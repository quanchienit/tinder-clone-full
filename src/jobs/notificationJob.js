// src/jobs/notificationJob.js
import Bull from 'bull';
import mongoose from 'mongoose';
import cron from 'node-cron';
import NotificationService from '../modules/notification/notification.service.js';
import Notification from '../modules/notification/notification.model.js';
import User from '../modules/user/user.model.js';
import Match from '../modules/match/match.model.js';
import CacheService from '../shared/services/cache.service.js';
import QueueService from '../shared/services/queue.service.js';
import MetricsService from '../shared/services/metrics.service.js';
import logger from '../shared/utils/logger.js';
import { NOTIFICATION_TYPES, USER_CONSTANTS } from '../config/constants.js';
import redis from '../config/redis.js';

class NotificationJob {
 constructor() {
   this.isRunning = false;
   this.workers = new Map();
   this.cronJobs = new Map();
 }

 /**
  * Initialize notification job workers
  */
 async initialize() {
   try {
     logger.info('🚀 Initializing notification job workers...');

     // Register queue processors
     await this.registerQueueProcessors();

     // Setup cron jobs
     this.setupCronJobs();

     // Setup monitoring
     this.setupMonitoring();

     this.isRunning = true;
     logger.info('✅ Notification job workers initialized successfully');
   } catch (error) {
     logger.error('Failed to initialize notification jobs:', error);
     throw error;
   }
 }

 /**
  * Register all queue processors
  */
 async registerQueueProcessors() {
   // Main notification delivery processor
   QueueService.process('notification_delivery', 5, async (job) => {
     return await this.processNotificationDelivery(job);
   });

   // Bulk notification processor
   QueueService.process('bulk_notifications', 2, async (job) => {
     return await this.processBulkNotifications(job);
   });

   // Notification retry processor
   QueueService.process('notification_retry', 3, async (job) => {
     return await this.processNotificationRetry(job);
   });

   // Push notification processor
   QueueService.process('push_notifications', 10, async (job) => {
     return await this.processPushNotification(job);
   });

   // Email notification processor
   QueueService.process('email_notifications', 5, async (job) => {
     return await this.processEmailNotification(job);
   });

   // Campaign notification processor
   QueueService.process('campaign_notifications', 1, async (job) => {
     return await this.processCampaignNotifications(job);
   });

   // Notification cleanup processor
   QueueService.process('notification_cleanup', 1, async (job) => {
     return await this.processNotificationCleanup(job);
   });

   logger.info('✅ Registered all notification queue processors');
 }

