// src/modules/chat/message.model.js
import mongoose from 'mongoose';
import { MESSAGE_TYPES, MESSAGE_STATUS } from '../../config/constants.js';

const { Schema } = mongoose;

/**
* Message Schema - Represents chat messages between matched users
*/
const messageSchema = new Schema(
 {
   // Match reference
   matchId: {
     type: Schema.Types.ObjectId,
     ref: 'Match',
     required: true,
     index: true,
   },

   // Sender
   sender: {
     type: Schema.Types.ObjectId,
     ref: 'User',
     required: true,
     index: true,
   },

   // Receiver
   receiver: {
     type: Schema.Types.ObjectId,
     ref: 'User',
     required: true,
     index: true,
   },

   // Message type
   type: {
     type: String,
     enum: Object.values(MESSAGE_TYPES),
     default: MESSAGE_TYPES.TEXT,
     required: true,
     index: true,
   },

   // Message content (varies by type)
   content: {
     // Text message
     text: {
       type: String,
       maxlength: 5000,
     },

     // Media messages (image, video, audio)
     mediaUrl: String,
     thumbnailUrl: String,
     mediaSize: Number, // in bytes
     mediaDuration: Number, // in seconds (for video/audio)
     mediaWidth: Number,
     mediaHeight: Number,
     mimeType: String,
     fileName: String,

     // Voice message
     audioUrl: String,
     duration: Number, // in seconds
     waveform: [Number], // Audio waveform data for visualization

     // Location
     location: {
       latitude: Number,
       longitude: Number,
       address: String,
       name: String, // Place name
       url: String, // Map URL
     },

     // GIF/Sticker
     gifUrl: String,
     stickerId: String,
     stickerPack: String,

     // Game invite
     gameId: String,
     gameType: String,
     gameData: Schema.Types.Mixed,

     // Virtual gift
     giftId: String,
     giftType: String,
     giftUrl: String,
     giftMessage: String,

     // Date request
     dateLocation: String,
     dateTime: Date,
     dateDescription: String,

     // Spotify track
     spotifyTrackId: String,
     spotifyTrackName: String,
     spotifyArtist: String,
     spotifyAlbumArt: String,
     spotifyPreviewUrl: String,

     // Instagram post
     instagramPostId: String,
     instagramMediaUrl: String,
     instagramCaption: String,
     instagramType: String, // photo, video, carousel

     // Call notification
     callType: {
       type: String,
       enum: ['voice', 'video'],
     },
     callDuration: Number, // in seconds
     callStatus: {
       type: String,
       enum: ['missed', 'declined', 'completed', 'failed'],
     },

     // System message
     systemMessage: String,
     systemAction: String,
     systemData: Schema.Types.Mixed,
   },

   // Reply reference
   replyTo: {
     type: Schema.Types.ObjectId,
     ref: 'Message',
   },

   // Message status
   status: {
     sent: {
       type: Boolean,
       default: false,
     },
     sentAt: {
       type: Date,
       default: Date.now,
     },
     delivered: {
       type: Boolean,
       default: false,
     },
     deliveredAt: Date,
     read: {
       type: Boolean,
       default: false,
     },
     readAt: Date,
     isDeleted: {
       type: Boolean,
       default: false,
     },
     deletedAt: Date,
     deletedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     deletedForEveryone: {
       type: Boolean,
       default: false,
     },
   },

   // Reactions
   reactions: [
     {
       userId: {
         type: Schema.Types.ObjectId,
         ref: 'User',
         required: true,
       },
       emoji: {
         type: String,
         required: true,
       },
       reactedAt: {
         type: Date,
         default: Date.now,
       },
     },
   ],

   // Visibility control
   visibility: {
     hiddenForSender: {
       type: Boolean,
       default: false,
     },
     hiddenForReceiver: {
       type: Boolean,
       default: false,
     },
     disappearAfter: Date, // For disappearing messages
     expiresAt: Date, // For time-limited messages
   },

   // Metadata
   metadata: {
     clientId: String, // Client-side ID for deduplication
     isEdited: {
       type: Boolean,
       default: false,
     },
     editedAt: Date,
     editHistory: [
       {
         text: String,
         editedAt: Date,
       },
     ],
     isForwarded: {
       type: Boolean,
       default: false,
     },
     forwardedFrom: {
       type: Schema.Types.ObjectId,
       ref: 'Message',
     },
     forwardCount: {
       type: Number,
       default: 0,
     },
     platform: {
       type: String,
       enum: ['ios', 'android', 'web', 'desktop'],
     },
     deviceId: String,
     appVersion: String,
     isSpam: {
       type: Boolean,
       default: false,
     },
     spamScore: Number,
     moderationStatus: {
       type: String,
       enum: ['pending', 'approved', 'flagged', 'removed'],
       default: 'approved',
     },
     moderationReason: String,
     isReported: {
       type: Boolean,
       default: false,
     },
     reportCount: {
       type: Number,
       default: 0,
     },
     reports: [
       {
         reportedBy: {
           type: Schema.Types.ObjectId,
           ref: 'User',
         },
         reason: String,
         reportedAt: Date,
       },
     ],
   },

   // Encryption (for future E2E encryption)
   encryption: {
     isEncrypted: {
       type: Boolean,
       default: false,
     },
     encryptionType: String,
     publicKey: String,
     encryptedKey: String,
   },

   // Media processing
   media: {
     isProcessed: {
       type: Boolean,
       default: false,
     },
     processedAt: Date,
     variations: [
       {
         size: String, // small, medium, large
         url: String,
         width: Number,
         height: Number,
       },
     ],
     blurHash: String, // For image placeholders
     isNSFW: {
       type: Boolean,
       default: false,
     },
     nsfwScore: Number,
     ocrText: String, // Extracted text from images
     downloads: [
       {
         userId: {
           type: Schema.Types.ObjectId,
           ref: 'User',
         },
         downloadedAt: Date,
       },
     ],
   },

   // Location tracking (for location messages)
   locationTracking: {
     isLive: {
       type: Boolean,
       default: false,
     },
     expiresAt: Date,
     updateInterval: Number, // in seconds
     lastUpdated: Date,
     history: [
       {
         latitude: Number,
         longitude: Number,
         timestamp: Date,
         accuracy: Number,
       },
     ],
   },

   // Engagement metrics
   engagement: {
     shares: {
       type: Number,
       default: 0,
     },
     saves: {
       type: Number,
       default: 0,
     },
     clicks: {
       type: Number,
       default: 0,
     },
     plays: {
       type: Number,
       default: 0, // For audio/video
     },
     playDuration: {
       type: Number,
       default: 0, // Total play time in seconds
     },
   },

   // Translation (for future multi-language support)
   translation: {
     isTranslated: {
       type: Boolean,
       default: false,
     },
     originalLanguage: String,
     translations: [
       {
         language: String,
         text: String,
         translatedAt: Date,
         translatedBy: {
           type: String,
           enum: ['auto', 'user', 'service'],
         },
       },
     ],
   },

   // Thread information (for conversation threading)
   thread: {
     threadId: String,
     isThreadStart: {
       type: Boolean,
       default: false,
     },
     threadMessageCount: {
       type: Number,
       default: 0,
     },
   },

   // Scheduled messages
   scheduling: {
     isScheduled: {
       type: Boolean,
       default: false,
     },
     scheduledFor: Date,
     scheduledAt: Date,
     schedulingStatus: {
       type: String,
       enum: ['pending', 'sent', 'failed', 'cancelled'],
     },
   },

   // Payment/tip related (for virtual gifts)
   payment: {
     amount: Number,
     currency: String,
     transactionId: String,
     isPaid: {
       type: Boolean,
       default: false,
     },
     paidAt: Date,
   },

   // Analytics
   analytics: {
     impressions: {
       type: Number,
       default: 0,
     },
     engagementRate: Number,
     sentimentScore: Number, // -1 to 1
     sentimentMagnitude: Number,
     keywords: [String],
     topics: [String],
     entities: [
       {
         name: String,
         type: String,
         salience: Number,
       },
     ],
   },

   // Admin/Moderation
   admin: {
     flaggedAt: Date,
     flaggedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     reviewedAt: Date,
     reviewedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     notes: String,
     priority: {
       type: String,
       enum: ['low', 'medium', 'high', 'urgent'],
       default: 'low',
     },
   },
 },
 {
   timestamps: true,
   collection: 'messages',
 }
);

