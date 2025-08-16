// src/modules/chat/chat.service.js
import Message from './message.model.js';
import Match from '../match/match.model.js';
import User from '../user/user.model.js';
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../../shared/utils/logger.js';
import CacheService from '../../shared/services/cache.service.js';
import NotificationService from '../../shared/services/notification.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import QueueService from '../../shared/services/queue.service.js';
import AppError from '../../shared/errors/AppError.js';
import {
 MESSAGE_TYPES,
 MESSAGE_STATUS,
 NOTIFICATION_TYPES,
 ERROR_CODES,
 HTTP_STATUS,
 SOCKET_EVENTS,
 SUBSCRIPTION_FEATURES,
} from '../../config/constants.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../../config/cloudinary.js';

class ChatService {
 /**
  * Send a message
  */
 async sendMessage(senderId, matchId, messageData) {
   try {
     const startTime = Date.now();

     // Validate match and permissions
     const match = await this.validateMatchAndPermissions(matchId, senderId);
     
     if (!match.chat.isEnabled) {
       throw new AppError('Chat is disabled for this match', HTTP_STATUS.FORBIDDEN, ERROR_CODES.CHAT_DISABLED);
     }

     // Get recipient
     const recipientId = match.getOtherUser(senderId);

     // Check rate limiting
     await this.checkMessageRateLimit(senderId);

     // Validate and process message based on type
     const processedContent = await this.processMessageContent(messageData.type, messageData.content, senderId);

     // Check for spam
     const spamCheck = await this.checkForSpam(processedContent, senderId);
     if (spamCheck.isSpam) {
       throw new AppError('Message detected as spam', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.SPAM_DETECTED);
     }

     // Create message
     const message = await Message.create({
       matchId,
       sender: senderId,
       receiver: recipientId,
       type: messageData.type,
       content: processedContent,
       replyTo: messageData.replyTo,
       metadata: {
         clientId: messageData.clientId,
         platform: messageData.platform || 'web',
         deviceId: messageData.deviceId,
         isSpam: spamCheck.isSpam,
         spamScore: spamCheck.score,
       },
       status: {
         sent: true,
         sentAt: new Date(),
       },
     });

     // Populate sender info
     await message.populate('sender', 'profile.firstName profile.displayName profile.photos');
     
     if (messageData.replyTo) {
       await message.populate('replyTo');
     }

     // Update match interaction
     await this.updateMatchInteraction(match, senderId, message);

     // Send real-time notification via socket
     this.emitMessageEvent(message, recipientId);

     // Send push notification if recipient is offline
     await this.sendMessageNotification(message, match, recipientId);

     // Process special message types
     await this.handleSpecialMessageTypes(message, match);

     // Track metrics
     const duration = Date.now() - startTime;
     await this.trackMessageMetrics(senderId, message.type, duration);

     // Auto-translate if needed
     await this.autoTranslateIfNeeded(message, recipientId);

     return {
       message: this.formatMessageResponse(message),
       match: {
         id: match._id,
         lastMessage: message.content.text || '[Media]',
         lastMessageAt: message.createdAt,
       },
     };
   } catch (error) {
     logger.error('Error sending message:', error);
     throw error;
   }
 }

