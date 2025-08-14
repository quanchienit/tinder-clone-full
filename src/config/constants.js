// src/config/constants.js

/**
 * HTTP Status Codes
 */
export const HTTP_STATUS = {
  // Success
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,

  // Redirection
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  NOT_MODIFIED: 304,

  // Client Errors
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  UNPROCESSABLE_ENTITY: 422,
  LOCKED: 423,
  TOO_MANY_REQUESTS: 429,

  // Server Errors
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

/**
 * Error Codes
 */
export const ERROR_CODES = {
  // General
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  FORBIDDEN: "FORBIDDEN",
  UNAUTHORIZED: "UNAUTHORIZED",
  BAD_REQUEST: "BAD_REQUEST",
  CONFLICT: "CONFLICT",
  EXPIRED: "EXPIRED",
  TIMEOUT: "TIMEOUT",
  DATABASE_ERROR: "DATABASE_ERROR",

  // Authentication
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  TOKEN_INVALID: "TOKEN_INVALID",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  PHONE_NOT_VERIFIED: "PHONE_NOT_VERIFIED",
  INVALID_OTP: "INVALID_OTP",

  // User
  USER_NOT_FOUND: "USER_NOT_FOUND",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_BANNED: "USER_BANNED",
  USER_INACTIVE: "USER_INACTIVE",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",

  // Limits
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED",

  // Subscription
  SUBSCRIPTION_REQUIRED: "SUBSCRIPTION_REQUIRED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",

  // Media
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  INVALID_FILE_TYPE: "INVALID_FILE_TYPE",
  UPLOAD_FAILED: "UPLOAD_FAILED",

  // Match
  ALREADY_SWIPED: "ALREADY_SWIPED",
  MATCH_NOT_FOUND: "MATCH_NOT_FOUND",
  NOT_MATCHED: "NOT_MATCHED",

  // Chat
  MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
  CANNOT_MESSAGE: "CANNOT_MESSAGE",
  MESSAGE_TOO_LONG: "MESSAGE_TOO_LONG",
};

/**
 * User Constants
 */
export const USER_CONSTANTS = {
  MIN_AGE: 18,
  MAX_AGE: 100,
  MAX_PHOTOS: 9,
  MAX_BIO_LENGTH: 500,
  MAX_INTERESTS: 10,
  MIN_SEARCH_RADIUS: 1, // km
  MAX_SEARCH_RADIUS: 500, // km
  DEFAULT_SEARCH_RADIUS: 50, // km
  DAILY_LIKE_LIMIT: 100, // Free users
  DAILY_SUPER_LIKE_LIMIT: 1, // Free users
  MESSAGE_MAX_LENGTH: 1000,
  MIN_PASSWORD_LENGTH: 8,
  MAX_PASSWORD_LENGTH: 128,
  USERNAME_MIN_LENGTH: 3,
  USERNAME_MAX_LENGTH: 30,
};

/**
 * Gender Options
 */
export const GENDER_OPTIONS = {
  MALE: "male",
  FEMALE: "female",
  NON_BINARY: "non-binary",
  OTHER: "other",
};

/**
 * Sexual Orientation Options
 */
export const SEXUAL_ORIENTATION = {
  STRAIGHT: "straight",
  GAY: "gay",
  LESBIAN: "lesbian",
  BISEXUAL: "bisexual",
  PANSEXUAL: "pansexual",
  ASEXUAL: "asexual",
  DEMISEXUAL: "demisexual",
  QUEER: "queer",
  OTHER: "other",
};

/**
 * Lifestyle Options
 */
export const LIFESTYLE = {
  DRINKING: {
    NEVER: "never",
    SOCIALLY: "socially",
    SOMETIMES: "sometimes",
    FREQUENTLY: "frequently",
    SOBER: "sober",
  },
  SMOKING: {
    NEVER: "never",
    OCCASIONALLY: "occasionally",
    SOCIALLY: "socially",
    REGULARLY: "regularly",
    TRYING_TO_QUIT: "trying_to_quit",
  },
  WORKOUT: {
    NEVER: "never",
    SOMETIMES: "sometimes",
    OFTEN: "often",
    EVERYDAY: "everyday",
  },
  PETS: {
    DOG: "dog",
    CAT: "cat",
    BIRD: "bird",
    FISH: "fish",
    REPTILE: "reptile",
    NONE: "none",
    ALLERGIC: "allergic",
    OTHER: "other",
  },
  CHILDREN: {
    NONE: "none",
    HAVE: "have",
    WANT: "want",
    DONT_WANT: "dont_want",
    NOT_SURE: "not_sure",
  },
  DIET: {
    OMNIVORE: "omnivore",
    VEGETARIAN: "vegetarian",
    VEGAN: "vegan",
    PESCATARIAN: "pescatarian",
    KOSHER: "kosher",
    HALAL: "halal",
    KETO: "keto",
    OTHER: "other",
  },
  ZODIAC: {
    ARIES: "aries",
    TAURUS: "taurus",
    GEMINI: "gemini",
    CANCER: "cancer",
    LEO: "leo",
    VIRGO: "virgo",
    LIBRA: "libra",
    SCORPIO: "scorpio",
    SAGITTARIUS: "sagittarius",
    CAPRICORN: "capricorn",
    AQUARIUS: "aquarius",
    PISCES: "pisces",
  },
  RELIGION: {
    AGNOSTIC: "agnostic",
    ATHEIST: "atheist",
    BUDDHIST: "buddhist",
    CATHOLIC: "catholic",
    CHRISTIAN: "christian",
    HINDU: "hindu",
    JEWISH: "jewish",
    MUSLIM: "muslim",
    SPIRITUAL: "spiritual",
    OTHER: "other",
    PREFER_NOT_TO_SAY: "prefer_not_to_say",
  },
  POLITICS: {
    LIBERAL: "liberal",
    MODERATE: "moderate",
    CONSERVATIVE: "conservative",
    NOT_POLITICAL: "not_political",
    OTHER: "other",
    PREFER_NOT_TO_SAY: "prefer_not_to_say",
  },
};

/**
 * Education Levels
 */
export const EDUCATION_LEVELS = {
  HIGH_SCHOOL: "high_school",
  SOME_COLLEGE: "some_college",
  ASSOCIATES: "associates",
  BACHELORS: "bachelors",
  MASTERS: "masters",
  PHD: "phd",
  TRADE_SCHOOL: "trade_school",
  OTHER: "other",
};

/**
 * Relationship Goals
 */
export const RELATIONSHIP_GOALS = {
  RELATIONSHIP: "relationship",
  SOMETHING_CASUAL: "something_casual",
  DONT_KNOW_YET: "dont_know_yet",
  MARRIAGE: "marriage",
  FRIENDSHIP: "friendship",
};

/**
 * Subscription Types
 */
export const SUBSCRIPTION_TYPES = {
  FREE: "free",
  PLUS: "plus",
  GOLD: "gold",
  PLATINUM: "platinum",
};

/**
 * Subscription Features
 */
export const SUBSCRIPTION_FEATURES = {
  free: {
    unlimitedLikes: false,
    seeWhoLikesYou: false,
    unlimitedRewinds: false,
    passport: false,
    noAds: false,
    superLikesPerDay: 1,
    boostsPerMonth: 0,
    messageBeforeMatch: false,
    priorityLikes: false,
    topPicks: 0,
  },
  plus: {
    unlimitedLikes: true,
    seeWhoLikesYou: false,
    unlimitedRewinds: true,
    passport: false,
    noAds: true,
    superLikesPerDay: 5,
    boostsPerMonth: 1,
    messageBeforeMatch: false,
    priorityLikes: false,
    topPicks: 0,
  },
  gold: {
    unlimitedLikes: true,
    seeWhoLikesYou: true,
    unlimitedRewinds: true,
    passport: true,
    noAds: true,
    superLikesPerDay: 5,
    boostsPerMonth: 1,
    messageBeforeMatch: false,
    priorityLikes: true,
    topPicks: 10,
  },
  platinum: {
    unlimitedLikes: true,
    seeWhoLikesYou: true,
    unlimitedRewinds: true,
    passport: true,
    noAds: true,
    superLikesPerDay: -1, // Unlimited
    boostsPerMonth: -1, // Unlimited
    messageBeforeMatch: true,
    priorityLikes: true,
    topPicks: -1, // Unlimited
  },
};

/**
 * Subscription Pricing (in cents)
 */
export const SUBSCRIPTION_PRICING = {
  plus: {
    monthly: 999, // $9.99
    quarterly: 2397, // $23.97 ($7.99/month)
    yearly: 7188, // $71.88 ($5.99/month)
  },
  gold: {
    monthly: 2499, // $24.99
    quarterly: 5997, // $59.97 ($19.99/month)
    yearly: 14388, // $143.88 ($11.99/month)
  },
  platinum: {
    monthly: 3999, // $39.99
    quarterly: 9597, // $95.97 ($31.99/month)
    yearly: 23988, // $239.88 ($19.99/month)
  },
};

/**
 * Swipe Actions
 */
export const SWIPE_ACTIONS = {
  LIKE: "like",
  NOPE: "nope",
  SUPER_LIKE: "superlike",
};

/**
 * Match Status
 */
export const MATCH_STATUS = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  BLOCKED: "blocked",
  DELETED: "deleted",
};

