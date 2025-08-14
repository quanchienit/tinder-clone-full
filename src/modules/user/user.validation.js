// src/modules/user/user.validation.js
import { body, param, query, check } from "express-validator";
import mongoose from "mongoose";
import {
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION,
  LIFESTYLE,
  EDUCATION_LEVELS,
  RELATIONSHIP_GOALS,
  USER_CONSTANTS,
  REGEX_PATTERNS,
  REPORT_REASONS,
  SUBSCRIPTION_TYPES,
} from "../../config/constants.js";

/**
 * Custom validators
 */
const customValidators = {
  /**
   * Validate MongoDB ObjectId
   */
  isValidObjectId: (value) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error("Invalid ID format");
    }
    return true;
  },

  /**
   * Validate age from date of birth
   */
  isValidAge: (value) => {
    const age = Math.floor((Date.now() - new Date(value)) / 31557600000);
    if (age < USER_CONSTANTS.MIN_AGE || age > USER_CONSTANTS.MAX_AGE) {
      throw new Error(
        `Age must be between ${USER_CONSTANTS.MIN_AGE} and ${USER_CONSTANTS.MAX_AGE}`,
      );
    }
    return true;
  },

  /**
   * Validate coordinates
   */
  isValidCoordinates: (lat, lng) => {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error("Invalid coordinates");
    }
    return true;
  },

  /**
   * Validate photo array
   */
  isValidPhotoArray: (photos) => {
    if (!Array.isArray(photos)) {
      throw new Error("Photos must be an array");
    }
    if (photos.length > USER_CONSTANTS.MAX_PHOTOS) {
      throw new Error(`Maximum ${USER_CONSTANTS.MAX_PHOTOS} photos allowed`);
    }
    return true;
  },

  /**
   * Validate interests array
   */
  isValidInterests: (interests) => {
    if (!Array.isArray(interests)) {
      throw new Error("Interests must be an array");
    }
    if (interests.length > USER_CONSTANTS.MAX_INTERESTS) {
      throw new Error(
        `Maximum ${USER_CONSTANTS.MAX_INTERESTS} interests allowed`,
      );
    }
    if (interests.some((interest) => interest.length > 50)) {
      throw new Error("Each interest must be less than 50 characters");
    }
    return true;
  },

  /**
   * Validate URL
   */
  isValidUrl: (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      throw new Error("Invalid URL format");
    }
  },

  /**
   * Sanitize input
   */
  sanitizeInput: (value) => {
    if (typeof value !== "string") return value;
    return value
      .replace(/[<>]/g, "")
      .replace(/javascript:/gi, "")
      .replace(/on\w+\s*=/gi, "")
      .trim();
  },
};

/**
 * Profile validators
 */
