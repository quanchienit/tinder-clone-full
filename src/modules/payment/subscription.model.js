// src/modules/payment/subscription.model.js

import mongoose from 'mongoose';
import { 
  SUBSCRIPTION_TYPES, 
  SUBSCRIPTION_STATUS,
  BILLING_CYCLES,
  PAYMENT_PROVIDERS,
  SUBSCRIPTION_FEATURES,
  SUBSCRIPTION_PRICING 
} from '../../config/constants.js';

const { Schema } = mongoose;

/**
 * Subscription History Schema - Track changes
 */
const subscriptionHistorySchema = new Schema({
  action: {
    type: String,
    enum: ['created', 'upgraded', 'downgraded', 'cancelled', 'expired', 'paused', 'resumed', 'payment_failed', 'payment_succeeded'],
    required: true,
  },
  fromPlan: {
    type: String,
    enum: Object.values(SUBSCRIPTION_TYPES),
  },
  toPlan: {
    type: String,
    enum: Object.values(SUBSCRIPTION_TYPES),
  },
  reason: String,
  metadata: Schema.Types.Mixed,
  performedBy: {
    type: String,
    enum: ['user', 'system', 'admin', 'provider'],
    default: 'system',
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Grace Period Schema - For payment failures
 */
const gracePeriodSchema = new Schema({
  startDate: Date,
  endDate: Date,
  reason: {
    type: String,
    enum: ['payment_failed', 'billing_retry', 'account_hold'],
  },
  retryCount: {
    type: Number,
    default: 0,
  },
  lastRetryAt: Date,
  resolved: {
    type: Boolean,
    default: false,
  },
});

/**
 * Discount/Promo Schema
 */
const discountSchema = new Schema({
  code: String,
  type: {
    type: String,
    enum: ['percentage', 'fixed', 'trial_extension'],
  },
  value: Number, // percentage (0-100) or fixed amount in cents
  appliedAt: {
    type: Date,
    default: Date.now,
  },
  expiresAt: Date,
  recurring: {
    type: Boolean,
    default: false,
  },
  maxRedemptions: Number,
  currentRedemptions: {
    type: Number,
    default: 1,
  },
});

/**
 * Main Subscription Schema
 */
const subscriptionSchema = new Schema(
  {
    // ========================
    // USER REFERENCE
    // ========================
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // ========================
    // PLAN DETAILS
    // ========================
    planType: {
      type: String,
      enum: Object.values(SUBSCRIPTION_TYPES).filter(type => type !== 'free'),
      required: true,
      index: true,
    },

    billingCycle: {
      type: String,
      enum: Object.values(BILLING_CYCLES || ['monthly', 'quarterly', 'yearly']),
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(SUBSCRIPTION_STATUS || [
        'active',
        'trialing',
        'past_due',
        'cancelled',
        'expired',
        'paused',
        'incomplete',
        'incomplete_expired',
      ]),
      default: 'incomplete',
      required: true,
      index: true,
    },

    // ========================
    // PROVIDER INFORMATION
    // ========================
    provider: {
      type: String,
      enum: Object.values(PAYMENT_PROVIDERS || ['stripe', 'google', 'apple', 'paypal']),
      required: true,
      index: true,
    },

    providerSubscriptionId: {
      type: String,
      required: true,
      unique: true,
      sparse: true, // Allow null values but ensure uniqueness when not null
    },

    providerCustomerId: {
      type: String,
      index: true,
    },

    providerPriceId: String, // Stripe price ID or similar
    providerProductId: String, // Provider's product ID

    // ========================
    // BILLING PERIODS
    // ========================
    currentPeriodStart: {
      type: Date,
      required: true,
      index: true,
    },

    currentPeriodEnd: {
      type: Date,
      required: true,
      index: true,
    },

    nextBillingDate: {
      type: Date,
      index: true,
    },

    // ========================
    // TRIAL INFORMATION
    // ========================
    trialStart: Date,
    
    trialEnd: {
      type: Date,
      index: true,
    },

    trialDaysRemaining: {
      type: Number,
      default: 0,
    },

    hasUsedTrial: {
      type: Boolean,
      default: false,
    },

    // ========================
    // CANCELLATION
    // ========================
    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },

    cancelledAt: Date,

    cancellationReason: {
      type: String,
      enum: [
        'too_expensive',
        'missing_features',
        'switched_service',
        'too_complex',
        'customer_service',
        'low_quality',
        'temporary',
        'other',
      ],
    },

    cancellationFeedback: String,

    // ========================
    // PAYMENT DETAILS
    // ========================
    amount: {
      type: Number, // Amount in cents
      required: true,
    },

    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
    },

    lastPaymentDate: Date,
    
    lastPaymentAmount: Number,
    
    lastPaymentStatus: {
      type: String,
      enum: ['succeeded', 'failed', 'pending', 'refunded'],
    },

    nextPaymentAmount: Number,

    totalPaidAmount: {
      type: Number,
      default: 0,
    },

    paymentMethod: {
      type: {
        type: String,
        enum: ['card', 'paypal', 'apple_pay', 'google_pay', 'bank_transfer'],
      },
      last4: String, // Last 4 digits of card
      brand: String, // Visa, Mastercard, etc.
      expiryMonth: Number,
      expiryYear: Number,
      isDefault: {
        type: Boolean,
        default: true,
      },
    },

    // ========================
    // GRACE PERIOD & RETRY
    // ========================
    gracePeriod: gracePeriodSchema,

    paymentRetryCount: {
      type: Number,
      default: 0,
    },

    maxPaymentRetries: {
      type: Number,
      default: 3,
    },

    // ========================
    // DISCOUNTS & PROMOTIONS
    // ========================
    discount: discountSchema,

    referralCode: String,

    referredBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },

    // ========================
    // PAUSE FUNCTIONALITY
    // ========================
    pausedAt: Date,
    
    pausedUntil: Date,
    
    pauseReason: String,
    
    pauseCount: {
      type: Number,
      default: 0,
    },

    maxPausesAllowed: {
      type: Number,
      default: 3,
    },

    // ========================
    // HISTORY & METADATA
    // ========================
    history: [subscriptionHistorySchema],

    previousPlan: {
      type: String,
      enum: Object.values(SUBSCRIPTION_TYPES),
    },

    upgradeAvailableAt: Date, // For preventing rapid plan changes

    downgradedAt: Date,

    metadata: {
      source: {
        type: String,
        enum: ['web', 'ios', 'android', 'admin', 'api'],
      },
      campaign: String,
      affiliate: String,
      utmSource: String,
      utmMedium: String,
      utmCampaign: String,
      deviceInfo: Schema.Types.Mixed,
      ipAddress: String,
      userAgent: String,
    },

    // ========================
    // FEATURES & LIMITS
    // ========================
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

    // ========================
    // USAGE TRACKING
    // ========================
    usage: {
      lastActiveAt: Date,
      totalActivedays: {
        type: Number,
        default: 0,
      },
      featuresUsed: [{
        feature: String,
        usedAt: Date,
        count: Number,
      }],
    },

    // ========================
    // COMPLIANCE & LEGAL
    // ========================
    taxIds: [{
      type: String,
      value: String,
      country: String,
    }],

    invoiceSettings: {
      companyName: String,
      address: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
      vatNumber: String,
      sendInvoiceEmails: {
        type: Boolean,
        default: true,
      },
    },

    consentTimestamp: Date,
    
    termsAcceptedAt: Date,
    
    termsVersion: String,

    // ========================
    // FLAGS & INTERNAL
    // ========================
    isLocked: {
      type: Boolean,
      default: false,
    },

    lockReason: String,

    requiresAction: {
      type: Boolean,
      default: false,
    },

    actionRequired: {
      type: String,
      enum: ['payment_method_update', 'verification', 'confirmation'],
    },

    internalNotes: [{
      note: String,
      addedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      addedAt: {
        type: Date,
        default: Date.now,
      },
    }],

    // ========================
    // SYNC & VERSIONING
    // ========================
    lastSyncedAt: Date,
    
    syncErrors: [{
      error: String,
      occurredAt: Date,
      resolved: Boolean,
    }],

    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
    collection: 'subscriptions',
  }
);

