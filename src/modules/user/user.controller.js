// src/modules/user/user.controller.js
import UserService from './user.service.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import {
 successResponse,
 createdResponse,
 badRequestResponse,
 notFoundResponse,
 forbiddenResponse,
 conflictResponse,
 serverErrorResponse,
 paginatedResponse,
} from '../../shared/utils/response.js';
import logger from '../../shared/utils/logger.js';
import MetricsService from '../../shared/services/metrics.service.js';
import { ERROR_CODES, USER_CONSTANTS } from '../../config/constants.js';

class UserController {
 /**
  * Get current user profile
  * @route GET /api/users/profile
  */
 getMyProfile = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();

   const profile = await UserService.getProfile(userId, userId, false);

   // Track metrics
   await MetricsService.trackUserAction(userId, 'profile_viewed', {
     type: 'own',
   });

   return successResponse(res, profile, 'Profile retrieved successfully');
 });

 /**
  * Get user profile by ID
  * @route GET /api/users/:userId
  */
 getUserProfile = asyncHandler(async (req, res) => {
   const { userId } = req.params;
   const requesterId = req.user._id.toString();

   // Check if user is trying to get their own profile
   if (userId === requesterId) {
     return this.getMyProfile(req, res);
   }

   const profile = await UserService.getProfile(userId, requesterId, true);

   // Track metrics
   await MetricsService.trackUserAction(requesterId, 'profile_viewed', {
     type: 'other',
     targetUser: userId,
   });

   return successResponse(res, profile, 'Profile retrieved successfully');
 });

 /**
  * Update user profile
  * @route PUT /api/users/profile
  */
 updateProfile = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const updates = req.body;

   // Remove fields that shouldn't be updated directly
   delete updates._id;
   delete updates.email;
   delete updates.password;
   delete updates.role;
   delete updates.subscription;
   delete updates.scoring;
   delete updates.stats;
   delete updates.verification;
   delete updates.security;
   delete updates.metadata;

   const updatedProfile = await UserService.updateProfile(userId, updates);

   return successResponse(res, updatedProfile, 'Profile updated successfully');
 });

 /**
  * Upload photo
  * @route POST /api/users/photos
  */
 uploadPhoto = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const file = req.file;

   if (!file) {
     return badRequestResponse(res, 'No photo file provided');
   }

   // Validate file type
   const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
   if (!allowedTypes.includes(file.mimetype)) {
     return badRequestResponse(res, 'Invalid file type. Only JPEG, PNG, and WebP are allowed');
   }

   // Validate file size (max 10MB)
   if (file.size > 10 * 1024 * 1024) {
     return badRequestResponse(res, 'File size exceeds 10MB limit');
   }

   const options = {
     order: req.body.order,
     isMain: req.body.isMain === 'true',
   };

   const photo = await UserService.uploadPhoto(userId, file, options);

   return createdResponse(res, photo, 'Photo uploaded successfully');
 });

 /**
  * Delete photo
  * @route DELETE /api/users/photos/:photoId
  */
 deletePhoto = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { photoId } = req.params;

   const result = await UserService.deletePhoto(userId, photoId);

   return successResponse(res, result, result.message);
 });

 /**
  * Reorder photos
  * @route PUT /api/users/photos/reorder
  */
 reorderPhotos = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { photoIds } = req.body;

   if (!Array.isArray(photoIds) || photoIds.length === 0) {
     return badRequestResponse(res, 'Photo IDs array is required');
   }

   const photos = await UserService.reorderPhotos(userId, photoIds);

   return successResponse(res, photos, 'Photos reordered successfully');
 });

 /**
  * Set main photo
  * @route PUT /api/users/photos/:photoId/main
  */
 setMainPhoto = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { photoId } = req.params;

   const photos = await UserService.setMainPhoto(userId, photoId);

   return successResponse(res, photos, 'Main photo updated successfully');
 });

 /**
  * Update location
  * @route PUT /api/users/location
  */
 updateLocation = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { latitude, longitude, address } = req.body;

   const location = await UserService.updateLocation(userId, {
     latitude,
     longitude,
     address,
   });

   return successResponse(res, location, 'Location updated successfully');
 });

 /**
  * Get nearby users
  * @route GET /api/users/nearby
  */
 getNearbyUsers = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const radius = parseInt(req.query.radius) || 10;

   // Check if user has location set
   if (!req.user.profile?.location?.coordinates) {
     return badRequestResponse(res, 'Please set your location first');
   }

   const nearbyUsers = await UserService.findNearbyUsers(userId, radius);

   return successResponse(res, nearbyUsers, 'Nearby users retrieved successfully');
 });

 /**
  * Update preferences
  * @route PUT /api/users/preferences
  */
 updatePreferences = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const preferences = req.body.preferences;

   if (!preferences) {
     return badRequestResponse(res, 'Preferences object is required');
   }

   const updatedPreferences = await UserService.updatePreferences(userId, preferences);

   return successResponse(res, updatedPreferences, 'Preferences updated successfully');
 });

 /**
  * Get recommendations
  * @route GET /api/users/recommendations
  */
 getRecommendations = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { 
     limit = 10, 
     page = 1,
     includeBoosts = true,
     ...filters 
   } = req.query;

   // Check if user has location set
   if (!req.user.profile?.location?.coordinates) {
     return badRequestResponse(res, 'Please set your location to get recommendations');
   }

   // Check daily limit for free users
   if (!req.user.isPremium) {
     const today = new Date().toISOString().split('T')[0];
     const swipeKey = `swipes:${userId}:${today}`;
     const swipeCount = await redis.get(swipeKey) || 0;

     if (swipeCount >= USER_CONSTANTS.DAILY_LIKE_LIMIT) {
       return forbiddenResponse(res, 'Daily swipe limit reached. Upgrade to premium for unlimited swipes');
     }
   }

   const recommendations = await UserService.getRecommendations(userId, {
     limit: parseInt(limit),
     page: parseInt(page),
     includeBoosts: includeBoosts === 'true',
     filters,
   });

   return paginatedResponse(
     res,
     recommendations,
     recommendations.length,
     parseInt(page),
     parseInt(limit),
     'Recommendations retrieved successfully'
   );
 });

 /**
  * Search users (Premium feature)
  * @route GET /api/users/search
  */
 searchUsers = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   
   // Check if user has premium
   if (!req.user.isPremium) {
     return forbiddenResponse(res, 'Search is a premium feature. Please upgrade to use this feature');
   }

   const searchParams = {
     query: req.query.q,
     filters: {
       gender: req.query['filters.gender'],
       minAge: req.query['filters.minAge'],
       maxAge: req.query['filters.maxAge'],
       verified: req.query['filters.verified'],
       interests: req.query['filters.interests'],
     },
     page: parseInt(req.query.page) || 1,
     limit: parseInt(req.query.limit) || 20,
   };

   const results = await UserService.searchUsers(userId, searchParams);

   return paginatedResponse(
     res,
     results,
     results.length,
     searchParams.page,
     searchParams.limit,
     'Search results retrieved successfully'
   );
 });

 /**
  * Get top picks
  * @route GET /api/users/top-picks
  */
 getTopPicks = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const limit = parseInt(req.query.limit) || 10;

   // Check if user has access to top picks
   if (!req.user.subscription?.features?.topPicks) {
     return forbiddenResponse(res, 'Top Picks is a premium feature');
   }

   const topPicks = await UserService.getTopPicks(userId, limit);

   return successResponse(res, topPicks, 'Top picks retrieved successfully');
 });

 /**
  * Block user
  * @route POST /api/users/block
  */
 blockUser = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { targetUserId } = req.body;

   const result = await UserService.blockUser(userId, targetUserId);

   return successResponse(res, result, result.message);
 });

 /**
  * Unblock user
  * @route DELETE /api/users/block/:targetUserId
  */
 unblockUser = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { targetUserId } = req.params;

   const result = await UserService.unblockUser(userId, targetUserId);

   return successResponse(res, result, result.message);
 });

 /**
  * Get blocked users
  * @route GET /api/users/blocked
  */
 getBlockedUsers = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();

   const blockedUsers = await UserService.getBlockedUsers(userId);

   return successResponse(res, blockedUsers, 'Blocked users retrieved successfully');
 });

 /**
  * Report user
  * @route POST /api/users/report
  */
 reportUser = asyncHandler(async (req, res) => {
   const reporterId = req.user._id.toString();
   const { reportedUserId, reason, description, evidence } = req.body;

   const result = await UserService.reportUser(reporterId, reportedUserId, {
     reason,
     description,
     evidence,
   });

   return successResponse(res, result, result.message);
 });

 /**
  * Update privacy settings
  * @route PUT /api/users/privacy
  */
 updatePrivacy = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { privacy } = req.body;

   if (!privacy) {
     return badRequestResponse(res, 'Privacy settings object is required');
   }

   const updates = { privacy };
   const updatedProfile = await UserService.updateProfile(userId, updates);

   return successResponse(res, updatedProfile.privacy, 'Privacy settings updated successfully');
 });

 /**
  * Update notification settings
  * @route PUT /api/users/notifications
  */
 updateNotifications = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { notifications } = req.body;

   if (!notifications) {
     return badRequestResponse(res, 'Notification settings object is required');
   }

   const updates = { notifications };
   const updatedProfile = await UserService.updateProfile(userId, updates);

   return successResponse(res, updatedProfile.notifications, 'Notification settings updated successfully');
 });

 /**
  * Register push token
  * @route POST /api/users/push-token
  */
 registerPushToken = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { token, platform } = req.body;

   // Add token to user's push tokens
   const updates = {
     $addToSet: {
       'notifications.push.tokens': {
         token,
         platform,
         addedAt: new Date(),
       },
     },
   };

   await User.findByIdAndUpdate(userId, updates);

   // Register with notification service
   await NotificationService.registerFCMToken(userId, token, { platform });

   return successResponse(res, null, 'Push token registered successfully');
 });

 /**
  * Pause/unpause account
  * @route PUT /api/users/pause
  */
 pauseAccount = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { pause } = req.body;

   const result = await UserService.toggleAccountPause(userId, pause);

   return successResponse(res, result, result.message);
 });

 /**
  * Delete account
  * @route DELETE /api/users/account
  */
 deleteAccount = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { password, reason } = req.body;

   const result = await UserService.deleteAccount(userId, password, reason);

   // Clear auth cookies
   res.clearCookie('refreshToken');

   return successResponse(res, result, result.message);
 });

 /**
  * Apply boost
  * @route POST /api/users/boost
  */
 applyBoost = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { type = 'regular', duration = 30 } = req.body;

   // Check if user has boosts available
   const user = req.user;
   if (!user.isPremium) {
     const monthlyLimit = 1;
     if (user.limits?.monthlyBoosts?.count >= monthlyLimit) {
       return forbiddenResponse(res, 'No boosts available. Upgrade to premium for more boosts');
     }
   }

   const result = await UserService.applyBoost(userId, type, duration);

   return successResponse(res, result, result.message);
 });

 /**
  * Get user statistics
  * @route GET /api/users/stats
  */
 getUserStats = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();

   const stats = await UserService.getUserStats(userId);

   return successResponse(res, stats, 'Statistics retrieved successfully');
 });

 /**
  * Verify photo
  * @route POST /api/users/verify/photo
  */
 verifyPhoto = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const file = req.file;

   if (!file) {
     return badRequestResponse(res, 'Verification photo is required');
   }

   const result = await UserService.verifyUserPhoto(userId, file);

   return successResponse(res, result, result.message);
 });

 /**
  * Complete profile (Onboarding)
  * @route POST /api/users/complete-profile
  */
 completeProfile = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const { profile } = req.body;

   // Check required fields for profile completion
   const requiredFields = ['firstName', 'dateOfBirth', 'gender'];
   const missingFields = requiredFields.filter(field => !profile[field]);

   if (missingFields.length > 0) {
     return badRequestResponse(res, `Missing required fields: ${missingFields.join(', ')}`);
   }

   // Check if at least one photo is provided
   if (!profile.photos || profile.photos.length === 0) {
     return badRequestResponse(res, 'At least one photo is required');
   }

   const updates = { profile };
   const updatedProfile = await UserService.updateProfile(userId, updates);

   // Mark profile as complete
   await User.findByIdAndUpdate(userId, {
     $set: { 'metadata.profileCompleted': true },
   });

   // Track onboarding completion
   await MetricsService.trackUserAction(userId, 'onboarding_completed');

   return successResponse(res, updatedProfile, 'Profile completed successfully');
 });

 /**
  * Get profile completion status
  * @route GET /api/users/profile-completion
  */
 getProfileCompletion = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();
   const user = req.user;

   const requiredFields = [
     { field: 'profile.firstName', label: 'First Name', completed: !!user.profile?.firstName },
     { field: 'profile.dateOfBirth', label: 'Date of Birth', completed: !!user.profile?.dateOfBirth },
     { field: 'profile.gender', label: 'Gender', completed: !!user.profile?.gender },
     { field: 'profile.photos', label: 'Photos', completed: user.profile?.photos?.length > 0 },
     { field: 'profile.bio', label: 'Bio', completed: !!user.profile?.bio },
     { field: 'profile.location', label: 'Location', completed: !!user.profile?.location?.coordinates },
   ];

   const optionalFields = [
     { field: 'profile.interests', label: 'Interests', completed: user.profile?.interests?.length > 0 },
     { field: 'profile.education', label: 'Education', completed: !!user.profile?.education?.level },
     { field: 'profile.career', label: 'Career', completed: !!user.profile?.career?.jobTitle },
     { field: 'profile.lifestyle', label: 'Lifestyle', completed: !!user.profile?.lifestyle?.drinking },
   ];

   const completedRequired = requiredFields.filter(f => f.completed).length;
   const completedOptional = optionalFields.filter(f => f.completed).length;
   const totalRequired = requiredFields.length;
   const totalOptional = optionalFields.length;

   const completionPercentage = Math.round(
     ((completedRequired + completedOptional) / (totalRequired + totalOptional)) * 100
   );

   return successResponse(res, {
     completionPercentage,
     requiredFields,
     optionalFields,
     isComplete: completedRequired === totalRequired,
     scoring: {
       profileCompleteness: user.scoring?.profileCompleteness || 0,
     },
   }, 'Profile completion status retrieved');
 });

 /**
  * Get subscription info
  * @route GET /api/users/subscription
  */
 getSubscription = asyncHandler(async (req, res) => {
   const user = req.user;

   const subscription = {
     type: user.subscription?.type || 'free',
     validUntil: user.subscription?.validUntil,
     features: user.subscription?.features,
     isPremium: user.isPremium,
     daysRemaining: user.subscription?.validUntil
       ? Math.max(0, Math.floor((new Date(user.subscription.validUntil) - new Date()) / (1000 * 60 * 60 * 24)))
       : null,
   };

   return successResponse(res, subscription, 'Subscription info retrieved successfully');
 });

 /**
  * Export user data (GDPR compliance)
  * @route GET /api/users/export
  */
 exportUserData = asyncHandler(async (req, res) => {
   const userId = req.user._id.toString();

   // Queue data export job
   await QueueService.addJob('data-export', {
     userId,
     email: req.user.email,
     requestedAt: new Date(),
   });

   return successResponse(res, {
     message: 'Your data export request has been received. You will receive an email with your data within 24 hours.',
   });
 });
}

export default new UserController();