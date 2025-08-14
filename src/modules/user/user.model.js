// src/modules/user/user.model.js
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION,
  LIFESTYLE,
  EDUCATION_LEVELS,
  RELATIONSHIP_GOALS,
  SUBSCRIPTION_TYPES,
  USER_CONSTANTS,
} from "../../config/constants.js";

const { Schema } = mongoose;

/**
 * Photo Sub-Schema
 */
const PhotoSchema = new Schema({
  url: {
    type: String,
    required: true,
  },
  thumbnailUrl: {
    type: String,
    required: true,
  },
  cloudinaryId: {
    type: String,
    required: true,
  },
  order: {
    type: Number,
    required: true,
    min: 0,
    max: USER_CONSTANTS.MAX_PHOTOS - 1,
  },
  isMain: {
    type: Boolean,
    default: false,
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  verifiedAt: Date,
  moderationStatus: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  moderationNotes: String,
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
  metadata: {
    width: Number,
    height: Number,
    format: String,
    size: Number,
  },
});

/**
 * Location Sub-Schema (GeoJSON)
 */
const LocationSchema = new Schema({
  type: {
    type: String,
    enum: ["Point"],
    default: "Point",
  },
  coordinates: {
    type: [Number], // [longitude, latitude]
    index: "2dsphere",
  },
  address: {
    city: String,
    state: String,
    country: String,
    postalCode: String,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Main User Schema
 */
const UserSchema = new Schema(
  {
    // ========================
    // AUTHENTICATION
    // ========================
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please enter a valid email"],
      index: true,
    },

    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
      match: [/^\+?[1-9]\d{1,14}$/, "Please enter a valid phone number"],
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false, // Don't return password by default
    },

    // OAuth providers
    providers: [
      {
        type: {
          type: String,
          enum: ["google", "facebook", "apple"],
        },
        providerId: String,
        email: String,
        connectedAt: Date,
      },
    ],

    // ========================
    // PROFILE INFORMATION
    // ========================
    profile: {
      firstName: {
        type: String,
        required: [true, "First name is required"],
        trim: true,
        maxlength: [50, "First name cannot exceed 50 characters"],
      },

      lastName: {
        type: String,
        trim: true,
        maxlength: [50, "Last name cannot exceed 50 characters"],
      },

      displayName: {
        type: String,
        trim: true,
        maxlength: [50, "Display name cannot exceed 50 characters"],
      },

      dateOfBirth: {
        type: Date,
        required: [true, "Date of birth is required"],
        validate: {
          validator: function (value) {
            const age = Math.floor((Date.now() - value) / 31557600000);
            return (
              age >= USER_CONSTANTS.MIN_AGE && age <= USER_CONSTANTS.MAX_AGE
            );
          },
          message: `Age must be between ${USER_CONSTANTS.MIN_AGE} and ${USER_CONSTANTS.MAX_AGE}`,
        },
      },

      bio: {
        type: String,
        maxlength: [
          USER_CONSTANTS.MAX_BIO_LENGTH,
          `Bio cannot exceed ${USER_CONSTANTS.MAX_BIO_LENGTH} characters`,
        ],
        trim: true,
      },

      gender: {
        type: String,
        enum: Object.values(GENDER_OPTIONS),
        required: [true, "Gender is required"],
      },

      sexualOrientation: [
        {
          type: String,
          enum: Object.values(SEXUAL_ORIENTATION),
        },
      ],

      showOrientation: {
        type: Boolean,
        default: false,
      },

      location: LocationSchema,

      photos: {
        type: [PhotoSchema],
        validate: {
          validator: function (photos) {
            return photos.length <= USER_CONSTANTS.MAX_PHOTOS;
          },
          message: `Cannot have more than ${USER_CONSTANTS.MAX_PHOTOS} photos`,
        },
      },

      height: {
        type: Number,
        min: [100, "Height must be at least 100cm"],
        max: [250, "Height cannot exceed 250cm"],
      },

      interests: [
        {
          type: String,
          trim: true,
        },
      ],

      languages: [
        {
          language: String,
          proficiency: {
            type: String,
            enum: ["basic", "conversational", "fluent", "native"],
          },
        },
      ],

      lifestyle: {
        drinking: {
          type: String,
          enum: Object.values(LIFESTYLE.DRINKING),
        },
        smoking: {
          type: String,
          enum: Object.values(LIFESTYLE.SMOKING),
        },
        workout: {
          type: String,
          enum: Object.values(LIFESTYLE.WORKOUT),
        },
        pets: [
          {
            type: String,
            enum: Object.values(LIFESTYLE.PETS),
          },
        ],
        children: {
          type: String,
          enum: Object.values(LIFESTYLE.CHILDREN),
        },
        diet: {
          type: String,
          enum: Object.values(LIFESTYLE.DIET),
        },
        zodiac: {
          type: String,
          enum: Object.values(LIFESTYLE.ZODIAC),
        },
        religion: {
          type: String,
          enum: Object.values(LIFESTYLE.RELIGION),
        },
        politics: {
          type: String,
          enum: Object.values(LIFESTYLE.POLITICS),
        },
      },

      education: {
        level: {
          type: String,
          enum: Object.values(EDUCATION_LEVELS),
        },
        school: {
          type: String,
          maxlength: 100,
        },
        major: {
          type: String,
          maxlength: 100,
        },
        graduationYear: Number,
      },

      career: {
        jobTitle: {
          type: String,
          maxlength: 100,
        },
        company: {
          type: String,
          maxlength: 100,
        },
        industry: String,
      },

      relationshipGoal: {
        type: String,
        enum: Object.values(RELATIONSHIP_GOALS),
      },

      prompts: [
        {
          promptId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Prompt",
          },
          question: String,
          answer: {
            type: String,
            maxlength: 300,
          },
        },
      ],
    },

    // ========================
    // PREFERENCES
    // ========================
    preferences: {
      ageRange: {
        min: {
          type: Number,
          default: USER_CONSTANTS.MIN_AGE,
          min: USER_CONSTANTS.MIN_AGE,
        },
        max: {
          type: Number,
          default: 50,
          max: USER_CONSTANTS.MAX_AGE,
        },
      },

      maxDistance: {
        type: Number,
        default: USER_CONSTANTS.DEFAULT_SEARCH_RADIUS,
        min: USER_CONSTANTS.MIN_SEARCH_RADIUS,
        max: USER_CONSTANTS.MAX_SEARCH_RADIUS,
      },

      distanceUnit: {
        type: String,
        enum: ["km", "mi"],
        default: "km",
      },

      genderPreference: [
        {
          type: String,
          enum: Object.values(GENDER_OPTIONS),
        },
      ],

      heightRange: {
        min: Number,
        max: Number,
      },

      languages: [String],

      dealbreakers: {
        smoking: Boolean,
        drinking: Boolean,
        children: Boolean,
        pets: Boolean,
      },

      showMe: {
        type: Boolean,
        default: true,
      },

      globalMode: {
        type: Boolean,
        default: false,
      },

      incognitoMode: {
        type: Boolean,
        default: false,
      },

      autoPlayVideos: {
        type: Boolean,
        default: true,
      },

      showActiveStatus: {
        type: Boolean,
        default: true,
      },

      showDistanceIn: {
        type: String,
        enum: ["km", "mi"],
        default: "km",
      },
    },

    // ========================
    // SUBSCRIPTION & FEATURES
    // ========================
    subscription: {
      type: {
        type: String,
        enum: Object.values(SUBSCRIPTION_TYPES),
        default: SUBSCRIPTION_TYPES.FREE,
      },

      validUntil: Date,

      startedAt: Date,

      cancelledAt: Date,

      paymentMethod: {
        type: String,
        enum: ["card", "paypal", "apple_pay", "google_pay"],
      },

      stripeCustomerId: String,

      stripeSubscriptionId: String,

      features: {
        unlimitedLikes: {
          type: Boolean,
          default: false,
        },
        seeWhoLikesYou: {
          type: Boolean,
          default: false,
        },
        unlimitedRewinds: {
          type: Boolean,
          default: false,
        },
        passport: {
          type: Boolean,
          default: false,
        },
        noAds: {
          type: Boolean,
          default: false,
        },
        superLikesPerDay: {
          type: Number,
          default: 0,
        },
        boostsPerMonth: {
          type: Number,
          default: 0,
        },
        messageBeforeMatch: {
          type: Boolean,
          default: false,
        },
        priorityLikes: {
          type: Boolean,
          default: false,
        },
        topPicks: {
          type: Number,
          default: 0,
        },
      },
    },

    // ========================
    // LIMITS & QUOTAS
    // ========================
    limits: {
      dailyLikes: {
        count: {
          type: Number,
          default: 0,
        },
        resetAt: Date,
      },

      dailySuperLikes: {
        count: {
          type: Number,
          default: 0,
        },
        resetAt: Date,
      },

      monthlyBoosts: {
        count: {
          type: Number,
          default: 0,
        },
        resetAt: Date,
      },

      rewinds: {
        count: {
          type: Number,
          default: 0,
        },
        resetAt: Date,
      },
    },

    // ========================
    // SCORING & ALGORITHM
    // ========================
    scoring: {
      eloScore: {
        type: Number,
        default: 1500,
        min: 0,
        max: 3000,
      },

      attractivenessScore: {
        type: Number,
        default: 0.5,
        min: 0,
        max: 1,
      },

      activityScore: {
        type: Number,
        default: 1.0,
        min: 0,
        max: 1,
      },

      responseRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 1,
      },

      profileCompleteness: {
        type: Number,
        default: 0,
        min: 0,
        max: 1,
      },

      popularityScore: {
        type: Number,
        default: 0,
        min: 0,
        max: 1,
      },

      lastScoringUpdate: Date,
    },

    // ========================
    // STATISTICS
    // ========================
    stats: {
      totalLikes: {
        type: Number,
        default: 0,
      },

      totalSuperLikes: {
        type: Number,
        default: 0,
      },

      totalMatches: {
        type: Number,
        default: 0,
      },

      totalSwipes: {
        type: Number,
        default: 0,
      },

      swipeRatio: {
        type: Number,
        default: 0,
      },

      messagesSent: {
        type: Number,
        default: 0,
      },

      messagesReceived: {
        type: Number,
        default: 0,
      },

      profileViews: {
        type: Number,
        default: 0,
      },

      lastActive: Date,
    },

    // ========================
    // VERIFICATION
    // ========================
    verification: {
      email: {
        verified: {
          type: Boolean,
          default: false,
        },
        verifiedAt: Date,
        token: String,
        tokenExpiry: Date,
      },

      phone: {
        verified: {
          type: Boolean,
          default: false,
        },
        verifiedAt: Date,
        code: String,
        codeExpiry: Date,
        attempts: {
          type: Number,
          default: 0,
        },
      },

      photo: {
        verified: {
          type: Boolean,
          default: false,
        },
        verifiedAt: Date,
        verificationPhotoUrl: String,
        verifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },

      identity: {
        verified: {
          type: Boolean,
          default: false,
        },
        verifiedAt: Date,
        documentType: String,
        documentNumber: String,
        verifiedBy: String,
      },
    },

    // ========================
    // SECURITY
    // ========================
    security: {
      twoFactorEnabled: {
        type: Boolean,
        default: false,
      },

      twoFactorMethod: {
        type: String,
        enum: ["app", "sms", "email"],
      },

      twoFactorSecret: {
        type: String,
        select: false,
      },

      backupCodes: {
        type: [String],
        select: false,
      },

      loginAttempts: {
        type: Number,
        default: 0,
      },

      lockUntil: Date,

      lastFailedLogin: Date,

      passwordChangedAt: Date,

      passwordResetToken: String,

      passwordResetExpires: Date,

      sessions: [
        {
          sessionId: String,
          deviceInfo: {
            platform: String,
            deviceId: String,
            userAgent: String,
            ip: String,
          },
          createdAt: Date,
          lastActivity: Date,
        },
      ],
    },

    // ========================
    // STATUS & FLAGS
    // ========================
    status: {
      isActive: {
        type: Boolean,
        default: true,
      },

      isOnline: {
        type: Boolean,
        default: false,
      },

      isPaused: {
        type: Boolean,
        default: false,
      },

      isBanned: {
        type: Boolean,
        default: false,
      },

      isDeleted: {
        type: Boolean,
        default: false,
      },

      bannedReason: String,

      bannedAt: Date,

      bannedUntil: Date,

      deletedAt: Date,

      deletionReason: String,

      lastActive: {
        type: Date,
        default: Date.now,
      },

      lastLogin: Date,

      lastLoginIp: String,
    },

    // ========================
    // NOTIFICATIONS
    // ========================
    notifications: {
      push: {
        enabled: {
          type: Boolean,
          default: true,
        },
        tokens: [
          {
            token: String,
            platform: {
              type: String,
              enum: ["ios", "android", "web"],
            },
            addedAt: Date,
          },
        ],
      },

      email: {
        enabled: {
          type: Boolean,
          default: true,
        },
        marketing: {
          type: Boolean,
          default: false,
        },
        frequency: {
          type: String,
          enum: ["instant", "daily", "weekly", "never"],
          default: "instant",
        },
      },

      sms: {
        enabled: {
          type: Boolean,
          default: false,
        },
      },

      inApp: {
        messages: {
          type: Boolean,
          default: true,
        },
        matches: {
          type: Boolean,
          default: true,
        },
        likes: {
          type: Boolean,
          default: true,
        },
        superLikes: {
          type: Boolean,
          default: true,
        },
      },
    },

    // ========================
    // PRIVACY
    // ========================
    privacy: {
      hideAge: {
        type: Boolean,
        default: false,
      },

      hideDistance: {
        type: Boolean,
        default: false,
      },

      hideProfile: {
        type: Boolean,
        default: false,
      },

      hideFromFriends: {
        type: Boolean,
        default: false,
      },

      blockedUsers: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      ],

      readReceipts: {
        type: Boolean,
        default: true,
      },

      activityStatus: {
        type: Boolean,
        default: true,
      },
    },

    // ========================
    // BOOSTS & POWER-UPS
    // ========================
    boosts: [
      {
        startedAt: Date,
        expiresAt: Date,
        type: {
          type: String,
          enum: ["regular", "super"],
        },
        multiplier: {
          type: Number,
          default: 10,
        },
      },
    ],

    spotlights: [
      {
        startedAt: Date,
        expiresAt: Date,
        views: {
          type: Number,
          default: 0,
        },
      },
    ],

    // ========================
    // METADATA
    // ========================
    metadata: {
      registrationIp: String,

      registrationSource: {
        type: String,
        enum: ["ios", "android", "web", "api"],
      },

      registrationVersion: String,

      referralCode: String,

      referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },

      referralCount: {
        type: Number,
        default: 0,
      },

      devices: [
        {
          deviceId: String,
          platform: String,
          model: String,
          os: String,
          appVersion: String,
          lastUsed: Date,
        },
      ],

      experiments: [
        {
          name: String,
          variant: String,
          enrolledAt: Date,
        },
      ],

      flags: {
        isVip: {
          type: Boolean,
          default: false,
        },
        isInfluencer: {
          type: Boolean,
          default: false,
        },
        isTestUser: {
          type: Boolean,
          default: false,
        },
        isFeatured: {
          type: Boolean,
          default: false,
        },
      },
    },

    // ========================
    // ADMIN
    // ========================
    role: {
      type: String,
      enum: ["user", "moderator", "admin", "superadmin"],
      default: "user",
    },

    adminNotes: [
      {
        note: String,
        addedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        addedAt: Date,
      },
    ],
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

