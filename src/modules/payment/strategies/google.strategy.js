// src/modules/payment/strategies/google.strategy.js

import { google } from 'googleapis';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import axios from 'axios';
import Subscription from '../subscription.model.js';
import Transaction from '../transaction.model.js';
import User from '../../user/user.model.js';
import {
  GOOGLE_PLAY_CONFIG,
  SUBSCRIPTION_STATUS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  SUBSCRIPTION_FEATURES_CONFIG,
  SUBSCRIPTION_PRICING,
  PAYMENT_ERRORS,
  PAYMENT_EVENTS,
} from '../payment.constants.js';
import { AppError } from '../../../shared/utils/errors.js';
import logger from '../../../shared/utils/logger.js';
import CacheService from '../../../shared/services/cache.service.js';
import NotificationService from '../../notification/notification.service.js';
import MetricsService from '../../../shared/services/metrics.service.js';
import QueueService from '../../../shared/services/queue.service.js';

/**
 * Google Play Billing Strategy
 * Handles all Google Play payment operations
 */
class GooglePlayStrategy {
  constructor() {
    this.androidPublisher = null;
    this.packageName = GOOGLE_PLAY_CONFIG.PACKAGE_NAME;
    this.initializeClient();
    
    // Cache keys
    this.cacheKeys = {
      purchase: (token) => `google:purchase:${token}`,
      subscription: (token) => `google:subscription:${token}`,
      products: 'google:products',
    };
  }

  /**
   * Initialize Google Play API client
   */
  async initializeClient() {
    try {
      // Check if service account credentials exist
      if (!process.env.GOOGLE_PLAY_SERVICE_ACCOUNT) {
        logger.warn('Google Play service account not configured');
        return;
      }

      // Parse service account JSON
      const serviceAccount = JSON.parse(
        Buffer.from(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT, 'base64').toString()
      );

      // Create auth client
      const auth = new google.auth.GoogleAuth({
        credentials: serviceAccount,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });

      // Initialize Android Publisher API
      this.androidPublisher = google.androidpublisher({
        version: 'v3',
        auth,
      });

      logger.info('Google Play API client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Google Play API client:', error);
      throw new AppError('Google Play service initialization failed', 500);
    }
  }

  // ========================
  // PURCHASE VERIFICATION
  // ========================

  /**
   * Verify one-time product purchase
   */
  async verifyProductPurchase(userId, { purchaseToken, productId, orderId }) {
    try {
      logger.info('Verifying Google Play product purchase:', { userId, productId, orderId });

      // Check cache first
      const cacheKey = this.cacheKeys.purchase(purchaseToken);
      const cached = await CacheService.get(cacheKey);
      if (cached) {
        logger.info('Using cached purchase verification');
        return JSON.parse(cached);
      }

      // Check if already processed
      const existingTransaction = await Transaction.findOne({
        provider: 'google',
        providerTransactionId: orderId,
      });

      if (existingTransaction) {
        throw new AppError('Purchase already processed', 400);
      }

      // Verify with Google Play
      const response = await this.androidPublisher.purchases.products.get({
        packageName: this.packageName,
        productId,
        token: purchaseToken,
      });

      const purchase = response.data;

      // Validate purchase state
      if (purchase.purchaseState !== GOOGLE_PLAY_CONFIG.PURCHASE_STATES.PURCHASED) {
        throw new AppError('Purchase not completed', 400);
      }

      // Validate order ID matches
      if (purchase.orderId !== orderId) {
        throw new AppError('Order ID mismatch', 400);
      }

      // Process the purchase
      const result = await this.processProductPurchase(userId, {
        productId,
        orderId: purchase.orderId,
        purchaseTime: new Date(parseInt(purchase.purchaseTimeMillis)),
        developerPayload: purchase.developerPayload,
        purchaseToken,
        acknowledged: purchase.acknowledgementState === 1,
      });

      // Acknowledge purchase if not already done
      if (!purchase.acknowledgementState) {
        await this.acknowledgePurchase(productId, purchaseToken);
      }

      // Cache result
      await CacheService.set(cacheKey, JSON.stringify(result), 3600); // 1 hour

      return result;
    } catch (error) {
      logger.error('Product purchase verification failed:', error);
      
      if (error.code === 404) {
        throw new AppError('Purchase not found', 404);
      }
      
      throw error;
    }
  }

