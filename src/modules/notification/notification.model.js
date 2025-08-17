// src/modules/notification/notification.model.js
import mongoose from 'mongoose';
import { NOTIFICATION_TYPES, NOTIFICATION_PRIORITY, NOTIFICATION_STATUS } from '../../config/constants.js';

const { Schema } = mongoose;

/**
 * Notification Schema - Represents system notifications sent to users
 */
const notificationSchema = new Schema(
  {
    // User who receives the notification
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // Notification type
    type: {
      type: String,
      enum: Object.values(NOTIFICATION_TYPES),
      required: true,
      index: true,
    },

    // Notification title
    title: {
      type: String,
      required: true,
      maxlength: 100,
      trim: true,
    },

    // Notification body/content
    body: {
      type: String,
      required: true,
      maxlength: 500,
      trim: true,
    },

    // Additional data payload
    data: {
      // Match-related data
      matchId: {
        type: Schema.Types.ObjectId,
        ref: 'Match',
      },
      otherUserId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },

      // Message-related data
      messageId: {
        type: Schema.Types.ObjectId,
        ref: 'Message',
      },
      chatId: {
        type: Schema.Types.ObjectId,
        ref: 'Match',
      },

      // Profile-related data
      profileId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      photoId: String,

      // Subscription-related data
      subscriptionType: String,
      planName: String,
      amount: Number,

      // Media data
      mediaUrl: String,
      thumbnailUrl: String,

      // Deep link data
      screen: String,
      params: Schema.Types.Mixed,

      // Custom payload
      custom: Schema.Types.Mixed,
    },

    // Notification priority
    priority: {
      type: String,
      enum: Object.values(NOTIFICATION_PRIORITY),
      default: NOTIFICATION_PRIORITY.NORMAL,
      index: true,
    },

    // Read status
    status: {
      isRead: {
        type: Boolean,
        default: false,
        index: true,
      },
      readAt: Date,
      isDelivered: {
        type: Boolean,
        default: false,
      },
      deliveredAt: Date,
      isSent: {
        type: Boolean,
        default: false,
      },
      sentAt: Date,
      isClicked: {
        type: Boolean,
        default: false,
      },
      clickedAt: Date,
    },

    // Delivery channels
    channels: {
      inApp: {
        enabled: {
          type: Boolean,
          default: true,
        },
        delivered: {
          type: Boolean,
          default: false,
        },
        deliveredAt: Date,
        error: String,
      },
      push: {
        enabled: {
          type: Boolean,
          default: true,
        },
        delivered: {
          type: Boolean,
          default: false,
        },
        deliveredAt: Date,
        messageId: String, // FCM message ID
        error: String,
        retryCount: {
          type: Number,
          default: 0,
        },
      },
      email: {
        enabled: {
          type: Boolean,
          default: false,
        },
        delivered: {
          type: Boolean,
          default: false,
        },
        deliveredAt: Date,
        messageId: String, // Email service message ID
        error: String,
        retryCount: {
          type: Number,
          default: 0,
        },
      },
      sms: {
        enabled: {
          type: Boolean,
          default: false,
        },
        delivered: {
          type: Boolean,
          default: false,
        },
        deliveredAt: Date,
        messageId: String, // SMS service message ID
        error: String,
        retryCount: {
          type: Number,
          default: 0,
        },
      },
    },

    // Scheduling
    scheduling: {
      isScheduled: {
        type: Boolean,
        default: false,
      },
      scheduledFor: Date,
      schedulingStatus: {
        type: String,
        enum: ['pending', 'sent', 'failed', 'cancelled'],
        default: 'pending',
      },
      timezone: String,
    },

    // Expiry and auto-deletion
    expiry: {
      expiresAt: Date,
      autoDelete: {
        type: Boolean,
        default: false,
      },
      deleteAfterRead: {
        type: Boolean,
        default: false,
      },
      retentionDays: {
        type: Number,
        default: 30,
      },
    },

    // Grouping for notification center
    grouping: {
      groupKey: String, // For grouping similar notifications
      isGrouped: {
        type: Boolean,
        default: false,
      },
      groupCount: {
        type: Number,
        default: 1,
      },
      latestInGroup: {
        type: Boolean,
        default: true,
      },
    },

    // User interaction tracking
    interaction: {
      isActionable: {
        type: Boolean,
        default: false,
      },
      actions: [
        {
          id: String,
          label: String,
          type: {
            type: String,
            enum: ['button', 'link', 'deeplink'],
          },
          url: String,
          data: Schema.Types.Mixed,
        },
      ],
      hasInteracted: {
        type: Boolean,
        default: false,
      },
      interactionType: String, // clicked, dismissed, etc.
      interactedAt: Date,
    },

    // Metadata
    metadata: {
      source: {
        type: String,
        enum: ['system', 'user_action', 'scheduled', 'campaign', 'automation'],
        default: 'system',
      },
      campaign: {
        id: String,
        name: String,
        type: String,
      },
      template: {
        id: String,
        version: String,
      },
      platform: {
        type: String,
        enum: ['ios', 'android', 'web', 'system'],
      },
      appVersion: String,
      locale: {
        type: String,
        default: 'en',
      },
      triggeredBy: {
        userId: {
          type: Schema.Types.ObjectId,
          ref: 'User',
        },
        event: String,
        timestamp: Date,
      },
    },

    // Admin and moderation
    moderation: {
      isReviewed: {
        type: Boolean,
        default: false,
      },
      reviewedAt: Date,
      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      isBlocked: {
        type: Boolean,
        default: false,
      },
      blockReason: String,
      blockedAt: Date,
    },

    // Performance tracking
    performance: {
      deliveryAttempts: {
        type: Number,
        default: 0,
      },
      lastAttemptAt: Date,
      nextRetryAt: Date,
      processingTime: Number, // in milliseconds
      deliveryTime: Number, // time to deliver after creation
    },
  },
  {
    timestamps: true,
    collection: 'notifications',
  }
);

