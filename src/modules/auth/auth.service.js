// src/modules/auth/auth.service.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../user/user.model.js';
import redis from '../../config/redis.js';
import logger from '../../shared/utils/logger.js';
import { 
  generateAuthTokens, 
  generateUniqueId, 
  generateOTP,
  generateRandomString 
} from '../../shared/utils/helpers.js';
import NotificationService from '../../shared/services/notification.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import CacheService from '../../shared/services/cache.service.js';
import QueueService from '../../shared/services/queue.service.js';
import TwoFactorAuthService from './strategies/2fa.strategy.js';
import AppError from '../../shared/errors/AppError.js';
import { ERROR_CODES, NOTIFICATION_TYPES } from '../../config/constants.js';

class AuthService {
  /**
   * Register new user
   */
  async register(userData) {
    try {
      const startTime = Date.now();

      // Normalize email and phone
      if (userData.email) {
        userData.email = userData.email.toLowerCase().trim();
      }
      if (userData.phoneNumber) {
        userData.phoneNumber = userData.phoneNumber.replace(/[\s\-\(\)]/g, '');
      }

      // Check if user already exists
      const existingUser = await User.findOne({
        $or: [
          userData.email && { email: userData.email },
          userData.phoneNumber && { phoneNumber: userData.phoneNumber },
        ].filter(Boolean),
      });

      if (existingUser) {
        if (existingUser.email === userData.email) {
          throw new AppError('Email already registered', 409, ERROR_CODES.USER_ALREADY_EXISTS);
        }
        if (existingUser.phoneNumber === userData.phoneNumber) {
          throw new AppError('Phone number already registered', 409, ERROR_CODES.USER_ALREADY_EXISTS);
        }
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(userData.password, 10);

      // Calculate age from date of birth
      const birthDate = new Date(userData.profile.dateOfBirth);
      const age = Math.floor((Date.now() - birthDate) / 31557600000);
      
      if (age < 18) {
        throw new AppError('You must be at least 18 years old', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      // Prepare user data
      const newUserData = {
        email: userData.email,
        phoneNumber: userData.phoneNumber,
        password: hashedPassword,
        profile: {
          firstName: userData.profile.firstName,
          lastName: userData.profile.lastName,
          displayName: userData.profile.firstName,
          dateOfBirth: userData.profile.dateOfBirth,
          gender: userData.profile.gender,
          bio: userData.profile.bio || '',
          interests: userData.profile.interests || [],
          location: userData.profile.location,
        },
        preferences: {
          ageRange: userData.preferences?.ageRange || { min: 18, max: 50 },
          maxDistance: userData.preferences?.maxDistance || 50,
          genderPreference: userData.preferences?.genderPreference || [],
          showMe: true,
        },
        verification: {
          email: {
            verified: false,
            verifiedAt: null,
          },
          phone: {
            verified: false,
            verifiedAt: null,
          },
        },
        scoring: {
          eloScore: 1500,
          activityScore: 1.0,
          profileCompleteness: this.calculateProfileCompleteness(userData.profile),
        },
        status: {
          isActive: true,
          isOnline: false,
          lastActive: new Date(),
        },
        security: {
          loginAttempts: 0,
          twoFactorEnabled: false,
        },
        subscription: {
          type: 'free',
          validUntil: null,
        },
        metadata: {
          registrationIp: userData.registrationIp,
          registrationSource: userData.source || 'web',
          deviceInfo: userData.deviceInfo,
          referralCode: userData.referralCode,
        },
      };

      // Create user
      const newUser = await User.create(newUserData);

      // Generate tokens
      const { accessToken, refreshToken, sessionId } = generateAuthTokens(newUser._id.toString());

      // Store refresh token in Redis
      await this.storeRefreshToken(newUser._id.toString(), refreshToken, sessionId, userData.deviceInfo);

      // Send verification email
      if (newUser.email) {
        await this.sendVerificationEmail(newUser);
      }

      // Send welcome notification
      await QueueService.addJob('notifications', {
        userId: newUser._id.toString(),
        notification: {
          type: NOTIFICATION_TYPES.SYSTEM,
          title: 'Welcome to Tinder Clone!',
          body: 'Complete your profile to start matching',
          data: { action: 'complete_profile' },
        },
      });

      // Track metrics
      const duration = Date.now() - startTime;
      await MetricsService.incrementCounter('auth.register.success');
      await MetricsService.recordTiming('auth.register.duration', duration);
      await MetricsService.trackUserAction(newUser._id.toString(), 'register', {
        source: userData.source || 'web',
        referralCode: userData.referralCode,
      });

      // Apply referral bonus if applicable
      if (userData.referralCode) {
        await this.applyReferralBonus(userData.referralCode, newUser._id.toString());
      }

      logger.info('User registered successfully', {
        userId: newUser._id,
        email: newUser.email,
        duration,
      });

      // Remove sensitive data
      const userObject = newUser.toObject();
      delete userObject.password;

      return {
        user: userObject,
        accessToken,
        refreshToken,
        sessionId,
      };
    } catch (error) {
      logger.error('Registration error:', error);
      await MetricsService.incrementCounter('auth.register.error');
      throw error;
    }
  }

  /**
   * Login user
   */
  async login(credentials, deviceInfo = {}) {
    try {
      const startTime = Date.now();
      const { email, phoneNumber, password } = credentials;

      // Find user by email or phone
      const user = await User.findOne({
        $or: [
          email && { email: email.toLowerCase().trim() },
          phoneNumber && { phoneNumber: phoneNumber?.replace(/[\s\-\(\)]/g, '') },
        ].filter(Boolean),
      }).select('+password +security');

      if (!user) {
        await MetricsService.incrementCounter('auth.login.failed', 1, { reason: 'user_not_found' });
        throw new AppError('Invalid credentials', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Check if account is locked
      if (user.security?.lockUntil && user.security.lockUntil > Date.now()) {
        const lockTime = Math.ceil((user.security.lockUntil - Date.now()) / 60000);
        throw new AppError(
          `Account is locked. Please try again in ${lockTime} minutes`,
          423,
          ERROR_CODES.ACCOUNT_LOCKED
        );
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        // Handle failed login attempt
        await this.handleFailedLogin(user);
        await MetricsService.incrementCounter('auth.login.failed', 1, { reason: 'invalid_password' });
        throw new AppError('Invalid credentials', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Check account status
      if (user.status?.isBanned) {
        throw new AppError('Your account has been banned', 403, ERROR_CODES.USER_BANNED);
      }

      if (!user.status?.isActive) {
        throw new AppError('Your account is inactive', 403, ERROR_CODES.USER_INACTIVE);
      }

      // Check email verification if required
      if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && !user.verification?.email?.verified) {
        throw new AppError('Please verify your email before logging in', 403, ERROR_CODES.EMAIL_NOT_VERIFIED);
      }

      // Reset failed login attempts
      if (user.security?.loginAttempts > 0) {
        user.security.loginAttempts = 0;
        user.security.lockUntil = null;
        await user.save();
      }

      // Check if 2FA is enabled
      if (user.security?.twoFactorEnabled) {
        // Generate temp token for 2FA verification
        const tempToken = this.generateTempToken(user._id.toString());
        await redis.set(`2fa:temp:${user._id}`, tempToken, 300); // 5 minutes

        // Send 2FA code if needed
        if (user.security.twoFactorMethod !== 'app') {
          await TwoFactorAuthService.send2FACode(user._id.toString());
        }

        return {
          requiresTwoFactor: true,
          tempToken,
          method: user.security.twoFactorMethod,
        };
      }

      // Generate tokens
      const { accessToken, refreshToken, sessionId } = generateAuthTokens(user._id.toString());

      // Store refresh token and session
      await this.storeRefreshToken(user._id.toString(), refreshToken, sessionId, deviceInfo);

      // Update user login info
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'status.lastLogin': new Date(),
          'status.lastLoginIp': deviceInfo.ip,
          'status.isOnline': true,
        },
        $push: {
          'metadata.devices': {
            $each: [{
              deviceId: deviceInfo.deviceId || generateUniqueId(),
              platform: deviceInfo.platform,
              lastUsed: new Date(),
            }],
            $slice: -5, // Keep only last 5 devices
          },
        },
      });

      // Track metrics
      const duration = Date.now() - startTime;
      await MetricsService.incrementCounter('auth.login.success');
      await MetricsService.recordTiming('auth.login.duration', duration);
      await MetricsService.trackUserAction(user._id.toString(), 'login', {
        method: email ? 'email' : 'phone',
        deviceInfo,
      });

      // Clear user cache to get fresh data
      await CacheService.invalidateUser(user._id.toString());

      logger.info('User logged in successfully', {
        userId: user._id,
        duration,
      });

      // Remove sensitive data
      const userObject = user.toObject();
      delete userObject.password;
      delete userObject.security;

      return {
        user: userObject,
        accessToken,
        refreshToken,
        sessionId,
      };
    } catch (error) {
      logger.error('Login error:', error);
      await MetricsService.incrementCounter('auth.login.error');
      throw error;
    }
  }

  /**
   * Complete 2FA login
   */
  async completeTwoFactorLogin(tempToken, code, deviceInfo = {}) {
    try {
      // Verify temp token
      const userId = await redis.get(`2fa:temp:${tempToken}`);
      if (!userId) {
        throw new AppError('Invalid or expired token', 401, ERROR_CODES.TOKEN_EXPIRED);
      }

      // Verify 2FA code
      await TwoFactorAuthService.verify2FALogin(userId, code);

      // Get user
      const user = await User.findById(userId);
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Generate tokens
      const { accessToken, refreshToken, sessionId } = generateAuthTokens(userId);

      // Store refresh token
      await this.storeRefreshToken(userId, refreshToken, sessionId, deviceInfo);

      // Update login info
      await User.findByIdAndUpdate(userId, {
        $set: {
          'status.lastLogin': new Date(),
          'status.lastLoginIp': deviceInfo.ip,
          'status.isOnline': true,
        },
      });

      // Clean up temp token
      await redis.del(`2fa:temp:${tempToken}`);
      await redis.del(`2fa:temp:${userId}`);

      // Track metrics
      await MetricsService.incrementCounter('auth.2fa.login.success');

      logger.info('2FA login completed', { userId });

      // Remove sensitive data
      const userObject = user.toObject();
      delete userObject.password;
      delete userObject.security;

      return {
        user: userObject,
        accessToken,
        refreshToken,
        sessionId,
      };
    } catch (error) {
      logger.error('2FA login error:', error);
      await MetricsService.incrementCounter('auth.2fa.login.error');
      throw error;
    }
  }

  /**
   * Logout user
   */
  async logout(userId, token, sessionId = null, allDevices = false) {
    try {
      if (allDevices) {
        // Logout from all devices
        const sessions = await redis.keys(`refresh:token:${userId}:*`);
        if (sessions.length > 0) {
          await redis.del(...sessions);
        }
        
        // Clear all user sessions
        await redis.del(`user:sessions:${userId}`);
        
        logger.info('User logged out from all devices', { userId });
      } else {
        // Logout from current device
        if (sessionId) {
          await redis.del(`refresh:token:${userId}:${sessionId}`);
          await redis.del(`session:${sessionId}`);
        }
      }

      // Blacklist current access token
      if (token) {
        const decoded = jwt.decode(token);
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redis.set(`blacklist:token:${token}`, '1', ttl);
        }
      }

      // Update user status
      await User.findByIdAndUpdate(userId, {
        $set: {
          'status.isOnline': false,
          'status.lastActive': new Date(),
        },
      });

      // Clear user cache
      await CacheService.invalidateUser(userId);

      // Track metrics
      await MetricsService.incrementCounter('auth.logout');
      await MetricsService.trackUserAction(userId, 'logout', {
        allDevices,
      });

      return { success: true, message: 'Logged out successfully' };
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      // Verify refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      
      if (decoded.type !== 'refresh') {
        throw new AppError('Invalid token type', 401, ERROR_CODES.TOKEN_INVALID);
      }

      // Check if refresh token exists in Redis
      const tokenKey = `refresh:token:${decoded.userId}:${decoded.sessionId}`;
      const storedToken = await redis.get(tokenKey);
      
      if (!storedToken || storedToken !== refreshToken) {
        throw new AppError('Invalid refresh token', 401, ERROR_CODES.TOKEN_INVALID);
      }

      // Get user
      const user = await User.findById(decoded.userId).select('status');
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (user.status?.isBanned || !user.status?.isActive) {
        await redis.del(tokenKey);
        throw new AppError('Account is not active', 403, ERROR_CODES.USER_INACTIVE);
      }

      // Generate new access token
      const newAccessToken = jwt.sign(
        { 
          userId: decoded.userId, 
          sessionId: decoded.sessionId,
          type: 'access' 
        },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: process.env.JWT_ACCESS_EXPIRY || '15m' }
      );

      // Extend refresh token expiry
      await redis.expire(tokenKey, 30 * 24 * 60 * 60); // 30 days

      // Track metrics
      await MetricsService.incrementCounter('auth.token.refresh');

      return {
        accessToken: newAccessToken,
        refreshToken, // Return same refresh token
      };
    } catch (error) {
      logger.error('Token refresh error:', error);
      throw error;
    }
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(user) {
    try {
      // Generate verification token
      const verificationToken = jwt.sign(
        {
          userId: user._id.toString(),
          email: user.email,
          type: 'email-verification',
          jti: generateUniqueId(),
        },
        process.env.JWT_EMAIL_SECRET || process.env.JWT_ACCESS_SECRET,
        { expiresIn: '24h' }
      );

      const verificationUrl = `${process.env.APP_URL}/verify-email?token=${verificationToken}`;

      // Queue email
      await QueueService.addJob('emails', {
        to: user.email,
        subject: 'Verify your email address',
        template: 'email-verification',
        data: {
          name: user.profile.firstName,
          verificationUrl,
        },
      });

      logger.info('Verification email queued', { userId: user._id, email: user.email });

      return { success: true, message: 'Verification email sent' };
    } catch (error) {
      logger.error('Error sending verification email:', error);
      throw error;
    }
  }

  /**
   * Verify email
   */
  async verifyEmail(token) {
    try {
      // Verify token
      const decoded = jwt.verify(
        token,
        process.env.JWT_EMAIL_SECRET || process.env.JWT_ACCESS_SECRET
      );

      if (decoded.type !== 'email-verification') {
        throw new AppError('Invalid token type', 400, ERROR_CODES.TOKEN_INVALID);
      }

      // Check if token has been used
      const usedKey = `used:email:token:${decoded.jti}`;
      const isUsed = await redis.exists(usedKey);
      if (isUsed) {
        throw new AppError('Token has already been used', 400, ERROR_CODES.TOKEN_INVALID);
      }

      // Get user
      const user = await User.findById(decoded.userId);
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (user.email !== decoded.email) {
        throw new AppError('Email mismatch', 400, ERROR_CODES.TOKEN_INVALID);
      }

      if (user.verification?.email?.verified) {
        throw new AppError('Email already verified', 400, ERROR_CODES.ALREADY_EXISTS);
      }

      // Update user
      await User.findByIdAndUpdate(decoded.userId, {
        $set: {
          'verification.email': {
            verified: true,
            verifiedAt: new Date(),
          },
        },
      });

      // Mark token as used
      await redis.set(usedKey, '1', 86400); // 24 hours

      // Send welcome email
      await QueueService.addJob('emails', {
        to: user.email,
        subject: 'Welcome to Tinder Clone!',
        template: 'welcome',
        data: {
          name: user.profile.firstName,
        },
      });

      // Track metrics
      await MetricsService.incrementCounter('auth.email.verified');
      await MetricsService.trackUserAction(decoded.userId, 'email_verified');

      logger.info('Email verified successfully', { userId: decoded.userId });

      return { success: true, message: 'Email verified successfully' };
    } catch (error) {
      logger.error('Email verification error:', error);
      throw error;
    }
  }

  /**
   * Request password reset
   */
  async requestPasswordReset(email) {
    try {
      email = email.toLowerCase().trim();
      
      // Check rate limiting
      const rateLimitKey = `password:reset:${email}`;
      const attempts = await redis.incr(rateLimitKey);
      
      if (attempts === 1) {
        await redis.expire(rateLimitKey, 3600); // 1 hour
      }

      if (attempts > 3) {
        throw new AppError(
          'Too many password reset requests. Please try again later.',
          429,
          ERROR_CODES.RATE_LIMIT_EXCEEDED
        );
      }

      // Find user
      const user = await User.findOne({ email });
      
      // Always return success to prevent email enumeration
      if (!user) {
        logger.warn('Password reset requested for non-existent email', { email });
        return { success: true, message: 'If the email exists, a reset link has been sent' };
      }

      // Generate reset token
      const resetToken = jwt.sign(
        {
          userId: user._id.toString(),
          type: 'password-reset',
          jti: generateUniqueId(),
          passwordHash: user.password.substring(0, 10), // Partial hash for validation
        },
        process.env.JWT_RESET_SECRET || process.env.JWT_ACCESS_SECRET,
        { expiresIn: '1h' }
      );

      const resetUrl = `${process.env.APP_URL}/reset-password?token=${resetToken}`;

      // Queue email
      await QueueService.addJob('emails', {
        to: user.email,
        subject: 'Reset your password',
        template: 'password-reset',
        data: {
          name: user.profile.firstName,
          resetUrl,
        },
      }, { priority: 10 }); // High priority

      // Track metrics
      await MetricsService.incrementCounter('auth.password.reset.requested');

      logger.info('Password reset email queued', { userId: user._id });

      return { success: true, message: 'If the email exists, a reset link has been sent' };
    } catch (error) {
      logger.error('Password reset request error:', error);
      throw error;
    }
  }

  /**
   * Reset password
   */
  async resetPassword(token, newPassword) {
    try {
      // Verify token
      const decoded = jwt.verify(
        token,
        process.env.JWT_RESET_SECRET || process.env.JWT_ACCESS_SECRET
      );

      if (decoded.type !== 'password-reset') {
        throw new AppError('Invalid token type', 400, ERROR_CODES.TOKEN_INVALID);
      }

      // Check if token has been used
      const usedKey = `used:reset:token:${decoded.jti}`;
      const isUsed = await redis.exists(usedKey);
      if (isUsed) {
        throw new AppError('Token has already been used', 400, ERROR_CODES.TOKEN_INVALID);
      }

      // Get user
      const user = await User.findById(decoded.userId).select('+password');
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Verify password hash hasn't changed
      if (decoded.passwordHash && user.password.substring(0, 10) !== decoded.passwordHash) {
        throw new AppError('Token invalidated due to password change', 400, ERROR_CODES.TOKEN_INVALID);
      }

      // Check if new password is same as old
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        throw new AppError('New password must be different from current password', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await User.findByIdAndUpdate(decoded.userId, {
        $set: {
          password: hashedPassword,
          'security.passwordChangedAt': new Date(),
        },
      });

      // Mark token as used
      await redis.set(usedKey, '1', 3600); // 1 hour

      // Invalidate all refresh tokens
      const sessions = await redis.keys(`refresh:token:${decoded.userId}:*`);
      if (sessions.length > 0) {
        await redis.del(...sessions);
      }

      // Send confirmation email
      await QueueService.addJob('emails', {
        to: user.email,
        subject: 'Password changed successfully',
        template: 'password-changed',
        data: {
          name: user.profile.firstName,
        },
      });

      // Track metrics
      await MetricsService.incrementCounter('auth.password.reset.success');
      await MetricsService.trackUserAction(decoded.userId, 'password_reset');

      logger.info('Password reset successfully', { userId: decoded.userId });

      return { success: true, message: 'Password reset successfully' };
    } catch (error) {
      logger.error('Password reset error:', error);
      throw error;
    }
  }

  /**
   * Change password (for logged-in users)
   */
  async changePassword(userId, currentPassword, newPassword) {
    try {
      // Get user
      const user = await User.findById(userId).select('+password');
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        throw new AppError('Current password is incorrect', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Check if new password is same as old
      const isSamePassword = await bcrypt.compare(newPassword, user.password);
      if (isSamePassword) {
        throw new AppError('New password must be different from current password', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await User.findByIdAndUpdate(userId, {
        $set: {
          password: hashedPassword,
          'security.passwordChangedAt': new Date(),
        },
      });

      // Send notification
      await NotificationService.sendNotification(userId, {
        type: NOTIFICATION_TYPES.SYSTEM,
        title: 'Password Changed',
        body: 'Your password has been changed successfully',
        priority: 'high',
      });

      // Track metrics
      await MetricsService.incrementCounter('auth.password.change');
      await MetricsService.trackUserAction(userId, 'password_changed');

      logger.info('Password changed successfully', { userId });

      return { success: true, message: 'Password changed successfully' };
    } catch (error) {
      logger.error('Password change error:', error);
      throw error;
    }
  }

  // Helper methods

  /**
   * Store refresh token in Redis
   */
  async storeRefreshToken(userId, refreshToken, sessionId, deviceInfo = {}) {
    const tokenKey = `refresh:token:${userId}:${sessionId}`;
    const sessionKey = `session:${sessionId}`;
    
    // Store refresh token
    await redis.set(tokenKey, refreshToken, 30 * 24 * 60 * 60); // 30 days
    
    // Store session info
    await redis.set(sessionKey, JSON.stringify({
      userId,
      deviceInfo,
      createdAt: new Date().toISOString(),
    }), 30 * 24 * 60 * 60);
  }

  /**
   * Handle failed login attempt
   */
  async handleFailedLogin(user) {
    user.security.loginAttempts = (user.security.loginAttempts || 0) + 1;
    user.security.lastFailedLogin = new Date();

    // Lock account after 5 failed attempts
    if (user.security.loginAttempts >= 5) {
      user.security.lockUntil = new Date(Date.now() + 30 * 60000); // Lock for 30 minutes
      
      logger.warn('Account locked due to failed attempts', {
        userId: user._id,
        attempts: user.security.loginAttempts,
      });

      // Send security alert
      if (user.email) {
        await QueueService.addJob('emails', {
          to: user.email,
          subject: 'Security Alert: Account Locked',
          template: 'security-alert',
          data: {
            name: user.profile.firstName,
            reason: 'multiple_failed_login_attempts',
          },
        });
      }
    }

    await user.save();
  }

  /**
   * Generate temporary token for 2FA
   */
  generateTempToken(userId) {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Calculate profile completeness
   */
  calculateProfileCompleteness(profile) {
    const fields = [
      'firstName',
      'bio',
      'photos',
      'interests',
      'dateOfBirth',
      'gender',
      'location',
    ];

    let completed = 0;
    fields.forEach(field => {
      if (profile[field]) {
        if (field === 'photos' && profile[field].length > 0) completed++;
        else if (field === 'interests' && profile[field].length > 0) completed++;
        else if (field !== 'photos' && field !== 'interests') completed++;
      }
    });

    return completed / fields.length;
  }

  /**
   * Apply referral bonus
   */
  async applyReferralBonus(referralCode, newUserId) {
    try {
      // Find referrer
      const referrer = await User.findOne({ 'metadata.referralCode': referralCode });
      
      if (!referrer) {
        logger.warn('Invalid referral code used', { code: referralCode });
        return;
      }

      // Apply bonus (e.g., free premium days)
      const bonusDays = 7;
      const currentValidUntil = referrer.subscription?.validUntil || new Date();
      const newValidUntil = new Date(Math.max(currentValidUntil, Date.now()) + bonusDays * 24 * 60 * 60 * 1000);

      await User.findByIdAndUpdate(referrer._id, {
        $set: {
          'subscription.validUntil': newValidUntil,
        },
        $inc: {
          'metadata.referralCount': 1,
        },
      });

      // Track referral
      await User.findByIdAndUpdate(newUserId, {
        $set: {
          'metadata.referredBy': referrer._id,
        },
      });

      // Send notification to referrer
      await NotificationService.sendNotification(referrer._id.toString(), {
        type: NOTIFICATION_TYPES.SYSTEM,
        title: 'Referral Bonus!',
        body: `You earned ${bonusDays} days of premium for referring a friend!`,
        data: { bonusType: 'referral', days: bonusDays },
      });

      logger.info('Referral bonus applied', {
        referrerId: referrer._id,
        newUserId,
        bonusDays,
      });
    } catch (error) {
      logger.error('Error applying referral bonus:', error);
    }
  }

  /**
   * Validate session
   */
  async validateSession(sessionId) {
    try {
      const sessionKey = `session:${sessionId}`;
      const sessionData = await redis.get(sessionKey);
      
      if (!sessionData) {
        return { valid: false };
      }

      const session = JSON.parse(sessionData);
      
      // Check if user is still active
      const user = await User.findById(session.userId).select('status');
      
      if (!user || user.status?.isBanned || !user.status?.isActive) {
        await redis.del(sessionKey);
        return { valid: false };
      }

      // Extend session
      await redis.expire(sessionKey, 30 * 24 * 60 * 60); // 30 days

      return {
        valid: true,
        userId: session.userId,
        deviceInfo: session.deviceInfo,
      };
    } catch (error) {
      logger.error('Session validation error:', error);
      return { valid: false };
    }
  }

  /**
   * Get active sessions for user
   */
  async getActiveSessions(userId) {
    try {
      const sessionKeys = await redis.keys(`refresh:token:${userId}:*`);
      const sessions = [];

      for (const key of sessionKeys) {
        const sessionId = key.split(':').pop();
        const sessionData = await redis.get(`session:${sessionId}`);
        
        if (sessionData) {
          const session = JSON.parse(sessionData);
          sessions.push({
            sessionId,
            ...session,
            current: false, // Will be set by controller based on current session
          });
        }
      }

      return sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } catch (error) {
      logger.error('Error getting active sessions:', error);
      return [];
    }
  }

  /**
   * Revoke specific session
   */
  async revokeSession(userId, sessionId, currentSessionId) {
    try {
      if (sessionId === currentSessionId) {
        throw new AppError('Cannot revoke current session', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      const tokenKey = `refresh:token:${userId}:${sessionId}`;
      const sessionKey = `session:${sessionId}`;
      
      await redis.del(tokenKey);
      await redis.del(sessionKey);

      logger.info('Session revoked', { userId, sessionId });

      return { success: true, message: 'Session revoked successfully' };
    } catch (error) {
      logger.error('Error revoking session:', error);
      throw error;
    }
  }

  /**
   * Send login alert
   */
  async sendLoginAlert(user, deviceInfo) {
    try {
      // Check if this is a new device
      const knownDevices = user.metadata?.devices || [];
      const isNewDevice = !knownDevices.some(d => d.deviceId === deviceInfo.deviceId);

      if (isNewDevice && user.email) {
        await QueueService.addJob('emails', {
          to: user.email,
          subject: 'New Login to Your Account',
          template: 'new-login',
          data: {
            name: user.profile.firstName,
            device: deviceInfo.platform || 'Unknown device',
            location: deviceInfo.location || 'Unknown location',
            time: new Date().toLocaleString(),
          },
        });
      }
    } catch (error) {
      logger.error('Error sending login alert:', error);
    }
  }

  /**
   * Check password strength
   */
  checkPasswordStrength(password) {
    const strength = {
      score: 0,
      feedback: [],
    };

    // Length check
    if (password.length >= 8) strength.score += 1;
    else strength.feedback.push('Password should be at least 8 characters');

    if (password.length >= 12) strength.score += 1;

    // Complexity checks
    if (/[a-z]/.test(password)) strength.score += 1;
    else strength.feedback.push('Add lowercase letters');

    if (/[A-Z]/.test(password)) strength.score += 1;
    else strength.feedback.push('Add uppercase letters');

    if (/\d/.test(password)) strength.score += 1;
    else strength.feedback.push('Add numbers');

    if (/[!@#$%^&*(),.?":{}|<>]/.test(password)) strength.score += 1;
    else strength.feedback.push('Add special characters');

    // Common patterns check
    const commonPasswords = ['password', '12345678', 'qwerty', 'admin'];
    if (commonPasswords.some(common => password.toLowerCase().includes(common))) {
      strength.score = Math.max(0, strength.score - 2);
      strength.feedback.push('Avoid common passwords');
    }

    // Determine strength level
    if (strength.score <= 2) strength.level = 'weak';
    else if (strength.score <= 4) strength.level = 'medium';
    else strength.level = 'strong';

    return strength;
  }

  /**
   * Verify captcha (if implemented)
   */
  async verifyCaptcha(captchaToken) {
    // This would integrate with services like Google reCAPTCHA
    // For now, we'll just return true in development
    if (process.env.NODE_ENV === 'development') {
      return true;
    }

    try {
      // Implement actual captcha verification here
      const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${captchaToken}`,
      });

      const data = await response.json();
      return data.success;
    } catch (error) {
      logger.error('Captcha verification error:', error);
      return false;
    }
  }

  /**
   * Send phone verification
   */
  async sendPhoneVerification(userId) {
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (!user.phoneNumber) {
        throw new AppError('Phone number not found', 400, ERROR_CODES.PHONE_NOT_VERIFIED);
      }

      if (user.verification?.phone?.verified) {
        throw new AppError('Phone already verified', 400, ERROR_CODES.ALREADY_EXISTS);
      }

      // Generate OTP
      const otp = generateOTP(6);
      
      // Store OTP in Redis
      const otpKey = `phone:otp:${userId}`;
      await redis.set(otpKey, otp, 300); // 5 minutes

      // Send SMS
      await NotificationService.sendSMS(user.phoneNumber, {
        message: `Your Tinder Clone verification code is: ${otp}`,
      });

      // Track metrics
      await MetricsService.incrementCounter('auth.phone.verification.sent');

      logger.info('Phone verification sent', { userId });

      return {
        success: true,
        message: 'Verification code sent to your phone',
        phoneNumber: user.phoneNumber.replace(/(\d{3})(\d{3})(\d{4})/, '***-***-$3'),
      };
    } catch (error) {
      logger.error('Phone verification error:', error);
      throw error;
    }
  }

  /**
   * Verify phone number
   */
  async verifyPhone(userId, otp) {
    try {
      // Get stored OTP
      const otpKey = `phone:otp:${userId}`;
      const storedOtp = await redis.get(otpKey);
      
      if (!storedOtp) {
        throw new AppError('OTP expired or not found', 400, ERROR_CODES.TOKEN_EXPIRED);
      }

      if (storedOtp !== otp) {
        throw new AppError('Invalid OTP', 400, ERROR_CODES.INVALID_OTP);
      }

      // Update user
      await User.findByIdAndUpdate(userId, {
        $set: {
          'verification.phone': {
            verified: true,
            verifiedAt: new Date(),
          },
        },
      });

      // Clean up OTP
      await redis.del(otpKey);

      // Track metrics
      await MetricsService.incrementCounter('auth.phone.verified');
      await MetricsService.trackUserAction(userId, 'phone_verified');

      logger.info('Phone verified successfully', { userId });

      return { success: true, message: 'Phone verified successfully' };
    } catch (error) {
      logger.error('Phone verification error:', error);
      throw error;
    }
  }

  /**
   * Delete account
   */
  async deleteAccount(userId, password, reason = '') {
    try {
      // Get user
      const user = await User.findById(userId).select('+password');
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new AppError('Invalid password', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Soft delete first
      await User.findByIdAndUpdate(userId, {
        $set: {
          'status.isActive': false,
          'status.deletedAt': new Date(),
          'status.deletionReason': reason,
        },
      });

      // Schedule hard delete after 30 days (for recovery purposes)
      await QueueService.addJob('account-deletion', {
        userId,
        scheduledAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, { delay: 30 * 24 * 60 * 60 * 1000 });

      // Logout from all devices
      await this.logout(userId, null, null, true);

      // Send confirmation email
      if (user.email) {
        await QueueService.addJob('emails', {
          to: user.email,
          subject: 'Account Deletion Confirmation',
          template: 'account-deleted',
          data: {
            name: user.profile.firstName,
            recoveryDays: 30,
          },
        });
      }

      // Track metrics
      await MetricsService.incrementCounter('auth.account.deleted');
      await MetricsService.trackUserAction(userId, 'account_deleted', { reason });

      logger.info('Account marked for deletion', { userId });

      return {
        success: true,
        message: 'Your account has been scheduled for deletion. You have 30 days to recover it.',
      };
    } catch (error) {
      logger.error('Account deletion error:', error);
      throw error;
    }
  }

  /**
   * Recover deleted account
   */
  async recoverAccount(email, password) {
    try {
      // Find deleted user
      const user = await User.findOne({
        email: email.toLowerCase().trim(),
        'status.isActive': false,
        'status.deletedAt': { $exists: true },
      }).select('+password');

      if (!user) {
        throw new AppError('Account not found or not eligible for recovery', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Check if within recovery period (30 days)
      const deletedAt = new Date(user.status.deletedAt);
      const daysSinceDeletion = Math.floor((Date.now() - deletedAt) / (24 * 60 * 60 * 1000));
      
      if (daysSinceDeletion > 30) {
        throw new AppError('Recovery period has expired', 400, ERROR_CODES.EXPIRED);
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new AppError('Invalid credentials', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Recover account
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'status.isActive': true,
        },
        $unset: {
          'status.deletedAt': '',
          'status.deletionReason': '',
        },
      });

      // Cancel scheduled deletion
      // This would need to be implemented in the queue processor

      // Send confirmation email
      if (user.email) {
        await QueueService.addJob('emails', {
          to: user.email,
          subject: 'Account Recovered Successfully',
          template: 'account-recovered',
          data: {
            name: user.profile.firstName,
          },
        });
      }

      // Track metrics
      await MetricsService.incrementCounter('auth.account.recovered');

      logger.info('Account recovered', { userId: user._id });

      return {
        success: true,
        message: 'Your account has been recovered successfully',
      };
    } catch (error) {
      logger.error('Account recovery error:', error);
      throw error;
    }
  }
}

export default new AuthService();