/**
 * Message Types
 */
export const MESSAGE_TYPES = {
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  GIF: "gif",
  LOCATION: "location",
  SPOTIFY: "spotify",
  INSTAGRAM: "instagram",
};

/**
 * Message Status
 */
export const MESSAGE_STATUS = {
  SENDING: "sending",
  SENT: "sent",
  DELIVERED: "delivered",
  READ: "read",
  FAILED: "failed",
};

/**
 * Report Reasons
 */
export const REPORT_REASONS = {
  FAKE_PROFILE: "fake_profile",
  INAPPROPRIATE_CONTENT: "inappropriate_content",
  HARASSMENT: "harassment",
  SPAM: "spam",
  UNDERAGE: "underage",
  OFFLINE_BEHAVIOR: "offline_behavior",
  SCAM: "scam",
  OTHER: "other",
};

/**
 * Notification Types
 */
export const NOTIFICATION_TYPES = {
  NEW_MATCH: "new_match",
  NEW_MESSAGE: "new_message",
  SUPER_LIKE: "super_like",
  PROFILE_LIKED: "profile_liked",
  BOOST_ACTIVATED: "boost_activated",
  SUBSCRIPTION_EXPIRING: "subscription_expiring",
  PHOTO_VERIFIED: "photo_verified",
  SYSTEM: "system",
  PROMOTION: "promotion",
};

