// src/jobs/matchingJob.js
import Bull from 'bull';
import mongoose from 'mongoose';
import cron from 'node-cron';
import Match from '../modules/match/match.model.js';
import User from '../modules/user/user.model.js';
import SwipeActivity from '../modules/swipe/swipeActivity.model.js';
import RecommendationAlgorithm from '../modules/match/recommendation.algorithm.js';
import CacheService from '../shared/services/cache.service.js';
import QueueService from '../shared/services/queue.service.js';
import MetricsService from '../shared/services/metrics.service.js';
import NotificationService from '../modules/notification/notification.service.js';
import logger from '../shared/utils/logger.js';
import { NOTIFICATION_TYPES, USER_CONSTANTS, MATCH_CONSTANTS } from '../config/constants.js';
import redis from '../config/redis.js';
import socketManager from '../config/socket.js';

class MatchingJob {
 constructor() {
   this.isRunning = false;
   this.workers = new Map();
   this.cronJobs = new Map();
   this.algorithm = new RecommendationAlgorithm();
 }

 /**
  * Initialize matching job workers
  */
 async initialize() {
   try {
     logger.info('🚀 Initializing matching job workers...');

     // Register queue processors
     await this.registerQueueProcessors();

     // Setup cron jobs
     this.setupCronJobs();

     // Setup monitoring
     this.setupMonitoring();

     // Initialize algorithm
     await this.algorithm.initialize();

     this.isRunning = true;
     logger.info('✅ Matching job workers initialized successfully');
   } catch (error) {
     logger.error('Failed to initialize matching jobs:', error);
     throw error;
   }
 }

 /**
  * Register all queue processors
  */
 async registerQueueProcessors() {
   // Process new matches
   QueueService.process('match_created', 5, async (job) => {
     return await this.processNewMatch(job);
   });

   // Process mutual likes check
   QueueService.process('check_mutual_like', 10, async (job) => {
     return await this.checkMutualLike(job);
   });

   // Generate recommendations
   QueueService.process('generate_recommendations', 3, async (job) => {
     return await this.generateRecommendations(job);
   });

   // Update compatibility scores
   QueueService.process('update_compatibility', 2, async (job) => {
     return await this.updateCompatibilityScores(job);
   });

   // Process super likes
   QueueService.process('process_super_like', 5, async (job) => {
     return await this.processSuperLike(job);
   });

   // Analyze user behavior
   QueueService.process('analyze_user_behavior', 2, async (job) => {
     return await this.analyzeUserBehavior(job);
   });

   // Process boost activation
   QueueService.process('activate_boost', 5, async (job) => {
     return await this.processBoostActivation(job);
   });

   // Calculate ELO scores
   QueueService.process('calculate_elo', 3, async (job) => {
     return await this.calculateEloScore(job);
   });

   // Process unmatch
   QueueService.process('process_unmatch', 5, async (job) => {
     return await this.processUnmatch(job);
   });

   logger.info('✅ Registered all matching queue processors');
 }