// ========================
// INDEXES
// ========================
UserSchema.index({ email: 1 });
UserSchema.index({ phoneNumber: 1 });
UserSchema.index({ "profile.location": "2dsphere" });
UserSchema.index({ "scoring.eloScore": -1 });
UserSchema.index({ "status.isActive": 1, "preferences.showMe": 1 });
UserSchema.index({ "profile.gender": 1, "preferences.genderPreference": 1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ "status.lastActive": -1 });
UserSchema.index({ "subscription.type": 1 });
UserSchema.index({ "metadata.referralCode": 1 });

// ========================
// VIRTUALS
// ========================
UserSchema.virtual("age").get(function () {
  if (!this.profile?.dateOfBirth) return null;
  return Math.floor((Date.now() - this.profile.dateOfBirth) / 31557600000);
});

UserSchema.virtual("fullName").get(function () {
  return `${this.profile?.firstName || ""} ${this.profile?.lastName || ""}`.trim();
});

UserSchema.virtual("isPremium").get(function () {
  return (
    this.subscription?.type !== "free" &&
    this.subscription?.validUntil > new Date()
  );
});

UserSchema.virtual("mainPhoto").get(function () {
  return (
    this.profile?.photos?.find((photo) => photo.isMain) ||
    this.profile?.photos?.[0]
  );
});

