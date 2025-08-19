// src/modules/payment/payment.constants.js

/**
 * Payment Module Constants
 * Central configuration for all payment-related constants
 */

// ========================
// SUBSCRIPTION TIERS
// ========================
export const SUBSCRIPTION_TIERS = {
  FREE: 'free',
  PLUS: 'plus',
  GOLD: 'gold',
  PLATINUM: 'platinum',
};

// ========================
// SUBSCRIPTION STATUS
// ========================
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  TRIALING: 'trialing',
  PAST_DUE: 'past_due',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  PAUSED: 'paused',
  INCOMPLETE: 'incomplete',
  INCOMPLETE_EXPIRED: 'incomplete_expired',
  UNPAID: 'unpaid',
};

// ========================
// BILLING CYCLES
// ========================
export const BILLING_CYCLES = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
  LIFETIME: 'lifetime', // One-time payment
};

// ========================
// PAYMENT PROVIDERS
// ========================
export const PAYMENT_PROVIDERS = {
  GOOGLE: 'google',
  APPLE: 'apple',
};

// ========================
// PAYMENT METHODS
// ========================
export const PAYMENT_METHODS = {
  APPLE_PAY: 'apple_pay',
  GOOGLE_PAY: 'google_pay',
  IN_APP_PURCHASE: 'in_app_purchase',
};

// ========================
// TRANSACTION TYPES
// ========================
export const TRANSACTION_TYPES = {
  SUBSCRIPTION: 'subscription',
  ONE_TIME: 'one_time',
  REFUND: 'refund',
  CHARGEBACK: 'chargeback',
  ADJUSTMENT: 'adjustment',
  CREDIT: 'credit',
  DEBIT: 'debit',
  PURCHASE: 'purchase', // In-app purchases
  RENEWAL: 'renewal',
  UPGRADE: 'upgrade',
  DOWNGRADE: 'downgrade',
};

// ========================
// TRANSACTION STATUS
// ========================
export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  DISPUTED: 'disputed',
  EXPIRED: 'expired',
};

// ========================
// SUBSCRIPTION FEATURES
// ========================
export const SUBSCRIPTION_FEATURES_CONFIG = {
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
    readReceipts: false,
    advancedFilters: false,
    hideAge: false,
    hideDistance: false,
    controlProfile: false,
    controlWhoSeesYou: false,
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
    readReceipts: false,
    advancedFilters: true,
    hideAge: true,
    hideDistance: true,
    controlProfile: false,
    controlWhoSeesYou: false,
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
    readReceipts: true,
    advancedFilters: true,
    hideAge: true,
    hideDistance: true,
    controlProfile: true,
    controlWhoSeesYou: true,
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
    readReceipts: true,
    advancedFilters: true,
    hideAge: true,
    hideDistance: true,
    controlProfile: true,
    controlWhoSeesYou: true,
    priorityMessageResponse: true,
    exclusiveStickers: true,
    profileBoost: true,
  },
};

// ========================
// PRICING CONFIGURATION (in cents)
// ========================
export const SUBSCRIPTION_PRICING = {
  plus: {
    monthly: {
      amount: 999, // $9.99
      currency: 'USD',
      interval: 'month',
      intervalCount: 1,
      trialDays: 7,
    },
    quarterly: {
      amount: 2397, // $23.97 ($7.99/month)
      currency: 'USD',
      interval: 'month',
      intervalCount: 3,
      trialDays: 7,
      savings: 25, // 25% savings
    },
    yearly: {
      amount: 7188, // $71.88 ($5.99/month)
      currency: 'USD',
      interval: 'year',
      intervalCount: 1,
      trialDays: 14,
      savings: 40, // 40% savings
    },
  },
  gold: {
    monthly: {
      amount: 2499, // $24.99
      currency: 'USD',
      interval: 'month',
      intervalCount: 1,
      trialDays: 7,
    },
    quarterly: {
      amount: 5997, // $59.97 ($19.99/month)
      currency: 'USD',
      interval: 'month',
      intervalCount: 3,
      trialDays: 7,
      savings: 20, // 20% savings
    },
    yearly: {
      amount: 14388, // $143.88 ($11.99/month)
      currency: 'USD',
      interval: 'year',
      intervalCount: 1,
      trialDays: 14,
      savings: 52, // 52% savings
    },
  },
  platinum: {
    monthly: {
      amount: 3999, // $39.99
      currency: 'USD',
      interval: 'month',
      intervalCount: 1,
      trialDays: 7,
    },
    quarterly: {
      amount: 9597, // $95.97 ($31.99/month)
      currency: 'USD',
      interval: 'month',
      intervalCount: 3,
      trialDays: 7,
      savings: 20, // 20% savings
    },
    yearly: {
      amount: 23988, // $239.88 ($19.99/month)
      currency: 'USD',
      interval: 'year',
      intervalCount: 1,
      trialDays: 14,
      savings: 50, // 50% savings
    },
  },
};