 /**
  * Process notification delivery
  */
 async processNotificationDelivery(job) {
   const startTime = Date.now();
   const { notificationId, userId, channels, retryCount = 0 } = job.data;

   try {
     logger.info(`Processing notification delivery: ${notificationId} for user: ${userId}`);

     // Track processing
     await MetricsService.incrementCounter('notifications.processing');

     // Check if notification still valid
     const notification = await Notification.findById(notificationId);
     if (!notification) {
       logger.warn(`Notification ${notificationId} not found, skipping`);
       return { success: false, reason: 'notification_not_found' };
     }

     // Check if already delivered
     if (notification.status.delivered) {
       logger.info(`Notification ${notificationId} already delivered`);
       return { success: true, reason: 'already_delivered' };
     }

     // Check expiration
     if (notification.expiresAt && notification.expiresAt < new Date()) {
       logger.warn(`Notification ${notificationId} expired`);
       await notification.updateOne({ 
         $set: { 'metadata.failureReason': 'expired' } 
       });
       return { success: false, reason: 'expired' };
     }

     // Get user with preferences
     const user = await CacheService.getOrSet(
       `user:${userId}:notification_prefs`,
       async () => {
         return await User.findById(userId)
           .select('deviceTokens email phone notificationPreferences profile isPremium')
           .lean();
       },
       3600 // Cache for 1 hour
     );

     if (!user) {
       throw new Error('User not found');
     }

     // Check user's quiet hours
     if (this.isInQuietHours(user)) {
       // Reschedule for later
       const delayMs = this.getDelayUntilActiveHours(user);
       await QueueService.addJob(
         'notification_delivery',
         job.data,
         { delay: delayMs }
       );
       logger.info(`Rescheduled notification ${notificationId} due to quiet hours`);
       return { success: true, reason: 'rescheduled_quiet_hours' };
     }

     // Process delivery through NotificationService
     const deliveryResults = await NotificationService.processNotificationDelivery(job);

     // Track delivery metrics
     const successChannels = Object.keys(deliveryResults).filter(
       channel => deliveryResults[channel].sent
     );
     
     await MetricsService.incrementCounter('notifications.delivered');
     await MetricsService.trackUserAction(userId, 'notification_delivered', {
       notificationId,
       channels: successChannels,
       duration: Date.now() - startTime,
     });

     // Update cache
     await this.updateNotificationCache(userId);

     // Check if all channels failed
     if (successChannels.length === 0 && retryCount < 3) {
       // Schedule retry with exponential backoff
       const retryDelay = Math.pow(2, retryCount) * 60000; // 1min, 2min, 4min
       await QueueService.addJob(
         'notification_retry',
         { ...job.data, retryCount: retryCount + 1 },
         { delay: retryDelay, priority: 2 }
       );
       
       logger.warn(`All channels failed for notification ${notificationId}, scheduling retry`);
     }

     logger.info(`Notification ${notificationId} delivered successfully via: ${successChannels.join(', ')}`);
     
     return {
       success: true,
       deliveryResults,
       duration: Date.now() - startTime,
     };

   } catch (error) {
     logger.error(`Error processing notification ${notificationId}:`, error);
     
     // Track failure
     await MetricsService.incrementCounter('notifications.failed');
     
     // Update notification with error
     await Notification.findByIdAndUpdate(notificationId, {
       $set: {
         'metadata.lastError': error.message,
         'metadata.lastErrorAt': new Date(),
       },
       $inc: { 'metadata.retryCount': 1 },
     });

     // Retry if under limit
     if (retryCount < 3) {
       await QueueService.addJob(
         'notification_retry',
         { ...job.data, retryCount: retryCount + 1 },
         { delay: 60000 * (retryCount + 1), priority: 2 }
       );
     }

     throw error;
   }
 }

 /**
  * Process bulk notifications
  */
 async processBulkNotifications(job) {
   const { notifications, campaignId } = job.data;
   const results = {
     total: notifications.length,
     sent: 0,
     failed: 0,
     errors: [],
   };

   try {
     logger.info(`Processing bulk notifications: ${notifications.length} recipients`);

     // Batch process notifications
     const batchSize = 50;
     for (let i = 0; i < notifications.length; i += batchSize) {
       const batch = notifications.slice(i, i + batchSize);
       
       const batchPromises = batch.map(async (notif) => {
         try {
           await NotificationService.sendNotification(notif.userId, {
             ...notif,
             metadata: { campaignId, source: 'campaign' },
           });
           results.sent++;
         } catch (error) {
           results.failed++;
           results.errors.push({
             userId: notif.userId,
             error: error.message,
           });
         }
       });

       await Promise.allSettled(batchPromises);

       // Rate limiting - pause between batches
       if (i + batchSize < notifications.length) {
         await new Promise(resolve => setTimeout(resolve, 1000));
       }
     }

     // Track campaign metrics
     await MetricsService.incrementCounter('campaigns.notifications.sent', results.sent);
     await MetricsService.incrementCounter('campaigns.notifications.failed', results.failed);

     logger.info(`Bulk notifications completed: ${results.sent}/${results.total} sent`);
     return results;

   } catch (error) {
     logger.error('Error processing bulk notifications:', error);
     throw error;
   }
 }

 /**
  * Process notification retry
  */
 async processNotificationRetry(job) {
   const { notificationId, retryCount } = job.data;

   try {
     logger.info(`Retrying notification ${notificationId} (attempt ${retryCount})`);

     // Update retry metadata
     await Notification.findByIdAndUpdate(notificationId, {
       $set: {
         'metadata.retryCount': retryCount,
         'metadata.lastRetryAt': new Date(),
       },
     });

     // Process with original delivery method
     return await this.processNotificationDelivery(job);

   } catch (error) {
     logger.error(`Retry failed for notification ${notificationId}:`, error);
     
     // If final retry failed, mark as permanently failed
     if (retryCount >= 3) {
       await Notification.findByIdAndUpdate(notificationId, {
         $set: {
           'metadata.permanentlyFailed': true,
           'metadata.failureReason': error.message,
         },
       });
     }
     
     throw error;
   }
 }

