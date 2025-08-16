// src/modules/match/swipe.model.js
import mongoose from 'mongoose';
import { SWIPE_ACTIONS, USER_CONSTANTS } from '../../config/constants.js';

const { Schema } = mongoose;

/**
* Swipe Schema - Records all swipe interactions between users
*/
const swipeSchema = new Schema(
 {
   // User who performed the swipe
   from: {
     type: Schema.Types.ObjectId,
     ref: 'User',
     required: true,
     index: true,
   },

   // User who was swiped on
   to: {
     type: Schema.Types.ObjectId,
     ref: 'User',
     required: true,
     index: true,
   },

   // Swipe action
   action: {
     type: String,
     enum: Object.values(SWIPE_ACTIONS),
     required: true,
     index: true,
   },

   // Timestamp of swipe
   swipedAt: {
     type: Date,
     default: Date.now,
     required: true,
     index: true,
   },

   // Is this swipe still active (not undone)
   isActive: {
     type: Boolean,
     default: true,
     index: true,
   },

   // Undo information
   undo: {
     isUndone: {
       type: Boolean,
       default: false,
     },
     undoneAt: Date,
     undoReason: String,
     undoCount: {
       type: Number,
       default: 0,
     },
   },

   // Match information (if this swipe resulted in a match)
   match: {
     isMatch: {
       type: Boolean,
       default: false,
       index: true,
     },
     matchId: {
       type: Schema.Types.ObjectId,
       ref: 'Match',
     },
     matchedAt: Date,
     matchType: {
       type: String,
       enum: ['regular', 'superlike_match', 'boost_match', 'spotlight_match'],
     },
   },

   // Swipe context
   context: {
     // Source of the swipe
     source: {
       type: String,
       enum: ['recommendations', 'likes_you', 'top_picks', 'explore', 'boost', 'spotlight', 'nearby', 'search'],
       default: 'recommendations',
     },
     
     // Was this from a boosted profile
     fromBoostedProfile: {
       type: Boolean,
       default: false,
     },
     
     // Was the target profile boosted
     toBoostedProfile: {
       type: Boolean,
       default: false,
     },
     
     // Recommendation details
     recommendation: {
       score: Number,
       rank: Number,
       algorithm: String,
       wasTopPick: {
         type: Boolean,
         default: false,
       },
     },
     
     // Search context (if from search)
     search: {
       query: String,
       filters: Schema.Types.Mixed,
       resultRank: Number,
     },
     
     // Photo that was shown when swiped
     photoIndex: {
       type: Number,
       default: 0,
     },
     
     // Time spent viewing profile before swiping
     viewDuration: {
       type: Number, // in seconds
       default: 0,
     },
     
     // Number of photos viewed
     photosViewed: {
       type: Number,
       default: 1,
     },
     
     // Did user read the bio
     bioViewed: {
       type: Boolean,
       default: false,
     },
     
     // Distance at time of swipe
     distance: Number, // in km
   },

   // Device and platform information
   device: {
     platform: {
       type: String,
       enum: ['ios', 'android', 'web', 'desktop'],
       required: true,
     },
     appVersion: String,
     deviceId: String,
     deviceModel: String,
     osVersion: String,
     browser: String,
     browserVersion: String,
   },

   // Location at time of swipe
   location: {
     from: {
       type: {
         type: String,
         enum: ['Point'],
         default: 'Point',
       },
       coordinates: {
         type: [Number], // [longitude, latitude]
         index: '2dsphere',
       },
       city: String,
       state: String,
       country: String,
       postalCode: String,
     },
     to: {
       type: {
         type: String,
         enum: ['Point'],
         default: 'Point',
       },
       coordinates: {
         type: [Number],
       },
       city: String,
       state: String,
       country: String,
       postalCode: String,
     },
     calculatedDistance: Number, // Distance between users at swipe time
   },

   // User states at time of swipe
   userStates: {
     from: {
       age: Number,
       eloScore: Number,
       popularityScore: Number,
       activityScore: Number,
       profileCompleteness: Number,
       subscriptionType: String,
       photosCount: Number,
       isVerified: Boolean,
       lastActive: Date,
     },
     to: {
       age: Number,
       eloScore: Number,
       popularityScore: Number,
       activityScore: Number,
       profileCompleteness: Number,
       subscriptionType: String,
       photosCount: Number,
       isVerified: Boolean,
       lastActive: Date,
     },
   },

   // Compatibility metrics at time of swipe
   compatibility: {
     overallScore: {
       type: Number,
       min: 0,
       max: 1,
     },
     commonInterests: [String],
     commonInterestsCount: Number,
     ageCompatibility: Number,
     distanceCompatibility: Number,
     lifestyleCompatibility: Number,
     educationCompatibility: Number,
     attractivenessGap: Number, // Difference in ELO scores
   },

   // Super like specific data
   superLike: {
     message: {
       type: String,
       maxlength: 140,
     },
     messageViewed: {
       type: Boolean,
       default: false,
     },
     messageViewedAt: Date,
     wasDaily: Boolean, // Was this a daily free super like
     wasPurchased: Boolean, // Was this a purchased super like
   },

   // Swipe limits tracking
   limits: {
     dailySwipeCount: Number, // User's swipe count for the day
     dailyLikeCount: Number, // User's like count for the day
     dailySuperLikeCount: Number, // User's super like count for the day
     wasLimited: {
       type: Boolean,
       default: false,
     },
     limitType: {
       type: String,
       enum: ['daily_likes', 'daily_swipes', 'super_likes'],
     },
   },

   // A/B testing and experiments
   experiments: {
     groupId: String,
     experimentIds: [String],
     variants: Schema.Types.Mixed,
   },

   // Analytics and tracking
   analytics: {
     sessionId: String,
     sequence: Number, // Position in swipe session
     sessionDuration: Number, // Time in current session
     previousAction: String, // Previous swipe action in session
     nextAction: String, // Next swipe action in session (filled later)
     pattern: String, // Swipe pattern detection (e.g., "right-heavy", "selective")
     
     // UI interactions
     profileExpanded: {
       type: Boolean,
       default: false,
     },
     spotifyPlayed: {
       type: Boolean,
       default: false,
     },
     instagramViewed: {
       type: Boolean,
       default: false,
     },
     
     // Timing metrics
     timeToSwipe: Number, // Seconds from profile load to swipe
     photoViewTimes: [Number], // Time spent on each photo
     
     // Gesture data (for mobile)
     swipeVelocity: Number,
     swipeDistance: Number,
     swipeDirection: Number, // Angle in degrees
   },

   // Moderation and safety
   moderation: {
     flaggedForReview: {
       type: Boolean,
       default: false,
     },
     flagReason: String,
     reviewedAt: Date,
     reviewedBy: {
       type: Schema.Types.ObjectId,
       ref: 'User',
     },
     isSuspicious: {
       type: Boolean,
       default: false,
     },
     suspiciousReason: String,
   },

   // Response tracking (for mutual interest)
   response: {
     hasResponse: {
       type: Boolean,
       default: false,
     },
     responseAction: {
       type: String,
       enum: Object.values(SWIPE_ACTIONS),
     },
     responseAt: Date,
     responseTime: Number, // Time between swipes in seconds
     wasNotified: {
       type: Boolean,
       default: false,
     },
   },

   // Metadata
   metadata: {
     ipAddress: String,
     userAgent: String,
     referrer: String,
     utmSource: String,
     utmMedium: String,
     utmCampaign: String,
     isTestUser: {
       type: Boolean,
       default: false,
     },
     apiVersion: String,
   },
 },
 {
   timestamps: true,
   collection: 'swipes',
 }
);