/**
 * Cache TTL (in seconds)
 */
export const CACHE_TTL = {
  USER_PROFILE: 300, // 5 minutes
  RECOMMENDATIONS: 1800, // 30 minutes
  MATCHES: 600, // 10 minutes
  MESSAGES: 60, // 1 minute
  SEARCH_RESULTS: 300, // 5 minutes
  STATS: 3600, // 1 hour
  SUBSCRIPTION: 3600, // 1 hour
};

/**
 * Rate Limits
 */
export const RATE_LIMITS = {
  API_REQUESTS: 100, // per minute
  LOGIN_ATTEMPTS: 5, // per 15 minutes
  REGISTER_ATTEMPTS: 3, // per hour
  PASSWORD_RESET: 3, // per hour
  MESSAGE_SEND: 30, // per minute
  SWIPE_ACTIONS: 100, // per hour
  PHOTO_UPLOAD: 20, // per hour
  REPORT_USER: 5, // per day
};

/**
 * Redis Key Prefixes
 */
export const REDIS_KEYS = {
  USER_SESSION: "session:",
  USER_PROFILE: "user:profile:",
  USER_RECOMMENDATIONS: "user:recommendations:",
  USER_MATCHES: "user:matches:",
  USER_ACTIVITY: "user:activity:",
  USER_ONLINE: "users:online",
  RATE_LIMIT: "ratelimit:",
  CACHE: "cache:",
  QUEUE: "queue:",
  LOCK: "lock:",
  TEMP: "temp:",
  VERIFICATION: "verification:",
  OTP: "otp:",
  TOKEN_BLACKLIST: "blacklist:token:",
  METRICS: "metrics:",
};

/**
 * Socket Events
 */
