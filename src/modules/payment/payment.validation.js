// src/modules/payment/payment.validation.js

import Joi from 'joi';
import {
  SUBSCRIPTION_TIERS,
  BILLING_CYCLES,
  PAYMENT_PROVIDERS,
  PAYMENT_METHODS,
  ONE_TIME_PURCHASES,
  PAYMENT_VALIDATION,
  REFUND_CONFIG,
  DISCOUNT_CONFIG,
} from './payment.constants.js';

/**
 * Payment Validation Schemas
 * Comprehensive validation for all payment-related requests
 */

// ========================
// COMMON SCHEMAS
// ========================

/**
 * Payment method ID validation
 */
const paymentMethodIdSchema = Joi.string()
  .pattern(/^pm_[a-zA-Z0-9_]+$/)
  .required()
  .messages({
    'string.pattern.base': 'Invalid payment method ID format',
    'any.required': 'Payment method ID is required',
  });

/**
 * Provider validation
 */
const providerSchema = Joi.string()
  .valid(...Object.values(PAYMENT_PROVIDERS))
  .messages({
    'any.only': 'Invalid payment provider. Must be one of: stripe, google, apple, paypal',
  });

/**
 * Currency validation
 */
const currencySchema = Joi.string()
  .uppercase()
  .length(3)
  .valid(...PAYMENT_VALIDATION.CURRENCY_CODES)
  .default('USD')
  .messages({
    'any.only': 'Currency not supported',
    'string.length': 'Currency code must be 3 characters',
  });

/**
 * Amount validation
 */
const amountSchema = Joi.number()
  .integer()
  .min(PAYMENT_VALIDATION.MIN_AMOUNT)
  .max(PAYMENT_VALIDATION.MAX_AMOUNT)
  .messages({
    'number.min': `Amount must be at least $${PAYMENT_VALIDATION.MIN_AMOUNT / 100}`,
    'number.max': `Amount cannot exceed $${PAYMENT_VALIDATION.MAX_AMOUNT / 100}`,
    'number.integer': 'Amount must be in cents (integer)',
  });

/**
 * Promo code validation
 */
const promoCodeSchema = Joi.string()
  .min(PAYMENT_VALIDATION.PROMO_CODE.MIN_LENGTH)
  .max(PAYMENT_VALIDATION.PROMO_CODE.MAX_LENGTH)
  .pattern(PAYMENT_VALIDATION.PROMO_CODE.PATTERN)
  .uppercase()
  .messages({
    'string.pattern.base': 'Promo code can only contain letters, numbers, underscores and hyphens',
    'string.min': `Promo code must be at least ${PAYMENT_VALIDATION.PROMO_CODE.MIN_LENGTH} characters`,
    'string.max': `Promo code cannot exceed ${PAYMENT_VALIDATION.PROMO_CODE.MAX_LENGTH} characters`,
  });

// ========================
// SUBSCRIPTION SCHEMAS
// ========================

/**
 * Create subscription validation
 */
export const createSubscriptionSchema = Joi.object({
  planType: Joi.string()
    .valid(...Object.values(SUBSCRIPTION_TIERS).filter(t => t !== 'free'))
    .required()
    .messages({
      'any.only': 'Invalid plan type. Choose from: plus, gold, platinum',
      'any.required': 'Plan type is required',
    }),

  billingCycle: Joi.string()
    .valid(...Object.values(BILLING_CYCLES).filter(c => c !== 'lifetime'))
    .required()
    .messages({
      'any.only': 'Invalid billing cycle. Choose from: monthly, quarterly, yearly',
      'any.required': 'Billing cycle is required',
    }),

  paymentMethodId: Joi.when('provider', {
    is: 'stripe',
    then: paymentMethodIdSchema,
    otherwise: Joi.string().optional(),
  }),

  provider: providerSchema.default('stripe'),

  promoCode: promoCodeSchema.optional(),

  trial: Joi.boolean()
    .default(true)
    .messages({
      'boolean.base': 'Trial must be a boolean value',
    }),

  metadata: Joi.object({
    source: Joi.string().valid('web', 'ios', 'android', 'admin').optional(),
    campaign: Joi.string().optional(),
    referralCode: Joi.string().optional(),
  }).optional(),
}).messages({
  'object.unknown': 'Unknown field in request',
});

