// src/modules/auth/strategies/2fa.strategy.js
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import User from '../../user/user.model.js';
import redis from '../../../config/redis.js';
import logger from '../../../shared/utils/logger.js';
import { generateOTP } from '../../../shared/utils/helpers.js';
import NotificationService from '../../../shared/services/notification.service.js';
import MetricsService from '../../../shared/services/metrics.service.js';
import AppError from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../config/constants.js';

/**
 * Two-Factor Authentication Service
 */
class TwoFactorAuthService {
  /**
   * Enable 2FA for user
   */
  async enable2FA(userId, method = 'app') {
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (user.security?.twoFactorEnabled) {
        throw new AppError('Two-factor authentication is already enabled', 400, ERROR_CODES.ALREADY_EXISTS);
      }

      let result;

      switch (method) {
        case 'app':
          result = await this.setupAuthenticatorApp(user);
          break;
        case 'sms':
          result = await this.setupSMS2FA(user);
          break;
        case 'email':
          result = await this.setupEmail2FA(user);
          break;
        default:
          throw new AppError('Invalid 2FA method', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      // Track metric
      await MetricsService.incrementCounter('auth.2fa.setup.initiated', 1, { method });

      return result;
    } catch (error) {
      logger.error('Error enabling 2FA:', error);
      throw error;
    }
  }

  /**
   * Setup authenticator app 2FA
   */
  async setupAuthenticatorApp(user) {
    // Generate secret
    const secret = speakeasy.generateSecret({
      name: `Tinder Clone (${user.email})`,
      issuer: 'Tinder Clone',
      length: 32,
    });

    // Store temp secret in Redis (expires in 10 minutes)
    const tempKey = `2fa:temp:${user._id}`;
    await redis.set(tempKey, JSON.stringify({
      secret: secret.base32,
      method: 'app',
      createdAt: new Date().toISOString(),
    }), 600);

    // Generate QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    return {
      method: 'app',
      secret: secret.base32,
      qrCode: qrCodeUrl,
      backupCodes,
      manualEntry: secret.base32,
    };
  }

  /**
   * Setup SMS 2FA
   */
  async setupSMS2FA(user) {
    if (!user.phoneNumber || !user.verification?.phone?.verified) {
      throw new AppError('Verified phone number required for SMS 2FA', 400, ERROR_CODES.PHONE_NOT_VERIFIED);
    }

    // Generate and send OTP
    const otp = generateOTP(6);
    
    // Store OTP in Redis (expires in 5 minutes)
    const otpKey = `2fa:otp:sms:${user._id}`;
    await redis.set(otpKey, otp, 300);

    // Send SMS
    await NotificationService.sendSMS(user.phoneNumber, {
      message: `Your Tinder Clone 2FA setup code is: ${otp}. Valid for 5 minutes.`,
    });

    logger.info('SMS 2FA setup initiated', { userId: user._id });

    return {
      method: 'sms',
      phoneNumber: user.phoneNumber.replace(/(\d{3})(\d{3})(\d{4})/, '***-***-$3'),
      message: 'Verification code sent to your phone',
    };
  }

  /**
   * Setup Email 2FA
   */
  async setupEmail2FA(user) {
    if (!user.email || !user.verification?.email?.verified) {
      throw new AppError('Verified email required for email 2FA', 400, ERROR_CODES.EMAIL_NOT_VERIFIED);
    }

    // Generate and send OTP
    const otp = generateOTP(6);
    
    // Store OTP in Redis (expires in 10 minutes)
    const otpKey = `2fa:otp:email:${user._id}`;
    await redis.set(otpKey, otp, 600);

    // Send email
    await NotificationService.sendEmail(user.email, {
      subject: 'Two-Factor Authentication Setup',
      template: '2fa-setup',
      data: {
        name: user.profile.firstName,
        code: otp,
      },
    });

    logger.info('Email 2FA setup initiated', { userId: user._id });

    return {
      method: 'email',
      email: user.email.replace(/(.{2})(.*)(@.*)/, '$1***$3'),
      message: 'Verification code sent to your email',
    };
  }