UserSchema.virtual("isVerified").get(function () {
  return (
    this.verification?.email?.verified ||
    this.verification?.phone?.verified ||
    this.verification?.photo?.verified
  );
});

// ========================
// INSTANCE METHODS
// ========================
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

UserSchema.methods.generateAuthToken = function () {
  const jwt = require("jsonwebtoken");
  return jwt.sign(
    {
      userId: this._id,
      email: this.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
};

UserSchema.methods.generatePasswordResetToken = function () {
  const resetToken = crypto.randomBytes(32).toString("hex");

  this.security.passwordResetToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  this.security.passwordResetExpires = Date.now() + 3600000; // 1 hour

  return resetToken;
};

UserSchema.methods.generateEmailVerificationToken = function () {
  const token = crypto.randomBytes(32).toString("hex");

  this.verification.email.token = crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");

  this.verification.email.tokenExpiry = Date.now() + 86400000; // 24 hours

  return token;
};

UserSchema.methods.calculateProfileCompleteness = function () {
  const fields = [
    "profile.bio",
    "profile.photos",
    "profile.interests",
    "profile.education.level",
    "profile.career.jobTitle",
    "profile.lifestyle.drinking",
    "profile.lifestyle.smoking",
    "profile.relationshipGoal",
  ];

  let completed = 0;
  let total = fields.length;

  fields.forEach((field) => {
    const value = field.split(".").reduce((obj, key) => obj?.[key], this);
    if (value) {
      if (Array.isArray(value) && value.length > 0) completed++;
      else if (!Array.isArray(value)) completed++;
    }
  });

  // Special handling for photos
  if (this.profile?.photos?.length >= 3) {
    completed += 1; // Bonus for having 3+ photos
    total += 1;
  }

  return completed / total;
};

UserSchema.methods.isAccountLocked = function () {
  return !!(this.security.lockUntil && this.security.lockUntil > Date.now());
};

UserSchema.methods.incrementLoginAttempts = function () {
  // Reset attempts if lock has expired
  if (this.security.lockUntil && this.security.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { "security.loginAttempts": 1 },
      $unset: { "security.lockUntil": 1 },
    });
  }

  const updates = { $inc: { "security.loginAttempts": 1 } };
  const maxAttempts = 5;

  // Lock account after max attempts
  if (this.security.loginAttempts + 1 >= maxAttempts) {
    updates.$set = { "security.lockUntil": Date.now() + 3600000 }; // 1 hour
  }

  return this.updateOne(updates);
};

UserSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({
    $set: { "security.loginAttempts": 0 },
    $unset: { "security.lockUntil": 1 },
  });
};

UserSchema.methods.canSwipe = function () {
  if (this.isPremium) return true;

  const dailyLimit = USER_CONSTANTS.DAILY_LIKE_LIMIT;
  const resetTime = this.limits.dailyLikes.resetAt;

  if (!resetTime || resetTime < Date.now()) {
    return true;
  }

  return this.limits.dailyLikes.count < dailyLimit;
};

UserSchema.methods.toPublicProfile = function () {
  const profile = this.toObject();

  // Remove sensitive fields
  delete profile.password;
  delete profile.security;
  delete profile.verification.email.token;
  delete profile.verification.phone.code;
  delete profile.metadata.registrationIp;
  delete profile.adminNotes;

  return profile;
};

UserSchema.methods.toMatchProfile = function () {
  // Return limited profile info for matches
  return {
    _id: this._id,
    profile: {
      firstName: this.profile.firstName,
      displayName: this.profile.displayName,
      age: this.age,
      bio: this.profile.bio,
      photos: this.profile.photos,
      interests: this.profile.interests,
      location: this.privacy.hideDistance ? null : this.profile.location,
      lifestyle: this.profile.lifestyle,
      education: this.profile.education,
      career: this.profile.career,
    },
    verification: {
      photo: this.verification.photo.verified,
    },
    status: {
      isOnline: this.privacy.activityStatus ? this.status.isOnline : null,
      lastActive: this.privacy.activityStatus ? this.status.lastActive : null,
    },
  };
};

