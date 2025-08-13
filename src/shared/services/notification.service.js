// src/shared/services/notification.service.js
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../utils/logger.js';
import { NOTIFICATION_TYPES } from '../../config/constants.js';
import QueueService from './queue.service.js';

class NotificationService {
  constructor() {
    this.firebaseApp = null;
    this.emailTransporter = null;
    this.initialized = false;
  }

  /**
   * Initialize notification services
   */
  async initialize() {
    try {
      // Initialize Firebase Admin SDK for push notifications
      if (process.env.FIREBASE_PROJECT_ID) {
        this.firebaseApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
          }),
        });
        logger.info('✅ Firebase Admin SDK initialized');
      } else {
        logger.warn('Firebase credentials not configured. Push notifications disabled.');
      }

      // Initialize email transporter
      if (process.env.SMTP_HOST) {
        this.emailTransporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
          },
        });

        // Verify email configuration
        await this.emailTransporter.verify();
        logger.info('✅ Email transporter configured');
      } else if (process.env.SENDGRID_API_KEY) {
        // Alternative: Use SendGrid
        const sgMail = await import('@sendgrid/mail');
        sgMail.default.setApiKey(process.env.SENDGRID_API_KEY);
        this.emailTransporter = sgMail.default;
        logger.info('✅ SendGrid configured for email');
      } else {
        logger.warn('Email configuration not found. Email notifications disabled.');
      }

      // Register queue handlers
      QueueService.registerHandler('notifications', this.processNotification.bind(this));
      QueueService.registerHandler('emails', this.processEmail.bind(this));

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
   * @param {Object} notification - Notification data
   */
  async sendNotification(userId, notification) {
    try {
      const { type, title, body, data = {}, priority = 'normal' } = notification;

      // Store notification in database
      const notificationDoc = await this.storeNotification(userId, {
        type,
        title,
        body,
        data,
        priority,
        read: false,
        createdAt: new Date(),
      });

      // Send through different channels based on user preferences
      const userPreferences = await this.getUserNotificationPreferences(userId);

      // Real-time notification via Socket.io
      if (userPreferences.inApp) {
        await this.sendInAppNotification(userId, notificationDoc);
      }

      // Push notification
      if (userPreferences.push) {
        await QueueService.addJob('notifications', {
          userId,
          notification: notificationDoc,
          channel: 'push',
        }, { priority: priority === 'high' ? 10 : 0 });
      }

      // Email notification (for important notifications)
      if (userPreferences.email && this.shouldSendEmail(type)) {
        await QueueService.addJob('emails', {
          userId,
          notification: notificationDoc,
        }, { delay: 300000 }); // 5 minute delay to batch emails
      }

      return notificationDoc;
    } catch (error) {
      logger.error(`Error sending notification to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Send bulk notifications
   * @param {Array} userIds - Array of user IDs
   * @param {Object} notification - Notification data
   */
  async sendBulkNotifications(userIds, notification) {
    try {
      const results = {
        success: [],
        failed: [],
      };

      // Batch process notifications
      const batchSize = 100;
      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize);
        
        const promises = batch.map(userId =>
          this.sendNotification(userId, notification)
            .then(() => results.success.push(userId))
            .catch(error => {
              logger.error(`Failed to send notification to ${userId}:`, error);
              results.failed.push({ userId, error: error.message });
            })
        );

        await Promise.all(promises);
      }

      logger.info(`Sent bulk notifications: ${results.success.length} success, ${results.failed.length} failed`);
      return results;
    } catch (error) {
      logger.error('Error sending bulk notifications:', error);
      throw error;
    }
  }

  /**
   * Send in-app notification via Socket.io
   * @private
   */
  async sendInAppNotification(userId, notification) {
    try {
      // Emit to user's socket
      socketManager.emitToUser(userId, 'notification:new', notification);
      
      // Update unread count
      const unreadCount = await this.getUnreadCount(userId);
      socketManager.emitToUser(userId, 'notification:unread', { count: unreadCount });
      
      logger.debug(`In-app notification sent to user ${userId}`);
    } catch (error) {
      logger.error(`Error sending in-app notification to ${userId}:`, error);
    }
  }

  /**
   * Send push notification
   * @param {string} userId - User ID
   * @param {Object} notification - Notification data
   */
  async sendPushNotification(userId, notification) {
    try {
      if (!this.firebaseApp) {
        logger.warn('Firebase not initialized. Cannot send push notification.');
        return;
      }

      // Get user's FCM tokens
      const tokens = await this.getUserFCMTokens(userId);
      if (!tokens || tokens.length === 0) {
        logger.debug(`No FCM tokens found for user ${userId}`);
        return;
      }

      // Prepare message
      const message = {
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: {
          ...notification.data,
          notificationId: notification._id?.toString() || '',
          type: notification.type,
          userId: userId,
        },
        android: {
          priority: notification.priority === 'high' ? 'high' : 'normal',
          notification: {
            sound: 'default',
            clickAction: 'FLUTTER_NOTIFICATION_CLICK',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: await this.getUnreadCount(userId),
            },
          },
        },
      };

      // Send to all user's devices
      const response = await admin.messaging().sendMulticast({
        ...message,
        tokens,
      });

      // Handle failed tokens
      if (response.failureCount > 0) {
        const failedTokens = [];
        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            failedTokens.push(tokens[idx]);
            logger.error(`Failed to send to token ${tokens[idx]}:`, resp.error);
          }
        });
        
        // Remove invalid tokens
        await this.removeInvalidTokens(userId, failedTokens);
      }

      logger.info(`Push notification sent to user ${userId}: ${response.successCount}/${tokens.length} successful`);
      return response;
    } catch (error) {
      logger.error(`Error sending push notification to ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Send email notification
   * @param {string} userId - User ID
   * @param {Object} notification - Notification data
   */
  async sendEmailNotification(userId, notification) {
    try {
      if (!this.emailTransporter) {
        logger.warn('Email transporter not configured. Cannot send email.');
        return;
      }

      // Get user email and preferences
      const user = await this.getUserEmailInfo(userId);
      if (!user || !user.email) {
        logger.debug(`No email found for user ${userId}`);
        return;
      }

      // Prepare email content
      const emailContent = this.prepareEmailContent(notification, user);

      let result;
      if (process.env.SENDGRID_API_KEY) {
        // SendGrid
        result = await this.emailTransporter.send({
          to: user.email,
          from: process.env.FROM_EMAIL || 'noreply@tinderclone.com',
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      } else {
        // SMTP
        result = await this.emailTransporter.sendMail({
          from: process.env.FROM_EMAIL || 'noreply@tinderclone.com',
          to: user.email,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
        });
      }

      logger.info(`Email sent to ${user.email} for user ${userId}`);
      return result;
    } catch (error) {
      logger.error(`Error sending email to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Process notification from queue
   * @private
   */
  async processNotification(jobData) {
    const { userId, notification, channel } = jobData;

    switch (channel) {
      case 'push':
        await this.sendPushNotification(userId, notification);
        break;
      case 'email':
        await this.sendEmailNotification(userId, notification);
        break;
      case 'sms':
        await this.sendSMSNotification(userId, notification);
        break;
      default:
        logger.warn(`Unknown notification channel: ${channel}`);
    }
  }

  /**
   * Process email from queue
   * @private
   */
  async processEmail(jobData) {
    const { userId, notification } = jobData;
    await this.sendEmailNotification(userId, notification);
  }

  /**
   * Prepare email content based on notification type
   * @private
   */
  prepareEmailContent(notification, user) {
    const templates = {
      [NOTIFICATION_TYPES.NEW_MATCH]: {
        subject: '🎉 You have a new match!',
        text: `Hi ${user.name}, ${notification.body}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #FF4458;">You have a new match!</h2>
            <p>Hi ${user.name},</p>
            <p>${notification.body}</p>
            <a href="${process.env.APP_URL}/matches" style="display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px;">View Match</a>
          </div>
        `
      },
      [NOTIFICATION_TYPES.NEW_MESSAGE]: {
        subject: '💬 New message',
        text: `Hi ${user.name}, ${notification.body}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #FF4458;">New Message</h2>
            <p>Hi ${user.name},</p>
            <p>${notification.body}</p>
            <a href="${process.env.APP_URL}/chat" style="display: inline-block; padding: 12px 24px; background-color: #FF4458; color: white; text-decoration: none; border-radius: 25px;">Read Message</a>
          </div>
        `
      },
      [NOTIFICATION_TYPES.SUPER_LIKE]: {
        subject: '⭐ Someone Super Liked you!',
        text: `Hi ${user.name}, ${notification.body}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #44D362;">Someone Super Liked You!</h2>
            <p>Hi ${user.name},</p>
            <p>${notification.body}</p>
            <a href="${process.env.APP_URL}" style="display: inline-block; padding: 12px 24px; background-color: #44D362; color: white; text-decoration: none; border-radius: 25px;">See Who</a>
          </div>
        `
      },
    };

    const template = templates[notification.type] || {
      subject: notification.title,
      text: notification.body,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>${notification.title}</h2>
          <p>${notification.body}</p>
        </div>
      `
    };

    return template;
  }

  /**
   * Store notification in database
   * @private
   */
  async storeNotification(userId, notification) {
    try {
      // This would typically save to MongoDB
      // For now, we'll store in Redis with TTL
      const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const notificationDoc = {
        _id: notificationId,
        userId,
        ...notification,
        createdAt: new Date().toISOString(),
      };

      // Store in Redis
      const key = `notifications:${userId}:${notificationId}`;
      await redis.set(key, JSON.stringify(notificationDoc), 86400 * 30); // 30 days

      // Add to user's notification list
      await redis.zadd(
        `user:${userId}:notifications`,
        Date.now(),
        notificationId
      );

      // Increment unread count if not read
      if (!notification.read) {
        await redis.incr(`user:${userId}:notifications:unread`);
      }

      return notificationDoc;
    } catch (error) {
      logger.error('Error storing notification:', error);
      throw error;
    }
  }

  /**
   * Get user's notification preferences
   * @private
   */
  async getUserNotificationPreferences(userId) {
    try {
      const key = `user:${userId}:preferences:notifications`;
      const preferences = await redis.get(key);
      
      if (preferences) {
        return JSON.parse(preferences);
      }

      // Default preferences
      return {
        inApp: true,
        push: true,
        email: true,
        sms: false,
        newMatch: true,
        newMessage: true,
        superLike: true,
        profileLiked: false,
      };
    } catch (error) {
      logger.error(`Error getting notification preferences for ${userId}:`, error);
      return {
        inApp: true,
        push: true,
        email: false,
        sms: false,
      };
    }
  }

  /**
   * Update notification preferences
   * @param {string} userId - User ID
   * @param {Object} preferences - Notification preferences
   */
  async updateNotificationPreferences(userId, preferences) {
    try {
      const key = `user:${userId}:preferences:notifications`;
      await redis.set(key, JSON.stringify(preferences), 86400 * 365); // 1 year
      logger.debug(`Updated notification preferences for user ${userId}`);
    } catch (error) {
      logger.error(`Error updating notification preferences for ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get user's FCM tokens
   * @private
   */
  async getUserFCMTokens(userId) {
    try {
      const key = `user:${userId}:fcm:tokens`;
      const tokens = await redis.smembers(key);
      return tokens;
    } catch (error) {
      logger.error(`Error getting FCM tokens for ${userId}:`, error);
      return [];
    }
  }

  /**
   * Register FCM token for user
   * @param {string} userId - User ID
   * @param {string} token - FCM token
   * @param {Object} deviceInfo - Device information
   */
  async registerFCMToken(userId, token, deviceInfo = {}) {
    try {
      // Add token to user's token set
      await redis.sadd(`user:${userId}:fcm:tokens`, token);
      
      // Store device info
      await redis.hset(
        `user:${userId}:devices`,
        token,
        JSON.stringify({
          ...deviceInfo,
          registeredAt: new Date().toISOString(),
        })
      );

      logger.debug(`FCM token registered for user ${userId}`);
    } catch (error) {
      logger.error(`Error registering FCM token for ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Remove invalid FCM tokens
   * @private
   */
  async removeInvalidTokens(userId, tokens) {
    try {
      if (tokens.length === 0) return;

      const key = `user:${userId}:fcm:tokens`;
      await redis.srem(key, ...tokens);
      
      // Remove device info
      const deviceKey = `user:${userId}:devices`;
      for (const token of tokens) {
        await redis.hdel(deviceKey, token);
      }

      logger.debug(`Removed ${tokens.length} invalid tokens for user ${userId}`);
    } catch (error) {
      logger.error(`Error removing invalid tokens for ${userId}:`, error);
    }
  }

  /**
   * Get user email info
   * @private
   */
  async getUserEmailInfo(userId) {
    try {
      // This would typically fetch from database
      // For now, we'll get from cache
      const key = `user:profile:${userId}`;
      const user = await redis.get(key);
      return user ? JSON.parse(user) : null;
    } catch (error) {
      logger.error(`Error getting user email info for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Get unread notification count
   * @param {string} userId - User ID
   * @returns {Promise<number>} - Unread count
   */
  async getUnreadCount(userId) {
    try {
      const count = await redis.get(`user:${userId}:notifications:unread`);
      return parseInt(count) || 0;
    } catch (error) {
      logger.error(`Error getting unread count for ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Mark notification as read
   * @param {string} userId - User ID
   * @param {string} notificationId - Notification ID
   */
  async markAsRead(userId, notificationId) {
    try {
      const key = `notifications:${userId}:${notificationId}`;
      const notification = await redis.get(key);
      
      if (notification) {
        const doc = JSON.parse(notification);
        doc.read = true;
        doc.readAt = new Date().toISOString();
        
        await redis.set(key, JSON.stringify(doc), 86400 * 30);
        
        // Decrement unread count
        const unreadKey = `user:${userId}:notifications:unread`;
        const count = await redis.get(unreadKey);
        if (count && parseInt(count) > 0) {
          await redis.decr(unreadKey);
        }
        
        // Emit update via socket
        const newCount = await this.getUnreadCount(userId);
        socketManager.emitToUser(userId, 'notification:read', {
          notificationId,
          unreadCount: newCount,
        });
      }
    } catch (error) {
      logger.error(`Error marking notification as read:`, error);
      throw error;
    }
  }

  /**
   * Mark all notifications as read
   * @param {string} userId - User ID
   */
  async markAllAsRead(userId) {
    try {
      // Reset unread count
      await redis.set(`user:${userId}:notifications:unread`, '0');
      
      // Update all notifications
      const notificationIds = await redis.zrange(`user:${userId}:notifications`, 0, -1);
      
      const pipeline = redis.client.pipeline();
      for (const notifId of notificationIds) {
        const key = `notifications:${userId}:${notifId}`;
        const notification = await redis.get(key);
        if (notification) {
          const doc = JSON.parse(notification);
          doc.read = true;
          doc.readAt = new Date().toISOString();
          pipeline.set(key, JSON.stringify(doc), 86400 * 30);
        }
      }
      await pipeline.exec();
      
      // Emit update
      socketManager.emitToUser(userId, 'notification:all:read', {
        unreadCount: 0,
      });
      
      logger.debug(`Marked all notifications as read for user ${userId}`);
    } catch (error) {
      logger.error(`Error marking all notifications as read:`, error);
      throw error;
    }
  }

  /**
   * Get user notifications
   * @param {string} userId - User ID
   * @param {Object} options - Query options
   */
  async getUserNotifications(userId, options = {}) {
    try {
      const { limit = 20, offset = 0, unreadOnly = false } = options;
      
      // Get notification IDs
      const notificationIds = await redis.zrevrange(
        `user:${userId}:notifications`,
        offset,
        offset + limit - 1
      );
      
      // Get notification details
      const notifications = [];
      for (const notifId of notificationIds) {
        const key = `notifications:${userId}:${notifId}`;
        const notification = await redis.get(key);
        if (notification) {
          const doc = JSON.parse(notification);
          if (!unreadOnly || !doc.read) {
            notifications.push(doc);
          }
        }
      }
      
      return {
        notifications,
        total: await redis.zcard(`user:${userId}:notifications`),
        unread: await this.getUnreadCount(userId),
      };
    } catch (error) {
      logger.error(`Error getting notifications for ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Delete notification
   * @param {string} userId - User ID
   * @param {string} notificationId - Notification ID
   */
  async deleteNotification(userId, notificationId) {
    try {
      // Remove from sorted set
      await redis.zrem(`user:${userId}:notifications`, notificationId);
      
      // Get notification to check if unread
      const key = `notifications:${userId}:${notificationId}`;
      const notification = await redis.get(key);
      
      if (notification) {
        const doc = JSON.parse(notification);
        if (!doc.read) {
          // Decrement unread count
          const unreadKey = `user:${userId}:notifications:unread`;
          const count = await redis.get(unreadKey);
          if (count && parseInt(count) > 0) {
            await redis.decr(unreadKey);
          }
        }
      }
      
      // Delete notification
      await redis.del(key);
      
      logger.debug(`Deleted notification ${notificationId} for user ${userId}`);
    } catch (error) {
      logger.error(`Error deleting notification:`, error);
      throw error;
    }
  }

  /**
   * Check if should send email for notification type
   * @private
   */
  shouldSendEmail(type) {
    const emailTypes = [
      NOTIFICATION_TYPES.NEW_MATCH,
      NOTIFICATION_TYPES.SUPER_LIKE,
      NOTIFICATION_TYPES.SUBSCRIPTION_EXPIRING,
    ];
    return emailTypes.includes(type);
  }

  /**
   * Send test notification
   * @param {string} userId - User ID
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
      priority: 'normal',
    });
  }
}

export default new NotificationService();