  /**
   * Verify subscription purchase
   */
  async verifySubscriptionPurchase(userId, { purchaseToken, subscriptionId, orderId }) {
    try {
      logger.info('Verifying Google Play subscription:', { userId, subscriptionId, orderId });

      // Check cache
      const cacheKey = this.cacheKeys.subscription(purchaseToken);
      const cached = await CacheService.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Verify with Google Play
      const response = await this.androidPublisher.purchases.subscriptions.get({
        packageName: this.packageName,
        subscriptionId,
        token: purchaseToken,
      });

      const subscription = response.data;

      // Validate subscription
      this.validateSubscription(subscription);

      // Process the subscription
      const result = await this.processSubscriptionPurchase(userId, {
        subscriptionId,
        orderId: subscription.orderId,
        startTime: new Date(parseInt(subscription.startTimeMillis)),
        expiryTime: new Date(parseInt(subscription.expiryTimeMillis)),
        purchaseToken,
        autoRenewing: subscription.autoRenewing,
        paymentState: subscription.paymentState,
        priceAmountMicros: subscription.priceAmountMicros,
        priceCurrencyCode: subscription.priceCurrencyCode,
        linkedPurchaseToken: subscription.linkedPurchaseToken,
        acknowledged: subscription.acknowledgementState === 1,
      });

      // Acknowledge if needed
      if (!subscription.acknowledgementState) {
        await this.acknowledgeSubscription(subscriptionId, purchaseToken);
      }

      // Cache result
      await CacheService.set(cacheKey, JSON.stringify(result), 600); // 10 minutes

      return result;
    } catch (error) {
      logger.error('Subscription verification failed:', error);
      
      if (error.code === 404) {
        throw new AppError('Subscription not found', 404);
      }
      
      throw error;
    }
  }

  // ========================
  // PURCHASE PROCESSING
  // ========================

