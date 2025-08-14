// src/modules/user/user.routes.js
import { Router } from 'express';
import UserController from './user.controller.js';
import userValidators from './user.validation.js';
import { 
 authenticate, 
 requireCompleteProfile,
 requireVerifiedEmail,
 requirePremium,
 optionalAuth 
} from '../../shared/middleware/auth.middleware.js';
import {
 apiLimiter,
 customRateLimiter,
 uploadLimiter,
 tieredRateLimiter
} from '../../shared/middleware/rateLimiter.middleware.js';
import {
 cacheMiddleware,
 clearCache,
 invalidateCache,
 cachePagination,
 conditionalCache
} from '../../shared/middleware/cache.middleware.js';
import {
 sanitizeRequest,
 validatePagination,
 validateObjectId
} from '../../shared/middleware/validation.middleware.js';
import { validate } from '../../shared/middleware/validation.middleware.js';
import { upload } from '../media/upload.middleware.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';

const router = Router();

/**
* @route   /api/users
* @desc    User management routes
*/

// ============================
// Public Routes (Optional Auth)
// ============================

/**
* @route   GET /api/users/public/:userId
* @desc    Get public user profile
* @access  Public (optional auth for blocking checks)
*/
router.get(
 '/public/:userId',
 optionalAuth,
 validateObjectId('userId'),
 cacheMiddleware({ ttl: 300, includeUser: false }),
 UserController.getUserProfile
);

// ============================
// Authenticated Routes
// ============================

// Apply authentication to all routes below
router.use(authenticate);

// ============================
// Profile Management
// ============================

/**
* @route   GET /api/users/profile
* @desc    Get current user profile
* @access  Private
*/
router.get(
 '/profile',
 cacheMiddleware({ ttl: 60, includeUser: true }),
 UserController.getMyProfile
);

/**
* @route   PUT /api/users/profile
* @desc    Update user profile
* @access  Private
*/
router.put(
 '/profile',
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.profile.updateProfile),
 clearCache(['user:profile:*', 'recommendations:*']),
 UserController.updateProfile
);

/**
* @route   POST /api/users/complete-profile
* @desc    Complete profile (onboarding)
* @access  Private
*/
router.post(
 '/complete-profile',
 sanitizeRequest,
 userValidators.validateRequest(userValidators.profile.completeProfile),
 clearCache(['user:profile:*']),
 UserController.completeProfile
);

/**
* @route   GET /api/users/profile-completion
* @desc    Get profile completion status
* @access  Private
*/
router.get(
 '/profile-completion',
 cacheMiddleware({ ttl: 300, includeUser: true }),
 UserController.getProfileCompletion
);

/**
* @route   GET /api/users/:userId
* @desc    Get user profile by ID
* @access  Private
*/
router.get(
 '/:userId',
 validateObjectId('userId'),
 conditionalCache(
   (req) => req.params.userId !== req.user._id.toString(),
   { ttl: 300 }
 ),
 UserController.getUserProfile
);

// ============================
// Photo Management
// ============================

/**
* @route   POST /api/users/photos
* @desc    Upload photo
* @access  Private
*/
router.post(
 '/photos',
 uploadLimiter,
 upload.single('photo'),
 userValidators.validateRequest(userValidators.photo.uploadPhoto),
 clearCache(['user:profile:*', 'recommendations:*']),
 UserController.uploadPhoto
);

/**
* @route   DELETE /api/users/photos/:photoId
* @desc    Delete photo
* @access  Private
*/
router.delete(
 '/photos/:photoId',
 customRateLimiter({ limit: 10, window: 3600 }),
 userValidators.validateRequest(userValidators.photo.deletePhoto),
 clearCache(['user:profile:*', 'recommendations:*']),
 UserController.deletePhoto
);

/**
* @route   PUT /api/users/photos/reorder
* @desc    Reorder photos
* @access  Private
*/
router.put(
 '/photos/reorder',
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.photo.reorderPhotos),
 clearCache(['user:profile:*']),
 UserController.reorderPhotos
);

