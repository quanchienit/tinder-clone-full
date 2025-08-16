// src/modules/match/match.controller.js
import MatchService from "./match.service.js";
import RecommendationAlgorithm from "./algorithms/recommendation.algorithm.js";
import EloAlgorithm from "./algorithms/elo.algorithm.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  successResponse,
  createdResponse,
  badRequestResponse,
  notFoundResponse,
  forbiddenResponse,
  conflictResponse,
  paginatedResponse,
} from "../../shared/utils/response.js";
import logger from "../../shared/utils/logger.js";
import MetricsService from "../../shared/services/metrics.service.js";
import {
  SWIPE_ACTIONS,
  ERROR_CODES,
  SUBSCRIPTION_FEATURES,
} from "../../config/constants.js";

class MatchController {
  /**
   * Process a swipe action
   * @route POST /api/matches/swipe
   */
  swipe = asyncHandler(async (req, res) => {
    const {
      targetUserId,
      action,
      photoIndex,
      viewDuration,
      photosViewed,
      bioViewed,
      message,
    } = req.body;
    const userId = req.user._id.toString();

    // Validate action
    if (!Object.values(SWIPE_ACTIONS).includes(action)) {
      return badRequestResponse(res, "Invalid swipe action");
    }

    // Process swipe
    const result = await MatchService.processSwipe(
      userId,
      targetUserId,
      action,
      {
        source: req.query.source || "recommendations",
        photoIndex,
        viewDuration,
        photosViewed,
        bioViewed,
        message, // For super likes
        platform: req.headers["x-platform"] || "web",
        appVersion: req.headers["x-app-version"],
        deviceId: req.headers["x-device-id"],
        recommendation: req.body.recommendation,
      },
    );

    // Response message based on action and result
    let message = "";
    if (result.match) {
      message = "It's a Match! 🎉";
    } else if (action === SWIPE_ACTIONS.LIKE) {
      message = "Liked successfully";
    } else if (action === SWIPE_ACTIONS.NOPE) {
      message = "Passed";
    } else if (action === SWIPE_ACTIONS.SUPER_LIKE) {
      message = "Super Like sent! ⭐";
    }

    return successResponse(
      res,
      {
        swipe: result.swipe,
        match: result.match,
        limits: result.limits,
      },
      message,
    );
  });

  /**
   * Undo last swipe
   * @route POST /api/matches/swipe/undo
   */
  undoSwipe = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { swipeId } = req.body;

    const result = await MatchService.undoSwipe(userId, swipeId);