  /**
   * Process verified product purchase
   */
  async processProductPurchase(userId, purchaseData) {
    try {
      const { productId, orderId, purchaseTime, purchaseToken } = purchaseData;

      // Map product ID to internal item
      const mappedProduct = this.mapProductToItem(productId);

      // Create transaction
      const transaction = await Transaction.create({
        userId,
        type: TRANSACTION_TYPES.PURCHASE,
        provider: 'google',
        providerTransactionId: orderId,
        amount: mappedProduct.amount,
        currency: 'USD',
        status: TRANSACTION_STATUS.SUCCESS,
        items: [{
          type: mappedProduct.itemType,
          quantity: mappedProduct.quantity,
          unitPrice: mappedProduct.unitPrice,
        }],
        metadata: {
          productId,
          purchaseToken,
          purchaseTime,
        },
      });

      // Update user inventory
      await this.updateUserInventory(userId, mappedProduct);

      // Send notification
      await NotificationService.sendNotification(userId, {
        type: 'purchase_complete',
        title: 'Purchase Successful! 🎉',
        body: `You've received ${mappedProduct.quantity} ${mappedProduct.itemType}`,
        data: mappedProduct,
      });

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.PURCHASE_COMPLETED, {
        userId,
        provider: 'google',
        productId,
        amount: mappedProduct.amount,
      });

      logger.info('Product purchase processed successfully:', transaction._id);

      return {
        success: true,
        transaction,
        items: mappedProduct,
      };
    } catch (error) {
      logger.error('Error processing product purchase:', error);
      throw error;
    }
  }

  /**
   * Process verified subscription purchase
   */
  async processSubscriptionPurchase(userId, subscriptionData) {
    try {
      const { 
        subscriptionId, 
        orderId, 
        startTime, 
        expiryTime, 
        autoRenewing,
        priceAmountMicros,
        priceCurrencyCode,
        linkedPurchaseToken,
      } = subscriptionData;

      // Map subscription ID to plan
      const mappedPlan = this.mapSubscriptionToPlan(subscriptionId);

      // Check for existing subscription
      let subscription = await Subscription.findOne({
        userId,
        provider: 'google',
        providerSubscriptionId: orderId,
      });

      if (subscription) {
        // Update existing subscription
        subscription.status = autoRenewing ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.CANCELLED;
        subscription.currentPeriodEnd = expiryTime;
        subscription.cancelAtPeriodEnd = !autoRenewing;
        
        if (linkedPurchaseToken) {
          subscription.metadata.linkedPurchaseToken = linkedPurchaseToken;
        }
        
        await subscription.save();
      } else {
        // Create new subscription
        subscription = await Subscription.create({
          userId,
          planType: mappedPlan.planType,
          billingCycle: mappedPlan.billingCycle,
          provider: 'google',
          providerSubscriptionId: orderId,
          status: SUBSCRIPTION_STATUS.ACTIVE,
          currentPeriodStart: startTime,
          currentPeriodEnd: expiryTime,
          amount: Math.round(priceAmountMicros / 10000), // Convert micros to cents
          currency: priceCurrencyCode,
          cancelAtPeriodEnd: !autoRenewing,
          features: SUBSCRIPTION_FEATURES_CONFIG[mappedPlan.planType],
          metadata: {
            subscriptionId,
            linkedPurchaseToken,
            source: 'android',
          },
        });

        // Create transaction
        await Transaction.create({
          userId,
          subscriptionId: subscription._id,
          type: TRANSACTION_TYPES.SUBSCRIPTION,
          provider: 'google',
          providerTransactionId: orderId,
          amount: subscription.amount,
          currency: priceCurrencyCode,
          status: TRANSACTION_STATUS.SUCCESS,
        });
      }

      // Update user subscription
      const user = await User.findById(userId);
      await user.updateSubscription({
        type: mappedPlan.planType,
        validUntil: expiryTime,
      });

      // Clear cache
      await CacheService.invalidateUser(userId);

      // Send notification
      await NotificationService.sendNotification(userId, {
        type: 'subscription_activated',
        title: 'Subscription Activated! 🎉',
        body: `Your ${mappedPlan.planType} subscription is now active`,
        data: { planType: mappedPlan.planType },
      });

      // Track metrics
      await MetricsService.trackEvent(PAYMENT_EVENTS.SUBSCRIPTION_STARTED, {
        userId,
        provider: 'google',
        planType: mappedPlan.planType,
        billingCycle: mappedPlan.billingCycle,
      });

      logger.info('Subscription processed successfully:', subscription._id);

      return {
        success: true,
        subscription,
        validUntil: expiryTime,
      };
    } catch (error) {
      logger.error('Error processing subscription:', error);
      throw error;
    }
  }

  // ========================
  // SUBSCRIPTION MANAGEMENT
  // ========================

  /**
   * Cancel subscription
   */
  async cancelSubscription(userId, subscriptionId, purchaseToken) {
    try {
      logger.info('Cancelling Google Play subscription:', { userId, subscriptionId });

      // Revoke subscription access
      await this.androidPublisher.purchases.subscriptions.revoke({
        packageName: this.packageName,
        subscriptionId,
        token: purchaseToken,
      });

      // Update local subscription
      const subscription = await Subscription.findOne({
        userId,
        provider: 'google',
        'metadata.subscriptionId': subscriptionId,
      });

      if (subscription) {
        subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
        subscription.cancelledAt = new Date();
        subscription.cancelAtPeriodEnd = false; // Immediate cancellation
        await subscription.save();
      }

      // Update user
      const user = await User.findById(userId);
      await user.updateSubscription({
        type: 'free',
        validUntil: null,
      });

      // Clear cache
      await CacheService.invalidateUser(userId);

      logger.info('Subscription cancelled successfully');

      return {
        success: true,
        message: 'Subscription cancelled successfully',
      };
    } catch (error) {
      logger.error('Error cancelling subscription:', error);
      throw error;
    }
  }

  /**
   * Defer subscription (extend trial or pause)
   */
  async deferSubscription(userId, subscriptionId, purchaseToken, deferralInfo) {
    try {
      const { expectedExpiryTime, desiredExpiryTime } = deferralInfo;

      await this.androidPublisher.purchases.subscriptions.defer({
        packageName: this.packageName,
        subscriptionId,
        token: purchaseToken,
        requestBody: {
          deferralInfo: {
            expectedExpiryTimeMillis: expectedExpiryTime.getTime().toString(),
            desiredExpiryTimeMillis: desiredExpiryTime.getTime().toString(),
          },
        },
      });

      // Update local subscription
      const subscription = await Subscription.findOne({
        userId,
        provider: 'google',
        'metadata.subscriptionId': subscriptionId,
      });

      if (subscription) {
        subscription.currentPeriodEnd = desiredExpiryTime;
        subscription.metadata.deferred = true;
        subscription.metadata.deferralInfo = deferralInfo;
        await subscription.save();
      }

      return {
        success: true,
        newExpiryTime: desiredExpiryTime,
      };
    } catch (error) {
      logger.error('Error deferring subscription:', error);
      throw error;
    }
  }

  // ========================
  // REFUNDS
  // ========================

  /**
   * Process refund for purchase
   */
  async refundPurchase(userId, orderId, reason) {
    try {
      logger.info('Processing Google Play refund:', { userId, orderId, reason });

      // Note: Google Play refunds must be initiated from Google Play Console
      // This method records the refund in our system

      const transaction = await Transaction.findOne({
        userId,
        provider: 'google',
        providerTransactionId: orderId,
      });

      if (!transaction) {
        throw new AppError('Transaction not found', 404);
      }

      if (transaction.status === TRANSACTION_STATUS.REFUNDED) {
        throw new AppError('Already refunded', 400);
      }

      // Update transaction
      transaction.status = TRANSACTION_STATUS.REFUNDED;
      transaction.refund = {
        reason,
        processedAt: new Date(),
        amount: transaction.amount,
      };
      await transaction.save();

      // If subscription, cancel it
      if (transaction.type === TRANSACTION_TYPES.SUBSCRIPTION) {
        const subscription = await Subscription.findOne({
          userId,
          provider: 'google',
          providerSubscriptionId: orderId,
        });

        if (subscription) {
          subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
          subscription.cancelledAt = new Date();
          subscription.cancellationReason = 'refunded';
          await subscription.save();
        }
      }

      // Send notification
      await NotificationService.sendNotification(userId, {
        type: 'refund_processed',
        title: 'Refund Processed',
        body: 'Your refund has been processed',
        data: { orderId },
      });

      logger.info('Refund processed successfully');

      return {
        success: true,
        message: 'Refund processed',
      };
    } catch (error) {
      logger.error('Error processing refund:', error);
      throw error;
    }
  }

  // ========================
  // NOTIFICATION HANDLERS
  // ========================

  /**
   * Handle real-time developer notification
   */
  async handleDeveloperNotification(notification) {
    try {
      const { 
        packageName, 
        subscriptionNotification, 
        oneTimeProductNotification 
      } = notification;

      if (packageName !== this.packageName) {
        logger.warn('Package name mismatch in notification');
        return;
      }

      if (subscriptionNotification) {
        return await this.handleSubscriptionNotification(subscriptionNotification);
      }

      if (oneTimeProductNotification) {
        return await this.handleProductNotification(oneTimeProductNotification);
      }

      logger.warn('Unknown notification type');
      return { success: false, message: 'Unknown notification type' };
    } catch (error) {
      logger.error('Error handling developer notification:', error);
      throw error;
    }
  }

  /**
   * Handle subscription notification
   */
  async handleSubscriptionNotification(notification) {
    try {
      const { 
        subscriptionId, 
        purchaseToken, 
        notificationType 
      } = notification;

      logger.info('Handling subscription notification:', { 
        subscriptionId, 
        notificationType 
      });

      // Get subscription details from Google
      const response = await this.androidPublisher.purchases.subscriptions.get({
        packageName: this.packageName,
        subscriptionId,
        token: purchaseToken,
      });

      const googleSubscription = response.data;

      // Find local subscription
      const subscription = await Subscription.findOne({
        provider: 'google',
        'metadata.subscriptionId': subscriptionId,
      });

      if (!subscription) {
        logger.warn('Subscription not found for notification');
        return { success: false, message: 'Subscription not found' };
      }

      // Handle based on notification type
      switch (notificationType) {
        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.RENEWED:
          await this.handleSubscriptionRenewal(subscription, googleSubscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.CANCELLED:
          await this.handleSubscriptionCancellation(subscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.PURCHASED:
          await this.handleNewSubscription(subscription, googleSubscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.ON_HOLD:
          await this.handleSubscriptionOnHold(subscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.IN_GRACE_PERIOD:
          await this.handleGracePeriod(subscription, googleSubscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.RESTARTED:
          await this.handleSubscriptionRestart(subscription, googleSubscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.EXPIRED:
          await this.handleSubscriptionExpiry(subscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.PAUSED:
          await this.handleSubscriptionPause(subscription, googleSubscription);
          break;

        case GOOGLE_PLAY_CONFIG.NOTIFICATION_TYPES.REVOKED:
          await this.handleSubscriptionRevocation(subscription);
          break;

        default:
          logger.warn('Unhandled notification type:', notificationType);
      }

      return { success: true };
    } catch (error) {
      logger.error('Error handling subscription notification:', error);
      throw error;
    }
  }

  // ========================
  // NOTIFICATION TYPE HANDLERS
  // ========================

  async handleSubscriptionRenewal(subscription, googleData) {
    subscription.currentPeriodEnd = new Date(parseInt(googleData.expiryTimeMillis));
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    await subscription.save();

    await Transaction.create({
      userId: subscription.userId,
      subscriptionId: subscription._id,
      type: TRANSACTION_TYPES.RENEWAL,
      provider: 'google',
      providerTransactionId: googleData.orderId,
      amount: subscription.amount,
      currency: subscription.currency,
      status: TRANSACTION_STATUS.SUCCESS,
    });

    logger.info('Subscription renewed:', subscription._id);
  }

  async handleSubscriptionCancellation(subscription) {
    subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
    subscription.cancelledAt = new Date();
    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    logger.info('Subscription cancelled:', subscription._id);
  }

  async handleGracePeriod(subscription, googleData) {
    const gracePeriodEnd = new Date(parseInt(googleData.expiryTimeMillis));
    
    subscription.status = SUBSCRIPTION_STATUS.PAST_DUE;
    await subscription.startGracePeriod('payment_failed', 
      Math.ceil((gracePeriodEnd - new Date()) / (1000 * 60 * 60 * 24))
    );

    logger.info('Subscription in grace period:', subscription._id);
  }

  async handleSubscriptionExpiry(subscription) {
    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    await subscription.save();

    // Update user to free plan
    const user = await User.findById(subscription.userId);
    await user.updateSubscription({
      type: 'free',
      validUntil: null,
    });

    logger.info('Subscription expired:', subscription._id);
  }

  // ========================
  // HELPER METHODS
  // ========================

  /**
   * Acknowledge product purchase
   */
  async acknowledgePurchase(productId, purchaseToken) {
    try {
      await this.androidPublisher.purchases.products.acknowledge({
        packageName: this.packageName,
        productId,
        token: purchaseToken,
      });
      
      logger.info('Purchase acknowledged:', productId);
    } catch (error) {
      logger.error('Error acknowledging purchase:', error);
    }
  }

  /**
   * Acknowledge subscription
   */
  async acknowledgeSubscription(subscriptionId, purchaseToken) {
    try {
      await this.androidPublisher.purchases.subscriptions.acknowledge({
        packageName: this.packageName,
        subscriptionId,
        token: purchaseToken,
      });
      
      logger.info('Subscription acknowledged:', subscriptionId);
    } catch (error) {
      logger.error('Error acknowledging subscription:', error);
    }
  }

  /**
   * Validate subscription data
   */
  validateSubscription(subscription) {
    // Check payment state
    if (subscription.paymentState === 0) {
      throw new AppError('Payment pending', 402);
    }

    // Check if expired
    const expiryTime = new Date(parseInt(subscription.expiryTimeMillis));
    if (expiryTime < new Date()) {
      throw new AppError('Subscription expired', 400);
    }

    return true;
  }

  /**
   * Map product ID to internal item
   */
  mapProductToItem(productId) {
    const productMap = {
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.SUPER_LIKES_5]: {
        itemType: 'superLikes',
        quantity: 5,
        amount: 499,
        unitPrice: 100,
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.SUPER_LIKES_10]: {
        itemType: 'superLikes',
        quantity: 10,
        amount: 899,
        unitPrice: 90,
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.SUPER_LIKES_25]: {
        itemType: 'superLikes',
        quantity: 25,
        amount: 1999,
        unitPrice: 80,
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.BOOST_1]: {
        itemType: 'boosts',
        quantity: 1,
        amount: 399,
        unitPrice: 399,
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.BOOST_5]: {
        itemType: 'boosts',
        quantity: 5,
        amount: 1599,
        unitPrice: 320,
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.BOOST_10]: {
        itemType: 'boosts',
        quantity: 10,
        amount: 2499,
        unitPrice: 250,
      },
    };

    const mapped = productMap[productId];
    if (!mapped) {
      throw new AppError('Unknown product ID', 400);
    }

    return mapped;
  }

  /**
   * Map subscription ID to plan
   */
  mapSubscriptionToPlan(subscriptionId) {
    const subscriptionMap = {
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLUS_MONTHLY]: {
        planType: 'plus',
        billingCycle: 'monthly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLUS_QUARTERLY]: {
        planType: 'plus',
        billingCycle: 'quarterly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLUS_YEARLY]: {
        planType: 'plus',
        billingCycle: 'yearly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.GOLD_MONTHLY]: {
        planType: 'gold',
        billingCycle: 'monthly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.GOLD_QUARTERLY]: {
        planType: 'gold',
        billingCycle: 'quarterly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.GOLD_YEARLY]: {
        planType: 'gold',
        billingCycle: 'yearly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLATINUM_MONTHLY]: {
        planType: 'platinum',
        billingCycle: 'monthly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLATINUM_QUARTERLY]: {
        planType: 'platinum',
        billingCycle: 'quarterly',
      },
      [GOOGLE_PLAY_CONFIG.PRODUCT_IDS.PLATINUM_YEARLY]: {
        planType: 'platinum',
        billingCycle: 'yearly',
      },
    };

    const mapped = subscriptionMap[subscriptionId];
    if (!mapped) {
      throw new AppError('Unknown subscription ID', 400);
    }

    return mapped;
  }

  /**
   * Update user inventory
   */
  async updateUserInventory(userId, product) {
    const user = await User.findById(userId);
    
    switch (product.itemType) {
      case 'superLikes':
        user.inventory.superLikes = (user.inventory.superLikes || 0) + product.quantity;
        break;
      
      case 'boosts':
        user.boosts.available = (user.boosts.available || 0) + product.quantity;
        break;
    }
    
    await user.save();
    await CacheService.invalidateUser(userId);
  }

  /**
   * Verify notification signature
   */
  verifyNotificationSignature(data, signature) {
    try {
      // Google uses JWT for notifications
      const decoded = jwt.verify(signature, this.getPublicKey(), {
        algorithms: ['RS256'],
      });
      
      return decoded.packageName === this.packageName;
    } catch (error) {
      logger.error('Invalid notification signature:', error);
      return false;
    }
  }

  /**
   * Get Google public key for signature verification
   */
  getPublicKey() {
    // This should be fetched from Google's public key endpoint
    // For now, return from environment variable
    return process.env.GOOGLE_PLAY_PUBLIC_KEY;
  }
}

// Export singleton instance
export default new GooglePlayStrategy();