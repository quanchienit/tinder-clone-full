// src/modules/chat/chat.socket.js
import Message from './message.model.js';
import Match from '../match/match.model.js';
import User from '../user/user.model.js';
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../../shared/utils/logger.js';
import NotificationService from '../../shared/services/notification.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import { 
 MESSAGE_TYPES, 
 NOTIFICATION_TYPES,
 MESSAGE_STATUS,
 SOCKET_EVENTS,
 ERROR_CODES 
} from '../../config/constants.js';

class ChatSocketHandler {
 constructor() {
   this.typingTimeouts = new Map();
   this.messageQueue = new Map();
   this.activeCalls = new Map();
 }

 /**
  * Initialize chat socket handlers
  */
 initialize(io) {
   this.io = io;

   // Chat namespace
   const chatNamespace = io.of('/chat');

   // Middleware for chat namespace
   chatNamespace.use(async (socket, next) => {
     try {
       const userId = socket.userId;
       if (!userId) {
         return next(new Error('Authentication required'));
       }

       // Get user's matches for validation
       const matches = await Match.find({
         users: userId,
         'status.isActive': true,
       }).select('_id users');

       socket.matches = matches.map(m => m._id.toString());
       socket.matchUsers = new Set();
       
       matches.forEach(match => {
         match.users.forEach(u => {
           if (u.toString() !== userId) {
             socket.matchUsers.add(u.toString());
           }
         });
       });

       next();
     } catch (error) {
       logger.error('Chat socket middleware error:', error);
       next(error);
     }
   });

   // Connection handler
   chatNamespace.on('connection', (socket) => {
     this.handleConnection(socket);
   });

   logger.info('Chat socket handlers initialized');
 }

 /**
  * Handle socket connection
  */
 handleConnection(socket) {
   const userId = socket.userId;
   logger.info(`User ${userId} connected to chat namespace`);

   // Join user's personal room
   socket.join(`user:${userId}`);

   // Join all match rooms
   socket.matches.forEach(matchId => {
     socket.join(`match:${matchId}`);
   });

   // Set user as online in chat
   this.setUserOnlineStatus(userId, true);

   // Register event handlers
   this.registerEventHandlers(socket);

   // Send pending messages
   this.sendPendingMessages(socket);

   // Emit connection success
   socket.emit('chat:connected', {
     userId,
     matches: socket.matches,
     timestamp: new Date(),
   });

   // Handle disconnection
   socket.on('disconnect', () => {
     this.handleDisconnect(socket);
   });
 }

 /**
  * Register all event handlers
  */
registerEventHandlers(socket) {
  // Message events
  socket.on(SOCKET_EVENTS.MESSAGE_SEND, (data) => this.handleSendMessage(socket, data));
  socket.on(SOCKET_EVENTS.MESSAGE_EDIT, (data) => this.handleEditMessage(socket, data));
  socket.on(SOCKET_EVENTS.MESSAGE_DELETED, (data) => this.handleDeleteMessage(socket, data));
  socket.on(SOCKET_EVENTS.MESSAGE_REACT, (data) => this.handleMessageReaction(socket, data));
  socket.on(SOCKET_EVENTS.MESSAGE_READ, (data) => this.handleMarkAsRead(socket, data));
  socket.on(SOCKET_EVENTS.MESSAGE_DELIVERED, (data) => this.handleMarkAsDelivered(socket, data));

  // Typing events
  socket.on(SOCKET_EVENTS.TYPING_START, (data) => this.handleTypingStart(socket, data));
  socket.on(SOCKET_EVENTS.TYPING_STOP, (data) => this.handleTypingStop(socket, data));

  // Voice/Video events
  socket.on(SOCKET_EVENTS.CALL_INITIATE, (data) => this.handleCallInitiate(socket, data));
  socket.on(SOCKET_EVENTS.CALL_ACCEPT, (data) => this.handleCallAccept(socket, data));
  socket.on(SOCKET_EVENTS.CALL_REJECT, (data) => this.handleCallReject(socket, data));
  socket.on(SOCKET_EVENTS.CALL_END, (data) => this.handleCallEnd(socket, data));
  socket.on(SOCKET_EVENTS.CALL_ICE_CANDIDATE, (data) => this.handleIceCandidate(socket, data));
  socket.on(SOCKET_EVENTS.CALL_SIGNAL, (data) => this.handleCallSignal(socket, data));

  // Media events
  socket.on(SOCKET_EVENTS.MEDIA_UPLOAD, (data) => this.handleMediaUpload(socket, data));
  socket.on(SOCKET_EVENTS.MEDIA_DOWNLOAD, (data) => this.handleMediaDownload(socket, data));

  // Chat management
  socket.on(SOCKET_EVENTS.CHAT_LOAD_HISTORY, (data) => this.handleLoadHistory(socket, data));
  socket.on(SOCKET_EVENTS.CHAT_CLEAR, (data) => this.handleClearChat(socket, data));
  socket.on(SOCKET_EVENTS.CHAT_EXPORT, (data) => this.handleExportChat(socket, data));
  socket.on(SOCKET_EVENTS.CHAT_SEARCH, (data) => this.handleSearchMessages(socket, data));

  // Presence events
  socket.on(SOCKET_EVENTS.PRESENCE_UPDATE, (data) => this.handlePresenceUpdate(socket, data));
  socket.on(SOCKET_EVENTS.PRESENCE_GET, (data) => this.handleGetPresence(socket, data));

  // Location sharing
  socket.on(SOCKET_EVENTS.LOCATION_SHARE, (data) => this.handleShareLocation(socket, data));
  socket.on(SOCKET_EVENTS.LOCATION_STOP, (data) => this.handleStopLocationSharing(socket, data));

  // Voice messages
  socket.on(SOCKET_EVENTS.VOICE_RECORD, (data) => this.handleVoiceRecord(socket, data));
  socket.on(SOCKET_EVENTS.VOICE_SEND, (data) => this.handleVoiceSend(socket, data));

  // Games & Activities
  socket.on(SOCKET_EVENTS.GAME_INVITE, (data) => this.handleGameInvite(socket, data));
  socket.on(SOCKET_EVENTS.GAME_ACCEPT, (data) => this.handleGameAccept(socket, data));
  socket.on(SOCKET_EVENTS.GAME_MOVE, (data) => this.handleGameMove(socket, data));

  // Subscription events
  socket.on(SOCKET_EVENTS.CHAT_SUBSCRIBE, (data) => this.handleSubscribeToMatch(socket, data));
  socket.on(SOCKET_EVENTS.CHAT_UNSUBSCRIBE, (data) => this.handleUnsubscribeFromMatch(socket, data));
}

