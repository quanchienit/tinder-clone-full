// src/modules/match/algorithms/elo.algorithm.js
import User from "../../user/user.model.js";
import Swipe from "../swipe.model.js";
import Match from "../match.model.js";
import redis from "../../../config/redis.js";
import logger from "../../../shared/utils/logger.js";
import MetricsService from "../../../shared/services/metrics.service.js";
import { SWIPE_ACTIONS, DEFAULTS } from "../../../config/constants.js";

/**
 * ELO Rating Algorithm for Dating App
 * Based on chess ELO system with modifications for dating context
 */
class EloAlgorithm {
  constructor() {
    // Configuration
    this.config = {
      // Base K-factor (volatility of rating changes)
      baseKFactor: 32,

      // K-factor adjustments based on user activity
      kFactorModifiers: {
        newUser: 2.0, // New users (< 30 swipes)
        lowActivity: 1.5, // Low activity users (< 100 swipes)
        normalActivity: 1.0, // Normal activity (100-500 swipes)
        highActivity: 0.8, // High activity (> 500 swipes)
      },

      // Action weights for score calculation
      actionWeights: {
        [SWIPE_ACTIONS.SUPER_LIKE]: 1.0,
        [SWIPE_ACTIONS.LIKE]: 0.7,
        [SWIPE_ACTIONS.NOPE]: 0.3,
      },

      // Score boundaries
      minScore: 0,
      maxScore: 3000,
      defaultScore: DEFAULTS.ELO_SCORE || 1500,

      // Tier boundaries for ranking
      tiers: {
        bronze: { min: 0, max: 1200 },
        silver: { min: 1200, max: 1500 },
        gold: { min: 1500, max: 1800 },
        platinum: { min: 1800, max: 2200 },
        diamond: { min: 2200, max: 3000 },
      },

      // Decay settings
      decay: {
        enabled: true,
        inactivityDays: 7, // Start decay after 7 days
        dailyDecayRate: 0.005, // 0.5% daily decay
        minDecayScore: 1200, // Don't decay below this
      },

      // Bonus/penalty factors
      bonuses: {
        mutualLike: 50, // Bonus for mutual match
        superLikeReceived: 30, // Bonus for receiving super like
        profileCompletion: 100, // One-time bonus for complete profile
        photoVerification: 50, // Bonus for verified photos
      },

      // Streak bonuses
      streaks: {
        dailyActive: 5, // Daily login bonus
        weeklyActive: 20, // Weekly activity bonus
        matchStreak: 10, // Consecutive matches bonus
      },
    };

    // Cache settings
    this.cacheConfig = {
      ttl: 3600, // 1 hour cache
      prefix: "elo:",
    };

    // Analytics tracking
    this.metricsEnabled = true;
  }

  /**
   * Calculate new ELO scores after a swipe interaction
   * @param {string} swiperId - User who swiped
   * @param {string} swipedId - User who was swiped on
   * @param {string} action - Swipe action (like, nope, superlike)
   * @param {Object} context - Additional context (mutual match, etc.)
   */
  async calculateNewScores(swiperId, swipedId, action, context = {}) {
    try {
      // Get current scores
      const [swiperData, swipedData] = await Promise.all([
        this.getUserEloData(swiperId),
        this.getUserEloData(swipedId),
      ]);

      if (!swiperData || !swipedData) {
        throw new Error("Unable to fetch user ELO data");
      }

      // Calculate expected outcomes
      const expectedSwiper = this.calculateExpectedScore(
        swiperData.eloScore,
        swipedData.eloScore,
      );
      const expectedSwiped = this.calculateExpectedScore(
        swipedData.eloScore,
        swiperData.eloScore,
      );

      // Get actual outcomes based on action
      const actualSwiper = this.getActionWeight(action);
      const actualSwiped = this.getRecipientWeight(action);

      // Get K-factors
      const kFactorSwiper = this.calculateKFactor(swiperData);
      const kFactorSwiped = this.calculateKFactor(swipedData);

      // Calculate score changes
      let deltaSwiper = kFactorSwiper * (actualSwiper - expectedSwiper);
      let deltaSwiped = kFactorSwiped * (actualSwiped - expectedSwiped);

      // Apply context bonuses
      if (context.isMutualMatch) {
        deltaSwiper += this.config.bonuses.mutualLike;
        deltaSwiped += this.config.bonuses.mutualLike;
      }

      if (action === SWIPE_ACTIONS.SUPER_LIKE) {
        deltaSwiped += this.config.bonuses.superLikeReceived;
      }

      // Calculate new scores
      const newSwiperScore = this.clampScore(swiperData.eloScore + deltaSwiper);
      const newSwipedScore = this.clampScore(swipedData.eloScore + deltaSwiped);

      // Update scores in database
      await this.updateUserScores(
        swiperId,
        swipedId,
        newSwiperScore,
        newSwipedScore,
        deltaSwiper,
        deltaSwiped,
      );

      // Track metrics
      if (this.metricsEnabled) {
        await this.trackEloChange(
          swiperId,
          swipedId,
          action,
          deltaSwiper,
          deltaSwiped,
        );
      }

      return {
        swiper: {
          oldScore: swiperData.eloScore,
          newScore: newSwiperScore,
          delta: deltaSwiper,
          tier: this.getTier(newSwiperScore),
        },
        swiped: {
          oldScore: swipedData.eloScore,
          newScore: newSwipedScore,
          delta: deltaSwiped,
          tier: this.getTier(newSwipedScore),
        },
      };
    } catch (error) {
      logger.error("Error calculating ELO scores:", error);
      throw error;
    }
  }

