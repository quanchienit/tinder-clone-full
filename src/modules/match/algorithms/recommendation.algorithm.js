// src/modules/match/algorithms/recommendation.algorithm.js
import mongoose from 'mongoose';
import User from '../../user/user.model.js';
import Swipe from '../swipe.model.js';
import Match from '../match.model.js';
import redis from '../../../config/redis.js';
import logger from '../../../shared/utils/logger.js';
import CacheService from '../../../shared/services/cache.service.js';
import MetricsService from '../../../shared/services/metrics.service.js';
import { 
 USER_CONSTANTS, 
 SWIPE_ACTIONS,
 SUBSCRIPTION_FEATURES 
} from '../../../config/constants.js';

class RecommendationAlgorithm {
 constructor() {
   // Algorithm weights for scoring
   this.weights = {
     distance: 0.25,        // 25% - Physical proximity
     interests: 0.20,       // 20% - Common interests
     attractiveness: 0.15,  // 15% - Attractiveness score
     activity: 0.15,        // 15% - Activity level
     compatibility: 0.15,   // 15% - Profile compatibility
     freshness: 0.10,       // 10% - New/recently active users
   };

   // ELO K-factor for score updates
   this.eloKFactor = 32;

   // Decay factors
   this.decayFactors = {
     lastActive: 0.95,      // 5% decay per day inactive
     accountAge: 0.98,      // 2% decay per month old
     swipeRatio: 0.90,      // 10% penalty for very selective swipers
   };
 }

 /**
  * Get recommendations for a user
  * @param {string} userId - User ID
  * @param {Object} options - Recommendation options
  */
 async getRecommendations(userId, options = {}) {
   try {
     const {
       limit = 10,
       offset = 0,
       includeBoosts = true,
       applyFilters = true,
       cacheResults = true,
     } = options;

     // Try cache first
     if (cacheResults) {
       const cached = await CacheService.getCachedRecommendations(userId);
       if (cached && cached.length > 0) {
         logger.debug(`Recommendations retrieved from cache for user ${userId}`);
         return cached.slice(offset, offset + limit);
       }
     }

     // Get user data
     const user = await this.getUserWithPreferences(userId);
     if (!user) {
       throw new Error('User not found');
     }

     // Get already swiped users to exclude
     const excludedUserIds = await this.getExcludedUsers(userId);

     // Build recommendation pipeline
     const pipeline = this.buildRecommendationPipeline(
       user,
       excludedUserIds,
       limit * 3, // Get extra for post-processing
       applyFilters
     );

     // Execute aggregation
     let recommendations = await User.aggregate(pipeline);

     // Post-process recommendations
     recommendations = await this.postProcessRecommendations(
       recommendations,
       user,
       includeBoosts
     );

     // Apply machine learning adjustments if available
     recommendations = await this.applyMLAdjustments(recommendations, user);

     // Limit and offset
     recommendations = recommendations.slice(offset, offset + limit);

     // Cache results
     if (cacheResults && recommendations.length > 0) {
       await CacheService.cacheRecommendations(userId, recommendations, 1800); // 30 minutes
     }

     // Track metrics
     await this.trackRecommendationMetrics(userId, recommendations.length);

     return recommendations;
   } catch (error) {
     logger.error(`Error getting recommendations for user ${userId}:`, error);
     throw error;
   }
 }

