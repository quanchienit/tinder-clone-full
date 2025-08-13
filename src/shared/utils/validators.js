// src/shared/utils/validators.js
import { body, param, query, check } from 'express-validator';
import { 
  REGEX_PATTERNS, 
  USER_CONSTANTS,
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION,
  LIFESTYLE,
  SWIPE_ACTIONS,
  MESSAGE_TYPES,
  REPORT_REASONS
} from '../../config/constants.js';

/**
 * Auth validators
 */
export const authValidators = {
  register: [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
    
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password must contain uppercase, lowercase, and numbers'),
    
    body('profile.firstName')
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage('First name is required'),
    
    body('profile.dateOfBirth')
      .isISO8601()
      .withMessage('Valid date of birth is required')
      .custom((value) => {
        const age = Math.floor((Date.now() - new Date(value)) / 31557600000);
        if (age < USER_CONSTANTS.MIN_AGE) {
          throw new Error(`You must be at least ${USER_CONSTANTS.MIN_AGE} years old`);
        }
        if (age > USER_CONSTANTS.MAX_AGE) {
          throw new Error('Invalid age');
        }
        return true;
      }),
    
    body('profile.gender')
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage('Valid gender is required'),
  ],

  login: [
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
    
    body('phoneNumber')
      .optional()
      .matches(REGEX_PATTERNS.PHONE)
      .withMessage('Valid phone number is required'),
    
    body('password')
      .notEmpty()
      .withMessage('Password is required'),
    
    check()
      .custom((value, { req }) => {
        if (!req.body.email && !req.body.phoneNumber) {
          throw new Error('Email or phone number is required');
        }
        return true;
      }),
  ],

  forgotPassword: [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
  ],

  resetPassword: [
    param('token')
      .notEmpty()
      .withMessage('Reset token is required'),
    
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password must contain uppercase, lowercase, and numbers'),
  ],

  verifyEmail: [
    param('token')
      .notEmpty()
      .withMessage('Verification token is required'),
  ],

  changePassword: [
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required'),
    
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
      .withMessage('Password must contain uppercase, lowercase, and numbers')
      .custom((value, { req }) => value !== req.body.currentPassword)
      .withMessage('New password must be different from current password'),
  ],
};

/**
 * User validators
 */
export const userValidators = {
  updateProfile: [
    body('profile.firstName')
      .optional()
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage('First name must be between 1 and 50 characters'),
    
    body('profile.bio')
      .optional()
      .trim()
      .isLength({ max: USER_CONSTANTS.MAX_BIO_LENGTH })
      .withMessage(`Bio must not exceed ${USER_CONSTANTS.MAX_BIO_LENGTH} characters`),
    
    body('profile.gender')
      .optional()
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage('Invalid gender'),
    
    body('profile.sexualOrientation')
      .optional()
      .isArray()
      .withMessage('Sexual orientation must be an array'),
    
    body('profile.sexualOrientation.*')
      .isIn(Object.values(SEXUAL_ORIENTATION))
      .withMessage('Invalid sexual orientation'),
    
    body('profile.interests')
      .optional()
      .isArray({ max: USER_CONSTANTS.MAX_INTERESTS })
      .withMessage(`Maximum ${USER_CONSTANTS.MAX_INTERESTS} interests allowed`),
    
    body('profile.height')
      .optional()
      .isInt({ min: 100, max: 250 })
      .withMessage('Height must be between 100 and 250 cm'),
    
    body('profile.lifestyle.drinking')
      .optional()
      .isIn(Object.values(LIFESTYLE.DRINKING))
      .withMessage('Invalid drinking preference'),
    
    body('profile.lifestyle.smoking')
      .optional()
      .isIn(Object.values(LIFESTYLE.SMOKING))
      .withMessage('Invalid smoking preference'),
    
    body('profile.lifestyle.workout')
      .optional()
      .isIn(Object.values(LIFESTYLE.WORKOUT))
      .withMessage('Invalid workout preference'),
  ],

  updateLocation: [
    body('latitude')
      .isFloat({ min: -90, max: 90 })
      .withMessage('Invalid latitude'),
    
    body('longitude')
      .isFloat({ min: -180, max: 180 })
      .withMessage('Invalid longitude'),
  ],

  updatePreferences: [
    body('ageRange.min')
      .optional()
      .isInt({ min: USER_CONSTANTS.MIN_AGE })
      .withMessage(`Minimum age must be at least ${USER_CONSTANTS.MIN_AGE}`),
    
    body('ageRange.max')
      .optional()
      .isInt({ max: USER_CONSTANTS.MAX_AGE })
      .withMessage(`Maximum age cannot exceed ${USER_CONSTANTS.MAX_AGE}`)
      .custom((value, { req }) => {
        if (req.body.ageRange?.min && value < req.body.ageRange.min) {
          throw new Error('Maximum age must be greater than minimum age');
        }
        return true;
      }),
    
    body('maxDistance')
      .optional()
      .isInt({ min: USER_CONSTANTS.MIN_SEARCH_RADIUS, max: USER_CONSTANTS.MAX_SEARCH_RADIUS })
      .withMessage(`Distance must be between ${USER_CONSTANTS.MIN_SEARCH_RADIUS} and ${USER_CONSTANTS.MAX_SEARCH_RADIUS} km`),
    
    body('genderPreference')
      .optional()
      .isArray()
      .withMessage('Gender preference must be an array'),
    
    body('genderPreference.*')
      .isIn(Object.values(GENDER_OPTIONS))
      .withMessage('Invalid gender preference'),
  ],

  getProfile: [
    param('userId')
      .isMongoId()
      .withMessage('Invalid user ID'),
  ],
};

