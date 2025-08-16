// src/modules/match/match.model.js
import mongoose from 'mongoose';
import { MATCH_STATUS, NOTIFICATION_TYPES } from '../../config/constants.js';

const { Schema } = mongoose;

/**
* Match Schema - Represents a mutual connection between two users
*/
const matchSchema = new Schema(
 {
   // Users involved in the match (always 2 users)
   users: [
     {
       type: Schema.Types.ObjectId,
       ref: 'User',
       required: true,
     },
   ],

   // User who initiated the match (last person to swipe right)
   initiatedBy: {
     type: Schema.Types.ObjectId,
     ref: 'User',
     required: true,
   },

   // Match timestamp
   matchedAt: {
     type: Date,
     default: Date.now,
     required: true,
     index: true,
   },

   // Match status
   status: {
     isActive: {
       type: Boolean,
       default: true,
       index: true,
     },
     status: {
       type: String,
       enum: Object.values(MATCH_STATUS),
       default: MATCH_STATUS.ACTIVE,
       index: true,
     },
     unmatchedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     unmatchedAt: Date,
     unmatchReason: String,
     blockedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     blockedAt: Date,
     deactivatedAt: Date,
   },

   // Interaction metrics
   interaction: {
     lastMessageAt: {
       type: Date,
       index: true,
     },
     lastMessageBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     messageCount: {
       type: Number,
       default: 0,
     },
     unreadCount: {
       user1: {
         type: Number,
         default: 0,
       },
       user2: {
         type: Number,
         default: 0,
       },
     },
     firstMessageAt: Date,
     firstMessageBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     hasExchangedMessages: {
       type: Boolean,
       default: false,
     },
     responseTime: {
       user1: Number, // Average response time in seconds
       user2: Number,
     },
   },

   // Match quality metrics
   quality: {
     compatibilityScore: {
       type: Number,
       min: 0,
       max: 1,
     },
     commonInterests: [String],
     distance: Number, // Distance at time of match (km)
     matchType: {
       type: String,
       enum: ['regular', 'superlike', 'boost', 'spotlight', 'top_pick'],
       default: 'regular',
     },
     wasRecommended: {
       type: Boolean,
       default: false,
     },
     recommendationScore: Number,
   },

   // Chat settings
   chat: {
     isEnabled: {
       type: Boolean,
       default: true,
     },
     expiresAt: Date, // For time-limited matches
     theme: {
       type: String,
       default: 'default',
     },
     lastTypingAt: {
       user1: Date,
       user2: Date,
     },
     isPinned: {
       user1: {
         type: Boolean,
         default: false,
       },
       user2: {
         type: Boolean,
         default: false,
       },
     },
     isMuted: {
       user1: {
         type: Boolean,
         default: false,
       },
       user2: {
         type: Boolean,
         default: false,
       },
     },
     mutedUntil: {
       user1: Date,
       user2: Date,
     },
   },

   // Media sharing
   media: {
     photosShared: {
       type: Number,
       default: 0,
     },
     videosShared: {
       type: Number,
       default: 0,
     },
     voiceMessagesShared: {
       type: Number,
       default: 0,
     },
     lastMediaSharedAt: Date,
     sharedSpotifyTracks: [
       {
         trackId: String,
         sharedBy: Schema.Types.ObjectId,
         sharedAt: Date,
       },
     ],
     sharedInstagramPosts: [
       {
         postId: String,
         sharedBy: Schema.Types.ObjectId,
         sharedAt: Date,
       },
     ],
   },

   // Video chat
   videoChat: {
     isEnabled: {
       type: Boolean,
       default: true,
     },
     totalCalls: {
       type: Number,
       default: 0,
     },
     totalDuration: {
       type: Number,
       default: 0, // in seconds
     },
     lastCallAt: Date,
     lastCallDuration: Number,
     lastCallInitiatedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
   },

   // Date planning (Premium feature)
   datePlanning: {
     hasPlannedDate: {
       type: Boolean,
       default: false,
     },
     plannedDates: [
       {
         title: String,
         description: String,
         location: {
           name: String,
           address: String,
           coordinates: {
             type: { type: String, default: 'Point' },
             coordinates: [Number],
           },
         },
         scheduledFor: Date,
         status: {
           type: String,
           enum: ['proposed', 'accepted', 'declined', 'completed', 'cancelled'],
           default: 'proposed',
         },
         proposedBy: {
           type: Schema.Types.ObjectId,
           ref: 'User',
         },
         createdAt: {
           type: Date,
           default: Date.now,
         },
       },
     ],
   },

   // Safety features
   safety: {
     isVerified: {
       user1: {
         type: Boolean,
         default: false,
       },
       user2: {
         type: Boolean,
         default: false,
       },
     },
     hasSharedLocation: {
       user1: {
         type: Boolean,
         default: false,
       },
       user2: {
         type: Boolean,
         default: false,
       },
     },
     emergencyContact: {
       user1: {
         shared: Boolean,
         sharedAt: Date,
       },
       user2: {
         shared: Boolean,
         sharedAt: Date,
       },
     },
     reportedMessages: [
       {
         messageId: Schema.Types.ObjectId,
         reportedBy: Schema.Types.ObjectId,
         reportedAt: Date,
         reason: String,
       },
     ],
   },

   // Engagement metrics
   engagement: {
     score: {
       type: Number,
       default: 0,
       min: 0,
       max: 100,
     },
     lastActivityAt: {
       type: Date,
       default: Date.now,
       index: true,
     },
     activityStreak: {
       current: {
         type: Number,
         default: 0,
       },
       longest: {
         type: Number,
         default: 0,
       },
       lastStreakDate: Date,
     },
     sentiment: {
       type: String,
       enum: ['positive', 'neutral', 'negative'],
       default: 'neutral',
     },
     conversationDepth: {
       type: Number,
       default: 0, // Based on message length and frequency
     },
   },

   // Icebreakers
   icebreakers: {
     used: [
       {
         type: {
           type: String,
           enum: ['question', 'game', 'prompt', 'gif', 'sticker'],
         },
         content: String,
         usedBy: Schema.Types.ObjectId,
         usedAt: Date,
         response: String,
       },
     ],
     remaining: {
       user1: {
         type: Number,
         default: 3,
       },
       user2: {
         type: Number,
         default: 3,
       },
     },
   },

   // Virtual gifts (Premium feature)
   virtualGifts: [
     {
       giftType: String,
       giftId: String,
       sentBy: {
         type: Schema.Types.ObjectId,
         ref: 'User',
       },
       sentAt: {
         type: Date,
         default: Date.now,
       },
       message: String,
       isOpened: {
         type: Boolean,
         default: false,
       },
       openedAt: Date,
     },
   ],

   // Metadata
   metadata: {
     source: {
       type: String,
       enum: ['swipe', 'superlike', 'boost', 'spotlight', 'likes_you', 'top_picks', 'explore'],
       default: 'swipe',
     },
     platform: {
       user1: String, // Platform where user1 swiped
       user2: String, // Platform where user2 swiped
     },
     appVersion: {
       user1: String,
       user2: String,
     },
     location: {
       user1: {
         city: String,
         country: String,
         coordinates: {
           type: { type: String },
           coordinates: [Number],
         },
       },
       user2: {
         city: String,
         country: String,
         coordinates: {
           type: { type: String },
           coordinates: [Number],
         },
       },
     },
     notificationsSent: {
       type: Number,
       default: 0,
     },
     lastNotificationAt: Date,
   },

   // Flagging system
   flags: {
     isStale: {
       type: Boolean,
       default: false,
     },
     staleSince: Date,
     isGhosted: {
       type: Boolean,
       default: false,
     },
     ghostedBy: Schema.Types.ObjectId,
     isFlagged: {
       type: Boolean,
       default: false,
     },
     flagReason: String,
     flaggedAt: Date,
   },

   // Admin notes
   adminNotes: {
     notes: String,
     reviewedAt: Date,
     reviewedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     priority: {
       type: String,
       enum: ['low', 'medium', 'high'],
       default: 'low',
     },
   },
 },
 {
   timestamps: true,
   collection: 'matches',
 }
);

