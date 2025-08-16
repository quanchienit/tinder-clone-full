// src/modules/chat/chat.routes.js
import { Router } from 'express';
import ChatController from './chat.controller.js';
import { 
 authenticate, 
 requireCompleteProfile,
 requirePremium,
 requireVerifiedEmail
} from '../../shared/middleware/auth.middleware.js';
import {
 messageLimiter,
 customRateLimiter,
 tieredRateLimiter,
} from '../../shared/middleware/rateLimiter.middleware.js';
import {
 cacheMiddleware,
 clearCache,
 invalidateCache,
 conditionalCache,
 bypassCache,
} from '../../shared/middleware/cache.middleware.js';
import {
 sanitizeRequest,
 validatePagination,
 validateObjectId,
 validate,
} from '../../shared/middleware/validation.middleware.js';
import { messageValidators } from '../../shared/utils/validators.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import multer from 'multer';
import { fileFilter, limits } from '../../shared/middleware/upload.middleware.js';

const router = Router();

/**
* @route   /api/chat
* @desc    Chat and messaging routes
*/

// Configure multer for file uploads
const upload = multer({
 storage: multer.memoryStorage(),
 limits: {
   fileSize: 50 * 1024 * 1024, // 50MB max
   files: 1,
 },
 fileFilter: (req, file, cb) => {
   // Accept images, videos, and audio
   const allowedMimeTypes = [
     'image/jpeg',
     'image/png',
     'image/gif',
     'image/webp',
     'video/mp4',
     'video/quicktime',
     'video/webm',
     'audio/mpeg',
     'audio/wav',
     'audio/ogg',
     'audio/webm',
   ];

   if (allowedMimeTypes.includes(file.mimetype)) {
     cb(null, true);
   } else {
     cb(new Error('Invalid file type. Only images, videos, and audio files are allowed.'), false);
   }
 },
});

// Apply authentication to all routes
router.use(authenticate);
router.use(requireCompleteProfile);

// ============================
// Message Routes
// ============================

/**
* @route   POST /api/chat/:matchId/messages
* @desc    Send a message
* @access  Private
*/
router.post(
 '/:matchId/messages',
 messageLimiter,
 sanitizeRequest,
 validateObjectId('matchId'),
 messageValidators.sendMessage,
 validate,
 clearCache(['messages:*', 'matches:*']),
 ChatController.sendMessage
);

/**
* @route   GET /api/chat/:matchId/messages
* @desc    Get messages for a match
* @access  Private
*/
router.get(
 '/:matchId/messages',
 validateObjectId('matchId'),
 messageValidators.getMessages,
 validate,
 conditionalCache(
   (req) => !req.query.after && !req.query.realtime,
   { ttl: 60, includeUser: true }
 ),
 ChatController.getMessages
);

/**
* @route   PUT /api/chat/messages/:messageId
* @desc    Edit a message
* @access  Private
*/
router.put(
 '/messages/:messageId',
 customRateLimiter({ limit: 10, window: 300 }),
 sanitizeRequest,
 validateObjectId('messageId'),
 messageValidators.editMessage,
 validate,
 clearCache(['messages:*']),
 ChatController.editMessage
);

/**
* @route   DELETE /api/chat/messages/:messageId
* @desc    Delete a message
* @access  Private
*/
router.delete(
 '/messages/:messageId',
 validateObjectId('messageId'),
 messageValidators.deleteMessage,
 validate,
 clearCache(['messages:*']),
 ChatController.deleteMessage
);

/**
* @route   POST /api/chat/messages/:messageId/react
* @desc    React to a message
* @access  Private
*/
router.post(
 '/messages/:messageId/react',
 customRateLimiter({ limit: 30, window: 60 }),
 validateObjectId('messageId'),
 sanitizeRequest,
 ChatController.reactToMessage
);

/**
* @route   POST /api/chat/:matchId/messages/read
* @desc    Mark messages as read
* @access  Private
*/
router.post(
 '/:matchId/messages/read',
 validateObjectId('matchId'),
 clearCache(['unread:*', 'matches:*']),
 ChatController.markAsRead
);

// ============================
// Media Message Routes
// ============================

/**
* @route   POST /api/chat/:matchId/messages/media
* @desc    Send media message (image/video)
* @access  Private
*/
router.post(
 '/:matchId/messages/media',
 tieredRateLimiter,
 validateObjectId('matchId'),
 upload.single('media'),
 clearCache(['messages:*', 'matches:*']),
 ChatController.sendMediaMessage
);