// ========================
// ONE-TIME PURCHASES (in cents)
// ========================
export const ONE_TIME_PURCHASES = {
  superLikes: {
    pack5: {
      amount: 499, // $4.99
      quantity: 5,
      unitPrice: 100, // $1.00 per super like
    },
    pack10: {
      amount: 899, // $8.99
      quantity: 10,
      unitPrice: 90, // $0.90 per super like
      savings: 10,
    },
    pack25: {
      amount: 1999, // $19.99
      quantity: 25,
      unitPrice: 80, // $0.80 per super like
      savings: 20,
    },
  },
  boosts: {
    single: {
      amount: 399, // $3.99
      duration: 30, // 30 minutes
      quantity: 1,
    },
    pack5: {
      amount: 1599, // $15.99
      quantity: 5,
      unitPrice: 320, // $3.20 per boost
      savings: 20,
    },
    pack10: {
      amount: 2499, // $24.99
      quantity: 10,
      unitPrice: 250, // $2.50 per boost
      savings: 37,
    },
  },
  readReceipts: {
    pack10: {
      amount: 199, // $1.99
      quantity: 10,
    },
    pack20: {
      amount: 299, // $2.99
      quantity: 20,
      savings: 25,
    },
  },
};

// ========================
// GOOGLE PLAY CONFIGURATION
// ========================
export const GOOGLE_PLAY_CONFIG = {
  PACKAGE_NAME: process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.yourapp.tinder',
  
  // Product IDs (must match Google Play Console)
  PRODUCT_IDS: {
    PLUS_MONTHLY: 'plus_monthly',
    PLUS_QUARTERLY: 'plus_quarterly',
    PLUS_YEARLY: 'plus_yearly',
    GOLD_MONTHLY: 'gold_monthly',
    GOLD_QUARTERLY: 'gold_quarterly',
    GOLD_YEARLY: 'gold_yearly',
    PLATINUM_MONTHLY: 'platinum_monthly',
    PLATINUM_QUARTERLY: 'platinum_quarterly',
    PLATINUM_YEARLY: 'platinum_yearly',
    SUPER_LIKES_5: 'super_likes_5',
    SUPER_LIKES_10: 'super_likes_10',
    SUPER_LIKES_25: 'super_likes_25',
    BOOST_1: 'boost_1',
    BOOST_5: 'boost_5',
    BOOST_10: 'boost_10',
  },
  
  // Notification types
  NOTIFICATION_TYPES: {
    RECOVERED: 1,
    RENEWED: 2,
    CANCELLED: 3,
    PURCHASED: 4,
    ON_HOLD: 5,
    IN_GRACE_PERIOD: 6,
    RESTARTED: 7,
    PRICE_CHANGE_CONFIRMED: 8,
    DEFERRED: 9,
    PAUSED: 10,
    PAUSE_SCHEDULE_CHANGED: 11,
    REVOKED: 12,
    EXPIRED: 13,
  },
  
  // Purchase states
  PURCHASE_STATES: {
    PURCHASED: 0,
    CANCELLED: 1,
    PENDING: 2,
  },
};