/**
 * Update subscription validation
 */
export const updateSubscriptionSchema = Joi.object({
  action: Joi.string()
    .valid('upgrade', 'downgrade', 'change_billing_cycle')
    .required()
    .messages({
      'any.only': 'Invalid action. Choose from: upgrade, downgrade, change_billing_cycle',
      'any.required': 'Action is required',
    }),

  newPlanType: Joi.when('action', {
    is: Joi.valid('upgrade', 'downgrade'),
    then: Joi.string()
      .valid(...Object.values(SUBSCRIPTION_TIERS).filter(t => t !== 'free'))
      .required(),
    otherwise: Joi.forbidden(),
  }),

  newBillingCycle: Joi.when('action', {
    is: 'change_billing_cycle',
    then: Joi.string()
      .valid(...Object.values(BILLING_CYCLES).filter(c => c !== 'lifetime'))
      .required(),
    otherwise: Joi.optional(),
  }),

  immediate: Joi.boolean()
    .default(false)
    .messages({
      'boolean.base': 'Immediate must be a boolean value',
    }),

  promoCode: promoCodeSchema.optional(),
});

/**
 * Cancel subscription validation
 */
export const cancelSubscriptionSchema = Joi.object({
  reason: Joi.string()
    .valid(
      'too_expensive',
      'missing_features',
      'switched_service',
      'too_complex',
      'customer_service',
      'low_quality',
      'temporary',
      'other'
    )
    .required()
    .messages({
      'any.required': 'Cancellation reason is required',
      'any.only': 'Please select a valid cancellation reason',
    }),

  feedback: Joi.string()
    .max(500)
    .when('reason', {
      is: 'other',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .messages({
      'string.max': 'Feedback cannot exceed 500 characters',
      'any.required': 'Please provide feedback when selecting "other" as reason',
    }),

  immediate: Joi.boolean()
    .default(false)
    .messages({
      'boolean.base': 'Immediate must be a boolean value',
    }),

  confirmCancellation: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'Please confirm the cancellation',
      'any.required': 'Cancellation confirmation is required',
    }),
});

/**
 * Pause subscription validation
 */
export const pauseSubscriptionSchema = Joi.object({
  pauseUntil: Joi.date()
    .min('now')
    .max(Joi.ref('$maxPauseDate'))
    .required()
    .messages({
      'date.min': 'Pause date must be in the future',
      'date.max': 'Pause period cannot exceed 3 months',
      'any.required': 'Resume date is required',
    }),

  reason: Joi.string()
    .valid('vacation', 'financial', 'temporary_break', 'other')
    .required()
    .messages({
      'any.required': 'Pause reason is required',
      'any.only': 'Please select a valid pause reason',
    }),

  customReason: Joi.when('reason', {
    is: 'other',
    then: Joi.string().max(200).required(),
    otherwise: Joi.forbidden(),
  }),
});

/**
 * Resume subscription validation
 */
export const resumeSubscriptionSchema = Joi.object({
  confirmResume: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'Please confirm the subscription resume',
      'any.required': 'Resume confirmation is required',
    }),
});

// ========================
// PURCHASE SCHEMAS
// ========================

/**
 * One-time purchase validation
 */
export const purchaseItemsSchema = Joi.object({
  itemType: Joi.string()
    .valid('superLikes', 'boosts', 'readReceipts')
    .required()
    .messages({
      'any.only': 'Invalid item type. Choose from: superLikes, boosts, readReceipts',
      'any.required': 'Item type is required',
    }),

  packSize: Joi.string()
    .required()
    .when('itemType', [
      {
        is: 'superLikes',
        then: Joi.valid('pack5', 'pack10', 'pack25'),
      },
      {
        is: 'boosts',
        then: Joi.valid('single', 'pack5', 'pack10'),
      },
      {
        is: 'readReceipts',
        then: Joi.valid('pack10', 'pack20'),
      },
    ])
    .messages({
      'any.only': 'Invalid pack size for selected item',
      'any.required': 'Pack size is required',
    }),

  paymentMethodId: Joi.when('provider', {
    is: 'stripe',
    then: paymentMethodIdSchema,
    otherwise: Joi.string().optional(),
  }),

  provider: providerSchema.default('stripe'),

  savePaymentMethod: Joi.boolean().default(false),
});