// ============================
// Indexes
// ============================

// Compound indexes for efficient queries
messageSchema.index({ matchId: 1, createdAt: -1 });
messageSchema.index({ sender: 1, receiver: 1, createdAt: -1 });
messageSchema.index({ matchId: 1, 'status.isDeleted': 1, createdAt: -1 });
messageSchema.index({ receiver: 1, 'status.read': 1 });
messageSchema.index({ matchId: 1, type: 1 });
messageSchema.index({ 'metadata.clientId': 1 });
messageSchema.index({ 'scheduling.scheduledFor': 1, 'scheduling.schedulingStatus': 1 });

// Text search index
messageSchema.index({ 'content.text': 'text', 'content.systemMessage': 'text' });

// TTL index for disappearing messages
messageSchema.index({ 'visibility.expiresAt': 1 }, { expireAfterSeconds: 0 });

// ============================
// Virtual Properties
// ============================

/**
* Check if message is recent (within 5 minutes)
*/
messageSchema.virtual('isRecent').get(function () {
 return Date.now() - this.createdAt < 5 * 60 * 1000;
});

/**
* Check if message can be edited
*/
messageSchema.virtual('canEdit').get(function () {
 return !this.status.isDeleted && Date.now() - this.createdAt < 15 * 60 * 1000;
});