// ========================
// APPLE IAP CONFIGURATION
// ========================
export const APPLE_IAP_CONFIG = {
  BUNDLE_ID: process.env.APPLE_BUNDLE_ID || 'com.yourapp.tinder',
  ENVIRONMENT: process.env.APPLE_ENVIRONMENT || 'sandbox', // 'sandbox' or 'production'
  
  // Product IDs (must match App Store Connect)
  PRODUCT_IDS: {
    PLUS_MONTHLY: 'com.tinder.plus.monthly',
    PLUS_QUARTERLY: 'com.tinder.plus.quarterly',
    PLUS_YEARLY: 'com.tinder.plus.yearly',
    GOLD_MONTHLY: 'com.tinder.gold.monthly',
    GOLD_QUARTERLY: 'com.tinder.gold.quarterly',
    GOLD_YEARLY: 'com.tinder.gold.yearly',
    PLATINUM_MONTHLY: 'com.tinder.platinum.monthly',
    PLATINUM_QUARTERLY: 'com.tinder.platinum.quarterly',
    PLATINUM_YEARLY: 'com.tinder.platinum.yearly',
    SUPER_LIKES_5: 'com.tinder.superlikes.5',
    SUPER_LIKES_10: 'com.tinder.superlikes.10',
    SUPER_LIKES_25: 'com.tinder.superlikes.25',
    BOOST_1: 'com.tinder.boost.1',
    BOOST_5: 'com.tinder.boost.5',
    BOOST_10: 'com.tinder.boost.10',
  },
  
  // Notification types (v2)
  NOTIFICATION_TYPES_V2: {
    SUBSCRIBED: 'SUBSCRIBED',
    DID_CHANGE_RENEWAL_PREF: 'DID_CHANGE_RENEWAL_PREF',
    DID_CHANGE_RENEWAL_STATUS: 'DID_CHANGE_RENEWAL_STATUS',
    OFFER_REDEEMED: 'OFFER_REDEEMED',
    DID_RENEW: 'DID_RENEW',
    EXPIRED: 'EXPIRED',
    GRACE_PERIOD_EXPIRED: 'GRACE_PERIOD_EXPIRED',
    PRICE_INCREASE: 'PRICE_INCREASE',
    REFUND: 'REFUND',
    REFUND_DECLINED: 'REFUND_DECLINED',
    CONSUMPTION_REQUEST: 'CONSUMPTION_REQUEST',
    RENEWAL_EXTENDED: 'RENEWAL_EXTENDED',
    REVOKE: 'REVOKE',
    TEST: 'TEST',
    RENEWAL_EXTENSION: 'RENEWAL_EXTENSION',
    REFUND_REVERSED: 'REFUND_REVERSED',
    EXTERNAL_PURCHASE_TOKEN: 'EXTERNAL_PURCHASE_TOKEN',
  },
  
  // Verify receipt URLs
  VERIFY_URLS: {
    PRODUCTION: 'https://buy.itunes.apple.com/verifyReceipt',
    SANDBOX: 'https://sandbox.itunes.apple.com/verifyReceipt',
  },
  
  // Status codes
  STATUS_CODES: {
    SUCCESS: 0,
    INVALID_JSON: 21000,
    INVALID_RECEIPT_DATA: 21002,
    RECEIPT_AUTHENTICATION_FAILED: 21003,
    SHARED_SECRET_MISMATCH: 21004,
    RECEIPT_SERVER_UNAVAILABLE: 21005,
    SUBSCRIPTION_EXPIRED: 21006,
    SANDBOX_RECEIPT_ON_PRODUCTION: 21007,
    PRODUCTION_RECEIPT_ON_SANDBOX: 21008,
    INTERNAL_DATA_ACCESS_ERROR: 21009,
    ACCOUNT_NOT_FOUND: 21010,
  },
};