// ========================
// STATIC METHODS
// ========================
UserSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase() });
};

UserSchema.statics.findActiveUsers = function () {
  return this.find({
    "status.isActive": true,
    "status.isBanned": false,
    "status.isDeleted": false,
  });
};

UserSchema.statics.findNearby = function (coordinates, maxDistance = 50) {
  return this.find({
    "profile.location": {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: coordinates,
        },
        $maxDistance: maxDistance * 1000, // Convert km to meters
      },
    },
    "status.isActive": true,
    "preferences.showMe": true,
  });
};

UserSchema.statics.updateActivityScore = async function (userId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const user = await this.findById(userId);
  if (!user) return;

  // Calculate activity based on recent actions
  const recentActivity = user.status.lastActive > thirtyDaysAgo ? 1 : 0.5;
  const profileComplete = user.scoring.profileCompleteness;
  const hasPhotos = user.profile.photos.length >= 3 ? 1 : 0.5;

  const activityScore = (recentActivity + profileComplete + hasPhotos) / 3;

  await this.findByIdAndUpdate(userId, {
    "scoring.activityScore": activityScore,
    "scoring.lastScoringUpdate": new Date(),
  });
};

// ========================
// HOOKS
// ========================
UserSchema.pre("save", async function (next) {
  // Hash password if modified
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 10);
    this.security.passwordChangedAt = Date.now();
  }

  // Update profile completeness
  if (this.isModified("profile")) {
    this.scoring.profileCompleteness = this.calculateProfileCompleteness();
  }

  // Set display name if not set
  if (!this.profile.displayName && this.profile.firstName) {
    this.profile.displayName = this.profile.firstName;
  }

  // Ensure only one main photo
  if (this.profile.photos?.length > 0) {
    const mainPhotos = this.profile.photos.filter((p) => p.isMain);
    if (mainPhotos.length === 0) {
      this.profile.photos[0].isMain = true;
    } else if (mainPhotos.length > 1) {
      this.profile.photos.forEach((photo, index) => {
        photo.isMain = index === 0;
      });
    }
  }
// ========================
// HOOKS (continued)
// ========================
 
 // Generate referral code if not exists
 if (!this.metadata.referralCode && this.isNew) {
   this.metadata.referralCode = this.generateReferralCode();
 }
 
 // Set default preferences based on gender
 if (this.isNew && !this.preferences.genderPreference?.length) {
   if (this.profile.gender === GENDER_OPTIONS.MALE) {
     this.preferences.genderPreference = [GENDER_OPTIONS.FEMALE];
   } else if (this.profile.gender === GENDER_OPTIONS.FEMALE) {
     this.preferences.genderPreference = [GENDER_OPTIONS.MALE];
   } else {
     this.preferences.genderPreference = Object.values(GENDER_OPTIONS);
   }
 }
 
 next();
});