// ============================
// Indexes
// ============================

// Compound indexes for efficient queries
notificationSchema.index({ userId: 1, 'status.isRead': 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1, createdAt: -1 });
notificationSchema.index({ 'scheduling.scheduledFor': 1, 'scheduling.schedulingStatus': 1 });
notificationSchema.index({ 'expiry.expiresAt': 1 });
notificationSchema.index({ 'grouping.groupKey': 1, userId: 1, createdAt: -1 });
notificationSchema.index({ priority: 1, createdAt: -1 });
notificationSchema.index({ 'status.isDelivered': 1, 'channels.push.delivered': 1 });

// TTL index for auto-deletion
notificationSchema.index(
  { 'expiry.expiresAt': 1 },
  { 
    expireAfterSeconds: 0,
    partialFilterExpression: { 'expiry.autoDelete': true }
  }
);

// ============================
// Virtual Properties
// ============================

/**
 * Get formatted notification for display
 */
notificationSchema.virtual('formatted').get(function () {
  return {
    id: this._id,
    type: this.type,
    title: this.title,
    body: this.body,
    data: this.data,
    priority: this.priority,
    isRead: this.status.isRead,
    readAt: this.status.readAt,
    createdAt: this.createdAt,
    isActionable: this.interaction.isActionable,
    actions: this.interaction.actions,
  };
});

/**
 * Check if notification is expired
 */
notificationSchema.virtual('isExpired').get(function () {
  return this.expiry.expiresAt && new Date() > this.expiry.expiresAt;
});

/**
 * Check if notification needs retry
 */
notificationSchema.virtual('needsRetry').get(function () {
  const maxRetries = 3;
  return (
    !this.status.isDelivered &&
    this.performance.deliveryAttempts < maxRetries &&
    (!this.performance.nextRetryAt || new Date() >= this.performance.nextRetryAt)
  );
});

// ============================
// Instance Methods
// ============================

/**
 * Mark notification as read
 */
