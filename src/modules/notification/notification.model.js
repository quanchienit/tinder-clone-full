// src/modules/notification/notification.model.js
import mongoose from 'mongoose';
import { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } from '../../config/constants.js';

const notificationSchema = new mongoose.Schema(
 {
   // Recipient Information
   recipient: {
     type: mongoose.Schema.Types.ObjectId,
     ref: 'User',
     required: true,
     index: true,
   },

   // Sender Information (optional - system notifications may not have sender)
   sender: {
     type: mongoose.Schema.Types.ObjectId,
     ref: 'User',
     sparse: true,
     index: true,
   },

   // Notification Type & Category
   type: {
     type: String,
     required: true,
     enum: Object.values(NOTIFICATION_TYPES),
     index: true,
   },

   category: {
     type: String,
     enum: ['match', 'message', 'social', 'system', 'promotion', 'security', 'subscription'],
     default: 'system',
     index: true,
   },

   // Content
   title: {
     type: String,
     required: true,
     maxlength: 100,
   },

   body: {
     type: String,
     required: true,
     maxlength: 500,
   },

   // Rich Media
   media: {
     imageUrl: {
       type: String,
       validate: {
         validator: function (v) {
           return !v || /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)$/i.test(v);
         },
         message: 'Invalid image URL format',
       },
     },
     thumbnailUrl: String,
     icon: {
       type: String,
       enum: ['heart', 'message', 'star', 'fire', 'gift', 'warning', 'info', 'success', 'error'],
       default: 'info',
     },
   },

   // Action & Navigation
   action: {
     type: {
       type: String,
       enum: ['navigate', 'deeplink', 'url', 'modal', 'none'],
       default: 'none',
     },
     target: String, // Screen name, URL, or deeplink
     params: mongoose.Schema.Types.Mixed, // Additional parameters for navigation
   },

   // Related Entities
   relatedEntities: {
     matchId: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'Match',
       sparse: true,
     },
     messageId: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'Message',
       sparse: true,
     },
     conversationId: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'Conversation',
       sparse: true,
     },
     activityId: {
       type: mongoose.Schema.Types.ObjectId,
       sparse: true,
     },
   },

   // Delivery Status
   status: {
     read: {
       type: Boolean,
       default: false,
       index: true,
     },
     readAt: Date,
     delivered: {
       type: Boolean,
       default: false,
     },
     deliveredAt: Date,
     clicked: {
       type: Boolean,
       default: false,
     },
     clickedAt: Date,
   },

   // Multi-channel Delivery Tracking
   channels: {
     inApp: {
       sent: { type: Boolean, default: false },
       sentAt: Date,
       error: String,
     },
     push: {
       sent: { type: Boolean, default: false },
       sentAt: Date,
       deviceTokens: [String],
       fcmMessageId: String,
       error: String,
     },
     email: {
       sent: { type: Boolean, default: false },
       sentAt: Date,
       messageId: String,
       error: String,
     },
     sms: {
       sent: { type: Boolean, default: false },
       sentAt: Date,
       messageId: String,
       error: String,
     },
   },

   // Priority & Scheduling
   priority: {
     type: String,
     enum: Object.values(NOTIFICATION_PRIORITIES || ['low', 'normal', 'high', 'urgent']),
     default: 'normal',
     index: true,
   },

   scheduledFor: {
     type: Date,
     sparse: true,
     index: true,
   },

   expiresAt: {
     type: Date,
     sparse: true,
     index: true,
   },

   // Grouping & Batching
   groupId: {
     type: String,
     sparse: true,
     index: true,
   },

   batchId: {
     type: String,
     sparse: true,
   },

   // User Interaction
   interactions: [{
     action: {
       type: String,
       enum: ['viewed', 'clicked', 'dismissed', 'snoozed', 'marked_read'],
     },
     timestamp: {
       type: Date,
       default: Date.now,
     },
     metadata: mongoose.Schema.Types.Mixed,
   }],

   // Localization
   locale: {
     type: String,
     default: 'en',
   },

   translations: {
     type: Map,
     of: {
       title: String,
       body: String,
     },
   },

   // Additional Data
   data: {
     type: mongoose.Schema.Types.Mixed,
     default: {},
   },

   // Metadata
   metadata: {
     retryCount: {
       type: Number,
       default: 0,
     },
     lastRetryAt: Date,
     source: {
       type: String,
       enum: ['system', 'user_action', 'scheduled', 'campaign', 'api'],
       default: 'system',
     },
     campaignId: String,
     templateId: String,
     version: {
       type: Number,
       default: 1,
     },
   },

   // Soft Delete
   isDeleted: {
     type: Boolean,
     default: false,
     index: true,
   },
   deletedAt: Date,
   deletedBy: {
     type: mongoose.Schema.Types.ObjectId,
     ref: 'User',
   },
 },
 {
   timestamps: true,
   collection: 'notifications',
 }
);