 /**
  * Process new match creation
  */
 async processNewMatch(job) {
   const { user1Id, user2Id, matchType = 'normal' } = job.data;
   const startTime = Date.now();

   const session = await mongoose.startSession();
   session.startTransaction();

   try {
     logger.info(`Processing new match: ${user1Id} <-> ${user2Id}`);

     // Check if match already exists
     const existingMatch = await Match.findOne({
       $or: [
         { user1: user1Id, user2: user2Id },
         { user1: user2Id, user2: user1Id },
       ],
       status: 'active',
     }).session(session);

     if (existingMatch) {
       logger.warn(`Match already exists between ${user1Id} and ${user2Id}`);
       await session.abortTransaction();
       return { success: false, reason: 'match_already_exists' };
     }

     // Get both users
     const [user1, user2] = await Promise.all([
       User.findById(user1Id).select('profile preferences isPremium boostInfo').session(session),
       User.findById(user2Id).select('profile preferences isPremium boostInfo').session(session),
     ]);

     if (!user1 || !user2) {
       throw new Error('One or both users not found');
     }

     // Calculate compatibility score
     const compatibilityScore = await this.algorithm.calculateCompatibility(user1, user2);

     // Create match
     const match = new Match({
       user1: user1Id,
       user2: user2Id,
       matchedAt: new Date(),
       matchType,
       compatibility: {
         score: compatibilityScore.overall,
         factors: compatibilityScore.factors,
         calculatedAt: new Date(),
       },
       metadata: {
         user1Location: user1.profile.location,
         user2Location: user2.profile.location,
         distance: compatibilityScore.distance,
       },
     });

     await match.save({ session });

     // Update user statistics
     await Promise.all([
       User.findByIdAndUpdate(
         user1Id,
         {
           $inc: { 
             'statistics.matchesCount': 1,
             'statistics.weeklyMatches': 1,
           },
           $set: { 'statistics.lastMatchAt': new Date() },
           $push: { 
             'activityLog': {
               action: 'match_created',
               timestamp: new Date(),
               data: { matchId: match._id, userId: user2Id },
             },
           },
         },
         { session }
       ),
       User.findByIdAndUpdate(
         user2Id,
         {
           $inc: { 
             'statistics.matchesCount': 1,
             'statistics.weeklyMatches': 1,
           },
           $set: { 'statistics.lastMatchAt': new Date() },
           $push: { 
             'activityLog': {
               action: 'match_created',
               timestamp: new Date(),
               data: { matchId: match._id, userId: user1Id },
             },
           },
         },
         { session }
       ),
     ]);

     await session.commitTransaction();

     // Clear caches
     await Promise.all([
       CacheService.invalidateUser(user1Id),
       CacheService.invalidateUser(user2Id),
       CacheService.invalidatePattern(`matches:${user1Id}:*`),
       CacheService.invalidatePattern(`matches:${user2Id}:*`),
       CacheService.invalidateRecommendations(user1Id),
       CacheService.invalidateRecommendations(user2Id),
     ]);

     // Send notifications
     await Promise.all([
       QueueService.addJob('notification_delivery', {
         userId: user1Id,
         notificationData: {
           type: NOTIFICATION_TYPES.NEW_MATCH,
           title: 'It\'s a Match! 🎉',
           body: `You and ${user2.profile.name} liked each other!`,
           senderId: user2Id,
           relatedEntities: { matchId: match._id },
           action: {
             type: 'navigate',
             target: 'match_detail',
             params: { matchId: match._id.toString() },
           },
           priority: 'high',
         },
       }),
       QueueService.addJob('notification_delivery', {
         userId: user2Id,
         notificationData: {
           type: NOTIFICATION_TYPES.NEW_MATCH,
           title: 'It\'s a Match! 🎉',
           body: `You and ${user1.profile.name} liked each other!`,
           senderId: user1Id,
           relatedEntities: { matchId: match._id },
           action: {
             type: 'navigate',
             target: 'match_detail',
             params: { matchId: match._id.toString() },
           },
           priority: 'high',
         },
       }),
     ]);

     // Emit real-time events
     const io = socketManager.getIO();
     if (io) {
       io.to(`user:${user1Id}`).emit('match:new', {
         matchId: match._id,
         user: {
           _id: user2._id,
           name: user2.profile.name,
           avatar: user2.profile.photos?.[0],
         },
         matchedAt: match.matchedAt,
       });

       io.to(`user:${user2Id}`).emit('match:new', {
         matchId: match._id,
         user: {
           _id: user1._id,
           name: user1.profile.name,
           avatar: user1.profile.photos?.[0],
         },
         matchedAt: match.matchedAt,
       });
     }

     // Queue follow-up tasks
     await Promise.all([
       // Update ELO scores
       QueueService.addJob('calculate_elo', {
         winnerId: user1Id,
         loserId: null,
         isDraw: true,
         matchId: match._id,
       }, { delay: 1000 }),

       // Generate new recommendations
       QueueService.addJob('generate_recommendations', {
         userId: user1Id,
         trigger: 'new_match',
       }, { delay: 5000 }),
       
       QueueService.addJob('generate_recommendations', {
         userId: user2Id,
         trigger: 'new_match',
       }, { delay: 5000 }),
     ]);

     // Track metrics
     await MetricsService.incrementCounter('matches.created');
     await MetricsService.incrementCounter(`matches.type.${matchType}`);
     await MetricsService.histogram('matches.compatibility_score', compatibilityScore.overall);
     await MetricsService.trackUserAction(user1Id, 'match_created', {
       matchId: match._id,
       partnerId: user2Id,
       compatibilityScore: compatibilityScore.overall,
     });

     logger.info(`Match created successfully: ${match._id} (${Date.now() - startTime}ms)`);

     return {
       success: true,
       matchId: match._id,
       compatibilityScore: compatibilityScore.overall,
       duration: Date.now() - startTime,
     };

   } catch (error) {
     await session.abortTransaction();
     logger.error(`Error creating match between ${user1Id} and ${user2Id}:`, error);
     
     await MetricsService.incrementCounter('matches.failed');
     throw error;
   } finally {
     session.endSession();
   }
 }

 /**
  * Check for mutual likes
  */
 async checkMutualLike(job) {
   const { likerId, likedId, action } = job.data;

   try {
     logger.info(`Checking mutual like: ${likerId} -> ${likedId}`);

     // Check if the other person already liked back
     const reciprocalSwipe = await SwipeActivity.findOne({
       userId: likedId,
       targetUserId: likerId,
       action: { $in: ['like', 'super_like'] },
       createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // Within 30 days
     });

     if (reciprocalSwipe) {
       // It's a match!
       logger.info(`Mutual like detected: ${likerId} <-> ${likedId}`);

       // Determine match type
       const matchType = (action === 'super_like' || reciprocalSwipe.action === 'super_like') 
         ? 'super_like' 
         : 'normal';

       // Queue match creation
       await QueueService.addJob('match_created', {
         user1Id: likerId,
         user2Id: likedId,
         matchType,
       }, { priority: 1 });

       // Track metrics
       await MetricsService.incrementCounter('matches.mutual_likes');

       return { success: true, isMatch: true, matchType };
     }

     // Not a match yet, but track the like
     await this.trackPotentialMatch(likerId, likedId);

     return { success: true, isMatch: false };

   } catch (error) {
     logger.error(`Error checking mutual like between ${likerId} and ${likedId}:`, error);
     throw error;
   }
 }

