// src/shared/services/push.service.js
import admin from 'firebase-admin';
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import CacheService from './cache.service.js';
import MetricsService from './metrics.service.js';
import QueueService from './queue.service.js';
import AppError from '../errors/AppError.js';
import { 
  NOTIFICATION_TYPES, 
  NOTIFICATION_PRIORITY,
  ERROR_CODES,
  HTTP_STATUS 
} from '../../config/constants.js';

class PushNotificationService {
  constructor() {
    this.firebaseApp = null;
    this.initialized = false;
    this.defaultOptions = {
      android: {
        priority: 'high',
        ttl: 3600000, // 1 hour
        notification: {
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          channelId: 'default',
        },
        data: {
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-expiration': Math.floor(Date.now() / 1000) + 3600,
        },
        payload: {
          aps: {
            sound: 'default',
            category: 'GENERAL',
            'mutable-content': 1,
          },
        },
      },
      webpush: {
        headers: {
          TTL: '3600',
        },
        notification: {
          icon: '/icon-192x192.png',
          badge: '/badge-72x72.png',
          requireInteraction: false,
        },
      },
    };
  }

  /**
   * Initialize Firebase Admin SDK
   */
  async initialize() {
    try {
      if (!process.env.FIREBASE_PROJECT_ID) {
        logger.warn('Firebase credentials not configured. Push notifications disabled.');
        return;
      }

      // Initialize Firebase Admin SDK
      this.firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });

      // Verify initialization
      await admin.messaging().send({
        token: 'dummy-token',
        notification: { title: 'Test', body: 'Test' },
      }, true); // dry run

      this.initialized = true;
      logger.info('✅ Firebase Admin SDK initialized for push notifications');