/**
 * Custom purchase validation
 */
export const customPurchaseSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        type: Joi.string().required(),
        quantity: Joi.number().integer().min(1).required(),
        unitPrice: Joi.number().integer().min(0).required(),
      })
    )
    .min(1)
    .required()
    .messages({
      'array.min': 'At least one item is required',
      'any.required': 'Items are required',
    }),

  totalAmount: amountSchema.required(),

  paymentMethodId: paymentMethodIdSchema,

  currency: currencySchema,

  metadata: Joi.object().optional(),
});

// ========================
// IN-APP PURCHASE SCHEMAS
// ========================

/**
 * Google Play purchase verification
 */
export const verifyGooglePurchaseSchema = Joi.object({
  purchaseToken: Joi.string()
    .required()
    .messages({
      'any.required': 'Purchase token is required',
      'string.empty': 'Purchase token cannot be empty',
    }),

  productId: Joi.string()
    .required()
    .messages({
      'any.required': 'Product ID is required',
      'string.empty': 'Product ID cannot be empty',
    }),

  orderId: Joi.string()
    .required()
    .messages({
      'any.required': 'Order ID is required',
      'string.empty': 'Order ID cannot be empty',
    }),

  packageName: Joi.string()
    .default(process.env.GOOGLE_PLAY_PACKAGE_NAME)
    .messages({
      'string.empty': 'Package name cannot be empty',
    }),

  developerPayload: Joi.string().optional(),
});

/**
 * Apple receipt verification
 */
export const verifyAppleReceiptSchema = Joi.object({
  receiptData: Joi.string()
    .required()
    .messages({
      'any.required': 'Receipt data is required',
      'string.empty': 'Receipt data cannot be empty',
    }),

  sandbox: Joi.boolean()
    .default(process.env.NODE_ENV !== 'production')
    .messages({
      'boolean.base': 'Sandbox must be a boolean value',
    }),

  excludeOldTransactions: Joi.boolean().default(false),
});

/**
 * Google Play subscription notification
 */
export const googleSubscriptionNotificationSchema = Joi.object({
  message: Joi.object({
    data: Joi.string().required(),
    messageId: Joi.string().required(),
    publishTime: Joi.string().required(),
  }).required(),

  subscription: Joi.string().required(),
});

/**
 * Apple server notification
 */
export const appleServerNotificationSchema = Joi.object({
  notificationType: Joi.string().required(),
  
  data: Joi.object({
    appAppleId: Joi.number().required(),
    bundleId: Joi.string().required(),
    bundleVersion: Joi.string().optional(),
    environment: Joi.string().valid('Sandbox', 'Production').required(),
    signedTransactionInfo: Joi.string().optional(),
    signedRenewalInfo: Joi.string().optional(),
  }).required(),

  notificationUUID: Joi.string().required(),
  
  signedDate: Joi.number().required(),
  
  version: Joi.string().required(),
});

// ========================
// PAYMENT METHOD SCHEMAS
// ========================

/**
 * Add payment method validation
 */
export const addPaymentMethodSchema = Joi.object({
  type: Joi.string()
    .valid(...Object.values(PAYMENT_METHODS))
    .default('card')
    .messages({
      'any.only': 'Invalid payment method type',
    }),

  token: Joi.when('type', {
    is: 'card',
    then: Joi.string()
      .pattern(/^tok_[a-zA-Z0-9]+$/)
      .required()
      .messages({
        'string.pattern.base': 'Invalid token format',
        'any.required': 'Payment token is required',
      }),
    otherwise: Joi.string().required(),
  }),

  setAsDefault: Joi.boolean().default(true),

  billingDetails: Joi.object({
    name: Joi.string().max(100).optional(),
    email: Joi.string().email().optional(),
    phone: Joi.string().optional(),
    address: Joi.object({
      line1: Joi.string().max(200).optional(),
      line2: Joi.string().max(200).optional(),
      city: Joi.string().max(100).optional(),
      state: Joi.string().max(100).optional(),
      postalCode: Joi.string().max(20).optional(),
      country: Joi.string().length(2).uppercase().optional(),
    }).optional(),
  }).optional(),
});

