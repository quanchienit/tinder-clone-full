// src/shared/services/notification.service.js
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../utils/logger.js';
import CacheService from './cache.service.js';
import QueueService from './queue.service.js';
import MetricsService from './metrics.service.js';
import PushService from './push.service.js';
import EmailService from './email.service.js';
import Notification from '../notification/notification.model.js';
import AppError from '../errors/AppError.js';
import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITY,
  NOTIFICATION_STATUS,
  ERROR_CODES,
  HTTP_STATUS,
  SOCKET_EVENTS
} from '../../config/constants.js';

class NotificationService {
  constructor() {
    this.initialized = false;
    this.defaultPreferences = {
      inApp: true,
      push: true,
      email: false,
      sms: false,
    };
    this.channelPriorityMap = {
      [NOTIFICATION_PRIORITY.HIGH]: ['push', 'inApp', 'email'],
      [NOTIFICATION_PRIORITY.NORMAL]: ['inApp', 'push'],
      [NOTIFICATION_PRIORITY.LOW]: ['inApp'],
    };
  }

  /**
   * Initialize notification service
   */
  async initialize() {
    try {
      // Initialize dependent services
      await Promise.all([
        PushService.initialize(),
        EmailService.initialize(),
      ]);

      // Register queue handlers
      QueueService.registerHandler('notifications', this.processNotificationJob.bind(this));
      QueueService.registerHandler('notification-retry', this.retryFailedNotification.bind(this));
      QueueService.registerHandler('notification-cleanup', this.cleanupOldNotifications.bind(this));

      this.initialized = true;
      logger.info('✅ Notification service initialized');

    } catch (error) {
      logger.error('Failed to initialize notification service:', error);
      throw error;
    }
  }

  /**
   * Send notification to user
   * @param {string} userId - User ID
   * @param {Object} notificationData - Notification data
   * @param {Object} options - Additional options
   */
  async sendNotification(userId, notificationData, options = {}) {
    try {
      if (!this.initialized) {
        throw new AppError('Notification service not initialized', HTTP_STATUS.SERVICE_UNAVAILABLE, ERROR_CODES.SERVICE_UNAVAILABLE);
      }

      const startTime = Date.now();
      const { 
        type, 
        title, 
        body, 
        data = {}, 
        priority = NOTIFICATION_PRIORITY.NORMAL,
        channels = null,
        scheduling = null 
      } = notificationData;

      // Validate notification data
      this.validateNotificationData(notificationData);

      // Check if user exists and get preferences
      const userPreferences = await this.getUserNotificationPreferences(userId);
      if (!userPreferences.found) {
        logger.warn(`User ${userId} not found, skipping notification`);
        return { success: false, reason: 'user_not_found' };
      }

      // Create notification in database
      const notification = await this.createNotification(userId, {
        type,
        title,
        body,
        data,
        priority,
        scheduling,
        channels: channels || this.getDefaultChannels(priority, userPreferences),
      });

      // Handle scheduled notifications
      if (scheduling?.isScheduled && scheduling.scheduledFor > new Date()) {
        await this.scheduleNotification(notification, scheduling);
        return { 
          success: true, 
          notificationId: notification._id,
          scheduled: true,
          scheduledFor: scheduling.scheduledFor 
        };
      }

      // Send immediately
      const result = await this.deliverNotification(notification, userPreferences, options);

      // Track metrics
      const processingTime = Date.now() - startTime;
      await this.trackNotificationMetrics(userId, type, result, processingTime);

      logger.info(`Notification sent to user ${userId}: ${result.channelsDelivered.length}/${result.totalChannels} channels successful`);

      return {
        success: result.totalChannels > 0,
        notificationId: notification._id,
        channelsDelivered: result.channelsDelivered,
        channelsFailed: result.channelsFailed,
        processingTime,
      };

    } catch (error) {
      logger.error(`Error sending notification to user ${userId}:`, error);
      
      // Track failed metrics
      await MetricsService.incrementCounter('notifications.send.failed', 1, {
        type: notificationData.type,
        error: error.code || 'unknown',
      });

      throw error;
    }
  }

