// src/modules/payment/payment.controller.js

import PaymentService from './payment.service.js';
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
import {
  PAYMENT_ERRORS,
  PAYMENT_SUCCESS,
  STRIPE_CONFIG,
} from './payment.constants.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import {
  successResponse,
  errorResponse,
  badRequestResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
} from '../../shared/utils/responseHandler.js';
import logger from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/errors.js';
import MetricsService from '../../shared/services/metrics.service.js';
import CacheService from '../../shared/services/cache.service.js';
import Stripe from 'stripe';

/**
 * Payment Controller
 * Handles all payment-related HTTP requests
 */
class PaymentController {
  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_CONFIG.API_VERSION,
    });
  }

  // ========================
  // SUBSCRIPTION ENDPOINTS
  // ========================

  /**
   * Create subscription
   * @route POST /api/payment/subscription
   */
  createSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { planType, billingCycle, paymentMethodId, provider, promoCode } = req.body;

    logger.info('Creating subscription:', { userId, planType, billingCycle });

    // Track initiation
    await MetricsService.trackEvent('subscription_initiated', {
      userId,
      planType,
      billingCycle,
    });

    const result = await PaymentService.createSubscription(userId, {
      planType,
      billingCycle,
      paymentMethodId,
      provider,
      promoCode,
    });

    return successResponse(res, result, PAYMENT_SUCCESS.SUBSCRIPTION_CREATED, 201);
  });

  /**
   * Get current subscription
   * @route GET /api/payment/subscription
   */
  getSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const subscription = await PaymentService.getUserSubscription(userId);
    
    if (!subscription) {
      return successResponse(res, {
        hasSubscription: false,
        planType: 'free',
        message: 'No active subscription',
      });
    }

    // Calculate additional info
    const daysRemaining = Math.ceil(
      (new Date(subscription.currentPeriodEnd) - new Date()) / (1000 * 60 * 60 * 24)
    );

    return successResponse(res, {
      subscription,
      daysRemaining,
      canPause: subscription.canPause(),
      canCancel: subscription.canCancel(),
    });
  });

  /**
   * Update subscription plan
   * @route PUT /api/payment/subscription
   */
  updateSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { action, newPlanType, newBillingCycle, immediate } = req.body;

    logger.info('Updating subscription:', { userId, action, newPlanType });

    // Calculate proration if changing plan
    let proration = null;
    if (action !== 'change_billing_cycle') {
      proration = await PaymentService.calculateProration(
        userId,
        newPlanType,
        newBillingCycle || req.user.subscription?.billingCycle
      );
    }

    const result = await PaymentService.changeSubscriptionPlan(userId, {
      newPlanType: newPlanType || req.user.subscription?.planType,
      newBillingCycle: newBillingCycle || req.user.subscription?.billingCycle,
    });

    return successResponse(res, {
      ...result,
      proration,
    }, PAYMENT_SUCCESS.SUBSCRIPTION_UPDATED);
  });

  /**
   * Cancel subscription
   * @route DELETE /api/payment/subscription
   */
  cancelSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { reason, feedback, immediate, confirmCancellation } = req.body;

    if (!confirmCancellation) {
      return badRequestResponse(res, 'Please confirm the cancellation');
    }

    logger.info('Cancelling subscription:', { userId, reason, immediate });

    const result = await PaymentService.cancelSubscription(userId, {
      reason,
      feedback,
      immediate,
    });

    return successResponse(res, result, PAYMENT_SUCCESS.SUBSCRIPTION_CANCELLED);
  });

  /**
   * Pause subscription
   * @route POST /api/payment/subscription/pause
   */
  pauseSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { pauseUntil, reason, customReason } = req.body;

    logger.info('Pausing subscription:', { userId, pauseUntil, reason });

    const result = await PaymentService.pauseSubscription(userId, {
      pauseUntil: new Date(pauseUntil),
      reason: reason === 'other' ? customReason : reason,
    });

    return successResponse(res, result, PAYMENT_SUCCESS.SUBSCRIPTION_PAUSED);
  });

  /**
   * Resume subscription
   * @route POST /api/payment/subscription/resume
   */
  resumeSubscription = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { confirmResume } = req.body;

    if (!confirmResume) {
      return badRequestResponse(res, 'Please confirm the subscription resume');
    }

    logger.info('Resuming subscription:', { userId });

    const result = await PaymentService.resumeSubscription(userId);

    return successResponse(res, result, PAYMENT_SUCCESS.SUBSCRIPTION_RESUMED);
  });

  /**
   * Preview subscription change
   * @route POST /api/payment/subscription/preview
   */
  previewSubscriptionChange = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { newPlanType, newBillingCycle } = req.body;

    const currentSubscription = await PaymentService.getUserSubscription(userId);
    
    if (!currentSubscription) {
      return badRequestResponse(res, 'No active subscription to change');
    }

    // Calculate proration
    const proration = await PaymentService.calculateProration(
      userId,
      newPlanType,
      newBillingCycle
    );

    // Get new plan features
    const { SUBSCRIPTION_FEATURES_CONFIG, SUBSCRIPTION_PRICING } = await import('./payment.constants.js');
    const newFeatures = SUBSCRIPTION_FEATURES_CONFIG[newPlanType];
    const newPricing = SUBSCRIPTION_PRICING[newPlanType][newBillingCycle];

    return successResponse(res, {
      current: {
        planType: currentSubscription.planType,
        billingCycle: currentSubscription.billingCycle,
        amount: currentSubscription.amount,
      },
      new: {
        planType: newPlanType,
        billingCycle: newBillingCycle,
        amount: newPricing.amount,
        features: newFeatures,
      },
      proration,
      effectiveDate: immediate ? new Date() : currentSubscription.currentPeriodEnd,
    });
  });

  // ========================
  // ONE-TIME PURCHASES
  // ========================

  /**
   * Purchase items
   * @route POST /api/payment/purchase
   */
  purchaseItems = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { itemType, packSize, paymentMethodId, provider, savePaymentMethod } = req.body;

    logger.info('Processing purchase:', { userId, itemType, packSize });

    // Track initiation
    await MetricsService.trackEvent('purchase_initiated', {
      userId,
      itemType,
      packSize,
    });

    const result = await PaymentService.purchaseItems(userId, {
      itemType,
      packSize,
      paymentMethodId,
      provider,
    });

    // Save payment method if requested
    if (savePaymentMethod && paymentMethodId) {
      await PaymentService.addPaymentMethod(userId, {
        type: 'card',
        token: paymentMethodId,
        setAsDefault: false,
      });
    }

    return successResponse(res, result, PAYMENT_SUCCESS.PAYMENT_COMPLETED, 201);
  });

  /**
   * Get purchase options
   * @route GET /api/payment/purchase/options
   */
  getPurchaseOptions = asyncHandler(async (req, res) => {
    const { ONE_TIME_PURCHASES } = await import('./payment.constants.js');
    
    const options = {
      superLikes: Object.entries(ONE_TIME_PURCHASES.superLikes).map(([key, value]) => ({
        id: key,
        ...value,
        perUnit: (value.amount / value.quantity / 100).toFixed(2),
      })),
      boosts: Object.entries(ONE_TIME_PURCHASES.boosts).map(([key, value]) => ({
        id: key,
        ...value,
        perUnit: value.quantity > 1 ? (value.amount / value.quantity / 100).toFixed(2) : (value.amount / 100).toFixed(2),
      })),
      readReceipts: Object.entries(ONE_TIME_PURCHASES.readReceipts).map(([key, value]) => ({
        id: key,
        ...value,
        perUnit: (value.amount / value.quantity / 100).toFixed(2),
      })),
    };

    return successResponse(res, options);
  });

  // ========================
  // IN-APP PURCHASE VERIFICATION
  // ========================

  /**
   * Verify Google Play purchase
   * @route POST /api/payment/verify/google
   */
  verifyGooglePurchase = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { purchaseToken, productId, orderId } = req.body;

    logger.info('Verifying Google Play purchase:', { userId, productId, orderId });

    const result = await PaymentService.verifyGooglePlayPurchase(userId, {
      purchaseToken,
      productId,
      orderId,
    });

    return successResponse(res, result, 'Purchase verified successfully');
  });

  /**
   * Verify Apple receipt
   * @route POST /api/payment/verify/apple
   */
  verifyAppleReceipt = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { receiptData, sandbox } = req.body;

    logger.info('Verifying Apple receipt:', { userId, sandbox });

    const result = await PaymentService.verifyAppleReceipt(userId, {
      receiptData,
      sandbox,
    });

    return successResponse(res, result, 'Receipt verified successfully');
  });

  // ========================
  // PAYMENT METHODS
  // ========================

  /**
   * Get payment methods
   * @route GET /api/payment/methods
   */
  getPaymentMethods = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    const methods = await PaymentService.getPaymentMethods(userId);

    return successResponse(res, {
      paymentMethods: methods,
      hasPaymentMethod: methods.length > 0,
    });
  });

  /**
   * Add payment method
   * @route POST /api/payment/methods
   */
  addPaymentMethod = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { type, token, setAsDefault, billingDetails } = req.body;

    logger.info('Adding payment method:', { userId, type });

    const result = await PaymentService.addPaymentMethod(userId, {
      type,
      token,
      setAsDefault,
      billingDetails,
    });

    return successResponse(res, result, PAYMENT_SUCCESS.PAYMENT_METHOD_ADDED, 201);
  });

  /**
   * Update payment method
   * @route PUT /api/payment/methods/:methodId
   */
  updatePaymentMethod = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { methodId } = req.params;
    const { billingDetails, setAsDefault } = req.body;

    logger.info('Updating payment method:', { userId, methodId });

    // Update billing details
    if (billingDetails) {
      await this.stripe.paymentMethods.update(methodId, {
        billing_details: billingDetails,
      });
    }

    // Set as default
    if (setAsDefault) {
      const user = await import('../user/user.model.js').then(m => m.default.findById(userId));
      if (user?.subscription?.stripeCustomerId) {
        await this.stripe.customers.update(user.subscription.stripeCustomerId, {
          invoice_settings: {
            default_payment_method: methodId,
          },
        });
      }
    }

    return successResponse(res, null, PAYMENT_SUCCESS.PAYMENT_METHOD_UPDATED);
  });

  /**
   * Remove payment method
   * @route DELETE /api/payment/methods/:methodId
   */
  removePaymentMethod = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { methodId } = req.params;
    const { confirmRemoval } = req.body;

    if (!confirmRemoval) {
      return badRequestResponse(res, 'Please confirm the payment method removal');
    }

    logger.info('Removing payment method:', { userId, methodId });

    const result = await PaymentService.removePaymentMethod(userId, methodId);

    return successResponse(res, result, PAYMENT_SUCCESS.PAYMENT_METHOD_REMOVED);
  });

  // ========================
  // TRANSACTION HISTORY
  // ========================

  /**
   * Get transaction history
   * @route GET /api/payment/transactions
   */
  getTransactions = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { limit, offset, type, status, startDate, endDate, sortBy, order } = req.query;

    const transactions = await PaymentService.getUserTransactions(userId, {
      limit: parseInt(limit) || 20,
      offset: parseInt(offset) || 0,
      type,
      status,
      startDate,
      endDate,
      sortBy,
      order,
    });

    // Get total count for pagination
    const Transaction = await import('./transaction.model.js').then(m => m.default);
    const totalCount = await Transaction.countDocuments({ userId });

    return successResponse(res, {
      transactions,
      pagination: {
        total: totalCount,
        limit: parseInt(limit) || 20,
        offset: parseInt(offset) || 0,
        hasMore: (parseInt(offset) || 0) + transactions.length < totalCount,
      },
    });
  });

  /**
   * Get transaction details
   * @route GET /api/payment/transactions/:transactionId
   */
  getTransactionDetails = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { transactionId } = req.params;

    const Transaction = await import('./transaction.model.js').then(m => m.default);
    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId,
    });

    if (!transaction) {
      return notFoundResponse(res, 'Transaction not found');
    }

    return successResponse(res, transaction);
  });

  /**
   * Download invoice
   * @route GET /api/payment/invoices/:invoiceId
   */
  downloadInvoice = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { invoiceId } = req.params;

    // Verify invoice belongs to user
    const user = await import('../user/user.model.js').then(m => m.default.findById(userId));
    if (!user?.subscription?.stripeCustomerId) {
      return forbiddenResponse(res, 'No billing account found');
    }

    try {
      // Get invoice from Stripe
      const invoice = await this.stripe.invoices.retrieve(invoiceId);
      
      // Verify invoice belongs to user
      if (invoice.customer !== user.subscription.stripeCustomerId) {
        return forbiddenResponse(res, 'Invoice not found');
      }

      // Return invoice PDF URL
      return successResponse(res, {
        invoiceUrl: invoice.invoice_pdf,
        hostedUrl: invoice.hosted_invoice_url,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        date: new Date(invoice.created * 1000),
      });
    } catch (error) {
      logger.error('Error retrieving invoice:', error);
      return notFoundResponse(res, 'Invoice not found');
    }
  });

  // ========================
  // REFUNDS
  // ========================

  /**
   * Request refund
   * @route POST /api/payment/refund
   */
  requestRefund = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { transactionId, reason, amount, details, confirmRefund } = req.body;

    if (!confirmRefund) {
      return badRequestResponse(res, 'Please confirm the refund request');
    }

    logger.info('Processing refund request:', { userId, transactionId, reason });

    const result = await PaymentService.processRefund(userId, transactionId, {
      reason,
      amount,
      details,
    });

    return successResponse(res, result, PAYMENT_SUCCESS.REFUND_INITIATED);
  });

  /**
   * Get refund status
   * @route GET /api/payment/refund/:transactionId
   */
  getRefundStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { transactionId } = req.params;

    const Transaction = await import('./transaction.model.js').then(m => m.default);
    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId,
    });

    if (!transaction) {
      return notFoundResponse(res, 'Transaction not found');
    }

    const refundStatus = {
      eligible: transaction.isRefundEligible(),
      status: transaction.refund?.status || 'not_requested',
      amount: transaction.refund?.amount,
      processedAt: transaction.refund?.processedAt,
      reason: transaction.refund?.reason,
    };

    return successResponse(res, refundStatus);
  });

  // ========================
  // PROMO CODES
  // ========================

  /**
   * Apply promo code
   * @route POST /api/payment/promo
   */
  applyPromoCode = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { code, subscriptionId } = req.body;

    logger.info('Applying promo code:', { userId, code });

    // Validate promo code
    const promoCode = await PaymentService.validateAndGetStripePromoCode(code);

    // Apply to subscription if provided
    if (subscriptionId) {
      const Subscription = await import('./subscription.model.js').then(m => m.default);
      const subscription = await Subscription.findOne({
        _id: subscriptionId,
        userId,
      });

      if (!subscription) {
        return notFoundResponse(res, 'Subscription not found');
      }

      await subscription.applyDiscount(code, {
        type: 'percentage', // Get from promo code
        value: 20, // Get from promo code
      });

      return successResponse(res, {
        applied: true,
        discount: subscription.discount,
      }, 'Promo code applied successfully');
    }

    // Store for next purchase
    await CacheService.set(`promo:${userId}`, code, 3600); // 1 hour

    return successResponse(res, {
      applied: true,
      code,
      message: 'Promo code will be applied to your next purchase',
    });
  });

  /**
   * Validate promo code
   * @route GET /api/payment/promo/:code
   */
  validatePromoCode = asyncHandler(async (req, res) => {
    const { code } = req.params;

    try {
      const promoCode = await PaymentService.validateAndGetStripePromoCode(code);
      
      return successResponse(res, {
        valid: true,
        code: code.toUpperCase(),
      });
    } catch (error) {
      return successResponse(res, {
        valid: false,
        error: error.message,
      });
    }
  });

  // ========================
  // BILLING PORTAL
  // ========================

  /**
   * Create billing portal session
   * @route POST /api/payment/billing-portal
   */
  createBillingPortalSession = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { returnUrl } = req.body;

    const user = await import('../user/user.model.js').then(m => m.default.findById(userId));
    
    if (!user?.subscription?.stripeCustomerId) {
      return badRequestResponse(res, 'No billing account found');
    }

    // Create Stripe billing portal session
    const session = await this.stripe.billingPortal.sessions.create({
      customer: user.subscription.stripeCustomerId,
      return_url: returnUrl,
    });

    return successResponse(res, {
      url: session.url,
    });
  });

  // ========================
  // CHECKOUT SESSIONS
  // ========================

  /**
   * Create checkout session
   * @route POST /api/payment/checkout
   */
  createCheckoutSession = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { planType, billingCycle, successUrl, cancelUrl } = req.body;

    const user = await import('../user/user.model.js').then(m => m.default.findById(userId));
    const { SUBSCRIPTION_PRICING } = await import('./payment.constants.js');
    
    const pricing = SUBSCRIPTION_PRICING[planType][billingCycle];
    if (!pricing) {
      return badRequestResponse(res, 'Invalid plan or billing cycle');
    }

    // Get or create Stripe customer
    let customerId = user.subscription?.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.customers.create({
        email: user.email,
        name: `${user.profile.firstName} ${user.profile.lastName}`,
        metadata: { userId: userId },
      });
      customerId = customer.id;
    }

    // Get price ID
    const priceId = await PaymentService.getOrCreateStripePrice(planType, billingCycle);

    // Create checkout session
    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: successUrl || STRIPE_CONFIG.SUCCESS_URL,
      cancel_url: cancelUrl || STRIPE_CONFIG.CANCEL_URL,
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: pricing.trialDays || 0,
        metadata: {
          userId,
          planType,
          billingCycle,
        },
      },
      metadata: {
        userId,
        planType,
        billingCycle,
      },
    });

    return successResponse(res, {
      sessionId: session.id,
      url: session.url,
    });
  });

  /**
   * Handle checkout success
   * @route GET /api/payment/checkout/success
   */
  handleCheckoutSuccess = asyncHandler(async (req, res) => {
    const { session_id } = req.query;

    if (!session_id) {
      return badRequestResponse(res, 'Session ID is required');
    }

    // Retrieve session from Stripe
    const session = await this.stripe.checkout.sessions.retrieve(session_id, {
      expand: ['subscription', 'customer'],
    });

    if (session.payment_status !== 'paid') {
      return badRequestResponse(res, 'Payment not completed');
    }

    return successResponse(res, {
      success: true,
      subscription: session.subscription,
      customer: session.customer,
    });
  });

  // ========================
  // ADMIN ENDPOINTS
  // ========================

  /**
   * Get revenue statistics (Admin)
   * @route GET /api/payment/admin/revenue
   */
  getRevenueStats = asyncHandler(async (req, res) => {
    // Check admin permission
    if (req.user.role !== 'admin') {
      return forbiddenResponse(res, 'Admin access required');
    }

    const { startDate, endDate } = req.query;

    const Subscription = await import('./subscription.model.js').then(m => m.default);
    const Transaction = await import('./transaction.model.js').then(m => m.default);

    // Get subscription stats
    const subscriptionStats = await Subscription.getStatistics();

    // Get transaction stats
    const query = {};
    if (startDate) query.createdAt = { $gte: new Date(startDate) };
    if (endDate) query.createdAt = { ...query.createdAt, $lte: new Date(endDate) };

    const transactionStats = await Transaction.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          total: { $sum: '$amount' },
          avgAmount: { $avg: '$amount' },
        },
      },
    ]);

    // Get MRR (Monthly Recurring Revenue)
    const activeSubscriptions = await Subscription.find({
      status: { $in: ['active', 'trialing'] },
    });

    const mrr = activeSubscriptions.reduce((total, sub) => {
      return total + (sub.monthlyAmount || 0);
    }, 0);

    return successResponse(res, {
      subscriptions: subscriptionStats,
      transactions: transactionStats,
      mrr: mrr / 100, // Convert from cents
      totalRevenue: transactionStats.reduce((sum, stat) => sum + stat.total, 0) / 100,
    });
  });

  /**
   * Grant subscription (Admin)
   * @route POST /api/payment/admin/grant
   */
  grantSubscription = asyncHandler(async (req, res) => {
    // Check admin permission
    if (req.user.role !== 'admin') {
      return forbiddenResponse(res, 'Admin access required');
    }

    const { userId, planType, duration, reason } = req.body;

    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + duration);

    // Create manual subscription
    const Subscription = await import('./subscription.model.js').then(m => m.default);
    const subscription = await Subscription.create({
      userId,
      planType,
      billingCycle: 'manual',
      provider: 'admin',
      status: 'active',
      providerSubscriptionId: `admin_${Date.now()}`,
      currentPeriodStart: new Date(),
      currentPeriodEnd: validUntil,
      amount: 0,
      currency: 'USD',
      metadata: {
        grantedBy: req.user._id,
        reason,
      },
    });

    // Update user
    const User = await import('../user/user.model.js').then(m => m.default);
    const user = await User.findById(userId);
    await user.updateSubscription({
      type: planType,
      validUntil,
    });

    logger.info('Subscription granted:', { userId, planType, duration, grantedBy: req.user._id });

    return successResponse(res, {
      subscription,
      message: `${planType} subscription granted for ${duration} days`,
    }, null, 201);
  });
}

// Export singleton instance
export default new PaymentController();