 /**
  * Handle sending a message
  */
 async handleSendMessage(socket, data) {
   try {
     const { matchId, type, content, replyTo, metadata } = data;
     const userId = socket.userId;

     // Validate match
     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized to send message to this match',
       });
     }

     // Get match details
     const match = await Match.findById(matchId);
     if (!match || !match.status.isActive) {
       return socket.emit('error', {
         code: ERROR_CODES.MATCH_NOT_FOUND,
         message: 'Match not found or inactive',
       });
     }

     // Check if chat is enabled
     if (!match.chat.isEnabled) {
       return socket.emit('error', {
         code: ERROR_CODES.CHAT_DISABLED,
         message: 'Chat is disabled for this match',
       });
     }

     // Get recipient
     const recipientId = match.getOtherUser(userId);

     // Validate message type and content
     const validationError = this.validateMessage(type, content);
     if (validationError) {
       return socket.emit('error', validationError);
     }

     // Create message
     const message = await Message.create({
       matchId,
       sender: userId,
       receiver: recipientId,
       type,
       content,
       replyTo,
       metadata: {
         ...metadata,
         clientId: data.clientId,
         platform: socket.handshake.headers['x-platform'] || 'web',
       },
       status: {
         sent: true,
         sentAt: new Date(),
         delivered: false,
         read: false,
       },
     });

     // Update match interaction
     match.incrementMessageCount(userId);
     match.updateUnreadCount(recipientId, match.getUnreadCount(recipientId) + 1);
     await match.save();

     // Populate sender info
     await message.populate('sender', 'profile.firstName profile.displayName profile.photos');

     // Format message for emission
     const formattedMessage = this.formatMessage(message);

     // Emit to sender (confirmation)
     socket.emit('message:sent', {
       ...formattedMessage,
       clientId: data.clientId,
       tempId: data.tempId,
     });

     // Emit to recipient
     this.io.of('/chat').to(`user:${recipientId}`).emit('message:new', formattedMessage);

     // Send push notification if recipient is offline
     const isRecipientOnline = await this.isUserOnline(recipientId);
     if (!isRecipientOnline) {
       await this.sendMessageNotification(message, match);
     }

     // Store in message queue for delivery tracking
     this.addToMessageQueue(message._id.toString(), recipientId.toString());

     // Track metrics
     await MetricsService.incrementCounter('chat.messages.sent', 1, { type });
     await MetricsService.trackUserAction(userId, 'message_sent', { matchId, type });

     // Handle special message types
     await this.handleSpecialMessageTypes(message, match);

   } catch (error) {
     logger.error('Error sending message:', error);
     socket.emit('error', {
       code: ERROR_CODES.MESSAGE_SEND_FAILED,
       message: 'Failed to send message',
       error: error.message,
     });
   }
 }

 /**
  * Handle editing a message
  */
 async handleEditMessage(socket, data) {
   try {
     const { messageId, newContent } = data;
     const userId = socket.userId;

     const message = await Message.findById(messageId);
     
     if (!message) {
       return socket.emit('error', {
         code: ERROR_CODES.MESSAGE_NOT_FOUND,
         message: 'Message not found',
       });
     }

     // Check if user is the sender
     if (message.sender.toString() !== userId) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'You can only edit your own messages',
       });
     }

     // Check if message can be edited (within 15 minutes)
     const timeSinceSent = Date.now() - message.createdAt;
     if (timeSinceSent > 15 * 60 * 1000) {
       return socket.emit('error', {
         code: ERROR_CODES.EDIT_TIME_EXPIRED,
         message: 'Messages can only be edited within 15 minutes',
       });
     }

     // Update message
     message.content.text = newContent;
     message.metadata.isEdited = true;
     message.metadata.editedAt = new Date();
     await message.save();

     // Emit update to both users
     const updateData = {
       messageId,
       newContent,
       editedAt: message.metadata.editedAt,
     };

     this.io.of('/chat').to(`match:${message.matchId}`).emit('message:edited', updateData);

   } catch (error) {
     logger.error('Error editing message:', error);
     socket.emit('error', {
       code: ERROR_CODES.MESSAGE_EDIT_FAILED,
       message: 'Failed to edit message',
     });
   }
 }

 /**
  * Handle deleting a message
  */
 async handleDeleteMessage(socket, data) {
   try {
     const { messageId, deleteForEveryone = false } = data;
     const userId = socket.userId;

     const message = await Message.findById(messageId);
     
     if (!message) {
       return socket.emit('error', {
         code: ERROR_CODES.MESSAGE_NOT_FOUND,
         message: 'Message not found',
       });
     }

     // Check permissions
     if (deleteForEveryone && message.sender.toString() !== userId) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'You can only delete your own messages for everyone',
       });
     }

     if (deleteForEveryone) {
       // Soft delete for everyone
       message.status.isDeleted = true;
       message.status.deletedAt = new Date();
       message.status.deletedBy = userId;
       await message.save();

       // Notify all parties
       this.io.of('/chat').to(`match:${message.matchId}`).emit('message:deleted', {
         messageId,
         deletedForEveryone: true,
       });
     } else {
       // Delete only for the user
       if (message.sender.toString() === userId) {
         message.visibility.hiddenForSender = true;
       } else {
         message.visibility.hiddenForReceiver = true;
       }
       await message.save();

       // Notify only the user
       socket.emit('message:deleted', {
         messageId,
         deletedForEveryone: false,
       });
     }

   } catch (error) {
     logger.error('Error deleting message:', error);
     socket.emit('error', {
       code: ERROR_CODES.MESSAGE_DELETE_FAILED,
       message: 'Failed to delete message',
     });
   }
 }

 /**
  * Handle message reactions
  */
 async handleMessageReaction(socket, data) {
   try {
     const { messageId, reaction, action = 'add' } = data;
     const userId = socket.userId;

     const message = await Message.findById(messageId);
     
     if (!message) {
       return socket.emit('error', {
         code: ERROR_CODES.MESSAGE_NOT_FOUND,
         message: 'Message not found',
       });
     }

     // Initialize reactions if not exists
     if (!message.reactions) {
       message.reactions = [];
     }

     const existingReactionIndex = message.reactions.findIndex(
       r => r.userId.toString() === userId
     );

     if (action === 'add') {
       if (existingReactionIndex > -1) {
         // Update existing reaction
         message.reactions[existingReactionIndex].emoji = reaction;
         message.reactions[existingReactionIndex].reactedAt = new Date();
       } else {
         // Add new reaction
         message.reactions.push({
           userId,
           emoji: reaction,
           reactedAt: new Date(),
         });
       }
     } else if (action === 'remove') {
       if (existingReactionIndex > -1) {
         message.reactions.splice(existingReactionIndex, 1);
       }
     }

     await message.save();

     // Emit reaction update
     this.io.of('/chat').to(`match:${message.matchId}`).emit('message:reaction', {
       messageId,
       userId,
       reaction: action === 'add' ? reaction : null,
       action,
     });

   } catch (error) {
     logger.error('Error handling reaction:', error);
     socket.emit('error', {
       code: ERROR_CODES.REACTION_FAILED,
       message: 'Failed to add reaction',
     });
   }
 }

 /**
  * Handle typing start
  */
 async handleTypingStart(socket, data) {
   try {
     const { matchId } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return;
     }

     // Clear existing timeout
     const timeoutKey = `${userId}:${matchId}`;
     if (this.typingTimeouts.has(timeoutKey)) {
       clearTimeout(this.typingTimeouts.get(timeoutKey));
     }

     // Set typing status in Redis
     await redis.set(`typing:${matchId}:${userId}`, '1', 3);

     // Emit to other user
     socket.to(`match:${matchId}`).emit('typing:start', {
       matchId,
       userId,
     });

     // Auto-stop typing after 3 seconds
     const timeout = setTimeout(() => {
       this.handleTypingStop(socket, { matchId });
     }, 3000);

     this.typingTimeouts.set(timeoutKey, timeout);

   } catch (error) {
     logger.error('Error handling typing start:', error);
   }
 }

 /**
  * Handle typing stop
  */
 async handleTypingStop(socket, data) {
   try {
     const { matchId } = data;
     const userId = socket.userId;

     // Clear timeout
     const timeoutKey = `${userId}:${matchId}`;
     if (this.typingTimeouts.has(timeoutKey)) {
       clearTimeout(this.typingTimeouts.get(timeoutKey));
       this.typingTimeouts.delete(timeoutKey);
     }

     // Remove typing status
     await redis.del(`typing:${matchId}:${userId}`);

     // Emit to other user
     socket.to(`match:${matchId}`).emit('typing:stop', {
       matchId,
       userId,
     });

   } catch (error) {
     logger.error('Error handling typing stop:', error);
   }
 }

 /**
  * Handle marking messages as read
  */
 async handleMarkAsRead(socket, data) {
   try {
     const { matchId, messageIds } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return;
     }

     // Update messages
     await Message.updateMany(
       {
         _id: { $in: messageIds },
         matchId,
         receiver: userId,
         'status.read': false,
       },
       {
         $set: {
           'status.read': true,
           'status.readAt': new Date(),
         },
       }
     );

     // Update match unread count
     const match = await Match.findById(matchId);
     if (match) {
       match.markAsRead(userId);
       await match.save();
     }

     // Emit read receipts to sender
     const senderId = match?.getOtherUser(userId);
     if (senderId) {
       this.io.of('/chat').to(`user:${senderId}`).emit('message:read', {
         matchId,
         messageIds,
         readBy: userId,
         readAt: new Date(),
       });
     }

     // Track metrics
     await MetricsService.incrementCounter('chat.messages.read', messageIds.length);

   } catch (error) {
     logger.error('Error marking messages as read:', error);
   }
 }

 /**
  * Handle video call initiation
  */
 async handleCallInitiate(socket, data) {
   try {
     const { matchId, callType = 'video', offer } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     const match = await Match.findById(matchId).populate('users', 'profile.firstName');
     const recipientId = match.getOtherUser(userId);

     // Check if recipient is online
     const isOnline = await this.isUserOnline(recipientId);
     if (!isOnline) {
       return socket.emit('call:recipient-offline', {
         matchId,
         message: 'User is not available for calls',
       });
     }

     // Create call session
     const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
     const callSession = {
       callId,
       matchId,
       initiator: userId,
       recipient: recipientId.toString(),
       type: callType,
       status: 'ringing',
       startedAt: new Date(),
       offer,
     };

     // Store call session
     await redis.set(`call:${callId}`, JSON.stringify(callSession), 120); // 2 min timeout
     this.activeCalls.set(callId, callSession);

     // Notify recipient
     this.io.of('/chat').to(`user:${recipientId}`).emit('call:incoming', {
       callId,
       matchId,
       callType,
       caller: {
         id: userId,
         name: socket.user?.profile?.firstName,
       },
       offer,
     });

     // Send push notification
     await NotificationService.sendNotification(recipientId.toString(), {
       type: NOTIFICATION_TYPES.INCOMING_CALL,
       title: `Incoming ${callType} call`,
       body: `${socket.user?.profile?.firstName} is calling you`,
       data: { callId, matchId, callType },
       priority: 'high',
     });

     socket.emit('call:initiated', { callId, status: 'ringing' });

   } catch (error) {
     logger.error('Error initiating call:', error);
     socket.emit('error', {
       code: ERROR_CODES.CALL_FAILED,
       message: 'Failed to initiate call',
     });
   }
 }

 /**
  * Handle call acceptance
  */
 async handleCallAccept(socket, data) {
   try {
     const { callId, answer } = data;
     const userId = socket.userId;

     const callSession = this.activeCalls.get(callId);
     if (!callSession) {
       return socket.emit('error', {
         code: ERROR_CODES.CALL_NOT_FOUND,
         message: 'Call session not found',
       });
     }

     if (callSession.recipient !== userId) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized to accept this call',
       });
     }

     // Update call status
     callSession.status = 'connected';
     callSession.connectedAt = new Date();
     callSession.answer = answer;
     
     await redis.set(`call:${callId}`, JSON.stringify(callSession), 7200); // 2 hours max

     // Notify initiator
     this.io.of('/chat').to(`user:${callSession.initiator}`).emit('call:accepted', {
       callId,
       answer,
     });

     // Update match video chat stats
     const match = await Match.findById(callSession.matchId);
     if (match) {
       match.videoChat.totalCalls++;
       match.videoChat.lastCallAt = new Date();
       match.videoChat.lastCallInitiatedBy = callSession.initiator;
       await match.save();
     }

   } catch (error) {
     logger.error('Error accepting call:', error);
     socket.emit('error', {
       code: ERROR_CODES.CALL_ACCEPT_FAILED,
       message: 'Failed to accept call',
     });
   }
 }

 /**
  * Handle call end
  */
 async handleCallEnd(socket, data) {
   try {
     const { callId, reason = 'user_ended' } = data;
     
     const callSession = this.activeCalls.get(callId);
     if (!callSession) {
       return;
     }

     // Calculate duration if call was connected
     let duration = 0;
     if (callSession.status === 'connected' && callSession.connectedAt) {
       duration = Date.now() - new Date(callSession.connectedAt).getTime();
     }

     // Update match stats if call was connected
     if (duration > 0) {
       const match = await Match.findById(callSession.matchId);
       if (match) {
         match.videoChat.totalDuration += Math.floor(duration / 1000);
         match.videoChat.lastCallDuration = Math.floor(duration / 1000);
         await match.save();
       }
     }

     // Notify both parties
     this.io.of('/chat').to(`match:${callSession.matchId}`).emit('call:ended', {
       callId,
       reason,
       duration,
     });

     // Clean up
     this.activeCalls.delete(callId);
     await redis.del(`call:${callId}`);

     // Track metrics
     await MetricsService.incrementCounter('chat.calls.ended', 1, { reason });
     if (duration > 0) {
       await MetricsService.recordHistogram('chat.calls.duration', duration / 1000);
     }

   } catch (error) {
     logger.error('Error ending call:', error);
   }
 }

 /**
  * Handle ICE candidates for WebRTC
  */
 async handleIceCandidate(socket, data) {
   try {
     const { callId, candidate } = data;
     
     const callSession = this.activeCalls.get(callId);
     if (!callSession) {
       return;
     }

     const targetUserId = socket.userId === callSession.initiator 
       ? callSession.recipient 
       : callSession.initiator;

     this.io.of('/chat').to(`user:${targetUserId}`).emit('call:ice-candidate', {
       callId,
       candidate,
     });

   } catch (error) {
     logger.error('Error handling ICE candidate:', error);
   }
 }

 /**
  * Handle location sharing
  */
 async handleShareLocation(socket, data) {
   try {
     const { matchId, location, duration = 3600 } = data; // Duration in seconds
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     // Store location with expiry
     const locationKey = `location:${matchId}:${userId}`;
     await redis.set(locationKey, JSON.stringify({
       ...location,
       sharedAt: new Date(),
       expiresAt: new Date(Date.now() + duration * 1000),
     }), duration);

     // Create location message
     const message = await Message.create({
       matchId,
       sender: userId,
       receiver: match.getOtherUser(userId),
       type: MESSAGE_TYPES.LOCATION,
       content: {
         location,
         duration,
       },
       metadata: {
         isLiveLocation: true,
         expiresAt: new Date(Date.now() + duration * 1000),
       },
     });

     // Emit to match
     socket.to(`match:${matchId}`).emit('location:shared', {
       matchId,
       userId,
       location,
       duration,
       expiresAt: message.metadata.expiresAt,
     });

   } catch (error) {
     logger.error('Error sharing location:', error);
     socket.emit('error', {
       code: ERROR_CODES.LOCATION_SHARE_FAILED,
       message: 'Failed to share location',
     });
   }
 }

 /**
  * Handle loading chat history
  */
 async handleLoadHistory(socket, data) {
   try {
     const { matchId, before, limit = 50 } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     const query = {
       matchId,
       $or: [
         { sender: userId, 'visibility.hiddenForSender': false },
         { receiver: userId, 'visibility.hiddenForReceiver': false },
       ],
       'status.isDeleted': false,
     };

     if (before) {
       query.createdAt = { $lt: new Date(before) };
     }

     const messages = await Message.find(query)
       .sort({ createdAt: -1 })
       .limit(limit)
       .populate('sender', 'profile.firstName profile.displayName profile.photos')
       .populate('replyTo')
       .lean();

     const formattedMessages = messages.reverse().map(msg => this.formatMessage(msg));

     socket.emit('chat:history', {
       matchId,
       messages: formattedMessages,
       hasMore: messages.length === limit,
     });

   } catch (error) {
     logger.error('Error loading history:', error);
     socket.emit('error', {
       code: ERROR_CODES.HISTORY_LOAD_FAILED,
       message: 'Failed to load chat history',
     });
   }
 }

 /**
  * Handle disconnect
  */
 handleDisconnect(socket) {
   const userId = socket.userId;
   
   // Clear typing indicators
   socket.matches.forEach(matchId => {
     redis.del(`typing:${matchId}:${userId}`);
     socket.to(`match:${matchId}`).emit('typing:stop', { matchId, userId });
   });

   // Clear typing timeouts
   this.typingTimeouts.forEach((timeout, key) => {
     if (key.startsWith(userId)) {
       clearTimeout(timeout);
       this.typingTimeouts.delete(key);
     }
   });

   // Update online status
   this.setUserOnlineStatus(userId, false);

   logger.info(`User ${userId} disconnected from chat namespace`);
 }

 // ============================
 // Helper Methods
 // ============================

 /**
  * Validate message content
  */
 validateMessage(type, content) {
   switch (type) {
     case MESSAGE_TYPES.TEXT:
       if (!content.text || content.text.trim().length === 0) {
         return {
           code: ERROR_CODES.VALIDATION_ERROR,
           message: 'Text message cannot be empty',
         };
       }
       if (content.text.length > 5000) {
         return {
           code: ERROR_CODES.VALIDATION_ERROR,
           message: 'Message too long (max 5000 characters)',
         };
       }
       break;

     case MESSAGE_TYPES.IMAGE:
     case MESSAGE_TYPES.VIDEO:
     case MESSAGE_TYPES.AUDIO:
       if (!content.mediaUrl) {
         return {
           code: ERROR_CODES.VALIDATION_ERROR,
           message: 'Media URL is required',
         };
       }
       break;

     case MESSAGE_TYPES.LOCATION:
       if (!content.location?.latitude || !content.location?.longitude) {
         return {
           code: ERROR_CODES.VALIDATION_ERROR,
           message: 'Invalid location data',
         };
       }
       break;

     case MESSAGE_TYPES.GIF:
     case MESSAGE_TYPES.STICKER:
       if (!content.url && !content.id) {
         return {
           code: ERROR_CODES.VALIDATION_ERROR,
           message: 'GIF/Sticker URL or ID is required',
         };
       }
       break;

     default:
       return {
         code: ERROR_CODES.VALIDATION_ERROR,
         message: 'Invalid message type',
       };
   }

   return null;
 }

 /**
  * Format message for emission
  */
 formatMessage(message) {
   return {
     id: message._id,
     matchId: message.matchId,
     sender: message.sender,
     type: message.type,
     content: message.content,
     status: message.status,
     reactions: message.reactions,
     replyTo: message.replyTo,
     metadata: message.metadata,
     createdAt: message.createdAt,
     updatedAt: message.updatedAt,
   };
 }

 /**
  * Check if user is online
  */