/**
* @route   POST /api/chat/:matchId/messages/voice
* @desc    Send voice message
* @access  Private
*/
router.post(
 '/:matchId/messages/voice',
 customRateLimiter({ limit: 20, window: 300 }),
 validateObjectId('matchId'),
 upload.single('audio'),
 clearCache(['messages:*', 'matches:*']),
 ChatController.sendVoiceMessage
);

/**
* @route   POST /api/chat/:matchId/messages/location
* @desc    Send location message
* @access  Private
*/
router.post(
 '/:matchId/messages/location',
 customRateLimiter({ limit: 10, window: 300 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 clearCache(['messages:*']),
 ChatController.sendLocation
);

/**
* @route   POST /api/chat/:matchId/messages/gif
* @desc    Send GIF or sticker
* @access  Private
*/
router.post(
 '/:matchId/messages/gif',
 messageLimiter,
 validateObjectId('matchId'),
 sanitizeRequest,
 clearCache(['messages:*']),
 ChatController.sendGif
);

// ============================
// Special Message Types
// ============================

/**
* @route   POST /api/chat/:matchId/messages/game
* @desc    Send game invite
* @access  Private
*/
router.post(
 '/:matchId/messages/game',
 customRateLimiter({ limit: 5, window: 300 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 clearCache(['messages:*']),
 ChatController.sendGameInvite
);

/**
* @route   POST /api/chat/:matchId/messages/gift
* @desc    Send virtual gift (Premium)
* @access  Private
*/
router.post(
 '/:matchId/messages/gift',
 requirePremium('plus'),
 customRateLimiter({ limit: 10, window: 3600 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 clearCache(['messages:*']),
 ChatController.sendVirtualGift
);

/**
* @route   POST /api/chat/:matchId/messages/date
* @desc    Send date request
* @access  Private
*/
router.post(
 '/:matchId/messages/date',
 customRateLimiter({ limit: 3, window: 3600 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 clearCache(['messages:*']),
 ChatController.sendDateRequest
);

// ============================
// Typing & Presence Routes
// ============================

/**
* @route   POST /api/chat/:matchId/typing
* @desc    Send typing indicator
* @access  Private
*/
router.post(
 '/:matchId/typing',
 customRateLimiter({ limit: 60, window: 60 }),
 validateObjectId('matchId'),
 ChatController.sendTypingIndicator
);

// ============================
// Search & Filter Routes
// ============================

/**
* @route   GET /api/chat/:matchId/messages/search
* @desc    Search messages in a chat
* @access  Private
*/
router.get(
 '/:matchId/messages/search',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 300 }),
 ChatController.searchMessages
);

/**
* @route   GET /api/chat/:matchId/media
* @desc    Get all media from a chat
* @access  Private
*/
router.get(
 '/:matchId/media',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 600 }),
 ChatController.getMatchMedia
);

/**
* @route   GET /api/chat/:matchId/links
* @desc    Get shared links from a chat
* @access  Private
*/
router.get(
 '/:matchId/links',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 600 }),
 ChatController.getSharedLinks
);

// ============================
// Scheduled Messages Routes (Premium)
// ============================

/**
* @route   POST /api/chat/:matchId/messages/schedule
* @desc    Schedule a message (Premium)
* @access  Private
*/
router.post(
 '/:matchId/messages/schedule',
 requirePremium('gold'),
 customRateLimiter({ limit: 10, window: 3600 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 ChatController.scheduleMessage
);

/**
* @route   GET /api/chat/:matchId/messages/scheduled
* @desc    Get scheduled messages (Premium)
* @access  Private
*/
router.get(
 '/:matchId/messages/scheduled',
 requirePremium('gold'),
 validateObjectId('matchId'),
 ChatController.getScheduledMessages
);

/**
* @route   DELETE /api/chat/messages/:messageId/schedule
* @desc    Cancel scheduled message (Premium)
* @access  Private
*/
router.delete(
 '/messages/:messageId/schedule',
 requirePremium('gold'),
 validateObjectId('messageId'),
 ChatController.cancelScheduledMessage
);

// ============================
// Pin Messages Routes
// ============================

/**
* @route   PUT /api/chat/messages/:messageId/pin
* @desc    Pin/unpin a message
* @access  Private
*/
router.put(
 '/messages/:messageId/pin',
 validateObjectId('messageId'),
 clearCache(['pinned:*']),
 ChatController.togglePinMessage
);

/**
* @route   GET /api/chat/:matchId/messages/pinned
* @desc    Get pinned messages
* @access  Private
*/
router.get(
 '/:matchId/messages/pinned',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 300 }),
 ChatController.getPinnedMessages
);

// ============================
// Chat Management Routes
// ============================

/**
* @route   GET /api/chat/:matchId/stats
* @desc    Get chat statistics
* @access  Private
*/
router.get(
 '/:matchId/stats',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 3600, includeUser: true }),
 ChatController.getChatStats
);