 /**
  * Generate recommendations for a user
  */
 async generateRecommendations(job) {
   const { userId, count = 10, trigger = 'manual' } = job.data;
   const startTime = Date.now();

   try {
     logger.info(`Generating ${count} recommendations for user ${userId} (trigger: ${trigger})`);

     // Get user with full profile
     const user = await User.findById(userId)
       .populate('preferences')
       .lean();

     if (!user) {
       throw new Error('User not found');
     }

     // Check if user has location
     if (!user.profile?.location?.coordinates) {
       logger.warn(`User ${userId} has no location set`);
       return { success: false, reason: 'no_location' };
     }

     // Get user's swipe history
     const [swipedUserIds, matches] = await Promise.all([
       this.getSwipedUserIds(userId, 90), // Last 90 days
       this.getUserMatches(userId),
     ]);

     // Build recommendation pipeline
     const pipeline = await this.algorithm.buildRecommendationPipeline(user, {
       excludeIds: [...swipedUserIds, ...matches],
       limit: count * 3, // Get extra for filtering
     });

     // Execute pipeline
     let recommendations = await User.aggregate(pipeline);

     // Apply ML-based scoring if available
     if (user.isPremium) {
       recommendations = await this.applyMLScoring(user, recommendations);
     }

     // Apply diversity boost
     recommendations = this.applyDiversityBoost(recommendations);

     // Limit to requested count
     recommendations = recommendations.slice(0, count);

     // Cache recommendations
     await CacheService.cacheRecommendations(userId, recommendations, 1800); // 30 minutes

     // Store in Redis for quick access
     const recommendationIds = recommendations.map(r => r._id.toString());
     const key = `recommendations:${userId}:current`;
     await redis.del(key);
     if (recommendationIds.length > 0) {
       await redis.lpush(key, ...recommendationIds);
       await redis.expire(key, 3600); // 1 hour
     }

     // Track metrics
     await MetricsService.incrementCounter('recommendations.generated');
     await MetricsService.histogram('recommendations.count', recommendations.length);
     await MetricsService.trackUserAction(userId, 'recommendations_generated', {
       count: recommendations.length,
       trigger,
       duration: Date.now() - startTime,
     });

     // Update user's last recommendation time
     await User.findByIdAndUpdate(userId, {
       $set: { 'metadata.lastRecommendationAt': new Date() },
     });

     logger.info(`Generated ${recommendations.length} recommendations for user ${userId} (${Date.now() - startTime}ms)`);

     return {
       success: true,
       count: recommendations.length,
       recommendations: recommendations.map(r => r._id),
       duration: Date.now() - startTime,
     };

   } catch (error) {
     logger.error(`Error generating recommendations for user ${userId}:`, error);
     await MetricsService.incrementCounter('recommendations.failed');
     throw error;
   }
 }

 /**
  * Update compatibility scores for existing matches
  */
 async updateCompatibilityScores(job) {
   const { matchId, userId1, userId2 } = job.data;

   try {
     logger.info(`Updating compatibility scores for match ${matchId || `${userId1} <-> ${userId2}`}`);

     let match;
     if (matchId) {
       match = await Match.findById(matchId);
     } else {
       match = await Match.findOne({
         $or: [
           { user1: userId1, user2: userId2 },
           { user1: userId2, user2: userId1 },
         ],
         status: 'active',
       });
     }

     if (!match) {
       logger.warn('Match not found for compatibility update');
       return { success: false, reason: 'match_not_found' };
     }

     // Get both users
     const [user1, user2] = await Promise.all([
       User.findById(match.user1),
       User.findById(match.user2),
     ]);

     // Recalculate compatibility
     const newScore = await this.algorithm.calculateCompatibility(user1, user2);

     // Update match with new score
     match.compatibility = {
       score: newScore.overall,
       factors: newScore.factors,
       calculatedAt: new Date(),
       previousScore: match.compatibility?.score,
     };

     // Add interaction-based adjustments
     const interactionScore = await this.calculateInteractionScore(match);
     match.compatibility.interactionScore = interactionScore;
     match.compatibility.adjustedScore = (newScore.overall * 0.7 + interactionScore * 0.3);

     await match.save();

     // Track metrics
     await MetricsService.histogram('compatibility.scores', newScore.overall);
     await MetricsService.incrementCounter('compatibility.updates');

     logger.info(`Updated compatibility score for match ${match._id}: ${newScore.overall}`);

     return {
       success: true,
       matchId: match._id,
       oldScore: match.compatibility.previousScore,
       newScore: newScore.overall,
       adjustedScore: match.compatibility.adjustedScore,
     };

   } catch (error) {
     logger.error('Error updating compatibility scores:', error);
     throw error;
   }
 }

 /**
  * Process super like
  */
 async processSuperLike(job) {
   const { likerId, likedId } = job.data;

   try {
     logger.info(`Processing super like: ${likerId} -> ${likedId}`);

     // Get both users
     const [liker, liked] = await Promise.all([
       User.findById(likerId).select('profile isPremium dailySuperLikes'),
       User.findById(likedId).select('profile notificationPreferences'),
     ]);

     if (!liker || !liked) {
       throw new Error('User(s) not found');
     }

     // Check super like limit
     const superLikeLimit = liker.isPremium ? 5 : 1;
     if (liker.dailySuperLikes >= superLikeLimit) {
       return { success: false, reason: 'super_like_limit_reached' };
     }

     // Increment daily super likes
     await User.findByIdAndUpdate(likerId, {
       $inc: { dailySuperLikes: 1 },
     });

     // Send notification to liked user
     await QueueService.addJob('notification_delivery', {
       userId: likedId,
       notificationData: {
         type: NOTIFICATION_TYPES.SUPER_LIKE,
         title: 'Someone Super Liked You! ⭐',
         body: `${liker.profile.name} super liked your profile!`,
         senderId: likerId,
         action: {
           type: 'navigate',
           target: 'profile',
           params: { userId: likerId },
         },
         priority: 'high',
       },
     });

     // Boost visibility in recommendations
     await this.boostUserVisibility(likerId, likedId, 24); // 24 hours boost

     // Check for mutual like
     await QueueService.addJob('check_mutual_like', {
       likerId,
       likedId,
       action: 'super_like',
     });

     // Track metrics
     await MetricsService.incrementCounter('super_likes.sent');
     await MetricsService.trackUserAction(likerId, 'super_like', {
       targetUserId: likedId,
     });

     logger.info(`Super like processed: ${likerId} -> ${likedId}`);

     return { success: true };

   } catch (error) {
     logger.error(`Error processing super like from ${likerId} to ${likedId}:`, error);
     throw error;
   }
 }