 /**
  * Build MongoDB aggregation pipeline for recommendations
  */
 buildRecommendationPipeline(user, excludedUserIds, limit, applyFilters) {
   const pipeline = [];

   // Stage 1: Basic filters
   const matchStage = {
     $match: {
       _id: { 
         $ne: mongoose.Types.ObjectId(user._id),
         $nin: excludedUserIds.map(id => mongoose.Types.ObjectId(id))
       },
       'status.isActive': true,
       'status.isBanned': false,
       'status.isDeleted': false,
       'preferences.showMe': true,
     },
   };

   // Add gender preferences (mutual)
   if (user.preferences?.genderPreference?.length > 0) {
     matchStage.$match.gender = { $in: user.preferences.genderPreference };
   }
   if (user.profile?.gender) {
     matchStage.$match['preferences.genderPreference'] = user.profile.gender;
   }

   pipeline.push(matchStage);

   // Stage 2: Geo-location filter (if location is set)
   if (user.profile?.location?.coordinates) {
     pipeline.push({
       $geoNear: {
         near: user.profile.location,
         distanceField: 'calculatedDistance',
         maxDistance: (user.preferences?.maxDistance || USER_CONSTANTS.DEFAULT_SEARCH_RADIUS) * 1000,
         spherical: true,
         query: {
           'profile.location': { $exists: true },
         },
       },
     });
   }

   // Stage 3: Calculate age and filter
   pipeline.push(
     {
       $addFields: {
         calculatedAge: {
           $divide: [
             { $subtract: [new Date(), '$profile.dateOfBirth'] },
             31557600000, // milliseconds in a year
           ],
         },
       },
     },
     {
       $match: {
         calculatedAge: {
           $gte: user.preferences?.ageRange?.min || USER_CONSTANTS.MIN_AGE,
           $lte: user.preferences?.ageRange?.max || 100,
         },
       },
     }
   );

   // Stage 4: Apply premium filters if user has subscription
   if (applyFilters && user.isPremium) {
     pipeline.push(...this.buildPremiumFilters(user));
   }

   // Stage 5: Calculate compatibility scores
   pipeline.push({
     $addFields: {
       scores: this.buildScoringStage(user),
     },
   });

   // Stage 6: Calculate final score
   pipeline.push({
     $addFields: {
       finalScore: {
         $sum: [
           { $multiply: ['$scores.distanceScore', this.weights.distance] },
           { $multiply: ['$scores.interestScore', this.weights.interests] },
           { $multiply: ['$scores.attractivenessScore', this.weights.attractiveness] },
           { $multiply: ['$scores.activityScore', this.weights.activity] },
           { $multiply: ['$scores.compatibilityScore', this.weights.compatibility] },
           { $multiply: ['$scores.freshnessScore', this.weights.freshness] },
         ],
       },
     },
   });

   // Stage 7: Sort by score
   pipeline.push({ $sort: { finalScore: -1 } });

   // Stage 8: Limit results
   pipeline.push({ $limit: limit });

   // Stage 9: Clean up fields
   pipeline.push({
     $project: {
       password: 0,
       security: 0,
       'verification.email': 0,
       'verification.phone': 0,
       metadata: 0,
       adminNotes: 0,
       scores: 0,
       calculatedAge: 0,
       calculatedDistance: 0,
     },
   });

   return pipeline;
 }

 /**
  * Build scoring calculations for aggregation
  */
 buildScoringStage(user) {
   return {
     // Distance Score (inverse - closer is better)
     distanceScore: {
       $cond: {
         if: { $gt: ['$calculatedDistance', 0] },
         then: {
           $subtract: [
             1,
             {
               $min: [
                 1,
                 {
                   $divide: [
                     '$calculatedDistance',
                     (user.preferences?.maxDistance || USER_CONSTANTS.DEFAULT_SEARCH_RADIUS) * 1000,
                   ],
                 },
               ],
             },
           ],
         },
         else: 0.5, // Default score if no distance
       },
     },

     // Interest Score (common interests)
     interestScore: {
       $cond: {
         if: {
           $and: [
             { $isArray: '$profile.interests' },
             { $gt: [{ $size: { $ifNull: ['$profile.interests', []] } }, 0] },
           ],
         },
         then: {
           $min: [
             1,
             {
               $divide: [
                 {
                   $size: {
                     $setIntersection: [
                       { $ifNull: ['$profile.interests', []] },
                       user.profile?.interests || [],
                     ],
                   },
                 },
                 { $max: [{ $size: { $ifNull: ['$profile.interests', [1]] } }, 1] },
               ],
             },
           ],
         },
         else: 0,
       },
     },

     // Attractiveness Score (based on ELO and like ratio)
     attractivenessScore: {
       $add: [
         // ELO component (40%)
         {
           $multiply: [
             0.4,
             {
               $divide: [
                 { $ifNull: ['$scoring.eloScore', 1500] },
                 3000, // Max ELO
               ],
             },
           ],
         },
         // Popularity component (60%)
         {
           $multiply: [
             0.6,
             { $ifNull: ['$scoring.popularityScore', 0.5] },
           ],
         },
       ],
     },

     // Activity Score
     activityScore: {
       $multiply: [
         { $ifNull: ['$scoring.activityScore', 0.5] },
         // Boost for recently active
         {
           $cond: {
             if: {
               $gte: [
                 '$status.lastActive',
                 new Date(Date.now() - 24 * 60 * 60 * 1000), // Active in last 24h
               ],
             },
             then: 1.2,
             else: 1,
           },
         },
       ],
     },

     // Compatibility Score (lifestyle, education, etc.)
     compatibilityScore: {
       $avg: [
         // Profile completeness
         { $ifNull: ['$scoring.profileCompleteness', 0.5] },
         
         // Lifestyle compatibility
         this.calculateLifestyleCompatibility(user),
         
         // Education level compatibility
         this.calculateEducationCompatibility(user),
         
         // Relationship goals alignment
         this.calculateGoalsCompatibility(user),
         
         // Verification bonus
         {
           $cond: {
             if: { $eq: ['$verification.photo.verified', true] },
             then: 1,
             else: 0.7,
           },
         },
       ],
     },

     // Freshness Score (new users or recently joined)
     freshnessScore: {
       $cond: {
         if: {
           $gte: [
             '$createdAt',
             new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Joined in last 7 days
           ],
         },
         then: 1,
         else: {
           $cond: {
             if: {
               $gte: [
                 '$createdAt',
                 new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Joined in last 30 days
               ],
             },
             then: 0.7,
             else: 0.4,
           },
         },
       },
     },
   };
 }