// ============================
// Indexes
// ============================

// Compound indexes for efficient queries
matchSchema.index({ users: 1, 'status.isActive': 1 });
matchSchema.index({ users: 1, matchedAt: -1 });
matchSchema.index({ users: 1, 'interaction.lastMessageAt': -1 });
matchSchema.index({ 'status.isActive': 1, matchedAt: -1 });
matchSchema.index({ 'engagement.lastActivityAt': -1 });
matchSchema.index({ 'chat.isPinned.user1': 1, 'chat.isPinned.user2': 1 });
matchSchema.index({ 'interaction.unreadCount.user1': 1, 'interaction.unreadCount.user2': 1 });

// Text index for search
matchSchema.index({ 'metadata.location.user1.city': 'text', 'metadata.location.user2.city': 'text' });

// ============================
// Virtual Properties
// ============================

/**
* Get match age in days
*/
matchSchema.virtual('ageInDays').get(function () {
 return Math.floor((Date.now() - this.matchedAt) / (1000 * 60 * 60 * 24));
});

/**
* Check if match is new (less than 24 hours old)
*/
matchSchema.virtual('isNew').get(function () {
 return Date.now() - this.matchedAt < 24 * 60 * 60 * 1000;
});

/**
* Check if conversation is active
*/
matchSchema.virtual('isConversationActive').get(function () {
 if (!this.interaction.lastMessageAt) return false;
 return Date.now() - this.interaction.lastMessageAt < 7 * 24 * 60 * 60 * 1000; // Active if messaged in last 7 days
});

