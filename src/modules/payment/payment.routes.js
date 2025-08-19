// src/modules/payment/payment.routes.js

import express from 'express';
import PaymentController from './payment.controller.js';
import {
  validate,
  createSubscriptionSchema,
  updateSubscriptionSchema,
  cancelSubscriptionSchema,
  pauseSubscriptionSchema,
  resumeSubscriptionSchema,
  purchaseItemsSchema,
  verifyGooglePurchaseSchema,
  verifyAppleReceiptSchema,
  addPaymentMethodSchema,
  updatePaymentMethodSchema,
  removePaymentMethodSchema,
  requestRefundSchema,
  applyPromoCodeSchema,
  getTransactionsQuerySchema,
  getInvoicesQuerySchema,
  createBillingPortalSchema,
} from './payment.validation.js';
import { authenticate, authorize } from '../../shared/middleware/auth.middleware.js';
import { rateLimiter } from '../../shared/middleware/rateLimiter.js';
import { cache, clearCache } from '../../shared/middleware/cache.middleware.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { checkSubscription } from '../../shared/middleware/subscription.middleware.js';

const router = express.Router();

/**
 * Payment Routes
 * All routes require authentication unless specified
 */

// Apply authentication to all routes
router.use(authenticate);

// ============================
// SUBSCRIPTION ROUTES
// ============================

/**
 * @route   GET /api/payment/subscription
 * @desc    Get current subscription
 * @access  Private
 */
router.get(
  '/subscription',
  cache('subscription', 300), // Cache for 5 minutes
  PaymentController.getSubscription
);

/**
 * @route   POST /api/payment/subscription
 * @desc    Create new subscription
 * @access  Private
 */
router.post(
  '/subscription',
  rateLimiter('payment', 5, 60),
  (req, res) => {
    // Redirect to mobile app stores
    return res.status(400).json({
      success: false,
      message: 'Please use the mobile app to manage subscriptions',
      stores: {
        ios: 'https://apps.apple.com/app/your-app-id',
        android: 'https://play.google.com/store/apps/details?id=com.yourapp',
      },
    });
  }
);

/**
 * @route   PUT /api/payment/subscription
 * @desc    Update subscription (upgrade/downgrade)
 * @access  Private
 */
router.put(
  '/subscription',
  rateLimiter('payment', 5, 60),
  validate(updateSubscriptionSchema),
  clearCache(['subscription:*', 'user:*']),
  PaymentController.updateSubscription
);

/**
 * @route   DELETE /api/payment/subscription
 * @desc    Cancel subscription
 * @access  Private
 */
router.delete(
  '/subscription',
  rateLimiter('payment', 3, 60),
  validate(cancelSubscriptionSchema),
  clearCache(['subscription:*', 'user:*']),
  PaymentController.cancelSubscription
);

/**
 * @route   POST /api/payment/subscription/pause
 * @desc    Pause subscription
 * @access  Private (Premium only)
 */
router.post(
  '/subscription/pause',
  checkSubscription(['plus', 'gold', 'platinum']),
  rateLimiter('payment', 3, 60),
  validate(pauseSubscriptionSchema),
  clearCache(['subscription:*']),
  PaymentController.pauseSubscription
);

/**
 * @route   POST /api/payment/subscription/resume
 * @desc    Resume paused subscription
 * @access  Private
 */
router.post(
  '/subscription/resume',
  rateLimiter('payment', 3, 60),
  validate(resumeSubscriptionSchema),
  clearCache(['subscription:*']),
  PaymentController.resumeSubscription
);

/**
 * @route   POST /api/payment/subscription/preview
 * @desc    Preview subscription change (proration)
 * @access  Private
 */
router.post(
  '/subscription/preview',
  validate(updateSubscriptionSchema),
  PaymentController.previewSubscriptionChange
);

// ============================
// ONE-TIME PURCHASE ROUTES
// ============================

/**
 * @route   GET /api/payment/purchase/options
 * @desc    Get available purchase options
 * @access  Private
 */
router.get(
  '/purchase/options',
  cache('purchase-options', 3600), // Cache for 1 hour
  PaymentController.getPurchaseOptions
);

/**
 * @route   POST /api/payment/purchase
 * @desc    Make one-time purchase
 * @access  Private
 */
