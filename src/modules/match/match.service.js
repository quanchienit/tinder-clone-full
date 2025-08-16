// src/modules/match/match.service.js
import Match from './match.model.js';
import Swipe from './swipe.model.js';
import User from '../user/user.model.js';
import Message from '../chat/message.model.js';
import redis from '../../config/redis.js';
import socketManager from '../../config/socket.js';
import logger from '../../shared/utils/logger.js';
import CacheService from '../../shared/services/cache.service.js';
import NotificationService from '../../shared/services/notification.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import QueueService from '../../shared/services/queue.service.js';
import RecommendationAlgorithm from './algorithms/recommendation.algorithm.js';
import EloAlgorithm from './algorithms/elo.algorithm.js';
import AppError from '../../shared/errors/AppError.js';
import {
 SWIPE_ACTIONS,
 MATCH_STATUS,
 NOTIFICATION_TYPES,
 USER_CONSTANTS,
 ERROR_CODES,
 HTTP_STATUS,
 SOCKET_EVENTS,
 SUBSCRIPTION_FEATURES,
} from '../../config/constants.js';

class MatchService {
 /**
  * Process a swipe action
  * @param {string} fromUserId - User who is swiping
  * @param {string} toUserId - User being swiped on
  * @param {string} action - Swipe action (like, nope, superlike)
  * @param {Object} context - Additional context data
  */
 async processSwipe(fromUserId, toUserId, action, context = {}) {
   try {
     const startTime = Date.now();

     // Validate users
     if (fromUserId === toUserId) {
       throw new AppError('Cannot swipe on yourself', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
     }

     // Check if already swiped
     const existingSwipe = await Swipe.hasSwipedBefore(fromUserId, toUserId);
     if (existingSwipe) {
       throw new AppError('Already swiped on this user', HTTP_STATUS.CONFLICT, ERROR_CODES.ALREADY_EXISTS);
     }

     // Check daily limits
     const fromUser = await User.findById(fromUserId).select('subscription');
     const subscriptionType = fromUser?.subscription?.type || 'free';
     const limits = await Swipe.checkDailyLimits(fromUserId, subscriptionType);

     if (action === SWIPE_ACTIONS.LIKE && !limits.canLike) {
       throw new AppError(
         'Daily like limit reached. Upgrade to Premium for unlimited likes',
         HTTP_STATUS.FORBIDDEN,
         ERROR_CODES.LIMIT_EXCEEDED
       );
     }

     if (action === SWIPE_ACTIONS.SUPER_LIKE && !limits.canSuperLike) {
       throw new AppError(
         'No super likes remaining for today',
         HTTP_STATUS.FORBIDDEN,
         ERROR_CODES.LIMIT_EXCEEDED
       );
     }

     // Get user data for swipe context
     const [fromUserData, toUserData] = await Promise.all([
       this.getUserSwipeData(fromUserId),
       this.getUserSwipeData(toUserId),
     ]);

     // Calculate compatibility
     const compatibility = await this.calculateCompatibility(fromUserData, toUserData);

     // Create swipe record
     const swipeData = {
       from: fromUserId,
       to: toUserId,
       action,
       context: {
         source: context.source || 'recommendations',
         fromBoostedProfile: context.fromBoosted || false,
         toBoostedProfile: context.toBoosted || false,
         photoIndex: context.photoIndex || 0,
         viewDuration: context.viewDuration || 0,
         photosViewed: context.photosViewed || 1,
         bioViewed: context.bioViewed || false,
         distance: compatibility.distance,
         recommendation: context.recommendation,
       },
       device: {
         platform: context.platform || 'unknown',
         appVersion: context.appVersion,
         deviceId: context.deviceId,
       },
       location: {
         from: fromUserData.profile?.location,
         to: toUserData.profile?.location,
         calculatedDistance: compatibility.distance,
       },
       userStates: {
         from: {
           age: fromUserData.age,
           eloScore: fromUserData.scoring?.eloScore,
           profileCompleteness: fromUserData.scoring?.profileCompleteness,
           subscriptionType: fromUserData.subscription?.type,
           photosCount: fromUserData.profile?.photos?.length,
           isVerified: fromUserData.verification?.photo?.verified,
         },
         to: {
           age: toUserData.age,
           eloScore: toUserData.scoring?.eloScore,
           profileCompleteness: toUserData.scoring?.profileCompleteness,
           subscriptionType: toUserData.subscription?.type,
           photosCount: toUserData.profile?.photos?.length,
           isVerified: toUserData.verification?.photo?.verified,
         },
       },
       compatibility: {
         overallScore: compatibility.score,
         commonInterests: compatibility.commonInterests,
         commonInterestsCount: compatibility.commonInterests.length,
         ageCompatibility: compatibility.ageCompatibility,
         distanceCompatibility: compatibility.distanceCompatibility,
       },
       limits: {
         dailySwipeCount: limits.counts.total + 1,
         dailyLikeCount: limits.counts.likes + (action === SWIPE_ACTIONS.LIKE ? 1 : 0),
         dailySuperLikeCount: limits.counts.superLikes + (action === SWIPE_ACTIONS.SUPER_LIKE ? 1 : 0),
       },
     };

     // Add super like specific data
     if (action === SWIPE_ACTIONS.SUPER_LIKE) {
       swipeData.superLike = {
         message: context.message,
         wasDaily: limits.counts.superLikes === 0, // First super like of the day
       };
     }

     // Save swipe
     const swipe = await Swipe.create(swipeData);

     // Check for match
     const matchResult = await this.checkAndCreateMatch(swipe);

     // Update ELO scores
     await EloAlgorithm.calculateNewScores(
       fromUserId,
       toUserId,
       action,
       { isMutualMatch: matchResult.isMatch }
     );

     // Update user statistics
     await this.updateUserStats(fromUserId, action, matchResult.isMatch);

     // Handle notifications
     if (action === SWIPE_ACTIONS.SUPER_LIKE) {
       await this.handleSuperLikeNotification(fromUserId, toUserId);
     }

     // Track metrics
     const duration = Date.now() - startTime;
     await this.trackSwipeMetrics(fromUserId, action, duration);

     // Clear relevant caches
     await this.clearSwipeCaches(fromUserId, toUserId);

     return {
       success: true,
       swipe: {
         id: swipe._id,
         action,
         canUndo: swipe.canUndo,
       },
       match: matchResult.isMatch ? {
         id: matchResult.match._id,
         users: matchResult.match.users,
       } : null,
       limits: {
         likesRemaining: limits.remaining.likes,
         superLikesRemaining: limits.remaining.superLikes,
       },
     };
   } catch (error) {
     logger.error('Error processing swipe:', error);
     throw error;
   }
 }

 /**
  * Check for match and create if exists
  */
 async checkAndCreateMatch(swipe) {
   try {
     // Check if the other user has already liked this user
     const reciprocalSwipe = await Swipe.findOne({
       from: swipe.to,
       to: swipe.from,
       action: { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] },
       isActive: true,
       'match.isMatch': false,
     });

     if (!reciprocalSwipe || swipe.action === SWIPE_ACTIONS.NOPE) {
       return { isMatch: false };
     }

     // It's a match!
     const matchType = swipe.action === SWIPE_ACTIONS.SUPER_LIKE || 
                      reciprocalSwipe.action === SWIPE_ACTIONS.SUPER_LIKE
       ? 'superlike_match'
       : 'regular';

     // Create match document
     const match = await Match.create({
       users: [swipe.from, swipe.to].sort(),
       initiatedBy: swipe.from,
       quality: {
         compatibilityScore: swipe.compatibility.overallScore,
         commonInterests: swipe.compatibility.commonInterests,
         distance: swipe.location.calculatedDistance,
         matchType,
         wasRecommended: swipe.context.source === 'recommendations',
         recommendationScore: swipe.context.recommendation?.score,
       },
       metadata: {
         source: swipe.context.source,
         platform: {
           user1: reciprocalSwipe.device?.platform,
           user2: swipe.device?.platform,
         },
       },
     });

     // Update both swipes with match info
     await Promise.all([
       swipe.markAsMatch(match._id, matchType),
       reciprocalSwipe.markAsMatch(match._id, matchType),
     ]);

     // Send match notifications
     await this.sendMatchNotifications(match);

     // Emit socket events
     this.emitMatchEvents(match);

     // Track match metrics
     await this.trackMatchMetrics(match);

     return {
       isMatch: true,
       match,
       matchType,
     };
   } catch (error) {
     logger.error('Error checking/creating match:', error);
     throw error;
   }
 }