/**
* Get total unread count
*/
matchSchema.virtual('totalUnreadCount').get(function () {
 return (this.interaction.unreadCount?.user1 || 0) + (this.interaction.unreadCount?.user2 || 0);
});

// ============================
// Instance Methods
// ============================

/**
* Get the other user in the match
*/
matchSchema.methods.getOtherUser = function (userId) {
 const userIdStr = userId.toString();
 return this.users.find((u) => u.toString() !== userIdStr);
};

/**
* Check if user is part of this match
*/
matchSchema.methods.hasUser = function (userId) {
 return this.users.some((u) => u.toString() === userId.toString());
};

/**
* Get unread count for specific user
*/
matchSchema.methods.getUnreadCount = function (userId) {
 const userIdStr = userId.toString();
 const userIndex = this.users.findIndex((u) => u.toString() === userIdStr);
 
 if (userIndex === 0) return this.interaction.unreadCount?.user1 || 0;
 if (userIndex === 1) return this.interaction.unreadCount?.user2 || 0;
 return 0;
};

/**
* Update unread count
*/
matchSchema.methods.updateUnreadCount = function (userId, count) {
 const userIdStr = userId.toString();
 const userIndex = this.users.findIndex((u) => u.toString() === userIdStr);
 
 if (userIndex === 0) {
   this.interaction.unreadCount.user1 = count;
 } else if (userIndex === 1) {
   this.interaction.unreadCount.user2 = count;
 }
};

/**
* Mark messages as read for user
*/
matchSchema.methods.markAsRead = function (userId) {
 this.updateUnreadCount(userId, 0);
};

/**
* Increment message count
*/
matchSchema.methods.incrementMessageCount = function (senderId) {
 this.interaction.messageCount++;
 this.interaction.lastMessageAt = new Date();
 this.interaction.lastMessageBy = senderId;
 
 if (!this.interaction.firstMessageAt) {
   this.interaction.firstMessageAt = new Date();
   this.interaction.firstMessageBy = senderId;
   this.interaction.hasExchangedMessages = true;
 }
 
 // Update engagement
 this.engagement.lastActivityAt = new Date();
 this.updateEngagementScore();
};