// ========================
// PAYMENT VALIDATION RULES
// ========================
export const PAYMENT_VALIDATION = {
  MIN_AMOUNT: 99,      // $0.99 minimum for app stores
  MAX_AMOUNT: 99999,   // $999.99 maximum
  
  // Remove CARD section completely
  
  RECEIPT: {
    MAX_SIZE: 1024 * 1024, // 1MB max receipt size
    ENCODING: 'base64',
  },
  
  PURCHASE_TOKEN: {
    MIN_LENGTH: 20,
    MAX_LENGTH: 1000,
  },
  
  PROMO_CODE: {
    MIN_LENGTH: 4,
    MAX_LENGTH: 20,
    PATTERN: /^[A-Z0-9_-]+$/i,
  },
  
  CURRENCY_CODES: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'INR'],
};


// ========================
// GRACE PERIOD CONFIGURATION
// ========================
export const GRACE_PERIOD_CONFIG = {
  DURATION_DAYS: 7, // Default grace period
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_INTERVALS: [1, 3, 5], // Days between retries
  
  REASONS: {
    PAYMENT_FAILED: 'payment_failed',
    BILLING_RETRY: 'billing_retry',
    ACCOUNT_HOLD: 'account_hold',
    BANK_DECLINE: 'bank_decline',
    CARD_EXPIRED: 'card_expired',
  },
};

// ========================
// REFUND CONFIGURATION
// ========================
export const REFUND_CONFIG = {
  REASONS: {
    DUPLICATE: 'duplicate',
    FRAUDULENT: 'fraudulent',
    REQUESTED_BY_CUSTOMER: 'requested_by_customer',
    NOT_AS_DESCRIBED: 'not_as_described',
    ACCIDENTAL_PURCHASE: 'accidental_purchase',
    CANCELLATION_WITHIN_TRIAL: 'cancellation_within_trial',
    SERVICE_ISSUE: 'service_issue',
    OTHER: 'other',
  },
  
  MAX_REFUND_PERIOD_DAYS: 30,
  PARTIAL_REFUND_ALLOWED: true,
  AUTO_REFUND_TRIAL_CANCELLATION: true,
  
  STATUS: {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    PROCESSED: 'processed',
    FAILED: 'failed',
  },
};

// ========================
// TRIAL CONFIGURATION
// ========================
export const TRIAL_CONFIG = {
  DEFAULT_DURATION_DAYS: 7,
  MAX_DURATION_DAYS: 30,
  
  ELIGIBILITY: {
    NEW_USERS_ONLY: true,
    ONE_PER_USER: true,
    REQUIRE_PAYMENT_METHOD: true,
  },
  
  REMINDER_DAYS_BEFORE_END: [3, 1], // Send reminders 3 and 1 day before trial ends
};

// ========================
// DISCOUNT/PROMO CONFIGURATION
// ========================
export const DISCOUNT_CONFIG = {
  TYPES: {
    PERCENTAGE: 'percentage',
    FIXED: 'fixed',
    TRIAL_EXTENSION: 'trial_extension',
    FREE_PERIOD: 'free_period',
  },
  
  MAX_PERCENTAGE: 100,
  MAX_FIXED_AMOUNT: 10000, // $100 in cents
  MAX_TRIAL_EXTENSION_DAYS: 30,
  
  RESTRICTIONS: {
    NEW_USERS_ONLY: 'new_users_only',
    FIRST_PURCHASE: 'first_purchase',
    SPECIFIC_PLANS: 'specific_plans',
    TIME_LIMITED: 'time_limited',
    USAGE_LIMITED: 'usage_limited',
  },
};