  /**
   * Send bulk notifications
   * @param {Array} notifications - Array of {userId, notification} objects
   * @param {Object} options - Bulk options
   */
  async sendBulkNotifications(notifications, options = {}) {
    try {
      const { 
        batchSize = 100, 
        maxConcurrency = 5, 
        delayBetweenBatches = 1000,
        stopOnError = false 
      } = options;

      const results = {
        success: [],
        failed: [],
        totalSent: 0,
        totalFailed: 0,
        channelStats: {},
      };

      logger.info(`Starting bulk notification send for ${notifications.length} notifications`);

      // Process in batches
      for (let i = 0; i < notifications.length; i += batchSize) {
        const batch = notifications.slice(i, i + batchSize);
        
        // Process batch with concurrency limit
        const batchPromises = batch.map(async ({ userId, notification }) => {
          try {
            const result = await this.sendNotification(userId, notification, options);
            if (result.success) {
              results.success.push({ userId, notificationId: result.notificationId });
              results.totalSent += 1;
              
              // Track channel stats
              result.channelsDelivered.forEach(channel => {
                results.channelStats[channel] = (results.channelStats[channel] || 0) + 1;
              });
            } else {
              results.failed.push({ userId, reason: result.reason });
              results.totalFailed += 1;
            }
          } catch (error) {
            results.failed.push({ userId, error: error.message });
            results.totalFailed += 1;
            
            if (stopOnError) {
              throw error;
            }
          }
        });

        // Limit concurrency
        const chunks = [];
        for (let j = 0; j < batchPromises.length; j += maxConcurrency) {
          chunks.push(batchPromises.slice(j, j + maxConcurrency));
        }

        for (const chunk of chunks) {
          await Promise.all(chunk);
        }

        // Delay between batches
        if (i + batchSize < notifications.length && delayBetweenBatches > 0) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
        }

        logger.debug(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(notifications.length / batchSize)}`);
      }

      logger.info(`Bulk notifications completed: ${results.totalSent} sent, ${results.totalFailed} failed`);
      
      // Track bulk metrics
      await MetricsService.incrementCounter('notifications.bulk.sent', results.totalSent);
      await MetricsService.incrementCounter('notifications.bulk.failed', results.totalFailed);

      return results;

    } catch (error) {
      logger.error('Error sending bulk notifications:', error);
      throw error;
    }
  }

  /**
   * Create notification in database
   * @private
   */
  async createNotification(userId, notificationData) {
    try {
      const notification = new Notification({
        userId,
        type: notificationData.type,
        title: notificationData.title,
        body: notificationData.body,
        data: notificationData.data,
        priority: notificationData.priority,
        channels: notificationData.channels,
        scheduling: notificationData.scheduling,
        metadata: {
          source: 'system',
          platform: 'server',
        },
      });

      await notification.save();
      
      // Track creation metrics
      await MetricsService.incrementCounter('notifications.created', 1, {
        type: notificationData.type,
        priority: notificationData.priority,
      });

      return notification;

    } catch (error) {
      logger.error('Error creating notification:', error);
      throw error;
    }
  }

  /**
   * Deliver notification through all enabled channels
   * @private
   */
  async deliverNotification(notification, userPreferences, options = {}) {
    const result = {
      totalChannels: 0,
      channelsDelivered: [],
      channelsFailed: [],
      errors: {},
    };

    // Determine active channels
    const activeChannels = this.getActiveChannels(notification, userPreferences);
    result.totalChannels = activeChannels.length;

    if (activeChannels.length === 0) {
      logger.debug(`No active channels for user ${notification.userId}`);
      return result;
    }

    // Send through each channel
    const channelPromises = activeChannels.map(async (channel) => {
      try {
        await this.sendThroughChannel(channel, notification, options);
        result.channelsDelivered.push(channel);
        
        // Update notification delivery status
        await notification.updateDeliveryStatus(channel, true);
        
      } catch (error) {
        result.channelsFailed.push(channel);
        result.errors[channel] = error.message;
        
        // Update notification delivery status with error
        await notification.updateDeliveryStatus(channel, false, null, error.message);
        
        logger.error(`Failed to send notification through ${channel} to user ${notification.userId}:`, error);
      }
    });

    await Promise.all(channelPromises);

    return result;
  }

  /**
   * Send notification through specific channel
   * @private
   */
  async sendThroughChannel(channel, notification, options = {}) {
    const userId = notification.userId.toString();
    
    switch (channel) {
      case 'inApp':
        await this.sendInAppNotification(userId, notification);
        break;
        
      case 'push':
        await PushService.sendPushNotification(userId, {
          _id: notification._id,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          data: notification.data,
          priority: notification.priority,
        }, options.push);
        break;
        
      case 'email':
        await EmailService.sendNotificationEmail(userId, notification.type, {
          notificationId: notification._id,
          title: notification.title,
          body: notification.body,
          ...notification.data,
        });
        break;
        
      case 'sms':
        await this.sendSMSNotification(userId, notification);
        break;
        
      default:
        throw new Error(`Unknown notification channel: ${channel}`);
    }
  }

  /**
   * Send in-app notification via Socket.io
   * @private
   */
  async sendInAppNotification(userId, notification) {
    try {
      // Emit to user's socket
      socketManager.emitToUser(userId, SOCKET_EVENTS.NOTIFICATION_NEW, notification.formatted);
      
      // Update unread count
      const unreadCount = await this.getUnreadCount(userId);
      socketManager.emitToUser(userId, SOCKET_EVENTS.NOTIFICATION_UNREAD, { count: unreadCount });
      
      logger.debug(`In-app notification sent to user ${userId}`);

    } catch (error) {
      logger.error(`Error sending in-app notification to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Send SMS notification (placeholder for SMS service integration)
   * @private
   */
  async sendSMSNotification(userId, notification) {
    try {
      // This would integrate with SMS service like Twilio
      logger.info(`SMS notification would be sent to user ${userId}: ${notification.title}`);
      
      // For now, just track the attempt
      await MetricsService.incrementCounter('notifications.sms.sent', 1, {
        type: notification.type,
      });

    } catch (error) {
      logger.error(`Error sending SMS notification to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get user notification preferences
   * @private
   */
  async getUserNotificationPreferences(userId) {
    try {
      // Try cache first
      const cacheKey = `user:${userId}:notification_preferences`;
      const cached = await CacheService.get(cacheKey);
      
      if (cached) {
        return JSON.parse(cached);
      }

      // Get from database
      const User = (await import('../../modules/user/user.model.js')).default;
      const user = await User.findById(userId).select('preferences.notifications status.isActive');
      
      if (!user) {
        return { found: false };
      }

      const preferences = {
        found: true,
        isActive: user.status?.isActive !== false,
        inApp: user.preferences?.notifications?.inApp ?? this.defaultPreferences.inApp,
        push: user.preferences?.notifications?.push ?? this.defaultPreferences.push,
        email: user.preferences?.notifications?.email ?? this.defaultPreferences.email,
        sms: user.preferences?.notifications?.sms ?? this.defaultPreferences.sms,
        types: user.preferences?.notifications?.types || {},
      };

      // Cache for 30 minutes
      await CacheService.set(cacheKey, JSON.stringify(preferences), 1800);

      return preferences;

    } catch (error) {
      logger.error(`Error getting notification preferences for user ${userId}:`, error);
      return { 
        found: true, 
        ...this.defaultPreferences,
        types: {} 
      };
    }
  }

  /**
   * Get default channels based on priority and preferences
   * @private
   */
  getDefaultChannels(priority, userPreferences) {
    const channels = {};
    const priorityChannels = this.channelPriorityMap[priority] || ['inApp'];

    priorityChannels.forEach(channel => {
      channels[channel] = {
        enabled: userPreferences[channel] && userPreferences.isActive,
        delivered: false,
        retryCount: 0,
      };
    });

    return channels;
  }

  /**
   * Get active channels for notification
   * @private
   */
  getActiveChannels(notification, userPreferences) {
    const activeChannels = [];

    for (const [channel, config] of Object.entries(notification.channels)) {
      if (config.enabled && userPreferences[channel] && userPreferences.isActive) {
        // Check type-specific preferences
        const typePrefs = userPreferences.types[notification.type];
        if (!typePrefs || typePrefs[channel] !== false) {
          activeChannels.push(channel);
        }
      }
    }

    return activeChannels;
  }

  /**
   * Schedule notification for later delivery
   * @private
   */
  async scheduleNotification(notification, scheduling) {
    try {
      const delay = scheduling.scheduledFor.getTime() - Date.now();
      
      if (delay <= 0) {
        throw new Error('Scheduled time must be in the future');
      }

      await QueueService.addJob('notifications', {
        notificationId: notification._id.toString(),
        isScheduled: true,
      }, {
        delay,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 30000,
        },
      });

      logger.info(`Notification scheduled for user ${notification.userId} at ${scheduling.scheduledFor}`);

    } catch (error) {
      logger.error('Error scheduling notification:', error);
      throw error;
    }
  }

  /**
   * Process notification job from queue
   * @private
   */
  async processNotificationJob(jobData) {
    try {
      const { notificationId, isScheduled = false } = jobData;

      if (isScheduled) {
        // Handle scheduled notification
        const notification = await Notification.findById(notificationId);
        if (!notification) {
          logger.warn(`Scheduled notification ${notificationId} not found`);
          return;
        }

        if (notification.scheduling.schedulingStatus !== 'pending') {
          logger.warn(`Scheduled notification ${notificationId} already processed`);
          return;
        }

        // Update status and deliver
        notification.scheduling.schedulingStatus = 'sent';
        await notification.save();

        const userPreferences = await this.getUserNotificationPreferences(notification.userId.toString());
        await this.deliverNotification(notification, userPreferences);

      } else {
        // Handle regular notification job
        logger.warn('Regular notification jobs should use sendNotification method directly');
      }

    } catch (error) {
      logger.error('Error processing notification job:', error);
      throw error;
    }
  }

  /**
   * Retry failed notification
   * @private
   */
  async retryFailedNotification(jobData) {
    try {
      const { notificationId, channel } = jobData;
      
      const notification = await Notification.findById(notificationId);
      if (!notification) {
        logger.warn(`Notification ${notificationId} not found for retry`);
        return;
      }

      if (notification.channels[channel].retryCount >= 3) {
        logger.warn(`Max retries reached for notification ${notificationId} channel ${channel}`);
        return;
      }

      // Increment retry count
      notification.channels[channel].retryCount += 1;
      await notification.save();

      // Retry sending
      const userPreferences = await this.getUserNotificationPreferences(notification.userId.toString());
      await this.sendThroughChannel(channel, notification);

      logger.info(`Notification ${notificationId} retried successfully for channel ${channel}`);

    } catch (error) {
      logger.error('Error retrying notification:', error);
      throw error;
    }
  }

  /**
   * Get user notifications with pagination
   */
  async getUserNotifications(userId, options = {}) {
    try {
      const {
        page = 1,
        limit = 20,
        type = null,
        unreadOnly = false,
        includeExpired = false,
      } = options;

      const result = await Notification.getUserNotifications(userId, {
        page,
        limit,
        type,
        unreadOnly,
        includeExpired,
      });

      return {
        notifications: result.notifications,
        pagination: result.pagination,
        unreadCount: await this.getUnreadCount(userId),
      };

    } catch (error) {
      logger.error(`Error getting notifications for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Mark notification as read
   */
  async markAsRead(userId, notificationId) {
    try {
      const notification = await Notification.findOne({
        _id: notificationId,
        userId,
      });

      if (!notification) {
        throw new AppError('Notification not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
      }

      await notification.markAsRead();

      // Clear unread count cache
      const cacheKey = `user:${userId}:unread_count`;
      await CacheService.delete(cacheKey);

      // Emit updated unread count
      const unreadCount = await this.getUnreadCount(userId);
      socketManager.emitToUser(userId, SOCKET_EVENTS.NOTIFICATION_UNREAD, { count: unreadCount });

      return notification;

    } catch (error) {
      logger.error(`Error marking notification as read:`, error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(userId) {
    try {
      const count = await Notification.markAllAsRead(userId);

      // Clear unread count cache
      const cacheKey = `user:${userId}:unread_count`;
      await CacheService.delete(cacheKey);

      // Emit updated unread count
      socketManager.emitToUser(userId, SOCKET_EVENTS.NOTIFICATION_UNREAD, { count: 0 });

      return { markedCount: count };

    } catch (error) {
      logger.error(`Error marking all notifications as read for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Delete notification
   */
  async deleteNotification(userId, notificationId) {
    try {
      const notification = await Notification.findOneAndDelete({
        _id: notificationId,
        userId,
      });

      if (!notification) {
        throw new AppError('Notification not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
      }

      // Clear caches
      const cacheKey = `user:${userId}:unread_count`;
      await CacheService.delete(cacheKey);

      // Track deletion
      await MetricsService.incrementCounter('notifications.deleted', 1, {
        type: notification.type,
      });

      return { deleted: true };

    } catch (error) {
      logger.error(`Error deleting notification:`, error);
      throw error;
    }
  }

  /**
   * Get unread count for user
   */
  async getUnreadCount(userId) {
    try {
      // Try cache first
      const cacheKey = `user:${userId}:unread_count`;
      const cached = await CacheService.get(cacheKey);
      
      if (cached !== null) {
        return parseInt(cached);
      }

      // Get from database
      const count = await Notification.getUnreadCount(userId);

      // Cache for 5 minutes
      await CacheService.set(cacheKey, count.toString(), 300);

      return count;

    } catch (error) {
      logger.error(`Error getting unread count for user ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Update user notification preferences
   */
  async updateNotificationPreferences(userId, preferences) {
    try {
      const User = (await import('../../modules/user/user.model.js')).default;
      
      await User.findByIdAndUpdate(userId, {
        $set: {
          'preferences.notifications': preferences,
        },
      });

      // Clear preferences cache
      const cacheKey = `user:${userId}:notification_preferences`;
      await CacheService.delete(cacheKey);

      logger.info(`Updated notification preferences for user ${userId}`);

      return { updated: true };

    } catch (error) {
      logger.error(`Error updating notification preferences for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Validate notification data
   * @private
   */
  validateNotificationData(data) {
    const { type, title, body } = data;

    if (!type || !Object.values(NOTIFICATION_TYPES).includes(type)) {
      throw new AppError('Invalid notification type', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    }

    if (!title || title.trim().length === 0) {
      throw new AppError('Notification title is required', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    }

    if (!body || body.trim().length === 0) {
      throw new AppError('Notification body is required', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    }

    if (title.length > 100) {
      throw new AppError('Notification title too long', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    }

    if (body.length > 500) {
      throw new AppError('Notification body too long', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    }
  }

  /**
   * Track notification metrics
   * @private
   */
  async trackNotificationMetrics(userId, type, result, processingTime) {
    try {
      const tags = {
        type,
        success: result.channelsDelivered.length > 0,
        totalChannels: result.totalChannels,
      };

      await Promise.all([
        MetricsService.incrementCounter('notifications.sent', 1, tags),
        MetricsService.recordHistogram('notifications.processing_time', processingTime, tags),
        MetricsService.trackUserAction(userId, 'notification_sent', {
          type,
          channelsDelivered: result.channelsDelivered,
          channelsFailed: result.channelsFailed,
        }),
      ]);

      // Track per-channel metrics
      result.channelsDelivered.forEach(channel => {
        MetricsService.incrementCounter('notifications.channel.delivered', 1, {
          channel,
          type,
        });
      });

      result.channelsFailed.forEach(channel => {
        MetricsService.incrementCounter('notifications.channel.failed', 1, {
          channel,
          type,
        });
      });

    } catch (error) {
      logger.error('Error tracking notification metrics:', error);
    }
  }

  /**
   * Clean up old notifications
   * @private
   */
  async cleanupOldNotifications() {
    try {
      const deletedCount = await Notification.cleanupOldNotifications();
      
      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} old notifications`);
        await MetricsService.incrementCounter('notifications.cleanup.deleted', deletedCount);
      }

      return { deletedCount };

    } catch (error) {
      logger.error('Error cleaning up old notifications:', error);
      throw error;
    }
  }

  /**
   * Send test notification
   */
  async sendTestNotification(userId) {
    return this.sendNotification(userId, {
      type: NOTIFICATION_TYPES.SYSTEM,
      title: 'Test Notification',
      body: 'This is a test notification to verify your notification settings.',
      data: {
        test: true,
        timestamp: new Date().toISOString(),
      },
      priority: NOTIFICATION_PRIORITY.NORMAL,
    });
  }

  /**
   * Get notification statistics
   */
  async getNotificationStats(dateRange = {}) {
    try {
      const stats = await Notification.getStats(dateRange);
      
      // Add real-time metrics
      const realtimeStats = await MetricsService.getMetricStats('notifications.sent', dateRange);
      
      return {
        ...stats,
        realtime: realtimeStats,
        services: {
          push: await PushService.getPushStats(dateRange),
          email: await EmailService.getEmailStats(dateRange),
        },
      };

    } catch (error) {
      logger.error('Error getting notification stats:', error);
      return {
        total: 0,
        delivered: 0,
        read: 0,
        clicked: 0,
        rates: { delivery: 0, read: 0, click: 0 },
        breakdown: { byType: {}, byPriority: {} },
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const checks = {
        service: this.initialized,
        push: await PushService.healthCheck(),
        email: await EmailService.healthCheck(),
        database: await this.checkDatabaseConnection(),
        queue: await QueueService.healthCheck(),
      };

      const isHealthy = Object.values(checks).every(check => 
        typeof check === 'boolean' ? check : check.status === 'healthy'
      );

      return {
        status: isHealthy ? 'healthy' : 'unhealthy',
        checks,
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Check database connection
   * @private
   */
  async checkDatabaseConnection() {
    try {
      await Notification.findOne().limit(1);
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }
}

export default new NotificationService();