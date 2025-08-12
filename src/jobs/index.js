import cron from 'node-cron';
import logger from '../shared/utils/logger.js';
import { cleanupExpiredData } from './cleanupJob.js';
import { generateDailyMatches } from './matchingJob.js';
import { sendPushNotifications } from './notificationJob.js';
import { resetDailyLimits } from './limitsJob.js';
import { calculateAnalytics } from './analyticsJob.js';

export function startBackgroundJobs() {
  logger.info('Starting background jobs...');

  // Reset daily limits at midnight
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running daily limits reset job');
    await resetDailyLimits();
  });

  // Cleanup expired data every hour
  cron.schedule('0 * * * *', async () => {
    logger.info('Running cleanup job');
    await cleanupExpiredData();
  });

  // Generate "Today's Picks" every day at 9 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Generating daily matches');
    await generateDailyMatches();
  });

  // Send engagement notifications every 4 hours
  cron.schedule('0 */4 * * *', async () => {
    logger.info('Sending push notifications');
    await sendPushNotifications();
  });

  // Calculate analytics every day at 2 AM
  cron.schedule('0 2 * * *', async () => {
    logger.info('Calculating analytics');
    await calculateAnalytics();
  });
}