/**
* Check if message can be deleted
*/
messageSchema.virtual('canDelete').get(function () {
 return !this.status.isDeleted;
});

/**
* Get reaction count
*/
messageSchema.virtual('reactionCount').get(function () {
 return this.reactions?.length || 0;
});

/**
* Check if message has media
*/
messageSchema.virtual('hasMedia').get(function () {
 return [
   MESSAGE_TYPES.IMAGE,
   MESSAGE_TYPES.VIDEO,
   MESSAGE_TYPES.AUDIO,
   MESSAGE_TYPES.VOICE,
 ].includes(this.type);
});

// ============================
// Instance Methods
// ============================

/**
* Mark message as delivered
*/
messageSchema.methods.markAsDelivered = function () {
 if (!this.status.delivered) {
   this.status.delivered = true;
   this.status.deliveredAt = new Date();
   return this.save();
 }
 return Promise.resolve(this);
};

/**
* Mark message as read
*/
messageSchema.methods.markAsRead = function () {
 if (!this.status.read) {
   this.status.read = true;
   this.status.readAt = new Date();
   
   // Also mark as delivered if not already
   if (!this.status.delivered) {
     this.status.delivered = true;
     this.status.deliveredAt = this.status.readAt;
   }
   
   return this.save();
 }
 return Promise.resolve(this);
};

/**
* Soft delete message
*/
messageSchema.methods.softDelete = function (userId, deleteForEveryone = false) {
 this.status.isDeleted = true;
 this.status.deletedAt = new Date();
 this.status.deletedBy = userId;
 this.status.deletedForEveryone = deleteForEveryone;
 
 if (deleteForEveryone) {
   this.content = {}; // Clear content for everyone
 }
 
 return this.save();
};

/**
* Add reaction
*/
messageSchema.methods.addReaction = function (userId, emoji) {
 const existingReaction = this.reactions.find(
   r => r.userId.toString() === userId.toString()
 );
 
 if (existingReaction) {
   existingReaction.emoji = emoji;
   existingReaction.reactedAt = new Date();
 } else {
   this.reactions.push({
     userId,
     emoji,
     reactedAt: new Date(),
   });
 }
 
 return this.save();
};