 /**
  * Analyze user behavior for better matching
  */
 async analyzeUserBehavior(job) {
   const { userId, period = 30 } = job.data;

   try {
     logger.info(`Analyzing behavior for user ${userId} (last ${period} days)`);

     const startDate = new Date();
     startDate.setDate(startDate.getDate() - period);

     // Get user's swipe activity
     const swipeActivity = await SwipeActivity.aggregate([
       {
         $match: {
           userId: mongoose.Types.ObjectId(userId),
           createdAt: { $gte: startDate },
         },
       },
       {
         $lookup: {
           from: 'users',
           localField: 'targetUserId',
           foreignField: '_id',
           as: 'targetUser',
         },
       },
       { $unwind: '$targetUser' },
       {
         $group: {
           _id: '$action',
           count: { $sum: 1 },
           avgAge: { $avg: '$targetUser.profile.age' },
           locations: { $addToSet: '$targetUser.profile.location.city' },
           interests: { $push: '$targetUser.profile.interests' },
         },
       },
     ]);

     // Calculate patterns
     const patterns = {
       swipeRightRate: 0,
       avgPreferredAge: 0,
       topInterests: [],
       preferredLocations: [],
       activityLevel: 'low',
     };

     const totalSwipes = swipeActivity.reduce((sum, a) => sum + a.count, 0);
     const likes = swipeActivity.find(a => a._id === 'like');
     const superLikes = swipeActivity.find(a => a._id === 'super_like');

     if (totalSwipes > 0) {
       patterns.swipeRightRate = ((likes?.count || 0) + (superLikes?.count || 0)) / totalSwipes;
       patterns.avgPreferredAge = likes?.avgAge || 0;

       // Calculate top interests
       const allInterests = (likes?.interests || []).flat();
       const interestCounts = {};
       allInterests.forEach(interest => {
         interestCounts[interest] = (interestCounts[interest] || 0) + 1;
       });
       patterns.topInterests = Object.entries(interestCounts)
         .sort((a, b) => b[1] - a[1])
         .slice(0, 5)
         .map(([interest]) => interest);

       // Activity level
       const dailyAvg = totalSwipes / period;
       if (dailyAvg >= 50) patterns.activityLevel = 'very_high';
       else if (dailyAvg >= 20) patterns.activityLevel = 'high';
       else if (dailyAvg >= 10) patterns.activityLevel = 'medium';
       else patterns.activityLevel = 'low';
     }

     // Update user preferences based on behavior
     await User.findByIdAndUpdate(userId, {
       $set: {
         'metadata.behaviorPatterns': patterns,
         'metadata.lastBehaviorAnalysis': new Date(),
       },
     });

     // Adjust recommendation weights
     await this.adjustRecommendationWeights(userId, patterns);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'behavior_analyzed', patterns);

     logger.info(`Behavior analysis completed for user ${userId}`);

     return {
       success: true,
       patterns,
       totalSwipes,
     };

   } catch (error) {
     logger.error(`Error analyzing behavior for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Process boost activation
  */
 async processBoostActivation(job) {
   const { userId, duration = 30 } = job.data; // Duration in minutes

   try {
     logger.info(`Activating boost for user ${userId} (${duration} minutes)`);

     const user = await User.findById(userId);
     if (!user) {
       throw new Error('User not found');
     }

     // Check if already boosted
     if (user.boostInfo?.isActive && user.boostInfo?.expiresAt > new Date()) {
       return { success: false, reason: 'already_boosted' };
     }

     // Activate boost
     const expiresAt = new Date(Date.now() + duration * 60 * 1000);
     
     await User.findByIdAndUpdate(userId, {
       $set: {
         'boostInfo.isActive': true,
         'boostInfo.activatedAt': new Date(),
         'boostInfo.expiresAt': expiresAt,
         'boostInfo.multiplier': user.isPremium ? 10 : 5,
       },
       $inc: { 'boostInfo.totalBoosts': 1 },
     });

     // Clear user's recommendation cache to reflect boost
     await CacheService.invalidatePattern(`recommendations:*:${userId}`);

     // Schedule boost expiration
     await QueueService.addJob(
       'expire_boost',
       { userId },
       { delay: duration * 60 * 1000 }
     );

     // Track boost views
     this.trackBoostViews(userId, duration);

     // Send confirmation notification
     await QueueService.addJob('notification_delivery', {
       userId,
       notificationData: {
         type: NOTIFICATION_TYPES.BOOST_ACTIVATED,
         title: '🚀 Boost Activated!',
         body: `Your profile is now boosted for ${duration} minutes. Get ready for more matches!`,
         priority: 'high',
       },
     });

     // Track metrics
     await MetricsService.incrementCounter('boosts.activated');
     await MetricsService.histogram('boosts.duration', duration);

     logger.info(`Boost activated for user ${userId} until ${expiresAt}`);

     return {
       success: true,
       expiresAt,
       multiplier: user.isPremium ? 10 : 5,
     };

   } catch (error) {
     logger.error(`Error activating boost for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Calculate ELO score
  */
 async calculateEloScore(job) {
   const { winnerId, loserId, isDraw = false, matchId } = job.data;

   try {
     logger.info(`Calculating ELO scores: winner=${winnerId}, loser=${loserId}, draw=${isDraw}`);

     const K = 32; // K-factor for ELO calculation

     if (isDraw && matchId) {
       // For mutual matches, both users gain slightly
       const match = await Match.findById(matchId).populate('user1 user2');
       
       const user1Elo = match.user1.eloScore || 1500;
       const user2Elo = match.user2.eloScore || 1500;

       const expectedScore1 = 1 / (1 + Math.pow(10, (user2Elo - user1Elo) / 400));
       const expectedScore2 = 1 / (1 + Math.pow(10, (user1Elo - user2Elo) / 400));

       const newElo1 = Math.round(user1Elo + K * (0.5 - expectedScore1));
       const newElo2 = Math.round(user2Elo + K * (0.5 - expectedScore2));

       await Promise.all([
         User.findByIdAndUpdate(match.user1._id, { eloScore: newElo1 }),
         User.findByIdAndUpdate(match.user2._id, { eloScore: newElo2 }),
       ]);

       logger.info(`ELO updated for match: ${match.user1._id}=${newElo1}, ${match.user2._id}=${newElo2}`);

       return { success: true, scores: { [match.user1._id]: newElo1, [match.user2._id]: newElo2 } };
     }

     if (winnerId && loserId) {
       // Standard win/loss scenario (e.g., one person liked, other passed)
       const [winner, loser] = await Promise.all([
         User.findById(winnerId).select('eloScore'),
         User.findById(loserId).select('eloScore'),
       ]);

       const winnerElo = winner.eloScore || 1500;
       const loserElo = loser.eloScore || 1500;

       const expectedScoreWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
       const expectedScoreLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));

       const newWinnerElo = Math.round(winnerElo + K * (1 - expectedScoreWinner));
       const newLoserElo = Math.round(loserElo + K * (0 - expectedScoreLoser));

       await Promise.all([
         User.findByIdAndUpdate(winnerId, { eloScore: newWinnerElo }),
         User.findByIdAndUpdate(loserId, { eloScore: newLoserElo }),
       ]);

       logger.info(`ELO updated: winner=${newWinnerElo}, loser=${newLoserElo}`);

       return { success: true, scores: { [winnerId]: newWinnerElo, [loserId]: newLoserElo } };
     }

     return { success: false, reason: 'invalid_parameters' };

   } catch (error) {
     logger.error('Error calculating ELO scores:', error);
     throw error;
   }
 }