const purchaseValidationSchema = Joi.object({
  provider: Joi.string()
    .valid('google', 'apple')
    .required(),
  
  // Google fields
  purchaseToken: Joi.when('provider', {
    is: 'google',
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
  
  productId: Joi.when('provider', {
    is: 'google', 
    then: Joi.string().required(),
    otherwise: Joi.optional(),
  }),
  
  // Apple fields
  receiptData: Joi.when('provider', {
    is: 'apple',
    then: Joi.string().required(),
    otherwise: Joi.forbidden(),
  }),
});

router.post(
  '/purchase',
  rateLimiter('payment', 10, 60),
  validate(purchaseValidationSchema),
  clearCache(['user:*']),
  PaymentController.purchaseItems
);

// ============================
// IN-APP PURCHASE VERIFICATION
// ============================

/**
 * @route   POST /api/payment/verify/google
 * @desc    Verify Google Play purchase
 * @access  Private
 */
router.post(
  '/verify/google',
  rateLimiter('iap', 20, 60), // 20 requests per minute
  validate(verifyGooglePurchaseSchema),
  clearCache(['subscription:*', 'user:*']),
  PaymentController.verifyGooglePurchase
);

/**
 * @route   POST /api/payment/verify/apple
 * @desc    Verify Apple receipt
 * @access  Private
 */
router.post(
  '/verify/apple',
  rateLimiter('iap', 20, 60),
  validate(verifyAppleReceiptSchema),
  clearCache(['subscription:*', 'user:*']),
  PaymentController.verifyAppleReceipt
);

// ============================
// PAYMENT METHOD ROUTES
// ============================

/**
 * @route   GET /api/payment/methods
 * @desc    Get payment methods
 * @access  Private
 */
router.get(
  '/methods',
  cache('payment-methods', 600), // Cache for 10 minutes
  PaymentController.getPaymentMethods
);

/**
 * @route   POST /api/payment/methods
 * @desc    Add payment method
 * @access  Private
 */
router.post(
  '/methods',
  rateLimiter('payment', 5, 60),
  validate(addPaymentMethodSchema),
  clearCache(['payment-methods:*']),
  PaymentController.addPaymentMethod
);

/**
 * @route   PUT /api/payment/methods/:methodId
 * @desc    Update payment method
 * @access  Private
 */
router.put(
  '/methods/:methodId',
  rateLimiter('payment', 5, 60),
  validate(updatePaymentMethodSchema),
  clearCache(['payment-methods:*']),
  PaymentController.updatePaymentMethod
);

/**
 * @route   DELETE /api/payment/methods/:methodId
 * @desc    Remove payment method
 * @access  Private
 */
router.delete(
  '/methods/:methodId',
  rateLimiter('payment', 3, 60),
  validate(removePaymentMethodSchema),
  clearCache(['payment-methods:*']),
  PaymentController.removePaymentMethod
);

// ============================
// TRANSACTION ROUTES
// ============================

/**
 * @route   GET /api/payment/transactions
 * @desc    Get transaction history
 * @access  Private
 */
router.get(
  '/transactions',
  validate(getTransactionsQuerySchema, 'query'),
  cache('transactions', 300),
  PaymentController.getTransactions
);

/**
 * @route   GET /api/payment/transactions/:transactionId
 * @desc    Get transaction details
 * @access  Private
 */
router.get(
  '/transactions/:transactionId',
  PaymentController.getTransactionDetails
);

/**
 * @route   GET /api/payment/invoices/:invoiceId
 * @desc    Download invoice
 * @access  Private
 */
router.get(
  '/invoices/:invoiceId',
  rateLimiter('download', 10, 60),
  PaymentController.downloadInvoice
);

// ============================
// REFUND ROUTES
// ============================

/**
 * @route   POST /api/payment/refund
 * @desc    Request refund
 * @access  Private
 */
router.post(
  '/refund',
  rateLimiter('refund', 3, 3600), // 3 requests per hour
  validate(requestRefundSchema),
  clearCache(['transactions:*']),
  PaymentController.requestRefund
);

/**
 * @route   GET /api/payment/refund/:transactionId
 * @desc    Get refund status
 * @access  Private
 */
router.get(
  '/refund/:transactionId',
  PaymentController.getRefundStatus
);

// ============================
// PROMO CODE ROUTES
// ============================

/**
 * @route   POST /api/payment/promo
 * @desc    Apply promo code
 * @access  Private
 */
router.post(
  '/promo',
  rateLimiter('promo', 10, 60),
  validate(applyPromoCodeSchema),
  PaymentController.applyPromoCode
);

/**
 * @route   GET /api/payment/promo/:code
 * @desc    Validate promo code
 * @access  Private
 */
router.get(
  '/promo/:code',
  cache('promo', 600),
  PaymentController.validatePromoCode
);

// ============================
// WEBHOOK ROUTES (No authentication)
// ============================



/**
 * @route   POST /api/payment/webhooks/google
 * @desc    Google Play webhook endpoint
 * @access  Public (verified by signature)
 */
router.post(
  '/webhooks/google',
  express.json(),
  asyncHandler(async (req, res) => {
    const GoogleWebhookHandler = await import('./webhooks/google.webhook.js');
    return GoogleWebhookHandler.default.handleWebhook(req, res);
  })
);

/**
 * @route   POST /api/payment/webhooks/apple
 * @desc    Apple webhook endpoint
 * @access  Public (verified by signature)
 */
router.post(
  '/webhooks/apple',
  express.json(),
  asyncHandler(async (req, res) => {
    const AppleWebhookHandler = await import('./webhooks/apple.webhook.js');
    return AppleWebhookHandler.default.handleWebhook(req, res);
  })
);

// ============================
// ADMIN ROUTES
// ============================

/**
 * Admin routes group
 * All require admin authorization
 */
const adminRouter = express.Router();
adminRouter.use(authorize(['admin', 'superadmin']));

/**
 * @route   GET /api/payment/admin/revenue
 * @desc    Get revenue statistics
 * @access  Admin
 */
adminRouter.get(
  '/revenue',
  validate(getInvoicesQuerySchema, 'query'),
  cache('admin-revenue', 3600),
  PaymentController.getRevenueStats
);

/**
 * @route   POST /api/payment/admin/grant
 * @desc    Grant subscription to user
 * @access  Admin
 */
adminRouter.post(
  '/grant',
  rateLimiter('admin', 20, 60),
  clearCache(['subscription:*', 'user:*']),
  PaymentController.grantSubscription
);

/**
 * @route   GET /api/payment/admin/subscriptions
 * @desc    Get all subscriptions
 * @access  Admin
 */
adminRouter.get(
  '/subscriptions',
  cache('admin-subscriptions', 600),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status, planType } = req.query;
    
    const Subscription = await import('./subscription.model.js').then(m => m.default);
    
    const query = {};
    if (status) query.status = status;
    if (planType) query.planType = planType;
    
    const subscriptions = await Subscription.find(query)
      .populate('userId', 'profile.firstName profile.lastName email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();
    
    const total = await Subscription.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        subscriptions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  })
);