UserSchema.pre('findOneAndUpdate', async function(next) {
 const update = this.getUpdate();
 
 // Update lastActive timestamp
 if (update.$set) {
   update.$set['status.lastActive'] = new Date();
 }
 
 // Recalculate profile completeness if profile is updated
 if (update.$set && Object.keys(update.$set).some(key => key.startsWith('profile.'))) {
   const user = await this.model.findOne(this.getQuery());
   if (user) {
     update.$set['scoring.profileCompleteness'] = user.calculateProfileCompleteness();
   }
 }
 
 next();
});

UserSchema.post('save', async function(doc) {
 // Clear user cache after save
 if (global.CacheService) {
   await global.CacheService.invalidateUser(doc._id.toString());
 }
 
 // Track metrics for new users
 if (doc.wasNew && global.MetricsService) {
   await global.MetricsService.incrementCounter('users.total');
   await global.MetricsService.trackUserAction(doc._id.toString(), 'user_created', {
     source: doc.metadata.registrationSource,
   });
 }
});

// ========================
// MORE INSTANCE METHODS
// ========================

UserSchema.methods.generateReferralCode = function() {
 const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
 let code = '';
 for (let i = 0; i < 6; i++) {
   code += chars.charAt(Math.floor(Math.random() * chars.length));
 }
 return code;
};

UserSchema.methods.applyBoost = async function(type = 'regular', duration = 30) {
 const boost = {
   startedAt: new Date(),
   expiresAt: new Date(Date.now() + duration * 60000),
   type,
   multiplier: type === 'super' ? 20 : 10,
 };
 
 this.boosts.push(boost);
 
 // Remove expired boosts
 this.boosts = this.boosts.filter(b => b.expiresAt > new Date());
 
 return this.save();
};

UserSchema.methods.hasActiveBoost = function() {
 return this.boosts.some(boost => boost.expiresAt > new Date());
};

UserSchema.methods.getActiveBoost = function() {
 return this.boosts.find(boost => boost.expiresAt > new Date());
};

UserSchema.methods.addSpotlight = async function(duration = 30) {
 const spotlight = {
   startedAt: new Date(),
   expiresAt: new Date(Date.now() + duration * 60000),
   views: 0,
 };
 
 this.spotlights.push(spotlight);
 
 // Remove expired spotlights
 this.spotlights = this.spotlights.filter(s => s.expiresAt > new Date());
 
 return this.save();
};

UserSchema.methods.incrementSpotlightViews = async function() {
 const activeSpotlight = this.spotlights.find(s => s.expiresAt > new Date());
 if (activeSpotlight) {
   activeSpotlight.views++;
   return this.save();
 }
};

UserSchema.methods.blockUser = async function(userIdToBlock) {
 if (!this.privacy.blockedUsers.includes(userIdToBlock)) {
   this.privacy.blockedUsers.push(userIdToBlock);
   return this.save();
 }
};

UserSchema.methods.unblockUser = async function(userIdToUnblock) {
 this.privacy.blockedUsers = this.privacy.blockedUsers.filter(
   id => id.toString() !== userIdToUnblock.toString()
 );
 return this.save();
};

UserSchema.methods.isBlocked = function(userId) {
 return this.privacy.blockedUsers.some(
   id => id.toString() === userId.toString()
 );
};

UserSchema.methods.updateLastActive = async function() {
 this.status.lastActive = new Date();
 this.status.isOnline = true;
 return this.save();
};

UserSchema.methods.setOffline = async function() {
 this.status.isOnline = false;
 this.status.lastActive = new Date();
 return this.save();
};

UserSchema.methods.addDevice = async function(deviceInfo) {
 const existingDevice = this.metadata.devices.find(
   d => d.deviceId === deviceInfo.deviceId
 );
 
 if (existingDevice) {
   existingDevice.lastUsed = new Date();
   existingDevice.appVersion = deviceInfo.appVersion || existingDevice.appVersion;
 } else {
   this.metadata.devices.push({
     ...deviceInfo,
     lastUsed: new Date(),
   });
   
   // Keep only last 5 devices
   if (this.metadata.devices.length > 5) {
     this.metadata.devices = this.metadata.devices
       .sort((a, b) => b.lastUsed - a.lastUsed)
       .slice(0, 5);
   }
 }
 
 return this.save();
};

UserSchema.methods.resetDailyLimits = async function() {
 const now = new Date();
 const tomorrow = new Date(now);
 tomorrow.setDate(tomorrow.getDate() + 1);
 tomorrow.setHours(0, 0, 0, 0);
 
 this.limits.dailyLikes = {
   count: 0,
   resetAt: tomorrow,
 };
 
 this.limits.dailySuperLikes = {
   count: 0,
   resetAt: tomorrow,
 };
 
 this.limits.rewinds = {
   count: 0,
   resetAt: tomorrow,
 };
 
 return this.save();
};