/**
 * Update payment method validation
 */
export const updatePaymentMethodSchema = Joi.object({
  paymentMethodId: paymentMethodIdSchema,

  billingDetails: Joi.object({
    name: Joi.string().max(100).optional(),
    email: Joi.string().email().optional(),
    phone: Joi.string().optional(),
    address: Joi.object({
      line1: Joi.string().max(200).optional(),
      line2: Joi.string().max(200).optional(),
      city: Joi.string().max(100).optional(),
      state: Joi.string().max(100).optional(),
      postalCode: Joi.string().max(20).optional(),
      country: Joi.string().length(2).uppercase().optional(),
    }).optional(),
  }),

  setAsDefault: Joi.boolean().optional(),
});

/**
 * Remove payment method validation
 */
export const removePaymentMethodSchema = Joi.object({
  paymentMethodId: paymentMethodIdSchema,

  confirmRemoval: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'Please confirm the payment method removal',
      'any.required': 'Removal confirmation is required',
    }),
});

// ========================
// REFUND SCHEMAS
// ========================

/**
 * Request refund validation
 */
export const requestRefundSchema = Joi.object({
  transactionId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .required()
    .messages({
      'string.pattern.base': 'Invalid transaction ID format',
      'any.required': 'Transaction ID is required',
    }),

  reason: Joi.string()
    .valid(...Object.values(REFUND_CONFIG.REASONS))
    .required()
    .messages({
      'any.only': 'Please select a valid refund reason',
      'any.required': 'Refund reason is required',
    }),

  amount: Joi.number()
    .integer()
    .min(PAYMENT_VALIDATION.MIN_AMOUNT)
    .optional()
    .messages({
      'number.min': `Refund amount must be at least $${PAYMENT_VALIDATION.MIN_AMOUNT / 100}`,
      'number.integer': 'Amount must be in cents',
    }),

  details: Joi.string()
    .max(500)
    .when('reason', {
      is: 'other',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .messages({
      'string.max': 'Details cannot exceed 500 characters',
      'any.required': 'Please provide details when selecting "other" as reason',
    }),

  confirmRefund: Joi.boolean()
    .valid(true)
    .required()
    .messages({
      'any.only': 'Please confirm the refund request',
      'any.required': 'Refund confirmation is required',
    }),
});

// ========================
// PROMO CODE SCHEMAS
// ========================

/**
 * Apply promo code validation
 */
export const applyPromoCodeSchema = Joi.object({
  code: promoCodeSchema.required(),

  subscriptionId: Joi.string()
    .pattern(/^[0-9a-fA-F]{24}$/)
    .optional()
    .messages({
      'string.pattern.base': 'Invalid subscription ID format',
    }),
});

/**
 * Create promo code validation (admin)
 */
export const createPromoCodeSchema = Joi.object({
  code: promoCodeSchema.required(),

  type: Joi.string()
    .valid(...Object.values(DISCOUNT_CONFIG.TYPES))
    .required()
    .messages({
      'any.only': 'Invalid discount type',
      'any.required': 'Discount type is required',
    }),

  value: Joi.when('type', [
    {
      is: 'percentage',
      then: Joi.number()
        .min(1)
        .max(DISCOUNT_CONFIG.MAX_PERCENTAGE)
        .required()
        .messages({
          'number.min': 'Percentage must be at least 1%',
          'number.max': `Percentage cannot exceed ${DISCOUNT_CONFIG.MAX_PERCENTAGE}%`,
        }),
    },
    {
      is: 'fixed',
      then: Joi.number()
        .integer()
        .min(PAYMENT_VALIDATION.MIN_AMOUNT)
        .max(DISCOUNT_CONFIG.MAX_FIXED_AMOUNT)
        .required()
        .messages({
          'number.min': `Fixed amount must be at least $${PAYMENT_VALIDATION.MIN_AMOUNT / 100}`,
          'number.max': `Fixed amount cannot exceed $${DISCOUNT_CONFIG.MAX_FIXED_AMOUNT / 100}`,
        }),
    },
    {
      is: 'trial_extension',
      then: Joi.number()
        .integer()
        .min(1)
        .max(DISCOUNT_CONFIG.MAX_TRIAL_EXTENSION_DAYS)
        .required()
        .messages({
          'number.min': 'Trial extension must be at least 1 day',
          'number.max': `Trial extension cannot exceed ${DISCOUNT_CONFIG.MAX_TRIAL_EXTENSION_DAYS} days`,
        }),
    },
  ]),

  restrictions: Joi.object({
    newUsersOnly: Joi.boolean().default(false),
    firstPurchaseOnly: Joi.boolean().default(false),
    specificPlans: Joi.array()
      .items(Joi.string().valid(...Object.values(SUBSCRIPTION_TIERS)))
      .optional(),
    minPurchaseAmount: amountSchema.optional(),
    maxRedemptions: Joi.number().integer().min(1).optional(),
    validFrom: Joi.date().optional(),
    validUntil: Joi.date().greater(Joi.ref('validFrom')).optional(),
  }).optional(),

  metadata: Joi.object().optional(),
});

// ========================
// WEBHOOK SCHEMAS
// ========================

/**
 * Stripe webhook validation
 */
export const stripeWebhookSchema = Joi.object({
  body: Joi.string().required(),
  headers: Joi.object({
    'stripe-signature': Joi.string().required(),
  }).unknown(true).required(),
});

/**
 * Generic webhook validation
 */
export const webhookSchema = Joi.object({
  provider: providerSchema.required(),
  event: Joi.string().required(),
  data: Joi.object().required(),
  signature: Joi.string().optional(),
  timestamp: Joi.date().optional(),
});

// ========================
// QUERY SCHEMAS
// ========================

/**
 * Get transactions query validation
 */
export const getTransactionsQuerySchema = Joi.object({
  limit: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(20),

  offset: Joi.number()
    .integer()
    .min(0)
    .default(0),

  type: Joi.string()
    .valid('subscription', 'purchase', 'refund')
    .optional(),

  status: Joi.string()
    .valid('pending', 'success', 'failed', 'refunded')
    .optional(),

  startDate: Joi.date().optional(),

  endDate: Joi.date()
    .greater(Joi.ref('startDate'))
    .optional(),

  sortBy: Joi.string()
    .valid('createdAt', 'amount', 'type')
    .default('createdAt'),

  order: Joi.string()
    .valid('asc', 'desc')
    .default('desc'),
});

/**
 * Get invoices query validation
 */
export const getInvoicesQuerySchema = Joi.object({
  limit: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .default(10),

  startDate: Joi.date().optional(),

  endDate: Joi.date()
    .greater(Joi.ref('startDate'))
    .optional(),

  paid: Joi.boolean().optional(),
});

// ========================
// BILLING PORTAL SCHEMAS
// ========================

/**
 * Create billing portal session
 */
export const createBillingPortalSchema = Joi.object({
  returnUrl: Joi.string()
    .uri()
    .required()
    .messages({
      'string.uri': 'Return URL must be a valid URL',
      'any.required': 'Return URL is required',
    }),
});

// ========================
// EXPORT VALIDATION MIDDLEWARE
// ========================

/**
 * Validation middleware factory
 */
export const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      context: {
        maxPauseDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      },
    });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
      }));

      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors,
      });
    }

    req[property] = value;
    next();
  };
};

// ========================
// EXPORT ALL SCHEMAS
// ========================

export default {
  // Subscription schemas
  createSubscriptionSchema,
  updateSubscriptionSchema,
  cancelSubscriptionSchema,
  pauseSubscriptionSchema,
  resumeSubscriptionSchema,

  // Purchase schemas
  purchaseItemsSchema,
  customPurchaseSchema,

  // IAP schemas
  verifyGooglePurchaseSchema,
  verifyAppleReceiptSchema,
  googleSubscriptionNotificationSchema,
  appleServerNotificationSchema,

  // Payment method schemas
  addPaymentMethodSchema,
  updatePaymentMethodSchema,
  removePaymentMethodSchema,

  // Refund schemas
  requestRefundSchema,

  // Promo code schemas
  applyPromoCodeSchema,
  createPromoCodeSchema,

  // Webhook schemas
  stripeWebhookSchema,
  webhookSchema,

  // Query schemas
  getTransactionsQuerySchema,
  getInvoicesQuerySchema,

  // Billing portal schemas
  createBillingPortalSchema,

  // Validation middleware
  validate,
};