// src/modules/notification/notification.service.js
import mongoose from 'mongoose';
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';
import twilio from 'twilio';
import Notification from './notification.model.js';
import User from '../user/user.model.js';
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../../shared/utils/logger.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorTypes.js';
import { NOTIFICATION_TYPES, NOTIFICATION_PRIORITIES } from '../../config/constants.js';
import CacheService from '../../shared/services/cache.service.js';
import QueueService from '../../shared/services/queue.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import { emailTemplates } from '../../config/emailTemplates.js';

class NotificationService {
 constructor() {
   this.firebaseApp = null;
   this.emailTransporter = null;
   this.twilioClient = null;
   this.initialized = false;
   this.templates = new Map();
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

     // Initialize Twilio for SMS
     if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
       this.twilioClient = twilio(
         process.env.TWILIO_ACCOUNT_SID,
         process.env.TWILIO_AUTH_TOKEN
       );
       logger.info('✅ Twilio SMS service initialized');
     } else {
       logger.warn('Twilio credentials not configured. SMS notifications disabled.');
     }

     // Load notification templates
     await this.loadTemplates();

     this.initialized = true;
     logger.info('✅ Notification service fully initialized');
   } catch (error) {
     logger.error('Failed to initialize notification service:', error);
     throw error;
   }
 }

 /**
  * Load notification templates
  */
 async loadTemplates() {
   // Load templates from database or config
   // This can be extended to load from a CMS or database
   this.templates.set('NEW_MATCH', {
     title: 'New Match! 🎉',
     body: 'You have a new match with {{userName}}!',
     push: true,
     email: true,
     inApp: true,
   });

   this.templates.set('NEW_MESSAGE', {
     title: 'New Message 💬',
     body: '{{senderName}}: {{messagePreview}}',
     push: true,
     inApp: true,
   });

   this.templates.set('SUPER_LIKE', {
     title: 'Someone Super Liked You! ⭐',
     body: '{{userName}} super liked your profile!',
     push: true,
     email: false,
     inApp: true,
   });
 }

 /**
  * Send notification to user
  * @param {string} userId - Recipient user ID
  * @param {Object} notificationData - Notification data
  * @returns {Promise<Notification>}
  */
 async sendNotification(userId, notificationData) {
   const session = await mongoose.startSession();
   session.startTransaction();

   try {
     // Validate user and get preferences
     const user = await User.findById(userId)
       .select('deviceTokens email phone notificationPreferences profile')
       .session(session);

     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check user notification preferences
     const preferences = user.notificationPreferences || {};
     const type = notificationData.type;

     // Create notification document
     const notification = new Notification({
       recipient: userId,
       sender: notificationData.senderId,
       type: notificationData.type,
       category: notificationData.category,
       title: notificationData.title,
       body: notificationData.body,
       media: notificationData.media,
       action: notificationData.action,
       relatedEntities: notificationData.relatedEntities,
       priority: notificationData.priority || 'normal',
       scheduledFor: notificationData.scheduledFor,
       expiresAt: notificationData.expiresAt,
       groupId: notificationData.groupId,
       data: notificationData.data,
       locale: user.profile?.language || 'en',
     });

     await notification.save({ session });

     // Queue delivery based on priority
     const jobPriority = this.getJobPriority(notification.priority);
     
     await QueueService.addJob(
       'notification_delivery',
       {
         notificationId: notification._id.toString(),
         userId: userId,
         channels: this.determineChannels(type, preferences, notificationData),
       },
       {
         priority: jobPriority,
         delay: notificationData.scheduledFor 
           ? new Date(notificationData.scheduledFor) - new Date() 
           : 0,
         attempts: 3,
         backoff: {
           type: 'exponential',
           delay: 2000,
         },
       }
     );

     await session.commitTransaction();

     // Track metrics
     await MetricsService.incrementCounter('notifications.created');
     await MetricsService.trackUserAction(userId, 'notification_sent', {
       type: notification.type,
       category: notification.category,
     });

     // Update cache
     await this.updateNotificationCache(userId);

     // Emit real-time event for in-app notifications
     if (preferences.inApp !== false) {
       this.emitRealtimeNotification(userId, notification);
     }

     logger.info(`Notification created for user ${userId}:`, {
       notificationId: notification._id,
       type: notification.type,
     });

     return notification;
   } catch (error) {
     await session.abortTransaction();
     logger.error(`Error sending notification to user ${userId}:`, error);
     throw error;
   } finally {
     session.endSession();
   }
 }

 /**
  * Send bulk notifications
  * @param {Array} notifications - Array of notification objects
  * @returns {Promise<Object>}
  */
 async sendBulkNotifications(notifications) {
   const results = {
     success: [],
     failed: [],
     total: notifications.length,
   };

   try {
     // Group notifications by priority for efficient queuing
     const grouped = this.groupByPriority(notifications);

     for (const [priority, group] of Object.entries(grouped)) {
       const bulkJobs = group.map(notif => ({
         name: 'notification_delivery',
         data: {
           userId: notif.userId,
           notificationData: notif,
         },
         opts: {
           priority: this.getJobPriority(priority),
           attempts: 3,
         },
       }));

       await QueueService.addBulkJobs(bulkJobs);
       results.success.push(...group.map(n => n.userId));
     }

     // Track metrics
     await MetricsService.incrementCounter('notifications.bulk_sent', results.success.length);

     logger.info(`Bulk notifications sent: ${results.success.length}/${results.total}`);
     return results;
   } catch (error) {
     logger.error('Error sending bulk notifications:', error);
     throw error;
   }
 }

 /**
  * Process notification delivery (called by queue worker)
  * @param {Object} job - Queue job data
  */
 async processNotificationDelivery(job) {
   const { notificationId, userId, channels } = job.data;

   try {
     const notification = await Notification.findById(notificationId)
       .populate('sender', 'name avatar');

     if (!notification) {
       throw new Error('Notification not found');
     }

     const user = await User.findById(userId)
       .select('deviceTokens email phone profile');

     const deliveryResults = {};

     // Send to each channel
     if (channels.push && user.deviceTokens?.length > 0) {
       deliveryResults.push = await this.sendPushNotification(user, notification);
     }

     if (channels.email && user.email) {
       deliveryResults.email = await this.sendEmailNotification(user, notification);
     }

     if (channels.sms && user.phone?.verified) {
       deliveryResults.sms = await this.sendSMSNotification(user, notification);
     }

     if (channels.inApp) {
       deliveryResults.inApp = await this.sendInAppNotification(user, notification);
     }

     // Update notification with delivery results
     await this.updateDeliveryStatus(notificationId, deliveryResults);

     // Track metrics
     await MetricsService.incrementCounter('notifications.delivered');
     
     return deliveryResults;
   } catch (error) {
     logger.error(`Failed to deliver notification ${notificationId}:`, error);
     
     // Update retry count
     await Notification.findByIdAndUpdate(notificationId, {
       $inc: { 'metadata.retryCount': 1 },
       $set: { 'metadata.lastRetryAt': new Date() },
     });

     throw error;
   }
 }

 /**
  * Send push notification via FCM
  * @param {Object} user - User object
  * @param {Object} notification - Notification object
  */
 async sendPushNotification(user, notification) {
   if (!this.firebaseApp || !user.deviceTokens?.length) {
     return { sent: false, error: 'No device tokens or FCM not configured' };
   }

   try {
     const message = {
       notification: {
         title: notification.title,
         body: notification.body,
         ...(notification.media?.imageUrl && { imageUrl: notification.media.imageUrl }),
       },
       data: {
         notificationId: notification._id.toString(),
         type: notification.type,
         ...(notification.action?.target && { action: notification.action.target }),
         ...notification.data,
       },
       android: {
         priority: this.getFCMPriority(notification.priority),
         notification: {
           sound: 'default',
           clickAction: 'FLUTTER_NOTIFICATION_CLICK',
           ...(notification.media?.icon && { icon: notification.media.icon }),
         },
       },
       apns: {
         payload: {
           aps: {
             sound: 'default',
             badge: await this.getUnreadCount(user._id),
             contentAvailable: true,
           },
         },
       },
       tokens: user.deviceTokens,
     };

     const response = await admin.messaging().sendMulticast(message);

     // Handle failed tokens
     if (response.failureCount > 0) {
       const failedTokens = [];
       response.responses.forEach((resp, idx) => {
         if (!resp.success) {
           failedTokens.push(user.deviceTokens[idx]);
           logger.warn(`Failed to send to token: ${resp.error?.message}`);
         }
       });

       // Remove invalid tokens
       if (failedTokens.length > 0) {
         await this.removeInvalidTokens(user._id, failedTokens);
       }
     }

     await notification.markAsDelivered('push');

     return {
       sent: true,
       successCount: response.successCount,
       failureCount: response.failureCount,
       messageId: response.responses[0]?.messageId,
     };
   } catch (error) {
     logger.error('Push notification error:', error);
     return { sent: false, error: error.message };
   }
 }

 /**
  * Send email notification
  * @param {Object} user - User object
  * @param {Object} notification - Notification object
  */
 async sendEmailNotification(user, notification) {
   if (!this.emailTransporter || !user.email) {
     return { sent: false, error: 'Email not configured or user has no email' };
   }

   try {
     // Get email template
     const template = await this.getEmailTemplate(notification.type);
     const html = this.renderEmailTemplate(template, {
       user,
       notification,
       unsubscribeUrl: `${process.env.APP_URL}/unsubscribe?token=${user._id}`,
     });

     const mailOptions = {
       from: process.env.EMAIL_FROM || 'noreply@datingapp.com',
       to: user.email,
       subject: notification.title,
       html,
       text: notification.body,
     };

     let result;
     if (this.emailTransporter.send) {
       // SendGrid
       result = await this.emailTransporter.send(mailOptions);
     } else {
       // Nodemailer
       result = await this.emailTransporter.sendMail(mailOptions);
     }

     await notification.markAsDelivered('email');

     return {
       sent: true,
       messageId: result.messageId || result[0]?.messageId,
     };
   } catch (error) {
     logger.error('Email notification error:', error);
     return { sent: false, error: error.message };
   }
 }

 /**
  * Send SMS notification
  * @param {Object} user - User object
  * @param {Object} notification - Notification object
  */
 async sendSMSNotification(user, notification) {
   if (!this.twilioClient || !user.phone?.number) {
     return { sent: false, error: 'SMS not configured or user has no phone' };
   }

   try {
     // Only send SMS for high priority notifications
     if (notification.priority !== 'high' && notification.priority !== 'urgent') {
       return { sent: false, error: 'SMS only for high priority' };
     }

     const message = await this.twilioClient.messages.create({
       body: `${notification.title}\n${notification.body}`,
       from: process.env.TWILIO_PHONE_NUMBER,
       to: user.phone.number,
     });

     await notification.markAsDelivered('sms');

     return {
       sent: true,
       messageId: message.sid,
     };
   } catch (error) {
     logger.error('SMS notification error:', error);
     return { sent: false, error: error.message };
   }
 }

 /**
  * Send in-app notification
  * @param {Object} user - User object
  * @param {Object} notification - Notification object
  */
 async sendInAppNotification(user, notification) {
   try {
     // Store in Redis for quick access
     const key = `notifications:${user._id}:unread`;
     await redis.zadd(key, Date.now(), notification._id.toString());
     await redis.expire(key, 86400 * 7); // 7 days

     // Emit socket event
     this.emitRealtimeNotification(user._id, notification);

     await notification.markAsDelivered('inApp');

     return { sent: true };
   } catch (error) {
     logger.error('In-app notification error:', error);
     return { sent: false, error: error.message };
   }
 }

 /**
  * Emit real-time notification via Socket.io
  * @param {string} userId - User ID
  * @param {Object} notification - Notification object
  */
 emitRealtimeNotification(userId, notification) {
   const io = socketManager.getIO();
   if (io) {
     io.to(`user:${userId}`).emit('notification:new', {
       _id: notification._id,
       type: notification.type,
       category: notification.category,
       title: notification.title,
       body: notification.body,
       media: notification.media,
       action: notification.action,
       sender: notification.sender ? {
         _id: notification.sender._id,
         name: notification.sender.name,
         avatar: notification.sender.avatar,
       } : null,
       createdAt: notification.createdAt,
     });

     // Update unread count
     this.emitUnreadCount(userId);
   }
 }

 /**
  * Emit unread count update
  * @param {string} userId - User ID
  */
 async emitUnreadCount(userId) {
   const count = await Notification.getUnreadCount(userId);
   const io = socketManager.getIO();
   
   if (io) {
     io.to(`user:${userId}`).emit('notification:unreadCount', count);
   }
 }

 /**
  * Get notifications for user
  * @param {string} userId - User ID
  * @param {Object} options - Query options
  */
 async getNotifications(userId, options = {}) {
   const {
     page = 1,
     limit = 20,
     category,
     unreadOnly = false,
     type,
   } = options;

   try {
     // Try to get from cache first
     const cacheKey = `notifications:${userId}:${page}:${limit}:${category || 'all'}`;
     const cached = await CacheService.get(cacheKey);
     
     if (cached) {
       return cached;
     }

     const query = {
       recipient: userId,
       isDeleted: false,
     };

     if (category) query.category = category;
     if (type) query.type = type;
     if (unreadOnly) query['status.read'] = false;

     const notifications = await Notification.find(query)
       .sort({ createdAt: -1 })
       .limit(limit)
       .skip((page - 1) * limit)
       .populate('sender', 'name avatar profile.bio')
       .lean();

     const total = await Notification.countDocuments(query);
     const unreadCount = await Notification.countDocuments({
       ...query,
       'status.read': false,
     });

     const result = {
       notifications,
       pagination: {
         page,
         limit,
         total,
         pages: Math.ceil(total / limit),
       },
       unreadCount,
     };

     // Cache for 5 minutes
     await CacheService.set(cacheKey, result, 300);

     return result;
   } catch (error) {
     logger.error(`Error getting notifications for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Mark notification as read
  * @param {string} notificationId - Notification ID
  * @param {string} userId - User ID
  */
 async markAsRead(notificationId, userId) {
   try {
     const notification = await Notification.findOne({
       _id: notificationId,
       recipient: userId,
     });

     if (!notification) {
       throw new AppError('Notification not found', 404, ERROR_CODES.NOT_FOUND);
     }

     const wasMarked = await notification.markAsRead(userId);

     if (wasMarked) {
       // Update cache
       await this.updateNotificationCache(userId);
       
       // Emit updated count
       await this.emitUnreadCount(userId);

       // Track metrics
       await MetricsService.incrementCounter('notifications.read');
     }

     return notification;
   } catch (error) {
     logger.error(`Error marking notification ${notificationId} as read:`, error);
     throw error;
   }
 }

 /**
  * Mark all notifications as read
  * @param {string} userId - User ID
  * @param {Object} filters - Optional filters
  */
 async markAllAsRead(userId, filters = {}) {
   try {
     const count = await Notification.markAllAsRead(userId, filters);

     // Clear cache
     await this.updateNotificationCache(userId);
     
     // Emit updated count
     await this.emitUnreadCount(userId);

     // Track metrics
     await MetricsService.incrementCounter('notifications.bulk_read', count);

     return { markedCount: count };
   } catch (error) {
     logger.error(`Error marking all notifications as read for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Delete notification
  * @param {string} notificationId - Notification ID
  * @param {string} userId - User ID
  */
 async deleteNotification(notificationId, userId) {
   try {
     const notification = await Notification.findOne({
       _id: notificationId,
       recipient: userId,
     });

     if (!notification) {
       throw new AppError('Notification not found', 404, ERROR_CODES.NOT_FOUND);
     }

     await notification.softDelete(userId);

     // Update cache
     await this.updateNotificationCache(userId);

     return { success: true };
   } catch (error) {
     logger.error(`Error deleting notification ${notificationId}:`, error);
     throw error;
   }
 }

 /**
  * Update notification preferences
  * @param {string} userId - User ID
  * @param {Object} preferences - New preferences
  */
 async updatePreferences(userId, preferences) {
   try {
     const user = await User.findByIdAndUpdate(
       userId,
       { notificationPreferences: preferences },
       { new: true, runValidators: true }
     );

     // Clear cache
     await CacheService.delete(`user:${userId}:preferences`);

     logger.info(`Updated notification preferences for user ${userId}`);
     return user.notificationPreferences;
   } catch (error) {
     logger.error(`Error updating preferences for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Register device token for push notifications
  * @param {string} userId - User ID
  * @param {string} token - Device token
  * @param {string} platform - Platform (ios/android)
  */
 async registerDeviceToken(userId, token, platform) {
   try {
     const user = await User.findById(userId);
     
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Add token if not exists
     if (!user.deviceTokens.includes(token)) {
       user.deviceTokens.push(token);
       
       // Keep only last 5 tokens
       if (user.deviceTokens.length > 5) {
         user.deviceTokens = user.deviceTokens.slice(-5);
       }

       await user.save();
     }

     // Track metrics
     await MetricsService.incrementCounter(`device_tokens.registered.${platform}`);

     logger.info(`Device token registered for user ${userId}`);
     return { success: true };
   } catch (error) {
     logger.error(`Error registering device token for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Remove device token
  * @param {string} userId - User ID
  * @param {string} token - Device token to remove
  */
 async removeDeviceToken(userId, token) {
   try {
     await User.findByIdAndUpdate(userId, {
       $pull: { deviceTokens: token },
     });

     logger.info(`Device token removed for user ${userId}`);
     return { success: true };
   } catch (error) {
     logger.error(`Error removing device token for user ${userId}:`, error);
     throw error;
   }
 }

 // Helper Methods

 /**
  * Determine which channels to use for notification
  */
 determineChannels(type, preferences, notificationData) {
   const channels = {
     push: false,
     email: false,
     sms: false,
     inApp: true,
   };

   // Override with notification data if specified
   if (notificationData.channels) {
     return { ...channels, ...notificationData.channels };
   }

   // Check user preferences
   const typePrefs = preferences[type] || {};
   
   channels.push = typePrefs.push !== false && preferences.push !== false;
   channels.email = typePrefs.email !== false && preferences.email !== false;
   channels.sms = typePrefs.sms === true; // SMS opt-in required
   channels.inApp = typePrefs.inApp !== false;

   return channels;
 }

 /**
  * Get job priority for queue
  */
 getJobPriority(priority) {
   const priorities = {
     urgent: 1,
     high: 2,
     normal: 3,
     low: 4,
   };
   return priorities[priority] || 3;
 }

 /**
  * Get FCM priority
  */
 getFCMPriority(priority) {
   return priority === 'urgent' || priority === 'high' ? 'high' : 'normal';
 }

 /**
  * Update notification cache for user
  */
 async updateNotificationCache(userId) {
   const patterns = [
     `notifications:${userId}:*`,
     `user:${userId}:notifications:*`,
   ];

   for (const pattern of patterns) {
     await CacheService.invalidatePattern(pattern);
   }
 }

 /**
  * Get unread count for user
  */
 async getUnreadCount(userId) {
   const cacheKey = `notifications:${userId}:unread:count`;
   
   return await CacheService.getOrSet(
     cacheKey,
     async () => {
       return await Notification.getUnreadCount(userId);
     },
     300 // 5 minutes
   );
 }

 /**
  * Remove invalid FCM tokens
  */
 async removeInvalidTokens(userId, tokens) {
   await User.findByIdAndUpdate(userId, {
     $pullAll: { deviceTokens: tokens },
   });
   
   logger.info(`Removed ${tokens.length} invalid tokens for user ${userId}`);
 }

 /**
  * Get email template
  */
 async getEmailTemplate(type) {
   // This could be extended to fetch from database or CMS
   return emailTemplates[type] || emailTemplates.default;
 }

 /**
  * Render email template
  */
 renderEmailTemplate(template, data) {
   let html = template;
   
   // Simple template replacement
   Object.keys(data).forEach(key => {
     const value = data[key];
     if (typeof value === 'object') {
       Object.keys(value).forEach(subKey => {
         html = html.replace(
           new RegExp(`{{${key}.${subKey}}}`, 'g'),
           value[subKey]
         );
       });
     } else {
       html = html.replace(new RegExp(`{{${key}}}`, 'g'), value);
     }
   });

   return html;
 }

 /**
  * Group notifications by priority
  */
 groupByPriority(notifications) {
   return notifications.reduce((grouped, notif) => {
     const priority = notif.priority || 'normal';
     if (!grouped[priority]) {
       grouped[priority] = [];
     }
     grouped[priority].push(notif);
     return grouped;
   }, {});
 }

 /**
  * Update delivery status in database
  */
 async updateDeliveryStatus(notificationId, results) {
   const updateData = {};

   Object.keys(results).forEach(channel => {
     if (results[channel].sent) {
       updateData[`channels.${channel}.sent`] = true;
       updateData[`channels.${channel}.sentAt`] = new Date();
       if (results[channel].messageId) {
         updateData[`channels.${channel}.messageId`] = results[channel].messageId;
       }
     } else {
       updateData[`channels.${channel}.error`] = results[channel].error;
     }
   });

   await Notification.findByIdAndUpdate(notificationId, { $set: updateData });
 }

 /**
  * Cleanup old notifications
  */
 async cleanupOldNotifications(daysToKeep = 30) {
   try {
     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

     const result = await Notification.deleteMany({
       createdAt: { $lt: cutoffDate },
       'status.read': true,
     });

     logger.info(`Cleaned up ${result.deletedCount} old notifications`);
     return result.deletedCount;
   } catch (error) {
     logger.error('Error cleaning up notifications:', error);
     throw error;
   }
 }

 /**
  * Get notification statistics
  */
 async getStatistics(userId) {
   try {
     const stats = await Notification.aggregate([
       { $match: { recipient: mongoose.Types.ObjectId(userId) } },
       {
         $group: {
           _id: null,
           total: { $sum: 1 },
           unread: {
             $sum: { $cond: [{ $eq: ['$status.read', false] }, 1, 0] },
           },
           byType: {
             $push: {
               type: '$type',
               read: '$status.read',
             },
           },
           byCategory: {
             $push: {
               category: '$category',
               read: '$status.read',
             },
           },
         },
       },
       {
         $project: {
           total: 1,
           unread: 1,
           readRate: {
             $multiply: [
               { $divide: [{ $subtract: ['$total', '$unread'] }, '$total'] },
               100,
             ],
           },
         },
       },
     ]);

     return stats[0] || { total: 0, unread: 0, readRate: 0 };
   } catch (error) {
     logger.error(`Error getting notification statistics for user ${userId}:`, error);
     throw error;
   }
 }
}

export default new NotificationService();