export const profileValidators = {
  /**
   * Get profile
   */
  getProfile: [
    param("userId")
      .optional()
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid user ID"),
  ],

  /**
   * Update profile
   */
  updateProfile: [
    // Basic info
    body("profile.firstName")
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("First name must be between 1 and 50 characters")
      .matches(/^[a-zA-Z\s'-]+$/)
      .withMessage("First name contains invalid characters"),

    body("profile.lastName")
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("Last name must be between 1 and 50 characters")
      .matches(/^[a-zA-Z\s'-]+$/)
      .withMessage("Last name contains invalid characters"),

    body("profile.displayName")
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("Display name must be between 1 and 50 characters"),

    body("profile.dateOfBirth")
      .optional()
      .isISO8601()
      .withMessage("Invalid date format")
      .custom(customValidators.isValidAge),

    body("profile.bio")
      .optional()
      .trim()
      .isLength({ max: USER_CONSTANTS.MAX_BIO_LENGTH })
      .withMessage(
        `Bio cannot exceed ${USER_CONSTANTS.MAX_BIO_LENGTH} characters`,
      )
      .customSanitizer(customValidators.sanitizeInput),

    body("profile.gender")
      .optional()
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage("Invalid gender option"),

    body("profile.sexualOrientation")
      .optional()
      .isArray()
      .withMessage("Sexual orientation must be an array"),

    body("profile.sexualOrientation.*")
      .isIn(Object.values(SEXUAL_ORIENTATION))
      .withMessage("Invalid sexual orientation option"),

    body("profile.showOrientation")
      .optional()
      .isBoolean()
      .withMessage("Show orientation must be a boolean"),

    // Physical attributes
    body("profile.height")
      .optional()
      .isInt({ min: 100, max: 250 })
      .withMessage("Height must be between 100 and 250 cm"),

    // Interests
    body("profile.interests")
      .optional()
      .custom(customValidators.isValidInterests),

    body("profile.interests.*")
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("Each interest must be between 2 and 50 characters")
      .customSanitizer(customValidators.sanitizeInput),

    // Languages
    body("profile.languages")
      .optional()
      .isArray({ max: 10 })
      .withMessage("Maximum 10 languages allowed"),

    body("profile.languages.*.language")
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("Language name must be between 2 and 50 characters"),

    body("profile.languages.*.proficiency")
      .isIn(["basic", "conversational", "fluent", "native"])
      .withMessage("Invalid language proficiency level"),

    // Lifestyle
    body("profile.lifestyle.drinking")
      .optional()
      .isIn(Object.values(LIFESTYLE.DRINKING))
      .withMessage("Invalid drinking preference"),

    body("profile.lifestyle.smoking")
      .optional()
      .isIn(Object.values(LIFESTYLE.SMOKING))
      .withMessage("Invalid smoking preference"),

    body("profile.lifestyle.workout")
      .optional()
      .isIn(Object.values(LIFESTYLE.WORKOUT))
      .withMessage("Invalid workout preference"),

    body("profile.lifestyle.pets")
      .optional()
      .isArray()
      .withMessage("Pets must be an array"),

    body("profile.lifestyle.pets.*")
      .isIn(Object.values(LIFESTYLE.PETS))
      .withMessage("Invalid pet preference"),

    body("profile.lifestyle.children")
      .optional()
      .isIn(Object.values(LIFESTYLE.CHILDREN))
      .withMessage("Invalid children preference"),

    body("profile.lifestyle.diet")
      .optional()
      .isIn(Object.values(LIFESTYLE.DIET))
      .withMessage("Invalid diet preference"),

    body("profile.lifestyle.zodiac")
      .optional()
      .isIn(Object.values(LIFESTYLE.ZODIAC))
      .withMessage("Invalid zodiac sign"),

    body("profile.lifestyle.religion")
      .optional()
      .isIn(Object.values(LIFESTYLE.RELIGION))
      .withMessage("Invalid religion preference"),

    body("profile.lifestyle.politics")
      .optional()
      .isIn(Object.values(LIFESTYLE.POLITICS))
      .withMessage("Invalid political preference"),

    // Education
    body("profile.education.level")
      .optional()
      .isIn(Object.values(EDUCATION_LEVELS))
      .withMessage("Invalid education level"),

    body("profile.education.school")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("School name cannot exceed 100 characters")
      .customSanitizer(customValidators.sanitizeInput),

    body("profile.education.major")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Major cannot exceed 100 characters")
      .customSanitizer(customValidators.sanitizeInput),

    body("profile.education.graduationYear")
      .optional()
      .isInt({ min: 1950, max: new Date().getFullYear() + 10 })
      .withMessage("Invalid graduation year"),

    // Career
    body("profile.career.jobTitle")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Job title cannot exceed 100 characters")
      .customSanitizer(customValidators.sanitizeInput),

    body("profile.career.company")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Company name cannot exceed 100 characters")
      .customSanitizer(customValidators.sanitizeInput),

    body("profile.career.industry")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Industry cannot exceed 100 characters"),

    // Relationship goal
    body("profile.relationshipGoal")
      .optional()
      .isIn(Object.values(RELATIONSHIP_GOALS))
      .withMessage("Invalid relationship goal"),

    // Prompts
    body("profile.prompts")
      .optional()
      .isArray({ max: 3 })
      .withMessage("Maximum 3 prompts allowed"),

    body("profile.prompts.*.promptId")
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid prompt ID"),

    body("profile.prompts.*.answer")
      .trim()
      .isLength({ min: 1, max: 300 })
      .withMessage("Prompt answer must be between 1 and 300 characters")
      .customSanitizer(customValidators.sanitizeInput),
  ],

  /**
   * Complete profile validation (for onboarding)
   */
  completeProfile: [
    body("profile.firstName")
      .notEmpty()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("First name is required"),

    body("profile.dateOfBirth")
      .notEmpty()
      .isISO8601()
      .withMessage("Date of birth is required")
      .custom(customValidators.isValidAge),

    body("profile.gender")
      .notEmpty()
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage("Gender is required"),

    body("profile.photos")
      .isArray({ min: 1 })
      .withMessage("At least one photo is required"),
  ],
};

/**
 * Photo validators
 */
export const photoValidators = {
  /**
   * Upload photo
   */
  uploadPhoto: [
    body("order")
      .optional()
      .isInt({ min: 0, max: USER_CONSTANTS.MAX_PHOTOS - 1 })
      .withMessage(
        `Photo order must be between 0 and ${USER_CONSTANTS.MAX_PHOTOS - 1}`,
      ),

    body("isMain")
      .optional()
      .isBoolean()
      .withMessage("isMain must be a boolean"),
  ],

  /**
   * Delete photo
   */
  deletePhoto: [
    param("photoId")
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid photo ID"),
  ],

  /**
   * Reorder photos
   */
  reorderPhotos: [
    body("photoIds")
      .isArray({ min: 1, max: USER_CONSTANTS.MAX_PHOTOS })
      .withMessage(
        `Must provide between 1 and ${USER_CONSTANTS.MAX_PHOTOS} photo IDs`,
      ),

    body("photoIds.*")
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid photo ID"),
  ],

  /**
   * Set main photo
   */
  setMainPhoto: [
    param("photoId")
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid photo ID"),
  ],
};

/**
 * Location validators
 */
export const locationValidators = {
  /**
   * Update location
   */
  updateLocation: [
    body("latitude")
      .notEmpty()
      .isFloat({ min: -90, max: 90 })
      .withMessage("Invalid latitude"),

    body("longitude")
      .notEmpty()
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),

    body("address")
      .optional()
      .isObject()
      .withMessage("Address must be an object"),

    body("address.city")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("City name cannot exceed 100 characters"),

    body("address.state")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("State name cannot exceed 100 characters"),

    body("address.country")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Country name cannot exceed 100 characters"),

    body("address.postalCode")
      .optional()
      .trim()
      .matches(/^[A-Z0-9\s-]+$/i)
      .withMessage("Invalid postal code format"),
  ],

  /**
   * Find nearby users
   */
  findNearby: [
    query("radius")
      .optional()
      .isInt({ min: 1, max: USER_CONSTANTS.MAX_SEARCH_RADIUS })
      .withMessage(
        `Radius must be between 1 and ${USER_CONSTANTS.MAX_SEARCH_RADIUS} km`,
      ),
  ],
};

/**
 * Preferences validators
 */
export const preferencesValidators = {
  /**
   * Update preferences
   */
  updatePreferences: [
    // Age range
    body("preferences.ageRange.min")
      .optional()
      .isInt({ min: USER_CONSTANTS.MIN_AGE })
      .withMessage(`Minimum age must be at least ${USER_CONSTANTS.MIN_AGE}`),

    body("preferences.ageRange.max")
      .optional()
      .isInt({ max: USER_CONSTANTS.MAX_AGE })
      .withMessage(`Maximum age cannot exceed ${USER_CONSTANTS.MAX_AGE}`)
      .custom((value, { req }) => {
        if (
          req.body.preferences?.ageRange?.min &&
          value < req.body.preferences.ageRange.min
        ) {
          throw new Error("Maximum age must be greater than minimum age");
        }
        return true;
      }),

    // Distance
    body("preferences.maxDistance")
      .optional()
      .isInt({
        min: USER_CONSTANTS.MIN_SEARCH_RADIUS,
        max: USER_CONSTANTS.MAX_SEARCH_RADIUS,
      })
      .withMessage(
        `Distance must be between ${USER_CONSTANTS.MIN_SEARCH_RADIUS} and ${USER_CONSTANTS.MAX_SEARCH_RADIUS} km`,
      ),

    body("preferences.distanceUnit")
      .optional()
      .isIn(["km", "mi"])
      .withMessage("Distance unit must be km or mi"),

    // Gender preference
    body("preferences.genderPreference")
      .optional()
      .isArray()
      .withMessage("Gender preference must be an array"),

    body("preferences.genderPreference.*")
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage("Invalid gender preference"),

    // Height range (premium)
    body("preferences.heightRange.min")
      .optional()
      .isInt({ min: 100, max: 250 })
      .withMessage("Minimum height must be between 100 and 250 cm"),

    body("preferences.heightRange.max")
      .optional()
      .isInt({ min: 100, max: 250 })
      .withMessage("Maximum height must be between 100 and 250 cm")
      .custom((value, { req }) => {
        if (
          req.body.preferences?.heightRange?.min &&
          value < req.body.preferences.heightRange.min
        ) {
          throw new Error("Maximum height must be greater than minimum height");
        }
        return true;
      }),

    // Languages (premium)
    body("preferences.languages")
      .optional()
      .isArray({ max: 10 })
      .withMessage("Maximum 10 language preferences allowed"),

    body("preferences.languages.*")
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("Language must be between 2 and 50 characters"),

    // Dealbreakers (premium)
    body("preferences.dealbreakers.smoking")
      .optional()
      .isBoolean()
      .withMessage("Smoking dealbreaker must be a boolean"),

    body("preferences.dealbreakers.drinking")
      .optional()
      .isBoolean()
      .withMessage("Drinking dealbreaker must be a boolean"),

    body("preferences.dealbreakers.children")
      .optional()
      .isBoolean()
      .withMessage("Children dealbreaker must be a boolean"),

    body("preferences.dealbreakers.pets")
      .optional()
      .isBoolean()
      .withMessage("Pets dealbreaker must be a boolean"),

    // Visibility
    body("preferences.showMe")
      .optional()
      .isBoolean()
      .withMessage("Show me must be a boolean"),

    body("preferences.globalMode")
      .optional()
      .isBoolean()
      .withMessage("Global mode must be a boolean"),

    body("preferences.incognitoMode")
      .optional()
      .isBoolean()
      .withMessage("Incognito mode must be a boolean"),

    // App preferences
    body("preferences.autoPlayVideos")
      .optional()
      .isBoolean()
      .withMessage("Auto-play videos must be a boolean"),

    body("preferences.showActiveStatus")
      .optional()
      .isBoolean()
      .withMessage("Show active status must be a boolean"),

    body("preferences.showDistanceIn")
      .optional()
      .isIn(["km", "mi"])
      .withMessage("Show distance in must be km or mi"),
  ],
};

/**
 * Privacy validators
 */
export const privacyValidators = {
  /**
   * Update privacy settings
   */
  updatePrivacy: [
    body("privacy.hideAge")
      .optional()
      .isBoolean()
      .withMessage("Hide age must be a boolean"),

    body("privacy.hideDistance")
      .optional()
      .isBoolean()
      .withMessage("Hide distance must be a boolean"),

    body("privacy.hideProfile")
      .optional()
      .isBoolean()
      .withMessage("Hide profile must be a boolean"),

    body("privacy.hideFromFriends")
      .optional()
      .isBoolean()
      .withMessage("Hide from friends must be a boolean"),

    body("privacy.readReceipts")
      .optional()
      .isBoolean()
      .withMessage("Read receipts must be a boolean"),

    body("privacy.activityStatus")
      .optional()
      .isBoolean()
      .withMessage("Activity status must be a boolean"),
  ],

  /**
   * Block user
   */
  blockUser: [
    body("targetUserId")
      .notEmpty()
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid user ID")
      .custom((value, { req }) => {
        if (value === req.user?._id?.toString()) {
          throw new Error("Cannot block yourself");
        }
        return true;
      }),
  ],

  /**
   * Unblock user
   */
  unblockUser: [
    param("targetUserId")
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid user ID"),
  ],

  /**
   * Report user
   */
  reportUser: [
    body("reportedUserId")
      .notEmpty()
      .custom(customValidators.isValidObjectId)
      .withMessage("Invalid user ID")
      .custom((value, { req }) => {
        if (value === req.user?._id?.toString()) {
          throw new Error("Cannot report yourself");
        }
        return true;
      }),

    body("reason")
      .notEmpty()
      .isIn(Object.values(REPORT_REASONS))
      .withMessage("Invalid report reason"),

    body("description")
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage("Description cannot exceed 1000 characters")
      .customSanitizer(customValidators.sanitizeInput),

    body("evidence")
      .optional()
      .isArray({ max: 5 })
      .withMessage("Maximum 5 evidence items allowed"),

    body("evidence.*")
      .custom(customValidators.isValidUrl)
      .withMessage("Evidence must be valid URLs"),
  ],
};

/**
 * Notification validators
 */
export const notificationValidators = {
  /**
   * Update notification preferences
   */
  updateNotifications: [
    // Push notifications
    body("notifications.push.enabled")
      .optional()
      .isBoolean()
      .withMessage("Push enabled must be a boolean"),

    // Email notifications
    body("notifications.email.enabled")
      .optional()
      .isBoolean()
      .withMessage("Email enabled must be a boolean"),

    body("notifications.email.marketing")
      .optional()
      .isBoolean()
      .withMessage("Marketing emails must be a boolean"),

    body("notifications.email.frequency")
      .optional()
      .isIn(["instant", "daily", "weekly", "never"])
      .withMessage("Invalid email frequency"),

    // SMS notifications
    body("notifications.sms.enabled")
      .optional()
      .isBoolean()
      .withMessage("SMS enabled must be a boolean"),

    // In-app notifications
    body("notifications.inApp.messages")
      .optional()
      .isBoolean()
      .withMessage("Message notifications must be a boolean"),

    body("notifications.inApp.matches")
      .optional()
      .isBoolean()
      .withMessage("Match notifications must be a boolean"),

    body("notifications.inApp.likes")
      .optional()
      .isBoolean()
      .withMessage("Like notifications must be a boolean"),

    body("notifications.inApp.superLikes")
      .optional()
      .isBoolean()
      .withMessage("Super like notifications must be a boolean"),
  ],

  /**
   * Register push token
   */
  registerPushToken: [
    body("token").notEmpty().trim().withMessage("Push token is required"),

    body("platform")
      .notEmpty()
      .isIn(["ios", "android", "web"])
      .withMessage("Invalid platform"),
  ],
};

/**
 * Search validators
 */
export const searchValidators = {
  /**
   * Search users
   */
  searchUsers: [
    query("q")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Search query must be between 2 and 100 characters")
      .customSanitizer(customValidators.sanitizeInput),

    query("filters.gender")
      .optional()
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage("Invalid gender filter"),

    query("filters.minAge")
      .optional()
      .isInt({ min: USER_CONSTANTS.MIN_AGE })
      .withMessage(`Minimum age must be at least ${USER_CONSTANTS.MIN_AGE}`),

    query("filters.maxAge")
      .optional()
      .isInt({ max: USER_CONSTANTS.MAX_AGE })
      .withMessage(`Maximum age cannot exceed ${USER_CONSTANTS.MAX_AGE}`),

    query("filters.verified")
      .optional()
      .isBoolean()
      .withMessage("Verified filter must be a boolean"),

    query("filters.interests")
      .optional()
      .isArray()
      .withMessage("Interests filter must be an array"),

    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),

    query("limit")
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage("Limit must be between 1 and 50"),
  ],

  /**
   * Get recommendations
   */
  getRecommendations: [
    query("limit")
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage("Limit must be between 1 and 50"),

    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),

    query("includeBoosts")
      .optional()
      .isBoolean()
      .withMessage("Include boosts must be a boolean"),

    query("filters.verified")
      .optional()
      .isBoolean()
      .withMessage("Verified filter must be a boolean"),

    query("filters.hasPhotos")
      .optional()
      .isBoolean()
      .withMessage("Has photos filter must be a boolean"),

    query("filters.interests")
      .optional()
      .isArray()
      .withMessage("Interests filter must be an array"),

    query("filters.lifestyle")
      .optional()
      .isObject()
      .withMessage("Lifestyle filters must be an object"),
  ],
};

/**
 * Account validators
 */
export const accountValidators = {
  /**
   * Delete account
   */
  deleteAccount: [
    body("password")
      .notEmpty()
      .withMessage("Password is required for account deletion"),

    body("reason")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Reason cannot exceed 500 characters")
      .customSanitizer(customValidators.sanitizeInput),
  ],

  /**
   * Restore account
   */
  restoreAccount: [
    body("email")
      .notEmpty()
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),

    body("password").notEmpty().withMessage("Password is required"),
  ],

  /**
   * Pause account
   */
  pauseAccount: [
    body("pause").notEmpty().isBoolean().withMessage("Pause must be a boolean"),
  ],
};