UserSchema.methods.resetMonthlyLimits = async function() {
 const now = new Date();
 const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
 
 this.limits.monthlyBoosts = {
   count: 0,
   resetAt: nextMonth,
 };
 
 return this.save();
};

UserSchema.methods.incrementLikeCount = async function() {
 const now = new Date();
 
 // Check if daily limit needs reset
 if (!this.limits.dailyLikes.resetAt || this.limits.dailyLikes.resetAt < now) {
   await this.resetDailyLimits();
 }
 
 this.limits.dailyLikes.count++;
 this.stats.totalLikes++;
 
 return this.save();
};

UserSchema.methods.incrementSuperLikeCount = async function() {
 const now = new Date();
 
 // Check if daily limit needs reset
 if (!this.limits.dailySuperLikes.resetAt || this.limits.dailySuperLikes.resetAt < now) {
   await this.resetDailyLimits();
 }
 
 this.limits.dailySuperLikes.count++;
 this.stats.totalSuperLikes++;
 
 return this.save();
};

UserSchema.methods.canSuperLike = function() {
 if (this.isPremium) {
   const limits = {
     plus: 5,
     gold: 5,
     platinum: -1, // Unlimited
   };
   
   const limit = limits[this.subscription.type];
   if (limit === -1) return true;
   
   return this.limits.dailySuperLikes.count < limit;
 }
 
 // Free users get 1 super like per day
 return this.limits.dailySuperLikes.count < 1;
};

UserSchema.methods.updateEloScore = function(won, opponentElo) {
 const K = 32; // K-factor
 const expectedScore = 1 / (1 + Math.pow(10, (opponentElo - this.scoring.eloScore) / 400));
 const actualScore = won ? 1 : 0;
 
 this.scoring.eloScore += K * (actualScore - expectedScore);
 this.scoring.eloScore = Math.max(0, Math.min(3000, this.scoring.eloScore)); // Clamp between 0-3000
 
 return this.save();
};

UserSchema.methods.updateResponseRate = function(responded) {
 const alpha = 0.1; // Smoothing factor
 const currentRate = this.scoring.responseRate || 0;
 const newValue = responded ? 1 : 0;
 
 this.scoring.responseRate = alpha * newValue + (1 - alpha) * currentRate;
 
 return this.save();
};

UserSchema.methods.pauseAccount = async function() {
 this.status.isPaused = true;
 this.preferences.showMe = false;
 return this.save();
};

UserSchema.methods.unpauseAccount = async function() {
 this.status.isPaused = false;
 this.preferences.showMe = true;
 return this.save();
};

UserSchema.methods.softDelete = async function(reason = '') {
 this.status.isDeleted = true;
 this.status.deletedAt = new Date();
 this.status.deletionReason = reason;
 this.status.isActive = false;
 this.preferences.showMe = false;
 
 // Anonymize personal data
 this.email = `deleted_${this._id}@deleted.com`;
 this.phoneNumber = null;
 this.profile.firstName = 'Deleted';
 this.profile.lastName = 'User';
 this.profile.bio = '';
 this.profile.photos = [];
 
 return this.save();
};

UserSchema.methods.restore = async function() {
 if (!this.status.isDeleted) {
   throw new Error('Account is not deleted');
 }
 
 const daysSinceDeletion = Math.floor(
   (Date.now() - this.status.deletedAt) / (1000 * 60 * 60 * 24)
 );
 
 if (daysSinceDeletion > 30) {
   throw new Error('Account cannot be restored after 30 days');
 }
 
 this.status.isDeleted = false;
 this.status.isActive = true;
 this.status.deletedAt = null;
 this.status.deletionReason = null;
 
 // Note: Personal data cannot be restored
 return this.save();
};

UserSchema.methods.ban = async function(reason, duration = null) {
 this.status.isBanned = true;
 this.status.bannedAt = new Date();
 this.status.bannedReason = reason;
 
 if (duration) {
   this.status.bannedUntil = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
 }
 
 this.status.isActive = false;
 this.preferences.showMe = false;
 
 return this.save();
};

UserSchema.methods.unban = async function() {
 this.status.isBanned = false;
 this.status.bannedAt = null;
 this.status.bannedReason = null;
 this.status.bannedUntil = null;
 this.status.isActive = true;
 
 return this.save();
};

UserSchema.methods.addAdminNote = async function(note, adminId) {
 this.adminNotes.push({
   note,
   addedBy: adminId,
   addedAt: new Date(),
 });
 
 return this.save();
};

// ========================
// MORE STATIC METHODS
// ========================