// ========================
// WEBHOOK SECURITY
// ========================
export const WEBHOOK_CONFIG = {
  TIMEOUT: 20000,
  MAX_PAYLOAD_SIZE: '100kb',
  
  HEADERS: {
    GOOGLE_SIGNATURE: 'x-goog-signature',
    APPLE_SIGNATURE: 'x-apple-signature',
  },
  
  IP_WHITELIST: {
    GOOGLE: ['66.102.0.0/20', '66.249.80.0/20'],
    APPLE: ['17.0.0.0/8'],
  },
  
  // Add retry configuration
  RETRY: {
    MAX_ATTEMPTS: 3,
    INITIAL_DELAY: 1000,
    MAX_DELAY: 10000,
    BACKOFF_MULTIPLIER: 2,
  },
};

// ========================
// ANALYTICS EVENTS
// ========================
export const PAYMENT_EVENTS = {
  // Subscription events
  SUBSCRIPTION_STARTED: 'subscription_started',
  SUBSCRIPTION_RENEWED: 'subscription_renewed',
  SUBSCRIPTION_CANCELLED: 'subscription_cancelled',
  SUBSCRIPTION_EXPIRED: 'subscription_expired',
  SUBSCRIPTION_UPGRADED: 'subscription_upgraded',
  SUBSCRIPTION_DOWNGRADED: 'subscription_downgraded',
  SUBSCRIPTION_PAUSED: 'subscription_paused',
  SUBSCRIPTION_RESUMED: 'subscription_resumed',
  
  // Payment events
  PAYMENT_INITIATED: 'payment_initiated',
  PAYMENT_COMPLETED: 'payment_completed',
  PAYMENT_FAILED: 'payment_failed',
  PAYMENT_REFUNDED: 'payment_refunded',
  
  // Trial events
  TRIAL_STARTED: 'trial_started',
  TRIAL_CONVERTED: 'trial_converted',
  TRIAL_EXPIRED: 'trial_expired',
  TRIAL_CANCELLED: 'trial_cancelled',
  
  // Purchase events
  PURCHASE_INITIATED: 'purchase_initiated',
  PURCHASE_COMPLETED: 'purchase_completed',
  PURCHASE_FAILED: 'purchase_failed',
  
  // Promo events
  PROMO_APPLIED: 'promo_applied',
  PROMO_FAILED: 'promo_failed',
  PROMO_EXPIRED: 'promo_expired',
};

// ========================
// ERROR MESSAGES
// ========================
export const PAYMENT_ERRORS = {
  // General errors
  INVALID_PAYMENT_METHOD: 'Invalid payment method',
  PAYMENT_METHOD_REQUIRED: 'Payment method is required',
  AMOUNT_TOO_LOW: 'Amount is below minimum allowed',
  AMOUNT_TOO_HIGH: 'Amount exceeds maximum allowed',
  CURRENCY_NOT_SUPPORTED: 'Currency is not supported',
  
  // Subscription errors
  SUBSCRIPTION_NOT_FOUND: 'Subscription not found',
  SUBSCRIPTION_ALREADY_EXISTS: 'Active subscription already exists',
  SUBSCRIPTION_CANCELLED: 'Subscription has been cancelled',
  SUBSCRIPTION_EXPIRED: 'Subscription has expired',
  CANNOT_CHANGE_PLAN: 'Cannot change plan at this time',
  
  // Mobile-specific errors
  PURCHASE_VERIFICATION_FAILED: 'Purchase verification failed',
  RECEIPT_INVALID: 'Invalid receipt',
  RECEIPT_ALREADY_USED: 'Receipt has already been used',
  PURCHASE_CANCELLED: 'Purchase was cancelled',
  PURCHASE_PENDING: 'Purchase is pending',
  STORE_UNAVAILABLE: 'App store service unavailable',
  
  // Provider errors
  PROVIDER_ERROR: 'Payment provider error',
  PROVIDER_UNAVAILABLE: 'Payment provider is temporarily unavailable',
  
  // Refund errors
  REFUND_PERIOD_EXPIRED: 'Refund period has expired',
  REFUND_NOT_ALLOWED: 'Refund is not allowed for this purchase',
  REFUND_ALREADY_PROCESSED: 'Refund has already been processed',
  
  // Promo errors
  PROMO_CODE_INVALID: 'Invalid promo code',
  PROMO_CODE_EXPIRED: 'Promo code has expired',
  PROMO_CODE_ALREADY_USED: 'Promo code has already been used',
  PROMO_CODE_NOT_APPLICABLE: 'Promo code is not applicable to this purchase',
  
  // Trial errors
  TRIAL_ALREADY_USED: 'Trial has already been used',
  TRIAL_NOT_AVAILABLE: 'Trial is not available for this plan',
};