 /**
  * Get messages for a match
  */
 async getMessages(userId, matchId, options = {}) {
   try {
     const {
       limit = 50,
       before = null,
       after = null,
       type = null,
     } = options;

     // Validate match access
     await this.validateMatchAndPermissions(matchId, userId);

     // Build query
     const query = {
       matchId,
       $or: [
         { sender: userId, 'visibility.hiddenForSender': false },
         { receiver: userId, 'visibility.hiddenForReceiver': false },
       ],
     };

     // Add type filter
     if (type) {
       if (type === 'media') {
         query.type = { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO] };
       } else {
         query.type = type;
       }
     }

     // Add time filters
     if (before) {
       query.createdAt = { $lt: new Date(before) };
     }
     if (after) {
       query.createdAt = { ...query.createdAt, $gt: new Date(after) };
     }

     // Get messages
     const messages = await Message.find(query)
       .populate('sender', 'profile.firstName profile.displayName profile.photos')
       .populate('receiver', 'profile.firstName profile.displayName profile.photos')
       .populate('replyTo')
       .sort({ createdAt: -1 })
       .limit(limit)
       .lean();

     // Format messages
     const formattedMessages = messages.reverse().map(msg => 
       this.formatMessageResponse(msg, userId)
     );

     // Mark messages as delivered
     const undeliveredIds = messages
       .filter(msg => msg.receiver.toString() === userId && !msg.status.delivered)
       .map(msg => msg._id);

     if (undeliveredIds.length > 0) {
       await this.markMessagesAsDelivered(undeliveredIds, userId);
     }

     return {
       messages: formattedMessages,
       hasMore: messages.length === limit,
       oldestMessageId: messages[0]?._id,
       newestMessageId: messages[messages.length - 1]?._id,
     };
   } catch (error) {
     logger.error('Error getting messages:', error);
     throw error;
   }
 }

 /**
  * Edit a message
  */
 async editMessage(userId, messageId, newContent) {
   try {
     const message = await Message.findById(messageId);

     if (!message) {
       throw new AppError('Message not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MESSAGE_NOT_FOUND);
     }

     if (message.sender.toString() !== userId) {
       throw new AppError('You can only edit your own messages', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     if (!message.canEdit) {
       throw new AppError('Message cannot be edited after 15 minutes', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.EDIT_TIME_EXPIRED);
     }

     // Edit the message
     await message.editMessage(newContent);

     // Emit update event
     socketManager.emitToUser(message.receiver.toString(), SOCKET_EVENTS.MESSAGE_EDITED, {
       messageId,
       newContent,
       editedAt: message.metadata.editedAt,
     });

     return {
       message: this.formatMessageResponse(message),
     };
   } catch (error) {
     logger.error('Error editing message:', error);
     throw error;
   }
 }

 /**
  * Delete a message
  */
 async deleteMessage(userId, messageId, deleteForEveryone = false) {
   try {
     const message = await Message.findById(messageId);

     if (!message) {
       throw new AppError('Message not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MESSAGE_NOT_FOUND);
     }

     // Check permissions
     if (deleteForEveryone && message.sender.toString() !== userId) {
       throw new AppError('You can only delete your own messages for everyone', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     if (!deleteForEveryone) {
       // Delete only for the user
       if (message.sender.toString() === userId) {
         message.visibility.hiddenForSender = true;
       } else if (message.receiver.toString() === userId) {
         message.visibility.hiddenForReceiver = true;
       } else {
         throw new AppError('Unauthorized to delete this message', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
       }
       await message.save();
     } else {
       // Soft delete for everyone
       await message.softDelete(userId, true);

       // Delete media from storage if exists
       if (message.hasMedia && message.content.mediaUrl) {
         await this.deleteMessageMedia(message);
       }
     }

     // Emit delete event
     const targetUsers = deleteForEveryone 
       ? [message.sender.toString(), message.receiver.toString()]
       : [userId];

     targetUsers.forEach(targetUserId => {
       socketManager.emitToUser(targetUserId, SOCKET_EVENTS.MESSAGE_DELETED, {
         messageId,
         deletedForEveryone,
       });
     });

     return {
       success: true,
       deletedForEveryone,
     };
   } catch (error) {
     logger.error('Error deleting message:', error);
     throw error;
   }
 }

 /**
  * React to a message
  */
 async reactToMessage(userId, messageId, emoji, action = 'add') {
   try {
     const message = await Message.findById(messageId);

     if (!message) {
       throw new AppError('Message not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MESSAGE_NOT_FOUND);
     }

     // Verify user is part of the conversation
     if (message.sender.toString() !== userId && message.receiver.toString() !== userId) {
       throw new AppError('Unauthorized to react to this message', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     if (action === 'add') {
       await message.addReaction(userId, emoji);
     } else {
       await message.removeReaction(userId);
     }

     // Emit reaction event
     const targetUserId = message.sender.toString() === userId 
       ? message.receiver.toString() 
       : message.sender.toString();

     socketManager.emitToUser(targetUserId, SOCKET_EVENTS.MESSAGE_REACTION, {
       messageId,
       userId,
       emoji: action === 'add' ? emoji : null,
       action,
     });

     return {
       success: true,
       reactions: message.reactions,
     };
   } catch (error) {
     logger.error('Error reacting to message:', error);
     throw error;
   }
 }

 /**
  * Mark messages as read
  */
 async markMessagesAsRead(userId, matchId, messageIds = null) {
   try {
     const match = await this.validateMatchAndPermissions(matchId, userId);

     const query = {
       matchId,
       receiver: userId,
       'status.read': false,
     };

     if (messageIds) {
       query._id = { $in: messageIds };
     }

     // Update messages
     const result = await Message.updateMany(query, {
       $set: {
         'status.read': true,
         'status.readAt': new Date(),
       },
     });

     // Update match unread count
     if (result.modifiedCount > 0) {
       await match.markAsRead(userId);
       await match.save();

       // Emit read receipts
       const senderId = match.getOtherUser(userId);
       socketManager.emitToUser(senderId.toString(), SOCKET_EVENTS.MESSAGES_READ, {
         matchId,
         messageIds,
         readBy: userId,
         readAt: new Date(),
       });
     }

     return {
       success: true,
       markedCount: result.modifiedCount,
     };
   } catch (error) {
     logger.error('Error marking messages as read:', error);
     throw error;
   }
 }

 /**
  * Send typing indicator
  */
 async sendTypingIndicator(userId, matchId, isTyping = true) {
   try {
     await this.validateMatchAndPermissions(matchId, userId);

     const key = `typing:${matchId}:${userId}`;
     
     if (isTyping) {
       // Set typing status with 3 second TTL
       await redis.set(key, '1', 3);
     } else {
       await redis.del(key);
     }

     // Emit typing event via socket (handled in socket handler)
     return { success: true };
   } catch (error) {
     logger.error('Error sending typing indicator:', error);
     throw error;
   }
 }

 /**
  * Upload and send media message
  */
 async sendMediaMessage(senderId, matchId, file, messageData) {
   try {
     // Validate file
     const validation = this.validateMediaFile(file);
     if (!validation.valid) {
       throw new AppError(validation.error, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_FILE);
     }

     // Check user limits
     const user = await User.findById(senderId);
     const canSendMedia = await this.checkMediaLimits(user);
     if (!canSendMedia) {
       throw new AppError('Daily media limit reached', HTTP_STATUS.FORBIDDEN, ERROR_CODES.LIMIT_EXCEEDED);
     }

     // Upload to Cloudinary
     const uploadResult = await this.uploadMedia(file, senderId);

     // Detect NSFW content if image
     if (file.mimetype.startsWith('image/')) {
       const nsfwCheck = await this.checkNSFWContent(uploadResult.secure_url);
       if (nsfwCheck.isNSFW && nsfwCheck.score > 0.8) {
         // Delete uploaded file
         await deleteFromCloudinary(uploadResult.public_id);
         throw new AppError('Inappropriate content detected', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INAPPROPRIATE_CONTENT);
       }
     }

     // Create media message
     const mediaContent = {
       mediaUrl: uploadResult.secure_url,
       thumbnailUrl: uploadResult.thumbnail_url || uploadResult.secure_url,
       mediaSize: file.size,
       mimeType: file.mimetype,
       fileName: file.originalname,
       mediaWidth: uploadResult.width,
       mediaHeight: uploadResult.height,
       ...messageData.content,
     };

     // Send message
     const result = await this.sendMessage(senderId, matchId, {
       type: this.getMediaType(file.mimetype),
       content: mediaContent,
       ...messageData,
     });

     return result;
   } catch (error) {
     logger.error('Error sending media message:', error);
     throw error;
   }
 }

 /**
  * Search messages
  */
 async searchMessages(userId, matchId, searchQuery, options = {}) {
   try {
     await this.validateMatchAndPermissions(matchId, userId);

     const {
       type = 'all',
       limit = 50,
     } = options;

     const messages = await Message.searchMessages(matchId, searchQuery, {
       type,
       limit,
     });

     return {
       results: messages.map(msg => this.formatMessageResponse(msg, userId)),
       query: searchQuery,
       count: messages.length,
     };
   } catch (error) {
     logger.error('Error searching messages:', error);
     throw error;
   }
 }

 /**
  * Get chat statistics
  */
 async getChatStats(userId, matchId) {
   try {
     await this.validateMatchAndPermissions(matchId, userId);

     const [
       messageStats,
       userStats,
       engagementStats,
     ] = await Promise.all([
       Message.getMatchStats(matchId),
       this.getUserChatStats(userId, matchId),
       this.getEngagementStats(matchId),
     ]);

     return {
       messages: messageStats,
       user: userStats,
       engagement: engagementStats,
     };
   } catch (error) {
     logger.error('Error getting chat stats:', error);
     throw error;
   }
 }

 /**
  * Export chat history
  */
 async exportChat(userId, matchId, format = 'json') {
   try {
     const match = await this.validateMatchAndPermissions(matchId, userId);

     // Check if user has premium for export feature
     const user = await User.findById(userId);
     if (user.subscription?.type === 'free') {
       throw new AppError('Chat export is a premium feature', HTTP_STATUS.FORBIDDEN, ERROR_CODES.SUBSCRIPTION_REQUIRED);
     }

     // Get all messages
     const messages = await Message.find({
       matchId,
       'status.isDeleted': false,
     })
       .populate('sender', 'profile.firstName profile.displayName')
       .populate('receiver', 'profile.firstName profile.displayName')
       .sort({ createdAt: 1 })
       .lean();

     let exportData;

     switch (format) {
       case 'json':
         exportData = this.exportAsJSON(messages);
         break;
       case 'txt':
         exportData = this.exportAsText(messages);
         break;
       case 'pdf':
         exportData = await this.exportAsPDF(messages, match);
         break;
       default:
         throw new AppError('Invalid export format', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_FORMAT);
     }

     // Track export
     await MetricsService.incrementCounter('chat.export', 1, { format });

     return {
       data: exportData,
       format,
       messageCount: messages.length,
       exportedAt: new Date(),
     };
   } catch (error) {
     logger.error('Error exporting chat:', error);
     throw error;
   }
 }

 /**
  * Clear chat history
  */
 async clearChat(userId, matchId, clearForBoth = false) {
   try {
     const match = await this.validateMatchAndPermissions(matchId, userId);

     if (clearForBoth) {
       // Only premium users can clear for both
       const user = await User.findById(userId);
       if (!SUBSCRIPTION_FEATURES[user.subscription?.type]?.clearChatForBoth) {
         throw new AppError('Clearing chat for both users is a premium feature', HTTP_STATUS.FORBIDDEN, ERROR_CODES.SUBSCRIPTION_REQUIRED);
       }

       // Soft delete all messages
       await Message.updateMany(
         { matchId },
         {
           $set: {
             'status.isDeleted': true,
             'status.deletedAt': new Date(),
             'status.deletedBy': userId,
           },
         }
       );

       // Notify other user
       const otherUserId = match.getOtherUser(userId);
       socketManager.emitToUser(otherUserId.toString(), SOCKET_EVENTS.CHAT_CLEARED, {
         matchId,
         clearedBy: userId,
       });
     } else {
       // Hide messages only for the user
       await Message.updateMany(
         { matchId, sender: userId },
         { $set: { 'visibility.hiddenForSender': true } }
       );

       await Message.updateMany(
         { matchId, receiver: userId },
         { $set: { 'visibility.hiddenForReceiver': true } }
       );
     }

     // Reset match chat stats
     match.interaction.messageCount = 0;
     match.interaction.lastMessageAt = null;
     await match.save();

     return {
       success: true,
       clearedForBoth: clearForBoth,
     };
   } catch (error) {
     logger.error('Error clearing chat:', error);
     throw error;
   }
 }

 /**
  * Report a message
  */
 async reportMessage(userId, messageId, reason, description = '') {
   try {
     const message = await Message.findById(messageId);

     if (!message) {
       throw new AppError('Message not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MESSAGE_NOT_FOUND);
     }

     // Verify user is part of the conversation
     if (message.sender.toString() !== userId && message.receiver.toString() !== userId) {
       throw new AppError('Unauthorized to report this message', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     // Add report
     await message.reportMessage(userId, reason);

     // Create admin report if threshold reached
     if (message.metadata.reportCount >= 3) {
       await QueueService.addJob('admin-review', {
         type: 'message',
         messageId,
         reportCount: message.metadata.reportCount,
         priority: 'high',
       });
     }

     return {
       success: true,
       message: 'Message reported successfully',
     };
   } catch (error) {
     logger.error('Error reporting message:', error);
     throw error;
   }
 }

 /**
  * Schedule a message
  */
 async scheduleMessage(senderId, matchId, messageData, scheduledFor) {
   try {
     const match = await this.validateMatchAndPermissions(matchId, senderId);

     // Check if user can schedule messages
     const user = await User.findById(senderId);
     if (!SUBSCRIPTION_FEATURES[user.subscription?.type]?.scheduledMessages) {
       throw new AppError('Scheduled messages are a premium feature', HTTP_STATUS.FORBIDDEN, ERROR_CODES.SUBSCRIPTION_REQUIRED);
     }

     // Validate scheduled time
     const scheduledTime = new Date(scheduledFor);
     if (scheduledTime <= new Date()) {
       throw new AppError('Scheduled time must be in the future', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_TIME);
     }

     // Create scheduled message
     const message = await Message.create({
       matchId,
       sender: senderId,
       receiver: match.getOtherUser(senderId),
       type: messageData.type,
       content: messageData.content,
       scheduling: {
         isScheduled: true,
         scheduledFor: scheduledTime,
         scheduledAt: new Date(),
         schedulingStatus: 'pending',
       },
       status: {
         sent: false,
       },
     });

     // Add to queue
     const delay = scheduledTime.getTime() - Date.now();
     await QueueService.addJob('scheduled-message', {
       messageId: message._id.toString(),
     }, { delay });

     return {
       message: this.formatMessageResponse(message),
       scheduledFor: scheduledTime,
     };
   } catch (error) {
     logger.error('Error scheduling message:', error);
     throw error;
   }
 }

 // ============================
 // Helper Methods
 // ============================

 /**
  * Validate match and permissions
  */
 async validateMatchAndPermissions(matchId, userId) {
   const match = await Match.findById(matchId);

   if (!match) {
     throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
   }

   if (!match.hasUser(userId)) {
     throw new AppError('Unauthorized to access this chat', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
   }

   if (!match.status.isActive) {
     throw new AppError('This match is no longer active', HTTP_STATUS.FORBIDDEN, ERROR_CODES.MATCH_INACTIVE);
   }

   return match;
 }

 /**
  * Process message content based on type
  */
 async processMessageContent(type, content, senderId) {
   const processedContent = { ...content };

   switch (type) {
     case MESSAGE_TYPES.TEXT:
       // Sanitize text
       processedContent.text = this.sanitizeText(content.text);
       // Extract links and mentions
       processedContent.links = this.extractLinks(content.text);
       processedContent.mentions = this.extractMentions(content.text);
       break;

     case MESSAGE_TYPES.LOCATION:
       // Validate coordinates
       if (!this.isValidCoordinate(content.location?.latitude, content.location?.longitude)) {
         throw new AppError('Invalid location coordinates', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_LOCATION);
       }
       break;

     case MESSAGE_TYPES.GIF:
     case MESSAGE_TYPES.STICKER:
       // Validate media URL
       if (!content.url && !content.id) {
         throw new AppError('Media URL or ID required', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_MEDIA);
       }
       break;

     case MESSAGE_TYPES.GAME_INVITE:
       // Validate game data
       if (!content.gameType || !content.gameId) {
         throw new AppError('Invalid game invite data', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_GAME_DATA);
       }
       break;
   }

   return processedContent;
 }

 /**
  * Check for spam
  */
 async checkForSpam(content, userId) {
   try {
     // Check rate limiting
     const recentMessages = await redis.get(`spam:check:${userId}`);
     if (recentMessages && parseInt(recentMessages) > 10) {
       return { isSpam: true, score: 1.0 };
     }

     // Simple spam patterns
     const spamPatterns = [
       /click here now/i,
       /free money/i,
       /hot singles/i,
       /viagra/i,
       /casino/i,
       /(\w)\1{5,}/i, // Repeated characters
     ];

     let spamScore = 0;
     const text = content.text || '';

     spamPatterns.forEach(pattern => {
       if (pattern.test(text)) {
         spamScore += 0.3;
       }
     });

     // Check for excessive links
     const links = (text.match(/https?:\/\//gi) || []).length;
     if (links > 3) {
       spamScore += 0.4;
     }

     // Check for all caps
     if (text.length > 10 && text === text.toUpperCase()) {
       spamScore += 0.2;
     }

     // Update spam check counter
     await redis.set(`spam:check:${userId}`, (parseInt(recentMessages) || 0) + 1, 60);

     return {
       isSpam: spamScore >= 0.7,
       score: Math.min(spamScore, 1.0),
     };
   } catch (error) {
     logger.error('Error checking for spam:', error);
     return { isSpam: false, score: 0 };
   }
 }

 /**
  * Update match interaction
  */
 async updateMatchInteraction(match, senderId, message) {
   try {
     // Update message count
     match.incrementMessageCount(senderId);

     // Update unread count for recipient
     const recipientId = match.getOtherUser(senderId);
     const userIndex = match.users.findIndex(u => u.toString() === recipientId.toString());
     
     if (userIndex === 0) {
       match.interaction.unreadCount.user1++;
     } else {
       match.interaction.unreadCount.user2++;
     }

     // Update last message info
     match.interaction.lastMessageAt = message.createdAt;
     match.interaction.lastMessageBy = senderId;
     match.interaction.lastMessagePreview = message.type === MESSAGE_TYPES.TEXT 
       ? message.content.text?.substring(0, 100)
       : `[${message.type}]`;

     // Mark as has exchanged messages
     if (!match.interaction.hasExchangedMessages) {
       match.interaction.hasExchangedMessages = true;
       match.interaction.firstMessageAt = message.createdAt;
     }

     // Update engagement score
     match.updateEngagement();

     await match.save();
   } catch (error) {
     logger.error('Error updating match interaction:', error);
   }
 }

 /**
  * Emit message event via socket
  */
 emitMessageEvent(message, recipientId) {
   try {
     socketManager.emitToUser(recipientId.toString(), SOCKET_EVENTS.NEW_MESSAGE, {
       message: this.formatMessageResponse(message),
     });
   } catch (error) {
     logger.error('Error emitting message event:', error);
   }
 }

 /**
  * Send message notification
  */
 async sendMessageNotification(message, match, recipientId) {
   try {
     // Check if recipient is online
     const isOnline = socketManager.isUserOnline(recipientId.toString());
     if (isOnline) {
       return;
     }

     // Check if notifications are muted
     const userIndex = match.users.findIndex(u => u.toString() === recipientId.toString());
     const isMuted = userIndex === 0 ? match.chat?.isMuted?.user1 : match.chat?.isMuted?.user2;
     
     if (isMuted) {
       return;
     }

     // Get sender info
     const sender = await User.findById(message.sender)
       .select('profile.firstName profile.displayName');

     // Prepare notification body
     let body = '';
     switch (message.type) {
       case MESSAGE_TYPES.TEXT:
         body = message.content.text;
         break;
       case MESSAGE_TYPES.IMAGE:
         body = '📷 Sent a photo';
         break;
       case MESSAGE_TYPES.VIDEO:
         body = '📹 Sent a video';
         break;
       case MESSAGE_TYPES.VOICE:
         body = '🎤 Sent a voice message';
         break;
       case MESSAGE_TYPES.LOCATION:
         body = '📍 Shared location';
         break;
       default:
         body = 'Sent a message';
     }

     await NotificationService.sendNotification(recipientId.toString(), {
       type: NOTIFICATION_TYPES.NEW_MESSAGE,
       title: sender.profile?.displayName || sender.profile?.firstName,
       body,
       data: {
         matchId: match._id.toString(),
         messageId: message._id.toString(),
         senderId: message.sender.toString(),
       },
       priority: 'high',
     });
   } catch (error) {
     logger.error('Error sending message notification:', error);
   }
 }

 /**
  * Format message response
  */
 formatMessageResponse(message, userId = null) {
   const formatted = {
     id: message._id,
     matchId: message.matchId,
     sender: message.sender,
     receiver: message.receiver,
     type: message.type,
     content: message.content,
     status: message.status,
     reactions: message.reactions,
     replyTo: message.replyTo,
     metadata: {
       isEdited: message.metadata?.isEdited,
       editedAt: message.metadata?.editedAt,
       platform: message.metadata?.platform,
     },
     createdAt: message.createdAt,
     updatedAt: message.updatedAt,
   };

   // Add user-specific flags
   if (userId) {
     formatted.isMine = message.sender?.toString() === userId || message.sender?._id?.toString() === userId;
     formatted.canEdit = formatted.isMine && message.canEdit;
     formatted.canDelete = message.canDelete;
   }

   return formatted;
 }

 /**
  * Sanitize text content
  */
 sanitizeText(text) {
   if (!text) return '';
   
   // Remove excessive whitespace
// Remove excessive whitespace
   text = text.replace(/\s+/g, ' ').trim();
   
   // Remove potential script tags
   text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
   
   // Limit length
   if (text.length > 5000) {
     text = text.substring(0, 5000);
   }
   
   return text;
 }

 /**
  * Extract links from text
  */
 extractLinks(text) {
   const urlRegex = /(https?:\/\/[^\s]+)/g;
   return text.match(urlRegex) || [];
 }

 /**
  * Extract mentions from text
  */
 extractMentions(text) {
   const mentionRegex = /@(\w+)/g;
   const mentions = [];
   let match;
   
   while ((match = mentionRegex.exec(text)) !== null) {
     mentions.push(match[1]);
   }
   
   return mentions;
 }

 /**
  * Validate coordinate
  */
 isValidCoordinate(lat, lng) {
   return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
 }

 /**
  * Check message rate limit
  */
 async checkMessageRateLimit(userId) {
   const key = `message:rate:${userId}`;
   const count = await redis.incr(key);
   
   if (count === 1) {
     await redis.expire(key, 60); // 1 minute window
   }
   
   if (count > 60) { // 60 messages per minute max
     throw new AppError('Message rate limit exceeded', HTTP_STATUS.TOO_MANY_REQUESTS, ERROR_CODES.RATE_LIMIT_EXCEEDED);
   }
 }

 /**
  * Track message metrics
  */
 async trackMessageMetrics(userId, messageType, duration) {
   try {
     await MetricsService.incrementCounter(`chat.messages.sent`, 1, { type: messageType });
     await MetricsService.recordTiming('chat.message.send.duration', duration);
     await MetricsService.trackUserAction(userId, 'message_sent', { type: messageType });
   } catch (error) {
     logger.error('Error tracking message metrics:', error);
   }
 }

 /**
  * Handle special message types
  */
 async handleSpecialMessageTypes(message, match) {
   try {
     switch (message.type) {
       case MESSAGE_TYPES.GAME_INVITE:
         await this.handleGameInvite(message, match);
         break;
         
       case MESSAGE_TYPES.VIRTUAL_GIFT:
         await this.handleVirtualGift(message, match);
         break;
         
       case MESSAGE_TYPES.DATE_REQUEST:
         await this.handleDateRequest(message, match);
         break;
         
       case MESSAGE_TYPES.LOCATION:
         if (message.content.location && message.locationTracking?.isLive) {
           await this.startLocationTracking(message);
         }
         break;
     }
   } catch (error) {
     logger.error('Error handling special message type:', error);
   }
 }

 /**
  * Handle game invite
  */
 async handleGameInvite(message, match) {
   try {
     // Create game session
     const gameSession = {
       gameId: message.content.gameId,
       matchId: match._id,
       players: match.users,
       initiator: message.sender,
       type: message.content.gameType,
       status: 'pending',
       createdAt: new Date(),
     };
     
     await redis.set(`game:${message.content.gameId}`, JSON.stringify(gameSession), 3600);
     
     // Send notification
     await NotificationService.sendNotification(message.receiver.toString(), {
       type: NOTIFICATION_TYPES.GAME_INVITE,
       title: 'Game Invite',
       body: 'You received a game invitation!',
       data: {
         gameId: message.content.gameId,
         matchId: match._id.toString(),
       },
     });
   } catch (error) {
     logger.error('Error handling game invite:', error);
   }
 }

 /**
  * Handle virtual gift
  */
 async handleVirtualGift(message, match) {
   try {
     // Update match gift stats
     if (!match.gifts) {
       match.gifts = { sent: [], received: [] };
     }
     
     const gift = {
       giftId: message.content.giftId,
       messageId: message._id,
       sentAt: message.createdAt,
     };
     
     const senderIndex = match.users.findIndex(u => u.toString() === message.sender.toString());
     if (senderIndex === 0) {
       match.gifts.sent.push(gift);
     } else {
       match.gifts.received.push(gift);
     }
     
     await match.save();
     
     // Track gift metrics
     await MetricsService.incrementCounter('chat.gifts.sent', 1, { 
       giftType: message.content.giftType 
     });
   } catch (error) {
     logger.error('Error handling virtual gift:', error);
   }
 }

 /**
  * Handle date request
  */
 async handleDateRequest(message, match) {
   try {
     // Update match date planning
     if (!match.datePlanning) {
       match.datePlanning = { proposals: [] };
     }
     
     match.datePlanning.proposals.push({
       proposedBy: message.sender,
       location: message.content.dateLocation,
       dateTime: message.content.dateTime,
       description: message.content.dateDescription,
       status: 'pending',
       proposedAt: message.createdAt,
       messageId: message._id,
     });
     
     await match.save();
     
     // Send notification
     await NotificationService.sendNotification(message.receiver.toString(), {
       type: NOTIFICATION_TYPES.DATE_REQUEST,
       title: 'Date Proposal',
       body: 'You received a date proposal!',
       data: {
         matchId: match._id.toString(),
         messageId: message._id.toString(),
       },
     });
   } catch (error) {
     logger.error('Error handling date request:', error);
   }
 }

 /**
  * Start location tracking
  */
 async startLocationTracking(message) {
   try {
     const trackingKey = `location:tracking:${message._id}`;
     const trackingData = {
       messageId: message._id,
       matchId: message.matchId,
       userId: message.sender,
       startedAt: new Date(),
       expiresAt: message.locationTracking.expiresAt,
     };
     
     const ttl = Math.floor((new Date(message.locationTracking.expiresAt) - new Date()) / 1000);
     await redis.set(trackingKey, JSON.stringify(trackingData), ttl);
     
     // Schedule location update checks
     await QueueService.addJob('location-tracking', {
       messageId: message._id.toString(),
     }, { repeat: { every: message.locationTracking.updateInterval * 1000 } });
   } catch (error) {
     logger.error('Error starting location tracking:', error);
   }
 }

 /**
  * Auto-translate message if needed
  */
 async autoTranslateIfNeeded(message, recipientId) {
   try {
     // Check if recipient has auto-translate enabled
     const recipient = await User.findById(recipientId).select('preferences.autoTranslate preferences.language');
     
     if (!recipient?.preferences?.autoTranslate) {
       return;
     }
     
     // This would integrate with a translation service
     // For now, we'll just mark it as needing translation
     if (message.type === MESSAGE_TYPES.TEXT && message.content.text) {
       // Detect language (mock implementation)
       const detectedLanguage = 'en'; // Would use actual language detection
       
       if (detectedLanguage !== recipient.preferences.language) {
         message.translation.isTranslated = false;
         message.translation.originalLanguage = detectedLanguage;
         await message.save();
         
         // Queue translation job
         await QueueService.addJob('translate-message', {
           messageId: message._id.toString(),
           targetLanguage: recipient.preferences.language,
         });
       }
     }
   } catch (error) {
     logger.error('Error in auto-translate:', error);
   }
 }

 /**
  * Mark messages as delivered
  */
 async markMessagesAsDelivered(messageIds, userId) {
   try {
     await Message.updateMany(
       {
         _id: { $in: messageIds },
         receiver: userId,
         'status.delivered': false,
       },
       {
         $set: {
           'status.delivered': true,
           'status.deliveredAt': new Date(),
         },
       }
     );
     
     // Emit delivery receipts (handled in socket)
   } catch (error) {
     logger.error('Error marking messages as delivered:', error);
   }
 }

 /**
  * Validate media file
  */
 validateMediaFile(file) {
   const maxSize = 50 * 1024 * 1024; // 50MB
   const allowedTypes = {
     image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
     video: ['video/mp4', 'video/quicktime', 'video/webm'],
     audio: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
   };
   
   if (file.size > maxSize) {
     return { valid: false, error: 'File size exceeds 50MB limit' };
   }
   
   const allAllowedTypes = [...allowedTypes.image, ...allowedTypes.video, ...allowedTypes.audio];
   if (!allAllowedTypes.includes(file.mimetype)) {
     return { valid: false, error: 'File type not supported' };
   }
   
   return { valid: true };
 }

 /**
  * Check media limits
  */
 async checkMediaLimits(user) {
   const key = `media:limit:${user._id}:${new Date().toISOString().split('T')[0]}`;
   const count = await redis.get(key);
   
   const limits = {
     free: 10,
     plus: 50,
     gold: 100,
     platinum: -1, // Unlimited
   };
   
   const userLimit = limits[user.subscription?.type] || limits.free;
   
   if (userLimit === -1) return true;
   if (parseInt(count) >= userLimit) return false;
   
   await redis.incr(key);
   await redis.expire(key, 86400); // 24 hours
   
   return true;
 }

 /**
  * Upload media to Cloudinary
  */
 async uploadMedia(file, userId) {
   try {
     const folder = `chat/${userId}/${new Date().getFullYear()}/${new Date().getMonth() + 1}`;
     
     const result = await uploadToCloudinary(file.buffer, {
       folder,
       resource_type: 'auto',
       transformation: this.getMediaTransformation(file.mimetype),
     });
     
     return result;
   } catch (error) {
     logger.error('Error uploading media:', error);
     throw new AppError('Failed to upload media', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.UPLOAD_FAILED);
   }
 }

 /**
  * Get media transformation options
  */
 getMediaTransformation(mimeType) {
   if (mimeType.startsWith('image/')) {
     return {
       quality: 'auto:good',
       fetch_format: 'auto',
       width: 1920,
       height: 1920,
       crop: 'limit',
     };
   } else if (mimeType.startsWith('video/')) {
     return {
       quality: 'auto:good',
       fetch_format: 'auto',
       width: 1280,
       height: 720,
       crop: 'limit',
     };
   }
   return {};
 }

 /**
  * Get media type from mimetype
  */
 getMediaType(mimeType) {
   if (mimeType.startsWith('image/')) return MESSAGE_TYPES.IMAGE;
   if (mimeType.startsWith('video/')) return MESSAGE_TYPES.VIDEO;
   if (mimeType.startsWith('audio/')) return MESSAGE_TYPES.AUDIO;
   return MESSAGE_TYPES.FILE;
 }

 /**
  * Check NSFW content
  */
 async checkNSFWContent(imageUrl) {
   try {
     // This would integrate with a content moderation API
     // For now, return safe
     return { isNSFW: false, score: 0 };
   } catch (error) {
     logger.error('Error checking NSFW content:', error);
     return { isNSFW: false, score: 0 };
   }
 }

 /**
  * Delete message media
  */
 async deleteMessageMedia(message) {
   try {
     if (message.content.mediaUrl) {
       // Extract public_id from Cloudinary URL
       const urlParts = message.content.mediaUrl.split('/');
       const publicId = urlParts[urlParts.length - 1].split('.')[0];
       await deleteFromCloudinary(publicId);
     }
   } catch (error) {
     logger.error('Error deleting message media:', error);
   }
 }

 /**
  * Get user chat stats
  */
 async getUserChatStats(userId, matchId) {
   try {
     const [
       sentCount,
       receivedCount,
       mediaCount,
       firstMessage,
     ] = await Promise.all([
       Message.countDocuments({ matchId, sender: userId, 'status.isDeleted': false }),
       Message.countDocuments({ matchId, receiver: userId, 'status.isDeleted': false }),
       Message.countDocuments({
         matchId,
         sender: userId,
         type: { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO] },
         'status.isDeleted': false,
       }),
       Message.findOne({ matchId, sender: userId }).sort({ createdAt: 1 }),
     ]);
     
     return {
       messagesSent: sentCount,
       messagesReceived: receivedCount,
       mediaSent: mediaCount,
       firstMessageAt: firstMessage?.createdAt,
       ratio: receivedCount > 0 ? sentCount / receivedCount : sentCount,
     };
   } catch (error) {
     logger.error('Error getting user chat stats:', error);
     return {};
   }
 }

 /**
  * Get engagement stats
  */
 async getEngagementStats(matchId) {
   try {
     const messages = await Message.find({
       matchId,
       'status.isDeleted': false,
     }).select('createdAt sender reactions engagement');
     
     if (messages.length === 0) {
       return { responseTime: 0, engagement: 0 };
     }
     
     // Calculate average response time
     let totalResponseTime = 0;
     let responseCount = 0;
     
     for (let i = 1; i < messages.length; i++) {
       if (messages[i].sender.toString() !== messages[i - 1].sender.toString()) {
         const responseTime = messages[i].createdAt - messages[i - 1].createdAt;
         totalResponseTime += responseTime;
         responseCount++;
       }
     }
     
     const avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;
     
     // Calculate engagement score
     const totalReactions = messages.reduce((sum, msg) => sum + (msg.reactions?.length || 0), 0);
     const engagementScore = (totalReactions / messages.length) * 100;
     
     return {
       averageResponseTime: Math.round(avgResponseTime / 1000), // in seconds
       engagementScore: Math.round(engagementScore),
       totalReactions,
       messagesWithReactions: messages.filter(m => m.reactions?.length > 0).length,
     };
   } catch (error) {
     logger.error('Error getting engagement stats:', error);
     return {};
   }
 }

 /**
  * Export chat as JSON
  */
 exportAsJSON(messages) {
   return JSON.stringify(messages.map(msg => ({
     id: msg._id,
     sender: msg.sender?.profile?.firstName || 'Unknown',
     receiver: msg.receiver?.profile?.firstName || 'Unknown',
     type: msg.type,
     content: msg.content,
     timestamp: msg.createdAt,
     reactions: msg.reactions,
   })), null, 2);
 }

 /**
  * Export chat as text
  */
 exportAsText(messages) {
   return messages.map(msg => {
     const sender = msg.sender?.profile?.firstName || 'Unknown';
     const timestamp = new Date(msg.createdAt).toLocaleString();
     let content = '';
     
     switch (msg.type) {
       case MESSAGE_TYPES.TEXT:
         content = msg.content.text;
         break;
       case MESSAGE_TYPES.IMAGE:
         content = '[Image]';
         break;
       case MESSAGE_TYPES.VIDEO:
         content = '[Video]';
         break;
       case MESSAGE_TYPES.VOICE:
         content = '[Voice message]';
         break;
       case MESSAGE_TYPES.LOCATION:
         content = '[Location]';
         break;
       default:
         content = `[${msg.type}]`;
     }
     
     return `[${timestamp}] ${sender}: ${content}`;
   }).join('\n');
 }

 /**
  * Export chat as PDF (placeholder)
  */
 async exportAsPDF(messages, match) {
   // This would integrate with a PDF generation library
   // For now, return a placeholder
   return {
     url: 'https://example.com/chat-export.pdf',
     size: messages.length * 100,
     pages: Math.ceil(messages.length / 50),
   };
 }

 /**
  * Get conversation summary (AI feature)
  */
 async getConversationSummary(userId, matchId) {
   try {
     const match = await this.validateMatchAndPermissions(matchId, userId);
     
     // Check if user has AI features
     const user = await User.findById(userId);
     if (!SUBSCRIPTION_FEATURES[user.subscription?.type]?.aiFeatures) {
       throw new AppError('AI features are premium only', HTTP_STATUS.FORBIDDEN, ERROR_CODES.SUBSCRIPTION_REQUIRED);
     }
     
     // Get recent messages
     const messages = await Message.find({
       matchId,
       'status.isDeleted': false,
       type: MESSAGE_TYPES.TEXT,
     })
       .sort({ createdAt: -1 })
       .limit(100)
       .lean();
     
     // This would integrate with an AI service
     // For now, return mock summary
     return {
       summary: 'You and your match have been discussing travel plans and favorite restaurants.',
       topics: ['travel', 'food', 'movies'],
       sentiment: 'positive',
       keyMoments: [
         { date: new Date(), event: 'Shared travel photos' },
         { date: new Date(), event: 'Planned first date' },
       ],
     };
   } catch (error) {
     logger.error('Error getting conversation summary:', error);
     throw error;
   }
 }
}

export default new ChatService();