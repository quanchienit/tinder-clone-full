// src/jobs/cleanupJob.js
import cron from 'node-cron';
import mongoose from 'mongoose';
import fs from 'fs/promises';
import path from 'path';
import User from '../modules/user/user.model.js';
import Match from '../modules/match/match.model.js';
import Message from '../modules/chat/message.model.js';
import Conversation from '../modules/chat/conversation.model.js';
import SwipeActivity from '../modules/swipe/swipeActivity.model.js';
import Notification from '../modules/notification/notification.model.js';
import Report from '../modules/report/report.model.js';
import Media from '../modules/media/media.model.js';
import CacheService from '../shared/services/cache.service.js';
import QueueService from '../shared/services/queue.service.js';
import MetricsService from '../shared/services/metrics.service.js';
import CloudinaryService from '../modules/media/cloudinary.service.js';
import logger from '../shared/utils/logger.js';
import redis from '../config/redis.js';
import { USER_CONSTANTS, CLEANUP_CONSTANTS } from '../config/constants.js';

class CleanupJob {
 constructor() {
   this.isRunning = false;
   this.cronJobs = new Map();
   this.cleanupStats = {
     lastRun: null,
     totalCleaned: 0,
     errors: [],
   };
 }

 /**
  * Initialize cleanup job workers
  */
 async initialize() {
   try {
     logger.info('🧹 Initializing cleanup job workers...');

     // Register queue processors
     await this.registerQueueProcessors();

     // Setup cron jobs
     this.setupCronJobs();

     // Setup monitoring
     this.setupMonitoring();

     this.isRunning = true;
     logger.info('✅ Cleanup job workers initialized successfully');
   } catch (error) {
     logger.error('Failed to initialize cleanup jobs:', error);
     throw error;
   }
 }

 /**
  * Register all queue processors
  */
 async registerQueueProcessors() {
   // Process general cleanup tasks
   QueueService.process('cleanup_task', 2, async (job) => {
     return await this.processCleanupTask(job);
   });

   // Process user data deletion (GDPR)
   QueueService.process('delete_user_data', 1, async (job) => {
     return await this.deleteUserData(job);
   });

   // Process media cleanup
   QueueService.process('cleanup_media', 2, async (job) => {
     return await this.cleanupMedia(job);
   });

   // Process cache cleanup
   QueueService.process('cleanup_cache', 3, async (job) => {
     return await this.cleanupCache(job);
   });

   // Process database optimization
   QueueService.process('optimize_database', 1, async (job) => {
     return await this.optimizeDatabase(job);
   });

   logger.info('✅ Registered all cleanup queue processors');
 }

 /**
  * Setup cron jobs for scheduled cleanup
  */
 setupCronJobs() {
   // Daily cleanup - 3 AM
   this.cronJobs.set('daily_cleanup', cron.schedule('0 3 * * *', async () => {
     try {
       await this.runDailyCleanup();
     } catch (error) {
       logger.error('Error in daily cleanup cron:', error);
     }
   }));

   // Weekly deep cleanup - Sundays at 2 AM
   this.cronJobs.set('weekly_cleanup', cron.schedule('0 2 * * 0', async () => {
     try {
       await this.runWeeklyCleanup();
     } catch (error) {
       logger.error('Error in weekly cleanup cron:', error);
     }
   }));

   // Monthly database optimization - 1st of month at 1 AM
   this.cronJobs.set('monthly_optimization', cron.schedule('0 1 1 * *', async () => {
     try {
       await this.runMonthlyOptimization();
     } catch (error) {
       logger.error('Error in monthly optimization cron:', error);
     }
   }));

   // Hourly cache cleanup
   this.cronJobs.set('hourly_cache', cron.schedule('0 * * * *', async () => {
     try {
       await this.cleanupExpiredCache();
     } catch (error) {
       logger.error('Error in hourly cache cleanup:', error);
     }
   }));

   // Clean temporary files every 6 hours
   this.cronJobs.set('temp_files', cron.schedule('0 */6 * * *', async () => {
     try {
       await this.cleanupTempFiles();
     } catch (error) {
       logger.error('Error in temp files cleanup:', error);
     }
   }));

   // Clean expired sessions - Every 4 hours
   this.cronJobs.set('session_cleanup', cron.schedule('0 */4 * * *', async () => {
     try {
       await this.cleanupExpiredSessions();
     } catch (error) {
       logger.error('Error in session cleanup:', error);
     }
   }));

   // Clean orphaned data - Daily at 4 AM
   this.cronJobs.set('orphaned_data', cron.schedule('0 4 * * *', async () => {
     try {
       await this.cleanupOrphanedData();
     } catch (error) {
       logger.error('Error in orphaned data cleanup:', error);
     }
   }));

   // Archive old data - Weekly on Saturdays at 1 AM
   this.cronJobs.set('archive_data', cron.schedule('0 1 * * 6', async () => {
     try {
       await this.archiveOldData();
     } catch (error) {
       logger.error('Error in data archival:', error);
     }
   }));

   logger.info('✅ Cleanup cron jobs scheduled');
 }