/**
* Update engagement score
*/
matchSchema.methods.updateEngagementScore = function () {
 let score = 0;
 
 // Message frequency (30 points)
 if (this.interaction.messageCount > 100) score += 30;
 else if (this.interaction.messageCount > 50) score += 20;
 else if (this.interaction.messageCount > 10) score += 10;
 
 // Conversation recency (20 points)
 const daysSinceLastMessage = (Date.now() - this.interaction.lastMessageAt) / (1000 * 60 * 60 * 24);
 if (daysSinceLastMessage < 1) score += 20;
 else if (daysSinceLastMessage < 3) score += 15;
 else if (daysSinceLastMessage < 7) score += 10;
 else if (daysSinceLastMessage < 14) score += 5;
 
 // Media sharing (20 points)
 const totalMedia = this.media.photosShared + this.media.videosShared + this.media.voiceMessagesShared;
 if (totalMedia > 20) score += 20;
 else if (totalMedia > 10) score += 15;
 else if (totalMedia > 5) score += 10;
 else if (totalMedia > 0) score += 5;
 
 // Video calls (15 points)
 if (this.videoChat.totalCalls > 5) score += 15;
 else if (this.videoChat.totalCalls > 2) score += 10;
 else if (this.videoChat.totalCalls > 0) score += 5;
 
 // Date planning (15 points)
 if (this.datePlanning.hasPlannedDate) score += 15;
 
 this.engagement.score = Math.min(100, score);
};

/**
* Check if match should be marked as stale
*/
matchSchema.methods.checkIfStale = function () {
 // No messages after 7 days
 if (!this.interaction.firstMessageAt && this.ageInDays > 7) {
   this.flags.isStale = true;
   this.flags.staleSince = new Date();
   return true;
 }
 
 // No messages in 30 days
 if (this.interaction.lastMessageAt) {
   const daysSinceLastMessage = (Date.now() - this.interaction.lastMessageAt) / (1000 * 60 * 60 * 24);
   if (daysSinceLastMessage > 30) {
     this.flags.isStale = true;
     this.flags.staleSince = new Date();
     return true;
   }
 }
 
 return false;
};

/**
* Unmatch users
*/
matchSchema.methods.unmatch = function (userId, reason = '') {
 this.status.isActive = false;
 this.status.status = MATCH_STATUS.INACTIVE;
 this.status.unmatchedBy = userId;
 this.status.unmatchedAt = new Date();
 this.status.unmatchReason = reason;
};

/**
* Block match
*/
matchSchema.methods.block = function (userId) {
 this.status.isActive = false;
 this.status.status = MATCH_STATUS.BLOCKED;
 this.status.blockedBy = userId;
 this.status.blockedAt = new Date();
};

/**
* Pin/unpin for user
*/
matchSchema.methods.togglePin = function (userId) {
 const userIdStr = userId.toString();
 const userIndex = this.users.findIndex((u) => u.toString() === userIdStr);
 
 if (userIndex === 0) {
   this.chat.isPinned.user1 = !this.chat.isPinned.user1;
 } else if (userIndex === 1) {
   this.chat.isPinned.user2 = !this.chat.isPinned.user2;
 }
};

/**
* Mute/unmute for user
*/
matchSchema.methods.toggleMute = function (userId, duration = null) {
 const userIdStr = userId.toString();
 const userIndex = this.users.findIndex((u) => u.toString() === userIdStr);
 
 if (userIndex === 0) {
   this.chat.isMuted.user1 = !this.chat.isMuted.user1;
   if (duration && this.chat.isMuted.user1) {
     this.chat.mutedUntil.user1 = new Date(Date.now() + duration);
   } else {
     this.chat.mutedUntil.user1 = null;
   }
 } else if (userIndex === 1) {
   this.chat.isMuted.user2 = !this.chat.isMuted.user2;
   if (duration && this.chat.isMuted.user2) {
     this.chat.mutedUntil.user2 = new Date(Date.now() + duration);
   } else {
     this.chat.mutedUntil.user2 = null;
   }
 }
};

// ============================
// Static Methods
// ============================