  /**
   * Verify 2FA setup
   */
  async verify2FASetup(userId, code, backupCodes = null) {
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      // Get temp setup data
      const tempKey = `2fa:temp:${userId}`;
      const tempData = await redis.get(tempKey);
      
      if (!tempData) {
        throw new AppError('2FA setup expired or not found', 400, ERROR_CODES.TOKEN_EXPIRED);
      }

      const setupData = JSON.parse(tempData);
      let isValid = false;

      switch (setupData.method) {
        case 'app':
          isValid = speakeasy.totp.verify({
            secret: setupData.secret,
            encoding: 'base32',
            token: code,
            window: 2,
          });
          break;

        case 'sms':
          const smsOtpKey = `2fa:otp:sms:${userId}`;
          const smsOtp = await redis.get(smsOtpKey);
          isValid = smsOtp === code;
          if (isValid) await redis.del(smsOtpKey);
          break;

        case 'email':
          const emailOtpKey = `2fa:otp:email:${userId}`;
          const emailOtp = await redis.get(emailOtpKey);
          isValid = emailOtp === code;
          if (isValid) await redis.del(emailOtpKey);
          break;
      }

      if (!isValid) {
        throw new AppError('Invalid verification code', 400, ERROR_CODES.INVALID_OTP);
      }

      // Enable 2FA for user
      const updateData = {
        'security.twoFactorEnabled': true,
        'security.twoFactorMethod': setupData.method,
        'security.twoFactorEnabledAt': new Date(),
      };

      if (setupData.method === 'app') {
        updateData['security.twoFactorSecret'] = setupData.secret;
      }

      if (backupCodes) {
        // Hash backup codes before storing
        const hashedCodes = await Promise.all(
          backupCodes.map(async (code) => {
            const salt = await bcrypt.genSalt(10);
            return bcrypt.hash(code, salt);
          })
        );
        updateData['security.backupCodes'] = hashedCodes;
      }

      await User.findByIdAndUpdate(userId, { $set: updateData });

      // Clean up temp data
      await redis.del(tempKey);

      // Track metric
      await MetricsService.incrementCounter('auth.2fa.enabled', 1, { method: setupData.method });

      logger.info('2FA enabled successfully', { userId, method: setupData.method });

      return {
        success: true,
        message: 'Two-factor authentication enabled successfully',
        method: setupData.method,
      };
    } catch (error) {
      logger.error('Error verifying 2FA setup:', error);
      throw error;
    }
  }

  /**
   * Verify 2FA code during login
   */
  async verify2FALogin(userId, code, method = null) {
    try {
      const user = await User.findById(userId).select('+security.twoFactorSecret');
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (!user.security?.twoFactorEnabled) {
        throw new AppError('2FA is not enabled', 400, ERROR_CODES.TWO_FACTOR_NOT_ENABLED);
      }

      const verifyMethod = method || user.security.twoFactorMethod;
      let isValid = false;

      // Check rate limiting
      const attemptKey = `2fa:attempts:${userId}`;
      const attempts = await redis.incr(attemptKey);
      
      if (attempts === 1) {
        await redis.expire(attemptKey, 300); // 5 minutes
      }

      if (attempts > 5) {
        throw new AppError('Too many 2FA attempts. Please try again later.', 429, ERROR_CODES.RATE_LIMIT_EXCEEDED);
      }

      switch (verifyMethod) {
        case 'app':
          isValid = speakeasy.totp.verify({
            secret: user.security.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 2,
          });
          break;

        case 'sms':
        case 'email':
          const otpKey = `2fa:otp:${verifyMethod}:${userId}`;
          const storedOtp = await redis.get(otpKey);
          isValid = storedOtp === code;
          if (isValid) await redis.del(otpKey);
          break;

        case 'backup':
          // Check backup codes
          if (user.security?.backupCodes) {
            for (let i = 0; i < user.security.backupCodes.length; i++) {
              const isMatch = await bcrypt.compare(code, user.security.backupCodes[i]);
              if (isMatch) {
                isValid = true;
                // Remove used backup code
                user.security.backupCodes.splice(i, 1);
                await user.save();
                logger.info('Backup code used', { userId });
                break;
              }
            }
          }
          break;
      }

      if (!isValid) {
        await MetricsService.incrementCounter('auth.2fa.failed');
        throw new AppError('Invalid 2FA code', 400, ERROR_CODES.INVALID_OTP);
      }

      // Reset attempts on success
      await redis.del(attemptKey);

      // Track metric
      await MetricsService.incrementCounter('auth.2fa.success', 1, { method: verifyMethod });

      return {
        success: true,
        verified: true,
      };
    } catch (error) {
      logger.error('Error verifying 2FA login:', error);
      throw error;
    }
  }

  /**
   * Send 2FA code
   */
  async send2FACode(userId) {
    try {
      const user = await User.findById(userId);
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (!user.security?.twoFactorEnabled) {
        throw new AppError('2FA is not enabled', 400, ERROR_CODES.TWO_FACTOR_NOT_ENABLED);
      }

      const method = user.security.twoFactorMethod;
      const otp = generateOTP(6);

      switch (method) {
        case 'sms':
          if (!user.phoneNumber) {
            throw new AppError('Phone number not found', 400, ERROR_CODES.PHONE_NOT_VERIFIED);
          }

          await redis.set(`2fa:otp:sms:${userId}`, otp, 300);
          await NotificationService.sendSMS(user.phoneNumber, {
            message: `Your Tinder Clone login code is: ${otp}. Valid for 5 minutes.`,
          });
          break;

        case 'email':
          if (!user.email) {
            throw new AppError('Email not found', 400, ERROR_CODES.EMAIL_NOT_VERIFIED);
          }

          await redis.set(`2fa:otp:email:${userId}`, otp, 600);
          await NotificationService.sendEmail(user.email, {
            subject: 'Your Login Code',
            template: '2fa-login',
            data: {
              name: user.profile.firstName,
              code: otp,
            },
          });
          break;

        case 'app':
          throw new AppError('Use your authenticator app to generate the code', 400, ERROR_CODES.VALIDATION_ERROR);

        default:
          throw new AppError('Invalid 2FA method', 400, ERROR_CODES.VALIDATION_ERROR);
      }

      logger.info('2FA code sent', { userId, method });

      return {
        success: true,
        method,
        message: `Code sent via ${method}`,
      };
    } catch (error) {
      logger.error('Error sending 2FA code:', error);
      throw error;
    }
  }

  /**
   * Disable 2FA
   */
  async disable2FA(userId, password) {
    try {
      const user = await User.findById(userId).select('+password');
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (!user.security?.twoFactorEnabled) {
        throw new AppError('2FA is not enabled', 400, ERROR_CODES.TWO_FACTOR_NOT_ENABLED);
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new AppError('Invalid password', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Disable 2FA
      await User.findByIdAndUpdate(userId, {
        $set: {
          'security.twoFactorEnabled': false,
          'security.twoFactorMethod': null,
          'security.twoFactorSecret': null,
          'security.backupCodes': [],
        },
      });

      // Track metric
      await MetricsService.incrementCounter('auth.2fa.disabled');

      logger.info('2FA disabled', { userId });

      return {
        success: true,
        message: 'Two-factor authentication disabled',
      };
    } catch (error) {
      logger.error('Error disabling 2FA:', error);
      throw error;
    }
  }

  /**
   * Generate backup codes
   */
  generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push(`${generateOTP(4)}-${generateOTP(4)}`);
    }
    return codes;
  }

  /**
   * Regenerate backup codes
   */
  async regenerateBackupCodes(userId, password) {
    try {
      const user = await User.findById(userId).select('+password');
      
      if (!user) {
        throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
      }

      if (!user.security?.twoFactorEnabled) {
        throw new AppError('2FA is not enabled', 400, ERROR_CODES.TWO_FACTOR_NOT_ENABLED);
      }

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        throw new AppError('Invalid password', 401, ERROR_CODES.INVALID_CREDENTIALS);
      }

      // Generate new backup codes
      const backupCodes = this.generateBackupCodes();
      
      // Hash and store backup codes
      const hashedCodes = await Promise.all(
        backupCodes.map(async (code) => {
          const salt = await bcrypt.genSalt(10);
          return bcrypt.hash(code, salt);
        })
      );

      await User.findByIdAndUpdate(userId, {
        $set: {
          'security.backupCodes': hashedCodes,
        },
      });

      logger.info('Backup codes regenerated', { userId });

      return {
        success: true,
        backupCodes,
        message: 'Backup codes regenerated successfully',
      };
    } catch (error) {
      logger.error('Error regenerating backup codes:', error);
      throw error;
    }
  }
}

export default new TwoFactorAuthService();