 /**
  * Run daily cleanup tasks
  */
 async runDailyCleanup() {
   const startTime = Date.now();
   logger.info('🧹 Starting daily cleanup...');

   const results = {
     notifications: 0,
     messages: 0,
     swipes: 0,
     logs: 0,
     tokens: 0,
     media: 0,
   };

   try {
     // 1. Clean old notifications
     results.notifications = await this.cleanupOldNotifications();

     // 2. Clean deleted messages
     results.messages = await this.cleanupDeletedMessages();

     // 3. Clean old swipe activities
     results.swipes = await this.cleanupOldSwipes();

     // 4. Clean old activity logs
     results.logs = await this.cleanupActivityLogs();

     // 5. Clean expired tokens
     results.tokens = await this.cleanupExpiredTokens();

     // 6. Clean unused media
     results.media = await this.cleanupUnusedMedia();

     // Update stats
     this.cleanupStats.lastRun = new Date();
     this.cleanupStats.totalCleaned += Object.values(results).reduce((a, b) => a + b, 0);

     // Track metrics
     await MetricsService.incrementCounter('cleanup.daily.completed');
     await MetricsService.histogram('cleanup.daily.duration', Date.now() - startTime);
     
     for (const [type, count] of Object.entries(results)) {
       await MetricsService.gauge(`cleanup.daily.${type}`, count);
     }

     logger.info(`✅ Daily cleanup completed in ${Date.now() - startTime}ms`, results);

     return results;

   } catch (error) {
     logger.error('Error in daily cleanup:', error);
     this.cleanupStats.errors.push({
       type: 'daily_cleanup',
       error: error.message,
       timestamp: new Date(),
     });
     throw error;
   }
 }

 /**
  * Run weekly deep cleanup
  */
 async runWeeklyCleanup() {
   const startTime = Date.now();
   logger.info('🧹 Starting weekly deep cleanup...');

   try {
     const results = {
       inactiveUsers: 0,
       oldMatches: 0,
       failedJobs: 0,
       metrics: 0,
       reports: 0,
     };

     // 1. Clean inactive user data
     results.inactiveUsers = await this.cleanupInactiveUsers();

     // 2. Clean old unmatched/expired matches
     results.oldMatches = await this.cleanupOldMatches();

     // 3. Clean failed queue jobs
     results.failedJobs = await this.cleanupFailedJobs();

     // 4. Clean old metrics data
     results.metrics = await this.cleanupOldMetrics();

     // 5. Clean resolved reports
     results.reports = await this.cleanupResolvedReports();

     // Track metrics
     await MetricsService.incrementCounter('cleanup.weekly.completed');
     await MetricsService.histogram('cleanup.weekly.duration', Date.now() - startTime);

     logger.info(`✅ Weekly cleanup completed in ${Date.now() - startTime}ms`, results);

     return results;

   } catch (error) {
     logger.error('Error in weekly cleanup:', error);
     throw error;
   }
 }

 /**
  * Run monthly database optimization
  */
 async runMonthlyOptimization() {
   const startTime = Date.now();
   logger.info('🔧 Starting monthly database optimization...');

   try {
     const results = {
       collections: [],
       indexes: [],
       compacted: 0,
     };

     // 1. Rebuild indexes
     const collections = await mongoose.connection.db.collections();
     
     for (const collection of collections) {
       try {
         // Reindex collection
         await collection.reIndex();
         results.collections.push(collection.collectionName);

         // Get index stats
         const indexes = await collection.indexInformation();
         results.indexes.push({
           collection: collection.collectionName,
           count: Object.keys(indexes).length,
         });

         logger.info(`Reindexed collection: ${collection.collectionName}`);
       } catch (error) {
         logger.error(`Error reindexing ${collection.collectionName}:`, error);
       }
     }

     // 2. Compact collections (if using WiredTiger)
     for (const collection of collections) {
       try {
         await mongoose.connection.db.command({
           compact: collection.collectionName,
         });
         results.compacted++;
       } catch (error) {
         // Compact might not be available in all environments
         logger.debug(`Could not compact ${collection.collectionName}:`, error.message);
       }
     }

     // 3. Update statistics
     await mongoose.connection.db.command({ dbStats: 1 });

     // Track metrics
     await MetricsService.incrementCounter('cleanup.monthly.optimization');
     await MetricsService.histogram('cleanup.monthly.duration', Date.now() - startTime);

     logger.info(`✅ Monthly optimization completed in ${Date.now() - startTime}ms`, results);

     return results;

   } catch (error) {
     logger.error('Error in monthly optimization:', error);
     throw error;
   }
 }