/**
* @route   GET /api/chat/:matchId/export
* @desc    Export chat history (Premium)
* @access  Private
*/
router.get(
 '/:matchId/export',
 requirePremium('plus'),
 validateObjectId('matchId'),
 customRateLimiter({ limit: 5, window: 3600 }),
 ChatController.exportChat
);

/**
* @route   DELETE /api/chat/:matchId/clear
* @desc    Clear chat history
* @access  Private
*/
router.delete(
 '/:matchId/clear',
 validateObjectId('matchId'),
 customRateLimiter({ limit: 3, window: 3600 }),
 clearCache(['messages:*', 'matches:*']),
 ChatController.clearChat
);

/**
* @route   POST /api/chat/messages/:messageId/report
* @desc    Report a message
* @access  Private
*/
router.post(
 '/messages/:messageId/report',
 validateObjectId('messageId'),
 customRateLimiter({ limit: 5, window: 3600 }),
 sanitizeRequest,
 messageValidators.reportMessage,
 validate,
 ChatController.reportMessage
);

// ============================
// AI & Translation Routes (Premium)
// ============================

/**
* @route   GET /api/chat/:matchId/summary
* @desc    Get AI conversation summary (Premium)
* @access  Private
*/
router.get(
 '/:matchId/summary',
 requirePremium('platinum'),
 validateObjectId('matchId'),
 customRateLimiter({ limit: 10, window: 3600 }),
 cacheMiddleware({ ttl: 3600 }),
 ChatController.getConversationSummary
);

/**
* @route   POST /api/chat/messages/:messageId/translate
* @desc    Translate a message (Premium)
* @access  Private
*/
router.post(
 '/messages/:messageId/translate',
 requirePremium('plus'),
 validateObjectId('messageId'),
 customRateLimiter({ limit: 20, window: 3600 }),
 cacheMiddleware({ ttl: 86400 }),
 ChatController.translateMessage
);

// ============================
// Unread & Notifications Routes
// ============================

/**
* @route   GET /api/chat/unread
* @desc    Get unread message count
* @access  Private
*/
router.get(
 '/unread',
 cacheMiddleware({ ttl: 30, includeUser: true }),
 ChatController.getUnreadCount
);

// ============================
// Voice/Video Call Routes
// ============================

/**
* @route   POST /api/chat/:matchId/call/initiate
* @desc    Initiate voice/video call
* @access  Private
*/
router.post(
 '/:matchId/call/initiate',
 requireVerifiedEmail,
 customRateLimiter({ limit: 5, window: 300 }),
 validateObjectId('matchId'),
 sanitizeRequest,
 asyncHandler(async (req, res) => {
   // This would be handled via WebSocket
   return res.json({
     success: true,
     message: 'Call initiation should be done via WebSocket',
   });
 })
);

/**
* @route   POST /api/chat/:matchId/call/end
* @desc    End voice/video call
* @access  Private
*/
router.post(
 '/:matchId/call/end',
 validateObjectId('matchId'),
 asyncHandler(async (req, res) => {
   // This would be handled via WebSocket
   return res.json({
     success: true,
     message: 'Call ending should be done via WebSocket',
   });
 })
);

/**
* @route   GET /api/chat/:matchId/call/history
* @desc    Get call history
* @access  Private
*/
router.get(
 '/:matchId/call/history',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 300 }),
 asyncHandler(async (req, res) => {
   const { matchId } = req.params;
   const Message = (await import('./message.model.js')).default;
   
   const calls = await Message.find({
     matchId,
     type: 'CALL',
     'status.isDeleted': false,
   })
     .select('content.callType content.callDuration content.callStatus createdAt sender')
     .populate('sender', 'profile.firstName profile.displayName')
     .sort({ createdAt: -1 })
     .limit(20)
     .lean();

   return res.json({
     success: true,
     data: { calls },
   });
 })
);

// ============================
// Batch Operations Routes
// ============================

/**
* @route   POST /api/chat/messages/batch/delete
* @desc    Delete multiple messages
* @access  Private
*/
router.post(
 '/messages/batch/delete',
 customRateLimiter({ limit: 5, window: 300 }),
 sanitizeRequest,
 clearCache(['messages:*']),
 asyncHandler(async (req, res) => {
   const { messageIds, deleteForEveryone = false } = req.body;
   const userId = req.user._id.toString();

   if (!Array.isArray(messageIds) || messageIds.length === 0) {
     return res.status(400).json({
       success: false,
       error: { message: 'Message IDs array is required' },
     });
   }

   const results = [];
   for (const messageId of messageIds) {
     try {
       const result = await ChatService.deleteMessage(userId, messageId, deleteForEveryone);
       results.push({ messageId, success: true });
     } catch (error) {
       results.push({ messageId, success: false, error: error.message });
     }
   }

   return res.json({
     success: true,
     data: { results },
   });
 })
);