/**
* @route   PUT /api/users/photos/:photoId/main
* @desc    Set main photo
* @access  Private
*/
router.put(
 '/photos/:photoId/main',
 customRateLimiter({ limit: 10, window: 3600 }),
 userValidators.validateRequest(userValidators.photo.setMainPhoto),
 clearCache(['user:profile:*']),
 UserController.setMainPhoto
);

// ============================
// Location Services
// ============================

/**
* @route   PUT /api/users/location
* @desc    Update user location
* @access  Private
*/
router.put(
 '/location',
 customRateLimiter({ limit: 60, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.location.updateLocation),
 clearCache(['user:profile:*', 'recommendations:*', 'nearby:*']),
 UserController.updateLocation
);

/**
* @route   GET /api/users/nearby
* @desc    Get nearby users
* @access  Private
*/
router.get(
 '/nearby',
 requireCompleteProfile,
 userValidators.validateRequest(userValidators.location.findNearby),
 cacheMiddleware({ ttl: 300, includeUser: true }),
 UserController.getNearbyUsers
);

// ============================
// Preferences & Settings
// ============================

/**
* @route   PUT /api/users/preferences
* @desc    Update user preferences
* @access  Private
*/
router.put(
 '/preferences',
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.preferences.updatePreferences),
 clearCache(['user:profile:*', 'recommendations:*']),
 UserController.updatePreferences
);

/**
* @route   PUT /api/users/privacy
* @desc    Update privacy settings
* @access  Private
*/
router.put(
 '/privacy',
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.privacy.updatePrivacy),
 clearCache(['user:profile:*']),
 UserController.updatePrivacy
);