/**
 * Boost validators
 */
export const boostValidators = {
  /**
   * Apply boost
   */
  applyBoost: [
    body("type")
      .optional()
      .isIn(["regular", "super"])
      .withMessage("Invalid boost type"),

    body("duration")
      .optional()
      .isInt({ min: 15, max: 180 })
      .withMessage("Duration must be between 15 and 180 minutes"),
  ],
};

/**
 * Verification validators
 */
export const verificationValidators = {
  /**
   * Verify photo
   */
  verifyPhoto: [
    // File validation is handled by multer middleware
    body("gesture")
      .optional()
      .isIn(["peace", "thumbs_up", "wave"])
      .withMessage("Invalid gesture type"),
  ],

  /**
   * Verify phone
   */
  verifyPhone: [
    body("phoneNumber")
      .notEmpty()
      .matches(REGEX_PATTERNS.PHONE)
      .withMessage("Invalid phone number format"),
  ],

  /**
   * Confirm phone OTP
   */
  confirmPhoneOTP: [
    body("otp")
      .notEmpty()
      .matches(/^\d{6}$/)
      .withMessage("OTP must be 6 digits"),
  ],
};

/**
 * Subscription validators
 */
export const subscriptionValidators = {
  /**
   * Update subscription
   */
  updateSubscription: [
    body("type")
      .notEmpty()
      .isIn(Object.values(SUBSCRIPTION_TYPES))
      .withMessage("Invalid subscription type"),

    body("paymentMethodId")
      .notEmpty()
      .withMessage("Payment method is required"),

    body("duration")
      .optional()
      .isIn(["monthly", "quarterly", "yearly"])
      .withMessage("Invalid subscription duration"),
  ],

  /**
   * Cancel subscription
   */
  cancelSubscription: [
    body("reason")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Reason cannot exceed 500 characters")
      .customSanitizer(customValidators.sanitizeInput),
  ],
};

/**
 * Validation middleware composer
 */
export const validateRequest = (validators) => {
  return [
    ...validators,
    (req, res, next) => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: {
            message: "Validation failed",
            code: "VALIDATION_ERROR",
            errors: errors.array().map((err) => ({
              field: err.param,
              message: err.msg,
              value: err.value,
              location: err.location,
            })),
          },
        });
      }
      next();
    },
  ];
};

// Export all validators
export default {
  profile: profileValidators,
  photo: photoValidators,
  location: locationValidators,
  preferences: preferencesValidators,
  privacy: privacyValidators,
  notification: notificationValidators,
  search: searchValidators,
  account: accountValidators,
  boost: boostValidators,
  verification: verificationValidators,
  subscription: subscriptionValidators,
  validateRequest,
};