UserSchema.statics.findPotentialMatches = async function(userId, limit = 10) {
 const user = await this.findById(userId);
 if (!user) throw new Error('User not found');
 
 // Import Swipe model to check already swiped users
 const Swipe = mongoose.model('Swipe');
 const swipedUserIds = await Swipe.distinct('to', { from: userId });
 
 return this.aggregate([
   {
     $match: {
       _id: { 
         $ne: mongoose.Types.ObjectId(userId),
         $nin: swipedUserIds.map(id => mongoose.Types.ObjectId(id))
       },
       'status.isActive': true,
       'status.isBanned': false,
       'preferences.showMe': true,
       gender: { $in: user.preferences.genderPreference },
     },
   },
   {
     $geoNear: {
       near: user.profile.location,
       distanceField: 'distance',
       maxDistance: user.preferences.maxDistance * 1000,
       spherical: true,
     },
   },
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
   {
     $match: {
       age: {
         $gte: user.preferences.ageRange.min,
         $lte: user.preferences.ageRange.max,
       },
     },
   },
   {
     $limit: limit,
   },
 ]);
};

UserSchema.statics.getTopPicksForUser = async function(userId, limit = 10) {
 const user = await this.findById(userId);
 if (!user) throw new Error('User not found');
 
 return this.aggregate([
   {
     $match: {
       _id: { $ne: mongoose.Types.ObjectId(userId) },
       'status.isActive': true,
       'preferences.showMe': true,
       gender: { $in: user.preferences.genderPreference },
       'verification.photo.verified': true, // Only verified profiles
     },
   },
   {
     $geoNear: {
       near: user.profile.location,
       distanceField: 'distance',
       maxDistance: user.preferences.maxDistance * 1000,
       spherical: true,
     },
   },
   {
     $addFields: {
       compatibilityScore: {
         $add: [
           // Common interests weight
           {
             $multiply: [
               {
                 $size: {
                   $setIntersection: ['$profile.interests', user.profile.interests || []],
                 },
               },
               10,
             ],
           },
           // ELO score similarity
           {
             $divide: [
               { $abs: { $subtract: ['$scoring.eloScore', user.scoring.eloScore] } },
               100,
             ],
           },
           // Activity score
           { $multiply: ['$scoring.activityScore', 20] },
           // Profile completeness
           { $multiply: ['$scoring.profileCompleteness', 15] },
         ],
       },
     },
   },
   {
     $sort: { compatibilityScore: -1 },
   },
   {
     $limit: limit,
   },
 ]);
};

UserSchema.statics.searchUsers = async function(query, filters = {}) {
 const searchQuery = {
   'status.isActive': true,
   'status.isBanned': false,
 };
 
 if (query) {
   searchQuery.$or = [
     { 'profile.firstName': new RegExp(query, 'i') },
     { 'profile.lastName': new RegExp(query, 'i') },
     { 'profile.bio': new RegExp(query, 'i') },
   ];
 }
 
 if (filters.gender) {
   searchQuery['profile.gender'] = filters.gender;
 }
 
 if (filters.minAge || filters.maxAge) {
   const now = new Date();
   searchQuery['profile.dateOfBirth'] = {};
   
   if (filters.maxAge) {
     searchQuery['profile.dateOfBirth'].$gte = new Date(
       now.getFullYear() - filters.maxAge - 1,
       now.getMonth(),
       now.getDate()
     );
   }
   
   if (filters.minAge) {
     searchQuery['profile.dateOfBirth'].$lte = new Date(
       now.getFullYear() - filters.minAge,
       now.getMonth(),
       now.getDate()
     );
   }
 }
 
 if (filters.verified) {
   searchQuery['verification.photo.verified'] = true;
 }
 
 if (filters.interests?.length > 0) {
   searchQuery['profile.interests'] = { $in: filters.interests };
 }
 
 return this.find(searchQuery)
   .select('-password -security -adminNotes')
   .limit(filters.limit || 20)
   .skip(filters.skip || 0);
};

UserSchema.statics.updateBulkActivityScores = async function() {
 const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
 
 // Find all users who need score updates
 const users = await this.find({
   $or: [
     { 'scoring.lastScoringUpdate': { $lt: thirtyDaysAgo } },
     { 'scoring.lastScoringUpdate': { $exists: false } },
   ],
 }).limit(100); // Process in batches
 
 for (const user of users) {
   await this.updateActivityScore(user._id);
 }
 
 return users.length;
};

UserSchema.statics.cleanupInactiveUsers = async function(daysInactive = 180) {
 const cutoffDate = new Date(Date.now() - daysInactive * 24 * 60 * 60 * 1000);
 
 const result = await this.updateMany(
   {
     'status.lastActive': { $lt: cutoffDate },
     'status.isActive': true,
     'subscription.type': 'free',
   },
   {
     $set: {
       'status.isActive': false,
       'preferences.showMe': false,
     },
   }
 );
 
 return result.modifiedCount;
};

// ========================
// EXPORT
// ========================

const User = mongoose.model('User', UserSchema);

export default User;