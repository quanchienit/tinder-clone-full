// src/modules/payment/transaction.model.js

import mongoose from 'mongoose';
import {
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  PAYMENT_PROVIDERS,
  PAYMENT_METHODS,
  REFUND_CONFIG,
} from './payment.constants.js';

const { Schema } = mongoose;

/**
 * Transaction Item Schema - For tracking individual items in a purchase
 */
const transactionItemSchema = new Schema({
  type: {
    type: String,
    required: true,
    enum: ['superLikes', 'boosts', 'readReceipts', 'subscription'],
  },
  
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  
  unitPrice: {
    type: Number, // In cents
    required: true,
    min: 0,
  },
  
  totalPrice: {
    type: Number, // In cents
    required: true,
    min: 0,
  },
  
  description: String,
  
  metadata: Schema.Types.Mixed,
});

/**
 * Refund Schema - Track refund details
 */
const refundSchema = new Schema({
  amount: {
    type: Number, // In cents
    required: true,
    min: 0,
  },
  
  reason: {
    type: String,
    enum: Object.values(REFUND_CONFIG.REASONS),
    required: true,
  },
  
  status: {
    type: String,
    enum: Object.values(REFUND_CONFIG.STATUS),
    default: REFUND_CONFIG.STATUS.PENDING,
  },
  
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  
  processedAt: Date,
  
  processedBy: {
    type: String,
    enum: ['system', 'admin', 'provider', 'user'],
    default: 'system',
  },
  
  providerRefundId: String, // Provider's refund ID
  
  notes: String,
  
  metadata: Schema.Types.Mixed,
});

/**
 * Receipt Schema - Store receipt data from providers
 */
const receiptSchema = new Schema({
  provider: {
    type: String,
    enum: Object.values(PAYMENT_PROVIDERS),
    required: true,
  },
  
  receiptType: {
    type: String,
    enum: ['purchase', 'subscription', 'renewal', 'refund'],
    required: true,
  },
  
  receiptData: {
    type: String, // Base64 encoded receipt
    required: true,
  },
  
  verifiedAt: Date,
  
  verificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'failed', 'expired'],
    default: 'pending',
  },
  
  parsedData: Schema.Types.Mixed, // Parsed receipt details
  
  environment: {
    type: String,
    enum: ['production', 'sandbox', 'test'],
    default: 'production',
  },
});

/**
 * Device Info Schema - Track purchase device
 */
const deviceInfoSchema = new Schema({
  platform: {
    type: String,
    enum: ['ios', 'android', 'web'],
  },
  
  deviceId: String,
  
  deviceModel: String,
  
  osVersion: String,
  
  appVersion: String,
  
  ipAddress: String,
  
  country: String,
  
  locale: String,
});

/**
 * Main Transaction Schema
 */