notificationSchema.methods.markAsRead = async function () {
  if (!this.status.isRead) {
    this.status.isRead = true;
    this.status.readAt = new Date();
    
    if (this.expiry.deleteAfterRead) {
      // Schedule for deletion
      this.expiry.expiresAt = new Date(Date.now() + 60000); // 1 minute
    }
    
    await this.save();
    
    // Track metrics
    const MetricsService = (await import('../../shared/services/metrics.service.js')).default;
    await MetricsService.incrementCounter('notifications.read', 1, {
      type: this.type,
      priority: this.priority,
    });
  }
  
  return this;
};

/**
 * Mark notification as clicked
 */
notificationSchema.methods.markAsClicked = async function (interactionType = 'clicked') {
  this.status.isClicked = true;
  this.status.clickedAt = new Date();
  this.interaction.hasInteracted = true;
  this.interaction.interactionType = interactionType;
  this.interaction.interactedAt = new Date();
  
  await this.save();
  
  // Track metrics
  const MetricsService = (await import('../../shared/services/metrics.service.js')).default;
  await MetricsService.incrementCounter('notifications.clicked', 1, {
    type: this.type,
    priority: this.priority,
    interactionType,
  });
  
  return this;
};

/**
 * Update delivery status for a channel
 */
notificationSchema.methods.updateDeliveryStatus = async function (channel, delivered, messageId = null, error = null) {
  if (!this.channels[channel]) return this;
  
  this.channels[channel].delivered = delivered;
  this.channels[channel].deliveredAt = delivered ? new Date() : null;
  
  if (messageId) {
    this.channels[channel].messageId = messageId;
  }
  
  if (error) {
    this.channels[channel].error = error;
    this.channels[channel].retryCount += 1;
  }
  
  // Update overall delivery status
  const anyDelivered = Object.values(this.channels).some(ch => ch.enabled && ch.delivered);
  if (anyDelivered && !this.status.isDelivered) {
    this.status.isDelivered = true;
    this.status.deliveredAt = new Date();
  }
  
  await this.save();
  return this;
};

/**
 * Check if notification should be sent via channel
 */
notificationSchema.methods.shouldSendViaChannel = function (channel) {
  return (
    this.channels[channel].enabled &&
    !this.channels[channel].delivered &&
    this.channels[channel].retryCount < 3
  );
};

// ============================
// Static Methods
// ============================

/**
 * Get unread count for user
 */
notificationSchema.statics.getUnreadCount = async function (userId) {
  return this.countDocuments({
    userId,
    'status.isRead': false,
    'expiry.expiresAt': { $gt: new Date() },
  });
};

/**
 * Get notifications for user with pagination
 */
notificationSchema.statics.getUserNotifications = async function (userId, options = {}) {
  const {
    page = 1,
    limit = 20,
    type = null,
    unreadOnly = false,
    includeExpired = false,
  } = options;

  const query = { userId };

  if (type) {
    query.type = type;
  }

  if (unreadOnly) {
    query['status.isRead'] = false;
  }

  if (!includeExpired) {
    query.$or = [
      { 'expiry.expiresAt': { $exists: false } },
      { 'expiry.expiresAt': { $gt: new Date() } },
    ];
  }

  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    this.find(query)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('data.otherUserId', 'profile.firstName profile.displayName profile.photos')
      .lean(),
    this.countDocuments(query),
  ]);

  return {
    notifications,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1,
    },
  };
};

/**
 * Mark all notifications as read for user
 */
notificationSchema.statics.markAllAsRead = async function (userId) {
  const result = await this.updateMany(
    {
      userId,
      'status.isRead': false,
    },
    {
      $set: {
        'status.isRead': true,
        'status.readAt': new Date(),
      },
    }
  );

  // Track metrics
  const MetricsService = (await import('../../shared/services/metrics.service.js')).default;
  await MetricsService.incrementCounter('notifications.bulk_read', result.modifiedCount);

  return result.modifiedCount;
};

/**
 * Get notifications ready for retry
 */