 /**
  * Process unmatch
  */
 async processUnmatch(job) {
   const { matchId, initiatorId, reason } = job.data;

   const session = await mongoose.startSession();
   session.startTransaction();

   try {
     logger.info(`Processing unmatch: ${matchId} by ${initiatorId}`);

     const match = await Match.findById(matchId).session(session);
     if (!match) {
       throw new Error('Match not found');
     }

     // Update match status
     match.status = 'unmatched';
     match.unmatchedAt = new Date();
     match.unmatchedBy = initiatorId;
     match.unmatchReason = reason;
     await match.save({ session });

     // Get the other user
     const otherUserId = match.user1.toString() === initiatorId 
       ? match.user2 
       : match.user1;

     // Update user statistics
     await Promise.all([
       User.findByIdAndUpdate(
         initiatorId,
         {
           $inc: { 'statistics.unmatchesInitiated': 1 },
           $push: {
             'activityLog': {
               action: 'unmatch_initiated',
               timestamp: new Date(),
               data: { matchId, reason },
             },
           },
         },
         { session }
         ),
       User.findByIdAndUpdate(
         otherUserId,
         {
           $inc: { 'statistics.unmatchesReceived': 1 },
           $push: {
             'activityLog': {
               action: 'unmatch_received',
               timestamp: new Date(),
               data: { matchId, initiatorId },
             },
           },
         },
         { session }
       ),
     ]);

     await session.commitTransaction();

     // Clear caches
     await Promise.all([
       CacheService.invalidatePattern(`matches:${initiatorId}:*`),
       CacheService.invalidatePattern(`matches:${otherUserId}:*`),
       CacheService.delete(`match:${matchId}`),
     ]);

     // Send notification to the other user (optional based on settings)
     const otherUser = await User.findById(otherUserId).select('notificationPreferences');
     if (otherUser?.notificationPreferences?.unmatchNotifications !== false) {
       await QueueService.addJob('notification_delivery', {
         userId: otherUserId,
         notificationData: {
           type: NOTIFICATION_TYPES.UNMATCH,
           title: 'Match Update',
           body: 'One of your matches has ended',
           category: 'match',
           priority: 'low',
         },
       });
     }

     // Emit socket event
     const io = socketManager.getIO();
     if (io) {
       io.to(`user:${otherUserId}`).emit('match:removed', {
         matchId: match._id,
       });
     }

     // Track metrics
     await MetricsService.incrementCounter('matches.unmatched');
     await MetricsService.incrementCounter(`matches.unmatch_reason.${reason || 'unknown'}`);

     logger.info(`Unmatch processed: ${matchId}`);

     return {
       success: true,
       matchId,
     };

   } catch (error) {
     await session.abortTransaction();
     logger.error(`Error processing unmatch ${matchId}:`, error);
     throw error;
   } finally {
     session.endSession();
   }
 }