/**
 * Swipe validators
 */
export const swipeValidators = {
  swipe: [
    body('targetUserId')
      .isMongoId()
      .withMessage('Invalid target user ID'),
    
    body('action')
      .isIn(Object.values(SWIPE_ACTIONS))
      .withMessage('Invalid swipe action'),
    
    body('photoIndex')
      .optional()
      .isInt({ min: 0, max: USER_CONSTANTS.MAX_PHOTOS - 1 })
      .withMessage('Invalid photo index'),
  ],

  undoSwipe: [
    body('swipeId')
      .optional()
      .isMongoId()
      .withMessage('Invalid swipe ID'),
  ],
};

/**
 * Match validators
 */
export const matchValidators = {
  getMatches: [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    
    query('sort')
      .optional()
      .isIn(['matchedAt', 'lastMessage', '-matchedAt', '-lastMessage'])
      .withMessage('Invalid sort field'),
  ],

  unmatch: [
    param('matchId')
      .isMongoId()
      .withMessage('Invalid match ID'),
    
    body('reason')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Reason must not exceed 500 characters'),
  ],
};

/**
 * Message validators
 */
export const messageValidators = {
  sendMessage: [
    param('matchId')
      .isMongoId()
      .withMessage('Invalid match ID'),
    
    body('type')
      .isIn(Object.values(MESSAGE_TYPES))
      .withMessage('Invalid message type'),
    
    body('text')
      .if(body('type').equals(MESSAGE_TYPES.TEXT))
      .trim()
      .isLength({ min: 1, max: 1000 })
      .withMessage('Text message must be between 1 and 1000 characters'),
    
    body('mediaUrl')
      .if(body('type').isIn([MESSAGE_TYPES.IMAGE, MESSAGE_TYPES.VIDEO, MESSAGE_TYPES.AUDIO]))
      .isURL()
      .withMessage('Valid media URL is required'),
    
    body('location')
      .if(body('type').equals(MESSAGE_TYPES.LOCATION))
      .isObject()
      .withMessage('Location object is required'),
    
    body('location.latitude')
      .if(body('type').equals(MESSAGE_TYPES.LOCATION))
      .isFloat({ min: -90, max: 90 })
      .withMessage('Invalid latitude'),
    
    body('location.longitude')
      .if(body('type').equals(MESSAGE_TYPES.LOCATION))
      .isFloat({ min: -180, max: 180 })
      .withMessage('Invalid longitude'),
  ],

  getMessages: [
    param('matchId')
      .isMongoId()
      .withMessage('Invalid match ID'),
    
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    
    query('before')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
  ],

  deleteMessage: [
    param('messageId')
      .isMongoId()
      .withMessage('Invalid message ID'),
  ],

  editMessage: [
    param('messageId')
      .isMongoId()
      .withMessage('Invalid message ID'),
    
    body('text')
      .trim()
      .isLength({ min: 1, max: 1000 })
      .withMessage('Text must be between 1 and 1000 characters'),
  ],
};

/**
 * Report validators
 */
export const reportValidators = {
  reportUser: [
    body('reportedUserId')
      .isMongoId()
      .withMessage('Invalid user ID'),
    
    body('reason')
      .isIn(Object.values(REPORT_REASONS))
      .withMessage('Invalid report reason'),
    
    body('description')
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Description must not exceed 1000 characters'),
    
    body('evidence')
      .optional()
      .isArray({ max: 5 })
      .withMessage('Maximum 5 evidence items allowed'),
    
    body('evidence.*')
      .isURL()
      .withMessage('Evidence must be valid URLs'),
  ],

  reportMessage: [
    body('messageId')
      .isMongoId()
      .withMessage('Invalid message ID'),
    
    body('reason')
      .isIn(Object.values(REPORT_REASONS))
      .withMessage('Invalid report reason'),
  ],
};

/**
 * Photo validators
 */
export const photoValidators = {
  uploadPhoto: [
    body('order')
      .optional()
      .isInt({ min: 0, max: USER_CONSTANTS.MAX_PHOTOS - 1 })
      .withMessage(`Photo order must be between 0 and ${USER_CONSTANTS.MAX_PHOTOS - 1}`),
    
    body('isMain')
      .optional()
      .isBoolean()
      .withMessage('isMain must be a boolean'),
  ],

  reorderPhotos: [
    body('photoIds')
      .isArray({ min: 1, max: USER_CONSTANTS.MAX_PHOTOS })
      .withMessage(`Must provide between 1 and ${USER_CONSTANTS.MAX_PHOTOS} photo IDs`),
    
    body('photoIds.*')
      .isMongoId()
      .withMessage('Invalid photo ID'),
  ],

  deletePhoto: [
    param('photoId')
      .isMongoId()
      .withMessage('Invalid photo ID'),
  ],
};

