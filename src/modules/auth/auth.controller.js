// src/modules/auth/auth.controller.js
import AuthService from './auth.service.js';
// import TwoFactorAuthService from './strategies/2fa.strategy.js';
//import { unlinkOAuthAccount } from './strategies/oauth.strategy.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { 
  successResponse, 
  createdResponse, 
  badRequestResponse,
  unauthorizedResponse,
  notFoundResponse,
  conflictResponse,
  tooManyRequestsResponse 
} from '../../shared/utils/response.js';
import logger from '../../shared/utils/logger.js';
import MetricsService from '../../shared/services/metrics.service.js';
import { ERROR_CODES } from '../../config/constants.js';

class AuthController {
  /**
   * Register new user
   * @route POST /api/auth/register
   */
  register = asyncHandler(async (req, res) => {
    const timer = MetricsService.startTimer();

    // Extract device info
    const deviceInfo = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      platform: req.headers['x-platform'] || 'web',
      deviceId: req.headers['x-device-id'],
      appVersion: req.headers['x-app-version'],
    };

    // Prepare user data
    const userData = {
      ...req.body,
      registrationIp: req.ip,
      deviceInfo,
      source: req.query.source || 'organic',
      referralCode: req.query.ref || req.body.referralCode,
    };

    // Call service
    const result = await AuthService.register(userData);

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    // Log performance
    timer.done('auth.register');

    // Send response
    return createdResponse(res, {
      user: result.user,
      accessToken: result.accessToken,
      sessionId: result.sessionId,
    }, 'Registration successful. Please verify your email.');
  });

  /**
   * Login user
   * @route POST /api/auth/login
   */
  login = asyncHandler(async (req, res) => {
    const timer = MetricsService.startTimer();

    // Extract device info
    const deviceInfo = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      platform: req.headers['x-platform'] || 'web',
      deviceId: req.headers['x-device-id'],
      appVersion: req.headers['x-app-version'],
      location: req.headers['x-location'],
    };

    // Call service
    const result = await AuthService.login(req.body, deviceInfo);

    // Check if 2FA is required
    if (result.requiresTwoFactor) {
      timer.done('auth.login.2fa_required');
      
      return successResponse(res, {
        requiresTwoFactor: true,
        tempToken: result.tempToken,
        method: result.method,
      }, 'Please complete two-factor authentication');
    }

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    // Send login alert for new device
    if (result.user) {
      AuthService.sendLoginAlert(result.user, deviceInfo).catch(error => {
        logger.error('Failed to send login alert:', error);
      });
    }

    timer.done('auth.login');

    return successResponse(res, {
      user: result.user,
      accessToken: result.accessToken,
      sessionId: result.sessionId,
    }, 'Login successful');
  });

  /**
   * Complete 2FA login
   * @route POST /api/auth/2fa/verify
   */
  completeTwoFactorLogin = asyncHandler(async (req, res) => {
    const { tempToken, code } = req.body;

    if (!tempToken || !code) {
      return badRequestResponse(res, 'Temp token and code are required');
    }

    // Extract device info
    const deviceInfo = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      platform: req.headers['x-platform'] || 'web',
      deviceId: req.headers['x-device-id'],
    };

    // Call service
    const result = await AuthService.completeTwoFactorLogin(tempToken, code, deviceInfo);

    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    return successResponse(res, {
      user: result.user,
      accessToken: result.accessToken,
      sessionId: result.sessionId,
    }, '2FA verification successful');
  });

  /**
   * Logout user
   * @route POST /api/auth/logout
   */
  logout = asyncHandler(async (req, res) => {
    const { allDevices = false } = req.body;
    const token = req.token;
    const sessionId = req.sessionId;
    const userId = req.user._id;

    // Call service
    await AuthService.logout(userId, token, sessionId, allDevices);

    // Clear refresh token cookie
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
    });

    return successResponse(res, null, allDevices ? 'Logged out from all devices' : 'Logged out successfully');
  });

  /**
   * Refresh access token
   * @route POST /api/auth/refresh
   */
  refreshToken = asyncHandler(async (req, res) => {
    const refreshToken = req.cookies.refreshToken || req.body.refreshToken;

    if (!refreshToken) {
      return unauthorizedResponse(res, 'Refresh token is required');
    }

    // Call service
    const result = await AuthService.refreshAccessToken(refreshToken);

    return successResponse(res, {
      accessToken: result.accessToken,
    }, 'Token refreshed successfully');
  });

  /**
   * Request email verification
   * @route POST /api/auth/verify-email/send
   */
  sendVerificationEmail = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const user = req.user;

    if (!user.email) {
      return badRequestResponse(res, 'Email not found');
    }

    if (user.verification?.email?.verified) {
      return badRequestResponse(res, 'Email already verified');
    }

    // Call service
    await AuthService.sendVerificationEmail(user);

    return successResponse(res, null, 'Verification email sent');
  });

  /**
   * Verify email
   * @route GET /api/auth/verify-email/:token
   */
  verifyEmail = asyncHandler(async (req, res) => {
    const { token } = req.params;

    if (!token) {
      return badRequestResponse(res, 'Verification token is required');
    }

    // Call service
    await AuthService.verifyEmail(token);

    return successResponse(res, null, 'Email verified successfully');
  });

  /**
   * Request phone verification
   * @route POST /api/auth/verify-phone/send
   */
  sendPhoneVerification = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    // Call service
    const result = await AuthService.sendPhoneVerification(userId);

    return successResponse(res, {
      phoneNumber: result.phoneNumber,
    }, result.message);
  });

  /**
   * Verify phone number
   * @route POST /api/auth/verify-phone
   */
  verifyPhone = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { otp } = req.body;

    if (!otp) {
      return badRequestResponse(res, 'OTP is required');
    }

    // Call service
    await AuthService.verifyPhone(userId, otp);

    return successResponse(res, null, 'Phone verified successfully');
  });

  /**
   * Request password reset
   * @route POST /api/auth/password/forgot
   */
  forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    if (!email) {
      return badRequestResponse(res, 'Email is required');
    }

    // Call service
    await AuthService.requestPasswordReset(email);

    // Always return success to prevent email enumeration
    return successResponse(res, null, 'If the email exists, a reset link has been sent');
  });

  /**
   * Reset password
   * @route POST /api/auth/password/reset/:token
   */
  resetPassword = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    if (!token) {
      return badRequestResponse(res, 'Reset token is required');
    }

    if (!password) {
      return badRequestResponse(res, 'New password is required');
    }

    // Check password strength
    const strength = AuthService.checkPasswordStrength(password);
    if (strength.level === 'weak') {
      return badRequestResponse(res, 'Password is too weak', strength.feedback);
    }

    // Call service
    await AuthService.resetPassword(token, password);

    return successResponse(res, null, 'Password reset successfully');
  });

  /**
   * Change password
   * @route POST /api/auth/password/change
   */
  changePassword = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return badRequestResponse(res, 'Current and new passwords are required');
    }

    // Check password strength
    const strength = AuthService.checkPasswordStrength(newPassword);
    if (strength.level === 'weak') {
      return badRequestResponse(res, 'New password is too weak', strength.feedback);
    }

    // Call service
    await AuthService.changePassword(userId, currentPassword, newPassword);

    return successResponse(res, null, 'Password changed successfully');
  });

  /**
   * Check password strength
   * @route POST /api/auth/password/strength
   */
  checkPasswordStrength = asyncHandler(async (req, res) => {
    const { password } = req.body;

    if (!password) {
      return badRequestResponse(res, 'Password is required');
    }

    const strength = AuthService.checkPasswordStrength(password);

    return successResponse(res, strength);
  });

  /**
   * Get active sessions
   * @route GET /api/auth/sessions
   */
  getSessions = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const currentSessionId = req.sessionId;

    // Get sessions
    const sessions = await AuthService.getActiveSessions(userId);

    // Mark current session
    sessions.forEach(session => {
      session.current = session.sessionId === currentSessionId;
    });

    return successResponse(res, { sessions });
  });

  /**
   * Revoke session
   * @route DELETE /api/auth/sessions/:sessionId
   */
  revokeSession = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { sessionId } = req.params;
    const currentSessionId = req.sessionId;

    if (!sessionId) {
      return badRequestResponse(res, 'Session ID is required');
    }

    // Call service
    await AuthService.revokeSession(userId, sessionId, currentSessionId);

    return successResponse(res, null, 'Session revoked successfully');
  });

  // 2FA Management

  /**
   * Enable 2FA
   * @route POST /api/auth/2fa/enable
   */
  enable2FA = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { method = 'app' } = req.body;

    // Call service
    const result = await TwoFactorAuthService.enable2FA(userId, method);

    return successResponse(res, result, '2FA setup initiated');
  });

  /**
   * Verify 2FA setup
   * @route POST /api/auth/2fa/verify-setup
   */
  verify2FASetup = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { code, backupCodes } = req.body;

    if (!code) {
      return badRequestResponse(res, 'Verification code is required');
    }

    // Call service
    const result = await TwoFactorAuthService.verify2FASetup(userId, code, backupCodes);

    return successResponse(res, result, '2FA enabled successfully');
  });

  /**
   * Disable 2FA
   * @route POST /api/auth/2fa/disable
   */
  disable2FA = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { password } = req.body;

    if (!password) {
      return badRequestResponse(res, 'Password is required');
    }

    // Call service
    const result = await TwoFactorAuthService.disable2FA(userId, password);

    return successResponse(res, result, '2FA disabled successfully');
  });

  /**
   * Regenerate backup codes
   * @route POST /api/auth/2fa/backup-codes
   */
  regenerateBackupCodes = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { password } = req.body;

    if (!password) {
      return badRequestResponse(res, 'Password is required');
    }

    // Call service
    const result = await TwoFactorAuthService.regenerateBackupCodes(userId, password);

    return successResponse(res, {
      backupCodes: result.backupCodes,
    }, 'Backup codes regenerated successfully');
  });

  /**
   * Send 2FA code
   * @route POST /api/auth/2fa/send
   */
  send2FACode = asyncHandler(async (req, res) => {
    const userId = req.user._id;

    // Call service
    const result = await TwoFactorAuthService.send2FACode(userId);

    return successResponse(res, result, 'Verification code sent');
  });

  // OAuth Management

  /**
   * Link OAuth account
   * @route POST /api/auth/oauth/:provider/link
   */
  linkOAuthAccount = asyncHandler(async (req, res) => {
    // This is handled by Passport OAuth strategies
    // The actual linking happens in the OAuth callback
    return successResponse(res, null, 'Redirecting to OAuth provider...');
  });

  /**
   * Unlink OAuth account
   * @route DELETE /api/auth/oauth/:provider
   */
  unlinkOAuthAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { provider } = req.params;

    if (!['google', 'facebook', 'apple'].includes(provider)) {
      return badRequestResponse(res, 'Invalid OAuth provider');
    }

    // Call service
    const result = await unlinkOAuthAccount(userId, provider);

    return successResponse(res, result, `${provider} account unlinked successfully`);
  });

  /**
   * OAuth callback handler
   * @route GET /api/auth/:provider/callback
   */
  oauthCallback = asyncHandler(async (req, res) => {
    // This is handled by Passport OAuth strategies
    // After successful OAuth, generate tokens and redirect
    
    if (!req.user) {
      return unauthorizedResponse(res, 'OAuth authentication failed');
    }

    // Generate tokens
    const { accessToken, refreshToken, sessionId } = generateAuthTokens(req.user._id.toString());

    // Set refresh token cookie
    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    // Store refresh token
    await AuthService.storeRefreshToken(req.user._id.toString(), refreshToken, sessionId, {
      platform: 'oauth',
      provider: req.params.provider,
    });

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${accessToken}&sessionId=${sessionId}`;
    res.redirect(redirectUrl);
  });

  // Account Management

  /**
   * Delete account
   * @route DELETE /api/auth/account
   */
  deleteAccount = asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const { password, reason } = req.body;

    if (!password) {
      return badRequestResponse(res, 'Password is required');
    }

    // Call service
    const result = await AuthService.deleteAccount(userId, password, reason);

    // Clear cookies
    res.clearCookie('refreshToken');

    return successResponse(res, result, result.message);
  });

  /**
   * Recover deleted account
   * @route POST /api/auth/account/recover
   */
  recoverAccount = asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
      return badRequestResponse(res, 'Email and password are required');
    }

    // Call service
    const result = await AuthService.recoverAccount(email, password);

    return successResponse(res, result, result.message);
  });

  /**
   * Get auth status
   * @route GET /api/auth/status
   */
  getAuthStatus = asyncHandler(async (req, res) => {
    const user = req.user;
    
    if (!user) {
      return successResponse(res, {
        authenticated: false,
      });
    }

    return successResponse(res, {
      authenticated: true,
      user: {
        id: user._id,
        email: user.email,
        profile: {
          firstName: user.profile?.firstName,
          displayName: user.profile?.displayName,
          photo: user.profile?.photos?.[0]?.url,
        },
        verification: {
          email: user.verification?.email?.verified,
          phone: user.verification?.phone?.verified,
        },
        subscription: user.subscription?.type,
        twoFactorEnabled: user.security?.twoFactorEnabled,
      },
    });
  });

  /**
   * Validate token
   * @route POST /api/auth/validate
   */
  validateToken = asyncHandler(async (req, res) => {
    // If middleware passed, token is valid
    return successResponse(res, {
      valid: true,
      user: {
        id: req.user._id,
        email: req.user.email,
      },
    });
  });

  /**
   * Resend verification (email/phone)
   * @route POST /api/auth/resend-verification
   */
  resendVerification = asyncHandler(async (req, res) => {
    const { type } = req.body;
    const userId = req.user._id;

    if (!['email', 'phone'].includes(type)) {
      return badRequestResponse(res, 'Invalid verification type');
    }

    if (type === 'email') {
      await AuthService.sendVerificationEmail(req.user);
    } else {
      await AuthService.sendPhoneVerification(userId);
    }

    return successResponse(res, null, `${type} verification sent`);
  });

  /**
   * Check email availability
   * @route GET /api/auth/check-email
   */
  checkEmailAvailability = asyncHandler(async (req, res) => {
    const { email } = req.query;

    if (!email) {
      return badRequestResponse(res, 'Email is required');
    }

    const User = (await import('../user/user.model.js')).default;
    const exists = await User.exists({ email: email.toLowerCase().trim() });

    return successResponse(res, {
      available: !exists,
      email: email.toLowerCase().trim(),
    });
  });

  /**
   * Check phone availability
   * @route GET /api/auth/check-phone
   */
  checkPhoneAvailability = asyncHandler(async (req, res) => {
    const { phone } = req.query;

    if (!phone) {
      return badRequestResponse(res, 'Phone number is required');
    }

    const User = (await import('../user/user.model.js')).default;
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '');
    const exists = await User.exists({ phoneNumber: normalizedPhone });

    return successResponse(res, {
      available: !exists,
      phone: normalizedPhone,
    });
  });

  /**
   * Get security settings
   * @route GET /api/auth/security
   */
  getSecuritySettings = asyncHandler(async (req, res) => {
    const user = req.user;

    return successResponse(res, {
      twoFactor: {
        enabled: user.security?.twoFactorEnabled || false,
        method: user.security?.twoFactorMethod || null,
      },
      sessions: {
        count: await AuthService.getActiveSessions(user._id).then(s => s.length),
      },
      lastPasswordChange: user.security?.passwordChangedAt || null,
      loginAttempts: user.security?.loginAttempts || 0,
      accountLocked: user.security?.lockUntil > Date.now(),
    });
  });
}

export default new AuthController();