// ============================
// Indexes
// ============================

// Compound indexes for common queries
swipeSchema.index({ from: 1, to: 1 }, { unique: true }); // Prevent duplicate swipes
swipeSchema.index({ from: 1, swipedAt: -1 });
swipeSchema.index({ to: 1, swipedAt: -1 });
swipeSchema.index({ from: 1, isActive: 1, swipedAt: -1 });
swipeSchema.index({ to: 1, action: 1, isActive: 1 });
swipeSchema.index({ from: 1, to: 1, isActive: 1 });
swipeSchema.index({ 'match.isMatch': 1, swipedAt: -1 });
swipeSchema.index({ from: 1, action: 1, swipedAt: -1 });
swipeSchema.index({ 'context.source': 1, swipedAt: -1 });
swipeSchema.index({ 'response.hasResponse': 1, 'response.responseAt': 1 });

// Geospatial indexes
swipeSchema.index({ 'location.from.coordinates': '2dsphere' });

// Text indexes for search
swipeSchema.index({ 'superLike.message': 'text' });

// TTL index for auto-cleanup of old inactive swipes (optional)
// swipeSchema.index({ swipedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // 90 days

// ============================
// Virtual Properties
// ============================

/**
* Check if swipe is recent (within 24 hours)
*/
swipeSchema.virtual('isRecent').get(function () {
 return Date.now() - this.swipedAt < 24 * 60 * 60 * 1000;
});