 /**
  * Calculate lifestyle compatibility score
  */
 calculateLifestyleCompatibility(user) {
   const lifestyle = user.profile?.lifestyle;
   if (!lifestyle) return 0.5;

   const checks = [];

   // Drinking compatibility
   if (lifestyle.drinking) {
     checks.push({
       $cond: {
         if: { $eq: ['$profile.lifestyle.drinking', lifestyle.drinking] },
         then: 1,
         else: 0.7,
       },
     });
   }

   // Smoking compatibility (more strict)
   if (lifestyle.smoking) {
     checks.push({
       $cond: {
         if: { $eq: ['$profile.lifestyle.smoking', lifestyle.smoking] },
         then: 1,
         else: lifestyle.smoking === 'never' ? 0.3 : 0.7,
       },
     });
   }

   // Add more lifestyle checks...

   return checks.length > 0 ? { $avg: checks } : 0.5;
 }

 /**
  * Calculate education compatibility score
  */
 calculateEducationCompatibility(user) {
   if (!user.profile?.education?.level) return 0.5;

   return {
     $cond: {
       if: { $eq: ['$profile.education.level', user.profile.education.level] },
       then: 1,
       else: 0.7,
     },
   };
 }

 /**
  * Calculate relationship goals compatibility
  */
 calculateGoalsCompatibility(user) {
   if (!user.profile?.relationshipGoal) return 0.5;

   return {
     $cond: {
       if: { $eq: ['$profile.relationshipGoal', user.profile.relationshipGoal] },
       then: 1,
       else: 0.5,
     },
   };
 }

 /**
  * Build premium filters for aggregation
  */
 buildPremiumFilters(user) {
   const filters = [];

   // Height filter (Gold+)
   if (user.subscription?.type === 'gold' || user.subscription?.type === 'platinum') {
     if (user.preferences?.heightRange) {
       filters.push({
         $match: {
           'profile.height': {
             $gte: user.preferences.heightRange.min,
             $lte: user.preferences.heightRange.max,
           },
         },
       });
     }
   }

   // Verified only filter (Platinum)
   if (user.subscription?.type === 'platinum') {
     if (user.preferences?.verifiedOnly) {
       filters.push({
         $match: {
           'verification.photo.verified': true,
         },
       });
     }
   }

   return filters;
 }

 /**
  * Post-process recommendations
  */
 async postProcessRecommendations(recommendations, user, includeBoosts) {
   try {
     // Apply boost multipliers if enabled
     if (includeBoosts) {
       recommendations = await this.applyBoostMultipliers(recommendations);
     }

     // Apply subscription-based sorting
     recommendations = this.applySubscriptionSorting(recommendations, user);

     // Diversify recommendations
     recommendations = this.diversifyRecommendations(recommendations);

     // Add recommendation metadata
     recommendations = recommendations.map((rec, index) => ({
       ...rec,
       recommendationRank: index + 1,
       recommendationScore: rec.finalScore,
       recommendedAt: new Date(),
     }));

     return recommendations;
   } catch (error) {
     logger.error('Error post-processing recommendations:', error);
     return recommendations;
   }
 }