/**
* Remove reaction
*/
messageSchema.methods.removeReaction = function (userId) {
 this.reactions = this.reactions.filter(
   r => r.userId.toString() !== userId.toString()
 );
 return this.save();
};

/**
* Edit message
*/
messageSchema.methods.editMessage = function (newText) {
 if (!this.canEdit) {
   throw new Error('Message cannot be edited');
 }
 
 // Save edit history
 if (!this.metadata.editHistory) {
   this.metadata.editHistory = [];
 }
 
 this.metadata.editHistory.push({
   text: this.content.text,
   editedAt: new Date(),
 });
 
 // Update message
 this.content.text = newText;
 this.metadata.isEdited = true;
 this.metadata.editedAt = new Date();
 
 return this.save();
};

/**
* Report message
*/
messageSchema.methods.reportMessage = function (userId, reason) {
 if (!this.metadata.reports) {
   this.metadata.reports = [];
 }
 
 // Check if already reported by this user
 const existingReport = this.metadata.reports.find(
   r => r.reportedBy.toString() === userId.toString()
 );
 
 if (!existingReport) {
   this.metadata.reports.push({
     reportedBy: userId,
     reason,
     reportedAt: new Date(),
   });
   
   this.metadata.reportCount = this.metadata.reports.length;
   this.metadata.isReported = true;
   
   // Auto-flag if multiple reports
   if (this.metadata.reportCount >= 3) {
     this.metadata.moderationStatus = 'flagged';
   }
 }
 
 return this.save();
};

/**
* Check if user can view message
*/
messageSchema.methods.canView = function (userId) {
 const userIdStr = userId.toString();
 
 // Check if deleted
 if (this.status.isDeleted && this.status.deletedForEveryone) {
   return false;
 }
 
 // Check visibility
 if (this.sender.toString() === userIdStr && this.visibility.hiddenForSender) {
   return false;
 }
 
 if (this.receiver.toString() === userIdStr && this.visibility.hiddenForReceiver) {
   return false;
 }
 
 // Check if expired
 if (this.visibility.expiresAt && new Date() > this.visibility.expiresAt) {
   return false;
 }
 
 return true;
};

/**
* Format for API response
*/
messageSchema.methods.toJSON = function () {
 const obj = this.toObject();
 
 // Remove sensitive fields
 delete obj.__v;
 delete obj.encryption;
 delete obj.admin;
 
 // Add virtuals
 obj.isRecent = this.isRecent;
 obj.canEdit = this.canEdit;
 obj.canDelete = this.canDelete;
 obj.reactionCount = this.reactionCount;
 obj.hasMedia = this.hasMedia;
 
 return obj;
};

// ============================
// Static Methods
// ============================

/**
* Get messages for a match
*/
messageSchema.statics.getMatchMessages = async function (matchId, options = {}) {
 const {
   limit = 50,
   before = null,
   after = null,
   userId = null,
 } = options;
 
 const query = {
   matchId,
   'status.isDeleted': false,
 };
 
 // Add visibility filters if userId provided
 if (userId) {
   query.$or = [
     { sender: userId, 'visibility.hiddenForSender': false },
     { receiver: userId, 'visibility.hiddenForReceiver': false },
   ];
 }
 
 // Add time filters
 if (before) {
   query.createdAt = { $lt: new Date(before) };
 }
 if (after) {
   query.createdAt = { ...query.createdAt, $gt: new Date(after) };
 }
 
 return this.find(query)
   .populate('sender', 'profile.firstName profile.displayName profile.photos')
   .populate('replyTo')
   .sort({ createdAt: -1 })
   .limit(limit);
};

/**
* Get unread messages for user
*/
messageSchema.statics.getUnreadMessages = async function (userId) {
 return this.find({
   receiver: userId,
   'status.read': false,
   'status.isDeleted': false,
   'visibility.hiddenForReceiver': false,
 })
   .populate('sender', 'profile.firstName profile.displayName')
   .populate('matchId');
};