/**
* Check if swipe can be undone
*/
swipeSchema.virtual('canUndo').get(function () {
 // Can only undo within 10 seconds and if not already matched
 const timeSinceSwipe = Date.now() - this.swipedAt;
 return (
   this.isActive &&
   !this.undo.isUndone &&
   !this.match.isMatch &&
   timeSinceSwipe < 10000 // 10 seconds
 );
});

/**
* Get swipe quality score
*/
swipeSchema.virtual('qualityScore').get(function () {
 let score = 0;
 
 // Profile engagement (40%)
 if (this.context.viewDuration > 5) score += 20;
 if (this.context.photosViewed > 2) score += 10;
 if (this.context.bioViewed) score += 10;
 
 // Compatibility (30%)
 if (this.compatibility.overallScore) {
   score += this.compatibility.overallScore * 30;
 }
 
 // User quality (30%)
 if (this.userStates.from?.profileCompleteness > 0.8) score += 15;
 if (this.userStates.from?.isVerified) score += 15;
 
 return Math.min(100, score);
});

// ============================
// Instance Methods
// ============================

/**
* Undo the swipe
*/
swipeSchema.methods.undoSwipe = function (reason = 'user_requested') {
 if (!this.canUndo) {
   throw new Error('Cannot undo this swipe');
 }
 
 this.isActive = false;
 this.undo.isUndone = true;
 this.undo.undoneAt = new Date();
 this.undo.undoReason = reason;
 this.undo.undoCount++;
 
 return this.save();
};

/**
* Mark swipe as resulting in a match
*/
swipeSchema.methods.markAsMatch = function (matchId, matchType = 'regular') {
 this.match.isMatch = true;
 this.match.matchId = matchId;
 this.match.matchedAt = new Date();
 this.match.matchType = matchType;
 
 return this.save();
};

/**
* Record response to this swipe
*/
swipeSchema.methods.recordResponse = function (responseAction) {
 this.response.hasResponse = true;
 this.response.responseAction = responseAction;
 this.response.responseAt = new Date();
 this.response.responseTime = (Date.now() - this.swipedAt) / 1000; // in seconds
 
 return this.save();
};

/**
* Flag swipe for moderation
*/
swipeSchema.methods.flagForReview = function (reason) {
 this.moderation.flaggedForReview = true;
 this.moderation.flagReason = reason;
 
 return this.save();
};

/**
* Calculate swipe velocity (swipes per minute)
*/
swipeSchema.methods.calculateVelocity = async function () {
 const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
 
 const recentSwipes = await this.constructor.countDocuments({
   from: this.from,
   swipedAt: { $gte: fiveMinutesAgo },
 });
 
 return recentSwipes / 5; // swipes per minute
};

// ============================
// Static Methods
// ============================

/**
* Check if users have already swiped on each other
*/
swipeSchema.statics.hasSwipedBefore = async function (fromUserId, toUserId) {
 const swipe = await this.findOne({
   from: fromUserId,
   to: toUserId,
   isActive: true,
 });
 
 return !!swipe;
};

/**
* Get mutual swipes (both users swiped on each other)
*/
swipeSchema.statics.getMutualSwipes = async function (userId1, userId2) {
 const swipes = await this.find({
   $or: [
     { from: userId1, to: userId2, isActive: true },
     { from: userId2, to: userId1, isActive: true },
   ],
 }).sort({ swipedAt: -1 });
 
 return swipes;
};