const transactionSchema = new Schema(
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
    // SUBSCRIPTION REFERENCE
    // ========================
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription',
      index: true,
      sparse: true, // Allow null for non-subscription transactions
    },

    // ========================
    // TRANSACTION DETAILS
    // ========================
    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: Object.values(TRANSACTION_STATUS),
      default: TRANSACTION_STATUS.PENDING,
      required: true,
      index: true,
    },

    // ========================
    // PROVIDER INFORMATION
    // ========================
    provider: {
      type: String,
      enum: Object.values(PAYMENT_PROVIDERS),
      required: true,
      index: true,
    },

    providerTransactionId: {
      type: String,
      required: true,
      unique: true,
      sparse: true,
    },

    providerOrderId: String, // Some providers use separate order ID

    providerCustomerId: String, // Provider's customer ID

    providerProductId: String, // Product ID from provider

    providerStatus: String, // Original status from provider

    // ========================
    // PAYMENT DETAILS
    // ========================
    amount: {
      type: Number, // Amount in cents
      required: true,
      min: 0,
      index: true,
    },

    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
      required: true,
    },

    exchangeRate: {
      type: Number,
      default: 1, // For currency conversion
    },

    amountInUSD: {
      type: Number, // Normalized amount in USD cents
      required: true,
    },

    tax: {
      amount: {
        type: Number,
        default: 0,
      },
      rate: Number, // Tax percentage
      country: String,
      state: String,
    },

    discount: {
      amount: {
        type: Number,
        default: 0,
      },
      code: String,
      type: {
        type: String,
        enum: ['percentage', 'fixed', 'trial'],
      },
    },

    finalAmount: {
      type: Number, // Final amount after tax and discount
      required: true,
    },

    // ========================
    // PAYMENT METHOD
    // ========================
    paymentMethod: {
      type: {
        type: String,
        enum: Object.values(PAYMENT_METHODS),
      },
      last4: String, // Last 4 digits of card
      brand: String, // Visa, Mastercard, etc.
      expiryMonth: Number,
      expiryYear: Number,
      funding: String, // credit, debit, prepaid
      country: String,
      fingerprint: String, // Card fingerprint for duplicate detection
    },

    // ========================
    // ITEMS PURCHASED
    // ========================
    items: [transactionItemSchema],

    // ========================
    // RECEIPT INFORMATION
    // ========================
    receipt: receiptSchema,

    receiptUrl: String, // URL to download receipt

    invoiceId: String, // Internal invoice ID

    invoiceUrl: String, // URL to download invoice

    // ========================
    // REFUND INFORMATION
    // ========================
    refund: refundSchema,

    isRefundable: {
      type: Boolean,
      default: true,
    },

    refundDeadline: Date, // Last date for refund eligibility

    partialRefundAmount: {
      type: Number,
      default: 0,
    },

    // ========================
    // DEVICE & SESSION INFO
    // ========================
    deviceInfo: deviceInfoSchema,

    sessionId: String, // Session ID for tracking

    purchaseToken: String, // Token from mobile purchases

    // ========================
    // DATES & TIMESTAMPS
    // ========================
    processedAt: Date,

    completedAt: Date,

    failedAt: Date,

    expiresAt: Date, // For subscription transactions

    nextBillingDate: Date, // For recurring transactions

    // ========================
    // ERROR HANDLING
    // ========================
    error: {
      code: String,
      message: String,
      details: Schema.Types.Mixed,
      occurredAt: Date,
      retryCount: {
        type: Number,
        default: 0,
      },
      lastRetryAt: Date,
    },

    // ========================
    // FRAUD DETECTION
    // ========================
    fraudDetection: {
      score: {
        type: Number,
        min: 0,
        max: 100,
      },
      status: {
        type: String,
        enum: ['safe', 'review', 'flagged', 'blocked'],
        default: 'safe',
      },
      checks: [{
        type: String,
        result: Boolean,
        details: String,
      }],
      reviewedAt: Date,
      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    },

    // ========================
    // ANALYTICS & TRACKING
    // ========================
    attribution: {
      source: String, // utm_source
      medium: String, // utm_medium
      campaign: String, // utm_campaign
      content: String, // utm_content
      term: String, // utm_term
      referrer: String,
      landingPage: String,
    },

    metrics: {
      processingTime: Number, // Time to process in ms
      verificationTime: Number, // Time to verify in ms
      retryAttempts: {
        type: Number,
        default: 0,
      },
    },

    // ========================
    // METADATA
    // ========================
    metadata: {
      source: {
        type: String,
        enum: ['web', 'ios', 'android', 'api', 'admin'],
      },
      appVersion: String,
      sdkVersion: String,
      environment: {
        type: String,
        enum: ['production', 'sandbox', 'test'],
        default: 'production',
      },
      testMode: {
        type: Boolean,
        default: false,
      },
      notes: String,
      customData: Schema.Types.Mixed,
    },

    // ========================
    // COMPLIANCE
    // ========================
    compliance: {
      taxDocumentId: String,
      invoiceRequired: {
        type: Boolean,
        default: false,
      },
      invoiceSent: {
        type: Boolean,
        default: false,
      },
      invoiceSentAt: Date,
      vatNumber: String,
      taxExempt: {
        type: Boolean,
        default: false,
      },
      companyName: String,
      billingAddress: {
        line1: String,
        line2: String,
        city: String,
        state: String,
        postalCode: String,
        country: String,
      },
    },

    // ========================
    // INTERNAL FLAGS
    // ========================
    isDisputed: {
      type: Boolean,
      default: false,
    },

    disputeDetails: {
      reason: String,
      status: String,
      openedAt: Date,
      resolvedAt: Date,
      outcome: String,
    },

    requiresAction: {
      type: Boolean,
      default: false,
    },

    actionRequired: {
      type: String,
      enum: ['verification', 'confirmation', 'payment_method', 'review'],
    },

    isReconciled: {
      type: Boolean,
      default: false,
    },

    reconciledAt: Date,

    // ========================
    // VERSIONING
    // ========================
    version: {
      type: Number,
      default: 1,
    },
  },
  {
    timestamps: true,
    collection: 'transactions',
  }
);

