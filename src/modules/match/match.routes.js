// src/modules/match/match.routes.js
import { Router } from 'express';
import MatchController from './match.controller.js';
import { 
 authenticate, 
 requireCompleteProfile,
 requirePremium,
 requireVerifiedEmail
} from '../../shared/middleware/auth.middleware.js';
import {
 swipeLimiter,
 customRateLimiter,
 tieredRateLimiter,
 apiLimiter
} from '../../shared/middleware/rateLimiter.middleware.js';
import {
 cacheMiddleware,
 clearCache,
 invalidateCache,
 conditionalCache,
 cachePagination
} from '../../shared/middleware/cache.middleware.js';
import {
 sanitizeRequest,
 validatePagination,
 validateObjectId,
 validate
} from '../../shared/middleware/validation.middleware.js';
import { swipeValidators, matchValidators } from '../../shared/utils/validators.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';

const router = Router();

/**
* @route   /api/matches
* @desc    Match and swipe management routes
*/

// Apply authentication to all routes
router.use(authenticate);

// ============================
// Swipe Routes
// ============================

/**
* @route   POST /api/matches/swipe
* @desc    Swipe on a user
* @access  Private
*/
router.post(
 '/swipe',
 requireCompleteProfile,
 swipeLimiter,
 sanitizeRequest,
 swipeValidators.swipe,
 validate,
 clearCache(['recommendations:*', 'swipe-patterns:*']),
 MatchController.swipe
);

/**
* @route   POST /api/matches/swipe/undo
* @desc    Undo last swipe
* @access  Private
*/
router.post(
 '/swipe/undo',
 requireCompleteProfile,
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 swipeValidators.undoSwipe,
 validate,
 clearCache(['recommendations:*']),
 MatchController.undoSwipe
);

/**
* @route   GET /api/matches/swipe/history
* @desc    Get swipe history
* @access  Private (Premium)
*/
router.get(
 '/swipe/history',
 requirePremium('plus'),
 validatePagination,
 cachePagination({ ttl: 300 }),
 MatchController.getSwipeHistory
);

/**
* @route   GET /api/matches/swipe/stats
* @desc    Get swipe statistics
* @access  Private
*/
router.get(
 '/swipe/stats',
 cacheMiddleware({ ttl: 3600, includeUser: true }),
 MatchController.getSwipeStats
);

/**
* @route   GET /api/matches/swipe/limits
* @desc    Get current swipe limits and usage
* @access  Private
*/
router.get(
 '/swipe/limits',
 cacheMiddleware({ ttl: 60, includeUser: true }),
 MatchController.getSwipeLimits
);

/**
* @route   POST /api/matches/swipe/reset-passes
* @desc    Reset all passes (Premium feature)
* @access  Private (Premium)
*/
router.post(
 '/swipe/reset-passes',
 requirePremium('gold'),
 customRateLimiter({ limit: 1, window: 86400 }),
 clearCache(['recommendations:*', 'swipe-patterns:*']),
 MatchController.resetPasses
);

// ============================
// Match Management Routes
// ============================

/**
* @route   GET /api/matches
* @desc    Get all matches for current user
* @access  Private
*/
router.get(
 '/',
 requireCompleteProfile,
 matchValidators.getMatches,
 validate,
 validatePagination,
 conditionalCache(
   (req) => !req.query.filter || req.query.filter === 'all',
   { ttl: 300 }
 ),
 MatchController.getMatches
);

/**
* @route   GET /api/matches/:matchId
* @desc    Get specific match details
* @access  Private
*/
router.get(
 '/:matchId',
 validateObjectId('matchId'),
 cacheMiddleware({ ttl: 300, includeUser: true }),
 MatchController.getMatch
);

/**
* @route   DELETE /api/matches/:matchId
* @desc    Unmatch with a user
* @access  Private
*/
router.delete(
 '/:matchId',
 validateObjectId('matchId'),
 matchValidators.unmatch,
 validate,
 clearCache(['matches:*', 'messages:*']),
 MatchController.unmatch
);

/**
* @route   POST /api/matches/:matchId/block
* @desc    Block and unmatch a user
* @access  Private
*/
router.post(
 '/:matchId/block',
 validateObjectId('matchId'),
 customRateLimiter({ limit: 10, window: 3600 }),
 clearCache(['matches:*', 'messages:*', 'recommendations:*']),
 MatchController.blockMatch
);