// ========================
// INDEXES
// ========================
subscriptionSchema.index({ userId: 1, status: 1 });
subscriptionSchema.index({ provider: 1, providerSubscriptionId: 1 });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ status: 1, nextBillingDate: 1 });
subscriptionSchema.index({ cancelAtPeriodEnd: 1, currentPeriodEnd: 1 });
subscriptionSchema.index({ 'gracePeriod.endDate': 1 });
subscriptionSchema.index({ trialEnd: 1, status: 1 });
subscriptionSchema.index({ createdAt: -1 });

// ========================
// VIRTUAL FIELDS
// ========================
subscriptionSchema.virtual('isActive').get(function() {
  return ['active', 'trialing'].includes(this.status);
});

subscriptionSchema.virtual('isInTrial').get(function() {
  return this.status === 'trialing' && this.trialEnd && this.trialEnd > new Date();
});

subscriptionSchema.virtual('isInGracePeriod').get(function() {
  return this.gracePeriod?.endDate && this.gracePeriod.endDate > new Date() && !this.gracePeriod.resolved;
});

subscriptionSchema.virtual('daysUntilRenewal').get(function() {
  if (!this.currentPeriodEnd) return null;
  const days = Math.ceil((this.currentPeriodEnd - new Date()) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
});

subscriptionSchema.virtual('monthlyAmount').get(function() {
  if (!this.amount || !this.billingCycle) return 0;
  
  const multipliers = {
    monthly: 1,
    quarterly: 1/3,
    yearly: 1/12,
  };
  
  return Math.round(this.amount * (multipliers[this.billingCycle] || 1));
});

// ========================
// INSTANCE METHODS
// ========================

/**
 * Add history entry
 */
subscriptionSchema.methods.addHistory = function(action, metadata = {}) {
  this.history.push({
    action,
    fromPlan: this.previousPlan,
    toPlan: this.planType,
    metadata,
    timestamp: new Date(),
  });
  
  return this.save();
};

/**
 * Check if can pause subscription
 */
subscriptionSchema.methods.canPause = function() {
  if (this.status !== 'active') return false;
  if (this.pauseCount >= this.maxPausesAllowed) return false;
  if (this.pausedUntil && this.pausedUntil > new Date()) return false;
  return true;
};

/**
 * Check if can cancel
 */
subscriptionSchema.methods.canCancel = function() {
  return ['active', 'trialing', 'past_due'].includes(this.status);
};

/**
 * Apply discount
 */
subscriptionSchema.methods.applyDiscount = function(discountCode, discountDetails) {
  this.discount = {
    code: discountCode,
    ...discountDetails,
    appliedAt: new Date(),
  };
  
  // Recalculate amount if needed
  if (discountDetails.type === 'percentage') {
    this.nextPaymentAmount = Math.round(this.amount * (1 - discountDetails.value / 100));
  } else if (discountDetails.type === 'fixed') {
    this.nextPaymentAmount = Math.max(0, this.amount - discountDetails.value);
  }
  
  return this.save();
};

/**
 * Start grace period
 */
subscriptionSchema.methods.startGracePeriod = function(reason, durationDays = 7) {
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + durationDays);
  
  this.gracePeriod = {
    startDate: new Date(),
    endDate,
    reason,
    retryCount: 0,
    resolved: false,
  };
  
  this.status = 'past_due';
  
  return this.save();
};