/**
* Check if should create a match
*/
swipeSchema.statics.checkForMatch = async function (fromUserId, toUserId, currentAction) {
 // Check if the other user has already liked this user
 const reciprocalSwipe = await this.findOne({
   from: toUserId,
   to: fromUserId,
   action: { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] },
   isActive: true,
   'match.isMatch': false,
 });
 
 if (reciprocalSwipe && [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE].includes(currentAction)) {
   return {
     isMatch: true,
     reciprocalSwipe,
     matchType: currentAction === SWIPE_ACTIONS.SUPER_LIKE || reciprocalSwipe.action === SWIPE_ACTIONS.SUPER_LIKE
       ? 'superlike_match'
       : 'regular',
   };
 }
 
 return { isMatch: false };
};

/**
* Get swipe statistics for a user
*/
swipeSchema.statics.getUserSwipeStats = async function (userId, dateRange = {}) {
 const query = { from: userId, isActive: true };
 
 if (dateRange.start || dateRange.end) {
   query.swipedAt = {};
   if (dateRange.start) query.swipedAt.$gte = dateRange.start;
   if (dateRange.end) query.swipedAt.$lte = dateRange.end;
 }
 
 const [
   totalSwipes,
   likes,
   nopes,
   superLikes,
   matches,
   undos,
 ] = await Promise.all([
   this.countDocuments(query),
   this.countDocuments({ ...query, action: SWIPE_ACTIONS.LIKE }),
   this.countDocuments({ ...query, action: SWIPE_ACTIONS.NOPE }),
   this.countDocuments({ ...query, action: SWIPE_ACTIONS.SUPER_LIKE }),
   this.countDocuments({ ...query, 'match.isMatch': true }),
   this.countDocuments({ ...query, 'undo.isUndone': true }),
 ]);
 
 const likeRate = totalSwipes > 0 ? (likes / totalSwipes) * 100 : 0;
 const matchRate = likes > 0 ? (matches / likes) * 100 : 0;
 
 return {
   total: totalSwipes,
   likes,
   nopes,
   superLikes,
   matches,
   undos,
   likeRate: Math.round(likeRate * 10) / 10,
   matchRate: Math.round(matchRate * 10) / 10,
   selectivity: likeRate < 30 ? 'high' : likeRate < 60 ? 'medium' : 'low',
 };
};

/**
* Get users who liked a specific user
*/
swipeSchema.statics.getLikesForUser = async function (userId, options = {}) {
 const {
   limit = 50,
   skip = 0,
   includeSuperlikes = true,
   onlyUnmatched = true,
 } = options;
 
 const query = {
   to: userId,
   action: includeSuperlikes 
     ? { $in: [SWIPE_ACTIONS.LIKE, SWIPE_ACTIONS.SUPER_LIKE] }
     : SWIPE_ACTIONS.LIKE,
   isActive: true,
 };
 
 if (onlyUnmatched) {
   query['match.isMatch'] = false;
 }
 
 return this.find(query)
   .populate('from', 'profile.firstName profile.displayName profile.photos verification')
   .sort({ swipedAt: -1 })
   .limit(limit)
   .skip(skip);
};

/**
* Get today's swipe count for user
*/
swipeSchema.statics.getTodaySwipeCount = async function (userId) {
 const startOfDay = new Date();
 startOfDay.setHours(0, 0, 0, 0);
 
 const counts = await this.aggregate([
   {
     $match: {
       from: mongoose.Types.ObjectId(userId),
       swipedAt: { $gte: startOfDay },
       isActive: true,
     },
   },
   {
     $group: {
       _id: '$action',
       count: { $sum: 1 },
     },
   },
 ]);
 
 const result = {
   total: 0,
   likes: 0,
   nopes: 0,
   superLikes: 0,
 };
 
 counts.forEach(({ _id, count }) => {
   result.total += count;
   if (_id === SWIPE_ACTIONS.LIKE) result.likes = count;
   else if (_id === SWIPE_ACTIONS.NOPE) result.nopes = count;
   else if (_id === SWIPE_ACTIONS.SUPER_LIKE) result.superLikes = count;
 });
 
 return result;
};