 /**
  * Setup cron jobs
  */
 setupCronJobs() {
   // Generate daily recommendations - 9 AM daily
   this.cronJobs.set('daily_recommendations', cron.schedule('0 9 * * *', async () => {
     try {
       await this.generateDailyRecommendations();
     } catch (error) {
       logger.error('Error in daily recommendations cron:', error);
     }
   }));

   // Update compatibility scores - Every 6 hours
   this.cronJobs.set('update_compatibility', cron.schedule('0 */6 * * *', async () => {
     try {
       await this.updateAllCompatibilityScores();
     } catch (error) {
       logger.error('Error in compatibility update cron:', error);
     }
   }));

   // Reset daily super likes - Midnight daily
   this.cronJobs.set('reset_super_likes', cron.schedule('0 0 * * *', async () => {
     try {
       await this.resetDailySuperLikes();
     } catch (error) {
       logger.error('Error in super likes reset cron:', error);
     }
   }));

   // Analyze user behavior - 2 AM daily
   this.cronJobs.set('behavior_analysis', cron.schedule('0 2 * * *', async () => {
     try {
       await this.analyzeAllUserBehavior();
     } catch (error) {
       logger.error('Error in behavior analysis cron:', error);
     }
   }));

   // Clean up expired boosts - Every 5 minutes
   this.cronJobs.set('expire_boosts', cron.schedule('*/5 * * * *', async () => {
     try {
       await this.expireBoosts();
     } catch (error) {
       logger.error('Error in boost expiration cron:', error);
     }
   }));

   // Calculate weekly statistics - Sundays at midnight
   this.cronJobs.set('weekly_stats', cron.schedule('0 0 * * 0', async () => {
     try {
       await this.calculateWeeklyStats();
     } catch (error) {
       logger.error('Error in weekly stats cron:', error);
     }
   }));

   // Reactivate dormant matches - Every day at 3 PM
   this.cronJobs.set('reactivate_matches', cron.schedule('0 15 * * *', async () => {
     try {
       await this.reactivateDormantMatches();
     } catch (error) {
       logger.error('Error in match reactivation cron:', error);
     }
   }));

   // Clean up old swipe data - Weekly on Mondays at 4 AM
   this.cronJobs.set('cleanup_swipes', cron.schedule('0 4 * * 1', async () => {
     try {
       await this.cleanupOldSwipeData();
     } catch (error) {
       logger.error('Error in swipe cleanup cron:', error);
     }
   }));

   logger.info('✅ Matching cron jobs scheduled');
 }

 /**
  * Generate daily recommendations for active users
  */
 async generateDailyRecommendations() {
   try {
     logger.info('Starting daily recommendation generation');

     // Get active users
     const yesterday = new Date();
     yesterday.setDate(yesterday.getDate() - 1);

     const activeUsers = await User.find({
       status: 'active',
       lastActiveAt: { $gte: yesterday },
       'notificationPreferences.dailyRecommendations': { $ne: false },
     })
       .select('_id')
       .limit(10000);

     let generated = 0;
     const batchSize = 50;

     for (let i = 0; i < activeUsers.length; i += batchSize) {
       const batch = activeUsers.slice(i, i + batchSize);
       
       const jobs = batch.map(user => ({
         name: 'generate_recommendations',
         data: {
           userId: user._id.toString(),
           count: 20,
           trigger: 'daily_cron',
         },
         opts: {
           priority: 3,
           delay: Math.random() * 60000, // Spread over 1 minute
         },
       }));

       await QueueService.addBulkJobs(jobs);
       generated += batch.length;

       // Rate limiting
       if (i + batchSize < activeUsers.length) {
         await new Promise(resolve => setTimeout(resolve, 1000));
       }
     }

     logger.info(`Queued daily recommendations for ${generated} users`);
     await MetricsService.incrementCounter('recommendations.daily_generation', generated);

   } catch (error) {
     logger.error('Error generating daily recommendations:', error);
   }
 }