 /**
  * Apply boost multipliers to boosted profiles
  */
 async applyBoostMultipliers(recommendations) {
   const now = new Date();
   
   return recommendations.map(rec => {
     // Check for active boosts
     const activeBoost = rec.boosts?.find(boost => 
       boost.expiresAt > now
     );

     if (activeBoost) {
       // Apply boost multiplier
       const multiplier = activeBoost.type === 'super' ? 2.0 : 1.5;
       rec.finalScore = (rec.finalScore || 0) * multiplier;
       rec.isBoosted = true;
       rec.boostType = activeBoost.type;
     }

     return rec;
   });
 }

 /**
  * Apply subscription-based sorting priorities
  */
 applySubscriptionSorting(recommendations, user) {
   // Platinum users see other premium users first
   if (user.subscription?.type === 'platinum') {
     recommendations.sort((a, b) => {
       const aPremium = a.subscription?.type !== 'free' ? 1 : 0;
       const bPremium = b.subscription?.type !== 'free' ? 1 : 0;
       
       if (aPremium !== bPremium) {
         return bPremium - aPremium;
       }
       return (b.finalScore || 0) - (a.finalScore || 0);
     });
   }

   return recommendations;
 }

 /**
  * Diversify recommendations to avoid monotony
  */
 diversifyRecommendations(recommendations) {
   if (recommendations.length <= 3) return recommendations;

   const diversified = [];
   const used = new Set();

   // Categorize by attributes
   const categories = {
     highScore: [],
     verified: [],
     newUsers: [],
     active: [],
     rest: [],
   };

   recommendations.forEach(rec => {
     if (rec.finalScore > 0.8) {
       categories.highScore.push(rec);
     } else if (rec.verification?.photo?.verified) {
       categories.verified.push(rec);
     } else if (new Date(rec.createdAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) {
       categories.newUsers.push(rec);
     } else if (new Date(rec.status?.lastActive) > new Date(Date.now() - 24 * 60 * 60 * 1000)) {
       categories.active.push(rec);
     } else {
       categories.rest.push(rec);
     }
   });

   // Mix categories for diversity
   const categoryOrder = ['highScore', 'verified', 'newUsers', 'active', 'rest'];
   let categoryIndex = 0;

   while (diversified.length < recommendations.length) {
     const category = categories[categoryOrder[categoryIndex % categoryOrder.length]];
     
     if (category.length > 0) {
       const rec = category.shift();
       if (!used.has(rec._id.toString())) {
         diversified.push(rec);
         used.add(rec._id.toString());
       }
     }
     
     categoryIndex++;
     
     // Prevent infinite loop
     if (categoryIndex > recommendations.length * 2) break;
   }

   return diversified;
 }

 /**
  * Apply machine learning adjustments
  */
 async applyMLAdjustments(recommendations, user) {
   try {
     // Get user's swipe patterns
     const swipePatterns = await this.getUserSwipePatterns(user._id.toString());
     
     if (!swipePatterns) return recommendations;

     // Adjust scores based on learned preferences
     return recommendations.map(rec => {
       let adjustmentFactor = 1.0;

       // Age preference adjustment
       if (swipePatterns.preferredAgeRange) {
         const age = Math.floor((Date.now() - new Date(rec.profile?.dateOfBirth)) / 31557600000);
         if (age >= swipePatterns.preferredAgeRange.min && age <= swipePatterns.preferredAgeRange.max) {
           adjustmentFactor *= 1.1;
         }
       }

       // Photo count preference
       if (swipePatterns.avgPhotoCount && rec.profile?.photos) {
         const photoCountDiff = Math.abs(rec.profile.photos.length - swipePatterns.avgPhotoCount);
         adjustmentFactor *= (1 - photoCountDiff * 0.05); // 5% penalty per photo difference
       }

       // Interest overlap preference
       if (swipePatterns.commonInterestWeight && rec.profile?.interests && user.profile?.interests) {
         const commonInterests = rec.profile.interests.filter(i => 
           user.profile.interests.includes(i)
         ).length;
         adjustmentFactor *= (1 + commonInterests * swipePatterns.commonInterestWeight);
       }

       // Apply adjustment
       rec.finalScore = (rec.finalScore || 0) * adjustmentFactor;
       rec.mlAdjusted = true;

       return rec;
     });
   } catch (error) {
     logger.error('Error applying ML adjustments:', error);
     return recommendations;
   }
 }

 /**
  * Get user's swipe patterns for ML
  */
 async getUserSwipePatterns(userId) {
   try {
     const cacheKey = `swipe-patterns:${userId}`;
     let patterns = await redis.get(cacheKey);
     
     if (patterns) {
       return JSON.parse(patterns);
     }

     // Analyze user's positive swipes
     const likedUsers = await Swipe.aggregate([
       {
         $match: {
           from: mongoose.Types.ObjectId(userId),
           action: { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] },
         },
       },
       {
         $lookup: {
           from: 'users',
           localField: 'to',
           foreignField: '_id',
           as: 'likedUser',
         },
       },
       { $unwind: '$likedUser' },
       {
         $group: {
           _id: null,
           avgAge: {
             $avg: {
               $divide: [
                 { $subtract: [new Date(), '$likedUser.profile.dateOfBirth'] },
                 31557600000,
               ],
             },
           },
           minAge: {
             $min: {
               $divide: [
                 { $subtract: [new Date(), '$likedUser.profile.dateOfBirth'] },
                 31557600000,
               ],
             },
           },
           maxAge: {
             $max: {
               $divide: [
                 { $subtract: [new Date(), '$likedUser.profile.dateOfBirth'] },
                 31557600000,
               ],
             },
           },
           avgPhotoCount: { $avg: { $size: { $ifNull: ['$likedUser.profile.photos', []] } } },
           commonInterests: { $push: '$likedUser.profile.interests' },
         },
       },
     ]);

     if (likedUsers.length === 0) return null;

     patterns = {
       preferredAgeRange: {
         min: Math.floor(likedUsers[0].minAge),
         max: Math.ceil(likedUsers[0].maxAge),
       },
       avgPhotoCount: Math.round(likedUsers[0].avgPhotoCount),
       commonInterestWeight: 0.1, // Can be calculated based on frequency
     };

     // Cache for 1 hour
     await redis.set(cacheKey, JSON.stringify(patterns), 3600);

     return patterns;
   } catch (error) {
     logger.error('Error getting swipe patterns:', error);
     return null;
   }
 }