/**
* @route   POST /api/chat/messages/batch/read
* @desc    Mark multiple messages as read
* @access  Private
*/
router.post(
 '/messages/batch/read',
 sanitizeRequest,
 clearCache(['unread:*']),
 asyncHandler(async (req, res) => {
   const { matchIds } = req.body;
   const userId = req.user._id.toString();

   if (!Array.isArray(matchIds)) {
     return res.status(400).json({
       success: false,
       error: { message: 'Match IDs array is required' },
     });
   }

   const results = [];
   for (const matchId of matchIds) {
     try {
       const result = await ChatService.markMessagesAsRead(userId, matchId);
       results.push({ matchId, ...result });
     } catch (error) {
       results.push({ matchId, success: false, error: error.message });
     }
   }

   return res.json({
     success: true,
     data: { results },
   });
 })
);

// ============================
// Settings Routes
// ============================

/**
* @route   GET /api/chat/settings
* @desc    Get chat settings
* @access  Private
*/
router.get(
 '/settings',
 cacheMiddleware({ ttl: 3600, includeUser: true }),
 asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const User = (await import('../user/user.model.js')).default;
   
   const user = await User.findById(userId).select('chatSettings preferences');
   
   return res.json({
     success: true,
     data: {
       settings: user.chatSettings || {
         soundEnabled: true,
         desktopNotifications: true,
         autoDownloadMedia: true,
         enterToSend: true,
       },
       preferences: {
         autoTranslate: user.preferences?.autoTranslate || false,
         language: user.preferences?.language || 'en',
       },
     },
   });
 })
);

/**
* @route   PUT /api/chat/settings
* @desc    Update chat settings
* @access  Private
*/
router.put(
 '/settings',
 sanitizeRequest,
 clearCache(['settings:*']),
 asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { settings } = req.body;
   
   const User = (await import('../user/user.model.js')).default;
   
   await User.findByIdAndUpdate(userId, {
     $set: { chatSettings: settings },
   });
   
   return res.json({
     success: true,
     message: 'Chat settings updated',
   });
 })
);

// ============================
// Sticker Packs Routes
// ============================

/**
* @route   GET /api/chat/stickers/packs
* @desc    Get available sticker packs
* @access  Private
*/
router.get(
 '/stickers/packs',
 cacheMiddleware({ ttl: 86400 }),
 asyncHandler(async (req, res) => {
   // Mock sticker packs
   const stickerPacks = [
     {
       id: 'love',
       name: 'Love & Romance',
       preview: '/stickers/love/preview.png',
       count: 24,
       isPremium: false,
     },
     {
       id: 'fun',
       name: 'Fun & Playful',
       preview: '/stickers/fun/preview.png',
       count: 32,
       isPremium: false,
     },
     {
       id: 'premium',
       name: 'Premium Pack',
       preview: '/stickers/premium/preview.png',
       count: 48,
       isPremium: true,
     },
   ];
   
   return res.json({
     success: true,
     data: { stickerPacks },
   });
 })
);

/**
* @route   GET /api/chat/stickers/pack/:packId
* @desc    Get stickers from a pack
* @access  Private
*/
router.get(
 '/stickers/pack/:packId',
 cacheMiddleware({ ttl: 86400 }),
 asyncHandler(async (req, res) => {
   const { packId } = req.params;
   
   // Mock stickers
   const stickers = Array.from({ length: 12 }, (_, i) => ({
     id: `${packId}_${i + 1}`,
     url: `/stickers/${packId}/${i + 1}.png`,
     name: `Sticker ${i + 1}`,
   }));
   
   return res.json({
     success: true,
     data: { stickers },
   });
 })
);

// ============================
// Health Check
// ============================

/**
* @route   GET /api/chat/health
* @desc    Health check for chat service
* @access  Public
*/
router.get('/health', (req, res) => {
 res.json({
   success: true,
   service: 'chat',
   timestamp: new Date().toISOString(),
   uptime: process.uptime(),
 });
});

// ============================
// Error Handling
// ============================

// Handle 404 for chat routes
router.use((req, res) => {
 res.status(404).json({
   success: false,
   error: {
     message: 'Chat endpoint not found',
     code: 'NOT_FOUND',
     path: req.originalUrl,
   },
 });
});

// Export router
export default router;