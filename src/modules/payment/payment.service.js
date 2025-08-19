// src/modules/payment/payment.service.js


import { google } from 'googleapis';

import GooglePlayStrategy from './strategies/google.strategy.js';
import AppleIAPStrategy from './strategies/apple.strategy.js';
import Subscription from './subscription.model.js';
import Transaction from './transaction.model.js';
import User from '../user/user.model.js';
import {
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_PRICING,
  ONE_TIME_PURCHASES,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  PAYMENT_PROVIDERS,
  STRIPE_CONFIG,
  GOOGLE_PLAY_CONFIG,
  APPLE_IAP_CONFIG,
  GRACE_PERIOD_CONFIG,
  REFUND_CONFIG,
  PAYMENT_ERRORS,
  PAYMENT_SUCCESS,
  PAYMENT_EVENTS,
  SUBSCRIPTION_FEATURES_CONFIG,
} from './payment.constants.js';
import { AppError } from '../../shared/utils/errors.js';
import logger from '../../shared/utils/logger.js';
import { redis } from '../../config/redis.js';
import QueueService from '../../shared/services/queue.service.js';
import NotificationService from '../notification/notification.service.js';
import EmailService from '../notification/email.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import CacheService from '../../shared/services/cache.service.js';

/**
 * Payment Service
 * Handles all payment operations across different providers
 */
class PaymentService {
constructor() {
  // Initialize strategies
  this.googleStrategy = GooglePlayStrategy;
  this.appleStrategy = AppleIAPStrategy;

  // Cache keys
  this.cacheKeys = {
    subscription: (userId) => `subscription:${userId}`,
    transactions: (userId) => `transactions:${userId}`,
    activePromos: 'promos:active',
  };
}

  /**
   * Initialize Google Play API
   */
  async initializeGooglePlay() {
    try {
      if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT) {
        const auth = new google.auth.GoogleAuth({
          keyFile: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT,
          scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });

        this.googlePlayClient = google.androidpublisher({
          version: 'v3',
          auth,
        });
      }
    } catch (error) {
      logger.error('Failed to initialize Google Play:', error);
    }
  }

  // ========================
  // SUBSCRIPTION MANAGEMENT
  // ========================

  /**
   * Create a new subscription
   */