 /**
  * Get excluded users (already swiped or matched)
  */
 async getExcludedUsers(userId) {
   try {
     // Get swiped users
     const swipedUsers = await Swipe.distinct('to', {
       from: userId,
       isActive: true,
     });

     // Get matched users
     const matches = await Match.find({
       users: userId,
       'status.isActive': true,
     }).select('users');

     const matchedUsers = matches.reduce((acc, match) => {
       const otherUser = match.users.find(u => u.toString() !== userId);
       if (otherUser) acc.push(otherUser);
       return acc;
     }, []);

     // Get blocked users
     const user = await User.findById(userId).select('privacy.blockedUsers');
     const blockedUsers = user?.privacy?.blockedUsers || [];

     // Combine all excluded users
     const excluded = new Set([
       ...swipedUsers.map(id => id.toString()),
       ...matchedUsers.map(id => id.toString()),
       ...blockedUsers.map(id => id.toString()),
     ]);

     return Array.from(excluded);
   } catch (error) {
     logger.error('Error getting excluded users:', error);
     return [];
   }
 }

 /**
  * Get user with preferences for recommendations
  */
 async getUserWithPreferences(userId) {
   try {
     const user = await User.findById(userId)
       .select('profile preferences subscription scoring status')
       .lean();

     if (!user) return null;

     // Add computed properties
     user.isPremium = user.subscription?.type !== 'free' && 
                     user.subscription?.validUntil > new Date();

     return user;
   } catch (error) {
     logger.error('Error getting user with preferences:', error);
     return null;
   }
 }