 /**
  * Undo last swipe
  */
 async undoSwipe(userId, swipeId = null) {
   try {
     let swipe;

     if (swipeId) {
       swipe = await Swipe.findById(swipeId);
     } else {
       // Get last swipe
       swipe = await Swipe.findOne({
         from: userId,
         isActive: true,
       }).sort({ swipedAt: -1 });
     }

     if (!swipe) {
       throw new AppError('No swipe found to undo', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
     }

     if (swipe.from.toString() !== userId) {
       throw new AppError('Unauthorized to undo this swipe', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     if (!swipe.canUndo) {
       throw new AppError('Cannot undo this swipe', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
     }

     // Check undo limit for free users
     const user = await User.findById(userId).select('subscription limits');
     if (user.subscription?.type === 'free') {
       const today = new Date().toISOString().split('T')[0];
       const undoKey = `undos:${userId}:${today}`;
       const undoCount = await redis.get(undoKey) || 0;

       if (undoCount >= 1) {
         throw new AppError(
           'Daily undo limit reached. Upgrade to Premium for unlimited undos',
           HTTP_STATUS.FORBIDDEN,
           ERROR_CODES.LIMIT_EXCEEDED
         );
       }

       await redis.incr(undoKey);
       await redis.expire(undoKey, 86400);
     }

     // Undo the swipe
     await swipe.undoSwipe();

     // If it was a match, handle match removal
     if (swipe.match.isMatch) {
       await this.removeMatch(swipe.match.matchId);
     }

     // Clear caches
     await this.clearSwipeCaches(userId, swipe.to.toString());

     return {
       success: true,
       message: 'Swipe undone successfully',
       restoredUser: swipe.to,
     };
   } catch (error) {
     logger.error('Error undoing swipe:', error);
     throw error;
   }
 }

 /**
  * Get matches for a user
  */
 async getMatches(userId, options = {}) {
   try {
     const {
       page = 1,
       limit = 20,
       sort = 'recent',
       filter = 'all',
       search = '',
     } = options;

     const skip = (page - 1) * limit;
     
     // Build query
     const query = {
       users: userId,
       'status.isActive': true,
     };

     // Apply filters
     if (filter === 'new') {
       const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
       query.matchedAt = { $gte: dayAgo };
     } else if (filter === 'messaged') {
       query['interaction.hasExchangedMessages'] = true;
     } else if (filter === 'unmessaged') {
       query['interaction.hasExchangedMessages'] = false;
     } else if (filter === 'unread') {
       query.$or = [
         { 'interaction.unreadCount.user1': { $gt: 0 } },
         { 'interaction.unreadCount.user2': { $gt: 0 } },
       ];
     }

     // Sorting
     let sortOption = {};
     switch (sort) {
       case 'recent':
         sortOption = { matchedAt: -1 };
         break;
       case 'lastMessage':
         sortOption = { 'interaction.lastMessageAt': -1 };
         break;
       case 'engagement':
         sortOption = { 'engagement.score': -1 };
         break;
       default:
         sortOption = { matchedAt: -1 };
     }

     // Execute query
     const [matches, total] = await Promise.all([
       Match.find(query)
         .populate({
           path: 'users',
           select: 'profile.firstName profile.displayName profile.photos profile.bio verification status',
         })
         .sort(sortOption)
         .limit(limit)
         .skip(skip)
         .lean(),
       Match.countDocuments(query),
     ]);

     // Format matches for response
     const formattedMatches = await Promise.all(
       matches.map(async (match) => {
         const otherUser = match.users.find(u => u._id.toString() !== userId);
         const userIndex = match.users.findIndex(u => u._id.toString() === userId);
         
         return {
           id: match._id,
           user: {
             id: otherUser._id,
             firstName: otherUser.profile?.firstName,
             displayName: otherUser.profile?.displayName,
             photos: otherUser.profile?.photos,
             bio: otherUser.profile?.bio,
             verified: otherUser.verification?.photo?.verified,
             online: await this.isUserOnline(otherUser._id),
             lastActive: otherUser.status?.lastActive,
           },
           matchedAt: match.matchedAt,
           lastMessage: match.interaction?.lastMessageAt,
           unreadCount: userIndex === 0 
             ? match.interaction?.unreadCount?.user1 
             : match.interaction?.unreadCount?.user2,
           hasMessages: match.interaction?.hasExchangedMessages,
           isPinned: userIndex === 0 
             ? match.chat?.isPinned?.user1 
             : match.chat?.isPinned?.user2,
           isMuted: userIndex === 0 
             ? match.chat?.isMuted?.user1 
             : match.chat?.isMuted?.user2,
           isNew: match.isNew,
           engagementScore: match.engagement?.score,
         };
       })
     );

     // Apply search filter if provided
     let filteredMatches = formattedMatches;
     if (search) {
       const searchLower = search.toLowerCase();
       filteredMatches = formattedMatches.filter(match =>
         match.user.firstName?.toLowerCase().includes(searchLower) ||
         match.user.displayName?.toLowerCase().includes(searchLower)
       );
     }

     return {
       matches: filteredMatches,
       pagination: {
         total,
         page,
         limit,
         totalPages: Math.ceil(total / limit),
         hasNext: page < Math.ceil(total / limit),
         hasPrev: page > 1,
       },
     };
   } catch (error) {
     logger.error('Error getting matches:', error);
     throw error;
   }
 }

 /**
  * Get a specific match
  */
 async getMatch(matchId, userId) {
   try {
     const match = await Match.findById(matchId)
       .populate('users', 'profile verification status subscription');

     if (!match) {
       throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
     }

     if (!match.hasUser(userId)) {
       throw new AppError('Unauthorized to view this match', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     const otherUser = match.users.find(u => u._id.toString() !== userId);
     const userIndex = match.users.findIndex(u => u._id.toString() === userId);

     return {
       id: match._id,
       user: otherUser,
       matchedAt: match.matchedAt,
       status: match.status,
       interaction: match.interaction,
       quality: match.quality,
       chat: {
         isEnabled: match.chat?.isEnabled,
         isPinned: userIndex === 0 ? match.chat?.isPinned?.user1 : match.chat?.isPinned?.user2,
         isMuted: userIndex === 0 ? match.chat?.isMuted?.user1 : match.chat?.isMuted?.user2,
       },
       media: match.media,
       videoChat: match.videoChat,
       datePlanning: match.datePlanning,
       engagement: match.engagement,
     };
   } catch (error) {
     logger.error('Error getting match:', error);
     throw error;
   }
 }

 /**
  * Unmatch with a user
  */
 async unmatch(matchId, userId, reason = '') {
   try {
     const match = await Match.findById(matchId);

     if (!match) {
       throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
     }

     if (!match.hasUser(userId)) {
       throw new AppError('Unauthorized to unmatch', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     // Update match status
     match.unmatch(userId, reason);
     await match.save();

     // Get other user
     const otherUserId = match.getOtherUser(userId);

     // Clear conversation
     await Message.updateMany(
       { matchId },
       { $set: { 'status.isDeleted': true } }
     );

     // Send notification to other user
     await NotificationService.sendNotification(otherUserId.toString(), {
       type: NOTIFICATION_TYPES.SYSTEM,
       title: 'Match Removed',
       body: 'One of your matches has unmatched with you',
       data: { matchId: match._id.toString() },
     });

     // Emit socket event
     socketManager.emitToUser(otherUserId.toString(), SOCKET_EVENTS.MATCH_REMOVED, {
       matchId: match._id,
     });

     // Track metrics
     await MetricsService.incrementCounter('match.unmatch', 1, { reason });

     // Clear caches
     await this.clearMatchCaches(userId, otherUserId.toString());

     return {
       success: true,
       message: 'Unmatched successfully',
     };
   } catch (error) {
     logger.error('Error unmatching:', error);
     throw error;
   }
 }

 /**
  * Block and unmatch
  */
 async blockMatch(matchId, userId) {
   try {
     const match = await Match.findById(matchId);

     if (!match) {
       throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
     }

     if (!match.hasUser(userId)) {
       throw new AppError('Unauthorized to block', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     // Block match
     match.block(userId);
     await match.save();

     // Get other user
     const otherUserId = match.getOtherUser(userId);

     // Add to blocked users list
     await User.findByIdAndUpdate(userId, {
       $addToSet: { 'privacy.blockedUsers': otherUserId },
     });

     // Clear all messages
     await Message.deleteMany({ matchId });

     // No notification for blocks (silent action)

     // Clear caches
     await this.clearMatchCaches(userId, otherUserId.toString());

     return {
       success: true,
       message: 'User blocked successfully',
     };
   } catch (error) {
     logger.error('Error blocking match:', error);
     throw error;
   }
 }

 /**
  * Get who liked me (Premium feature)
  */
 async getWhoLikedMe(userId, options = {}) {
   try {
     const user = await User.findById(userId).select('subscription');
     
     // Check if user has access to this feature
     const canSeeWhoLikedMe = SUBSCRIPTION_FEATURES[user.subscription?.type]?.seeWhoLikesYou;
     
     if (!canSeeWhoLikedMe) {
       // Return limited/blurred data for free users
       const count = await Swipe.countDocuments({
         to: userId,
         action: { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] },
         isActive: true,
         'match.isMatch': false,
       });

       return {
         count,
         likes: [],
         message: 'Upgrade to Gold to see who likes you',
         isBlurred: true,
       };
     }

     // Premium users get full access
     const {
       page = 1,
       limit = 20,
       filter = 'all', // all, recent, superlike
     } = options;

     const skip = (page - 1) * limit;
     const query = {
       to: userId,
       isActive: true,
       'match.isMatch': false,
     };

     // Apply filters
     if (filter === 'recent') {
       const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
       query.swipedAt = { $gte: weekAgo };
       query.action = { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] };
     } else if (filter === 'superlike') {
       query.action = SWIPE_ACTIONS.SUPER_LIKE;
     } else {
       query.action = { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] };
     }

     const [likes, total] = await Promise.all([
       Swipe.find(query)
         .populate('from', 'profile verification status scoring')
         .sort({ swipedAt: -1 })
         .limit(limit)
         .skip(skip)
         .lean(),
       Swipe.countDocuments(query),
     ]);

     const formattedLikes = likes.map(swipe => ({
       id: swipe._id,
       user: swipe.from,
       likedAt: swipe.swipedAt,
       isSuperLike: swipe.action === SWIPE_ACTIONS.SUPER_LIKE,
       superLikeMessage: swipe.superLike?.message,
       compatibility: swipe.compatibility?.overallScore,
       distance: swipe.location?.calculatedDistance,
     }));

     return {
       count: total,
       likes: formattedLikes,
       pagination: {
         total,
         page,
         limit,
         totalPages: Math.ceil(total / limit),
         hasNext: page < Math.ceil(total / limit),
         hasPrev: page > 1,
       },
       isBlurred: false,
     };
   } catch (error) {
     logger.error('Error getting who liked me:', error);
     throw error;
   }
 }

 /**
  * Toggle pin status for a match
  */
 async togglePinMatch(matchId, userId) {
   try {
     const match = await Match.findById(matchId);

     if (!match) {
       throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
     }

     if (!match.hasUser(userId)) {
       throw new AppError('Unauthorized', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     match.togglePin(userId);
     await match.save();

     const userIndex = match.users.findIndex(u => u.toString() === userId);
     const isPinned = userIndex === 0 ? match.chat.isPinned.user1 : match.chat.isPinned.user2;

     return {
       success: true,
       isPinned,
       message: isPinned ? 'Match pinned' : 'Match unpinned',
     };
   } catch (error) {
     logger.error('Error toggling pin:', error);
     throw error;
   }
 }

 /**
  * Toggle mute status for a match
  */
 async toggleMuteMatch(matchId, userId, duration = null) {
   try {
     const match = await Match.findById(matchId);

     if (!match) {
       throw new AppError('Match not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.MATCH_NOT_FOUND);
     }

     if (!match.hasUser(userId)) {
       throw new AppError('Unauthorized', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
     }

     match.toggleMute(userId, duration);
     await match.save();

     const userIndex = match.users.findIndex(u => u.toString() === userId);
     const isMuted = userIndex === 0 ? match.chat.isMuted.user1 : match.chat.isMuted.user2;

     return {
       success: true,
       isMuted,
       mutedUntil: userIndex === 0 ? match.chat.mutedUntil.user1 : match.chat.mutedUntil.user2,
       message: isMuted ? 'Notifications muted' : 'Notifications unmuted',
     };
   } catch (error) {
     logger.error('Error toggling mute:', error);
     throw error;
   }
 }

 /**
  * Get match statistics
  */
 async getMatchStats(userId) {
   try {
     const [
       matchStats,
       swipeStats,
       engagementStats,
       qualityStats,
     ] = await Promise.all([
       Match.getUserMatchStats(userId),
       Swipe.getUserSwipeStats(userId),
       this.getEngagementStats(userId),
       this.getQualityStats(userId),
     ]);

     return {
       matches: matchStats,
       swipes: swipeStats,
       engagement: engagementStats,
       quality: qualityStats,
     };
   } catch (error) {
     logger.error('Error getting match stats:', error);
     throw error;
   }
 }

 /**
  * Get top picks (Premium feature)
  */
 async getTopPicks(userId, limit = 10) {
   try {
     const user = await User.findById(userId).select('subscription preferences profile');
     
     // Check if user has access
     const topPicksLimit = SUBSCRIPTION_FEATURES[user.subscription?.type]?.topPicks;
     
     if (topPicksLimit === 0) {
       throw new AppError(
         'Top Picks is a premium feature',
         HTTP_STATUS.FORBIDDEN,
         ERROR_CODES.SUBSCRIPTION_REQUIRED
       );
     }

     // Check cache
     const cacheKey = `top-picks:${userId}`;
     const cached = await redis.get(cacheKey);
     
     if (cached) {
       return JSON.parse(cached);
     }

     // Get high-quality recommendations
     const recommendations = await RecommendationAlgorithm.getRecommendations(userId, {
       limit: topPicksLimit === -1 ? limit : Math.min(limit, topPicksLimit),
       includeBoosts: false,
       applyFilters: true,
     });

     // Filter for top quality users
     const topPicks = recommendations.filter(rec => {
       return (
         rec.scoring?.eloScore > 1700 &&
         rec.scoring?.profileCompleteness > 0.8 &&
         rec.verification?.photo?.verified
       );
     });

     // Cache for 24 hours
     await redis.set(cacheKey, JSON.stringify(topPicks), 86400);

     return topPicks;
   } catch (error) {
     logger.error('Error getting top picks:', error);
     throw error;
   }
 }

 // ============================
 // Helper Methods
 // ============================

 /**
  * Get user data for swipe context
  */
 async getUserSwipeData(userId) {
   const user = await User.findById(userId).select(
     'profile preferences scoring subscription verification status'
   ).lean();

   if (!user) return null;

   // Calculate age
   const age = user.profile?.dateOfBirth
     ? Math.floor((Date.now() - new Date(user.profile.dateOfBirth)) / 31557600000)
     : null;

   return {
     ...user,
     age,
   };
 }

 /**
  * Calculate compatibility between two users
  */
 async calculateCompatibility(user1, user2) {
   let score = 0;
   const factors = {
     interests: 0,
     age: 0,
     distance: 0,
     lifestyle: 0,
     goals: 0,
   };

   // Common interests (30%)
   if (user1.profile?.interests && user2.profile?.interests) {
     const common = user1.profile.interests.filter(i => 
       user2.profile.interests.includes(i)
     );
     factors.interests = common.length / Math.max(user1.profile.interests.length, 1);
     score += factors.interests * 0.3;
   }

   // Age compatibility (20%)
   if (user1.age && user2.age) {
     const ageDiff = Math.abs(user1.age - user2.age);
     factors.age = Math.max(0, 1 - ageDiff / 20);
     score += factors.age * 0.2;
   }

   // Distance (20%)
   let distance = null;
   if (user1.profile?.location?.coordinates && user2.profile?.location?.coordinates) {
     distance = this.calculateDistance(
       user1.profile.location.coordinates,
       user2.profile.location.coordinates
     );
     factors.distance = Math.max(0, 1 - distance / 100);
     score += factors.distance * 0.2;
   }

   // Lifestyle compatibility (15%)
   if (user1.profile?.lifestyle && user2.profile?.lifestyle) {
     let lifestyle
     let lifestyleScore = 0;
     let lifestyleFactors = 0;
     
     if (user1.profile.lifestyle.drinking === user2.profile.lifestyle.drinking) {
       lifestyleScore += 1;
       lifestyleFactors++;
     }
     if (user1.profile.lifestyle.smoking === user2.profile.lifestyle.smoking) {
       lifestyleScore += 1;
       lifestyleFactors++;
     }
     if (user1.profile.lifestyle.workout === user2.profile.lifestyle.workout) {
       lifestyleScore += 0.5;
       lifestyleFactors++;
     }
     
     factors.lifestyle = lifestyleFactors > 0 ? lifestyleScore / lifestyleFactors : 0;
     score += factors.lifestyle * 0.15;
   }

   // Relationship goals (15%)
   if (user1.profile?.relationshipGoal === user2.profile?.relationshipGoal) {
     factors.goals = 1;
     score += 0.15;
   }

   return {
     score: Math.min(1, score),
     commonInterests: user1.profile?.interests?.filter(i => 
       user2.profile?.interests?.includes(i)
     ) || [],
     distance,
     ageCompatibility: factors.age,
     distanceCompatibility: factors.distance,
     lifestyleCompatibility: factors.lifestyle,
   };
 }

 /**
  * Calculate distance between coordinates
  */
 calculateDistance(coords1, coords2) {
   const [lon1, lat1] = coords1;
   const [lon2, lat2] = coords2;
   
   const R = 6371; // Earth's radius in km
   const dLat = (lat2 - lat1) * Math.PI / 180;
   const dLon = (lon2 - lon1) * Math.PI / 180;
   
   const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
             Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
             Math.sin(dLon/2) * Math.sin(dLon/2);
   
   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
   const distance = R * c;
   
   return Math.round(distance * 10) / 10;
 }

 /**
  * Update user statistics
  */
 async updateUserStats(userId, action, isMatch) {
   try {
     const updates = {
       $inc: {
         'stats.totalSwipes': 1,
       },
     };

     if (action === SWIPE_ACTIONS.LIKE) {
       updates.$inc['stats.totalLikes'] = 1;
     } else if (action === SWIPE_ACTIONS.NOPE) {
       updates.$inc['stats.totalPasses'] = 1;
     } else if (action === SWIPE_ACTIONS.SUPER_LIKE) {
       updates.$inc['stats.totalSuperLikes'] = 1;
     }

     if (isMatch) {
       updates.$inc['stats.totalMatches'] = 1;
     }

     await User.findByIdAndUpdate(userId, updates);
   } catch (error) {
     logger.error('Error updating user stats:', error);
   }
 }

 /**
  * Send match notifications
  */
 async sendMatchNotifications(match) {
   try {
     const users = await User.find({
       _id: { $in: match.users },
     }).select('profile.firstName profile.displayName');

     for (let i = 0; i < users.length; i++) {
       const user = users[i];
       const otherUser = users[1 - i];
       
       await NotificationService.sendNotification(user._id.toString(), {
         type: NOTIFICATION_TYPES.NEW_MATCH,
         title: "It's a Match! 🎉",
         body: `You matched with ${otherUser.profile?.displayName || otherUser.profile?.firstName}!`,
         data: {
           matchId: match._id.toString(),
           otherUserId: otherUser._id.toString(),
           matchType: match.quality?.matchType,
         },
         priority: 'high',
       });
     }
   } catch (error) {
     logger.error('Error sending match notifications:', error);
   }
 }

 /**
  * Send super like notification
  */
 async handleSuperLikeNotification(fromUserId, toUserId) {
   try {
     const fromUser = await User.findById(fromUserId)
       .select('profile.firstName profile.displayName profile.photos');

     await NotificationService.sendNotification(toUserId, {
       type: NOTIFICATION_TYPES.SUPER_LIKE,
       title: 'Someone Super Liked You! ⭐',
       body: `${fromUser.profile?.displayName || fromUser.profile?.firstName} super liked you!`,
       data: {
         fromUserId: fromUserId.toString(),
         photo: fromUser.profile?.photos?.[0]?.url,
       },
       priority: 'high',
     });
   } catch (error) {
     logger.error('Error sending super like notification:', error);
   }
 }

 /**
  * Emit match socket events
  */
 emitMatchEvents(match) {
   try {
     match.users.forEach(userId => {
       socketManager.emitToUser(userId.toString(), SOCKET_EVENTS.NEW_MATCH, {
         matchId: match._id,
         matchedAt: match.matchedAt,
         users: match.users,
       });
     });
   } catch (error) {
     logger.error('Error emitting match events:', error);
   }
 }

 /**
  * Track swipe metrics
  */
 async trackSwipeMetrics(userId, action, duration) {
   try {
     await MetricsService.incrementCounter(`swipe.${action}`, 1, { userId });
     await MetricsService.recordTiming('swipe.duration', duration, { action });
     await MetricsService.trackUserAction(userId, 'swipe', { action });
   } catch (error) {
     logger.error('Error tracking swipe metrics:', error);
   }
 }

 /**
  * Track match metrics
  */
 async trackMatchMetrics(match) {
   try {
     await MetricsService.incrementCounter('match.created', 1, {
       type: match.quality?.matchType,
       source: match.metadata?.source,
     });
     
     // Track compatibility score distribution
     if (match.quality?.compatibilityScore) {
       await MetricsService.recordHistogram(
         'match.compatibility',
         match.quality.compatibilityScore
       );
     }
   } catch (error) {
     logger.error('Error tracking match metrics:', error);
   }
 }

 /**
  * Clear swipe-related caches
  */
 async clearSwipeCaches(userId1, userId2) {
   try {
     await Promise.all([
       redis.del(`recommendations:${userId1}:*`),
       redis.del(`swipe-patterns:${userId1}`),
       redis.del(`elo:${userId1}`),
       redis.del(`elo:${userId2}`),
     ]);
   } catch (error) {
     logger.error('Error clearing swipe caches:', error);
   }
 }

 /**
  * Clear match-related caches
  */
 async clearMatchCaches(userId1, userId2) {
   try {
     await Promise.all([
       redis.del(`matches:${userId1}:*`),
       redis.del(`matches:${userId2}:*`),
       CacheService.invalidateUser(userId1),
       CacheService.invalidateUser(userId2),
     ]);
   } catch (error) {
     logger.error('Error clearing match caches:', error);
   }
 }

 /**
  * Check if user is online
  */
 async isUserOnline(userId) {
   return socketManager.isUserOnline(userId.toString());
 }

 /**
  * Get engagement statistics
  */
 async getEngagementStats(userId) {
   try {
     const matches = await Match.find({
       users: userId,
       'status.isActive': true,
     }).select('engagement interaction');

     const stats = {
       avgEngagementScore: 0,
       highEngagementMatches: 0,
       activeConversations: 0,
       avgMessageCount: 0,
       avgResponseTime: 0,
     };

     if (matches.length === 0) return stats;

     let totalEngagement = 0;
     let totalMessages = 0;
     let totalResponseTime = 0;
     let responseCount = 0;

     matches.forEach(match => {
       totalEngagement += match.engagement?.score || 0;
       totalMessages += match.interaction?.messageCount || 0;
       
       if (match.engagement?.score > 70) {
         stats.highEngagementMatches++;
       }
       
       if (match.isConversationActive) {
         stats.activeConversations++;
       }
       
       const userIndex = match.users.findIndex(u => u.toString() === userId);
       const responseTime = userIndex === 0 
         ? match.interaction?.responseTime?.user1 
         : match.interaction?.responseTime?.user2;
       
       if (responseTime) {
         totalResponseTime += responseTime;
         responseCount++;
       }
     });

     stats.avgEngagementScore = Math.round(totalEngagement / matches.length);
     stats.avgMessageCount = Math.round(totalMessages / matches.length);
     stats.avgResponseTime = responseCount > 0 
       ? Math.round(totalResponseTime / responseCount) 
       : 0;

     return stats;
   } catch (error) {
     logger.error('Error getting engagement stats:', error);
     return {};
   }
 }

 /**
  * Get quality statistics
  */
 async getQualityStats(userId) {
   try {
     const matches = await Match.find({
       users: userId,
     }).select('quality');

     const stats = {
       avgCompatibility: 0,
       superlikeMatches: 0,
       recommendedMatches: 0,
       avgDistance: 0,
     };

     if (matches.length === 0) return stats;

     let totalCompatibility = 0;
     let totalDistance = 0;
     let distanceCount = 0;

     matches.forEach(match => {
       if (match.quality?.compatibilityScore) {
         totalCompatibility += match.quality.compatibilityScore;
       }
       
       if (match.quality?.matchType === 'superlike_match') {
         stats.superlikeMatches++;
       }
       
       if (match.quality?.wasRecommended) {
         stats.recommendedMatches++;
       }
       
       if (match.quality?.distance) {
         totalDistance += match.quality.distance;
         distanceCount++;
       }
     });

     stats.avgCompatibility = Math.round((totalCompatibility / matches.length) * 100) / 100;
     stats.avgDistance = distanceCount > 0 
       ? Math.round(totalDistance / distanceCount) 
       : 0;

     return stats;
   } catch (error) {
     logger.error('Error getting quality stats:', error);
     return {};
   }
 }

 /**
  * Remove match (internal use)
  */
 async removeMatch(matchId) {
   try {
     const match = await Match.findById(matchId);
     if (!match) return;

     match.status.isActive = false;
     match.status.status = MATCH_STATUS.DELETED;
     match.status.deactivatedAt = new Date();
     await match.save();

     // Notify users
     match.users.forEach(userId => {
       socketManager.emitToUser(userId.toString(), SOCKET_EVENTS.MATCH_REMOVED, {
         matchId: match._id,
       });
     });
   } catch (error) {
     logger.error('Error removing match:', error);
   }
 }

 /**
  * Get match insights (Premium feature)
  */
 async getMatchInsights(userId) {
   try {
     const user = await User.findById(userId).select('subscription');
     
     if (user.subscription?.type === 'free') {
       return {
         message: 'Upgrade to Premium for detailed insights',
         isPremium: false,
       };
     }

     const [
       swipePatterns,
       peakTimes,
       successRate,
       preferences,
     ] = await Promise.all([
       Swipe.getSwipePatterns(userId),
       this.getPeakMatchTimes(userId),
       this.getSuccessRateByType(userId),
       this.getMatchPreferences(userId),
     ]);

     return {
       swipePatterns,
       peakTimes,
       successRate,
       preferences,
       isPremium: true,
     };
   } catch (error) {
     logger.error('Error getting match insights:', error);
     throw error;
   }
 }

 /**
  * Get peak matching times
  */
 async getPeakMatchTimes(userId) {
   try {
     const matches = await Match.aggregate([
       {
         $match: {
           users: mongoose.Types.ObjectId(userId),
         },
       },
       {
         $group: {
           _id: {
             hour: { $hour: '$matchedAt' },
             dayOfWeek: { $dayOfWeek: '$matchedAt' },
           },
           count: { $sum: 1 },
         },
       },
       {
         $sort: { count: -1 },
       },
       {
         $limit: 5,
       },
     ]);

     return matches.map(m => ({
       hour: m._id.hour,
       dayOfWeek: m._id.dayOfWeek,
       count: m.count,
     }));
   } catch (error) {
     logger.error('Error getting peak times:', error);
     return [];
   }
 }

 /**
  * Get success rate by match type
  */
 async getSuccessRateByType(userId) {
   try {
     const stats = await Match.aggregate([
       {
         $match: {
           users: mongoose.Types.ObjectId(userId),
         },
       },
       {
         $group: {
           _id: '$quality.matchType',
           total: { $sum: 1 },
           withMessages: {
             $sum: {
               $cond: ['$interaction.hasExchangedMessages', 1, 0],
             },
           },
         },
       },
     ]);

     return stats.map(s => ({
       type: s._id,
       total: s.total,
       successRate: s.total > 0 ? Math.round((s.withMessages / s.total) * 100) : 0,
     }));
   } catch (error) {
     logger.error('Error getting success rate:', error);
     return [];
   }
 }

 /**
  * Get match preferences analysis
  */
 async getMatchPreferences(userId) {
   try {
     const matches = await Match.find({
       users: userId,
       'interaction.hasExchangedMessages': true,
     })
       .populate('users', 'profile.interests profile.lifestyle profile.education')
       .limit(50);

     const preferences = {
       commonInterests: {},
       lifestyle: {},
       education: {},
     };

     matches.forEach(match => {
       const otherUser = match.users.find(u => u._id.toString() !== userId);
       
       // Analyze interests
       otherUser.profile?.interests?.forEach(interest => {
         preferences.commonInterests[interest] = (preferences.commonInterests[interest] || 0) + 1;
       });
       
       // Analyze lifestyle
       if (otherUser.profile?.lifestyle) {
         Object.entries(otherUser.profile.lifestyle).forEach(([key, value]) => {
           if (!preferences.lifestyle[key]) preferences.lifestyle[key] = {};
           preferences.lifestyle[key][value] = (preferences.lifestyle[key][value] || 0) + 1;
         });
       }
       
       // Analyze education
       if (otherUser.profile?.education?.level) {
         preferences.education[otherUser.profile.education.level] = 
           (preferences.education[otherUser.profile.education.level] || 0) + 1;
       }
     });

     // Sort and limit results
     const topInterests = Object.entries(preferences.commonInterests)
       .sort((a, b) => b[1] - a[1])
       .slice(0, 10)
       .map(([interest, count]) => ({ interest, count }));

     return {
       topInterests,
       lifestyle: preferences.lifestyle,
       education: preferences.education,
     };
   } catch (error) {
     logger.error('Error getting match preferences:', error);
     return {};
   }
 }

 /**
  * Schedule stale match cleanup
  */
 async cleanupStaleMatches() {
   try {
     const staleDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
     
     const staleMatches = await Match.find({
       'status.isActive': true,
       'interaction.hasExchangedMessages': false,
       matchedAt: { $lt: staleDate },
     });

     for (const match of staleMatches) {
       match.checkIfStale();
       await match.save();
     }

     logger.info(`Marked ${staleMatches.length} matches as stale`);
   } catch (error) {
     logger.error('Error cleaning up stale matches:', error);
   }
 }
}

export default new MatchService();