async createSubscription(userId, { planType, billingCycle, provider, purchaseToken, receiptData }) {
  try {
    // Check for existing active subscription
    const existingSubscription = await Subscription.findActiveByUserId(userId);
    if (existingSubscription) {
      throw new AppError(PAYMENT_ERRORS.SUBSCRIPTION_ALREADY_EXISTS, 400);
    }

    // Mobile subscriptions only
    if (provider === PAYMENT_PROVIDERS.GOOGLE) {
      throw new AppError('Google Play subscriptions must be initiated from the app', 400);
    } else if (provider === PAYMENT_PROVIDERS.APPLE) {
      throw new AppError('Apple subscriptions must be initiated from the app', 400);
    } else {
      throw new AppError('Invalid payment provider. Use Google Play or App Store', 400);
    }
  } catch (error) {
    logger.error('Error creating subscription:', error);
    throw error;
  }
}

  /**
   * Cancel subscription
   */
  async cancelSubscription(userId, { reason, feedback, immediate = false }) {
    try {
      const subscription = await Subscription.findActiveByUserId(userId);
      if (!subscription) {
        throw new AppError(PAYMENT_ERRORS.SUBSCRIPTION_NOT_FOUND, 404);
      }

      if (!subscription.canCancel()) {
        throw new AppError('Cannot cancel subscription in current state', 400);
      }

      // Cancel based on provider
      switch (subscription.provider) {
        
        case PAYMENT_PROVIDERS.GOOGLE:
          // Google subscriptions are cancelled on device
          break;
        
        case PAYMENT_PROVIDERS.APPLE:
          // Apple subscriptions are cancelled on device
          break;
      }

      // Update subscription
      subscription.cancelAtPeriodEnd = !immediate;
      subscription.cancelledAt = new Date();
      subscription.cancellationReason = reason;
      subscription.cancellationFeedback = feedback;
      
      if (immediate) {
        subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
        subscription.currentPeriodEnd = new Date();
      }

      await subscription.addHistory('cancelled', { reason, feedback, immediate });
      await subscription.save();

      // Update user
      const user = await User.findById(userId);
      if (immediate) {
        await user.updateSubscription({
          type: 'free',
          validUntil: null,
        });
      }

      // Clear cache
      await CacheService.invalidateUser(userId);

      // Send notification
      await this.sendSubscriptionNotification(user, 'cancelled', subscription);

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.SUBSCRIPTION_CANCELLED, {
        userId,
        planType: subscription.planType,
        reason,
        immediate,
      });

      logger.info('Subscription cancelled:', subscription._id);

      return {
        success: true,
        message: PAYMENT_SUCCESS.SUBSCRIPTION_CANCELLED,
        effectiveDate: subscription.currentPeriodEnd,
      };
    } catch (error) {
      logger.error('Error cancelling subscription:', error);
      throw error;
    }
  }

  /**
   * Pause subscription
   */
  async pauseSubscription(userId, { pauseUntil, reason }) {
    try {
      const subscription = await Subscription.findActiveByUserId(userId);
      if (!subscription) {
        throw new AppError(PAYMENT_ERRORS.SUBSCRIPTION_NOT_FOUND, 404);
      }

      if (!subscription.canPause()) {
        throw new AppError('Cannot pause subscription', 400);
      }

      // Update subscription
      subscription.status = SUBSCRIPTION_STATUS.PAUSED;
      subscription.pausedAt = new Date();
      subscription.pausedUntil = pauseUntil;
      subscription.pauseReason = reason;
      subscription.pauseCount += 1;

      await subscription.addHistory('paused', { pauseUntil, reason });
      await subscription.save();

      // Send notification
      const user = await User.findById(userId);
      await this.sendSubscriptionNotification(user, 'paused', subscription);

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.SUBSCRIPTION_PAUSED, {
        userId,
        pauseUntil,
        reason,
      });

      return {
        success: true,
        message: PAYMENT_SUCCESS.SUBSCRIPTION_PAUSED,
        resumeDate: pauseUntil,
      };
    } catch (error) {
      logger.error('Error pausing subscription:', error);
      throw error;
    }
  }

  /**
   * Resume paused subscription
   */
  async resumeSubscription(userId) {
    try {
      const subscription = await Subscription.findOne({
        userId,
        status: SUBSCRIPTION_STATUS.PAUSED,
      });

      if (!subscription) {
        throw new AppError('No paused subscription found', 404);
      }
      // Update subscription
      subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
      subscription.pausedAt = null;
      subscription.pausedUntil = null;

      await subscription.addHistory('resumed');
      await subscription.save();

      // Send notification
      const user = await User.findById(userId);
      await this.sendSubscriptionNotification(user, 'resumed', subscription);

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.SUBSCRIPTION_RESUMED, { userId });

      return {
        success: true,
        message: PAYMENT_SUCCESS.SUBSCRIPTION_RESUMED,
      };
    } catch (error) {
      logger.error('Error resuming subscription:', error);
      throw error;
    }
  }

  /**
   * Change subscription plan
   */
  async changeSubscriptionPlan(userId, { newPlanType, newBillingCycle }) {
    try {
      const subscription = await Subscription.findActiveByUserId(userId);
      if (!subscription) {
        throw new AppError(PAYMENT_ERRORS.SUBSCRIPTION_NOT_FOUND, 404);
      }

      const oldPlanType = subscription.planType;
      const oldBillingCycle = subscription.billingCycle;

      // Check if upgrade or downgrade
      const isUpgrade = this.isUpgrade(oldPlanType, newPlanType);

      // Get new pricing
      const newPricing = SUBSCRIPTION_PRICING[newPlanType]?.[newBillingCycle];
      if (!newPricing) {
        throw new AppError('Invalid plan or billing cycle', 400);
      }

      // Update subscription
      subscription.previousPlan = oldPlanType;
      subscription.planType = newPlanType;
      subscription.billingCycle = newBillingCycle;
      subscription.amount = newPricing.amount;
      subscription.features = SUBSCRIPTION_FEATURES_CONFIG[newPlanType];

      if (isUpgrade) {
        subscription.upgradeAvailableAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      } else {
        subscription.downgradedAt = new Date();
      }

      await subscription.addHistory(isUpgrade ? 'upgraded' : 'downgraded', {
        fromPlan: oldPlanType,
        toPlan: newPlanType,
        fromCycle: oldBillingCycle,
        toCycle: newBillingCycle,
      });
      await subscription.save();

      // Update user
      const user = await User.findById(userId);
      await user.updateSubscription({
        type: newPlanType,
        validUntil: subscription.currentPeriodEnd,
      });

      // Clear cache
      await CacheService.invalidateUser(userId);

      // Send notification
      await this.sendSubscriptionNotification(user, isUpgrade ? 'upgraded' : 'downgraded', subscription);

      // Track metrics
      await MetricsService.trackEvent(
        isUpgrade ? PAYMENT_EVENTS.SUBSCRIPTION_UPGRADED : PAYMENT_EVENTS.SUBSCRIPTION_DOWNGRADED,
        {
          userId,
          fromPlan: oldPlanType,
          toPlan: newPlanType,
          fromCycle: oldBillingCycle,
          toCycle: newBillingCycle,
        }
      );

      return {
        success: true,
        message: PAYMENT_SUCCESS.SUBSCRIPTION_UPDATED,
        subscription,
      };
    } catch (error) {
      logger.error('Error changing subscription plan:', error);
      throw error;
    }
  }

  // ========================
  // ONE-TIME PURCHASES
  // ========================

  /**
   * Purchase items (super likes, boosts, etc.)
   */