/**
* Get message statistics for a match
*/
messageSchema.statics.getMatchStats = async function (matchId) {
 const [
   totalMessages,
   mediaMessages,
   averageResponseTime,
   messagesByType,
 ] = await Promise.all([
   this.countDocuments({ matchId, 'status.isDeleted': false }),
   
   this.countDocuments({
     matchId,
     type: { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO] },
     'status.isDeleted': false,
   }),
   
   this.aggregate([
     { $match: { matchId: mongoose.Types.ObjectId(matchId) } },
     { $sort: { createdAt: 1 } },
     {
       $group: {
         _id: '$sender',
         messages: { $push: '$createdAt' },
       },
     },
   ]),
   
   this.aggregate([
     { $match: { matchId: mongoose.Types.ObjectId(matchId), 'status.isDeleted': false } },
     {
       $group: {
         _id: '$type',
         count: { $sum: 1 },
       },
     },
   ]),
 ]);
 
 // Calculate average response time
 let avgResponseTime = 0;
 if (averageResponseTime.length === 2) {
   // Complex calculation for response time between users
   // This would need more sophisticated logic
 }
 
 return {
   total: totalMessages,
   media: mediaMessages,
   averageResponseTime: avgResponseTime,
   byType: messagesByType.reduce((acc, curr) => {
     acc[curr._id] = curr.count;
     return acc;
   }, {}),
 };
};

/**
* Search messages
*/
messageSchema.statics.searchMessages = async function (matchId, searchQuery, options = {}) {
 const { limit = 50, type = 'all' } = options;
 
 const query = {
   matchId,
   'status.isDeleted': false,
 };
 
 if (type === 'text') {
   query.$text = { $search: searchQuery };
 } else if (type === 'media') {
   query.type = { $in: [MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO] };
 } else if (type === 'links') {
   query['content.text'] = { $regex: /https?:\/\//i };
 }
 
 return this.find(query)
   .sort({ score: { $meta: 'textScore' } })
   .limit(limit)
   .populate('sender', 'profile.firstName profile.displayName');
};

/**
* Get scheduled messages ready to send
*/
messageSchema.statics.getScheduledMessages = async function () {
 return this.find({
   'scheduling.isScheduled': true,
   'scheduling.schedulingStatus': 'pending',
   'scheduling.scheduledFor': { $lte: new Date() },
 });
};

/**
* Clean up expired messages
*/
messageSchema.statics.cleanupExpiredMessages = async function () {
 const now = new Date();
 
 // Delete expired disappearing messages
 const result = await this.deleteMany({
   'visibility.expiresAt': { $lte: now },
 });
 
 return result.deletedCount;
};

// ============================
// Middleware
// ============================

/**
* Pre-save middleware
*/
messageSchema.pre('save', async function (next) {
 // Validate content based on type
 if (this.type === MESSAGE_TYPES.TEXT && !this.content.text) {
   return next(new Error('Text content is required for text messages'));
 }
 
 if ([MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO].includes(this.type) && !this.content.mediaUrl) {
   return next(new Error('Media URL is required for media messages'));
 }
 
 // Set sent status if new
 if (this.isNew) {
   this.status.sent = true;
   this.status.sentAt = new Date();
 }
 
 // Auto-moderate content (would integrate with moderation service)
 if (this.isNew && this.type === MESSAGE_TYPES.TEXT) {
   // Check for spam, inappropriate content, etc.
   // This would call an external moderation service
 }
 
 next();
});

/**
* Post-save middleware for notifications
*/
messageSchema.post('save', async function (doc) {
 if (doc.wasNew && !doc.status.isDeleted) {
   // Emit socket event (handled in socket handler)
   // Update match interaction stats (handled in service)
 }
});

/**
* Pre-remove middleware
*/
messageSchema.pre('remove', async function (next) {
 // Clean up related data
 // Remove from threads, reactions, etc.
 next();
});

// ============================
// Model Export
// ============================

const Message = mongoose.model('Message', messageSchema);

export default Message;