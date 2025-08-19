// src/modules/payment/strategies/apple.strategy.js

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import Subscription from '../subscription.model.js';
import Transaction from '../transaction.model.js';
import User from '../../user/user.model.js';
import {
  APPLE_IAP_CONFIG,
  SUBSCRIPTION_STATUS,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS,
  SUBSCRIPTION_FEATURES_CONFIG,
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
 * Apple In-App Purchase Strategy
 * Handles all Apple IAP operations including StoreKit 2
 */
class AppleIAPStrategy {
  constructor() {
    this.bundleId = APPLE_IAP_CONFIG.BUNDLE_ID;
    this.environment = APPLE_IAP_CONFIG.ENVIRONMENT;
    this.sharedSecret = process.env.APPLE_SHARED_SECRET;
    
    // App Store Server API configuration
    this.apiConfig = {
      issuer: process.env.APPLE_ISSUER_ID,
      keyId: process.env.APPLE_KEY_ID,
      privateKey: process.env.APPLE_PRIVATE_KEY,
    };
    
    // Cache keys
    this.cacheKeys = {
      receipt: (transactionId) => `apple:receipt:${transactionId}`,
      subscription: (originalTransactionId) => `apple:subscription:${originalTransactionId}`,
      products: 'apple:products',
      jwk: 'apple:jwk',
    };
  }

  // ========================
  // RECEIPT VERIFICATION
  // ========================

  /**
   * Verify receipt with Apple servers
   */
  async verifyReceipt(userId, { receiptData, excludeOldTransactions = true }) {
    try {
      logger.info('Verifying Apple receipt for user:', userId);

      // Try production environment first
      let verifyUrl = APPLE_IAP_CONFIG.VERIFY_URLS.PRODUCTION;
      let response = await this.sendReceiptToApple(receiptData, excludeOldTransactions, verifyUrl);

      // If sandbox receipt, retry with sandbox URL
      if (response.status === APPLE_IAP_CONFIG.STATUS_CODES.SANDBOX_RECEIPT_ON_PRODUCTION) {
        logger.info('Retrying with sandbox URL');
        verifyUrl = APPLE_IAP_CONFIG.VERIFY_URLS.SANDBOX;
        response = await this.sendReceiptToApple(receiptData, excludeOldTransactions, verifyUrl);
      }

      // Check for errors
      if (response.status !== APPLE_IAP_CONFIG.STATUS_CODES.SUCCESS) {
        throw new AppError(
          this.getErrorMessage(response.status),
          this.getErrorStatusCode(response.status)
        );
      }

      // Process the receipt
      return await this.processReceiptResponse(userId, response);
    } catch (error) {
      logger.error('Receipt verification failed:', error);
      throw error;
    }
  }

  /**
   * Send receipt to Apple for verification
   */
  async sendReceiptToApple(receiptData, excludeOldTransactions, verifyUrl) {
    try {
      const requestBody = {
        'receipt-data': receiptData,
        'password': this.sharedSecret,
        'exclude-old-transactions': excludeOldTransactions,
      };

      const response = await axios.post(verifyUrl, requestBody, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to send receipt to Apple:', error);
      throw new AppError('Receipt verification service unavailable', 503);
    }
  }

  /**
   * Process verified receipt response
   */
  async processReceiptResponse(userId, response) {
    try {
      const { receipt, latest_receipt_info, pending_renewal_info } = response;

      // Get latest transaction
      const latestTransaction = this.getLatestTransaction(latest_receipt_info || receipt.in_app);
      
      if (!latestTransaction) {
        throw new AppError('No valid transactions found in receipt', 400);
      }

      // Check if already processed
      const existingTransaction = await this.checkExistingTransaction(
        latestTransaction.transaction_id
      );

      if (existingTransaction) {
        return {
          success: true,
          message: 'Receipt already processed',
          transaction: existingTransaction,
        };
      }

      // Determine purchase type
      const isSubscription = this.isSubscriptionProduct(latestTransaction.product_id);

      if (isSubscription) {
        return await this.processSubscriptionReceipt(
          userId,
          latestTransaction,
          pending_renewal_info,
          response.latest_receipt
        );
      } else {
        return await this.processProductReceipt(userId, latestTransaction);
      }
    } catch (error) {
      logger.error('Error processing receipt response:', error);
      throw error;
    }
  }

  // ========================
  // SUBSCRIPTION PROCESSING
  // ========================

  /**
   * Process subscription receipt
   */
  async processSubscriptionReceipt(userId, transaction, renewalInfo, latestReceipt) {
    try {
      const mappedPlan = this.mapProductToPlan(transaction.product_id);
      
      // Parse dates
      const purchaseDate = new Date(parseInt(transaction.purchase_date_ms));
      const expiresDate = new Date(parseInt(transaction.expires_date_ms));
      const originalPurchaseDate = new Date(parseInt(transaction.original_purchase_date_ms));

      // Determine subscription status
      const status = this.determineSubscriptionStatus(transaction, renewalInfo);

      // Find or create subscription
      let subscription = await Subscription.findOne({
        userId,
        provider: 'apple',
        'metadata.originalTransactionId': transaction.original_transaction_id,
      });

      if (subscription) {
        // Update existing subscription
        subscription.status = status;
        subscription.currentPeriodEnd = expiresDate;
        subscription.cancelAtPeriodEnd = renewalInfo?.[0]?.auto_renew_status === '0';
        
        if (transaction.cancellation_date_ms) {
          subscription.cancelledAt = new Date(parseInt(transaction.cancellation_date_ms));
          subscription.cancellationReason = transaction.cancellation_reason;
        }

        // Store latest receipt for future use
        subscription.metadata.latestReceipt = latestReceipt;
        
        await subscription.save();
      } else {
        // Create new subscription
        subscription = await Subscription.create({
          userId,
          planType: mappedPlan.planType,
          billingCycle: mappedPlan.billingCycle,
          provider: 'apple',
          providerSubscriptionId: transaction.original_transaction_id,
          status,
          currentPeriodStart: purchaseDate,
          currentPeriodEnd: expiresDate,
          amount: this.parsePrice(transaction.price),
          currency: 'USD',
          cancelAtPeriodEnd: renewalInfo?.[0]?.auto_renew_status === '0',
          trialEnd: transaction.is_trial_period === 'true' ? expiresDate : null,
          features: SUBSCRIPTION_FEATURES_CONFIG[mappedPlan.planType],
          metadata: {
            productId: transaction.product_id,
            originalTransactionId: transaction.original_transaction_id,
            latestTransactionId: transaction.transaction_id,
            originalPurchaseDate,
            bundleId: receipt?.bundle_id || this.bundleId,
            latestReceipt,
            isInIntroOfferPeriod: transaction.is_in_intro_offer_period === 'true',
            webOrderLineItemId: transaction.web_order_line_item_id,
            source: 'ios',
          },
        });

        // Create transaction record
        await Transaction.create({
          userId,
          subscriptionId: subscription._id,
          type: TRANSACTION_TYPES.SUBSCRIPTION,
          provider: 'apple',
          providerTransactionId: transaction.transaction_id,
          amount: subscription.amount,
          currency: 'USD',
          status: TRANSACTION_STATUS.SUCCESS,
          metadata: {
            productId: transaction.product_id,
            originalTransactionId: transaction.original_transaction_id,
          },
        });
      }

      // Update user subscription
      const user = await User.findById(userId);
      await user.updateSubscription({
        type: mappedPlan.planType,
        validUntil: expiresDate,
      });

      // Clear cache
      await CacheService.invalidateUser(userId);

      // Send notification
      if (!subscription.wasNew) {
        await NotificationService.sendNotification(userId, {
          type: 'subscription_renewed',
          title: 'Subscription Renewed',
          body: `Your ${mappedPlan.planType} subscription has been renewed`,
        });
      } else {
        await NotificationService.sendNotification(userId, {
          type: 'subscription_activated',
          title: 'Subscription Activated! 🎉',
          body: `Your ${mappedPlan.planType} subscription is now active`,
        });
      }

      // Track metrics
      await MetricsService.trackEvent(
        subscription.wasNew ? PAYMENT_EVENTS.SUBSCRIPTION_STARTED : PAYMENT_EVENTS.SUBSCRIPTION_RENEWED,
        {
          userId,
          provider: 'apple',
          planType: mappedPlan.planType,
          billingCycle: mappedPlan.billingCycle,
        }
      );

      logger.info('Subscription processed successfully:', subscription._id);

      return {
        success: true,
        subscription,
        validUntil: expiresDate,
      };
    } catch (error) {
      logger.error('Error processing subscription receipt:', error);
      throw error;
    }
  }

  /**
   * Process product (consumable/non-consumable) receipt
   */
  async processProductReceipt(userId, transaction) {
    try {
      const mappedProduct = this.mapProductToItem(transaction.product_id);
      
      // Create transaction
      const transactionRecord = await Transaction.create({
        userId,
        type: TRANSACTION_TYPES.PURCHASE,
        provider: 'apple',
        providerTransactionId: transaction.transaction_id,
        amount: this.parsePrice(transaction.price),
        currency: 'USD',
        status: TRANSACTION_STATUS.SUCCESS,
        items: [{
          type: mappedProduct.itemType,
          quantity: mappedProduct.quantity,
          unitPrice: mappedProduct.unitPrice,
        }],
        metadata: {
          productId: transaction.product_id,
          purchaseDate: new Date(parseInt(transaction.purchase_date_ms)),
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
        provider: 'apple',
        productId: transaction.product_id,
        amount: this.parsePrice(transaction.price),
      });

      logger.info('Product purchase processed successfully');

      return {
        success: true,
        transaction: transactionRecord,
        items: mappedProduct,
      };
    } catch (error) {
      logger.error('Error processing product receipt:', error);
      throw error;
    }
  }

  // ========================
  // SERVER NOTIFICATIONS V2
  // ========================

  /**
   * Handle App Store Server Notification V2
   */
  async handleServerNotificationV2(signedPayload) {
    try {
      // Decode and verify the JWT
      const decodedPayload = await this.verifyAndDecodeJWT(signedPayload);
      
      const { notificationType, subtype, data } = decodedPayload;
      
      logger.info('Handling Apple server notification:', { 
        notificationType, 
        subtype 
      });

      // Decode transaction info
      const transactionInfo = data.signedTransactionInfo 
        ? jwt.decode(data.signedTransactionInfo) 
        : null;
      
      const renewalInfo = data.signedRenewalInfo 
        ? jwt.decode(data.signedRenewalInfo) 
        : null;

      // Handle based on notification type
      switch (notificationType) {
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.SUBSCRIBED:
          return await this.handleSubscribed(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.DID_RENEW:
          return await this.handleDidRenew(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.DID_CHANGE_RENEWAL_STATUS:
          return await this.handleRenewalStatusChange(transactionInfo, renewalInfo, subtype);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.OFFER_REDEEMED:
          return await this.handleOfferRedeemed(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.DID_CHANGE_RENEWAL_PREF:
          return await this.handleRenewalPrefChange(transactionInfo, renewalInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.EXPIRED:
          return await this.handleExpired(transactionInfo, subtype);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.GRACE_PERIOD_EXPIRED:
          return await this.handleGracePeriodExpired(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.REFUND:
          return await this.handleRefund(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.REVOKE:
          return await this.handleRevoke(transactionInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.PRICE_INCREASE:
          return await this.handlePriceIncrease(transactionInfo, renewalInfo);
          
        case APPLE_IAP_CONFIG.NOTIFICATION_TYPES_V2.CONSUMPTION_REQUEST:
          return await this.handleConsumptionRequest(transactionInfo);
          
        default:
          logger.warn('Unhandled notification type:', notificationType);
          return { success: true };
      }
    } catch (error) {
      logger.error('Error handling server notification:', error);
      throw error;
    }
  }

  /**
   * Verify and decode JWT from Apple
   */
  async verifyAndDecodeJWT(signedPayload) {
    try {
      // Get Apple's public keys
      const publicKeys = await this.getApplePublicKeys();
      
      // Decode header to get kid
      const header = jwt.decode(signedPayload, { complete: true }).header;
      const publicKey = publicKeys[header.kid];
      
      if (!publicKey) {
        throw new AppError('Public key not found for kid: ' + header.kid, 400);
      }

      // Verify and decode
      const decoded = jwt.verify(signedPayload, publicKey, {
        algorithms: ['ES256'],
        issuer: 'https://appleid.apple.com',
        audience: this.bundleId,
      });

      return decoded;
    } catch (error) {
      logger.error('JWT verification failed:', error);
      throw new AppError('Invalid notification signature', 401);
    }
  }

  /**
   * Get Apple's public keys for JWT verification
   */
  async getApplePublicKeys() {
    try {
      // Check cache first
      const cached = await CacheService.get(this.cacheKeys.jwk);
      if (cached) {
        return JSON.parse(cached);
      }

      // Fetch from Apple
      const response = await axios.get('https://appleid.apple.com/auth/keys');
      const keys = {};
      
      for (const key of response.data.keys) {
        keys[key.kid] = this.jwkToPem(key);
      }

      // Cache for 24 hours
      await CacheService.set(this.cacheKeys.jwk, JSON.stringify(keys), 86400);
      
      return keys;
    } catch (error) {
      logger.error('Failed to fetch Apple public keys:', error);
      throw error;
    }
  }

  /**
   * Convert JWK to PEM format
   */
  jwkToPem(jwk) {
    // Implementation to convert JWK to PEM
    // This is a simplified version - use a library like jwk-to-pem in production
    const { n, e } = jwk;
    const modulus = Buffer.from(n, 'base64');
    const exponent = Buffer.from(e, 'base64');
    
    // Convert to PEM format (simplified)
    return `-----BEGIN PUBLIC KEY-----
${Buffer.concat([modulus, exponent]).toString('base64')}
-----END PUBLIC KEY-----`;
  }

  // ========================
  // NOTIFICATION HANDLERS
  // ========================

  async handleSubscribed(transactionInfo) {
    const subscription = await this.findSubscriptionByOriginalTransactionId(
      transactionInfo.originalTransactionId
    );

    if (!subscription) {
      // New subscription, should have been created during receipt validation
      logger.warn('Subscription not found for SUBSCRIBED notification');
      return { success: true };
    }

    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.currentPeriodEnd = new Date(transactionInfo.expiresDate);
    await subscription.save();

    logger.info('Subscription activated via notification');
    return { success: true };
  }

  async handleDidRenew(transactionInfo) {
    const subscription = await this.findSubscriptionByOriginalTransactionId(
      transactionInfo.originalTransactionId
    );

    if (!subscription) {
      logger.warn('Subscription not found for DID_RENEW notification');
      return { success: false };
    }

    // Update subscription
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.currentPeriodStart = new Date(transactionInfo.purchaseDate);
    subscription.currentPeriodEnd = new Date(transactionInfo.expiresDate);
    await subscription.save();

    // Create renewal transaction
    await Transaction.create({
      userId: subscription.userId,
      subscriptionId: subscription._id,
      type: TRANSACTION_TYPES.RENEWAL,
      provider: 'apple',
      providerTransactionId: transactionInfo.transactionId,
      amount: subscription.amount,
      currency: subscription.currency,
      status: TRANSACTION_STATUS.SUCCESS,
    });

    // Update user
    const user = await User.findById(subscription.userId);
    await user.updateSubscription({
      type: subscription.planType,
      validUntil: subscription.currentPeriodEnd,
    });

    logger.info('Subscription renewed via notification');
    return { success: true };
  }

  async handleRenewalStatusChange(transactionInfo, renewalInfo, subtype) {
    const subscription = await this.findSubscriptionByOriginalTransactionId(
      transactionInfo.originalTransactionId
    );

    if (!subscription) {
      return { success: false };
    }

    if (subtype === 'AUTO_RENEW_DISABLED') {
      subscription.cancelAtPeriodEnd = true;
      subscription.cancelledAt = new Date();
    } else if (subtype === 'AUTO_RENEW_ENABLED') {
      subscription.cancelAtPeriodEnd = false;
      subscription.cancelledAt = null;
    }

    await subscription.save();
    logger.info('Renewal status changed:', subtype);
    return { success: true };
  }

  async handleExpired(transactionInfo, subtype) {
    const subscription = await this.findSubscriptionByOriginalTransactionId(
      transactionInfo.originalTransactionId
    );

    if (!subscription) {
      return { success: false };
    }

    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    
    if (subtype === 'VOLUNTARY') {
      subscription.cancellationReason = 'voluntary';
    } else if (subtype === 'BILLING_RETRY') {
      subscription.cancellationReason = 'billing_failed';
    }

    await subscription.save();

    // Update user to free plan
    const user = await User.findById(subscription.userId);
    await user.updateSubscription({
      type: 'free',
      validUntil: null,
    });

    logger.info('Subscription expired:', subtype);
    return { success: true };
  }

  async handleGracePeriodExpired(transactionInfo) {
    const subscription = await this.findSubscriptionByOriginalTransactionId(
      transactionInfo.originalTransactionId
    );

    if (!subscription) {
      return { success: false };
    }

    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    subscription.gracePeriod = {
      ...subscription.gracePeriod,
      resolved: true,
      endDate: new Date(),
    };
    await subscription.save();

    logger.info('Grace period expired for subscription');
    return { success: true };
  }

  async handleRefund(transactionInfo) {
    const transaction = await Transaction.findOne({
      provider: 'apple',
      providerTransactionId: transactionInfo.transactionId,
    });

    if (!transaction) {
      logger.warn('Transaction not found for refund');
      return { success: false };
    }

    transaction.status = TRANSACTION_STATUS.REFUNDED;
    transaction.refund = {
      reason: transactionInfo.revocationReason || 'customer_request',
      processedAt: new Date(transactionInfo.revocationDate || Date.now()),
      amount: transaction.amount,
    };
    await transaction.save();

    // If subscription, cancel it
    if (transaction.subscriptionId) {
      const subscription = await Subscription.findById(transaction.subscriptionId);
      if (subscription) {
        subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
        subscription.cancelledAt = new Date();
        subscription.cancellationReason = 'refunded';
        await subscription.save();
      }
    }

    logger.info('Refund processed via notification');
    return { success: true };
  }

  // ========================
  // APP STORE SERVER API
  // ========================

  /**
   * Get subscription status using App Store Server API
   */
  async getSubscriptionStatus(originalTransactionId) {
    try {
      const token = this.generateJWT();
      
      const response = await axios.get(
        `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/${originalTransactionId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Failed to get subscription status:', error);
      throw error;
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(originalTransactionId, revision = null) {
    try {
      const token = this.generateJWT();
      
      let url = `https://api.storekit.itunes.apple.com/inApps/v1/history/${originalTransactionId}`;
      if (revision) {
        url += `?revision=${revision}`;
      }

      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      return response.data;
    } catch (error) {
      logger.error('Failed to get transaction history:', error);
      throw error;
    }
  }

  /**
   * Send consumption information
   */
  async sendConsumptionInfo(originalTransactionId, consumptionInfo) {
    try {
      const token = this.generateJWT();
      
      await axios.put(
        `https://api.storekit.itunes.apple.com/inApps/v1/transactions/consumption/${originalTransactionId}`,
        consumptionInfo,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info('Consumption info sent successfully');
      return { success: true };
    } catch (error) {
      logger.error('Failed to send consumption info:', error);
      throw error;
    }
  }

  /**
   * Extend subscription renewal date
   */
  async extendRenewalDate(originalTransactionId, extensionInfo) {
    try {
      const token = this.generateJWT();
      
      const response = await axios.put(
        `https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/extend/${originalTransactionId}`,
        extensionInfo,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return response.data;
    } catch (error) {
      logger.error('Failed to extend renewal date:', error);
      throw error;
    }
  }

  /**
   * Generate JWT for App Store Server API
   */
  generateJWT() {
    const payload = {
      iss: this.apiConfig.issuer,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      aud: 'appstoreconnect-v1',
      bid: this.bundleId,
    };

    return jwt.sign(payload, this.apiConfig.privateKey, {
      algorithm: 'ES256',
      keyid: this.apiConfig.keyId,
    });
  }

  // ========================
  // HELPER METHODS
  // ========================

  /**
   * Find subscription by original transaction ID
   */
  async findSubscriptionByOriginalTransactionId(originalTransactionId) {
    return await Subscription.findOne({
      provider: 'apple',
      'metadata.originalTransactionId': originalTransactionId,
    });
  }

  /**
   * Check if transaction already exists
   */
  async checkExistingTransaction(transactionId) {
    return await Transaction.findOne({
      provider: 'apple',
      providerTransactionId: transactionId,
    });
  }

  /**
   * Get latest transaction from receipt
   */
  getLatestTransaction(transactions) {
    if (!transactions || transactions.length === 0) {
      return null;
    }

    return transactions.reduce((latest, current) => {
      const currentDate = parseInt(current.purchase_date_ms);
      const latestDate = parseInt(latest.purchase_date_ms);
      return currentDate > latestDate ? current : latest;
    });
  }

  /**
   * Determine subscription status from transaction and renewal info
   */
  determineSubscriptionStatus(transaction, renewalInfo) {
    const now = Date.now();
    const expiresDate = parseInt(transaction.expires_date_ms);

    // Check if in trial
    if (transaction.is_trial_period === 'true' && expiresDate > now) {
      return SUBSCRIPTION_STATUS.TRIALING;
    }

    // Check if expired
    if (expiresDate <= now) {
      return SUBSCRIPTION_STATUS.EXPIRED;
    }

    // Check if in grace period
    if (renewalInfo?.[0]?.is_in_billing_retry_period === '1') {
      return SUBSCRIPTION_STATUS.PAST_DUE;
    }

    // Check if cancelled but still active
    if (renewalInfo?.[0]?.auto_renew_status === '0') {
      return SUBSCRIPTION_STATUS.ACTIVE; // Will cancel at period end
    }

    return SUBSCRIPTION_STATUS.ACTIVE;
  }

  /**
   * Check if product is subscription
   */
  isSubscriptionProduct(productId) {
    const subscriptionProducts = [
      ...Object.values(APPLE_IAP_CONFIG.PRODUCT_IDS).filter(id => 
        id.includes('plus') || id.includes('gold') || id.includes('platinum')
      ),
    ];

    return subscriptionProducts.includes(productId);
  }

  /**
   * Map product ID to plan
   */
  mapProductToPlan(productId) {
    const productMap = {
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLUS_MONTHLY]: {
        planType: 'plus',
        billingCycle: 'monthly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLUS_QUARTERLY]: {
        planType: 'plus',
        billingCycle: 'quarterly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLUS_YEARLY]: {
        planType: 'plus',
        billingCycle: 'yearly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.GOLD_MONTHLY]: {
        planType: 'gold',
        billingCycle: 'monthly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.GOLD_QUARTERLY]: {
        planType: 'gold',
        billingCycle: 'quarterly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.GOLD_YEARLY]: {
        planType: 'gold',
        billingCycle: 'yearly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLATINUM_MONTHLY]: {
        planType: 'platinum',
        billingCycle: 'monthly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLATINUM_QUARTERLY]: {
        planType: 'platinum',
        billingCycle: 'quarterly',
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.PLATINUM_YEARLY]: {
        planType: 'platinum',
        billingCycle: 'yearly',
      },
    };

    const mapped = productMap[productId];
    if (!mapped) {
      throw new AppError('Unknown product ID: ' + productId, 400);
    }

    return mapped;
  }

  /**
   * Map product ID to item
   */
  mapProductToItem(productId) {
    const productMap = {
      [APPLE_IAP_CONFIG.PRODUCT_IDS.SUPER_LIKES_5]: {
        itemType: 'superLikes',
        quantity: 5,
        amount: 499,
        unitPrice: 100,
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.SUPER_LIKES_10]: {
        itemType: 'superLikes',
        quantity: 10,
        amount: 899,
        unitPrice: 90,
      },
      [APPLE_IAP_CONFIG.PRODUCT_IDS.SUPER_LIKES_25]: {
        itemType: 'superLikes',
        quantity: 25,
        amount: 1999,
        unitPrice: 80,
     },
     [APPLE_IAP_CONFIG.PRODUCT_IDS.BOOST_1]: {
       itemType: 'boosts',
       quantity: 1,
       amount: 399,
       unitPrice: 399,
     },
     [APPLE_IAP_CONFIG.PRODUCT_IDS.BOOST_5]: {
       itemType: 'boosts',
       quantity: 5,
       amount: 1599,
       unitPrice: 320,
     },
     [APPLE_IAP_CONFIG.PRODUCT_IDS.BOOST_10]: {
       itemType: 'boosts',
       quantity: 10,
       amount: 2499,
       unitPrice: 250,
     },
   };

   const mapped = productMap[productId];
   if (!mapped) {
     throw new AppError('Unknown product ID: ' + productId, 400);
   }

   return mapped;
 }

 /**
  * Parse price from Apple format
  */
 parsePrice(price) {
   // Apple sends price as string like "9.99"
   // Convert to cents
   const numericPrice = parseFloat(price);
   return Math.round(numericPrice * 100);
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
  * Get error message for status code
  */
 getErrorMessage(statusCode) {
   const messages = {
     [APPLE_IAP_CONFIG.STATUS_CODES.INVALID_JSON]: 'Invalid receipt format',
     [APPLE_IAP_CONFIG.STATUS_CODES.INVALID_RECEIPT_DATA]: 'Invalid receipt data',
     [APPLE_IAP_CONFIG.STATUS_CODES.RECEIPT_AUTHENTICATION_FAILED]: 'Receipt authentication failed',
     [APPLE_IAP_CONFIG.STATUS_CODES.SHARED_SECRET_MISMATCH]: 'Invalid shared secret',
     [APPLE_IAP_CONFIG.STATUS_CODES.RECEIPT_SERVER_UNAVAILABLE]: 'Apple server unavailable',
     [APPLE_IAP_CONFIG.STATUS_CODES.SUBSCRIPTION_EXPIRED]: 'Subscription has expired',
     [APPLE_IAP_CONFIG.STATUS_CODES.SANDBOX_RECEIPT_ON_PRODUCTION]: 'Sandbox receipt sent to production',
     [APPLE_IAP_CONFIG.STATUS_CODES.PRODUCTION_RECEIPT_ON_SANDBOX]: 'Production receipt sent to sandbox',
     [APPLE_IAP_CONFIG.STATUS_CODES.INTERNAL_DATA_ACCESS_ERROR]: 'Internal data access error',
     [APPLE_IAP_CONFIG.STATUS_CODES.ACCOUNT_NOT_FOUND]: 'Account not found',
   };

   return messages[statusCode] || 'Unknown error occurred';
 }

 /**
  * Get HTTP status code for Apple status code
  */
 getErrorStatusCode(appleStatusCode) {
   const httpStatusMap = {
     [APPLE_IAP_CONFIG.STATUS_CODES.INVALID_JSON]: 400,
     [APPLE_IAP_CONFIG.STATUS_CODES.INVALID_RECEIPT_DATA]: 400,
     [APPLE_IAP_CONFIG.STATUS_CODES.RECEIPT_AUTHENTICATION_FAILED]: 401,
     [APPLE_IAP_CONFIG.STATUS_CODES.SHARED_SECRET_MISMATCH]: 401,
     [APPLE_IAP_CONFIG.STATUS_CODES.RECEIPT_SERVER_UNAVAILABLE]: 503,
     [APPLE_IAP_CONFIG.STATUS_CODES.SUBSCRIPTION_EXPIRED]: 410,
     [APPLE_IAP_CONFIG.STATUS_CODES.SANDBOX_RECEIPT_ON_PRODUCTION]: 400,
     [APPLE_IAP_CONFIG.STATUS_CODES.PRODUCTION_RECEIPT_ON_SANDBOX]: 400,
     [APPLE_IAP_CONFIG.STATUS_CODES.INTERNAL_DATA_ACCESS_ERROR]: 500,
     [APPLE_IAP_CONFIG.STATUS_CODES.ACCOUNT_NOT_FOUND]: 404,
   };

   return httpStatusMap[appleStatusCode] || 400;
 }

 // ========================
 // SANDBOX TESTING
 // ========================

 /**
  * Validate sandbox receipt
  */
 async validateSandboxReceipt(receiptData) {
   try {
     const response = await this.sendReceiptToApple(
       receiptData,
       false,
       APPLE_IAP_CONFIG.VERIFY_URLS.SANDBOX
     );

     if (response.status !== APPLE_IAP_CONFIG.STATUS_CODES.SUCCESS) {
       throw new AppError(this.getErrorMessage(response.status), 400);
     }

     return {
       success: true,
       environment: 'sandbox',
       receipt: response.receipt,
       latestReceiptInfo: response.latest_receipt_info,
     };
   } catch (error) {
     logger.error('Sandbox validation failed:', error);
     throw error;
   }
 }

 /**
  * Clear test user purchases (sandbox only)
  */
 async clearTestPurchases(userId) {
   if (this.environment !== 'sandbox') {
     throw new AppError('This operation is only available in sandbox', 403);
   }

   try {
     // Delete all Apple transactions for user
     await Transaction.deleteMany({
       userId,
       provider: 'apple',
     });

     // Delete all Apple subscriptions for user
     await Subscription.deleteMany({
       userId,
       provider: 'apple',
     });

     // Reset user to free plan
     const user = await User.findById(userId);
     await user.updateSubscription({
       type: 'free',
       validUntil: null,
     });

     logger.info('Test purchases cleared for user:', userId);

     return {
       success: true,
       message: 'Test purchases cleared successfully',
     };
   } catch (error) {
     logger.error('Error clearing test purchases:', error);
     throw error;
   }
 }

 // ========================
 // OFFER MANAGEMENT
 // ========================

 /**
  * Generate signature for promotional offer
  */
 generateOfferSignature(productId, offerId, applicationUsername, nonce, timestamp) {
   try {
     const payload = [
       applicationUsername || '',
       this.bundleId,
       productId,
       offerId,
       nonce.toLowerCase(),
       timestamp.toString(),
     ].join('\u2063'); // Unicode separator

     const signature = crypto
       .createSign('SHA256')
       .update(payload)
       .sign(this.apiConfig.privateKey, 'base64');

     return {
       signature,
       nonce,
       timestamp,
       keyIdentifier: this.apiConfig.keyId,
     };
   } catch (error) {
     logger.error('Error generating offer signature:', error);
     throw error;
   }
 }

 /**
  * Handle offer redemption
  */
 async handleOfferRedeemed(transactionInfo) {
   const subscription = await this.findSubscriptionByOriginalTransactionId(
     transactionInfo.originalTransactionId
   );

   if (!subscription) {
     return { success: false };
   }

   // Update subscription with offer details
   subscription.metadata.offerIdentifier = transactionInfo.offerIdentifier;
   subscription.metadata.offerType = transactionInfo.offerType;
   
   if (transactionInfo.offerDiscountType) {
     subscription.discount = {
       type: transactionInfo.offerDiscountType,
       value: transactionInfo.offerDiscountValue,
       appliedAt: new Date(),
     };
   }

   await subscription.save();

   // Track metrics
   await MetricsService.trackEvent('offer_redeemed', {
     userId: subscription.userId,
     offerId: transactionInfo.offerIdentifier,
     offerType: transactionInfo.offerType,
   });

   logger.info('Offer redeemed:', transactionInfo.offerIdentifier);
   return { success: true };
 }

 // ========================
 // FAMILY SHARING
 // ========================

 /**
  * Handle family sharing purchase
  */
 async handleFamilySharing(transactionInfo, familyMemberInfo) {
   try {
     // Check if purchase is family shared
     if (transactionInfo.inAppOwnershipType !== 'FAMILY_SHARED') {
       return { success: false, message: 'Not a family shared purchase' };
     }

     // Find or create subscription for family member
     const subscription = await Subscription.findOne({
       'metadata.originalTransactionId': transactionInfo.originalTransactionId,
       'metadata.familyShared': true,
     });

     if (subscription) {
       // Update existing family subscription
       subscription.currentPeriodEnd = new Date(transactionInfo.expiresDate);
       subscription.metadata.familyMemberInfo = familyMemberInfo;
       await subscription.save();
     } else {
       // Create new family subscription
       const mappedPlan = this.mapProductToPlan(transactionInfo.productId);
       
       await Subscription.create({
         userId: familyMemberInfo.userId,
         planType: mappedPlan.planType,
         billingCycle: mappedPlan.billingCycle,
         provider: 'apple',
         providerSubscriptionId: transactionInfo.originalTransactionId,
         status: SUBSCRIPTION_STATUS.ACTIVE,
         currentPeriodStart: new Date(transactionInfo.purchaseDate),
         currentPeriodEnd: new Date(transactionInfo.expiresDate),
         amount: 0, // Family member doesn't pay
         currency: 'USD',
         features: SUBSCRIPTION_FEATURES_CONFIG[mappedPlan.planType],
         metadata: {
           familyShared: true,
           familyMemberInfo,
           originalPurchaser: transactionInfo.originalPurchaserAppAccountToken,
         },
       });
     }

     logger.info('Family sharing purchase processed');
     return { success: true };
   } catch (error) {
     logger.error('Error handling family sharing:', error);
     throw error;
   }
 }

 // ========================
 // PRICE MANAGEMENT
 // ========================

 /**
  * Handle price increase consent
  */
 async handlePriceIncrease(transactionInfo, renewalInfo) {
   const subscription = await this.findSubscriptionByOriginalTransactionId(
     transactionInfo.originalTransactionId
   );

   if (!subscription) {
     return { success: false };
   }

   // Store price increase info
   subscription.metadata.priceIncrease = {
     newPrice: renewalInfo.priceIncreasePrice,
     consentRequired: true,
     consentStatus: renewalInfo.priceIncreaseStatus,
     effectiveDate: new Date(renewalInfo.priceIncreaseEffectiveDate),
   };

   await subscription.save();

   // Notify user about price increase
   await NotificationService.sendNotification(subscription.userId, {
     type: 'price_increase',
     title: 'Subscription Price Change',
     body: 'Your subscription price will increase. Please review and confirm.',
     data: {
       newPrice: renewalInfo.priceIncreasePrice,
       effectiveDate: renewalInfo.priceIncreaseEffectiveDate,
     },
   });

   logger.info('Price increase notification handled');
   return { success: true };
 }

 // ========================
 // CONSUMPTION TRACKING
 // ========================

 /**
  * Handle consumption request
  */
 async handleConsumptionRequest(transactionInfo) {
   try {
     // Apple wants to know if the consumable was delivered
     const transaction = await Transaction.findOne({
       provider: 'apple',
       providerTransactionId: transactionInfo.transactionId,
     });

     if (!transaction) {
       logger.warn('Transaction not found for consumption request');
       return { success: false };
     }

     // Send consumption info back to Apple
     const consumptionInfo = {
       customerConsented: true,
       consumptionStatus: 0, // 0 = delivered successfully
       platform: 2, // 2 = iOS
       sampleContentProvided: false,
       deliveryStatus: 0, // 0 = delivered successfully
       appAccountToken: transaction.userId.toString(),
       accountTenure: 0, // Customer tenure in days
       playTime: 0, // Play time in milliseconds
       lifetimeDollarsRefunded: 0,
       lifetimeDollarsPurchased: transaction.amount / 100,
       userStatus: 1, // 1 = active
     };

     await this.sendConsumptionInfo(
       transactionInfo.originalTransactionId,
       consumptionInfo
     );

     logger.info('Consumption request handled');
     return { success: true };
   } catch (error) {
     logger.error('Error handling consumption request:', error);
     throw error;
   }
 }

 // ========================
 // MONITORING & ANALYTICS
 // ========================

 /**
  * Track subscription metrics
  */
 async trackSubscriptionMetrics(subscription, event) {
   const metrics = {
     provider: 'apple',
     planType: subscription.planType,
     billingCycle: subscription.billingCycle,
     amount: subscription.amount,
     currency: subscription.currency,
     event,
     timestamp: new Date(),
   };

   // Track MRR changes
   if (event === 'renewed' || event === 'subscribed') {
     metrics.mrrChange = subscription.amount;
   } else if (event === 'cancelled' || event === 'expired') {
     metrics.mrrChange = -subscription.amount;
   }

   await MetricsService.trackEvent('subscription_metrics', metrics);
 }

 /**
  * Get subscription analytics
  */
 async getSubscriptionAnalytics(startDate, endDate) {
   try {
     const subscriptions = await Subscription.find({
       provider: 'apple',
       createdAt: { $gte: startDate, $lte: endDate },
     });

     const analytics = {
       totalSubscriptions: subscriptions.length,
       activeSubscriptions: subscriptions.filter(s => s.status === SUBSCRIPTION_STATUS.ACTIVE).length,
       revenue: subscriptions.reduce((sum, s) => sum + s.totalPaidAmount, 0),
       byPlan: {},
       byCycle: {},
       churnRate: 0,
       averageLifetimeValue: 0,
     };

     // Group by plan type
     for (const sub of subscriptions) {
       if (!analytics.byPlan[sub.planType]) {
         analytics.byPlan[sub.planType] = {
           count: 0,
           revenue: 0,
         };
       }
       analytics.byPlan[sub.planType].count++;
       analytics.byPlan[sub.planType].revenue += sub.totalPaidAmount;
     }

     // Calculate churn rate
     const cancelledCount = subscriptions.filter(s => 
       s.status === SUBSCRIPTION_STATUS.CANCELLED || 
       s.status === SUBSCRIPTION_STATUS.EXPIRED
     ).length;
     
     analytics.churnRate = subscriptions.length > 0 
       ? (cancelledCount / subscriptions.length) * 100 
       : 0;

     // Calculate average lifetime value
     analytics.averageLifetimeValue = subscriptions.length > 0
       ? analytics.revenue / subscriptions.length
       : 0;

     return analytics;
   } catch (error) {
     logger.error('Error getting subscription analytics:', error);
     throw error;
   }
 }
}

// Export singleton instance
export default new AppleIAPStrategy();