  /**
   * Calculate expected score (probability of winning)
   * @param {number} ratingA - Player A's rating
   * @param {number} ratingB - Player B's rating
   */
  calculateExpectedScore(ratingA, ratingB) {
    return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  }

  /**
   * Get action weight for swiper
   * @param {string} action - Swipe action
   */
  getActionWeight(action) {
    return this.config.actionWeights[action] || 0.5;
  }

  /**
   * Get weight for recipient of action
   * @param {string} action - Swipe action
   */
  getRecipientWeight(action) {
    // Recipients get inverse weight for negative actions
    if (action === SWIPE_ACTIONS.NOPE) {
      return 1 - this.config.actionWeights[action];
    }
    return this.config.actionWeights[action] || 0.5;
  }

  /**
   * Calculate K-factor based on user activity
   * @param {Object} userData - User data with swipe stats
   */
  calculateKFactor(userData) {
    const baseK = this.config.baseKFactor;
    const totalSwipes = userData.totalSwipes || 0;

    let modifier;
    if (totalSwipes < 30) {
      modifier = this.config.kFactorModifiers.newUser;
    } else if (totalSwipes < 100) {
      modifier = this.config.kFactorModifiers.lowActivity;
    } else if (totalSwipes < 500) {
      modifier = this.config.kFactorModifiers.normalActivity;
    } else {
      modifier = this.config.kFactorModifiers.highActivity;
    }

    // Additional modifiers
    const volatilityFactor = this.calculateVolatilityFactor(userData);

    return baseK * modifier * volatilityFactor;
  }

  /**
   * Calculate volatility factor based on recent performance
   * @param {Object} userData - User data with recent history
   */
  calculateVolatilityFactor(userData) {
    // If user's recent matches are very different from expected, increase volatility
    const recentMatches = userData.recentMatches || 0;
    const expectedMatches = userData.expectedMatches || 0;

    if (expectedMatches === 0) return 1.0;

    const performanceRatio = recentMatches / expectedMatches;

    // Increase volatility if performance is very different from expected
    if (performanceRatio > 2 || performanceRatio < 0.5) {
      return 1.5;
    }

    return 1.0;
  }

  /**
   * Clamp score within boundaries
   * @param {number} score - Raw score
   */
  clampScore(score) {
    return Math.max(
      this.config.minScore,
      Math.min(this.config.maxScore, Math.round(score)),
    );
  }