 /**
  * Update all compatibility scores
  */
 async updateAllCompatibilityScores() {
   try {
     logger.info('Starting compatibility score updates');

     // Get active matches that haven't been updated recently
     const twelveHoursAgo = new Date();
     twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);

     const matches = await Match.find({
       status: 'active',
       $or: [
         { 'compatibility.calculatedAt': { $lt: twelveHoursAgo } },
         { 'compatibility.calculatedAt': { $exists: false } },
       ],
     })
       .select('_id user1 user2')
       .limit(1000);

     const jobs = matches.map(match => ({
       name: 'update_compatibility',
       data: {
         matchId: match._id.toString(),
         userId1: match.user1.toString(),
         userId2: match.user2.toString(),
       },
       opts: {
         priority: 4,
         delay: Math.random() * 300000, // Spread over 5 minutes
       },
     }));

     await QueueService.addBulkJobs(jobs);

     logger.info(`Queued compatibility updates for ${matches.length} matches`);
     await MetricsService.incrementCounter('compatibility.batch_updates', matches.length);

   } catch (error) {
     logger.error('Error updating compatibility scores:', error);
   }
 }

 /**
  * Reset daily super likes
  */
 async resetDailySuperLikes() {
   try {
     logger.info('Resetting daily super likes');

     const result = await User.updateMany(
       { dailySuperLikes: { $gt: 0 } },
       { $set: { dailySuperLikes: 0 } }
     );

     logger.info(`Reset super likes for ${result.modifiedCount} users`);
     await MetricsService.gauge('super_likes.daily_reset', result.modifiedCount);

   } catch (error) {
     logger.error('Error resetting daily super likes:', error);
   }
 }

 /**
  * Analyze all user behavior
  */
 async analyzeAllUserBehavior() {
   try {
     logger.info('Starting user behavior analysis');

     // Get users who were active in the last week
     const oneWeekAgo = new Date();
     oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

     const activeUsers = await User.find({
       lastActiveAt: { $gte: oneWeekAgo },
       $or: [
         { 'metadata.lastBehaviorAnalysis': { $lt: oneWeekAgo } },
         { 'metadata.lastBehaviorAnalysis': { $exists: false } },
       ],
     })
       .select('_id')
       .limit(5000);

     const jobs = activeUsers.map(user => ({
       name: 'analyze_user_behavior',
       data: {
         userId: user._id.toString(),
         period: 30,
       },
       opts: {
         priority: 5,
         delay: Math.random() * 600000, // Spread over 10 minutes
       },
     }));

     await QueueService.addBulkJobs(jobs);

     logger.info(`Queued behavior analysis for ${activeUsers.length} users`);

   } catch (error) {
     logger.error('Error in batch behavior analysis:', error);
   }
 }

 /**
  * Expire active boosts
  */
 async expireBoosts() {
   try {
     const now = new Date();

     const result = await User.updateMany(
       {
         'boostInfo.isActive': true,
         'boostInfo.expiresAt': { $lt: now },
       },
       {
         $set: { 'boostInfo.isActive': false },
       }
     );

     if (result.modifiedCount > 0) {
       logger.info(`Expired ${result.modifiedCount} boosts`);
       await MetricsService.incrementCounter('boosts.expired', result.modifiedCount);
     }

   } catch (error) {
     logger.error('Error expiring boosts:', error);
   }
 }

 /**
  * Calculate weekly statistics
  */
 async calculateWeeklyStats() {
   try {
     logger.info('Calculating weekly statistics');

     // Reset weekly counters
     await User.updateMany(
       { 'statistics.weeklyMatches': { $gt: 0 } },
       { $set: { 'statistics.weeklyMatches': 0 } }
     );

     // Generate weekly report
     const oneWeekAgo = new Date();
     oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

     const stats = await Match.aggregate([
       {
         $match: {
           matchedAt: { $gte: oneWeekAgo },
         },
       },
       {
         $group: {
           _id: null,
           total: { $sum: 1 },
           avgCompatibility: { $avg: '$compatibility.score' },
           byType: {
             $push: '$matchType',
           },
         },
       },
     ]);

     if (stats[0]) {
       logger.info('Weekly stats:', stats[0]);
       await MetricsService.gauge('weekly.matches_total', stats[0].total);
       await MetricsService.gauge('weekly.avg_compatibility', stats[0].avgCompatibility);
     }

   } catch (error) {
     logger.error('Error calculating weekly stats:', error);
   }
 }

 /**
  * Reactivate dormant matches
  */
 async reactivateDormantMatches() {
   try {
     logger.info('Checking for dormant matches to reactivate');

     // Find matches with no recent messages
     const threeDaysAgo = new Date();
     threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

     const dormantMatches = await Match.aggregate([
       {
         $match: {
           status: 'active',
           matchedAt: { $lt: threeDaysAgo },
           lastMessageAt: {
             $lt: new Date(Date.now() - 72 * 60 * 60 * 1000),
           },
         },
       },
       { $limit: 100 },
       {
         $lookup: {
           from: 'users',
           localField: 'user1',
           foreignField: '_id',
           as: 'user1Data',
         },
       },
       {
         $lookup: {
           from: 'users',
           localField: 'user2',
           foreignField: '_id',
           as: 'user2Data',
         },
       },
     ]);

     for (const match of dormantMatches) {
       // Send conversation starter suggestions
       await Promise.all([
         QueueService.addJob('notification_delivery', {
           userId: match.user1.toString(),
           notificationData: {
             type: NOTIFICATION_TYPES.CONVERSATION_STARTER,
             title: '💬 Keep the conversation going!',
             body: `Don't let your match with ${match.user2Data[0]?.profile?.name} fade away`,
             relatedEntities: { matchId: match._id },
             action: {
               type: 'navigate',
               target: 'chat',
               params: { matchId: match._id.toString() },
             },
             priority: 'low',
           },
         }),
       ]);
     }

     logger.info(`Sent reactivation for ${dormantMatches.length} dormant matches`);

   } catch (error) {
     logger.error('Error reactivating dormant matches:', error);
   }
 }

 /**
  * Clean up old swipe data
  */
 async cleanupOldSwipeData() {
   try {
     logger.info('Cleaning up old swipe data');

     const ninetyDaysAgo = new Date();
     ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

     const result = await SwipeActivity.deleteMany({
       createdAt: { $lt: ninetyDaysAgo },
       action: 'pass',
     });

     logger.info(`Deleted ${result.deletedCount} old swipe records`);
     await MetricsService.incrementCounter('cleanup.swipes_deleted', result.deletedCount);

   } catch (error) {
     logger.error('Error cleaning up swipe data:', error);
   }
 }

 /**
  * Setup monitoring
  */
 setupMonitoring() {
   // Monitor queue health
   setInterval(async () => {
     try {
       const queues = [
         'match_created',
         'check_mutual_like',
         'generate_recommendations',
         'update_compatibility',
       ];

       for (const queueName of queues) {
         const stats = await QueueService.getQueueStats(queueName);
         
         if (stats.waiting > 500) {
           logger.warn(`Queue ${queueName} has ${stats.waiting} waiting jobs`);
         }
         
         await MetricsService.gauge(`queue.${queueName}.waiting`, stats.waiting);
         await MetricsService.gauge(`queue.${queueName}.active`, stats.active);
       }
     } catch (error) {
       logger.error('Error monitoring matching queues:', error);
     }
   }, 30000);

   // Monitor match rate
   setInterval(async () => {
     try {
       const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
       const recentMatches = await Match.countDocuments({
         matchedAt: { $gte: fiveMinutesAgo },
       });

       await MetricsService.gauge('matches.rate_5min', recentMatches);

     } catch (error) {
       logger.error('Error monitoring match rate:', error);
     }
   }, 60000);

   logger.info('✅ Matching monitoring started');
 }

 // Helper Methods

 /**
  * Get swiped user IDs
  */
 async getSwipedUserIds(userId, days = 30) {
   const cutoff = new Date();
   cutoff.setDate(cutoff.getDate() - days);

   const swipes = await SwipeActivity.find({
     userId,
     createdAt: { $gte: cutoff },
   }).select('targetUserId');

   return swipes.map(s => s.targetUserId);
 }

 /**
  * Get user matches
  */
 async getUserMatches(userId) {
   const matches = await Match.find({
     $or: [
       { user1: userId },
       { user2: userId },
     ],
     status: 'active',
   }).select('user1 user2');

   return matches.map(m => 
     m.user1.toString() === userId ? m.user2 : m.user1
   );
 }

 /**
  * Apply ML scoring to recommendations
  */
 async applyMLScoring(user, recommendations) {
   // This would integrate with a ML model
   // For now, using a simplified scoring based on patterns
   
   const patterns = user.metadata?.behaviorPatterns;
   if (!patterns) return recommendations;

   return recommendations.map(rec => {
     let mlScore = rec.finalScore || 0;

     // Boost score based on matching patterns
     if (patterns.topInterests?.some(i => rec.profile?.interests?.includes(i))) {
       mlScore += 0.1;
     }

     if (Math.abs(rec.profile?.age - patterns.avgPreferredAge) < 3) {
       mlScore += 0.05;
     }

     rec.mlScore = Math.min(mlScore, 1);
     rec.finalScore = mlScore;
     return rec;
   }).sort((a, b) => b.finalScore - a.finalScore);
 }

 /**
  * Apply diversity boost to recommendations
  */
 applyDiversityBoost(recommendations) {
   // Ensure variety in recommendations
   const shuffled = [...recommendations];
   
   // Take top 30% as is, shuffle middle 50%, keep bottom 20%
   const topCount = Math.floor(recommendations.length * 0.3);
   const middleCount = Math.floor(recommendations.length * 0.5);
   
   const top = shuffled.slice(0, topCount);
   const middle = shuffled.slice(topCount, topCount + middleCount);
   const bottom = shuffled.slice(topCount + middleCount);

   // Shuffle middle section for diversity
   for (let i = middle.length - 1; i > 0; i--) {
     const j = Math.floor(Math.random() * (i + 1));
     [middle[i], middle[j]] = [middle[j], middle[i]];
   }

   return [...top, ...middle, ...bottom];
 }

 /**
  * Track potential match
  */
 async trackPotentialMatch(likerId, likedId) {
   const key = `potential_match:${likerId}:${likedId}`;
   await redis.setex(key, 2592000, '1'); // 30 days expiry
 }

 /**
  * Calculate interaction score for a match
  */
 async calculateInteractionScore(match) {
   // This would analyze message frequency, response time, etc.
   // Simplified version for now
   
   const hoursSinceMatch = (Date.now() - match.matchedAt) / (1000 * 60 * 60);
   const messagesExchanged = match.statistics?.messagesExchanged || 0;
   
   let score = 0.5; // Base score
   
   // Boost for active conversation
   if (messagesExchanged > 10) score += 0.2;
   if (messagesExchanged > 50) score += 0.2;
   
   // Penalty for no messages after time
   if (hoursSinceMatch > 24 && messagesExchanged === 0) score -= 0.2;
   
   return Math.max(0, Math.min(1, score));
 }

 /**
  * Boost user visibility temporarily
  */
 async boostUserVisibility(userId, targetUserId, hours) {
   const key = `visibility_boost:${targetUserId}:${userId}`;
   await redis.setex(key, hours * 3600, '1');
 }

 /**
  * Adjust recommendation weights based on behavior
  */
 async adjustRecommendationWeights(userId, patterns) {
   const weights = {
     distance: 0.2,
     interests: 0.25,
     attractiveness: 0.15,
     activity: 0.15,
     compatibility: 0.25,
   };

   // Adjust based on patterns
   if (patterns.activityLevel === 'very_high') {
     weights.activity = 0.25;
     weights.attractiveness = 0.1;
   }

   if (patterns.swipeRightRate < 0.1) {
     // Very selective user
     weights.compatibility = 0.35;
     weights.interests = 0.3;
   }

   // Store adjusted weights
   await CacheService.set(`recommendation_weights:${userId}`, weights, 86400);
 }

 /**
  * Track boost views
  */
 async trackBoostViews(userId, duration) {
   const interval = setInterval(async () => {
     const views = await redis.incr(`boost_views:${userId}`);
     await MetricsService.gauge(`boosts.views.${userId}`, views);
   }, 60000); // Every minute

   setTimeout(() => {
     clearInterval(interval);
     redis.del(`boost_views:${userId}`);
   }, duration * 60 * 1000);
 }

 /**
  * Shutdown job workers gracefully
  */
 async shutdown() {
   logger.info('Shutting down matching job workers...');

   // Stop cron jobs
   for (const [name, job] of this.cronJobs) {
     job.stop();
     logger.info(`Stopped cron job: ${name}`);
   }

   // Close queue connections
   await QueueService.closeAll();

   this.isRunning = false;
   logger.info('✅ Matching job workers shut down successfully');
 }
}

export default new MatchingJob();