      // Register queue handler
      QueueService.registerHandler('push-notifications', this.processPushJob.bind(this));

    } catch (error) {
      if (!error.message.includes('dummy-token')) {
        logger.error('Failed to initialize Firebase Admin SDK:', error);
        throw error;
      }
      this.initialized = true;
      logger.info('✅ Firebase Admin SDK initialized for push notifications');
    }
  }

  /**
   * Send push notification to user
   * @param {string} userId - User ID
   * @param {Object} notification - Notification data
   * @param {Object} options - Additional options
   */
  async sendPushNotification(userId, notification, options = {}) {
    try {
      if (!this.initialized) {
        logger.warn('Push service not initialized. Cannot send push notification.');
        return { success: false, error: 'Service not initialized' };
      }

      const startTime = Date.now();

      // Get user's FCM tokens
      const tokens = await this.getUserFCMTokens(userId);
      if (!tokens || tokens.length === 0) {
        logger.debug(`No FCM tokens found for user ${userId}`);
        return { success: false, error: 'No FCM tokens found' };
      }

      // Prepare message payload
      const message = await this.prepareMessage(notification, userId, options);

      // Send to all user's devices
      const response = await this.sendToMultipleTokens(tokens, message, userId);

      // Track metrics
      const processingTime = Date.now() - startTime;
      await this.trackPushMetrics(userId, notification.type, response, processingTime);

      logger.info(`Push notification sent to user ${userId}: ${response.successCount}/${tokens.length} successful`);
      
      return {
        success: response.successCount > 0,
        successCount: response.successCount,
        failureCount: response.failureCount,
        responses: response.responses,
        processingTime,
      };

    } catch (error) {
      logger.error(`Error sending push notification to ${userId}:`, error);
      await MetricsService.incrementCounter('push.notifications.error', 1, {
        userId,
        error: error.code || 'unknown',
      });
      throw error;
    }
  }

  /**
   * Send bulk push notifications
   * @param {Array} notifications - Array of {userId, notification} objects
   * @param {Object} options - Bulk options
   */
  async sendBulkPushNotifications(notifications, options = {}) {
    try {
      const { batchSize = 100, maxConcurrency = 5 } = options;
      const results = {
        success: [],
        failed: [],
        totalSent: 0,
        totalFailed: 0,
      };

      logger.info(`Starting bulk push notification send for ${notifications.length} notifications`);

      // Process in batches
      for (let i = 0; i < notifications.length; i += batchSize) {
        const batch = notifications.slice(i, i + batchSize);
        
        // Process batch with concurrency limit
        const batchPromises = batch.map(async ({ userId, notification }) => {
          try {
            const result = await this.sendPushNotification(userId, notification);
            if (result.success) {
              results.success.push({ userId, result });
              results.totalSent += result.successCount;
            } else {
              results.failed.push({ userId, error: result.error });
              results.totalFailed += 1;
            }
          } catch (error) {
            results.failed.push({ userId, error: error.message });
            results.totalFailed += 1;
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

        logger.debug(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(notifications.length / batchSize)}`);
      }

      logger.info(`Bulk push notifications completed: ${results.totalSent} sent, ${results.totalFailed} failed`);
      
      // Track bulk metrics
      await MetricsService.incrementCounter('push.notifications.bulk.sent', results.totalSent);
      await MetricsService.incrementCounter('push.notifications.bulk.failed', results.totalFailed);

      return results;

    } catch (error) {
      logger.error('Error sending bulk push notifications:', error);
      throw error;
    }
  }

  /**
   * Send to multiple tokens
   * @private
   */
  async sendToMultipleTokens(tokens, message, userId) {
    try {
      const response = await admin.messaging().sendMulticast({
        ...message,
        tokens,
      });

      // Handle failed tokens
      if (response.failureCount > 0) {
        const failedTokens = [];
        const invalidTokens = [];

        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const token = tokens[idx];
            failedTokens.push({ token, error: resp.error });

            // Check if token is invalid
            if (this.isInvalidTokenError(resp.error)) {
              invalidTokens.push(token);
            }

            logger.error(`Failed to send to token ${token}:`, resp.error?.message);
          }
        });

        // Remove invalid tokens
        if (invalidTokens.length > 0) {
          await this.removeInvalidTokens(userId, invalidTokens);
        }

        // Queue failed notifications for retry (non-invalid tokens only)
        const retryableTokens = failedTokens
          .filter(({ error }) => !this.isInvalidTokenError(error))
          .map(({ token }) => token);

        if (retryableTokens.length > 0) {
          await this.queueRetryNotification(userId, message, retryableTokens);
        }
      }

      return response;

    } catch (error) {
      logger.error('Error sending to multiple tokens:', error);
      throw error;
    }
  }

  /**
   * Prepare message payload
   * @private
   */
  async prepareMessage(notification, userId, options = {}) {
    const { type, title, body, data = {}, priority = NOTIFICATION_PRIORITY.NORMAL } = notification;

    // Get unread count for badge
    const unreadCount = await this.getUnreadCount(userId);

    // Base message
    const message = {
      notification: {
        title: title.substring(0, 100), // FCM title limit
        body: body.substring(0, 500),   // FCM body limit
      },
      data: {
        ...data,
        notificationId: notification._id?.toString() || '',
        type,
        userId,
        timestamp: new Date().toISOString(),
        // Convert all data values to strings (FCM requirement)
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [
            key, 
            typeof value === 'string' ? value : JSON.stringify(value)
          ])
        ),
      },
    };

    // Platform-specific configurations
    message.android = {
      ...this.defaultOptions.android,
      priority: priority === NOTIFICATION_PRIORITY.HIGH ? 'high' : 'normal',
      notification: {
        ...this.defaultOptions.android.notification,
        ...this.getAndroidNotificationConfig(type),
      },
    };

    message.apns = {
      ...this.defaultOptions.apns,
      headers: {
        ...this.defaultOptions.apns.headers,
        'apns-priority': priority === NOTIFICATION_PRIORITY.HIGH ? '10' : '5',
      },
      payload: {
        ...this.defaultOptions.apns.payload,
        aps: {
          ...this.defaultOptions.apns.payload.aps,
          badge: unreadCount,
          ...this.getApnsPayload(type),
        },
      },
    };

    message.webpush = {
      ...this.defaultOptions.webpush,
      notification: {
        ...this.defaultOptions.webpush.notification,
        ...this.getWebPushConfig(type),
      },
    };

    // Apply custom options
    if (options.android) {
      message.android = { ...message.android, ...options.android };
    }
    if (options.apns) {
      message.apns = { ...message.apns, ...options.apns };
    }
    if (options.webpush) {
      message.webpush = { ...message.webpush, ...options.webpush };
    }

    return message;
  }

  /**
   * Get Android-specific notification config
   * @private
   */
  getAndroidNotificationConfig(type) {
    const configs = {
      [NOTIFICATION_TYPES.NEW_MATCH]: {
        icon: 'ic_match',
        color: '#FF4458',
        channelId: 'matches',
        sound: 'match_sound',
      },
      [NOTIFICATION_TYPES.NEW_MESSAGE]: {
        icon: 'ic_message',
        color: '#FF4458',
        channelId: 'messages',
        sound: 'message_sound',
      },
      [NOTIFICATION_TYPES.SUPER_LIKE]: {
        icon: 'ic_super_like',
        color: '#03DAC6',
        channelId: 'super_likes',
        sound: 'super_like_sound',
      },
      [NOTIFICATION_TYPES.LIKES_YOU]: {
        icon: 'ic_like',
        color: '#FF4458',
        channelId: 'likes',
        sound: 'default',
      },
    };

    return configs[type] || {
      icon: 'ic_notification',
      color: '#FF4458',
      channelId: 'default',
      sound: 'default',
    };
  }

  /**
   * Get APNS-specific payload
   * @private
   */
  getApnsPayload(type) {
    const payloads = {
      [NOTIFICATION_TYPES.NEW_MATCH]: {
        sound: 'match.caf',
        category: 'MATCH',
        'thread-id': 'matches',
      },
      [NOTIFICATION_TYPES.NEW_MESSAGE]: {
        sound: 'message.caf',
        category: 'MESSAGE',
        'thread-id': 'messages',
      },
      [NOTIFICATION_TYPES.SUPER_LIKE]: {
        sound: 'super_like.caf',
        category: 'SUPER_LIKE',
        'thread-id': 'super_likes',
      },
    };

    return payloads[type] || {
      sound: 'default',
      category: 'GENERAL',
    };
  }

  /**
   * Get WebPush-specific config
   * @private
   */
  getWebPushConfig(type) {
    const configs = {
      [NOTIFICATION_TYPES.NEW_MATCH]: {
        icon: '/icons/match-icon.png',
        badge: '/icons/match-badge.png',
        tag: 'match',
        requireInteraction: true,
      },
      [NOTIFICATION_TYPES.NEW_MESSAGE]: {
        icon: '/icons/message-icon.png',
        badge: '/icons/message-badge.png',
        tag: 'message',
        requireInteraction: false,
      },
    };

    return configs[type] || {
      icon: '/icons/default-icon.png',
      badge: '/icons/default-badge.png',
      requireInteraction: false,
    };
  }

  /**
   * Get user's FCM tokens
   * @private
   */
  async getUserFCMTokens(userId) {
    try {
      // Try cache first
      const cacheKey = `user:${userId}:fcm_tokens`;
      const cachedTokens = await CacheService.get(cacheKey);
      
      if (cachedTokens) {
        return JSON.parse(cachedTokens);
      }

      // Get from database
      const User = (await import('../../modules/user/user.model.js')).default;
      const user = await User.findById(userId).select('devices.fcmTokens');
      
      if (!user || !user.devices?.fcmTokens) {
        return [];
      }

      const tokens = user.devices.fcmTokens
        .filter(tokenData => tokenData.isActive && tokenData.token)
        .map(tokenData => tokenData.token);

      // Cache for 30 minutes
      await CacheService.set(cacheKey, JSON.stringify(tokens), 1800);

      return tokens;

    } catch (error) {
      logger.error(`Error getting FCM tokens for user ${userId}:`, error);
      return [];
    }
  }

  /**
   * Remove invalid FCM tokens
   * @private
   */
  async removeInvalidTokens(userId, invalidTokens) {
    try {
      if (!invalidTokens || invalidTokens.length === 0) return;

      const User = (await import('../../modules/user/user.model.js')).default;
      
      await User.findByIdAndUpdate(userId, {
        $pull: {
          'devices.fcmTokens': {
            token: { $in: invalidTokens },
          },
        },
      });

      // Clear cache
      const cacheKey = `user:${userId}:fcm_tokens`;
      await CacheService.delete(cacheKey);

      logger.info(`Removed ${invalidTokens.length} invalid FCM tokens for user ${userId}`);

      // Track metrics
      await MetricsService.incrementCounter('push.tokens.removed', invalidTokens.length, {
        userId,
        reason: 'invalid',
      });

    } catch (error) {
      logger.error(`Error removing invalid tokens for user ${userId}:`, error);
    }
  }

  /**
   * Check if error indicates invalid token
   * @private
   */
  isInvalidTokenError(error) {
    if (!error) return false;
    
    const invalidTokenCodes = [
      'messaging/invalid-registration-token',
      'messaging/registration-token-not-registered',
      'messaging/invalid-argument',
    ];

    return invalidTokenCodes.includes(error.code);
  }

  /**
   * Queue notification for retry
   * @private
   */
  async queueRetryNotification(userId, message, tokens) {
    try {
      await QueueService.addJob('push-notifications', {
        userId,
        message,
        tokens,
        isRetry: true,
      }, {
        delay: 60000, // Retry after 1 minute
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000,
        },
      });

      logger.debug(`Queued ${tokens.length} tokens for retry for user ${userId}`);

    } catch (error) {
      logger.error('Error queuing retry notification:', error);
    }
  }

  /**
   * Process push notification job from queue
   * @private
   */
  async processPushJob(jobData) {
    try {
      const { userId, message, tokens, isRetry = false } = jobData;

      if (tokens && tokens.length > 0) {
        // Retry with specific tokens
        return await this.sendToMultipleTokens(tokens, message, userId);
      } else {
        // Regular notification
        return await this.sendPushNotification(userId, message);
      }

    } catch (error) {
      logger.error('Error processing push job:', error);
      throw error;
    }
  }

  /**
   * Get unread count for badge
   * @private
   */
  async getUnreadCount(userId) {
    try {
      // Try cache first
      const cacheKey = `user:${userId}:unread_count`;
      const cachedCount = await CacheService.get(cacheKey);
      
      if (cachedCount !== null) {
        return parseInt(cachedCount);
      }

      // Get from notification service
      const Notification = (await import('../notification/notification.model.js')).default;
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
   * Track push notification metrics
   * @private
   */
  async trackPushMetrics(userId, notificationType, response, processingTime) {
    try {
      await Promise.all([
        MetricsService.incrementCounter('push.notifications.sent', response.successCount, {
          type: notificationType,
          platform: 'all',
        }),
        MetricsService.incrementCounter('push.notifications.failed', response.failureCount, {
          type: notificationType,
          platform: 'all',
        }),
        MetricsService.recordHistogram('push.notifications.processing_time', processingTime, {
          type: notificationType,
        }),
        MetricsService.trackUserAction(userId, 'push_notification_sent', {
          type: notificationType,
          success: response.successCount > 0,
          successCount: response.successCount,
          failureCount: response.failureCount,
        }),
      ]);

    } catch (error) {
      logger.error('Error tracking push metrics:', error);
    }
  }

  /**
   * Send test push notification
   * @param {string} userId - User ID
   */
  async sendTestPushNotification(userId) {
    return this.sendPushNotification(userId, {
      type: NOTIFICATION_TYPES.SYSTEM,
      title: 'Test Push Notification',
      body: 'This is a test push notification to verify your device settings.',
      data: {
        test: true,
        timestamp: new Date().toISOString(),
      },
      priority: NOTIFICATION_PRIORITY.NORMAL,
    });
  }

  /**
   * Get push notification statistics
   */
  async getPushStats(dateRange = {}) {
    try {
      const { start, end } = dateRange;
      const timeFilter = {};
      
      if (start || end) {
        timeFilter.timestamp = {};
        if (start) timeFilter.timestamp.$gte = start;
        if (end) timeFilter.timestamp.$lte = end;
      }

      const stats = await MetricsService.getMetricStats('push.notifications.sent', timeFilter);
      
      return {
        totalSent: stats.total || 0,
        successRate: stats.successRate || 0,
        averageProcessingTime: stats.averageProcessingTime || 0,
        byType: stats.byType || {},
        byPlatform: stats.byPlatform || {},
      };

    } catch (error) {
      logger.error('Error getting push stats:', error);
      return {
        totalSent: 0,
        successRate: 0,
        averageProcessingTime: 0,
        byType: {},
        byPlatform: {},
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      if (!this.initialized) {
        return { status: 'unhealthy', error: 'Service not initialized' };
      }

      // Test Firebase connection
      await admin.messaging().send({
        token: 'dummy-token',
        notification: { title: 'Health Check', body: 'Test' },
      }, true); // dry run

      return { status: 'healthy', initialized: this.initialized };

    } catch (error) {
      if (!error.message.includes('dummy-token')) {
        return { status: 'unhealthy', error: error.message };
      }
      return { status: 'healthy', initialized: this.initialized };
    }
  }
}

export default new PushNotificationService();