// Simplify purchaseItems - mobile only
async purchaseItems(userId, { provider, purchaseToken, receiptData, productId }) {
  try {
    logger.info('Processing purchase:', { userId, provider, productId });

    const user = await User.findById(userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    let result = null;

    // Process based on provider
    switch (provider) {
      case PAYMENT_PROVIDERS.GOOGLE:
        result = await this.googleStrategy.verifyProductPurchase(userId, {
          purchaseToken,
          productId,
        });
        break;
      
      case PAYMENT_PROVIDERS.APPLE:
        result = await this.appleStrategy.verifyReceipt(userId, {
          receiptData,
        });
        break;
        
      default:
        throw new AppError('Invalid payment provider', 400);
    }

    return result;
  } catch (error) {
    logger.error('Error processing purchase:', error);
    throw error;
  }
}

  // ========================
  // IN-APP PURCHASE VERIFICATION
  // ========================

  /**
   * Verify Google Play purchase
   */
  async verifyGooglePlayPurchase(userId, { purchaseToken, productId, orderId }) {
    try {
      if (!this.googlePlayClient) {
        throw new AppError('Google Play service not initialized', 500);
      }

      // Verify purchase with Google
      const response = await this.googlePlayClient.purchases.products.get({
        packageName: GOOGLE_PLAY_CONFIG.PACKAGE_NAME,
        productId,
        token: purchaseToken,
      });

      const purchase = response.data;

      // Validate purchase
      if (purchase.purchaseState !== GOOGLE_PLAY_CONFIG.PURCHASE_STATES.PURCHASED) {
        throw new AppError('Purchase not in valid state', 400);
      }

      // Check if already processed
      const existingTransaction = await Transaction.findOne({
        providerTransactionId: orderId,
        provider: PAYMENT_PROVIDERS.GOOGLE,
      });

      if (existingTransaction) {
        throw new AppError('Purchase already processed', 400);
      }

      // Process based on product type
      const result = await this.processVerifiedPurchase(userId, {
        provider: PAYMENT_PROVIDERS.GOOGLE,
        productId,
        orderId,
        purchaseTime: new Date(parseInt(purchase.purchaseTimeMillis)),
      });

      return result;
    } catch (error) {
      logger.error('Google Play verification failed:', error);
      throw error;
    }
  }

  /**
   * Verify Apple receipt
   */
  async verifyAppleReceipt(userId, { receiptData, sandbox = false }) {
    try {
      const verifyUrl = sandbox 
        ? APPLE_IAP_CONFIG.VERIFY_URLS.SANDBOX 
        : APPLE_IAP_CONFIG.VERIFY_URLS.PRODUCTION;

      // Send receipt to Apple
      const response = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receiptData,
          password: process.env.APPLE_SHARED_SECRET,
        }),
      });

      const result = await response.json();

      // Check status
      if (result.status !== APPLE_IAP_CONFIG.STATUS_CODES.SUCCESS) {
        // Try sandbox if production failed
        if (result.status === APPLE_IAP_CONFIG.STATUS_CODES.SANDBOX_RECEIPT_ON_PRODUCTION && !sandbox) {
          return this.verifyAppleReceipt(userId, { receiptData, sandbox: true });
        }
        throw new AppError(`Apple verification failed: ${result.status}`, 400);
      }

      // Get latest receipt info
      const latestReceipt = result.latest_receipt_info?.[0] || result.receipt?.in_app?.[0];
      if (!latestReceipt) {
        throw new AppError('No valid receipt found', 400);
      }

      // Check if already processed
      const existingTransaction = await Transaction.findOne({
        providerTransactionId: latestReceipt.transaction_id,
        provider: PAYMENT_PROVIDERS.APPLE,
      });

      if (existingTransaction) {
        throw new AppError('Receipt already processed', 400);
      }

      // Process verified purchase
      const processResult = await this.processVerifiedPurchase(userId, {
        provider: PAYMENT_PROVIDERS.APPLE,
        productId: latestReceipt.product_id,
        orderId: latestReceipt.transaction_id,
        purchaseTime: new Date(parseInt(latestReceipt.purchase_date_ms)),
        expiresAt: latestReceipt.expires_date_ms 
          ? new Date(parseInt(latestReceipt.expires_date_ms))
          : null,
      });

      return processResult;
    } catch (error) {
      logger.error('Apple receipt verification failed:', error);
      throw error;
    }
  }

  // ========================
  // REFUNDS
  // ========================

  /**
   * Process refund request
   */
  async processRefund(userId, transactionId, { reason, amount = null }) {
    try {
      const transaction = await Transaction.findOne({
        _id: transactionId,
        userId,
      });

      if (!transaction) {
        throw new AppError('Transaction not found', 404);
      }

      // Check refund eligibility
      const daysSincePurchase = Math.floor(
        (Date.now() - transaction.createdAt) / (1000 * 60 * 60 * 24)
      );

      if (daysSincePurchase > REFUND_CONFIG.MAX_REFUND_PERIOD_DAYS) {
        throw new AppError(PAYMENT_ERRORS.REFUND_PERIOD_EXPIRED, 400);
      }

      if (transaction.status === TRANSACTION_STATUS.REFUNDED) {
        throw new AppError(PAYMENT_ERRORS.REFUND_ALREADY_PROCESSED, 400);
      }

      // Calculate refund amount
      const refundAmount = amount || transaction.amount;

      // Process refund based on provider
      let refundData = null;
      switch (transaction.provider) {
        default:
          throw new AppError('Refunds not supported for this provider', 400);
      }

      // Update transaction
      transaction.status = amount && amount < transaction.amount 
        ? TRANSACTION_STATUS.PARTIALLY_REFUNDED 
        : TRANSACTION_STATUS.REFUNDED;
      transaction.refund = {
        amount: refundAmount,
        reason,
        processedAt: new Date(),
        providerRefundId: refundData.id,
      };
      await transaction.save();

      // Update subscription if applicable
      if (transaction.type === TRANSACTION_TYPES.SUBSCRIPTION) {
        const subscription = await Subscription.findById(transaction.subscriptionId);
        if (subscription) {
          subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
          await subscription.save();
        }
      }

      // Send notification
      const user = await User.findById(userId);
      await EmailService.sendEmail(user.email, {
        template: 'refund_processed',
        data: {
          name: user.profile.firstName,
          amount: (refundAmount / 100).toFixed(2),
          transactionId: transaction._id,
        },
      });

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.PAYMENT_REFUNDED, {
        userId,
        transactionId,
        amount: refundAmount,
        reason,
      });

      return {
        success: true,
        message: PAYMENT_SUCCESS.REFUND_PROCESSED,
        refund: {
          amount: refundAmount,
          status: transaction.status,
        },
      };
    } catch (error) {
      logger.error('Error processing refund:', error);
      throw error;
    }
  }

  // ========================
  // HELPER METHODS
  // ========================

  /**
   * Create transaction record
   */
  async createTransaction(data) {
    try {
      const transaction = await Transaction.create(data);
      
      // Clear cache
      await redis.del(this.cacheKeys.transactions(data.userId));
      
      return transaction;
    } catch (error) {
      logger.error('Error creating transaction:', error);
      throw error;
    }
  }

  /**
   * Update user inventory after purchase
   */
  async updateUserInventory(userId, itemType, quantity) {
    try {
      const user = await User.findById(userId);
      
      switch (itemType) {
        case 'superLikes':
          user.inventory.superLikes = (user.inventory.superLikes || 0) + quantity;
          break;
        
        case 'boosts':
          user.boosts.available = (user.boosts.available || 0) + quantity;
          break;
        
        case 'readReceipts':
          user.inventory.readReceipts = (user.inventory.readReceipts || 0) + quantity;
          break;
      }
      
      await user.save();
      await CacheService.invalidateUser(userId);
    } catch (error) {
      logger.error('Error updating user inventory:', error);
      throw error;
    }
  }

  /**
   * Send subscription notification
   */
  async sendSubscriptionNotification(user, action, subscription) {
    try {
      const templates = {
        created: 'subscription_created',
        cancelled: 'subscription_cancelled',
        paused: 'subscription_paused',
        resumed: 'subscription_resumed',
        upgraded: 'subscription_upgraded',
        downgraded: 'subscription_downgraded',
      };

      await EmailService.sendEmail(user.email, {
        template: templates[action],
        data: {
          name: user.profile.firstName,
          planType: subscription.planType,
          billingCycle: subscription.billingCycle,
          nextBillingDate: subscription.currentPeriodEnd,
        },
      });
    } catch (error) {
      logger.error('Error sending subscription notification:', error);
    }
  }

 /**
  * Process verified purchase from IAP
  */
 async processVerifiedPurchase(userId, { provider, productId, orderId, purchaseTime, expiresAt }) {
   try {
     // Map product ID to internal plan/item
     const mappedProduct = this.mapProductId(provider, productId);
     
     if (mappedProduct.type === 'subscription') {
       // Create or update subscription
       const subscription = await Subscription.findOne({
         userId,
         provider,
       });

       if (subscription) {
         // Update existing subscription
         subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
         subscription.currentPeriodEnd = expiresAt;
         subscription.providerSubscriptionId = orderId;
         await subscription.save();
       } else {
         // Create new subscription
         await Subscription.create({
           userId,
           planType: mappedProduct.planType,
           billingCycle: mappedProduct.billingCycle,
           provider,
           status: SUBSCRIPTION_STATUS.ACTIVE,
           providerSubscriptionId: orderId,
           currentPeriodStart: purchaseTime,
           currentPeriodEnd: expiresAt,
           amount: mappedProduct.amount,
           currency: 'USD',
           features: SUBSCRIPTION_FEATURES_CONFIG[mappedProduct.planType],
         });
       }

       // Update user
       const user = await User.findById(userId);
       await user.updateSubscription({
         type: mappedProduct.planType,
         validUntil: expiresAt,
       });

     } else {
       // Process one-time purchase
       await this.updateUserInventory(
         userId,
         mappedProduct.itemType,
         mappedProduct.quantity
       );
     }

     // Create transaction
     await this.createTransaction({
       userId,
       type: mappedProduct.type === 'subscription' 
         ? TRANSACTION_TYPES.SUBSCRIPTION 
         : TRANSACTION_TYPES.PURCHASE,
       amount: mappedProduct.amount,
       currency: 'USD',
       status: TRANSACTION_STATUS.SUCCESS,
       provider,
       providerTransactionId: orderId,
       items: mappedProduct.type !== 'subscription' ? [{
         type: mappedProduct.itemType,
         quantity: mappedProduct.quantity,
       }] : null,
     });

     return {
       success: true,
       message: 'Purchase verified and processed',
       type: mappedProduct.type,
       details: mappedProduct,
     };
   } catch (error) {
     logger.error('Error processing verified purchase:', error);
     throw error;
   }
 }

 /**
  * Map provider product ID to internal structure
  */
 mapProductId(provider, productId) {
   const mappings = {
     [PAYMENT_PROVIDERS.GOOGLE]: GOOGLE_PLAY_CONFIG.PRODUCT_IDS,
     [PAYMENT_PROVIDERS.APPLE]: APPLE_IAP_CONFIG.PRODUCT_IDS,
   };

   const providerMappings = mappings[provider];
   
   // Find matching product
   for (const [key, value] of Object.entries(providerMappings)) {
     if (value === productId) {
       // Parse product key
       const parts = key.toLowerCase().split('_');
       
       if (parts.includes('plus') || parts.includes('gold') || parts.includes('platinum')) {
         // Subscription product
         const planType = parts[0];
         const billingCycle = parts[1];
         const pricing = SUBSCRIPTION_PRICING[planType][billingCycle];
         
         return {
           type: 'subscription',
           planType,
           billingCycle,
           amount: pricing.amount,
         };
       } else {
         // One-time purchase
         const itemType = parts[0] + (parts[1] === 'likes' ? 'Likes' : 's');
         const quantity = parseInt(parts[parts.length - 1]);
         const pricing = ONE_TIME_PURCHASES[itemType][`pack${quantity}`] ||
                        ONE_TIME_PURCHASES[itemType][quantity === 1 ? 'single' : `pack${quantity}`];
         
         return {
           type: 'purchase',
           itemType,
           quantity,
           amount: pricing?.amount || 0,
         };
       }
     }
   }

   throw new AppError('Unknown product ID', 400);
 }

 /**
  * Map Stripe status to internal status
  */
 mapStripeStatus(stripeStatus) {
   const statusMap = {
     'active': SUBSCRIPTION_STATUS.ACTIVE,
     'trialing': SUBSCRIPTION_STATUS.TRIALING,
     'past_due': SUBSCRIPTION_STATUS.PAST_DUE,
     'canceled': SUBSCRIPTION_STATUS.CANCELLED,
     'incomplete': SUBSCRIPTION_STATUS.INCOMPLETE,
     'incomplete_expired': SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
     'unpaid': SUBSCRIPTION_STATUS.UNPAID,
     'paused': SUBSCRIPTION_STATUS.PAUSED,
   };

   return statusMap[stripeStatus] || SUBSCRIPTION_STATUS.EXPIRED;
 }

 /**
  * Check if plan change is an upgrade
  */
 isUpgrade(currentPlan, newPlan) {
   const planHierarchy = {
     'free': 0,
     'plus': 1,
     'gold': 2,
     'platinum': 3,
   };

   return planHierarchy[newPlan] > planHierarchy[currentPlan];
 }

 // ========================
 // QUERY METHODS
 // ========================

 /**
  * Get user's active subscription
  */
 async getUserSubscription(userId) {
   try {
     // Check cache
     const cached = await redis.get(this.cacheKeys.subscription(userId));
     if (cached) return JSON.parse(cached);

     const subscription = await Subscription.findActiveByUserId(userId);
     
     if (subscription) {
       // Cache for 5 minutes
       await redis.set(
         this.cacheKeys.subscription(userId),
         JSON.stringify(subscription),
         300
       );
     }

     return subscription;
   } catch (error) {
     logger.error('Error getting user subscription:', error);
     throw error;
   }
 }

 /**
  * Get user's transaction history
  */
 async getUserTransactions(userId, { limit = 20, offset = 0, type = null }) {
   try {
     const query = { userId };
     if (type) query.type = type;

     const transactions = await Transaction.find(query)
       .sort({ createdAt: -1 })
       .limit(limit)
       .skip(offset)
       .lean();

     return transactions;
   } catch (error) {
     logger.error('Error getting user transactions:', error);
     throw error;
   }
 }

 /**
  * Check subscription status
  */
 async checkSubscriptionStatus(userId) {
   try {
     const subscription = await Subscription.findActiveByUserId(userId);
     
     if (!subscription) {
       return {
         hasSubscription: false,
         planType: 'free',
       };
     }

     return {
       hasSubscription: true,
       planType: subscription.planType,
       billingCycle: subscription.billingCycle,
       status: subscription.status,
       currentPeriodEnd: subscription.currentPeriodEnd,
       cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
       isInTrial: subscription.isInTrial,
       features: subscription.features,
     };
   } catch (error) {
     logger.error('Error checking subscription status:', error);
     throw error;
   }
 }

 /**
  * Calculate proration for plan change
  */
 async calculateProration(userId, newPlanType, newBillingCycle) {
   try {
     const subscription = await Subscription.findActiveByUserId(userId);
     if (!subscription) {
       throw new AppError('No active subscription', 400);
     }

     const oldPricing = SUBSCRIPTION_PRICING[subscription.planType][subscription.billingCycle];
     const newPricing = SUBSCRIPTION_PRICING[newPlanType][newBillingCycle];

     // Calculate remaining value
     const now = new Date();
     const periodRemaining = subscription.currentPeriodEnd - now;
     const periodTotal = subscription.currentPeriodEnd - subscription.currentPeriodStart;
     const percentageRemaining = periodRemaining / periodTotal;
     
     const currentCredit = Math.round(oldPricing.amount * percentageRemaining);
     const newCharge = newPricing.amount;
     const prorationAmount = newCharge - currentCredit;

     return {
       currentCredit,
       newCharge,
       prorationAmount,
       immediateCharge: Math.max(0, prorationAmount),
     };
   } catch (error) {
     logger.error('Error calculating proration:', error);
     throw error;
   }
 }
}

// Export singleton instance
export default new PaymentService();