/**
 * Subscription validators
 */
export const subscriptionValidators = {
  subscribe: [
    body('plan')
      .isIn(['plus', 'gold', 'platinum'])
      .withMessage('Invalid subscription plan'),
    
    body('duration')
      .isIn(['monthly', 'quarterly', 'yearly'])
      .withMessage('Invalid subscription duration'),
    
    body('paymentMethodId')
      .notEmpty()
      .withMessage('Payment method is required'),
  ],

  cancelSubscription: [
    body('reason')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Reason must not exceed 500 characters'),
  ],
};

/**
 * Notification validators
 */
export const notificationValidators = {
  updatePreferences: [
    body('push')
      .optional()
      .isBoolean()
      .withMessage('Push preference must be a boolean'),
    
    body('email')
      .optional()
      .isBoolean()
      .withMessage('Email preference must be a boolean'),
    
    body('sms')
      .optional()
      .isBoolean()
      .withMessage('SMS preference must be a boolean'),
    
    body('newMatch')
      .optional()
      .isBoolean()
      .withMessage('New match preference must be a boolean'),
    
    body('newMessage')
      .optional()
      .isBoolean()
      .withMessage('New message preference must be a boolean'),
  ],

  registerToken: [
    body('token')
      .notEmpty()
      .withMessage('FCM token is required'),
    
    body('platform')
      .isIn(['ios', 'android', 'web'])
      .withMessage('Invalid platform'),
  ],
};

/**
 * Search validators
 */
export const searchValidators = {
  searchUsers: [
    query('q')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Search query must be between 2 and 100 characters'),
    
    query('filters.ageMin')
      .optional()
      .isInt({ min: USER_CONSTANTS.MIN_AGE })
      .withMessage(`Minimum age must be at least ${USER_CONSTANTS.MIN_AGE}`),
    
    query('filters.ageMax')
      .optional()
      .isInt({ max: USER_CONSTANTS.MAX_AGE })
      .withMessage(`Maximum age cannot exceed ${USER_CONSTANTS.MAX_AGE}`),
    
    query('filters.distance')
      .optional()
      .isInt({ min: 1, max: USER_CONSTANTS.MAX_SEARCH_RADIUS })
      .withMessage(`Distance must be between 1 and ${USER_CONSTANTS.MAX_SEARCH_RADIUS} km`),
    
    query('filters.hasPhoto')
      .optional()
      .isBoolean()
      .withMessage('hasPhoto must be a boolean'),
    
    query('filters.isVerified')
      .optional()
      .isBoolean()
      .withMessage('isVerified must be a boolean'),
  ],
};

/**
 * Admin validators
 */
export const adminValidators = {
  banUser: [
    param('userId')
      .isMongoId()
      .withMessage('Invalid user ID'),
    
    body('reason')
      .trim()
      .isLength({ min: 10, max: 1000 })
      .withMessage('Ban reason must be between 10 and 1000 characters'),
    
    body('duration')
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage('Ban duration must be between 1 and 365 days'),
  ],

  verifyPhoto: [
    param('photoId')
      .isMongoId()
      .withMessage('Invalid photo ID'),
    
    body('status')
      .isIn(['approved', 'rejected'])
      .withMessage('Status must be approved or rejected'),
    
    body('reason')
      .if(body('status').equals('rejected'))
      .trim()
      .isLength({ min: 10, max: 500 })
      .withMessage('Rejection reason must be between 10 and 500 characters'),
  ],

  handleReport: [
    param('reportId')
      .isMongoId()
      .withMessage('Invalid report ID'),
    
    body('action')
      .isIn(['dismiss', 'warning', 'ban', 'delete'])
      .withMessage('Invalid action'),
    
    body('notes')
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage('Notes must not exceed 1000 characters'),
  ],
};

/**
 * Custom validators
 */
export const customValidators = {
  isValidAge: (value) => {
    const age = Math.floor((Date.now() - new Date(value)) / 31557600000);
    return age >= USER_CONSTANTS.MIN_AGE && age <= USER_CONSTANTS.MAX_AGE;
  },

  isValidCoordinates: (lat, lng) => {
    return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  },

  isStrongPassword: (password) => {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/.test(password);
  },

  isValidUsername: (username) => {
    return /^[a-zA-Z0-9_-]{3,30}$/.test(username);
  },

  isValidUrl: (url) => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  },

  sanitizeInput: (input) => {
    if (typeof input !== 'string') return input;
    
    return input
      .replace(/[<>]/g, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();
  },

  normalizeEmail: (email) => {
    return email.toLowerCase().trim();
  },

  normalizePhone: (phone) => {
    return phone.replace(/[\s\-\(\)]/g, '');
  },
};