/**
* Find match between two users
*/
matchSchema.statics.findBetweenUsers = async function (userId1, userId2) {
 return this.findOne({
   users: { $all: [userId1, userId2] },
   'status.isActive': true,
 });
};

/**
* Get active matches for user
*/
matchSchema.statics.getActiveMatches = async function (userId, options = {}) {
 const {
   limit = 50,
   skip = 0,
   sort = { 'interaction.lastMessageAt': -1 },
   populate = true,
 } = options;

 const query = this.find({
   users: userId,
   'status.isActive': true,
 })
   .sort(sort)
   .limit(limit)
   .skip(skip);

 if (populate) {
   query.populate('users', 'profile.firstName profile.displayName profile.photos verification');
 }

 return query.exec();
};

/**
* Get matches with unread messages
*/
matchSchema.statics.getUnreadMatches = async function (userId) {
 const userIdStr = userId.toString();
 
 return this.find({
   users: userId,
   'status.isActive': true,
   $or: [
     { 
       users: { $elemMatch: { $eq: userId } },
       'interaction.unreadCount.user1': { $gt: 0 },
     },
     {
       users: { $elemMatch: { $eq: userId } },
       'interaction.unreadCount.user2': { $gt: 0 },
     },
   ],
 }).populate('users', 'profile.firstName profile.displayName profile.photos');
};

/**
* Get match statistics for user
*/
matchSchema.statics.getUserMatchStats = async function (userId) {
 const [
   totalMatches,
   activeMatches,
   messagesExchanged,
   avgResponseTime,
   ghostedMatches,
 ] = await Promise.all([
   this.countDocuments({ users: userId }),
   this.countDocuments({ users: userId, 'status.isActive': true }),
   this.countDocuments({ 
     users: userId, 
     'interaction.hasExchangedMessages': true,
   }),
   this.aggregate([
     { $match: { users: userId } },
     {
       $group: {
         _id: null,
         avgResponse: { 
           $avg: {
             $cond: [
               { $eq: [{ $arrayElemAt: ['$users', 0] }, userId] },
               '$interaction.responseTime.user1',
               '$interaction.responseTime.user2',
             ],
           },
         },
       },
     },
   ]),
   this.countDocuments({ 
     users: userId, 
     'flags.isGhosted': true,
   }),
 ]);

 return {
   total: totalMatches,
   active: activeMatches,
   withMessages: messagesExchanged,
   avgResponseTime: avgResponseTime[0]?.avgResponse || 0,
   ghosted: ghostedMatches,
   conversionRate: totalMatches > 0 ? (messagesExchanged / totalMatches) * 100 : 0,
 };
};

// ============================
// Middleware
// ============================

/**
* Pre-save middleware
*/
matchSchema.pre('save', async function (next) {
 // Ensure exactly 2 users
 if (this.users.length !== 2) {
   return next(new Error('Match must have exactly 2 users'));
 }

 // Ensure users are different
 if (this.users[0].toString() === this.users[1].toString()) {
   return next(new Error('Cannot match user with themselves'));
 }

 // Sort users for consistency
 this.users.sort();

 // Check for stale matches
 if (this.isNew) {
   // Set initial engagement score
   this.engagement.score = 50; // Start at neutral
 } else {
   // Update stale status
   this.checkIfStale();
 }

 next();
});

/**
* Post-save middleware for notifications
*/
matchSchema.post('save', async function (doc) {
 if (doc.wasNew) {
   // Send match notifications
   const NotificationService = (await import('../../shared/services/notification.service.js')).default;
   
   // Notify both users
   for (const userId of doc.users) {
     const otherUserId = doc.getOtherUser(userId);
     await NotificationService.sendNotification(userId.toString(), {
       type: NOTIFICATION_TYPES.NEW_MATCH,
       title: "It's a Match! 🎉",
       body: "You have a new match! Start a conversation now.",
       data: {
         matchId: doc._id.toString(),
         otherUserId: otherUserId.toString(),
       },
     });
   }
 }
});

// ============================
// Model Export
// ============================

const Match = mongoose.model('Match', matchSchema);

export default Match;