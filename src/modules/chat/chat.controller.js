// src/modules/chat/chat.controller.js
import ChatService from './chat.service.js';
import ChatSocketHandler from './chat.socket.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import {
 successResponse,
 createdResponse,
 badRequestResponse,
 notFoundResponse,
 forbiddenResponse,
 paginatedResponse,
 fileResponse,
} from '../../shared/utils/response.js';
import logger from '../../shared/utils/logger.js';
import MetricsService from '../../shared/services/metrics.service.js';
import { 
 MESSAGE_TYPES, 
 ERROR_CODES,
 SUBSCRIPTION_FEATURES 
} from '../../config/constants.js';

class ChatController {
 /**
  * Send a message
  * @route POST /api/chat/:matchId/messages
  */
 sendMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { type, content, replyTo, clientId } = req.body;

   // Validate message type
   if (!Object.values(MESSAGE_TYPES).includes(type)) {
     return badRequestResponse(res, 'Invalid message type');
   }

   // Validate content based on type
   if (type === MESSAGE_TYPES.TEXT && (!content.text || content.text.trim().length === 0)) {
     return badRequestResponse(res, 'Text message cannot be empty');
   }

   const messageData = {
     type,
     content,
     replyTo,
     clientId,
     platform: req.headers['x-platform'] || 'web',
     deviceId: req.headers['x-device-id'],
     appVersion: req.headers['x-app-version'],
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   return createdResponse(res, result, 'Message sent successfully');
 });

 /**
  * Get messages for a match
  * @route GET /api/chat/:matchId/messages
  */
 getMessages = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { limit = 50, before, after, type } = req.query;

   const result = await ChatService.getMessages(userId, matchId, {
     limit: parseInt(limit),
     before,
     after,
     type,
   });

   return successResponse(res, result, 'Messages retrieved successfully');
 });

 /**
  * Edit a message
  * @route PUT /api/chat/messages/:messageId
  */
 editMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;
   const { content } = req.body;

   if (!content || content.trim().length === 0) {
     return badRequestResponse(res, 'Message content cannot be empty');
   }

   const result = await ChatService.editMessage(userId, messageId, content);

   return successResponse(res, result, 'Message edited successfully');
 });

 /**
  * Delete a message
  * @route DELETE /api/chat/messages/:messageId
  */
 deleteMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;
   const { deleteForEveryone = false } = req.body;

   const result = await ChatService.deleteMessage(userId, messageId, deleteForEveryone);

   return successResponse(res, result, 'Message deleted successfully');
 });

 /**
  * React to a message
  * @route POST /api/chat/messages/:messageId/react
  */
 reactToMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;
   const { emoji, action = 'add' } = req.body;

   if (action === 'add' && !emoji) {
     return badRequestResponse(res, 'Emoji is required');
   }

   const result = await ChatService.reactToMessage(userId, messageId, emoji, action);

   return successResponse(res, result, 'Reaction updated successfully');
 });

 /**
  * Mark messages as read
  * @route POST /api/chat/:matchId/messages/read
  */
 markAsRead = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { messageIds } = req.body;

   const result = await ChatService.markMessagesAsRead(userId, matchId, messageIds);

   return successResponse(res, result, 'Messages marked as read');
 });

 /**
  * Send typing indicator
  * @route POST /api/chat/:matchId/typing
  */
 sendTypingIndicator = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { isTyping = true } = req.body;

   const result = await ChatService.sendTypingIndicator(userId, matchId, isTyping);

   return successResponse(res, result);
 });

 /**
  * Upload and send media message
  * @route POST /api/chat/:matchId/messages/media
  */
 sendMediaMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   if (!req.file) {
     return badRequestResponse(res, 'No file uploaded');
   }

   const messageData = {
     content: {
       caption: req.body.caption,
     },
     replyTo: req.body.replyTo,
     clientId: req.body.clientId,
     platform: req.headers['x-platform'] || 'web',
     deviceId: req.headers['x-device-id'],
   };

   const result = await ChatService.sendMediaMessage(userId, matchId, req.file, messageData);

   return createdResponse(res, result, 'Media message sent successfully');
 });

 /**
  * Send voice message
  * @route POST /api/chat/:matchId/messages/voice
  */
 sendVoiceMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   if (!req.file) {
     return badRequestResponse(res, 'No audio file uploaded');
   }

   const { duration, waveform } = req.body;

   const messageData = {
     type: MESSAGE_TYPES.VOICE,
     content: {
       duration: parseInt(duration),
       waveform: waveform ? JSON.parse(waveform) : [],
     },
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMediaMessage(userId, matchId, req.file, messageData);

   return createdResponse(res, result, 'Voice message sent successfully');
 });

 /**
  * Send location message
  * @route POST /api/chat/:matchId/messages/location
  */
 sendLocation = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { latitude, longitude, address, name, isLive = false, duration } = req.body;

   if (!latitude || !longitude) {
     return badRequestResponse(res, 'Location coordinates are required');
   }

   const messageData = {
     type: MESSAGE_TYPES.LOCATION,
     content: {
       location: {
         latitude: parseFloat(latitude),
         longitude: parseFloat(longitude),
         address,
         name,
       },
     },
     locationTracking: isLive ? {
       isLive: true,
       expiresAt: new Date(Date.now() + (duration || 3600) * 1000),
       updateInterval: 60, // Update every minute
     } : undefined,
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   return createdResponse(res, result, 'Location sent successfully');
 });

 /**
  * Send GIF/Sticker
  * @route POST /api/chat/:matchId/messages/gif
  */
 sendGif = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { gifUrl, stickerId, stickerPack } = req.body;

   if (!gifUrl && !stickerId) {
     return badRequestResponse(res, 'GIF URL or Sticker ID is required');
   }

   const messageData = {
     type: stickerId ? MESSAGE_TYPES.STICKER : MESSAGE_TYPES.GIF,
     content: {
       gifUrl,
       stickerId,
       stickerPack,
     },
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   return createdResponse(res, result, 'GIF/Sticker sent successfully');
 });

 /**
  * Search messages
  * @route GET /api/chat/:matchId/messages/search
  */
 searchMessages = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { q, type = 'all', limit = 50 } = req.query;

   if (!q || q.trim().length < 2) {
     return badRequestResponse(res, 'Search query must be at least 2 characters');
   }

   const result = await ChatService.searchMessages(userId, matchId, q, {
     type,
     limit: parseInt(limit),
   });

   return successResponse(res, result, 'Search completed');
 });

 /**
  * Get chat statistics
  * @route GET /api/chat/:matchId/stats
  */
 getChatStats = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   const stats = await ChatService.getChatStats(userId, matchId);

   return successResponse(res, stats, 'Chat statistics retrieved');
 });

 /**
  * Export chat history
  * @route GET /api/chat/:matchId/export
  */
 exportChat = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { format = 'json' } = req.query;

   const result = await ChatService.exportChat(userId, matchId, format);

   if (format === 'json' || format === 'txt') {
     res.setHeader('Content-Type', format === 'json' ? 'application/json' : 'text/plain');
     res.setHeader('Content-Disposition', `attachment; filename="chat-${matchId}.${format}"`);
     return res.send(result.data);
   }

   return successResponse(res, result, 'Chat exported successfully');
 });

 /**
  * Clear chat history
  * @route DELETE /api/chat/:matchId/clear
  */
 clearChat = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { clearForBoth = false } = req.body;

   const result = await ChatService.clearChat(userId, matchId, clearForBoth);

   return successResponse(res, result, 'Chat cleared successfully');
 });

 /**
  * Report a message
  * @route POST /api/chat/messages/:messageId/report
  */
 reportMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;
   const { reason, description } = req.body;

   if (!reason) {
     return badRequestResponse(res, 'Report reason is required');
   }

   const result = await ChatService.reportMessage(userId, messageId, reason, description);

   return successResponse(res, result, 'Message reported successfully');
 });

 /**
  * Schedule a message
  * @route POST /api/chat/:matchId/messages/schedule
  */
 scheduleMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { type, content, scheduledFor } = req.body;

   if (!scheduledFor) {
     return badRequestResponse(res, 'Scheduled time is required');
   }

   const scheduledTime = new Date(scheduledFor);
   if (scheduledTime <= new Date()) {
     return badRequestResponse(res, 'Scheduled time must be in the future');
   }

   const messageData = {
     type,
     content,
   };

   const result = await ChatService.scheduleMessage(userId, matchId, messageData, scheduledTime);

   return createdResponse(res, result, 'Message scheduled successfully');
 });

 /**
  * Get scheduled messages
  * @route GET /api/chat/:matchId/messages/scheduled
  */
 getScheduledMessages = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   const Message = (await import('./message.model.js')).default;
   
   const messages = await Message.find({
     matchId,
     sender: userId,
     'scheduling.isScheduled': true,
     'scheduling.schedulingStatus': 'pending',
   })
     .sort({ 'scheduling.scheduledFor': 1 })
     .lean();

   return successResponse(res, { messages }, 'Scheduled messages retrieved');
 });

 /**
  * Cancel scheduled message
  * @route DELETE /api/chat/messages/:messageId/schedule
  */
 cancelScheduledMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;

   const Message = (await import('./message.model.js')).default;
   
   const message = await Message.findOne({
     _id: messageId,
     sender: userId,
     'scheduling.isScheduled': true,
     'scheduling.schedulingStatus': 'pending',
   });

   if (!message) {
     return notFoundResponse(res, 'Scheduled message not found');
   }

   message.scheduling.schedulingStatus = 'cancelled';
   await message.save();

   return successResponse(res, null, 'Scheduled message cancelled');
 });

 /**
  * Send game invite
  * @route POST /api/chat/:matchId/messages/game
  */
 sendGameInvite = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { gameType, gameData } = req.body;

   if (!gameType) {
     return badRequestResponse(res, 'Game type is required');
   }

   const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

   const messageData = {
     type: MESSAGE_TYPES.GAME_INVITE,
     content: {
       gameId,
       gameType,
       gameData,
     },
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   return createdResponse(res, result, 'Game invite sent');
 });

 /**
  * Send virtual gift
  * @route POST /api/chat/:matchId/messages/gift
  */
 sendVirtualGift = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { giftId, giftType, giftMessage } = req.body;

   if (!giftId || !giftType) {
     return badRequestResponse(res, 'Gift ID and type are required');
   }

   // Check if user has credits for gift
   const user = await (await import('../user/user.model.js')).default.findById(userId);
   
   const giftPrices = {
     rose: 1,
     chocolate: 3,
     teddy: 5,
     diamond: 10,
   };

   const price = giftPrices[giftType] || 1;
   
   if (!user.credits || user.credits < price) {
     return forbiddenResponse(res, 'Insufficient credits for this gift');
   }

   const messageData = {
     type: MESSAGE_TYPES.VIRTUAL_GIFT,
     content: {
       giftId,
       giftType,
       giftUrl: `/assets/gifts/${giftType}.png`,
       giftMessage,
     },
     payment: {
       amount: price,
       currency: 'credits',
     },
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   // Deduct credits
   user.credits -= price;
   await user.save();

   return createdResponse(res, {
     ...result,
     remainingCredits: user.credits,
   }, 'Gift sent successfully');
 });

 /**
  * Send date request
  * @route POST /api/chat/:matchId/messages/date
  */
 sendDateRequest = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { location, dateTime, description } = req.body;

   if (!location || !dateTime) {
     return badRequestResponse(res, 'Date location and time are required');
   }

   const messageData = {
     type: MESSAGE_TYPES.DATE_REQUEST,
     content: {
       dateLocation: location,
       dateTime: new Date(dateTime),
       dateDescription: description,
     },
     clientId: req.body.clientId,
   };

   const result = await ChatService.sendMessage(userId, matchId, messageData);

   return createdResponse(res, result, 'Date request sent');
 });

 /**
  * Get unread message count
  * @route GET /api/chat/unread
  */
 getUnreadCount = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();

   const Message = (await import('./message.model.js')).default;
   const Match = (await import('../match/match.model.js')).default;

   // Get all active matches
   const matches = await Match.find({
     users: userId,
     'status.isActive': true,
   }).select('_id interaction.unreadCount users');

   let totalUnread = 0;
   const unreadByMatch = {};

   matches.forEach(match => {
     const userIndex = match.users.findIndex(u => u.toString() === userId);
     const unread = userIndex === 0 
       ? match.interaction.unreadCount.user1 
       : match.interaction.unreadCount.user2;
     
     if (unread > 0) {
       totalUnread += unread;
       unreadByMatch[match._id] = unread;
     }
   });

   return successResponse(res, {
     total: totalUnread,
     byMatch: unreadByMatch,
   }, 'Unread count retrieved');
 });

 /**
  * Get conversation summary (AI feature)
  * @route GET /api/chat/:matchId/summary
  */
 getConversationSummary = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   const summary = await ChatService.getConversationSummary(userId, matchId);

   return successResponse(res, summary, 'Conversation summary generated');
 });

 /**
  * Translate message
  * @route POST /api/chat/messages/:messageId/translate
  */
 translateMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;
   const { targetLanguage = 'en' } = req.body;

   const Message = (await import('./message.model.js')).default;
   const message = await Message.findById(messageId);

   if (!message) {
     return notFoundResponse(res, 'Message not found');
   }

   // Verify user is part of conversation
   if (message.sender.toString() !== userId && message.receiver.toString() !== userId) {
     return forbiddenResponse(res, 'Unauthorized to translate this message');
   }

   // This would integrate with translation service
   // For now, return mock translation
   const translation = {
     originalText: message.content.text,
     translatedText: `[Translated from ${message.translation.originalLanguage || 'auto'}]: ${message.content.text}`,
     targetLanguage,
     confidence: 0.95,
   };

   return successResponse(res, translation, 'Message translated');
 });

 /**
  * Get message media
  * @route GET /api/chat/:matchId/media
  */
 getMatchMedia = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;
   const { type = 'all', limit = 50 } = req.query;

   await ChatService.validateMatchAndPermissions(matchId, userId);

   const Message = (await import('./message.model.js')).default;
   
   const query = {
     matchId,
     'status.isDeleted': false,
   };

   if (type === 'images') {
     query.type = MESSAGE_TYPES.IMAGE;
   } else if (type === 'videos') {
     query.type = MESSAGE_TYPES.VIDEO;
   } else {
     query.type = { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO] };
   }

   const media = await Message.find(query)
     .select('type content.mediaUrl content.thumbnailUrl content.caption sender createdAt')
     .populate('sender', 'profile.firstName profile.displayName')
     .sort({ createdAt: -1 })
     .limit(parseInt(limit))
     .lean();

   return successResponse(res, { media }, 'Media retrieved');
 });

 /**
  * Pin/unpin message
  * @route PUT /api/chat/messages/:messageId/pin
  */
 togglePinMessage = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { messageId } = req.params;

   const Message = (await import('./message.model.js')).default;
   const message = await Message.findById(messageId);

   if (!message) {
     return notFoundResponse(res, 'Message not found');
   }

   // Verify user is part of conversation
   if (message.sender.toString() !== userId && message.receiver.toString() !== userId) {
     return forbiddenResponse(res, 'Unauthorized to pin this message');
   }

   message.metadata.isPinned = !message.metadata.isPinned;
   message.metadata.pinnedBy = message.metadata.isPinned ? userId : null;
   message.metadata.pinnedAt = message.metadata.isPinned ? new Date() : null;
   await message.save();

   return successResponse(res, {
     isPinned: message.metadata.isPinned,
   }, message.metadata.isPinned ? 'Message pinned' : 'Message unpinned');
 });

 /**
  * Get pinned messages
  * @route GET /api/chat/:matchId/messages/pinned
  */
 getPinnedMessages = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   await ChatService.validateMatchAndPermissions(matchId, userId);

   const Message = (await import('./message.model.js')).default;
   
   const pinnedMessages = await Message.find({
     matchId,
     'metadata.isPinned': true,
     'status.isDeleted': false,
   })
     .populate('sender', 'profile.firstName profile.displayName profile.photos')
     .sort({ 'metadata.pinnedAt': -1 })
     .lean();

   return successResponse(res, {
     messages: pinnedMessages,
     count: pinnedMessages.length,
   }, 'Pinned messages retrieved');
 });

 /**
  * Get shared links
  * @route GET /api/chat/:matchId/links
  */
 getSharedLinks = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { matchId } = req.params;

   await ChatService.validateMatchAndPermissions(matchId, userId);

   const Message = (await import('./message.model.js')).default;
   
   const messages = await Message.find({
     matchId,
     'content.text': { $regex: /https?:\/\//i },
     'status.isDeleted': false,
   })
     .select('content.text content.links sender createdAt')
     .populate('sender', 'profile.firstName profile.displayName')
     .sort({ createdAt: -1 })
     .limit(50)
     .lean();

   const links = messages.map(msg => ({
     messageId: msg._id,
     links: msg.content.links || [],
     sender: msg.sender,
     sentAt: msg.createdAt,
   }));

   return successResponse(res, { links }, 'Shared links retrieved');
 });
}

export default new ChatController();