/**
* @route   PUT /api/users/notifications
* @desc    Update notification settings
* @access  Private
*/
router.put(
 '/notifications',
 customRateLimiter({ limit: 10, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.notification.updateNotifications),
 clearCache(['user:profile:*']),
 UserController.updateNotifications
);

/**
* @route   POST /api/users/push-token
* @desc    Register push notification token
* @access  Private
*/
router.post(
 '/push-token',
 customRateLimiter({ limit: 5, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.notification.registerPushToken),
 UserController.registerPushToken
);

// ============================
// Discovery & Recommendations
// ============================

/**
* @route   GET /api/users/recommendations
* @desc    Get user recommendations
* @access  Private
*/
router.get(
 '/recommendations',
 requireCompleteProfile,
 tieredRateLimiter,
 userValidators.validateRequest(userValidators.search.getRecommendations),
 validatePagination,
 conditionalCache(
   (req) => !req.query.includeBoosts,
   { ttl: 600 }
 ),
 UserController.getRecommendations
);

/**
* @route   GET /api/users/search
* @desc    Search users (Premium feature)
* @access  Private (Premium)
*/
router.get(
 '/search',
 requireCompleteProfile,
 requirePremium('plus'),
 customRateLimiter({ limit: 30, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.search.searchUsers),
 validatePagination,
 cachePagination({ ttl: 300 }),
 UserController.searchUsers
);

/**
* @route   GET /api/users/top-picks
* @desc    Get top picks (Premium feature)
* @access  Private (Premium)
*/
router.get(
 '/top-picks',
 requireCompleteProfile,
 requirePremium('gold'),
 customRateLimiter({ limit: 10, window: 86400 }),
 cacheMiddleware({ ttl: 3600, includeUser: true }),
 UserController.getTopPicks
);

// ============================
// User Interactions
// ============================

/**
* @route   POST /api/users/block
* @desc    Block a user
* @access  Private
*/
router.post(
 '/block',
 customRateLimiter({ limit: 20, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.privacy.blockUser),
 clearCache(['user:profile:*', 'matches:*', 'recommendations:*']),
 UserController.blockUser
);

/**
* @route   DELETE /api/users/block/:targetUserId
* @desc    Unblock a user
* @access  Private
*/
router.delete(
 '/block/:targetUserId',
 customRateLimiter({ limit: 20, window: 3600 }),
 userValidators.validateRequest(userValidators.privacy.unblockUser),
 clearCache(['user:profile:*']),
 UserController.unblockUser
);

/**
* @route   GET /api/users/blocked
* @desc    Get blocked users list
* @access  Private
*/
router.get(
 '/blocked',
 cacheMiddleware({ ttl: 300, includeUser: true }),
 UserController.getBlockedUsers
);

/**
* @route   POST /api/users/report
* @desc    Report a user
* @access  Private
*/
router.post(
 '/report',
 customRateLimiter({ limit: 5, window: 86400 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.privacy.reportUser),
 UserController.reportUser
);

// ============================
// Premium Features
// ============================

/**
* @route   POST /api/users/boost
* @desc    Apply profile boost
* @access  Private
*/
router.post(
 '/boost',
 customRateLimiter({ limit: 3, window: 86400 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.boost.applyBoost),
 clearCache(['recommendations:*']),
 UserController.applyBoost
);

/**
* @route   GET /api/users/subscription
* @desc    Get subscription info
* @access  Private
*/
router.get(
 '/subscription',
 cacheMiddleware({ ttl: 300, includeUser: true }),
 UserController.getSubscription
);

// ============================
// Verification
// ============================

/**
* @route   POST /api/users/verify/photo
* @desc    Submit photo verification
* @access  Private
*/
router.post(
 '/verify/photo',
 requireCompleteProfile,
 uploadLimiter,
 upload.single('verificationPhoto'),
 userValidators.validateRequest(userValidators.verification.verifyPhoto),
 UserController.verifyPhoto
);

/**
* @route   POST /api/users/verify/phone
* @desc    Request phone verification
* @access  Private
*/
router.post(
 '/verify/phone',
 customRateLimiter({ limit: 3, window: 3600 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.verification.verifyPhone),
 asyncHandler(async (req, res) => {
   // This would be handled by auth module
   res.status(501).json({
     success: false,
     message: 'Phone verification is handled by auth module',
   });
 })
);

// ============================
// Account Management
// ============================

/**
* @route   PUT /api/users/pause
* @desc    Pause/unpause account
* @access  Private
*/
router.put(
 '/pause',
 customRateLimiter({ limit: 5, window: 86400 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.account.pauseAccount),
 clearCache(['user:profile:*', 'recommendations:*']),
 UserController.pauseAccount
);

/**
* @route   DELETE /api/users/account
* @desc    Delete user account
* @access  Private
*/
router.delete(
 '/account',
 customRateLimiter({ limit: 1, window: 86400 }),
 sanitizeRequest,
 userValidators.validateRequest(userValidators.account.deleteAccount),
 clearCache(['user:*', 'session:*', 'matches:*', 'recommendations:*']),
 UserController.deleteAccount
);

/**
* @route   GET /api/users/export
* @desc    Export user data (GDPR)
* @access  Private
*/
router.get(
 '/export',
 requireVerifiedEmail,
 customRateLimiter({ limit: 1, window: 86400 }),
 UserController.exportUserData
);

// ============================
// Statistics & Analytics
// ============================

/**
* @route   GET /api/users/stats
* @desc    Get user statistics
* @access  Private
*/
router.get(
 '/stats',
 requireCompleteProfile,
 cacheMiddleware({ ttl: 600, includeUser: true }),
 UserController.getUserStats
);

// ============================
// Admin Routes (Optional)
// ============================

/**
* @route   GET /api/users/admin/list
* @desc    Get all users (Admin only)
* @access  Admin
*/
router.get(
 '/admin/list',
 (req, res, next) => {
   if (req.user.role !== 'admin') {
     return res.status(403).json({
       success: false,
       error: { message: 'Admin access required' },
     });
   }
   next();
 },
 validatePagination,
 cachePagination({ ttl: 60 }),
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
* @route   GET /api/users/health
* @desc    Health check for user service
* @access  Public
*/
router.get('/health', (req, res) => {
 res.json({
   success: true,
   service: 'users',
   timestamp: new Date().toISOString(),
   uptime: process.uptime(),
 });
});

// ============================
// Error Handling Middleware
// ============================

// Handle 404 for user routes
router.use((req, res) => {
 res.status(404).json({
   success: false,
   error: {
     message: 'User endpoint not found',
     code: 'NOT_FOUND',
     path: req.originalUrl,
   },
 });
});

// Export router
export default router;