  /**
   * Get user's ELO data
   * @param {string} userId - User ID
   */
  async getUserEloData(userId) {
    try {
      // Try cache first
      const cacheKey = `${this.cacheConfig.prefix}${userId}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return JSON.parse(cached);
      }

      // Get from database
      const user = await User.findById(userId).select(
        "scoring.eloScore scoring.eloHistory stats.totalSwipes stats.totalMatches",
      );

      if (!user) return null;

      const eloData = {
        userId,
        eloScore: user.scoring?.eloScore || this.config.defaultScore,
        totalSwipes: user.stats?.totalSwipes || 0,
        totalMatches: user.stats?.totalMatches || 0,
        recentMatches: await this.getRecentMatches(userId),
        expectedMatches: await this.getExpectedMatches(user.scoring?.eloScore),
      };

      // Cache for later
      await redis.set(cacheKey, JSON.stringify(eloData), this.cacheConfig.ttl);

      return eloData;
    } catch (error) {
      logger.error(`Error getting ELO data for user ${userId}:`, error);
      return null;
    }
  }

  /**
   * Update user scores in database
   */
  async updateUserScores(
    swiperId,
    swipedId,
    newSwiperScore,
    newSwipedScore,
    deltaSwiper,
    deltaSwiped,
  ) {
    try {
      const updatePromises = [
        // Update swiper
        User.findByIdAndUpdate(swiperId, {
          $set: { "scoring.eloScore": newSwiperScore },
          $push: {
            "scoring.eloHistory": {
              $each: [
                {
                  score: newSwiperScore,
                  delta: deltaSwiper,
                  timestamp: new Date(),
                },
              ],
              $slice: -100, // Keep last 100 history entries
            },
          },
        }),

        // Update swiped
        User.findByIdAndUpdate(swipedId, {
          $set: { "scoring.eloScore": newSwipedScore },
          $push: {
            "scoring.eloHistory": {
              $each: [
                {
                  score: newSwipedScore,
                  delta: deltaSwiped,
                  timestamp: new Date(),
                },
              ],
              $slice: -100,
            },
          },
        }),
      ];

      await Promise.all(updatePromises);

      // Invalidate cache
      await Promise.all([
        redis.del(`${this.cacheConfig.prefix}${swiperId}`),
        redis.del(`${this.cacheConfig.prefix}${swipedId}`),
      ]);

      //logger.debug(`ELO scores updated - Swiper: ${newSwiperScore} (${deltaSwiper:+}), Swiped: ${newSwipedScore} (${deltaSwiped:+})`);
      logger.debug(
        `ELO scores updated - Swiper: ${newSwiperScore} (${deltaSwiper >= 0 ? `+${deltaSwiper}` : deltaSwiper}), ` +
          `Swiped: ${newSwipedScore} (${deltaSwiped >= 0 ? `+${deltaSwiped}` : deltaSwiped})`,
      );
    } catch (error) {
      logger.error("Error updating ELO scores:", error);
      throw error;
    }
  }

  /**
   * Get tier based on ELO score
   * @param {number} score - ELO score
   */
  getTier(score) {
    for (const [tier, range] of Object.entries(this.config.tiers)) {
      if (score >= range.min && score <= range.max) {
        return tier;
      }
    }
    return "silver"; // Default tier
  }

  /**
   * Apply decay to inactive users
   */
  async applyInactivityDecay() {
    if (!this.config.decay.enabled) return;

    try {
      const inactiveDate = new Date(
        Date.now() - this.config.decay.inactivityDays * 24 * 60 * 60 * 1000,
      );

      const inactiveUsers = await User.find({
        "status.lastActive": { $lt: inactiveDate },
        "scoring.eloScore": { $gt: this.config.decay.minDecayScore },
        "status.isActive": true,
      }).select("_id scoring.eloScore status.lastActive");

      logger.info(
        `Applying ELO decay to ${inactiveUsers.length} inactive users`,
      );

      const updates = inactiveUsers.map((user) => {
        const daysSinceActive = Math.floor(
          (Date.now() - user.status.lastActive) / (24 * 60 * 60 * 1000),
        );

        const decayMultiplier = Math.pow(
          1 - this.config.decay.dailyDecayRate,
          daysSinceActive - this.config.decay.inactivityDays,
        );

        const newScore = Math.max(
          this.config.decay.minDecayScore,
          Math.round(user.scoring.eloScore * decayMultiplier),
        );

        return User.findByIdAndUpdate(user._id, {
          $set: { "scoring.eloScore": newScore },
          $push: {
            "scoring.eloHistory": {
              score: newScore,
              delta: newScore - user.scoring.eloScore,
              reason: "inactivity_decay",
              timestamp: new Date(),
            },
          },
        });
      });

      await Promise.all(updates);

      logger.info("ELO decay applied successfully");
    } catch (error) {
      logger.error("Error applying inactivity decay:", error);
    }
  }

  /**
   * Apply streak bonuses
   * @param {string} userId - User ID
   * @param {string} streakType - Type of streak
   */
  async applyStreakBonus(userId, streakType) {
    try {
      const bonus = this.config.streaks[streakType];
      if (!bonus) return;

      const user = await User.findById(userId).select("scoring.eloScore");
      if (!user) return;

      const newScore = this.clampScore(user.scoring.eloScore + bonus);

      await User.findByIdAndUpdate(userId, {
        $set: { "scoring.eloScore": newScore },
        $push: {
          "scoring.eloHistory": {
            score: newScore,
            delta: bonus,
            reason: `${streakType}_bonus`,
            timestamp: new Date(),
          },
        },
      });

      logger.debug(
        `Streak bonus applied to user ${userId}: +${bonus} for ${streakType}`,
      );
    } catch (error) {
      logger.error("Error applying streak bonus:", error);
    }
  }

  /**
   * Apply one-time bonuses
   * @param {string} userId - User ID
   * @param {string} bonusType - Type of bonus
   */
  async applyOneTimeBonus(userId, bonusType) {
    try {
      const bonus = this.config.bonuses[bonusType];
      if (!bonus) return;

      // Check if bonus already applied
      const cacheKey = `bonus:${bonusType}:${userId}`;
      const alreadyApplied = await redis.exists(cacheKey);

      if (alreadyApplied) {
        logger.debug(`Bonus ${bonusType} already applied to user ${userId}`);
        return;
      }

      const user = await User.findById(userId).select("scoring.eloScore");
      if (!user) return;

      const newScore = this.clampScore(user.scoring.eloScore + bonus);

      await User.findByIdAndUpdate(userId, {
        $set: { "scoring.eloScore": newScore },
        $push: {
          "scoring.eloHistory": {
            score: newScore,
            delta: bonus,
            reason: `${bonusType}_bonus`,
            timestamp: new Date(),
          },
        },
      });

      // Mark bonus as applied
      await redis.set(cacheKey, "1", 365 * 24 * 60 * 60); // 1 year

      logger.info(
        `One-time bonus applied to user ${userId}: +${bonus} for ${bonusType}`,
      );
    } catch (error) {
      logger.error("Error applying one-time bonus:", error);
    }
  }

  /**
   * Get recent matches count for user
   * @param {string} userId - User ID
   */
  async getRecentMatches(userId) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const count = await Match.countDocuments({
        users: userId,
        matchedAt: { $gte: sevenDaysAgo },
      });

      return count;
    } catch (error) {
      logger.error("Error getting recent matches:", error);
      return 0;
    }
  }

  /**
   * Get expected matches based on ELO
   * @param {number} eloScore - User's ELO score
   */
  async getExpectedMatches(eloScore) {
    // Calculate expected matches based on tier
    const tier = this.getTier(eloScore);

    const expectedByTier = {
      bronze: 2,
      silver: 4,
      gold: 6,
      platinum: 8,
      diamond: 10,
    };

    return expectedByTier[tier] || 4;
  }

  /**
   * Track ELO changes for analytics
   */
  async trackEloChange(swiperId, swipedId, action, deltaSwiper, deltaSwiped) {
    try {
      await MetricsService.recordHistogram(
        "elo.change",
        Math.abs(deltaSwiper),
        {
          userId: swiperId,
          action,
        },
      );

      await MetricsService.recordHistogram(
        "elo.change",
        Math.abs(deltaSwiped),
        {
          userId: swipedId,
          action: "received",
        },
      );

      // Track tier changes
      const [swiperData, swipedData] = await Promise.all([
        this.getUserEloData(swiperId),
        this.getUserEloData(swipedId),
      ]);

      const swiperOldTier = this.getTier(swiperData.eloScore - deltaSwiper);
      const swiperNewTier = this.getTier(swiperData.eloScore);

      if (swiperOldTier !== swiperNewTier) {
        await MetricsService.incrementCounter("elo.tier.change", 1, {
          from: swiperOldTier,
          to: swiperNewTier,
        });
      }
    } catch (error) {
      logger.error("Error tracking ELO change:", error);
    }
  }

  /**
   * Get ELO statistics for a user
   * @param {string} userId - User ID
   */
  async getUserEloStats(userId) {
    try {
      const user = await User.findById(userId).select("scoring");
      if (!user) return null;

      const score = user.scoring?.eloScore || this.config.defaultScore;
      const history = user.scoring?.eloHistory || [];

      // Calculate percentile
      const percentile = await this.calculatePercentile(score);

      // Calculate trend
      const trend = this.calculateTrend(history);

      // Get peak score
      const peakScore = Math.max(score, ...history.map((h) => h.score));

      return {
        currentScore: score,
        tier: this.getTier(score),
        percentile,
        trend,
        peakScore,
        history: history.slice(-30), // Last 30 entries
        streaks: await this.getUserStreaks(userId),
      };
    } catch (error) {
      logger.error("Error getting ELO stats:", error);
      return null;
    }
  }

  /**
   * Calculate percentile rank
   * @param {number} score - ELO score
   */
  async calculatePercentile(score) {
    try {
      const [below, total] = await Promise.all([
        User.countDocuments({
          "scoring.eloScore": { $lt: score },
          "status.isActive": true,
        }),
        User.countDocuments({
          "status.isActive": true,
        }),
      ]);

      return Math.round((below / total) * 100);
    } catch (error) {
      logger.error("Error calculating percentile:", error);
      return 50;
    }
  }

  /**
   * Calculate score trend
   * @param {Array} history - ELO history
   */
  calculateTrend(history) {
    if (history.length < 2) return "stable";

    const recent = history.slice(-10);
    const deltas = recent.map((h) => h.delta || 0);
    const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

    if (avgDelta > 10) return "rising";
    if (avgDelta < -10) return "falling";
    return "stable";
  }

  /**
   * Get user streaks
   * @param {string} userId - User ID
   */
  async getUserStreaks(userId) {
    try {
      const now = new Date();
      const today = now.toISOString().split("T")[0];
      const thisWeek = `${now.getFullYear()}-W${Math.ceil(now.getDate() / 7)}`;

      const [dailyStreak, weeklyStreak, matchStreak] = await Promise.all([
        redis.get(`streak:daily:${userId}:${today}`),
        redis.get(`streak:weekly:${userId}:${thisWeek}`),
        redis.get(`streak:match:${userId}`),
      ]);

      return {
        daily: parseInt(dailyStreak) || 0,
        weekly: parseInt(weeklyStreak) || 0,
        match: parseInt(matchStreak) || 0,
      };
    } catch (error) {
      logger.error("Error getting user streaks:", error);
      return { daily: 0, weekly: 0, match: 0 };
    }
  }

  /**
   * Recalculate ELO for all users (maintenance task)
   */
  async recalculateAllScores() {
    try {
      logger.info("Starting ELO recalculation for all users");

      const users = await User.find({ "status.isActive": true }).select(
        "_id scoring stats",
      );

      for (const user of users) {
        // Calculate base score from stats
        const matchRate =
          user.stats?.totalMatches / Math.max(user.stats?.totalSwipes, 1);
        const activityScore = user.scoring?.activityScore || 0.5;
        const completeness = user.scoring?.profileCompleteness || 0.5;

        // New score formula
        const newScore = this.clampScore(
          this.config.defaultScore +
            matchRate * 1000 +
            activityScore * 500 +
            completeness * 300,
        );

        await User.findByIdAndUpdate(user._id, {
          $set: { "scoring.eloScore": newScore },
        });
      }

      logger.info(`ELO recalculation completed for ${users.length} users`);
    } catch (error) {
      logger.error("Error recalculating all scores:", error);
    }
  }

  /**
   * Get leaderboard
   * @param {Object} options - Leaderboard options
   */
  async getLeaderboard(options = {}) {
    try {
      const {
        limit = 100,
        tier = null,
        timeframe = "all", // all, monthly, weekly
      } = options;

      const query = { "status.isActive": true };

      // Filter by tier if specified
      if (tier) {
        const tierRange = this.config.tiers[tier];
        if (tierRange) {
          query["scoring.eloScore"] = {
            $gte: tierRange.min,
            $lte: tierRange.max,
          };
        }
      }

      // Filter by timeframe
      if (timeframe === "monthly") {
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        query["status.lastActive"] = { $gte: monthAgo };
      } else if (timeframe === "weekly") {
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        query["status.lastActive"] = { $gte: weekAgo };
      }

      const leaderboard = await User.find(query)
        .select("profile.displayName profile.photos scoring.eloScore")
        .sort({ "scoring.eloScore": -1 })
        .limit(limit)
        .lean();

      return leaderboard.map((user, index) => ({
        rank: index + 1,
        userId: user._id,
        displayName: user.profile?.displayName,
        photo: user.profile?.photos?.[0]?.thumbnailUrl,
        score: user.scoring?.eloScore,
        tier: this.getTier(user.scoring?.eloScore),
      }));
    } catch (error) {
      logger.error("Error getting leaderboard:", error);
      return [];
    }
  }
}

export default new EloAlgorithm();