/**
* @route   PUT /api/matches/:matchId/pin
* @desc    Pin/unpin a match
* @access  Private
*/
router.put(
 '/:matchId/pin',
 validateObjectId('matchId'),
 clearCache(['matches:*']),
 MatchController.togglePin
);

/**
* @route   PUT /api/matches/:matchId/mute
* @desc    Mute/unmute match notifications
* @access  Private
*/
router.put(
 '/:matchId/mute',
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.toggleMute
);

/**
* @route   POST /api/matches/:matchId/report
* @desc    Report a match
* @access  Private
*/
router.post(
 '/:matchId/report',
 validateObjectId('matchId'),
 customRateLimiter({ limit: 5, window: 86400 }),
 sanitizeRequest,
 MatchController.reportMatch
);

// ============================
// Likes & Discovery Routes
// ============================

/**
* @route   GET /api/matches/likes/received
* @desc    Get who liked me (Premium feature)
* @access  Private
*/
router.get(
 '/likes/received',
 conditionalCache(
   (req) => req.user?.subscription?.type === 'free',
   { ttl: 3600 }
 ),
 validatePagination,
 MatchController.getWhoLikedMe
);

/**
* @route   GET /api/matches/likes/sent
* @desc    Get users I've liked
* @access  Private (Premium)
*/
router.get(
 '/likes/sent',
 requirePremium('plus'),
 validatePagination,
 cachePagination({ ttl: 300 }),
 MatchController.getSentLikes
);

/**
* @route   GET /api/matches/top-picks
* @desc    Get daily top picks (Premium feature)
* @access  Private (Gold+)
*/
router.get(
 '/top-picks',
 requireCompleteProfile,
 requirePremium('gold'),
 cacheMiddleware({ ttl: 86400, includeUser: true }),
 MatchController.getTopPicks
);

/**
* @route   POST /api/matches/top-picks/refresh
* @desc    Refresh top picks (Platinum feature)
* @access  Private (Platinum)
*/
router.post(
 '/top-picks/refresh',
 requirePremium('platinum'),
 customRateLimiter({ limit: 1, window: 86400 }),
 clearCache(['top-picks:*']),
 MatchController.refreshTopPicks
);

// ============================
// Super Like Routes
// ============================

/**
* @route   POST /api/matches/superlike
* @desc    Send a super like
* @access  Private
*/
router.post(
 '/superlike',
 requireCompleteProfile,
 customRateLimiter({ limit: 5, window: 86400 }),
 sanitizeRequest,
 clearCache(['recommendations:*']),
 MatchController.sendSuperLike
);

/**
* @route   GET /api/matches/superlike/remaining
* @desc    Get remaining super likes
* @access  Private
*/
router.get(
 '/superlike/remaining',
 cacheMiddleware({ ttl: 60, includeUser: true }),
 MatchController.getRemainingSuperLikes
);

// ============================
// Boost Routes
// ============================

/**
* @route   POST /api/matches/boost
* @desc    Activate profile boost
* @access  Private
*/
router.post(
 '/boost',
 requireCompleteProfile,
 customRateLimiter({ limit: 3, window: 86400 }),
 clearCache(['recommendations:*', 'boosts:*']),
 MatchController.activateBoost
);

/**
* @route   GET /api/matches/boost/status
* @desc    Get boost status
* @access  Private
*/
router.get(
 '/boost/status',
 cacheMiddleware({ ttl: 30, includeUser: true }),
 MatchController.getBoostStatus
);

// ============================
// Date Planning Routes (Premium)
// ============================

/**
* @route   POST /api/matches/:matchId/date
* @desc    Propose a date
* @access  Private (Premium)
*/
router.post(
 '/:matchId/date',
 requirePremium('plus'),
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.proposeDate
);

/**
* @route   PUT /api/matches/:matchId/date/:dateId
* @desc    Update date proposal
* @access  Private (Premium)
*/
router.put(
 '/:matchId/date/:dateId',
 requirePremium('plus'),
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.updateDate
);

/**
* @route   POST /api/matches/:matchId/date/:dateId/respond
* @desc    Respond to date proposal
* @access  Private (Premium)
*/
router.post(
 '/:matchId/date/:dateId/respond',
 requirePremium('plus'),
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.respondToDate
);

// ============================
// Virtual Gifts Routes (Premium)
// ============================