// ========================
// INDEXES
// ========================
transactionSchema.index({ userId: 1, createdAt: -1 });
transactionSchema.index({ provider: 1, providerTransactionId: 1 });
transactionSchema.index({ subscriptionId: 1, type: 1 });
transactionSchema.index({ status: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ 'refund.status': 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ amount: 1 });
transactionSchema.index({ 'fraudDetection.status': 1 });
transactionSchema.index({ provider: 1, status: 1, createdAt: -1 });

// Compound indexes for common queries
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ userId: 1, subscriptionId: 1, type: 1 });

// ========================
// VIRTUAL FIELDS
// ========================
transactionSchema.virtual('displayAmount').get(function() {
  return (this.amount / 100).toFixed(2);
});

transactionSchema.virtual('displayFinalAmount').get(function() {
  return (this.finalAmount / 100).toFixed(2);
});

transactionSchema.virtual('isSuccess').get(function() {
  return this.status === TRANSACTION_STATUS.SUCCESS;
});

transactionSchema.virtual('isPending').get(function() {
  return this.status === TRANSACTION_STATUS.PENDING || 
         this.status === TRANSACTION_STATUS.PROCESSING;
});

transactionSchema.virtual('isFailed').get(function() {
  return this.status === TRANSACTION_STATUS.FAILED || 
         this.status === TRANSACTION_STATUS.EXPIRED;
});

transactionSchema.virtual('isRefunded').get(function() {
  return this.status === TRANSACTION_STATUS.REFUNDED || 
         this.status === TRANSACTION_STATUS.PARTIALLY_REFUNDED;
});

transactionSchema.virtual('refundEligible').get(function() {
  if (!this.isRefundable || this.isRefunded) return false;
  if (!this.refundDeadline) return true;
  return new Date() <= this.refundDeadline;
});