async isUserOnline(userId) {
   return socketManager.isUserOnline(userId.toString());
 }

 /**
  * Set user online status
  */
 async setUserOnlineStatus(userId, isOnline) {
   const key = `chat:online:${userId}`;
   if (isOnline) {
     await redis.set(key, '1', 300); // 5 minutes TTL
   } else {
     await redis.del(key);
   }
 }

 /**
  * Send message notification
  */
 async sendMessageNotification(message, match) {
   try {
     const sender = await User.findById(message.sender)
       .select('profile.firstName profile.displayName');

     const senderName = sender?.profile?.displayName || sender?.profile?.firstName;
     
     let notificationBody = '';
     switch (message.type) {
       case MESSAGE_TYPES.TEXT:
         notificationBody = message.content.text;
         break;
       case MESSAGE_TYPES.IMAGE:
         notificationBody = '📷 Sent a photo';
         break;
       case MESSAGE_TYPES.VIDEO:
         notificationBody = '📹 Sent a video';
         break;
       case MESSAGE_TYPES.AUDIO:
         notificationBody = '🎵 Sent an audio message';
         break;
       case MESSAGE_TYPES.VOICE:
         notificationBody = '🎤 Sent a voice message';
         break;
       case MESSAGE_TYPES.LOCATION:
         notificationBody = '📍 Shared location';
         break;
       case MESSAGE_TYPES.GIF:
         notificationBody = 'Sent a GIF';
         break;
       case MESSAGE_TYPES.STICKER:
         notificationBody = 'Sent a sticker';
         break;
       default:
         notificationBody = 'Sent a message';
     }

     // Check if recipient has muted this match
     const userIndex = match.users.findIndex(u => u.toString() === message.receiver.toString());
     const isMuted = userIndex === 0 ? match.chat?.isMuted?.user1 : match.chat?.isMuted?.user2;
     
     if (!isMuted) {
       await NotificationService.sendNotification(message.receiver.toString(), {
         type: NOTIFICATION_TYPES.NEW_MESSAGE,
         title: senderName,
         body: notificationBody,
         data: {
           matchId: match._id.toString(),
           messageId: message._id.toString(),
           senderId: message.sender.toString(),
         },
         priority: 'high',
       });
     }
   } catch (error) {
     logger.error('Error sending message notification:', error);
   }
 }

 /**
  * Add message to delivery queue
  */
 addToMessageQueue(messageId, recipientId) {
   if (!this.messageQueue.has(recipientId)) {
     this.messageQueue.set(recipientId, new Set());
   }
   this.messageQueue.get(recipientId).add(messageId);

   // Set timeout to mark as delivered after 30 seconds
   setTimeout(() => {
     this.checkAndMarkDelivered(recipientId, messageId);
   }, 30000);
 }

 /**
  * Check and mark messages as delivered
  */
 async checkAndMarkDelivered(recipientId, messageId) {
   try {
     const queue = this.messageQueue.get(recipientId);
     if (!queue || !queue.has(messageId)) {
       return;
     }

     const isOnline = await this.isUserOnline(recipientId);
     if (isOnline) {
       await Message.findByIdAndUpdate(messageId, {
         $set: {
           'status.delivered': true,
           'status.deliveredAt': new Date(),
         },
       });

       queue.delete(messageId);
       if (queue.size === 0) {
         this.messageQueue.delete(recipientId);
       }
     }
   } catch (error) {
     logger.error('Error marking message as delivered:', error);
   }
 }

 /**
  * Send pending messages when user comes online
  */
 async sendPendingMessages(socket) {
   try {
     const userId = socket.userId;
     const queue = this.messageQueue.get(userId);
     
     if (!queue || queue.size === 0) {
       return;
     }

     const messageIds = Array.from(queue);
     
     // Mark messages as delivered
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

     // Get undelivered messages
     const messages = await Message.find({
       receiver: userId,
       'status.delivered': false,
       'status.isDeleted': false,
     })
       .populate('sender', 'profile.firstName profile.displayName profile.photos')
       .sort({ createdAt: -1 })
       .limit(50);

     if (messages.length > 0) {
       socket.emit('messages:pending', {
         messages: messages.map(msg => this.formatMessage(msg)),
       });
     }

     // Clear queue
     this.messageQueue.delete(userId);

   } catch (error) {
     logger.error('Error sending pending messages:', error);
   }
 }

 /**
  * Handle special message types
  */
 async handleSpecialMessageTypes(message, match) {
   try {
     switch (message.type) {
       case MESSAGE_TYPES.GAME_INVITE:
         await this.handleGameInviteMessage(message, match);
         break;
         
       case MESSAGE_TYPES.VIRTUAL_GIFT:
         await this.handleVirtualGiftMessage(message, match);
         break;
         
       case MESSAGE_TYPES.DATE_REQUEST:
         await this.handleDateRequestMessage(message, match);
         break;
         
       case MESSAGE_TYPES.SPOTIFY_TRACK:
         await this.handleSpotifyTrackMessage(message, match);
         break;
         
       case MESSAGE_TYPES.INSTAGRAM_POST:
         await this.handleInstagramPostMessage(message, match);
         break;
     }
   } catch (error) {
     logger.error('Error handling special message type:', error);
   }
 }

 /**
  * Handle voice recording
  */
 async handleVoiceRecord(socket, data) {
   try {
     const { matchId, action } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return;
     }

     if (action === 'start') {
       // Notify other user that recording started
       socket.to(`match:${matchId}`).emit('voice:recording', {
         matchId,
         userId,
         isRecording: true,
       });
     } else if (action === 'stop') {
       // Notify recording stopped
       socket.to(`match:${matchId}`).emit('voice:recording', {
         matchId,
         userId,
         isRecording: false,
       });
     }
   } catch (error) {
     logger.error('Error handling voice recording:', error);
   }
 }

 /**
  * Handle voice message send
  */
 async handleVoiceSend(socket, data) {
   try {
     const { matchId, audioUrl, duration, waveform } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     // Validate duration (max 1 minute)
     if (duration > 60) {
       return socket.emit('error', {
         code: ERROR_CODES.VALIDATION_ERROR,
         message: 'Voice messages cannot exceed 1 minute',
       });
     }

     // Create voice message
     await this.handleSendMessage(socket, {
       matchId,
       type: MESSAGE_TYPES.VOICE,
       content: {
         audioUrl,
         duration,
         waveform,
       },
     });

   } catch (error) {
     logger.error('Error sending voice message:', error);
     socket.emit('error', {
       code: ERROR_CODES.VOICE_SEND_FAILED,
       message: 'Failed to send voice message',
     });
   }
 }

 /**
  * Handle game invite
  */
 async handleGameInvite(socket, data) {
   try {
     const { matchId, gameType, gameData } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     const match = await Match.findById(matchId);
     const recipientId = match.getOtherUser(userId);

     // Create game session
     const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
     const gameSession = {
       gameId,
       matchId,
       type: gameType,
       players: [userId, recipientId.toString()],
       initiator: userId,
       status: 'pending',
       data: gameData,
       createdAt: new Date(),
     };

     // Store game session
     await redis.set(`game:${gameId}`, JSON.stringify(gameSession), 3600);

     // Send game invite message
     await this.handleSendMessage(socket, {
       matchId,
       type: MESSAGE_TYPES.GAME_INVITE,
       content: {
         gameId,
         gameType,
         gameData,
       },
     });

     // Emit game invite event
     this.io.of('/chat').to(`user:${recipientId}`).emit('game:invite', {
       gameId,
       matchId,
       gameType,
       inviter: {
         id: userId,
         name: socket.user?.profile?.firstName,
       },
     });

   } catch (error) {
     logger.error('Error sending game invite:', error);
     socket.emit('error', {
       code: ERROR_CODES.GAME_INVITE_FAILED,
       message: 'Failed to send game invite',
     });
   }
 }

 /**
  * Handle game acceptance
  */
 async handleGameAccept(socket, data) {
   try {
     const { gameId } = data;
     const userId = socket.userId;

     const gameSession = await redis.get(`game:${gameId}`);
     if (!gameSession) {
       return socket.emit('error', {
         code: ERROR_CODES.GAME_NOT_FOUND,
         message: 'Game session not found',
       });
     }

     const game = JSON.parse(gameSession);
     
     if (!game.players.includes(userId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this game',
       });
     }

     // Update game status
     game.status = 'active';
     game.startedAt = new Date();
     await redis.set(`game:${gameId}`, JSON.stringify(game), 3600);

     // Notify both players
     game.players.forEach(playerId => {
       this.io.of('/chat').to(`user:${playerId}`).emit('game:started', {
         gameId,
         game,
       });
     });

   } catch (error) {
     logger.error('Error accepting game:', error);
     socket.emit('error', {
       code: ERROR_CODES.GAME_ACCEPT_FAILED,
       message: 'Failed to accept game invite',
     });
   }
 }

 /**
  * Handle game move
  */
 async handleGameMove(socket, data) {
   try {
     const { gameId, move } = data;
     const userId = socket.userId;

     const gameSession = await redis.get(`game:${gameId}`);
     if (!gameSession) {
       return socket.emit('error', {
         code: ERROR_CODES.GAME_NOT_FOUND,
         message: 'Game session not found',
       });
     }

     const game = JSON.parse(gameSession);
     
     if (!game.players.includes(userId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this game',
       });
     }

     // Update game state
     if (!game.moves) {
       game.moves = [];
     }
     game.moves.push({
       player: userId,
       move,
       timestamp: new Date(),
     });
     game.lastMove = new Date();
     
     await redis.set(`game:${gameId}`, JSON.stringify(game), 3600);

     // Notify other player
     const otherPlayer = game.players.find(p => p !== userId);
     this.io.of('/chat').to(`user:${otherPlayer}`).emit('game:move', {
       gameId,
       move,
       player: userId,
     });

   } catch (error) {
     logger.error('Error handling game move:', error);
     socket.emit('error', {
       code: ERROR_CODES.GAME_MOVE_FAILED,
       message: 'Failed to process game move',
     });
   }
 }

 /**
  * Handle media upload notification
  */
 async handleMediaUpload(socket, data) {
   try {
     const { matchId, mediaType, uploadProgress } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return;
     }

     // Broadcast upload progress to match
     socket.to(`match:${matchId}`).emit('media:uploading', {
       matchId,
       userId,
       mediaType,
       progress: uploadProgress,
     });

   } catch (error) {
     logger.error('Error handling media upload:', error);
   }
 }

 /**
  * Handle search in messages
  */
 async handleSearchMessages(socket, data) {
   try {
     const { matchId, query, type } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     const searchQuery = {
       matchId,
       'status.isDeleted': false,
     };

     if (type === 'text') {
       searchQuery.$text = { $search: query };
     } else if (type === 'media') {
       searchQuery.type = { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO] };
     } else if (type === 'links') {
       searchQuery['content.text'] = { $regex: /https?:\/\//i };
     }

     const results = await Message.find(searchQuery)
       .sort({ createdAt: -1 })
       .limit(50)
       .populate('sender', 'profile.firstName profile.displayName')
       .lean();

     socket.emit('chat:search:results', {
       matchId,
       query,
       results: results.map(msg => this.formatMessage(msg)),
     });

   } catch (error) {
     logger.error('Error searching messages:', error);
     socket.emit('error', {
       code: ERROR_CODES.SEARCH_FAILED,
       message: 'Failed to search messages',
     });
   }
 }

 /**
  * Handle chat export request
  */
 async handleExportChat(socket, data) {
   try {
     const { matchId, format = 'json' } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     // Get all messages
     const messages = await Message.find({
       matchId,
       'status.isDeleted': false,
     })
       .sort({ createdAt: 1 })
       .populate('sender', 'profile.firstName profile.displayName')
       .lean();

     let exportData;
     
     if (format === 'json') {
       exportData = JSON.stringify(messages, null, 2);
     } else if (format === 'txt') {
       exportData = messages.map(msg => {
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
           default:
             content = `[${msg.type}]`;
         }
         
         return `[${timestamp}] ${sender}: ${content}`;
       }).join('\n');
     }

     socket.emit('chat:export:ready', {
       matchId,
       format,
       data: exportData,
       messageCount: messages.length,
     });

   } catch (error) {
     logger.error('Error exporting chat:', error);
     socket.emit('error', {
       code: ERROR_CODES.EXPORT_FAILED,
       message: 'Failed to export chat',
     });
   }
 }

 /**
  * Handle clear chat
  */
 async handleClearChat(socket, data) {
   try {
     const { matchId } = data;
     const userId = socket.userId;

     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     // Soft delete messages for this user
     await Message.updateMany(
       {
         matchId,
         sender: userId,
       },
       {
         $set: { 'visibility.hiddenForSender': true },
       }
     );

     await Message.updateMany(
       {
         matchId,
         receiver: userId,
       },
       {
         $set: { 'visibility.hiddenForReceiver': true },
       }
     );

     socket.emit('chat:cleared', { matchId });

   } catch (error) {
     logger.error('Error clearing chat:', error);
     socket.emit('error', {
       code: ERROR_CODES.CLEAR_FAILED,
       message: 'Failed to clear chat',
     });
   }
 }

 /**
  * Handle presence update
  */
 async handlePresenceUpdate(socket, data) {
   try {
     const { status, statusMessage } = data;
     const userId = socket.userId;

     // Update user presence
     await redis.set(`presence:${userId}`, JSON.stringify({
       status,
       statusMessage,
       lastUpdated: new Date(),
     }), 300);

     // Broadcast to all matches
     socket.matches.forEach(matchId => {
       socket.to(`match:${matchId}`).emit('presence:updated', {
         userId,
         status,
         statusMessage,
       });
     });

   } catch (error) {
     logger.error('Error updating presence:', error);
   }
 }

 /**
  * Handle get presence
  */
 async handleGetPresence(socket, data) {
   try {
     const { userIds } = data;
     const presenceData = {};

     for (const userId of userIds) {
       // Check if user is in matches
       if (socket.matchUsers.has(userId)) {
         const presence = await redis.get(`presence:${userId}`);
         if (presence) {
           presenceData[userId] = JSON.parse(presence);
         } else {
           presenceData[userId] = {
             status: await this.isUserOnline(userId) ? 'online' : 'offline',
             lastUpdated: null,
           };
         }
       }
     }

     socket.emit('presence:data', presenceData);

   } catch (error) {
     logger.error('Error getting presence:', error);
   }
 }

 /**
  * Handle subscribe to match updates
  */
 async handleSubscribeToMatch(socket, data) {
   try {
     const { matchId } = data;
     
     if (!socket.matches.includes(matchId)) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized for this match',
       });
     }

     socket.join(`match:${matchId}:updates`);
     socket.emit('chat:subscribed', { matchId });

   } catch (error) {
     logger.error('Error subscribing to match:', error);
   }
 }

 /**
  * Handle unsubscribe from match
  */
 async handleUnsubscribeFromMatch(socket, data) {
   try {
     const { matchId } = data;
     
     socket.leave(`match:${matchId}:updates`);
     socket.emit('chat:unsubscribed', { matchId });

   } catch (error) {
     logger.error('Error unsubscribing from match:', error);
   }
 }

 /**
  * Handle stop location sharing
  */
 async handleStopLocationSharing(socket, data) {
   try {
     const { matchId } = data;
     const userId = socket.userId;

     const locationKey = `location:${matchId}:${userId}`;
     await redis.del(locationKey);

     socket.to(`match:${matchId}`).emit('location:stopped', {
       matchId,
       userId,
     });

   } catch (error) {
     logger.error('Error stopping location sharing:', error);
   }
 }

 /**
  * Handle call signal (for WebRTC signaling)
  */
 async handleCallSignal(socket, data) {
   try {
     const { callId, signal } = data;
     
     const callSession = this.activeCalls.get(callId);
     if (!callSession) {
       return;
     }

     const targetUserId = socket.userId === callSession.initiator 
       ? callSession.recipient 
       : callSession.initiator;

     this.io.of('/chat').to(`user:${targetUserId}`).emit('call:signal', {
       callId,
       signal,
     });

   } catch (error) {
     logger.error('Error handling call signal:', error);
   }
 }

 /**
  * Handle call rejection
  */
 async handleCallReject(socket, data) {
   try {
     const { callId, reason = 'busy' } = data;
     const userId = socket.userId;

     const callSession = this.activeCalls.get(callId);
     if (!callSession) {
       return;
     }

     if (callSession.recipient !== userId) {
       return socket.emit('error', {
         code: ERROR_CODES.FORBIDDEN,
         message: 'Not authorized to reject this call',
       });
     }

     // Notify initiator
     this.io.of('/chat').to(`user:${callSession.initiator}`).emit('call:rejected', {
       callId,
       reason,
     });

     // Clean up
     this.activeCalls.delete(callId);
     await redis.del(`call:${callId}`);

     // Track metrics
     await MetricsService.incrementCounter('chat.calls.rejected', 1, { reason });

   } catch (error) {
     logger.error('Error rejecting call:', error);
   }
 }

 /**
  * Handle marking messages as delivered
  */
 async handleMarkAsDelivered(socket, data) {
   try {
     const { messageIds } = data;
     const userId = socket.userId;

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

     // Notify senders
     const messages = await Message.find({
       _id: { $in: messageIds },
     }).select('sender matchId');

     const senderNotifications = {};
     messages.forEach(msg => {
       if (!senderNotifications[msg.sender]) {
         senderNotifications[msg.sender] = [];
       }
       senderNotifications[msg.sender].push(msg._id);
     });

     Object.entries(senderNotifications).forEach(([senderId, msgIds]) => {
       this.io.of('/chat').to(`user:${senderId}`).emit('message:delivered', {
         messageIds: msgIds,
         deliveredTo: userId,
         deliveredAt: new Date(),
       });
     });

   } catch (error) {
     logger.error('Error marking messages as delivered:', error);
   }
 }

 /**
  * Handle media download tracking
  */
 async handleMediaDownload(socket, data) {
   try {
     const { messageId } = data;
     const userId = socket.userId;

     const message = await Message.findById(messageId);
     if (!message) {
       return;
     }

     // Track download
     if (!message.metadata.downloads) {
       message.metadata.downloads = [];
     }
     
     message.metadata.downloads.push({
       userId,
       downloadedAt: new Date(),
     });
     
     await message.save();

     // Notify sender
     if (message.sender.toString() !== userId) {
       this.io.of('/chat').to(`user:${message.sender}`).emit('media:downloaded', {
         messageId,
         downloadedBy: userId,
         downloadedAt: new Date(),
       });
     }

   } catch (error) {
     logger.error('Error tracking media download:', error);
   }
 }
}

export default new ChatSocketHandler();