 /**
  * Process push notification specifically
  */
 async processPushNotification(job) {
   const { userId, payload, options = {} } = job.data;

   try {
     // Get user's device tokens from cache or DB
     const user = await CacheService.getOrSet(
       `user:${userId}:devices`,
       async () => {
         return await User.findById(userId)
           .select('deviceTokens')
           .lean();
       },
       7200 // Cache for 2 hours
     );

     if (!user?.deviceTokens?.length) {
       logger.warn(`No device tokens for user ${userId}`);
       return { success: false, reason: 'no_device_tokens' };
     }

     // Send push notification
     const result = await NotificationService.sendPushNotification(user, payload);

     // Track metrics
     await MetricsService.incrementCounter('push.sent');
     if (result.failureCount > 0) {
       await MetricsService.incrementCounter('push.failed', result.failureCount);
     }

     return result;

   } catch (error) {
     logger.error(`Error sending push notification to user ${userId}:`, error);
     await MetricsService.incrementCounter('push.error');
     throw error;
   }
 }

 /**
  * Process email notification specifically
  */
 async processEmailNotification(job) {
   const { userId, emailData, templateId } = job.data;

   try {
     // Get user email preferences
     const user = await User.findById(userId)
       .select('email notificationPreferences profile');

     if (!user?.email) {
       logger.warn(`No email for user ${userId}`);
       return { success: false, reason: 'no_email' };
     }

     // Check email preferences
     if (user.notificationPreferences?.email === false) {
       logger.info(`Email notifications disabled for user ${userId}`);
       return { success: false, reason: 'email_disabled' };
     }

     // Send email
     const result = await NotificationService.sendEmailNotification(user, emailData);

     // Track metrics
     await MetricsService.incrementCounter('email.sent');
     await MetricsService.trackUserAction(userId, 'email_sent', {
       templateId,
       success: result.sent,
     });

     return result;

   } catch (error) {
     logger.error(`Error sending email to user ${userId}:`, error);
     await MetricsService.incrementCounter('email.error');
     throw error;
   }
 }

 /**
  * Process campaign notifications
  */
 async processCampaignNotifications(job) {
   const { campaignId, segment, template } = job.data;

   try {
     logger.info(`Processing campaign ${campaignId} for segment: ${segment}`);

     // Get target users based on segment
     const users = await this.getSegmentUsers(segment);
     
     if (!users.length) {
       logger.warn(`No users found for segment: ${segment}`);
       return { success: false, reason: 'no_users_in_segment' };
     }

     // Create notifications for each user
     const notifications = users.map(user => ({
       userId: user._id,
       type: template.type || NOTIFICATION_TYPES.PROMOTION,
       title: this.personalizeTemplate(template.title, user),
       body: this.personalizeTemplate(template.body, user),
       category: 'promotion',
       data: { campaignId },
       priority: template.priority || 'normal',
     }));

     // Queue bulk notifications
     await QueueService.addJob(
       'bulk_notifications',
       { notifications, campaignId },
       { priority: 3 }
     );

     // Track campaign start
     await MetricsService.incrementCounter('campaigns.started');
     await MetricsService.gauge('campaigns.audience_size', users.length);

     logger.info(`Campaign ${campaignId} queued for ${users.length} users`);
     
     return {
       success: true,
       audienceSize: users.length,
       campaignId,
     };

   } catch (error) {
     logger.error(`Error processing campaign ${campaignId}:`, error);
     await MetricsService.incrementCounter('campaigns.failed');
     throw error;
   }
 }