notificationSchema.statics.getRetryNotifications = async function () {
  const maxRetries = 3;
  
  return this.find({
    'status.isDelivered': false,
    'performance.deliveryAttempts': { $lt: maxRetries },
    $or: [
      { 'performance.nextRetryAt': { $exists: false } },
      { 'performance.nextRetryAt': { $lte: new Date() } },
    ],
  }).limit(100);
};

/**
 * Get scheduled notifications ready to send
 */
notificationSchema.statics.getScheduledNotifications = async function () {
  return this.find({
    'scheduling.isScheduled': true,
    'scheduling.schedulingStatus': 'pending',
    'scheduling.scheduledFor': { $lte: new Date() },
  });
};

/**
 * Clean up old notifications
 */
notificationSchema.statics.cleanupOldNotifications = async function () {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  const result = await this.deleteMany({
    $or: [
      { 'expiry.expiresAt': { $lte: new Date() } },
      {
        createdAt: { $lte: thirtyDaysAgo },
        'status.isRead': true,
        'expiry.autoDelete': { $ne: false },
      },
    ],
  });

  return result.deletedCount;
};

/**
 * Get notification statistics
 */
notificationSchema.statics.getStats = async function (dateRange = {}) {
  const { start, end } = dateRange;
  const query = {};

  if (start || end) {
    query.createdAt = {};
    if (start) query.createdAt.$gte = start;
    if (end) query.createdAt.$lte = end;
  }

  const [
    total,
    delivered,
    read,
    clicked,
    byType,
    byPriority,
  ] = await Promise.all([
    this.countDocuments(query),
    this.countDocuments({ ...query, 'status.isDelivered': true }),
    this.countDocuments({ ...query, 'status.isRead': true }),
    this.countDocuments({ ...query, 'status.isClicked': true }),
    this.aggregate([
      { $match: query },
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    this.aggregate([
      { $match: query },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const deliveryRate = total > 0 ? (delivered / total) * 100 : 0;
  const readRate = delivered > 0 ? (read / delivered) * 100 : 0;
  const clickRate = delivered > 0 ? (clicked / delivered) * 100 : 0;

  return {
    total,
    delivered,
    read,
    clicked,
    rates: {
      delivery: Math.round(deliveryRate * 10) / 10,
      read: Math.round(readRate * 10) / 10,
      click: Math.round(clickRate * 10) / 10,
    },
    breakdown: {
      byType: byType.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
      byPriority: byPriority.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {}),
    },
  };
};

// ============================
// Middleware
// ============================

/**
 * Pre-save middleware
 */
notificationSchema.pre('save', async function (next) {
  // Set default expiry if not set
  if (this.isNew && !this.expiry.expiresAt && this.expiry.retentionDays) {
    this.expiry.expiresAt = new Date(
      Date.now() + this.expiry.retentionDays * 24 * 60 * 60 * 1000
    );
  }

  // Generate group key for similar notifications
  if (this.isNew && !this.grouping.groupKey) {
    this.grouping.groupKey = `${this.type}_${this.userId}_${this.data.matchId || this.data.otherUserId || 'general'}`;
  }

  // Set scheduling status
  if (this.scheduling.isScheduled && this.scheduling.scheduledFor > new Date()) {
    this.scheduling.schedulingStatus = 'pending';
  }

  next();
});

/**
 * Post-save middleware for real-time updates
 */
notificationSchema.post('save', async function (doc) {
  if (doc.wasNew) {
    // Emit real-time notification via Socket.io
    try {
      const socketManager = (await import('../../config/socket.js')).default;
      socketManager.emitToUser(doc.userId.toString(), 'notification:new', doc.formatted);
      
      // Update unread count
      const unreadCount = await this.constructor.getUnreadCount(doc.userId);
      socketManager.emitToUser(doc.userId.toString(), 'notification:unread', { count: unreadCount });
    } catch (error) {
      // Silently fail for socket emissions
    }

    // Track metrics
    const MetricsService = (await import('../../shared/services/metrics.service.js')).default;
    await MetricsService.incrementCounter('notifications.created', 1, {
      type: doc.type,
      priority: doc.priority,
    });
  }
});

// ============================
// Model Export
// ============================

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;