    return successResponse(res, result, "Swipe undone successfully");
  });

  /**
   * Get swipe history
   * @route GET /api/matches/swipe/history
   */
  getSwipeHistory = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { page = 1, limit = 20, filter = "all" } = req.query;

    const Swipe = (await import("./swipe.model.js")).default;

    const query = {
      from: userId,
      isActive: true,
    };

    // Apply filters
    if (filter === "likes") {
      query.action = { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] };
    } else if (filter === "passes") {
      query.action = SWIPE_ACTIONS.NOPE;
    } else if (filter === "matches") {
      query["match.isMatch"] = true;
    }

    const skip = (page - 1) * limit;

    const [swipes, total] = await Promise.all([
      Swipe.find(query)
        .populate("to", "profile.firstName profile.displayName profile.photos")
        .sort({ swipedAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Swipe.countDocuments(query),
    ]);

    const formattedSwipes = swipes.map((swipe) => ({
      id: swipe._id,
      user: swipe.to,
      action: swipe.action,
      swipedAt: swipe.swipedAt,
      isMatch: swipe.match?.isMatch,
      canUndo: swipe.canUndo,
    }));

    return paginatedResponse(
      res,
      formattedSwipes,
      total,
      page,
      limit,
      "Swipe history retrieved",
    );
  });

  /**
   * Get swipe statistics
   * @route GET /api/matches/swipe/stats
   */
  getSwipeStats = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { dateRange } = req.query;

    const Swipe = (await import("./swipe.model.js")).default;

    let dateFilter = {};
    if (dateRange === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      dateFilter = { start: startOfDay };
    } else if (dateRange === "week") {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      dateFilter = { start: weekAgo };
    } else if (dateRange === "month") {
      const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      dateFilter = { start: monthAgo };
    }

    const stats = await Swipe.getUserSwipeStats(userId, dateFilter);

    return successResponse(res, { stats }, "Swipe statistics retrieved");
  });

  /**
   * Get current swipe limits
   * @route GET /api/matches/swipe/limits
   */
  getSwipeLimits = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const subscriptionType = req.user.subscription?.type || "free";

    const Swipe = (await import("./swipe.model.js")).default;
    const limits = await Swipe.checkDailyLimits(userId, subscriptionType);

    // Add reset time
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    const resetIn = tomorrow - now;

    return successResponse(
      res,
      {
        limits: {
          likes: limits.remaining.likes,
          superLikes: limits.remaining.superLikes,
          canLike: limits.canLike,
          canSuperLike: limits.canSuperLike,
        },
        usage: limits.counts,
        resetIn: Math.floor(resetIn / 1000), // seconds until reset
        subscription: subscriptionType,
      },
      "Swipe limits retrieved",
    );
  });

  /**
   * Reset all passes
   * @route POST /api/matches/swipe/reset-passes
   */
  resetPasses = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const Swipe = (await import("./swipe.model.js")).default;

    // Deactivate all nope swipes
    const result = await Swipe.updateMany(
      {
        from: userId,
        action: SWIPE_ACTIONS.NOPE,
        isActive: true,
      },
      {
        $set: { isActive: false },
      },
    );

    return successResponse(
      res,
      {
        resetCount: result.modifiedCount,
      },
      `${result.modifiedCount} passes have been reset`,
    );
  });

  /**
   * Get all matches
   * @route GET /api/matches
   */
  getMatches = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const {
      page = 1,
      limit = 20,
      sort = "recent",
      filter = "all",
      search,
    } = req.query;

    const result = await MatchService.getMatches(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      sort,
      filter,
      search,
    });

    return paginatedResponse(
      res,
      result.matches,
      result.pagination.total,
      result.pagination.page,
      result.pagination.limit,
      "Matches retrieved successfully",
    );
  });

  /**
   * Get specific match
   * @route GET /api/matches/:matchId
   */
  getMatch = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;

    const match = await MatchService.getMatch(matchId, userId);

    return successResponse(res, { match }, "Match details retrieved");
  });

  /**
   * Unmatch with user
   * @route DELETE /api/matches/:matchId
   */
  unmatch = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;
    const { reason } = req.body;

    await MatchService.unmatch(matchId, userId, reason);

    return successResponse(res, null, "Unmatched successfully");
  });

  /**
   * Block match
   * @route POST /api/matches/:matchId/block
   */
  blockMatch = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;

    await MatchService.blockMatch(matchId, userId);

    return successResponse(res, null, "User blocked successfully");
  });

  /**
   * Toggle pin status
   * @route PUT /api/matches/:matchId/pin
   */
  togglePin = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;

    const result = await MatchService.togglePinMatch(matchId, userId);

    return successResponse(res, result, result.message);
  });

  /**
   * Toggle mute status
   * @route PUT /api/matches/:matchId/mute
   */
  toggleMute = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;
    const { duration } = req.body; // Duration in milliseconds

    const result = await MatchService.toggleMuteMatch(
      matchId,
      userId,
      duration,
    );

    return successResponse(res, result, result.message);
  });

  /**
   * Report match
   * @route POST /api/matches/:matchId/report
   */
  reportMatch = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { matchId } = req.params;
    const { reason, description, evidence } = req.body;

    const Report = (await import("../admin/report.model.js")).default;
    const Match = (await import("./match.model.js")).default;

    const match = await Match.findById(matchId);
    if (!match || !match.hasUser(userId)) {
      return forbiddenResponse(res, "Match not found or unauthorized");
    }

    const reportedUserId = match.getOtherUser(userId);

    const report = await Report.create({
      reportedBy: userId,
      reportedUser: reportedUserId,
      matchId,
      reason,
      description,
      evidence,
      status: "pending",
    });

    // Flag match for review
    match.moderation.flaggedForReview = true;
    match.moderation.flagReason = reason;
    await match.save();

    return createdResponse(
      res,
      { reportId: report._id },
      "Report submitted successfully",
    );
  });

  /**
   * Get who liked me
   * @route GET /api/matches/likes/received
   */
  getWhoLikedMe = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { page = 1, limit = 20, filter = "all" } = req.query;

    const result = await MatchService.getWhoLikedMe(userId, {
      page: parseInt(page),
      limit: parseInt(limit),
      filter,
    });

    if (result.isBlurred) {
      return successResponse(
        res,
        {
          count: result.count,
          likes: [],
          message: result.message,
          isBlurred: true,
        },
        "Upgrade to see who likes you",
      );
    }

    return paginatedResponse(
      res,
      result.likes,
      result.pagination.total,
      result.pagination.page,
      result.pagination.limit,
      "Likes retrieved successfully",
    );
  });

  /**
   * Get sent likes
   * @route GET /api/matches/likes/sent
   */
  getSentLikes = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { page = 1, limit = 20 } = req.query;

    const Swipe = (await import("./swipe.model.js")).default;

    const skip = (page - 1) * limit;
    const query = {
      from: userId,
      action: { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] },
      isActive: true,
      "match.isMatch": false,
    };

    const [likes, total] = await Promise.all([
      Swipe.find(query)
        .populate(
          "to",
          "profile.firstName profile.displayName profile.photos status",
        )
        .sort({ swipedAt: -1 })
        .limit(limit)
        .skip(skip)
        .lean(),
      Swipe.countDocuments(query),
    ]);

    const formattedLikes = likes.map((swipe) => ({
      id: swipe._id,
      user: swipe.to,
      sentAt: swipe.swipedAt,
      isSuperLike: swipe.action === SWIPE_ACTIONS.SUPER_LIKE,
    }));

    return paginatedResponse(
      res,
      formattedLikes,
      total,
      page,
      limit,
      "Sent likes retrieved",
    );
  });

  /**
   * Get top picks
   * @route GET /api/matches/top-picks
   */
  getTopPicks = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { limit = 10 } = req.query;

    const topPicks = await MatchService.getTopPicks(userId, parseInt(limit));

    return successResponse(
      res,
      {
        topPicks,
        refreshAvailableAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Next day
      },
      "Top picks retrieved",
    );
  });

  /**
   * Refresh top picks
   * @route POST /api/matches/top-picks/refresh
   */
  refreshTopPicks = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    // Clear cache and get new picks
    const redis = (await import("../../config/redis.js")).default;
    await redis.del(`top-picks:${userId}`);

    const topPicks = await MatchService.getTopPicks(userId, 10);

    return successResponse(res, { topPicks }, "Top picks refreshed");
  });

  /**
   * Send super like
   * @route POST /api/matches/superlike
   */
  sendSuperLike = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { targetUserId, message } = req.body;

    const result = await MatchService.processSwipe(
      userId,
      targetUserId,
      SWIPE_ACTIONS.SUPER_LIKE,
      {
        message,
        source: "direct",
        platform: req.headers["x-platform"] || "web",
      },
    );

    return successResponse(res, result, "Super Like sent! ⭐");
  });

  /**
   * Get remaining super likes
   * @route GET /api/matches/superlike/remaining
   */
  getRemainingSuperLikes = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const subscriptionType = req.user.subscription?.type || "free";

    const Swipe = (await import("./swipe.model.js")).default;
    const limits = await Swipe.checkDailyLimits(userId, subscriptionType);

    const features = SUBSCRIPTION_FEATURES[subscriptionType];
    const dailyLimit = features.superLikesPerDay;

    return successResponse(
      res,
      {
        remaining: limits.remaining.superLikes,
        used: limits.counts.superLikes,
        dailyLimit: dailyLimit === -1 ? "unlimited" : dailyLimit,
        subscription: subscriptionType,
      },
      "Super like count retrieved",
    );
  });

  /**
   * Activate boost
   * @route POST /api/matches/boost
   */
  activateBoost = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { duration = 30 } = req.body; // Duration in minutes

    const User = (await import("../user/user.model.js")).default;
    const user = await User.findById(userId);

    // Check if user has boosts available
    const hasBoost =
      user.boosts?.available > 0 || user.subscription?.type === "platinum";

    if (!hasBoost) {
      return forbiddenResponse(
        res,
        "No boosts available. Purchase or upgrade to get boosts.",
      );
    }

    // Create boost
    const boost = {
      userId,
      type: "regular",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + duration * 60 * 1000),
      views: 0,
      likes: 0,
    };

    // Deduct boost if not platinum
    if (user.subscription?.type !== "platinum") {
      await User.findByIdAndUpdate(userId, {
        $inc: { "boosts.available": -1 },
        $push: { "boosts.history": boost },
      });
    }

    // Store active boost in Redis
    const redis = (await import("../../config/redis.js")).default;
    await redis.set(`boost:${userId}`, JSON.stringify(boost), duration * 60);

    return successResponse(
      res,
      {
        boost,
        remainingBoosts: Math.max(0, (user.boosts?.available || 1) - 1),
      },
      "Boost activated! Your profile is now 10x more visible.",
    );
  });

  /**
   * Get boost status
   * @route GET /api/matches/boost/status
   */
  getBoostStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const redis = (await import("../../config/redis.js")).default;
    const activeBoost = await redis.get(`boost:${userId}`);

    const User = (await import("../user/user.model.js")).default;
    const user = await User.findById(userId).select("boosts subscription");

    const response = {
      active: !!activeBoost,
      boost: activeBoost ? JSON.parse(activeBoost) : null,
      available: user.boosts?.available || 0,
      canBoost:
        user.boosts?.available > 0 || user.subscription?.type === "platinum",
    };

    return successResponse(res, response, "Boost status retrieved");
  });

  /**
   * Get recommendations
   * @route GET /api/matches/recommendations
   */
  getRecommendations = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { limit = 10, offset = 0 } = req.query;

    const recommendations = await RecommendationAlgorithm.getRecommendations(
      userId,
      {
        limit: parseInt(limit),
        offset: parseInt(offset),
        includeBoosts: true,
        applyFilters: true,
        cacheResults: !req.query.realtime,
      },
    );

    return successResponse(
      res,
      {
        recommendations,
        count: recommendations.length,
      },
      "Recommendations retrieved",
    );
  });

  /**
   * Calculate compatibility
   * @route GET /api/matches/compatibility/:userId
   */
  calculateCompatibility = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { userId: targetUserId } = req.params;

    const User = (await import("../user/user.model.js")).default;
    const [user1, user2] = await Promise.all([
      User.findById(userId).select("profile preferences scoring"),
      User.findById(targetUserId).select("profile preferences scoring"),
    ]);

    if (!user1 || !user2) {
      return notFoundResponse(res, "User not found");
    }

    // Use the service's compatibility calculation
    const compatibility = await MatchService.calculateCompatibility(
      user1,
      user2,
    );

    return successResponse(
      res,
      {
        compatibility: {
          score: Math.round(compatibility.score * 100),
          factors: {
            interests: Math.round(compatibility.commonInterests.length),
            age: Math.round(compatibility.ageCompatibility * 100),
            distance: Math.round(compatibility.distanceCompatibility * 100),
            lifestyle: Math.round(compatibility.lifestyleCompatibility * 100),
          },
          commonInterests: compatibility.commonInterests,
          distance: compatibility.distance,
        },
      },
      "Compatibility calculated",
    );
  });

  /**
   * Get match statistics
   * @route GET /api/matches/stats
   */
  getMatchStats = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const stats = await MatchService.getMatchStats(userId);

    return successResponse(res, stats, "Statistics retrieved");
  });

  /**
   * Get match insights
   * @route GET /api/matches/insights
   */
  getMatchInsights = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const insights = await MatchService.getMatchInsights(userId);

    if (!insights.isPremium) {
      return successResponse(res, insights, insights.message);
    }

    return successResponse(res, insights, "Insights retrieved");
  });

  /**
   * Other controller methods would follow similar patterns...
   * Including: proposeDate, sendVirtualGift, sendIcebreaker,
   * requestVideoChat, changeLocation, exploreMode, etc.
   */

  // Placeholder for remaining methods
  proposeDate = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Date planning feature coming soon");
  });

  sendVirtualGift = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Virtual gifts feature coming soon");
  });

  sendIcebreaker = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Icebreaker sent");
  });

  requestVideoChat = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Video chat request sent");
  });

  changeLocation = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Location changed");
  });

  exploreMode = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Explore mode activated");
  });

  activateSpotlight = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Spotlight activated");
  });

  getActivityFeed = asyncHandler(async (req, res) => {
    return successResponse(res, { activities: [] }, "Activity feed retrieved");
  });

  // Additional placeholder methods
  updateDate = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Date updated");
  });

  respondToDate = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Response recorded");
  });

  getAvailableGifts = asyncHandler(async (req, res) => {
    return successResponse(res, { gifts: [] }, "Gifts retrieved");
  });

  getIcebreakerSuggestions = asyncHandler(async (req, res) => {
    return successResponse(res, { suggestions: [] }, "Suggestions retrieved");
  });

  endVideoChat = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Video chat ended");
  });

  shareLocation = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Location shared");
  });

  shareEmergencyContact = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Emergency contact shared");
  });

  resetLocation = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Location reset");
  });

  updateActivityStreak = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Streak updated");
  });

  setExploreFilters = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Filters set");
  });

  getSpotlightStatus = asyncHandler(async (req, res) => {
    return successResponse(res, { active: false }, "Status retrieved");
  });

  batchLike = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Batch like completed");
  });

  batchPass = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Batch pass completed");
  });

  provideFeedback = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Feedback recorded");
  });

  refreshRecommendations = asyncHandler(async (req, res) => {
    return successResponse(res, null, "Recommendations refreshed");
  });
}

export default new MatchController();