 /**
  * Process notification cleanup
  */
 async processNotificationCleanup(job) {
   const { daysToKeep = 30, batchSize = 1000 } = job.data;

   try {
     logger.info(`Starting notification cleanup (keeping last ${daysToKeep} days)`);

     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

     let totalDeleted = 0;
     let hasMore = true;

     while (hasMore) {
       // Delete in batches to avoid memory issues
       const result = await Notification.deleteMany({
         createdAt: { $lt: cutoffDate },
         'status.read': true,
         $or: [
           { 'metadata.permanentlyFailed': true },
           { isDeleted: true },
         ],
       }).limit(batchSize);

       totalDeleted += result.deletedCount;
       hasMore = result.deletedCount === batchSize;

       if (hasMore) {
         // Pause between batches
         await new Promise(resolve => setTimeout(resolve, 100));
       }
     }

     // Clean up Redis cache
     await this.cleanupRedisCache();

     // Track metrics
     await MetricsService.incrementCounter('notifications.cleaned_up', totalDeleted);

     logger.info(`Notification cleanup completed: ${totalDeleted} notifications deleted`);
     
     return {
       success: true,
       deletedCount: totalDeleted,
       cutoffDate,
     };

   } catch (error) {
     logger.error('Error during notification cleanup:', error);
     throw error;
   }
 }

 /**
  * Setup cron jobs for scheduled tasks
  */
 setupCronJobs() {
   // Daily inactive user notifications - 10 AM daily
   this.cronJobs.set('inactive_users', cron.schedule('0 10 * * *', async () => {
     try {
       await this.sendInactiveUserNotifications();
     } catch (error) {
       logger.error('Error in inactive users cron job:', error);
     }
   }));

   // Weekly match suggestions - Sundays at 6 PM
   this.cronJobs.set('weekly_suggestions', cron.schedule('0 18 * * 0', async () => {
     try {
       await this.sendWeeklyMatchSuggestions();
     } catch (error) {
       logger.error('Error in weekly suggestions cron job:', error);
     }
   }));

   // Daily notification cleanup - 3 AM daily
   this.cronJobs.set('daily_cleanup', cron.schedule('0 3 * * *', async () => {
     try {
       await QueueService.addJob('notification_cleanup', {
         daysToKeep: 30,
       });
     } catch (error) {
       logger.error('Error in cleanup cron job:', error);
     }
   }));

   // Hourly metrics aggregation
   this.cronJobs.set('metrics_aggregation', cron.schedule('0 * * * *', async () => {
     try {
       await this.aggregateNotificationMetrics();
     } catch (error) {
       logger.error('Error in metrics aggregation:', error);
     }
   }));

   // Check and send scheduled notifications every minute
   this.cronJobs.set('scheduled_notifications', cron.schedule('* * * * *', async () => {
     try {
       await this.processScheduledNotifications();
     } catch (error) {
       logger.error('Error processing scheduled notifications:', error);
     }
   }));

   logger.info('✅ Notification cron jobs scheduled');
 }

 /**
  * Send notifications to inactive users
  */
 async sendInactiveUserNotifications() {
   try {
     // Find users inactive for 3+ days
     const threeDaysAgo = new Date();
     threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

     const inactiveUsers = await User.find({
       lastActiveAt: { $lt: threeDaysAgo },
       'notificationPreferences.inactivityReminders': { $ne: false },
       status: 'active',
     })
       .select('_id profile.name')
       .limit(1000);

     let sentCount = 0;
     
     for (const user of inactiveUsers) {
       try {
         // Check if already sent recently
         const recentKey = `notification:inactive:${user._id}`;
         const alreadySent = await redis.get(recentKey);
         
         if (alreadySent) continue;

         // Get user's match count to personalize message
         const matchCount = await Match.countDocuments({
           $or: [{ user1: user._id }, { user2: user._id }],
           status: 'active',
         });

         await NotificationService.sendNotification(user._id, {
           type: NOTIFICATION_TYPES.INACTIVE_REMINDER,
           title: '👋 We miss you!',
           body: matchCount > 0 
             ? `You have ${matchCount} matches waiting to hear from you!`
             : 'New people have joined! Come see who\'s nearby.',
           category: 'system',
           action: {
             type: 'navigate',
             target: matchCount > 0 ? 'matches' : 'discover',
           },
           priority: 'low',
         });

         // Mark as sent for 7 days
         await redis.setex(recentKey, 604800, '1');
         sentCount++;

         // Rate limiting
         if (sentCount % 10 === 0) {
           await new Promise(resolve => setTimeout(resolve, 100));
         }

       } catch (error) {
         logger.error(`Failed to send inactive notification to user ${user._id}:`, error);
       }
     }

     logger.info(`Sent ${sentCount} inactive user notifications`);
     await MetricsService.incrementCounter('notifications.inactive_reminders', sentCount);

   } catch (error) {
     logger.error('Error sending inactive user notifications:', error);
   }
 }