/**
 * @route   GET /api/payment/admin/transactions
 * @desc    Get all transactions
 * @access  Admin
 */
adminRouter.get(
  '/transactions',
  cache('admin-transactions', 600),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, type, status, startDate, endDate } = req.query;
    
    const Transaction = await import('./transaction.model.js').then(m => m.default);
    
    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    const transactions = await Transaction.find(query)
      .populate('userId', 'profile.firstName profile.lastName email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();
    
    const total = await Transaction.countDocuments(query);
    
    res.json({
      success: true,
      data: {
        transactions,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      },
    });
  })
);

/**
 * @route   POST /api/payment/admin/refund/:transactionId
 * @desc    Process refund (Admin)
 * @access  Admin
 */
adminRouter.post(
  '/refund/:transactionId',
  rateLimiter('admin', 10, 60),
  clearCache(['transactions:*']),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;
    const { amount, reason } = req.body;
    
    const Transaction = await import('./transaction.model.js').then(m => m.default);
    const transaction = await Transaction.findById(transactionId);
    
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found',
      });
    }
    
    const result = await PaymentService.processRefund(
      transaction.userId,
      transactionId,
      { reason: reason || 'admin_refund', amount }
    );
    
    res.json({
      success: true,
      data: result,
    });
  })
);

/**
 * @route   POST /api/payment/admin/subscription/:subscriptionId/cancel
 * @desc    Cancel subscription (Admin)
 * @access  Admin
 */
adminRouter.post(
  '/subscription/:subscriptionId/cancel',
  rateLimiter('admin', 10, 60),
  clearCache(['subscription:*', 'user:*']),
  asyncHandler(async (req, res) => {
    const { subscriptionId } = req.params;
    const { immediate = false, reason = 'admin_action' } = req.body;
    
    const Subscription = await import('./subscription.model.js').then(m => m.default);
    const subscription = await Subscription.findById(subscriptionId);
    
    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'Subscription not found',
      });
    }
    
    const result = await PaymentService.cancelSubscription(
      subscription.userId,
      { reason, immediate, feedback: `Cancelled by admin: ${req.user._id}` }
    );
    
    res.json({
      success: true,
      data: result,
    });
  })
);

// Mount admin routes
router.use('/admin', adminRouter);

// ============================
// HEALTH CHECK
// ============================

/**
 * @route   GET /api/payment/health
 * @desc    Health check endpoint
 * @access  Public
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Payment service is healthy',
    timestamp: new Date().toISOString(),
  });
});

// ============================
// ERROR HANDLING
// ============================

/**
 * 404 handler for undefined routes
 */
router.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Payment endpoint not found',
    path: req.originalUrl,
  });
});

/**
 * Error handler middleware
 */
router.use((error, req, res, next) => {
  logger.error('Payment route error:', {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
  });

  // Handle Stripe errors
  if (error.type === 'StripeCardError') {
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }

  // Handle validation errors
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation error',
      errors: Object.values(error.errors).map(e => ({
        field: e.path,
        message: e.message,
      })),
    });
  }

  // Default error response
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
});

export default router;