/**
 * Update payment status
 */
subscriptionSchema.methods.updatePaymentStatus = function(status, amount = null) {
  this.lastPaymentDate = new Date();
  this.lastPaymentStatus = status;
  
  if (amount) {
    this.lastPaymentAmount = amount;
    if (status === 'succeeded') {
      this.totalPaidAmount = (this.totalPaidAmount || 0) + amount;
    }
  }
  
  if (status === 'succeeded' && this.gracePeriod) {
    this.gracePeriod.resolved = true;
    this.status = 'active';
  } else if (status === 'failed') {
    this.paymentRetryCount = (this.paymentRetryCount || 0) + 1;
    if (this.paymentRetryCount >= this.maxPaymentRetries) {
      this.status = 'expired';
    }
  }
  
  return this.save();
};

/**
 * Calculate refund amount
 */
subscriptionSchema.methods.calculateRefundAmount = function() {
  if (!this.lastPaymentAmount || !this.currentPeriodStart || !this.currentPeriodEnd) {
    return 0;
  }
  
  const now = new Date();
  const periodLength = this.currentPeriodEnd - this.currentPeriodStart;
  const usedTime = now - this.currentPeriodStart;
  const unusedPercentage = Math.max(0, (periodLength - usedTime) / periodLength);
  
  return Math.round(this.lastPaymentAmount * unusedPercentage);
};