/**
* @route   POST /api/matches/:matchId/gift
* @desc    Send virtual gift
* @access  Private (Premium)
*/
router.post(
 '/:matchId/gift',
 requirePremium('gold'),
 validateObjectId('matchId'),
 customRateLimiter({ limit: 10, window: 86400 }),
 sanitizeRequest,
 MatchController.sendVirtualGift
);

/**
* @route   GET /api/matches/gifts/available
* @desc    Get available virtual gifts
* @access  Private
*/
router.get(
 '/gifts/available',
 cacheMiddleware({ ttl: 3600 }),
 MatchController.getAvailableGifts
);

// ============================
// Icebreaker Routes
// ============================

/**
* @route   POST /api/matches/:matchId/icebreaker
* @desc    Send an icebreaker
* @access  Private
*/
router.post(
 '/:matchId/icebreaker',
 validateObjectId('matchId'),
 customRateLimiter({ limit: 3, window: 86400 }),
 sanitizeRequest,
 MatchController.sendIcebreaker
);

/**
* @route   GET /api/matches/icebreakers/suggestions
* @desc    Get icebreaker suggestions
* @access  Private
*/
router.get(
 '/icebreakers/suggestions',
 cacheMiddleware({ ttl: 3600 }),
 MatchController.getIcebreakerSuggestions
);

// ============================
// Statistics & Analytics Routes
// ============================

/**
* @route   GET /api/matches/stats
* @desc    Get match statistics
* @access  Private
*/
router.get(
 '/stats',
 cacheMiddleware({ ttl: 3600, includeUser: true }),
 MatchController.getMatchStats
);

/**
* @route   GET /api/matches/insights
* @desc    Get match insights (Premium)
* @access  Private
*/
router.get(
 '/insights',
 conditionalCache(
   (req) => req.user?.subscription?.type !== 'free',
   { ttl: 3600 }
 ),
 MatchController.getMatchInsights
);

/**
* @route   GET /api/matches/compatibility/:userId
* @desc    Calculate compatibility with specific user (Premium)
* @access  Private (Premium)
*/
router.get(
 '/compatibility/:userId',
 requirePremium('gold'),
 validateObjectId('userId'),
 cacheMiddleware({ ttl: 3600 }),
 MatchController.calculateCompatibility
);

// ============================
// Recommendation Routes
// ============================

/**
* @route   GET /api/matches/recommendations
* @desc    Get match recommendations
* @access  Private
*/
router.get(
 '/recommendations',
 requireCompleteProfile,
 tieredRateLimiter,
 conditionalCache(
   (req) => !req.query.realtime,
   { ttl: 1800 }
 ),
 MatchController.getRecommendations
);

/**
* @route   POST /api/matches/recommendations/feedback
* @desc    Provide feedback on recommendations
* @access  Private
*/
router.post(
 '/recommendations/feedback',
 sanitizeRequest,
 MatchController.provideFeedback
);

/**
* @route   POST /api/matches/recommendations/refresh
* @desc    Force refresh recommendations
* @access  Private
*/
router.post(
 '/recommendations/refresh',
 customRateLimiter({ limit: 5, window: 3600 }),
 clearCache(['recommendations:*']),
 MatchController.refreshRecommendations
);

// ============================
// Video Chat Routes
// ============================

/**
* @route   POST /api/matches/:matchId/video/request
* @desc    Request video chat
* @access  Private
*/
router.post(
 '/:matchId/video/request',
 requireCompleteProfile,
 validateObjectId('matchId'),
 customRateLimiter({ limit: 5, window: 3600 }),
 MatchController.requestVideoChat
);

/**
* @route   POST /api/matches/:matchId/video/end
* @desc    End video chat
* @access  Private
*/
router.post(
 '/:matchId/video/end',
 validateObjectId('matchId'),
 MatchController.endVideoChat
);

// ============================
// Safety Routes
// ============================

/**
* @route   POST /api/matches/:matchId/safety/share-location
* @desc    Share location with match
* @access  Private
*/
router.post(
 '/:matchId/safety/share-location',
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.shareLocation
);

/**
* @route   POST /api/matches/:matchId/safety/emergency-contact
* @desc    Share emergency contact
* @access  Private
*/
router.post(
 '/:matchId/safety/emergency-contact',
 validateObjectId('matchId'),
 sanitizeRequest,
 MatchController.shareEmergencyContact
);

// ============================
// Passport Routes (Location Change)
// ============================