transactionSchema.virtual('daysUntilRefundDeadline').get(function() {
  if (!this.refundDeadline) return null;
  const days = Math.ceil((this.refundDeadline - new Date()) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
});

// ========================
// INSTANCE METHODS
// ========================

/**
 * Process transaction
 */
transactionSchema.methods.process = async function() {
  this.status = TRANSACTION_STATUS.PROCESSING;
  this.processedAt = new Date();
  return this.save();
};

/**
 * Mark as successful
 */
transactionSchema.methods.markAsSuccess = async function() {
  this.status = TRANSACTION_STATUS.SUCCESS;
  this.completedAt = new Date();
  this.metrics.processingTime = this.completedAt - this.createdAt;
  return this.save();
};

/**
 * Mark as failed
 */
transactionSchema.methods.markAsFailed = async function(error) {
  this.status = TRANSACTION_STATUS.FAILED;
  this.failedAt = new Date();
  this.error = {
    code: error.code || 'UNKNOWN',
    message: error.message,
    details: error.details || {},
    occurredAt: new Date(),
    retryCount: this.error?.retryCount || 0,
  };
  return this.save();
};

/**
 * Retry transaction
 */
transactionSchema.methods.retry = async function() {
  if (!this.error) {
    this.error = { retryCount: 0 };
  }
  
  this.error.retryCount += 1;
  this.error.lastRetryAt = new Date();
  this.status = TRANSACTION_STATUS.PENDING;
  
  return this.save();
};

/**
 * Process refund
 */
transactionSchema.methods.processRefund = async function(amount, reason, details = {}) {
  if (!this.refundEligible) {
    throw new Error('Transaction not eligible for refund');
  }

  const refundAmount = amount || this.finalAmount;
  
  this.refund = {
    amount: refundAmount,
    reason,
    status: REFUND_CONFIG.STATUS.PENDING,
    requestedAt: new Date(),
    ...details,
  };

  if (refundAmount < this.finalAmount) {
    this.status = TRANSACTION_STATUS.PARTIALLY_REFUNDED;
    this.partialRefundAmount = refundAmount;
  } else {
    this.status = TRANSACTION_STATUS.REFUNDED;
  }

  return this.save();
};

/**
 * Complete refund
 */
transactionSchema.methods.completeRefund = async function(providerRefundId) {
  if (!this.refund) {
    throw new Error('No refund request found');
  }

  this.refund.status = REFUND_CONFIG.STATUS.PROCESSED;
  this.refund.processedAt = new Date();
  this.refund.providerRefundId = providerRefundId;

  return this.save();
};

/**
 * Add fraud check
 */
transactionSchema.methods.addFraudCheck = async function(checkType, result, details) {
  if (!this.fraudDetection.checks) {
    this.fraudDetection.checks = [];
  }

  this.fraudDetection.checks.push({
    type: checkType,
    result,
    details,
  });

  // Update fraud score based on checks
  const failedChecks = this.fraudDetection.checks.filter(c => !c.result).length;
  const totalChecks = this.fraudDetection.checks.length;
  
  this.fraudDetection.score = Math.round((failedChecks / totalChecks) * 100);
  
  // Update status based on score
  if (this.fraudDetection.score >= 70) {
    this.fraudDetection.status = 'blocked';
  } else if (this.fraudDetection.score >= 40) {
    this.fraudDetection.status = 'flagged';
  } else if (this.fraudDetection.score >= 20) {
    this.fraudDetection.status = 'review';
  } else {
    this.fraudDetection.status = 'safe';
  }

  return this.save();
};

/**
 * Check if refund eligible
 */
transactionSchema.methods.isRefundEligible = function() {
  // Not eligible if already refunded
  if (this.isRefunded) return false;
  
  // Not eligible if not refundable
  if (!this.isRefundable) return false;
  
  // Not eligible if transaction failed
  if (this.isFailed) return false;
  
  // Check deadline
  if (this.refundDeadline && new Date() > this.refundDeadline) {
    return false;
  }
  
  return true;
};

/**
 * Generate invoice
 */
transactionSchema.methods.generateInvoice = async function() {
  // Generate unique invoice ID
  this.invoiceId = `INV-${Date.now()}-${this._id.toString().slice(-6)}`;
  
  // Mark invoice as required
  this.compliance.invoiceRequired = true;
  
  return this.save();
};

// ========================
// STATIC METHODS
// ========================

/**
 * Find transactions by user
 */
transactionSchema.statics.findByUser = async function(userId, options = {}) {
  const query = { userId };
  
  if (options.type) query.type = options.type;
  if (options.status) query.status = options.status;
  if (options.provider) query.provider = options.provider;
  
  if (options.startDate || options.endDate) {
    query.createdAt = {};
    if (options.startDate) query.createdAt.$gte = options.startDate;
    if (options.endDate) query.createdAt.$lte = options.endDate;
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .skip(options.offset || 0);
};

/**
 * Get revenue statistics
 */
transactionSchema.statics.getRevenueStats = async function(startDate, endDate) {
  const pipeline = [
    {
      $match: {
        status: TRANSACTION_STATUS.SUCCESS,
        createdAt: { $gte: startDate, $lte: endDate },
      },
    },
    {
      $group: {
        _id: {
          type: '$type',
          provider: '$provider',
        },
        count: { $sum: 1 },
        totalAmount: { $sum: '$finalAmount' },
        avgAmount: { $avg: '$finalAmount' },
        minAmount: { $min: '$finalAmount' },
        maxAmount: { $max: '$finalAmount' },
      },
    },
    {
      $sort: { totalAmount: -1 },
    },
  ];
  
  return this.aggregate(pipeline);
};

/**
 * Get pending transactions
 */
transactionSchema.statics.getPendingTransactions = async function(provider = null) {
  const query = {
    status: { $in: [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] },
  };
  
  if (provider) query.provider = provider;
  
  return this.find(query).sort({ createdAt: 1 });
};

/**
 * Get transactions requiring action
 */
transactionSchema.statics.getRequiringAction = async function() {
  return this.find({
    requiresAction: true,
    status: { $nin: [TRANSACTION_STATUS.FAILED, TRANSACTION_STATUS.REFUNDED] },
  }).sort({ createdAt: 1 });
};

/**
 * Get refund requests
 */
transactionSchema.statics.getPendingRefunds = async function() {
  return this.find({
    'refund.status': REFUND_CONFIG.STATUS.PENDING,
  }).sort({ 'refund.requestedAt': 1 });
};

/**
 * Check for duplicate transaction
 */
transactionSchema.statics.checkDuplicate = async function(provider, providerTransactionId) {
  const existing = await this.findOne({
    provider,
    providerTransactionId,
  });
  
  return existing !== null;
};

/**
 * Get user spending
 */
transactionSchema.statics.getUserSpending = async function(userId, period = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - period);
  
  const result = await this.aggregate([
    {
      $match: {
        userId: mongoose.Types.ObjectId(userId),
        status: TRANSACTION_STATUS.SUCCESS,
        createdAt: { $gte: startDate },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$finalAmount' },
        count: { $sum: 1 },
        avgTransaction: { $avg: '$finalAmount' },
      },
    },
  ]);
  
  return result[0] || { total: 0, count: 0, avgTransaction: 0 };
};

// ========================
// MIDDLEWARE
// ========================

/**
 * Pre-save middleware
 */
transactionSchema.pre('save', async function(next) {
  // Calculate final amount if not set
  if (this.isNew && !this.finalAmount) {
    let finalAmount = this.amount;
    
    // Add tax
    if (this.tax?.amount) {
      finalAmount += this.tax.amount;
    }
    
    // Subtract discount
    if (this.discount?.amount) {
      finalAmount -= this.discount.amount;
    }
    
    this.finalAmount = Math.max(0, finalAmount);
  }
  
  // Calculate amount in USD
  if (this.isNew && !this.amountInUSD) {
    this.amountInUSD = Math.round(this.finalAmount * (this.exchangeRate || 1));
  }
  
  // Set refund deadline for eligible transactions
  if (this.isNew && this.isRefundable && !this.refundDeadline) {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 30); // 30 days default
    this.refundDeadline = deadline;
  }
  
  // Update items total price
  if (this.items && this.items.length > 0) {
    this.items.forEach(item => {
      if (!item.totalPrice) {
        item.totalPrice = item.unitPrice * item.quantity;
      }
    });
  }
  
  next();
});

/**
 * Post-save middleware - Update related models
 */
transactionSchema.post('save', async function(doc) {
  // Update user stats if successful
  if (doc.status === TRANSACTION_STATUS.SUCCESS && doc.wasNew) {
    const User = mongoose.model('User');
    await User.findByIdAndUpdate(doc.userId, {
      $inc: {
        'stats.totalSpent': doc.finalAmount,
        'stats.transactionCount': 1,
      },
    });
  }
  
  // Update subscription if renewal
  if (doc.type === TRANSACTION_TYPES.RENEWAL && doc.subscriptionId) {
    const Subscription = mongoose.model('Subscription');
    await Subscription.findByIdAndUpdate(doc.subscriptionId, {
      $inc: { 'totalPaidAmount': doc.finalAmount },
      $set: { 'lastPaymentDate': doc.completedAt || doc.createdAt },
    });
  }
});

// ========================
// MODEL EXPORT
// ========================
const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;