 /**
  * Send weekly match suggestions
  */
 async sendWeeklyMatchSuggestions() {
   try {
     // Get active users with weekly suggestions enabled
     const users = await User.find({
       status: 'active',
       'notificationPreferences.weeklyDigest': { $ne: false },
       lastActiveAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
     })
       .select('_id profile preferences')
       .limit(5000);

     let sentCount = 0;

     for (const user of users) {
       try {
         // Get potential matches count
         const potentialMatches = await User.countDocuments({
           _id: { $ne: user._id },
           status: 'active',
           'profile.gender': { $in: user.preferences?.genderPreference || [] },
           'preferences.genderPreference': user.profile?.gender,
         });

         if (potentialMatches > 0) {
           await NotificationService.sendNotification(user._id, {
             type: NOTIFICATION_TYPES.WEEKLY_DIGEST,
             title: '📊 Your weekly update',
             body: `${potentialMatches} potential matches are waiting for you this week!`,
             category: 'system',
             action: {
               type: 'navigate',
               target: 'discover',
             },
             priority: 'low',
           });

           sentCount++;
         }

         // Rate limiting
         if (sentCount % 50 === 0) {
           await new Promise(resolve => setTimeout(resolve, 500));
         }

       } catch (error) {
         logger.error(`Failed to send weekly digest to user ${user._id}:`, error);
       }
     }

     logger.info(`Sent ${sentCount} weekly digest notifications`);
     await MetricsService.incrementCounter('notifications.weekly_digest', sentCount);

   } catch (error) {
     logger.error('Error sending weekly match suggestions:', error);
   }
 }

 /**
  * Process scheduled notifications
  */
 async processScheduledNotifications() {
   try {
     const now = new Date();
     
     // Find notifications scheduled for now
     const scheduled = await Notification.find({
       scheduledFor: { $lte: now },
       'status.delivered': false,
       isDeleted: false,
     }).limit(100);

     for (const notification of scheduled) {
       await QueueService.addJob(
         'notification_delivery',
         {
           notificationId: notification._id.toString(),
           userId: notification.recipient.toString(),
           channels: {
             push: true,
             email: true,
             inApp: true,
           },
         },
         { priority: 2 }
       );

       // Clear the scheduledFor field
       notification.scheduledFor = null;
       await notification.save();
     }

     if (scheduled.length > 0) {
       logger.info(`Queued ${scheduled.length} scheduled notifications`);
     }

   } catch (error) {
     logger.error('Error processing scheduled notifications:', error);
   }
 }

 /**
  * Setup monitoring for queue health
  */
 setupMonitoring() {
   // Monitor queue health every 30 seconds
   setInterval(async () => {
     try {
       const queues = [
         'notification_delivery',
         'bulk_notifications',
         'push_notifications',
         'email_notifications',
       ];

       for (const queueName of queues) {
         const stats = await QueueService.getQueueStats(queueName);
         
         // Log if queue is backing up
         if (stats.waiting > 1000) {
           logger.warn(`Queue ${queueName} has ${stats.waiting} waiting jobs`);
         }
         
         // Track metrics
         await MetricsService.gauge(`queue.${queueName}.waiting`, stats.waiting);
         await MetricsService.gauge(`queue.${queueName}.active`, stats.active);
         await MetricsService.gauge(`queue.${queueName}.failed`, stats.failed);
       }
     } catch (error) {
       logger.error('Error monitoring queues:', error);
     }
   }, 30000);

   logger.info('✅ Queue monitoring started');
 }