// ========================
// SUCCESS MESSAGES
// ========================
export const PAYMENT_SUCCESS = {
  SUBSCRIPTION_CREATED: 'Subscription created successfully',
  SUBSCRIPTION_UPDATED: 'Subscription updated successfully',
  SUBSCRIPTION_CANCELLED: 'Subscription cancelled successfully',
  SUBSCRIPTION_PAUSED: 'Subscription paused successfully',
  SUBSCRIPTION_RESUMED: 'Subscription resumed successfully',
  
  PAYMENT_COMPLETED: 'Payment completed successfully',
  PAYMENT_METHOD_ADDED: 'Payment method added successfully',
  PAYMENT_METHOD_UPDATED: 'Payment method updated successfully',
  PAYMENT_METHOD_REMOVED: 'Payment method removed successfully',
  
  REFUND_INITIATED: 'Refund has been initiated',
  REFUND_PROCESSED: 'Refund has been processed',
  
  PROMO_APPLIED: 'Promo code applied successfully',
  
  TRIAL_STARTED: 'Trial started successfully',
};
export const MOBILE_PAYMENT_CONFIG = {
  // Common settings
  VERIFICATION_TIMEOUT: 30000, // 30 seconds
  MAX_RETRY_ATTEMPTS: 3,
  CACHE_DURATION: {
    RECEIPT: 3600,      // 1 hour
    SUBSCRIPTION: 600,   // 10 minutes
    PRODUCTS: 86400,     // 24 hours
  },
  
  // Sandbox/Production detection
  ENVIRONMENTS: {
    PRODUCTION: 'production',
    SANDBOX: 'sandbox',
    TEST: 'test',
  },
  
  // Common error codes
  ERROR_CODES: {
    PURCHASE_CANCELLED: 'purchase_cancelled',
    PURCHASE_PENDING: 'purchase_pending', 
    RECEIPT_INVALID: 'receipt_invalid',
    RECEIPT_ALREADY_USED: 'receipt_already_used',
    PRODUCT_NOT_FOUND: 'product_not_found',
    SUBSCRIPTION_EXPIRED: 'subscription_expired',
  },
};

export const STORE_URLS = {
  APP_STORE: process.env.APP_STORE_URL || 'https://apps.apple.com/app/id123456789',
  PLAY_STORE: process.env.PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.yourapp',
  
  // Subscription management URLs
  MANAGE_SUBSCRIPTIONS: {
    IOS: 'https://apps.apple.com/account/subscriptions',
    ANDROID: 'https://play.google.com/store/account/subscriptions',
  },
  
  // Support URLs
  SUPPORT: {
    IOS: 'https://support.apple.com/billing',
    ANDROID: 'https://support.google.com/googleplay',
  },
};
// ========================
// EXPORTS
// ========================
export default {
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_STATUS,
  BILLING_CYCLES,
  PAYMENT_PROVIDERS,
  PAYMENT_METHODS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  SUBSCRIPTION_FEATURES_CONFIG,
  SUBSCRIPTION_PRICING,
  ONE_TIME_PURCHASES,
  GOOGLE_PLAY_CONFIG,
  APPLE_IAP_CONFIG,
  PAYMENT_VALIDATION,
  GRACE_PERIOD_CONFIG,
  REFUND_CONFIG,
  TRIAL_CONFIG,
  DISCOUNT_CONFIG,
  WEBHOOK_CONFIG,
  PAYMENT_EVENTS,
  PAYMENT_ERRORS,
  PAYMENT_SUCCESS,
};