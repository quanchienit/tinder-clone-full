// modules/match/algorithms/recommendation.algorithm.js
import User from '../../user/user.model.js';
import Swipe from '../swipe.model.js';
import CacheService from '../../../shared/services/cache.service.js';

class RecommendationAlgorithm {
  async getRecommendations(userId, limit = 10) {
    // Try cache first
    const cacheKey = `recommendations:${userId}`;
    const cached = await CacheService.getCachedUser(cacheKey);
    if (cached) return cached;

    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // Get already swiped users to exclude
    const swipedUserIds = await Swipe.distinct('to', { 
      from: userId,
      isActive: true 
    });

    // Build recommendation pipeline
    const recommendations = await User.aggregate([
      // Stage 1: Basic filters
      {
        $match: {
          _id: { 
            $ne: userId,
            $nin: swipedUserIds 
          },
          'status.isActive': true,
          'preferences.showMe': true,
          gender: { $in: user.preferences.genderPreference }
        }
      },

      // Stage 2: Geo-location filter
      {
        $geoNear: {
          near: user.profile.location,
          distanceField: 'distance',
          maxDistance: user.preferences.maxDistance * 1000, // Convert km to meters
          spherical: true,
          query: {
            // Additional filters can be added here
          }
        }
      },

      // Stage 3: Calculate age
      {
        $addFields: {
          age: {
            $dateDiff: {
              startDate: '$profile.dateOfBirth',
              endDate: new Date(),
              unit: 'year'
            }
          }
        }
      },

      // Stage 4: Age filter
      {
        $match: {
          age: {
            $gte: user.preferences.ageRange.min,
            $lte: user.preferences.ageRange.max
          }
        }
      },

      // Stage 5: Calculate compatibility score
      {
        $addFields: {
          compatibilityScore: {
            $add: [
              // Distance score (closer = higher score)
              {
                $multiply: [
                  { 
                    $subtract: [
                      1, 
                      { $divide: ['$distance', user.preferences.maxDistance * 1000] }
                    ]
                  },
                  30 // Weight
                ]
              },

              // Common interests score
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
                                user.profile.interests || []
                              ] 
                            } 
                          },
                          { $size: { $ifNull: ['$profile.interests', [1]] } }
                        ]
                      },
                      else: 0
                    }
                  },
                  25 // Weight
                ]
              },

              // Profile completeness score
              {
                $multiply: [
                  '$scoring.profileCompleteness',
                  15 // Weight
                ]
              },

              // Activity score
              {
                $multiply: [
                  '$scoring.activityScore',
                  15 // Weight
                ]
              },

              // ELO score similarity
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
                              1000
                            ]
                          }
                        ]
                      }
                    ]
                  },
                  15 // Weight
                ]
              }
            ]
          }
        }
      },

      // Stage 6: Boost profiles
      {
        $lookup: {
          from: 'boosts',
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$user', '$$userId'] },
                    { $gte: ['$expiresAt', new Date()] }
                  ]
                }
              }
            }
          ],
          as: 'activeBoost'
        }
      },

      // Stage 7: Apply boost multiplier
      {
        $addFields: {
          finalScore: {
            $cond: {
              if: { $gt: [{ $size: '$activeBoost' }, 0] },
              then: { $multiply: ['$compatibilityScore', 2] },
              else: '$compatibilityScore'
            }
          }
        }
      },

      // Stage 8: Sort by score
      { $sort: { finalScore: -1 } },

      // Stage 9: Limit results
      { $limit: limit * 2 }, // Get more for filtering

      // Stage 10: Clean up fields
      {
        $project: {
          activeBoost: 0,
          compatibilityScore: 0,
          finalScore: 0
        }
      }
    ]);

    // Additional filtering for premium features
    const filteredRecommendations = this.applyPremiumFilters(
      recommendations, 
      user, 
      limit
    );

    // Cache results
    await CacheService.cacheRecommendations(
      userId, 
      filteredRecommendations, 
      1800 // 30 minutes
    );

    return filteredRecommendations;
  }

  applyPremiumFilters(recommendations, user, limit) {
    let filtered = recommendations;

    // Apply additional filters for premium users
    if (user.subscription.type !== 'free') {
      // Premium users can filter by more criteria
      if (user.preferences.heightRange) {
        filtered = filtered.filter(r => 
          r.profile.height >= user.preferences.heightRange.min &&
          r.profile.height <= user.preferences.heightRange.max
        );
      }

      if (user.preferences.languages?.length > 0) {
        filtered = filtered.filter(r =>
          r.profile.languages?.some(lang => 
            user.preferences.languages.includes(lang.language)
          )
        );
      }
    }

    return filtered.slice(0, limit);
  }

  // Update ELO scores after swipe
  async updateEloScores(swiperId, swipedId, action) {
    const K = 32; // K-factor for ELO calculation
    
    const swiper = await User.findById(swiperId).select('scoring.eloScore');
    const swiped = await User.findById(swipedId).select('scoring.eloScore');

    const expectedScoreSwiper = 1 / (1 + Math.pow(10, (swiped.scoring.eloScore - swiper.scoring.eloScore) / 400));
    
    let actualScore;
    switch(action) {
      case 'superlike':
        actualScore = 1;
        break;
      case 'like':
        actualScore = 0.7;
        break;
      case 'nope':
        actualScore = 0.3;
        break;
      default:
        actualScore = 0.5;
    }

    const newEloSwiper = swiper.scoring.eloScore + K * (actualScore - expectedScoreSwiper);
    const newEloSwiped = swiped.scoring.eloScore + K * ((1 - actualScore) - (1 - expectedScoreSwiper));

    await Promise.all([
      User.findByIdAndUpdate(swiperId, { 'scoring.eloScore': Math.round(newEloSwiper) }),
      User.findByIdAndUpdate(swipedId, { 'scoring.eloScore': Math.round(newEloSwiped) })
    ]);
  }
}

export default new RecommendationAlgorithm();