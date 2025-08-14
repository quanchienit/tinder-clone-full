// src/modules/user/user.service.js
import User from './user.model.js';
import Swipe from '../match/swipe.model.js';
import Match from '../match/match.model.js';
import redis from '../../config/redis.js';
import cloudinary from '../../config/cloudinary.js';
import logger from '../../shared/utils/logger.js';
import AppError from '../../shared/errors/AppError.js';
import CacheService from '../../shared/services/cache.service.js';
import QueueService from '../../shared/services/queue.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import NotificationService from '../../shared/services/notification.service.js';
import { 
 ERROR_CODES, 
 NOTIFICATION_TYPES,
 USER_CONSTANTS,
 SUBSCRIPTION_FEATURES 
} from '../../config/constants.js';
import mongoose from 'mongoose';

class UserService {
 /**
  * Get user profile by ID
  * @param {string} userId - User ID to fetch
  * @param {string} requesterId - ID of user making request
  * @param {boolean} isPublic - Whether to return public profile only
  */
 async getProfile(userId, requesterId = null, isPublic = false) {
   try {
     // Check cache first
     const cacheKey = `user:profile:${userId}${isPublic ? ':public' : ''}`;
     const cached = await CacheService.getCachedUser(cacheKey);
     if (cached) {
       logger.debug(`Profile retrieved from cache for user ${userId}`);
       return cached;
     }

     // Find user
     const user = await User.findById(userId)
       .select(isPublic ? '-password -security -metadata -adminNotes' : '-password');

     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check if profile is visible
     if (isPublic && requesterId !== userId) {
       // Check if blocked
       if (user.privacy.blockedUsers.includes(requesterId)) {
         throw new AppError('Profile not available', 403, ERROR_CODES.FORBIDDEN);
       }

       // Check privacy settings
       if (user.privacy.hideProfile || !user.status.isActive) {
         throw new AppError('Profile is private', 403, ERROR_CODES.FORBIDDEN);
       }

       // Increment profile views
       await this.incrementProfileViews(userId);
     }

     // Format response based on context
     let profileData;
     if (isPublic && requesterId !== userId) {
       profileData = user.toMatchProfile();
     } else {
       profileData = user.toPublicProfile();
     }

     // Cache the result
     await CacheService.cacheUser(cacheKey, profileData, 300); // 5 minutes

     return profileData;
   } catch (error) {
     logger.error(`Error getting profile for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Update user profile
  * @param {string} userId - User ID
  * @param {Object} updates - Profile updates
  */
 async updateProfile(userId, updates) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Validate age if date of birth is being updated
     if (updates.profile?.dateOfBirth) {
       const age = Math.floor(
         (Date.now() - new Date(updates.profile.dateOfBirth)) / 31557600000
       );
       if (age < USER_CONSTANTS.MIN_AGE || age > USER_CONSTANTS.MAX_AGE) {
         throw new AppError(
           `Age must be between ${USER_CONSTANTS.MIN_AGE} and ${USER_CONSTANTS.MAX_AGE}`,
           400,
           ERROR_CODES.VALIDATION_ERROR
         );
       }
     }

     // Handle interests limit
     if (updates.profile?.interests) {
       if (updates.profile.interests.length > USER_CONSTANTS.MAX_INTERESTS) {
         throw new AppError(
           `Maximum ${USER_CONSTANTS.MAX_INTERESTS} interests allowed`,
           400,
           ERROR_CODES.VALIDATION_ERROR
         );
       }
     }

     // Handle bio length
     if (updates.profile?.bio) {
       if (updates.profile.bio.length > USER_CONSTANTS.MAX_BIO_LENGTH) {
         throw new AppError(
           `Bio cannot exceed ${USER_CONSTANTS.MAX_BIO_LENGTH} characters`,
           400,
           ERROR_CODES.VALIDATION_ERROR
         );
       }
     }

     // Update nested objects properly
     if (updates.profile) {
       Object.keys(updates.profile).forEach(key => {
         if (typeof updates.profile[key] === 'object' && !Array.isArray(updates.profile[key])) {
           // For nested objects like lifestyle, education, career
           Object.assign(user.profile[key] || {}, updates.profile[key]);
         } else {
           user.profile[key] = updates.profile[key];
         }
       });
     }

     // Update preferences
     if (updates.preferences) {
       Object.assign(user.preferences, updates.preferences);
     }

     // Update notifications
     if (updates.notifications) {
       Object.keys(updates.notifications).forEach(key => {
         Object.assign(user.notifications[key] || {}, updates.notifications[key]);
       });
     }

     // Update privacy
     if (updates.privacy) {
       Object.assign(user.privacy, updates.privacy);
     }

     // Save user
     await user.save();

     // Clear cache
     await CacheService.invalidateUser(userId);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'profile_updated', {
       fields: Object.keys(updates),
     });

     logger.info(`Profile updated for user ${userId}`);

     return user.toPublicProfile();
   } catch (error) {
     logger.error(`Error updating profile for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Upload user photo
  * @param {string} userId - User ID
  * @param {Object} file - Uploaded file
  * @param {Object} options - Upload options
  */
 async uploadPhoto(userId, file, options = {}) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check photo limit
     if (user.profile.photos.length >= USER_CONSTANTS.MAX_PHOTOS) {
       throw new AppError(
         `Maximum ${USER_CONSTANTS.MAX_PHOTOS} photos allowed`,
         400,
         ERROR_CODES.VALIDATION_ERROR
       );
     }

     // Upload to Cloudinary
     const uploadResult = await cloudinary.uploader.upload(file.path || file.buffer, {
       folder: `users/${userId}/photos`,
       transformation: [
         { width: 800, height: 800, crop: 'limit', quality: 'auto' },
       ],
       allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
       resource_type: 'image',
       type: 'upload',
       invalidate: true,
     });

     // Generate thumbnail
     const thumbnailUrl = cloudinary.url(uploadResult.public_id, {
       width: 200,
       height: 200,
       crop: 'fill',
       quality: 'auto',
       format: 'webp',
     });

     // Create photo object
     const photo = {
       url: uploadResult.secure_url,
       thumbnailUrl,
       cloudinaryId: uploadResult.public_id,
       order: options.order ?? user.profile.photos.length,
       isMain: options.isMain || user.profile.photos.length === 0,
       isVerified: false,
       uploadedAt: new Date(),
       metadata: {
         width: uploadResult.width,
         height: uploadResult.height,
         format: uploadResult.format,
         size: uploadResult.bytes,
       },
     };

     // If setting as main, unset other main photos
     if (photo.isMain) {
       user.profile.photos.forEach(p => {
         p.isMain = false;
       });
     }

     // Add photo
     user.profile.photos.push(photo);

     // Sort photos by order
     user.profile.photos.sort((a, b) => a.order - b.order);

     await user.save();

     // Queue for moderation if enabled
     if (process.env.ENABLE_PHOTO_MODERATION === 'true') {
       await QueueService.addJob('photo-moderation', {
         userId,
         photoId: photo._id,
         url: photo.url,
       });
     }

     // Clear cache
     await CacheService.invalidateUser(userId);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'photo_uploaded', {
       photoCount: user.profile.photos.length,
     });

     logger.info(`Photo uploaded for user ${userId}`);

     return photo;
   } catch (error) {
     logger.error(`Error uploading photo for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Delete user photo
  * @param {string} userId - User ID
  * @param {string} photoId - Photo ID to delete
  */
 async deletePhoto(userId, photoId) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     const photoIndex = user.profile.photos.findIndex(
       p => p._id.toString() === photoId
     );

     if (photoIndex === -1) {
       throw new AppError('Photo not found', 404, ERROR_CODES.NOT_FOUND);
     }

     const photo = user.profile.photos[photoIndex];

     // Don't allow deleting the only photo
     if (user.profile.photos.length === 1) {
       throw new AppError(
         'Cannot delete your only photo',
         400,
         ERROR_CODES.VALIDATION_ERROR
       );
     }

     // Delete from Cloudinary
     if (photo.cloudinaryId) {
       await cloudinary.uploader.destroy(photo.cloudinaryId);
     }

     // Remove photo from array
     user.profile.photos.splice(photoIndex, 1);

     // If deleted photo was main, set first photo as main
     if (photo.isMain && user.profile.photos.length > 0) {
       user.profile.photos[0].isMain = true;
     }

     // Reorder remaining photos
     user.profile.photos.forEach((p, index) => {
       p.order = index;
     });

     await user.save();

     // Clear cache
     await CacheService.invalidateUser(userId);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'photo_deleted');

     logger.info(`Photo deleted for user ${userId}`);

     return { success: true, message: 'Photo deleted successfully' };
   } catch (error) {
     logger.error(`Error deleting photo for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Reorder user photos
  * @param {string} userId - User ID
  * @param {Array} photoIds - Ordered array of photo IDs
  */
 async reorderPhotos(userId, photoIds) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Validate all photo IDs belong to user
     const userPhotoIds = user.profile.photos.map(p => p._id.toString());
     const invalidIds = photoIds.filter(id => !userPhotoIds.includes(id));

     if (invalidIds.length > 0) {
       throw new AppError('Invalid photo IDs provided', 400, ERROR_CODES.VALIDATION_ERROR);
     }

     if (photoIds.length !== user.profile.photos.length) {
       throw new AppError(
         'All photos must be included in reorder',
         400,
         ERROR_CODES.VALIDATION_ERROR
       );
     }

     // Reorder photos
     const reorderedPhotos = [];
     photoIds.forEach((photoId, index) => {
       const photo = user.profile.photos.find(p => p._id.toString() === photoId);
       if (photo) {
         photo.order = index;
         photo.isMain = index === 0; // First photo is always main
         reorderedPhotos.push(photo);
       }
     });

     user.profile.photos = reorderedPhotos;
     await user.save();

     // Clear cache
     await CacheService.invalidateUser(userId);

     logger.info(`Photos reordered for user ${userId}`);

     return user.profile.photos;
   } catch (error) {
     logger.error(`Error reordering photos for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Set main photo
  * @param {string} userId - User ID
  * @param {string} photoId - Photo ID to set as main
  */
 async setMainPhoto(userId, photoId) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     const photo = user.profile.photos.find(p => p._id.toString() === photoId);
     if (!photo) {
       throw new AppError('Photo not found', 404, ERROR_CODES.NOT_FOUND);
     }

     // Unset all main flags
     user.profile.photos.forEach(p => {
       p.isMain = false;
     });

     // Set new main photo
     photo.isMain = true;

     await user.save();

     // Clear cache
     await CacheService.invalidateUser(userId);

     logger.info(`Main photo set for user ${userId}`);

     return user.profile.photos;
   } catch (error) {
     logger.error(`Error setting main photo for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Update user location
  * @param {string} userId - User ID
  * @param {Object} location - Location data
  */
 async updateLocation(userId, location) {
   try {
     const { latitude, longitude, address } = location;

     // Validate coordinates
     if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
       throw new AppError('Invalid coordinates', 400, ERROR_CODES.VALIDATION_ERROR);
     }

     const updateData = {
       'profile.location': {
         type: 'Point',
         coordinates: [longitude, latitude],
         lastUpdated: new Date(),
       },
     };

     if (address) {
       updateData['profile.location.address'] = address;
     }

     const user = await User.findByIdAndUpdate(
       userId,
       { $set: updateData },
       { new: true }
     );

     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Clear location-based caches
     await CacheService.invalidatePattern(`recommendations:${userId}*`);
     await CacheService.invalidatePattern(`nearby:${userId}*`);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'location_updated', {
       hasAddress: !!address,
     });

     logger.info(`Location updated for user ${userId}`);

     return user.profile.location;
   } catch (error) {
     logger.error(`Error updating location for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Update user preferences
  * @param {string} userId - User ID
  * @param {Object} preferences - New preferences
  */
 async updatePreferences(userId, preferences) {
   try {
     // Validate preferences
     if (preferences.ageRange) {
       const { min, max } = preferences.ageRange;
       if (min < USER_CONSTANTS.MIN_AGE || max > USER_CONSTANTS.MAX_AGE || min > max) {
         throw new AppError(
           'Invalid age range',
           400,
           ERROR_CODES.VALIDATION_ERROR
         );
       }
     }

     if (preferences.maxDistance) {
       if (
         preferences.maxDistance < USER_CONSTANTS.MIN_SEARCH_RADIUS ||
         preferences.maxDistance > USER_CONSTANTS.MAX_SEARCH_RADIUS
       ) {
         throw new AppError(
           `Distance must be between ${USER_CONSTANTS.MIN_SEARCH_RADIUS} and ${USER_CONSTANTS.MAX_SEARCH_RADIUS} km`,
           400,
           ERROR_CODES.VALIDATION_ERROR
         );
       }
     }

     const user = await User.findByIdAndUpdate(
       userId,
       { $set: { preferences } },
       { new: true, runValidators: true }
     );

     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Clear recommendation cache as preferences changed
     await CacheService.invalidatePattern(`recommendations:${userId}*`);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'preferences_updated', preferences);

     logger.info(`Preferences updated for user ${userId}`);

     return user.preferences;
   } catch (error) {
     logger.error(`Error updating preferences for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Get user recommendations
  * @param {string} userId - User ID
  * @param {Object} options - Recommendation options
  */
 async getRecommendations(userId, options = {}) {
   try {
     const { 
       limit = 10, 
       page = 1, 
       includeBoosts = true,
       filters = {} 
     } = options;

     // Check cache
     const cacheKey = `recommendations:${userId}:${page}:${limit}`;
     const cached = await CacheService.getCachedRecommendations(userId);
     if (cached && cached.length > 0) {
       return cached.slice((page - 1) * limit, page * limit);
     }

     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Get already swiped users
     const swipedUserIds = await Swipe.distinct('to', {
       from: userId,
       isActive: true,
     });

     // Build query
     const query = {
       _id: { 
         $ne: mongoose.Types.ObjectId(userId),
         $nin: swipedUserIds 
       },
       'status.isActive': true,
       'status.isBanned': false,
       'preferences.showMe': true,
       gender: { $in: user.preferences.genderPreference },
     };

     // Apply premium filters
     if (user.isPremium) {
       query['preferences.genderPreference'] = user.profile.gender;
       
       if (filters.verified) {
         query['verification.photo.verified'] = true;
       }
       
       if (filters.hasPhotos) {
         query['profile.photos.0'] = { $exists: true };
       }
       
       if (filters.interests?.length > 0) {
         query['profile.interests'] = { $in: filters.interests };
       }
       
       if (filters.lifestyle) {
         Object.keys(filters.lifestyle).forEach(key => {
           if (filters.lifestyle[key]) {
             query[`profile.lifestyle.${key}`] = filters.lifestyle[key];
           }
         });
       }
     }

     // Aggregate pipeline for recommendations
     const pipeline = [
       { $match: query },
       
       // Geo-location stage
       {
         $geoNear: {
           near: user.profile.location,
           distanceField: 'distance',
           maxDistance: user.preferences.maxDistance * 1000,
           spherical: true,
         },
       },
       
       // Calculate age
       {
         $addFields: {
           age: {
             $divide: [
               { $subtract: [new Date(), '$profile.dateOfBirth'] },
               31557600000,
             ],
           },
         },
       },
       
       // Filter by age
       {
         $match: {
           age: {
             $gte: user.preferences.ageRange.min,
             $lte: user.preferences.ageRange.max,
           },
         },
       },
       
       // Calculate compatibility score
       {
         $addFields: {
           compatibilityScore: {
             $add: [
               // Distance score (30%)
               {
                 $multiply: [
                   {
                     $subtract: [
                       1,
                       { $divide: ['$distance', user.preferences.maxDistance * 1000] },
                     ],
                   },
                   30,
                 ],
               },
               
               // Common interests (25%)
               {
                 $multiply: [
                   {
                     $cond: {
                       if: { $gt: [{ $size: { $ifNull: ['$profile.interests', []] } }, 0] },
                       then: {
                         $divide: [
                           {
                             $size: {
                               $setIntersection: [
                                 '$profile.interests',
                                 user.profile.interests || [],
                               ],
                             },
                           },
                           { $max: [{ $size: { $ifNull: ['$profile.interests', [1]] } }, 1] },
                         ],
                       },
                       else: 0,
                     },
                   },
                   25,
                 ],
               },
               
               // Profile completeness (15%)
               { $multiply: ['$scoring.profileCompleteness', 15] },
               
               // Activity score (15%)
               { $multiply: ['$scoring.activityScore', 15] },
               
               // ELO similarity (15%)
               {
                 $multiply: [
                   {
                     $subtract: [
                       1,
                       {
                         $min: [
                           1,
                           {
                             $divide: [
                               { $abs: { $subtract: ['$scoring.eloScore', user.scoring.eloScore] } },
                               1000,
                             ],
                           },
                         ],
                       },
                     ],
                   },
                   15,
                 ],
               },
             ],
           },
         },
       },
     ];

     // Add boost stage if enabled
     if (includeBoosts) {
       pipeline.push(
         {
           $lookup: {
             from: 'users',
             let: { userId: '$_id' },
             pipeline: [
               {
                 $match: {
                   $expr: {
                     $and: [
                       { $eq: ['$_id', '$$userId'] },
                       { $gt: [{ $size: '$boosts' }, 0] },
                     ],
                   },
                 },
               },
               {
                 $project: {
                   activeBoost: {
                     $filter: {
                       input: '$boosts',
                       cond: { $gt: ['$$this.expiresAt', new Date()] },
                     },
                   },
                 },
               },
             ],
             as: 'boostInfo',
           },
         },
         {
           $addFields: {
             finalScore: {
               $cond: {
                 if: { $gt: [{ $size: { $ifNull: ['$boostInfo.activeBoost', []] } }, 0] },
                 then: { $multiply: ['$compatibilityScore', 2] },
                 else: '$compatibilityScore',
               },
             },
           },
         }
       );
     } else {
       pipeline.push({
         $addFields: {
           finalScore: '$compatibilityScore',
         },
       });
     }

     // Sort and limit
     pipeline.push(
       { $sort: { finalScore: -1 } },
       { $limit: limit * 3 }, // Get extra for filtering
       {
         $project: {
           password: 0,
           security: 0,
           metadata: 0,
           adminNotes: 0,
           boostInfo: 0,
           compatibilityScore: 0,
           finalScore: 0,
         },
       }
     );

     const recommendations = await User.aggregate(pipeline);

     // Additional filtering based on user preferences
     let filtered = recommendations;
     
     // Apply dealbreakers for premium users
     if (user.isPremium && user.preferences.dealbreakers) {
       const { dealbreakers } = user.preferences;
       
       filtered = filtered.filter(rec => {
         if (dealbreakers.smoking && rec.profile.lifestyle?.smoking === 'regularly') {
           return false;
         }
         if (dealbreakers.drinking && rec.profile.lifestyle?.drinking === 'frequently') {
           return false;
         }
         if (dealbreakers.children && rec.profile.lifestyle?.children === 'have') {
           return false;
         }
         return true;
       });
     }

     // Limit to requested amount
     filtered = filtered.slice(0, limit);

     // Cache recommendations
     await CacheService.cacheRecommendations(userId, filtered, 1800); // 30 minutes

     // Track metrics
     await MetricsService.trackUserAction(userId, 'recommendations_generated', {
       count: filtered.length,
       page,
     });

     return filtered;
   } catch (error) {
     logger.error(`Error getting recommendations for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Get nearby users
  * @param {string} userId - User ID
  * @param {number} radius - Search radius in km
  */
 async findNearbyUsers(userId, radius = 10) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     if (!user.profile.location?.coordinates) {
       throw new AppError('Location not set', 400, ERROR_CODES.VALIDATION_ERROR);
     }

     const nearbyUsers = await User.findNearby(
       user.profile.location.coordinates,
       radius
     );

     // Filter out self and blocked users
     const filtered = nearbyUsers.filter(
       u => 
         u._id.toString() !== userId &&
         !user.privacy.blockedUsers.includes(u._id) &&
         !u.privacy.blockedUsers.includes(userId)
     );

     return filtered.map(u => ({
       _id: u._id,
       profile: {
         firstName: u.profile.firstName,
         displayName: u.profile.displayName,
         photos: u.profile.photos.filter(p => p.isMain),
         age: u.age,
       },
       distance: u.distance,
       verification: {
         photo: u.verification.photo.verified,
       },
     }));
   } catch (error) {
     logger.error(`Error finding nearby users for ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Search users (Premium feature)
  * @param {string} userId - User ID performing search
  * @param {Object} searchParams - Search parameters
  */
 async searchUsers(userId, searchParams) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check if user has search permission
     if (!user.isPremium) {
       throw new AppError(
         'Search is a premium feature',
         403,
         ERROR_CODES.FORBIDDEN
       );
     }

     const { query, filters = {}, page = 1, limit = 20 } = searchParams;

     const searchResults = await User.searchUsers(query, {
       ...filters,
       limit,
       skip: (page - 1) * limit,
     });

     // Filter out blocked users
     const filtered = searchResults.filter(
       u => 
         u._id.toString() !== userId &&
         !user.privacy.blockedUsers.includes(u._id) &&
         !u.privacy.blockedUsers.includes(userId)
     );

     // Track search
     await MetricsService.trackUserAction(userId, 'search_performed', {
       query: query ? 'text' : 'filter',
       resultCount: filtered.length,
     });

     return filtered.map(u => u.toMatchProfile());
   } catch (error) {
     logger.error(`Error searching users for ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Block user
  * @param {string} userId - User doing the blocking
  * @param {string} targetUserId - User to block
  */
 async blockUser(userId, targetUserId) {
   try {
     if (userId === targetUserId) {
       throw new AppError('Cannot block yourself', 400, ERROR_CODES.VALIDATION_ERROR);
     }

     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     await user.blockUser(targetUserId);

     // Remove any existing matches
     await Match.updateMany(
       {
         users: { $all: [userId, targetUserId] },
       },
       {
         $set: { 
           'status.isActive': false,
           'status.blockedAt': new Date(),
           'status.blockedBy': userId,
         },
       }
     );

     // Clear caches
     await CacheService.invalidateUser(userId);
     await CacheService.invalidatePattern(`matches:${userId}*`);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'user_blocked', {
       targetUser: targetUserId,
     });

     logger.info(`User ${userId} blocked user ${targetUserId}`);

     return { success: true, message: 'User blocked successfully' };
   } catch (error) {
     logger.error(`Error blocking user ${targetUserId} by ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Unblock user
  * @param {string} userId - User doing the unblocking
  * @param {string} targetUserId - User to unblock
  */
 async unblockUser(userId, targetUserId) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     await user.unblockUser(targetUserId);

     // Clear caches
     await CacheService.invalidateUser(userId);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'user_unblocked', {
       targetUser: targetUserId,
     });

     logger.info(`User ${userId} unblocked user ${targetUserId}`);

     return { success: true, message: 'User unblocked successfully' };
   } catch (error) {
     logger.error(`Error unblocking user ${targetUserId} by ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Get blocked users list
  * /**
  * Get blocked users list
  * @param {string} userId - User ID
  */
 async getBlockedUsers(userId) {
   try {
     const user = await User.findById(userId)
       .populate('privacy.blockedUsers', 'profile.firstName profile.displayName profile.photos');

     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     return user.privacy.blockedUsers.map(blocked => ({
       _id: blocked._id,
       name: blocked.profile.displayName || blocked.profile.firstName,
       photo: blocked.profile.photos?.find(p => p.isMain)?.thumbnailUrl,
     }));
   } catch (error) {
     logger.error(`Error getting blocked users for ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Report user
  * @param {string} reporterId - User making the report
  * @param {string} reportedUserId - User being reported
  * @param {Object} reportData - Report details
  */
 async reportUser(reporterId, reportedUserId, reportData) {
   try {
     if (reporterId === reportedUserId) {
       throw new AppError('Cannot report yourself', 400, ERROR_CODES.VALIDATION_ERROR);
     }

     const { reason, description, evidence = [] } = reportData;

     // Create report (assuming Report model exists)
     const Report = mongoose.model('Report');
     const report = await Report.create({
       reporter: reporterId,
       reportedUser: reportedUserId,
       reason,
       description,
       evidence,
       status: 'pending',
       createdAt: new Date(),
     });

     // Block user automatically
     await this.blockUser(reporterId, reportedUserId);

     // Queue for moderation
     await QueueService.addJob('moderation', {
       type: 'user_report',
       reportId: report._id,
       priority: reason === 'inappropriate_content' ? 10 : 5,
     });

     // Track metrics
     await MetricsService.trackUserAction(reporterId, 'user_reported', {
       reason,
       targetUser: reportedUserId,
     });

     // Notify admins if serious
     if (['harassment', 'fake_profile', 'inappropriate_content'].includes(reason)) {
       await NotificationService.notifyAdmins({
         type: 'urgent_report',
         reportId: report._id,
         reason,
       });
     }

     logger.info(`User ${reportedUserId} reported by ${reporterId} for ${reason}`);

     return { 
       success: true, 
       message: 'Report submitted successfully. User has been blocked.',
       reportId: report._id,
     };
   } catch (error) {
     logger.error(`Error reporting user ${reportedUserId}:`, error);
     throw error;
   }
 }

 /**
  * Pause/unpause account
  * @param {string} userId - User ID
  * @param {boolean} pause - Whether to pause or unpause
  */
 async toggleAccountPause(userId, pause = true) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     if (pause) {
       await user.pauseAccount();
     } else {
       await user.unpauseAccount();
     }

     // Clear caches
     await CacheService.invalidateUser(userId);
     await CacheService.invalidatePattern(`recommendations:*`);

     // Track metrics
     await MetricsService.trackUserAction(userId, pause ? 'account_paused' : 'account_unpaused');

     logger.info(`Account ${pause ? 'paused' : 'unpaused'} for user ${userId}`);

     return { 
       success: true, 
       message: `Account ${pause ? 'paused' : 'unpaused'} successfully`,
       isPaused: pause,
     };
   } catch (error) {
     logger.error(`Error toggling pause for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Delete account
  * @param {string} userId - User ID
  * @param {string} password - User password for verification
  * @param {string} reason - Deletion reason
  */
 async deleteAccount(userId, password, reason = '') {
   try {
     const user = await User.findById(userId).select('+password');
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Verify password
     const isValidPassword = await user.comparePassword(password);
     if (!isValidPassword) {
       throw new AppError('Invalid password', 401, ERROR_CODES.INVALID_CREDENTIALS);
     }

     // Soft delete the account
     await user.softDelete(reason);

     // Deactivate all matches
     await Match.updateMany(
       { users: userId },
       { 
         $set: { 
           'status.isActive': false,
           'status.deactivatedAt': new Date(),
         },
       }
     );

     // Cancel subscription if exists
     if (user.subscription?.stripeSubscriptionId) {
       await QueueService.addJob('payment', {
         action: 'cancel_subscription',
         subscriptionId: user.subscription.stripeSubscriptionId,
         userId,
       });
     }

     // Clear all user data from cache
     await CacheService.invalidateUser(userId);
     await CacheService.invalidatePattern(`*:${userId}:*`);

     // Schedule permanent deletion after 30 days
     await QueueService.addJob('account-deletion', {
       userId,
       scheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
     }, { delay: 30 * 24 * 60 * 60 * 1000 });

     // Send confirmation email
     if (user.email) {
       await NotificationService.sendEmail(user.email, {
         template: 'account_deleted',
         data: {
           name: user.profile.firstName,
           recoveryDays: 30,
         },
       });
     }

     // Track metrics
     await MetricsService.trackUserAction(userId, 'account_deleted', { reason });

     logger.info(`Account deleted for user ${userId}`);

     return {
       success: true,
       message: 'Your account has been deleted. You have 30 days to recover it.',
     };
   } catch (error) {
     logger.error(`Error deleting account for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Restore deleted account
  * @param {string} email - User email
  * @param {string} password - User password
  */
 async restoreAccount(email, password) {
   try {
     const user = await User.findOne({
       email: `deleted_${email}`,
       'status.isDeleted': true,
     }).select('+password');

     if (!user) {
       throw new AppError('Account not found or not eligible for recovery', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check if within recovery period
     const daysSinceDeletion = Math.floor(
       (Date.now() - user.status.deletedAt) / (1000 * 60 * 60 * 24)
     );

     if (daysSinceDeletion > 30) {
       throw new AppError('Recovery period has expired', 400, ERROR_CODES.EXPIRED);
     }

     // Verify password
     const isValidPassword = await user.comparePassword(password);
     if (!isValidPassword) {
       throw new AppError('Invalid credentials', 401, ERROR_CODES.INVALID_CREDENTIALS);
     }

     // Restore account
     await user.restore();

     // Reactivate matches
     await Match.updateMany(
       { 
         users: user._id,
         'status.deactivatedAt': { $exists: true },
       },
       { 
         $set: { 'status.isActive': true },
         $unset: { 'status.deactivatedAt': '' },
       }
     );

     // Track metrics
     await MetricsService.trackUserAction(user._id.toString(), 'account_restored');

     logger.info(`Account restored for user ${user._id}`);

     return {
       success: true,
       message: 'Your account has been restored successfully. Please update your profile.',
       userId: user._id,
     };
   } catch (error) {
     logger.error(`Error restoring account for ${email}:`, error);
     throw error;
   }
 }

 /**
  * Apply boost to user profile
  * @param {string} userId - User ID
  * @param {string} boostType - Type of boost
  * @param {number} duration - Duration in minutes
  */
 async applyBoost(userId, boostType = 'regular', duration = 30) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check if user has boosts available
     if (!user.isPremium && user.limits.monthlyBoosts.count >= 1) {
       throw new AppError('No boosts available', 400, ERROR_CODES.LIMIT_EXCEEDED);
     }

     // Check for active boost
     if (user.hasActiveBoost()) {
       throw new AppError('You already have an active boost', 400, ERROR_CODES.ALREADY_EXISTS);
     }

     // Apply boost
     await user.applyBoost(boostType, duration);

     // Increment boost count
     user.limits.monthlyBoosts.count++;
     await user.save();

     // Clear recommendation caches globally to show boosted profile
     await CacheService.invalidatePattern('recommendations:*');

     // Send notification
     await NotificationService.sendNotification(userId, {
       type: NOTIFICATION_TYPES.SYSTEM,
       title: 'Boost Activated! 🚀',
       body: `Your profile is now boosted for ${duration} minutes`,
       data: { boostType, duration },
     });

     // Track metrics
     await MetricsService.trackUserAction(userId, 'boost_activated', {
       type: boostType,
       duration,
     });

     logger.info(`Boost applied for user ${userId}`);

     return {
       success: true,
       message: 'Boost activated successfully',
       expiresAt: new Date(Date.now() + duration * 60000),
     };
   } catch (error) {
     logger.error(`Error applying boost for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Get user statistics
  * @param {string} userId - User ID
  */
 async getUserStats(userId) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Get additional stats from other collections
     const [swipeStats, matchStats] = await Promise.all([
       Swipe.aggregate([
         { $match: { to: mongoose.Types.ObjectId(userId) } },
         {
           $group: {
             _id: '$action',
             count: { $sum: 1 },
           },
         },
       ]),
       Match.countDocuments({
         users: userId,
         'status.isActive': true,
       }),
     ]);

     const swipeBreakdown = swipeStats.reduce((acc, stat) => {
       acc[stat._id] = stat.count;
       return acc;
     }, {});

     return {
       profile: {
         completeness: user.scoring.profileCompleteness,
         photoCount: user.profile.photos.length,
         verified: user.isVerified,
       },
       activity: {
         totalSwipes: user.stats.totalSwipes,
         swipeRatio: user.stats.swipeRatio,
         lastActive: user.status.lastActive,
         accountAge: Math.floor((Date.now() - user.createdAt) / (1000 * 60 * 60 * 24)),
       },
       popularity: {
         profileViews: user.stats.profileViews,
         likesReceived: swipeBreakdown.like || 0,
         superLikesReceived: swipeBreakdown.superlike || 0,
         totalMatches: matchStats,
       },
       scoring: {
         eloScore: user.scoring.eloScore,
         activityScore: user.scoring.activityScore,
         attractivenessScore: user.scoring.attractivenessScore,
         responseRate: user.scoring.responseRate,
       },
       subscription: {
         type: user.subscription.type,
         validUntil: user.subscription.validUntil,
         features: user.subscription.features,
       },
     };
   } catch (error) {
     logger.error(`Error getting stats for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Verify user photo
  * @param {string} userId - User ID
  * @param {Object} verificationPhoto - Verification photo file
  */
 async verifyUserPhoto(userId, verificationPhoto) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     if (user.verification.photo.verified) {
       throw new AppError('Photo already verified', 400, ERROR_CODES.ALREADY_EXISTS);
     }

     // Upload verification photo
     const uploadResult = await cloudinary.uploader.upload(verificationPhoto.path || verificationPhoto.buffer, {
       folder: `users/${userId}/verification`,
       transformation: [
         { width: 800, height: 800, crop: 'limit', quality: 'auto' },
       ],
     });

     // Queue for manual verification
     await QueueService.addJob('photo-verification', {
       userId,
       verificationPhotoUrl: uploadResult.secure_url,
       userPhotos: user.profile.photos.map(p => p.url),
     }, { priority: 5 });

     // Update user
     user.verification.photo.verificationPhotoUrl = uploadResult.secure_url;
     await user.save();

     // Track metrics
     await MetricsService.trackUserAction(userId, 'photo_verification_requested');

     logger.info(`Photo verification requested for user ${userId}`);

     return {
       success: true,
       message: 'Photo verification request submitted. We\'ll review it within 24 hours.',
     };
   } catch (error) {
     logger.error(`Error verifying photo for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Update subscription
  * @param {string} userId - User ID
  * @param {Object} subscriptionData - Subscription details
  */
 async updateSubscription(userId, subscriptionData) {
   try {
     const { type, validUntil, paymentMethod, stripeSubscriptionId } = subscriptionData;

     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Update subscription
     user.subscription.type = type;
     user.subscription.validUntil = validUntil;
     user.subscription.startedAt = new Date();
     user.subscription.paymentMethod = paymentMethod;
     user.subscription.stripeSubscriptionId = stripeSubscriptionId;

     // Apply subscription features
     user.subscription.features = SUBSCRIPTION_FEATURES[type];

     // Reset limits for premium features
     if (type !== 'free') {
       user.limits.dailyLikes.count = 0;
       user.limits.dailySuperLikes.count = 0;
       user.limits.monthlyBoosts.count = 0;
     }

     await user.save();

     // Clear caches
     await CacheService.invalidateUser(userId);

     // Send confirmation
     await NotificationService.sendNotification(userId, {
       type: NOTIFICATION_TYPES.SYSTEM,
       title: 'Subscription Updated! 🎉',
       body: `You're now on ${type} plan`,
       data: { subscriptionType: type },
     });

     // Track metrics
     await MetricsService.trackUserAction(userId, 'subscription_updated', {
       type,
       paymentMethod,
     });

     logger.info(`Subscription updated for user ${userId} to ${type}`);

     return {
       success: true,
       message: 'Subscription updated successfully',
       subscription: user.subscription,
     };
   } catch (error) {
     logger.error(`Error updating subscription for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Increment profile views
  * @param {string} userId - User ID whose profile was viewed
  */
 async incrementProfileViews(userId) {
   try {
     await User.findByIdAndUpdate(userId, {
       $inc: { 'stats.profileViews': 1 },
     });

     // Track in Redis for rate limiting
     const viewKey = `profile:views:${userId}:${new Date().toISOString().split('T')[0]}`;
     await redis.incr(viewKey);
     await redis.expire(viewKey, 86400); // 24 hours

     return true;
   } catch (error) {
     logger.error(`Error incrementing profile views for ${userId}:`, error);
     return false;
   }
 }

 /**
  * Get top picks for user
  * @param {string} userId - User ID
  * @param {number} limit - Number of picks
  */
 async getTopPicks(userId, limit = 10) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Check if user has access to top picks
     const dailyPicksLimit = user.subscription.features?.topPicks || 0;
     if (dailyPicksLimit === 0) {
       throw new AppError('Top Picks is a premium feature', 403, ERROR_CODES.FORBIDDEN);
     }

     // Check daily limit
     const today = new Date().toISOString().split('T')[0];
     const picksKey = `top-picks:${userId}:${today}`;
     const picksViewed = await redis.get(picksKey) || 0;

     if (picksViewed >= dailyPicksLimit) {
       throw new AppError('Daily Top Picks limit reached', 400, ERROR_CODES.LIMIT_EXCEEDED);
     }

     // Get top picks
     const topPicks = await User.getTopPicksForUser(userId, Math.min(limit, dailyPicksLimit - picksViewed));

     // Track views
     await redis.incr(picksKey);
     await redis.expire(picksKey, 86400);

     // Track metrics
     await MetricsService.trackUserAction(userId, 'top_picks_viewed', {
       count: topPicks.length,
     });

     return topPicks;
   } catch (error) {
     logger.error(`Error getting top picks for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Calculate and update user scores
  * @param {string} userId - User ID
  */
 async updateUserScores(userId) {
   try {
     const user = await User.findById(userId);
     if (!user) {
       throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
     }

     // Update profile completeness
     user.scoring.profileCompleteness = user.calculateProfileCompleteness();

     // Update activity score
     await User.updateActivityScore(userId);

     // Calculate attractiveness score based on like ratio
     const [likesReceived, totalSwipes] = await Promise.all([
       Swipe.countDocuments({ to: userId, action: { $in: ['like', 'superlike'] } }),
       Swipe.countDocuments({ to: userId }),
     ]);

     if (totalSwipes > 0) {
       user.scoring.attractivenessScore = Math.min(1, likesReceived / totalSwipes);
     }

     // Update popularity score
     const recentViews = await redis.get(`profile:views:${userId}:${new Date().toISOString().split('T')[0]}`) || 0;
     user.scoring.popularityScore = Math.min(1, recentViews / 100); // Normalize to 0-1

     user.scoring.lastScoringUpdate = new Date();
     await user.save();

     logger.info(`Scores updated for user ${userId}`);

     return user.scoring;
   } catch (error) {
     logger.error(`Error updating scores for user ${userId}:`, error);
     throw error;
   }
 }
}

export default new UserService();