// ========================
// STATIC METHODS
// ========================

/**
 * Find active subscription for user
 */
subscriptionSchema.statics.findActiveByUserId = async function(userId) {
  return this.findOne({
    userId,
    status: { $in: ['active', 'trialing'] },
  }).sort({ createdAt: -1 });
};

/**
 * Find subscriptions expiring soon
 */
subscriptionSchema.statics.findExpiringSoon = async function(days = 3) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);
  
  return this.find({
    status: 'active',
    cancelAtPeriodEnd: true,
    currentPeriodEnd: {
      $gte: new Date(),
      $lte: futureDate,
    },
  });
};

/**
 * Find subscriptions in grace period
 */
subscriptionSchema.statics.findInGracePeriod = async function() {
  return this.find({
    status: 'past_due',
    'gracePeriod.resolved': false,
    'gracePeriod.endDate': { $gt: new Date() },
  });
};

/**
 * Get subscription statistics
 */
subscriptionSchema.statics.getStatistics = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: '$planType',
        total: { $sum: 1 },
        active: {
          $sum: { $cond: [{ $in: ['$status', ['active', 'trialing']] }, 1, 0] },
        },
        revenue: { $sum: '$totalPaidAmount' },
        avgMonthlyRevenue: { $avg: '$monthlyAmount' },
      },
    },
  ]);
  
  return stats;
};

// ========================
// MIDDLEWARE
// ========================

/**
 * Pre-save middleware
 */
subscriptionSchema.pre('save', async function(next) {
  // Update trial days remaining
  if (this.trialEnd) {
    const daysRemaining = Math.ceil((this.trialEnd - new Date()) / (1000 * 60 * 60 * 24));
    this.trialDaysRemaining = Math.max(0, daysRemaining);
  }
  
  // Set next billing date
  if (this.currentPeriodEnd && this.status === 'active' && !this.cancelAtPeriodEnd) {
    this.nextBillingDate = this.currentPeriodEnd;
  }
  
  // Track plan changes
  if (this.isModified('planType') && this.planType !== this.previousPlan) {
    this.previousPlan = this.planType;
  }
  
  // Update features based on plan
  if (this.isModified('planType')) {
    const features = SUBSCRIPTION_FEATURES[this.planType];
    if (features) {
      this.features = { ...features };
    }
  }
  
  next();
});

/**
 * Post-save middleware - Sync with User model
 */
subscriptionSchema.post('save', async function(doc) {
  // Update user's subscription status
  const User = mongoose.model('User');
  await User.findByIdAndUpdate(doc.userId, {
    'subscription.type': doc.isActive ? doc.planType : 'free',
    'subscription.validUntil': doc.currentPeriodEnd,
    'subscription.features': doc.features,
  });
});

/**
 * Pre-remove middleware - Cleanup
 */
subscriptionSchema.pre('remove', async function(next) {
  // Reset user to free plan
  const User = mongoose.model('User');
  await User.findByIdAndUpdate(this.userId, {
    'subscription.type': 'free',
    'subscription.validUntil': null,
    'subscription.features': SUBSCRIPTION_FEATURES.free,
  });
  
  next();
});

// ========================
// MODEL EXPORT
// ========================
const Subscription = mongoose.model('Subscription', subscriptionSchema);

export default Subscription;