 /**
  * Update ELO scores after a swipe
  */
 async updateEloScores(swiperId, swipedId, action) {
   try {
     const [swiper, swiped] = await Promise.all([
       User.findById(swiperId).select('scoring.eloScore'),
       User.findById(swipedId).select('scoring.eloScore'),
     ]);

     if (!swiper || !swiped) return;

     const swiperElo = swiper.scoring?.eloScore || 1500;
     const swipedElo = swiped.scoring?.eloScore || 1500;

     // Calculate expected scores
     const expectedSwiper = 1 / (1 + Math.pow(10, (swipedElo - swiperElo) / 400));
     const expectedSwiped = 1 / (1 + Math.pow(10, (swiperElo - swipedElo) / 400));

     // Actual scores based on action
     let actualSwiper, actualSwiped;
     switch (action) {
       case SWIPE_ACTIONS.SUPER_LIKE:
         actualSwiper = 1;
         actualSwiped = 1;
         break;
       case SWIPE_ACTIONS.LIKE:
         actualSwiper = 0.7;
         actualSwiped = 0.7;
         break;
       case SWIPE_ACTIONS.NOPE:
         actualSwiper = 0.3;
         actualSwiped = 0.3;
         break;
       default:
         actualSwiper = 0.5;
         actualSwiped = 0.5;
     }

     // Calculate new ELO scores
     const newSwiperElo = Math.round(swiperElo + this.eloKFactor * (actualSwiper - expectedSwiper));
     const newSwipedElo = Math.round(swipedElo + this.eloKFactor * (actualSwiped - expectedSwiped));

     // Update scores
     await Promise.all([
       User.findByIdAndUpdate(swiperId, {
         'scoring.eloScore': Math.max(0, Math.min(3000, newSwiperElo)),
       }),
       User.findByIdAndUpdate(swipedId, {
         'scoring.eloScore': Math.max(0, Math.min(3000, newSwipedElo)),
       }),
     ]);

     logger.debug(`ELO updated - Swiper: ${swiperElo} -> ${newSwiperElo}, Swiped: ${swipedElo} -> ${newSwipedElo}`);
   } catch (error) {
     logger.error('Error updating ELO scores:', error);
   }
 }

 /**
  * Track recommendation metrics
  */
 async trackRecommendationMetrics(userId, count) {
   try {
     await MetricsService.trackUserAction(userId, 'recommendations_generated', {
       count,
       timestamp: new Date(),
     });

     // Track daily recommendation views
     const today = new Date().toISOString().split('T')[0];
     const key = `recommendations:views:${userId}:${today}`;
     await redis.incr(key);
     await redis.expire(key, 86400);
   } catch (error) {
     logger.error('Error tracking recommendation metrics:', error);
   }
 }

 /**
  * Get recommendation insights for user
  */
 async getRecommendationInsights(userId) {
   try {
     const user = await User.findById(userId).select('scoring subscription');
     
     const insights = {
       eloScore: user.scoring?.eloScore || 1500,
       eloPercentile: await this.calculateEloPercentile(user.scoring?.eloScore),
       attractivenessScore: user.scoring?.attractivenessScore || 0.5,
       activityScore: user.scoring?.activityScore || 0.5,
       profileCompleteness: user.scoring?.profileCompleteness || 0,
       recommendationQuality: 'standard',
       estimatedMatches: 0,
     };

     // Calculate recommendation quality
     if (user.subscription?.type === 'platinum') {
       insights.recommendationQuality = 'premium';
     } else if (user.subscription?.type === 'gold') {
       insights.recommendationQuality = 'enhanced';
     }

     // Estimate potential matches
     insights.estimatedMatches = Math.round(
       (insights.eloPercentile / 100) * 
       (insights.attractivenessScore) * 
       (insights.activityScore) * 
       100
     );

     return insights;
   } catch (error) {
     logger.error('Error getting recommendation insights:', error);
     return null;
   }
 }

 /**
  * Calculate ELO percentile
  */
 async calculateEloPercentile(eloScore) {
   try {
     const count = await User.countDocuments({
       'scoring.eloScore': { $lt: eloScore },
       'status.isActive': true,
     });

     const total = await User.countDocuments({
       'status.isActive': true,
     });

     return Math.round((count / total) * 100);
   } catch (error) {
     logger.error('Error calculating ELO percentile:', error);
     return 50;
   }
 }
}

export default new RecommendationAlgorithm();