/**
* Check if user has reached daily limits
*/
swipeSchema.statics.checkDailyLimits = async function (userId, userSubscription = 'free') {
 const counts = await this.getTodaySwipeCount(userId);
 
 const limits = {
   free: {
     likes: USER_CONSTANTS.DAILY_LIKE_LIMIT,
     superLikes: USER_CONSTANTS.DAILY_SUPER_LIKE_LIMIT,
   },
   plus: {
     likes: -1, // Unlimited
     superLikes: 5,
   },
   gold: {
     likes: -1,
     superLikes: 5,
   },
   platinum: {
     likes: -1,
     superLikes: -1,
   },
 };
 
 const userLimits = limits[userSubscription] || limits.free;
 
 return {
   canLike: userLimits.likes === -1 || counts.likes < userLimits.likes,
   canSuperLike: userLimits.superLikes === -1 || counts.superLikes < userLimits.superLikes,
   remaining: {
     likes: userLimits.likes === -1 ? -1 : Math.max(0, userLimits.likes - counts.likes),
     superLikes: userLimits.superLikes === -1 ? -1 : Math.max(0, userLimits.superLikes - counts.superLikes),
   },
   counts,
 };
};

/**
* Get swipe patterns for ML
*/
swipeSchema.statics.getSwipePatterns = async function (userId, days = 30) {
 const startDate = new Date();
 startDate.setDate(startDate.getDate() - days);
 
 const patterns = await this.aggregate([
   {
     $match: {
       from: mongoose.Types.ObjectId(userId),
       swipedAt: { $gte: startDate },
       isActive: true,
     },
   },
   {
     $group: {
       _id: {
         hour: { $hour: '$swipedAt' },
         dayOfWeek: { $dayOfWeek: '$swipedAt' },
       },
       count: { $sum: 1 },
       likeRate: {
         $avg: {
           $cond: [{ $eq: ['$action', SWIPE_ACTIONS.LIKE] }, 1, 0],
         },
       },
     },
   },
   {
     $sort: { count: -1 },
   },
 ]);
 
 return patterns;
};

// ============================
// Middleware
// ============================

/**
* Pre-save middleware
*/
swipeSchema.pre('save', async function (next) {
 // Prevent self-swipes
 if (this.from.toString() === this.to.toString()) {
   return next(new Error('Cannot swipe on yourself'));
 }
 
 // Calculate compatibility if not set
 if (this.isNew && !this.compatibility.overallScore) {
   // This would call a service to calculate compatibility
   // For now, set a default
   this.compatibility.overallScore = 0.5;
 }
 
 // Set limits tracking
 if (this.isNew) {
   const todayCount = await this.constructor.getTodaySwipeCount(this.from);
   this.limits.dailySwipeCount = todayCount.total + 1;
   this.limits.dailyLikeCount = todayCount.likes + (this.action === SWIPE_ACTIONS.LIKE ? 1 : 0);
   this.limits.dailySuperLikeCount = todayCount.superLikes + (this.action === SWIPE_ACTIONS.SUPER_LIKE ? 1 : 0);
 }
 
 next();
});

/**
* Post-save middleware for match checking
*/
swipeSchema.post('save', async function (doc) {
 if (doc.isNew && doc.isActive && !doc.match.isMatch) {
   // Check for potential match
   const matchCheck = await doc.constructor.checkForMatch(
     doc.from,
     doc.to,
     doc.action
   );
   
   if (matchCheck.isMatch) {
     // Create match (this would be handled by MatchService)
     const Match = mongoose.model('Match');
     const match = await Match.create({
       users: [doc.from, doc.to],
       initiatedBy: doc.from,
       quality: {
         compatibilityScore: doc.compatibility.overallScore,
         commonInterests: doc.compatibility.commonInterests,
         distance: doc.location.calculatedDistance,
         matchType: matchCheck.matchType,
       },
       metadata: {
         source: doc.context.source,
       },
     });
     
     // Update both swipes
     await doc.markAsMatch(match._id, matchCheck.matchType);
     await matchCheck.reciprocalSwipe.markAsMatch(match._id, matchCheck.matchType);
     
     // Update ELO scores
     const EloAlgorithm = (await import('./algorithms/elo.algorithm.js')).default;
     await EloAlgorithm.calculateNewScores(
       doc.from.toString(),
       doc.to.toString(),
       doc.action,
       { isMutualMatch: true }
     );
   }
 }
});

// ============================
// Model Export
// ============================

const Swipe = mongoose.model('Swipe', swipeSchema);

export default Swipe;