 // Helper Methods

 /**
  * Check if user is in quiet hours
  */
 isInQuietHours(user) {
   if (!user.notificationPreferences?.quietHours?.enabled) {
     return false;
   }

   const now = new Date();
   const currentHour = now.getHours();
   const { startHour, endHour } = user.notificationPreferences.quietHours;

   if (startHour < endHour) {
     return currentHour >= startHour && currentHour < endHour;
   } else {
     return currentHour >= startHour || currentHour < endHour;
   }
 }

 /**
  * Calculate delay until active hours
  */
 getDelayUntilActiveHours(user) {
   const now = new Date();
   const { endHour } = user.notificationPreferences.quietHours;
   
   const endTime = new Date(now);
   endTime.setHours(endHour, 0, 0, 0);
   
   if (endTime <= now) {
     endTime.setDate(endTime.getDate() + 1);
   }

   return endTime - now;
 }

 /**
  * Get users for a segment
  */
 async getSegmentUsers(segment) {
   const query = {};

   switch (segment) {
     case 'premium':
       query.isPremium = true;
       break;
     case 'new_users':
       query.createdAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
       break;
     case 'active':
       query.lastActiveAt = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
       break;
     case 'inactive':
       query.lastActiveAt = { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
       break;
     default:
       // Custom segment logic
       break;
   }

   return await User.find(query)
     .select('_id profile notificationPreferences')
     .limit(10000);
 }

 /**
  * Personalize template with user data
  */
 personalizeTemplate(template, user) {
   return template
     .replace('{{name}}', user.profile?.name || 'there')
     .replace('{{firstName}}', user.profile?.name?.split(' ')[0] || 'there');
 }

 /**
  * Update notification cache
  */
 async updateNotificationCache(userId) {
   // Invalidate user notification cache
   await CacheService.invalidatePattern(`notifications:${userId}:*`);
   
   // Update unread count in cache
   const unreadCount = await Notification.getUnreadCount(userId);
   await CacheService.set(`notifications:${userId}:unread:count`, unreadCount, 300);
 }

 /**
  * Clean up Redis cache
  */
 async cleanupRedisCache() {
   try {
     // Clean up old notification keys
     const keys = await redis.keys('notifications:*:temp:*');
     
     for (const key of keys) {
       const ttl = await redis.ttl(key);
       if (ttl === -1) {
         // No TTL set, delete if older than 7 days
         await redis.del(key);
       }
     }

     logger.info(`Cleaned up ${keys.length} Redis cache keys`);
   } catch (error) {
     logger.error('Error cleaning Redis cache:', error);
   }
 }

 /**
  * Aggregate notification metrics
  */
 async aggregateNotificationMetrics() {
   try {
     const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

     const stats = await Notification.aggregate([
       {
         $match: {
           createdAt: { $gte: hourAgo },
         },
       },
       {
         $group: {
           _id: {
             type: '$type',
             delivered: '$status.delivered',
             read: '$status.read',
           },
           count: { $sum: 1 },
         },
       },
     ]);

     // Store aggregated metrics
     for (const stat of stats) {
       const key = `notifications.hourly.${stat._id.type}`;
       await MetricsService.gauge(`${key}.count`, stat.count);
       
       if (stat._id.delivered) {
         await MetricsService.gauge(`${key}.delivered`, stat.count);
       }
       if (stat._id.read) {
         await MetricsService.gauge(`${key}.read`, stat.count);
       }
     }

     logger.info('Notification metrics aggregated successfully');
   } catch (error) {
     logger.error('Error aggregating notification metrics:', error);
   }
 }

 /**
  * Shutdown job workers gracefully
  */
 async shutdown() {
   logger.info('Shutting down notification job workers...');

   // Stop cron jobs
   for (const [name, job] of this.cronJobs) {
     job.stop();
     logger.info(`Stopped cron job: ${name}`);
   }

   // Close queue connections
   await QueueService.closeAll();

   this.isRunning = false;
   logger.info('✅ Notification job workers shut down successfully');
 }
}

export default new NotificationJob();