export const SOCKET_EVENTS = {
  // Connection
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  ERROR: "error",

  // User Status
  USER_ONLINE: "user:online",
  USER_OFFLINE: "user:offline",
  USER_STATUS_CHANGED: "user:status:changed",

  // Matching
  NEW_MATCH: "match:new",
  MATCH_REMOVED: "match:removed",

  // Messaging
  MESSAGE_SEND: "message:send",
  MESSAGE_RECEIVE: "message:receive",
  MESSAGE_DELIVERED: "message:delivered",
  MESSAGE_READ: "message:read",
  MESSAGE_DELETED: "message:deleted",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",

  // Notifications
  NOTIFICATION_NEW: "notification:new",
  NOTIFICATION_READ: "notification:read",
  NOTIFICATION_UNREAD: "notification:unread",

  // Real-time Updates
  PROFILE_UPDATE: "profile:update",
  BOOST_ACTIVATED: "boost:activated",
  SUPER_LIKE_RECEIVED: "superlike:received",
};

/**
 * Regex Patterns
 */
export const REGEX_PATTERNS = {
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  PHONE: /^\+?[1-9]\d{1,14}$/,
  USERNAME: /^[a-zA-Z0-9_-]{3,30}$/,
  PASSWORD:
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/,
  URL: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
  ALPHANUMERIC: /^[a-zA-Z0-9]+$/,
  NUMERIC: /^\d+$/,
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  MONGODB_ID: /^[0-9a-fA-F]{24}$/,
};

/**
 * File Upload Limits
 */
export const FILE_UPLOAD = {
  MAX_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/jpg", "image/png", "image/webp"],
  ALLOWED_VIDEO_TYPES: ["video/mp4", "video/mpeg", "video/quicktime"],
  MAX_VIDEO_SIZE: 50 * 1024 * 1024, // 50MB
  MAX_PHOTOS: 9,
  MIN_IMAGE_WIDTH: 200,
  MIN_IMAGE_HEIGHT: 200,
  MAX_IMAGE_WIDTH: 4096,
  MAX_IMAGE_HEIGHT: 4096,
};

/**
 * Pagination Defaults
 */
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
};

/**
 * Time Constants (in milliseconds)
 */
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
  WEEK: 7 * 24 * 60 * 60 * 1000,
  MONTH: 30 * 24 * 60 * 60 * 1000,
  YEAR: 365 * 24 * 60 * 60 * 1000,
};

/**
 * Default Values
 */
export const DEFAULTS = {
  ELO_SCORE: 1500,
  ACTIVITY_SCORE: 1.0,
  PROFILE_COMPLETENESS: 0,
  SEARCH_RADIUS: 50,
  AGE_RANGE: { min: 18, max: 50 },
  LANGUAGE: "en",
  CURRENCY: "USD",
  TIMEZONE: "UTC",
};

/**
 * Admin Roles
 */
export const ROLES = {
  USER: "user",
  MODERATOR: "moderator",
  ADMIN: "admin",
  SUPER_ADMIN: "superadmin",
};

/**
 * Environment Variables
 */
export const ENV = {
  DEVELOPMENT: "development",
  STAGING: "staging",
  PRODUCTION: "production",
  TEST: "test",
};

/**
 * API Versions
 */
export const API_VERSIONS = {
  V1: "v1",
  V2: "v2",
};

/**
 * Export all constants
 */
export default {
  HTTP_STATUS,
  ERROR_CODES,
  USER_CONSTANTS,
  GENDER_OPTIONS,
  SEXUAL_ORIENTATION,
  LIFESTYLE,
  EDUCATION_LEVELS,
  RELATIONSHIP_GOALS,
  SUBSCRIPTION_TYPES,
  SUBSCRIPTION_FEATURES,
  SUBSCRIPTION_PRICING,
  SWIPE_ACTIONS,
  MATCH_STATUS,
  MESSAGE_TYPES,
  MESSAGE_STATUS,
  REPORT_REASONS,
  NOTIFICATION_TYPES,
  CACHE_TTL,
  RATE_LIMITS,
  REDIS_KEYS,
  SOCKET_EVENTS,
  REGEX_PATTERNS,
  FILE_UPLOAD,
  PAGINATION,
  TIME,
  DEFAULTS,
  ROLES,
  ENV,
  API_VERSIONS,
};