 /**
  * Clean up old notifications
  */
 async cleanupOldNotifications() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - (CLEANUP_CONSTANTS?.NOTIFICATION_RETENTION_DAYS || 30));

     const result = await Notification.deleteMany({
       createdAt: { $lt: cutoffDate },
       'status.read': true,
       $or: [
         { isDeleted: true },
         { 'metadata.permanentlyFailed': true },
       ],
     });

     logger.info(`Cleaned up ${result.deletedCount} old notifications`);
     return result.deletedCount;

   } catch (error) {
     logger.error('Error cleaning notifications:', error);
     return 0;
   }
 }

 /**
  * Clean up deleted messages
  */
 async cleanupDeletedMessages() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - 7); // Keep deleted messages for 7 days

     const result = await Message.deleteMany({
       deletedAt: { $lt: cutoffDate },
       isDeleted: true,
     });

     logger.info(`Cleaned up ${result.deletedCount} deleted messages`);
     return result.deletedCount;

   } catch (error) {
     logger.error('Error cleaning messages:', error);
     return 0;
   }
 }

 /**
  * Clean up old swipe activities
  */
 async cleanupOldSwipes() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - (CLEANUP_CONSTANTS?.SWIPE_RETENTION_DAYS || 90));

     // Keep only 'like' and 'super_like' older than 90 days
     // Delete all 'pass' older than 30 days
     const passDate = new Date();
     passDate.setDate(passDate.getDate() - 30);

     const result = await SwipeActivity.deleteMany({
       $or: [
         {
           action: 'pass',
           createdAt: { $lt: passDate },
         },
         {
           createdAt: { $lt: cutoffDate },
           action: { $nin: ['like', 'super_like'] },
         },
       ],
     });

     logger.info(`Cleaned up ${result.deletedCount} old swipe activities`);
     return result.deletedCount;

   } catch (error) {
     logger.error('Error cleaning swipes:', error);
     return 0;
   }
 }

 /**
  * Clean up activity logs
  */
 async cleanupActivityLogs() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setDate(cutoffDate.getDate() - 60); // Keep 60 days of logs

     // Remove old activity logs from users
     const result = await User.updateMany(
       {},
       {
         $pull: {
           activityLog: {
             timestamp: { $lt: cutoffDate },
           },
         },
       }
     );

     logger.info(`Cleaned activity logs for ${result.modifiedCount} users`);
     return result.modifiedCount;

   } catch (error) {
     logger.error('Error cleaning activity logs:', error);
     return 0;
   }
 }

 /**
  * Clean up expired tokens
  */
 async cleanupExpiredTokens() {
   try {
     const now = new Date();
     let totalCleaned = 0;

     // Clean expired password reset tokens
     const passwordResets = await User.updateMany(
       {
         'security.passwordResetToken': { $exists: true },
         'security.passwordResetExpires': { $lt: now },
       },
       {
         $unset: {
           'security.passwordResetToken': '',
           'security.passwordResetExpires': '',
         },
       }
     );
     totalCleaned += passwordResets.modifiedCount;

     // Clean expired email verification tokens
     const emailVerifications = await User.updateMany(
       {
         'verification.emailToken': { $exists: true },
         'verification.emailTokenExpires': { $lt: now },
       },
       {
         $unset: {
           'verification.emailToken': '',
           'verification.emailTokenExpires': '',
         },
       }
     );
     totalCleaned += emailVerifications.modifiedCount;

     // Clean expired device tokens (not used for 30 days)
     const thirtyDaysAgo = new Date();
     thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

     const deviceTokens = await User.updateMany(
       {
         lastActiveAt: { $lt: thirtyDaysAgo },
         deviceTokens: { $exists: true, $ne: [] },
       },
       {
         $set: { deviceTokens: [] },
       }
     );
     totalCleaned += deviceTokens.modifiedCount;

     logger.info(`Cleaned up tokens for ${totalCleaned} users`);
     return totalCleaned;

   } catch (error) {
     logger.error('Error cleaning expired tokens:', error);
     return 0;
   }
 }

 /**
  * Clean up unused media
  */
 async cleanupUnusedMedia() {
   try {
     // Find media not referenced anywhere
     const orphanedMedia = await Media.aggregate([
       {
         $lookup: {
           from: 'users',
           localField: '_id',
           foreignField: 'profile.photos',
           as: 'userRefs',
         },
       },
       {
         $lookup: {
           from: 'messages',
           localField: '_id',
           foreignField: 'media',
           as: 'messageRefs',
         },
       },
       {
         $match: {
           userRefs: { $size: 0 },
           messageRefs: { $size: 0 },
           createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Older than 24 hours
         },
       },
       { $limit: 100 }, // Process in batches
     ]);

     let deletedCount = 0;

     for (const media of orphanedMedia) {
       try {
         // Delete from Cloudinary
         if (media.cloudinaryId) {
           await CloudinaryService.deleteImage(media.cloudinaryId);
         }

         // Delete from database
         await Media.findByIdAndDelete(media._id);
         deletedCount++;

       } catch (error) {
         logger.error(`Error deleting media ${media._id}:`, error);
       }
     }

     logger.info(`Cleaned up ${deletedCount} unused media files`);
     return deletedCount;

   } catch (error) {
     logger.error('Error cleaning unused media:', error);
     return 0;
   }
 }

 /**
  * Clean up inactive users
  */
 async cleanupInactiveUsers() {
   try {
     const inactiveDate = new Date();
     inactiveDate.setFullYear(inactiveDate.getFullYear() - 1); // 1 year inactive

     // Find users inactive for over a year
     const inactiveUsers = await User.find({
       lastActiveAt: { $lt: inactiveDate },
       status: { $ne: 'deleted' },
     })
       .select('_id')
       .limit(100); // Process in batches

     let processedCount = 0;

     for (const user of inactiveUsers) {
       await QueueService.addJob('delete_user_data', {
         userId: user._id.toString(),
         reason: 'inactive_account',
         softDelete: true,
       });
       processedCount++;
     }

     logger.info(`Queued ${processedCount} inactive users for cleanup`);
     return processedCount;

   } catch (error) {
     logger.error('Error cleaning inactive users:', error);
     return 0;
   }
 }

 /**
  * Clean up old matches
  */
 async cleanupOldMatches() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setMonth(cutoffDate.getMonth() - 6); // 6 months old

     // Delete old unmatched records
     const result = await Match.deleteMany({
       status: 'unmatched',
       unmatchedAt: { $lt: cutoffDate },
     });

     logger.info(`Cleaned up ${result.deletedCount} old unmatched records`);
     return result.deletedCount;

   } catch (error) {
     logger.error('Error cleaning old matches:', error);
     return 0;
   }
 }

 /**
  * Clean up failed queue jobs
  */
 async cleanupFailedJobs() {
   try {
     const queues = await QueueService.getAllQueues();
     let totalCleaned = 0;

     for (const queue of queues) {
       const failed = await queue.getFailed();
       
       // Remove jobs failed more than 7 days ago
       const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
       
       for (const job of failed) {
         if (job.timestamp < sevenDaysAgo) {
           await job.remove();
           totalCleaned++;
         }
       }
     }

     logger.info(`Cleaned up ${totalCleaned} failed jobs`);
     return totalCleaned;

   } catch (error) {
     logger.error('Error cleaning failed jobs:', error);
     return 0;
   }
 }

 /**
  * Clean up old metrics data
  */
 async cleanupOldMetrics() {
   try {
     // Clean metrics older than 90 days from Redis
     const keys = await redis.keys('metrics:*');
     let deletedCount = 0;

     for (const key of keys) {
       const ttl = await redis.ttl(key);
       
       // If no TTL or very old, delete
       if (ttl === -1 || ttl > 7776000) { // 90 days in seconds
         await redis.del(key);
         deletedCount++;
       }
     }

     logger.info(`Cleaned up ${deletedCount} old metric keys`);
     return deletedCount;

   } catch (error) {
     logger.error('Error cleaning metrics:', error);
     return 0;
   }
 }

 /**
  * Clean up resolved reports
  */
 async cleanupResolvedReports() {
   try {
     const cutoffDate = new Date();
     cutoffDate.setMonth(cutoffDate.getMonth() - 3); // 3 months old

     const result = await Report.deleteMany({
       status: 'resolved',
       resolvedAt: { $lt: cutoffDate },
     });

     logger.info(`Cleaned up ${result.deletedCount} old resolved reports`);
     return result.deletedCount;

   } catch (error) {
     logger.error('Error cleaning reports:', error);
     return 0;
   }
 }

 /**
  * Clean up expired cache
  */
 async cleanupExpiredCache() {
   try {
     const patterns = [
       'cache:temp:*',
       'session:*',
       'rate_limit:*',
     ];

     let totalCleaned = 0;

     for (const pattern of patterns) {
       const keys = await redis.keys(pattern);
       
       for (const key of keys) {
         const ttl = await redis.ttl(key);
         
         // Clean up keys without TTL
         if (ttl === -1) {
           await redis.del(key);
           totalCleaned++;
         }
       }
     }

     // Use Redis SCAN for large datasets
     await this.scanAndClean('cache:*', 3600); // 1 hour default TTL

     logger.info(`Cleaned up ${totalCleaned} expired cache entries`);
     return totalCleaned;

   } catch (error) {
     logger.error('Error cleaning cache:', error);
     return 0;
   }
 }

 /**
  * Clean up temporary files
  */
 async cleanupTempFiles() {
   try {
     const tempDir = path.join(process.cwd(), 'temp');
     let deletedCount = 0;

     try {
       const files = await fs.readdir(tempDir);
       const now = Date.now();

       for (const file of files) {
         const filePath = path.join(tempDir, file);
         const stats = await fs.stat(filePath);

         // Delete files older than 6 hours
         if (now - stats.mtimeMs > 6 * 60 * 60 * 1000) {
           await fs.unlink(filePath);
           deletedCount++;
         }
       }
     } catch (error) {
       if (error.code !== 'ENOENT') {
         throw error;
       }
     }

     logger.info(`Cleaned up ${deletedCount} temporary files`);
     return deletedCount;

   } catch (error) {
     logger.error('Error cleaning temp files:', error);
     return 0;
   }
 }

 /**
  * Clean up expired sessions
  */
 async cleanupExpiredSessions() {
   try {
     const sessions = await redis.keys('sess:*');
     let cleanedCount = 0;

     for (const sessionKey of sessions) {
       const session = await redis.get(sessionKey);
       
       if (session) {
         try {
           const sessionData = JSON.parse(session);
           const expires = new Date(sessionData.cookie?.expires);
           
           if (expires < new Date()) {
             await redis.del(sessionKey);
             cleanedCount++;
           }
         } catch (error) {
           // Invalid session data, delete it
           await redis.del(sessionKey);
           cleanedCount++;
         }
       }
     }

     logger.info(`Cleaned up ${cleanedCount} expired sessions`);
     return cleanedCount;

   } catch (error) {
     logger.error('Error cleaning sessions:', error);
     return 0;
   }
 }

 /**
  * Clean up orphaned data
  */
 async cleanupOrphanedData() {
   try {
     let totalCleaned = 0;

     // 1. Messages without valid conversations
     const orphanedMessages = await Message.aggregate([
       {
         $lookup: {
           from: 'conversations',
           localField: 'conversationId',
           foreignField: '_id',
           as: 'conversation',
         },
       },
       {
         $match: {
           conversation: { $size: 0 },
         },
       },
       { $limit: 1000 },
     ]);

     if (orphanedMessages.length > 0) {
       const messageIds = orphanedMessages.map(m => m._id);
       const result = await Message.deleteMany({ _id: { $in: messageIds } });
       totalCleaned += result.deletedCount;
       logger.info(`Deleted ${result.deletedCount} orphaned messages`);
     }

     // 2. Conversations without valid matches
     const orphanedConversations = await Conversation.aggregate([
       {
         $lookup: {
           from: 'matches',
           localField: 'matchId',
           foreignField: '_id',
           as: 'match',
         },
       },
       {
         $match: {
           match: { $size: 0 },
         },
       },
       { $limit: 100 },
     ]);

     if (orphanedConversations.length > 0) {
       const conversationIds = orphanedConversations.map(c => c._id);
       const result = await Conversation.deleteMany({ _id: { $in: conversationIds } });
       totalCleaned += result.deletedCount;
       logger.info(`Deleted ${result.deletedCount} orphaned conversations`);
     }

     logger.info(`Total orphaned data cleaned: ${totalCleaned}`);
     return totalCleaned;

   } catch (error) {
     logger.error('Error cleaning orphaned data:', error);
     return 0;
   }
 }

 /**
  * Archive old data
  */
 async archiveOldData() {
   try {
     const archiveDate = new Date();
     archiveDate.setMonth(archiveDate.getMonth() - 12); // 1 year old

     // Archive old conversations
     const oldConversations = await Conversation.find({
       lastMessageAt: { $lt: archiveDate },
       isArchived: { $ne: true },
     }).limit(1000);

     let archivedCount = 0;

     for (const conversation of oldConversations) {
       conversation.isArchived = true;
       conversation.archivedAt = new Date();
       await conversation.save();
       archivedCount++;

       // Archive associated messages
       await Message.updateMany(
         { conversationId: conversation._id },
         {
           $set: {
             isArchived: true,
             archivedAt: new Date(),
           },
         }
       );
     }

     logger.info(`Archived ${archivedCount} old conversations`);
     return archivedCount;

   } catch (error) {
     logger.error('Error archiving data:', error);
     return 0;
   }
 }

 /**
  * Delete user data (GDPR compliance)
  */
 async deleteUserData(job) {
   const { userId, reason, softDelete = false } = job.data;
   const session = await mongoose.startSession();
   session.startTransaction();

   try {
     logger.info(`Processing user data deletion for ${userId} (reason: ${reason})`);

     const user = await User.findById(userId).session(session);
     if (!user) {
       throw new Error('User not found');
     }

     if (softDelete) {
       // Soft delete - anonymize data
       user.status = 'deleted';
       user.deletedAt = new Date();
       user.email = `deleted_${userId}@deleted.com`;
       user.phone = null;
       user.profile = {
         name: 'Deleted User',
         bio: '',
         photos: [],
         interests: [],
         location: null,
       };
       user.deviceTokens = [];
       user.security = {};
       await user.save({ session });

     } else {
       // Hard delete - remove all data
       
       // Delete user's matches
       await Match.deleteMany({
         $or: [{ user1: userId }, { user2: userId }],
       }).session(session);

       // Delete user's conversations and messages
       const conversations = await Conversation.find({
         participants: userId,
       }).session(session);

       for (const conv of conversations) {
         await Message.deleteMany({
           conversationId: conv._id,
         }).session(session);
       }

       await Conversation.deleteMany({
         participants: userId,
       }).session(session);

       // Delete user's swipe activities
       await SwipeActivity.deleteMany({
         $or: [{ userId }, { targetUserId: userId }],
       }).session(session);

       // Delete user's notifications
       await Notification.deleteMany({
         $or: [{ recipient: userId }, { sender: userId }],
       }).session(session);

       // Delete user's reports
       await Report.deleteMany({
         $or: [{ reportedBy: userId }, { reportedUser: userId }],
       }).session(session);

       // Delete user's media from Cloudinary
       if (user.profile?.photos?.length > 0) {
         for (const photoId of user.profile.photos) {
           const media = await Media.findById(photoId);
           if (media?.cloudinaryId) {
             await CloudinaryService.deleteImage(media.cloudinaryId);
           }
           await Media.findByIdAndDelete(photoId).session(session);
         }
       }

       // Finally, delete the user
       await User.findByIdAndDelete(userId).session(session);
     }

     await session.commitTransaction();

     // Clear all caches
     await CacheService.invalidatePattern(`*${userId}*`);

     // Track metrics
     await MetricsService.incrementCounter(`users.deleted.${reason}`);

     logger.info(`User data ${softDelete ? 'soft' : 'hard'} deleted for ${userId}`);

     return {
       success: true,
       userId,
       type: softDelete ? 'soft_delete' : 'hard_delete',
     };

   } catch (error) {
     await session.abortTransaction();
     logger.error(`Error deleting user data for ${userId}:`, error);
     throw error;
   } finally {
     session.endSession();
   }
 }

 /**
  * Process general cleanup task
  */
 async processCleanupTask(job) {
   const { type, params = {} } = job.data;

   try {
     logger.info(`Processing cleanup task: ${type}`);

     switch (type) {
       case 'notifications':
         return await this.cleanupOldNotifications();
       
       case 'messages':
         return await this.cleanupDeletedMessages();
       
       case 'swipes':
         return await this.cleanupOldSwipes();
       
       case 'media':
         return await this.cleanupUnusedMedia();
       
       case 'cache':
         return await this.cleanupExpiredCache();
       
       case 'sessions':
         return await this.cleanupExpiredSessions();
       
       case 'logs':
         return await this.cleanupActivityLogs();
       
       case 'tokens':
         return await this.cleanupExpiredTokens();
       
       default:
         throw new Error(`Unknown cleanup type: ${type}`);
     }

   } catch (error) {
     logger.error(`Error processing cleanup task ${type}:`, error);
     throw error;
   }
 }

 /**
  * Cleanup media files
  */
 async cleanupMedia(job) {
   const { mediaIds, userId } = job.data;

   try {
     logger.info(`Cleaning up ${mediaIds.length} media files`);
     let deletedCount = 0;

     for (const mediaId of mediaIds) {
       try {
         const media = await Media.findById(mediaId);
         
         if (media) {
           // Check if media is still in use
           const inUse = await this.isMediaInUse(mediaId);
           
           if (!inUse) {
             // Delete from Cloudinary
             if (media.cloudinaryId) {
               await CloudinaryService.deleteImage(media.cloudinaryId);
             }

             // Delete from database
             await Media.findByIdAndDelete(mediaId);
             deletedCount++;
           }
         }
       } catch (error) {
         logger.error(`Error deleting media ${mediaId}:`, error);
       }
     }

     logger.info(`Deleted ${deletedCount} media files`);
     return { success: true, deletedCount };

   } catch (error) {
     logger.error('Error in media cleanup:', error);
     throw error;
   }
 }

 /**
  * Cleanup cache entries
  */
 async cleanupCache(job) {
   const { patterns = [], maxAge } = job.data;

   try {
     let totalDeleted = 0;

     for (const pattern of patterns) {
       const deleted = await this.scanAndClean(pattern, maxAge);
       totalDeleted += deleted;
     }

     logger.info(`Cleaned up ${totalDeleted} cache entries`);
     return { success: true, deletedCount: totalDeleted };

   } catch (error) {
     logger.error('Error in cache cleanup:', error);
     throw error;
   }
 }

 /**
  * Optimize database collections
  */
 async optimizeDatabase(job) {
   const { collections = [] } = job.data;

   try {
     logger.info(`Optimizing ${collections.length || 'all'} collections`);
     const results = [];

     const targetCollections = collections.length > 0 
       ? collections 
       : await mongoose.connection.db.collections();

     for (const collection of targetCollections) {
       const collName = typeof collection === 'string' 
         ? collection 
         : collection.collectionName;

       try {
         // Reindex
         await mongoose.connection.db.collection(collName).reIndex();

         // Get stats
         const stats = await mongoose.connection.db.collection(collName).stats();

         // Try to compact (might fail in some environments)
         try {
           await mongoose.connection.db.command({
             compact: collName,
             force: true,
           });
         } catch (e) {
           // Compact not available, skip
         }

         results.push({
           collection: collName,
           documents: stats.count,
           size: stats.size,
           indexes: stats.nindexes,
         });

         logger.info(`Optimized collection: ${collName}`);

       } catch (error) {
         logger.error(`Error optimizing ${collName}:`, error);
       }
     }

     return { success: true, results };

   } catch (error) {
     logger.error('Error in database optimization:', error);
     throw error;
   }
 }

 /**
  * Setup monitoring for cleanup jobs
  */
 setupMonitoring() {
   // Monitor cleanup performance
   setInterval(async () => {
     try {
       // Check cleanup queue health
       const stats = await QueueService.getQueueStats('cleanup_task');
       
       if (stats.failed > 10) {
         logger.warn(`Cleanup queue has ${stats.failed} failed jobs`);
       }

       await MetricsService.gauge('cleanup.queue.waiting', stats.waiting);
       await MetricsService.gauge('cleanup.queue.active', stats.active);
       await MetricsService.gauge('cleanup.queue.failed', stats.failed);

       // Check disk space for temp files
       await this.checkDiskSpace();

       // Check database size
       await this.checkDatabaseSize();

     } catch (error) {
       logger.error('Error in cleanup monitoring:', error);
     }
   }, 300000); // Every 5 minutes

   logger.info('✅ Cleanup monitoring started');
 }

 // Helper Methods

 /**
  * Scan and clean Redis keys
  */
 async scanAndClean(pattern, maxAge) {
   let cursor = '0';
   let deletedCount = 0;
   const now = Date.now();

   do {
     const [newCursor, keys] = await redis.scan(
       cursor,
       'MATCH',
       pattern,
       'COUNT',
       100
     );

     cursor = newCursor;

     for (const key of keys) {
       try {
         // Get TTL
         const ttl = await redis.ttl(key);
         
         // Delete if no TTL or very old
         if (ttl === -1 || (maxAge && ttl > maxAge)) {
           await redis.del(key);
           deletedCount++;
         }
       } catch (error) {
         // Skip problematic keys
         continue;
       }
     }
   } while (cursor !== '0');

   return deletedCount;
 }

 /**
  * Check if media is in use
  */
 async isMediaInUse(mediaId) {
   // Check in user profiles
   const userWithMedia = await User.findOne({
     'profile.photos': mediaId,
   });
   if (userWithMedia) return true;

   // Check in messages
   const messageWithMedia = await Message.findOne({
     media: mediaId,
   });
   if (messageWithMedia) return true;

   return false;
 }

 /**
  * Check disk space
  */
 async checkDiskSpace() {
   try {
     // This is platform-specific, simplified version
     const tempDir = path.join(process.cwd(), 'temp');
     const uploadDir = path.join(process.cwd(), 'uploads');

     const checkDir = async (dir) => {
       try {
         const files = await fs.readdir(dir);
         let totalSize = 0;

         for (const file of files) {
           const stats = await fs.stat(path.join(dir, file));
           totalSize += stats.size;
         }

         return totalSize;
       } catch (error) {
         return 0;
       }
     };

     const tempSize = await checkDir(tempDir);
     const uploadSize = await checkDir(uploadDir);

     await MetricsService.gauge('disk.temp_size', tempSize);
     await MetricsService.gauge('disk.upload_size', uploadSize);

     // Alert if too large
     if (tempSize > 1024 * 1024 * 1024) { // 1GB
       logger.warn(`Temp directory is large: ${tempSize} bytes`);
     }

   } catch (error) {
     logger.error('Error checking disk space:', error);
   }
 }

 /**
  * Check database size
  */
 async checkDatabaseSize() {
   try {
     const stats = await mongoose.connection.db.stats();
     
     await MetricsService.gauge('database.size', stats.dataSize);
     await MetricsService.gauge('database.storage', stats.storageSize);
     await MetricsService.gauge('database.collections', stats.collections);
     await MetricsService.gauge('database.indexes', stats.indexes);

     // Alert if database is large
     if (stats.dataSize > 5 * 1024 * 1024 * 1024) { // 5GB
       logger.warn(`Database is large: ${stats.dataSize} bytes`);
     }

   } catch (error) {
     logger.error('Error checking database size:', error);
   }
 }

 /**
  * Generate cleanup report
  */
 async generateCleanupReport() {
   try {
     const report = {
       timestamp: new Date(),
       lastRun: this.cleanupStats.lastRun,
       totalCleaned: this.cleanupStats.totalCleaned,
       errors: this.cleanupStats.errors.slice(-10), // Last 10 errors
       database: await this.getDatabaseStats(),
       redis: await this.getRedisStats(),
       queues: await this.getQueueStats(),
     };

     // Save report
     await CacheService.set('cleanup:last_report', report, 86400);

     logger.info('Cleanup report generated:', report);
     return report;

   } catch (error) {
     logger.error('Error generating cleanup report:', error);
     return null;
   }
 }

 /**
  * Get database statistics
  */
 async getDatabaseStats() {
   try {
     const stats = await mongoose.connection.db.stats();
     const collections = await mongoose.connection.db.collections();

     const collectionStats = await Promise.all(
       collections.map(async (col) => {
         const colStats = await col.stats();
         return {
           name: col.collectionName,
           count: colStats.count,
           size: colStats.size,
         };
       })
     );

     return {
       size: stats.dataSize,
       storage: stats.storageSize,
       collections: collectionStats.sort((a, b) => b.size - a.size).slice(0, 10),
     };

   } catch (error) {
     logger.error('Error getting database stats:', error);
     return {};
   }
 }

 /**
  * Get Redis statistics
  */
 async getRedisStats() {
   try {
     const info = await redis.info();
     const dbsize = await redis.dbsize();

     // Parse Redis info
     const lines = info.split('\r\n');
     const stats = {};

     for (const line of lines) {
       if (line.includes(':')) {
         const [key, value] = line.split(':');
         stats[key] = value;
       }
     }

     return {
       keys: dbsize,
       memory: stats.used_memory_human || 'unknown',
       uptime: stats.uptime_in_seconds || 'unknown',
     };

   } catch (error) {
     logger.error('Error getting Redis stats:', error);
     return {};
   }
 }

 /**
  * Get queue statistics
  */
 async getQueueStats() {
   try {
     const queues = await QueueService.getAllQueues();
     const stats = {};

     for (const queue of queues) {
       const queueStats = await queue.getJobCounts();
       stats[queue.name] = queueStats;
     }

     return stats;

   } catch (error) {
     logger.error('Error getting queue stats:', error);
     return {};
   }
 }

 /**
  * Emergency cleanup - when disk/memory is critical
  */
 async emergencyCleanup() {
   logger.warn('🚨 Starting emergency cleanup...');

   try {
     // 1. Clear all temp files
     const tempDir = path.join(process.cwd(), 'temp');
     await fs.rm(tempDir, { recursive: true, force: true });
     await fs.mkdir(tempDir, { recursive: true });

     // 2. Clear Redis cache (keep only essential)
     const patterns = ['cache:*', 'temp:*', 'metrics:*'];
     for (const pattern of patterns) {
       await redis.eval(
         `for _,k in ipairs(redis.call('keys','${pattern}')) do redis.call('del',k) end`,
         0
       );
     }

     // 3. Remove old logs
     await this.cleanupActivityLogs();

     // 4. Clear failed jobs
     const queues = await QueueService.getAllQueues();
     for (const queue of queues) {
       await queue.clean(0, 'failed');
     }

     // 5. Run garbage collection
     if (global.gc) {
       global.gc();
     }

     logger.info('✅ Emergency cleanup completed');

     return { success: true };

   } catch (error) {
     logger.error('Error in emergency cleanup:', error);
     throw error;
   }
 }

 /**
  * Health check for cleanup system
  */
 async healthCheck() {
   const health = {
     status: 'healthy',
     issues: [],
     stats: this.cleanupStats,
   };

   try {
     // Check if cleanup is running
     if (!this.isRunning) {
       health.status = 'unhealthy';
       health.issues.push('Cleanup jobs not running');
     }

     // Check last run time
     if (this.cleanupStats.lastRun) {
       const hoursSinceLastRun = (Date.now() - this.cleanupStats.lastRun) / (1000 * 60 * 60);
       if (hoursSinceLastRun > 25) {
         health.status = 'warning';
         health.issues.push(`Last cleanup was ${hoursSinceLastRun.toFixed(1)} hours ago`);
       }
     }

     // Check error rate
     const recentErrors = this.cleanupStats.errors.filter(
       e => Date.now() - e.timestamp < 24 * 60 * 60 * 1000
     );
     if (recentErrors.length > 10) {
       health.status = 'warning';
       health.issues.push(`${recentErrors.length} errors in last 24 hours`);
     }

     // Check queue health
     const queueStats = await QueueService.getQueueStats('cleanup_task');
     if (queueStats.failed > 50) {
       health.status = 'warning';
       health.issues.push(`${queueStats.failed} failed cleanup jobs`);
     }

     return health;

   } catch (error) {
     logger.error('Error in cleanup health check:', error);
     return {
       status: 'unhealthy',
       issues: ['Health check failed'],
       error: error.message,
     };
   }
 }

 /**
  * Shutdown cleanup workers gracefully
  */
 async shutdown() {
   logger.info('Shutting down cleanup job workers...');

   try {
     // Generate final report
     await this.generateCleanupReport();

     // Stop cron jobs
     for (const [name, job] of this.cronJobs) {
       job.stop();
       logger.info(`Stopped cron job: ${name}`);
     }

     // Wait for active cleanup jobs to complete
     await new Promise(resolve => setTimeout(resolve, 5000));

     this.isRunning = false;
     logger.info('✅ Cleanup job workers shut down successfully');

   } catch (error) {
     logger.error('Error during cleanup shutdown:', error);
   }
 }
}

export default new CleanupJob();