/**
* @route   POST /api/matches/passport
* @desc    Change location (Premium feature)
* @access  Private (Gold+)
*/
router.post(
 '/passport',
 requirePremium('gold'),
 sanitizeRequest,
 clearCache(['recommendations:*', 'nearby:*']),
 MatchController.changeLocation
);

/**
* @route   DELETE /api/matches/passport
* @desc    Reset to actual location
* @access  Private (Gold+)
*/
router.delete(
 '/passport',
 requirePremium('gold'),
 clearCache(['recommendations:*', 'nearby:*']),
 MatchController.resetLocation
);

// ============================
// Activity Routes
// ============================

/**
* @route   GET /api/matches/activity
* @desc    Get match activity feed
* @access  Private
*/
router.get(
 '/activity',
 validatePagination,
 cacheMiddleware({ ttl: 300, includeUser: true }),
 MatchController.getActivityFeed
);

/**
* @route   POST /api/matches/:matchId/activity/streak
* @desc    Update activity streak
* @access  Private
*/
router.post(
 '/:matchId/activity/streak',
 validateObjectId('matchId'),
 MatchController.updateActivityStreak
);

// ============================
// Explore Mode Routes (Premium)
// ============================

/**
* @route   GET /api/matches/explore
* @desc    Browse profiles in explore mode (Premium)
* @access  Private (Premium)
*/
router.get(
 '/explore',
 requirePremium('plus'),
 validatePagination,
 conditionalCache(
   (req) => !req.query.filters,
   { ttl: 600 }
 ),
 MatchController.exploreMode
);

/**
* @route   POST /api/matches/explore/filters
* @desc    Set explore filters (Premium)
* @access  Private (Premium)
*/
router.post(
 '/explore/filters',
 requirePremium('plus'),
 sanitizeRequest,
 clearCache(['explore:*']),
 MatchController.setExploreFilters
);

// ============================
// Spotlight Routes
// ============================

/**
* @route   POST /api/matches/spotlight
* @desc    Activate spotlight (30 min visibility boost)
* @access  Private
*/
router.post(
 '/spotlight',
 requireCompleteProfile,
 customRateLimiter({ limit: 2, window: 86400 }),
 clearCache(['spotlight:*']),
 MatchController.activateSpotlight
);

/**
* @route   GET /api/matches/spotlight/status
* @desc    Get spotlight status
* @access  Private
*/
router.get(
 '/spotlight/status',
 cacheMiddleware({ ttl: 30, includeUser: true }),
 MatchController.getSpotlightStatus
);

// ============================
// Batch Operations Routes
// ============================

/**
* @route   POST /api/matches/batch/like
* @desc    Batch like profiles (Platinum)
* @access  Private (Platinum)
*/
router.post(
 '/batch/like',
 requirePremium('platinum'),
 customRateLimiter({ limit: 1, window: 3600 }),
 sanitizeRequest,
 clearCache(['recommendations:*']),
 MatchController.batchLike
);

/**
* @route   POST /api/matches/batch/pass
* @desc    Batch pass profiles
* @access  Private
*/
router.post(
 '/batch/pass',
 customRateLimiter({ limit: 5, window: 3600 }),
 sanitizeRequest,
 clearCache(['recommendations:*']),
 MatchController.batchPass
);

// ============================
// Admin Routes (Optional)
// ============================

/**
* @route   GET /api/matches/admin/stats
* @desc    Get platform match statistics (Admin)
* @access  Admin
*/
router.get(
 '/admin/stats',
 (req, res, next) => {
   if (req.user.role !== 'admin') {
     return res.status(403).json({
       success: false,
       error: { message: 'Admin access required' },
     });
   }
   next();
 },
 cacheMiddleware({ ttl: 3600 }),
 asyncHandler(async (req, res) => {
   // This would be implemented in admin module
   res.status(501).json({
     success: false,
     message: 'Admin routes are handled by admin module',
   });
 })
);

// ============================
// Health Check
// ============================

/**
* @route   GET /api/matches/health
* @desc    Health check for match service
* @access  Public
*/
router.get('/health', (req, res) => {
 res.json({
   success: true,
   service: 'matches',
   timestamp: new Date().toISOString(),
   uptime: process.uptime(),
 });
});

// ============================
// Error Handling
// ============================

// Handle 404 for match routes
router.use((req, res) => {
 res.status(404).json({
   success: false,
   error: {
     message: 'Match endpoint not found',
     code: 'NOT_FOUND',
     path: req.originalUrl,
   },
 });
});

// Export router
export default router;