// Compound Indexes for Performance
notificationSchema.index({ recipient: 1, 'status.read': 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, type: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, category: 1, 'status.read': 1 });
notificationSchema.index({ scheduledFor: 1, 'status.delivered': 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notificationSchema.index({ groupId: 1, recipient: 1 });
notificationSchema.index({ 'relatedEntities.matchId': 1 });
notificationSchema.index({ 'relatedEntities.conversationId': 1 });

// Virtual Fields
notificationSchema.virtual('isRead').get(function () {
 return this.status?.read === true;
});

notificationSchema.virtual('isExpired').get(function () {
 return this.expiresAt && this.expiresAt < new Date();
});

notificationSchema.virtual('age').get(function () {
 return Date.now() - this.createdAt.getTime();
});

// Instance Methods
notificationSchema.methods.markAsRead = async function (userId) {
 if (!this.status.read) {
   this.status.read = true;
   this.status.readAt = new Date();
   
   // Track interaction
   this.interactions.push({
     action: 'marked_read',
     metadata: { userId },
   });

   await this.save();
   return true;
 }
 return false;
};

notificationSchema.methods.markAsDelivered = async function (channel) {
 this.status.delivered = true;
 this.status.deliveredAt = new Date();
 
 if (channel && this.channels[channel]) {
   this.channels[channel].sent = true;
   this.channels[channel].sentAt = new Date();
 }
 
 await this.save();
};

notificationSchema.methods.recordClick = async function () {
 if (!this.status.clicked) {
   this.status.clicked = true;
   this.status.clickedAt = new Date();
   
   this.interactions.push({
     action: 'clicked',
   });

   await this.save();
   return true;
 }
 return false;
};

notificationSchema.methods.addInteraction = async function (action, metadata = {}) {
 this.interactions.push({
   action,
   metadata,
 });
 
 await this.save();
};

notificationSchema.methods.softDelete = async function (userId) {
 this.isDeleted = true;
 this.deletedAt = new Date();
 this.deletedBy = userId;
 await this.save();
};

// Static Methods
notificationSchema.statics.getUnreadCount = async function (userId) {
 return this.countDocuments({
   recipient: userId,
   'status.read': false,
   isDeleted: false,
   $or: [
     { expiresAt: { $exists: false } },
     { expiresAt: { $gt: new Date() } },
   ],
 });
};

notificationSchema.statics.getByCategory = async function (userId, category, options = {}) {
 const {
   limit = 20,
   skip = 0,
   unreadOnly = false,
 } = options;

 const query = {
   recipient: userId,
   category,
   isDeleted: false,
 };

 if (unreadOnly) {
   query['status.read'] = false;
 }

 return this.find(query)
   .sort({ createdAt: -1 })
   .limit(limit)
   .skip(skip)
   .populate('sender', 'name avatar')
   .lean();
};

notificationSchema.statics.markAllAsRead = async function (userId, filters = {}) {
 const query = {
   recipient: userId,
   'status.read': false,
   isDeleted: false,
   ...filters,
 };

 const result = await this.updateMany(
   query,
   {
     $set: {
       'status.read': true,
       'status.readAt': new Date(),
     },
     $push: {
       interactions: {
         action: 'marked_read',
         timestamp: new Date(),
         metadata: { bulk: true },
       },
     },
   }
 );

 return result.modifiedCount;
};

notificationSchema.statics.createBulk = async function (notifications) {
 const bulkOps = notifications.map((notif) => ({
   insertOne: {
     document: {
       ...notif,
       createdAt: new Date(),
       updatedAt: new Date(),
     },
   },
 }));

 return this.bulkWrite(bulkOps);
};

notificationSchema.statics.getGroupedNotifications = async function (userId, groupId) {
 return this.find({
   recipient: userId,
   groupId,
   isDeleted: false,
 })
   .sort({ createdAt: -1 })
   .populate('sender', 'name avatar')
   .lean();
};

notificationSchema.statics.cleanupExpired = async function () {
 const result = await this.deleteMany({
   expiresAt: { $lt: new Date() },
 });
 
 return result.deletedCount;
};

// Middleware
notificationSchema.pre('save', function (next) {
 // Auto-set category based on type if not set
 if (!this.category && this.type) {
   const typeCategories = {
     [NOTIFICATION_TYPES.NEW_MATCH]: 'match',
     [NOTIFICATION_TYPES.NEW_MESSAGE]: 'message',
     [NOTIFICATION_TYPES.SUPER_LIKE]: 'social',
     [NOTIFICATION_TYPES.PROFILE_VIEW]: 'social',
     [NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRING]: 'subscription',
     [NOTIFICATION_TYPES.SECURITY_ALERT]: 'security',
   };
   
   this.category = typeCategories[this.type] || 'system';
 }

 next();
});

// Post-save hook for real-time updates
notificationSchema.post('save', async function (doc) {
 // Emit socket event for real-time notification
 if (global.io) {
   global.io.to(`user:${doc.recipient}`).emit('notification:new', {
     _id: doc._id,
     type: doc.type,
     title: doc.title,
     body: doc.body,
     media: doc.media,
     createdAt: doc.createdAt,
   });
 }
});

// Plugins
notificationSchema.plugin(mongooseLeanVirtuals);

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;