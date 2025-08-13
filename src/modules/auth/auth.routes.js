// src/modules/auth/auth.routes.js
import { Router } from 'express';
import passport from 'passport';
import AuthController from './auth.controller.js';
import { authValidators } from '../../shared/utils/validators.js';
import { validate } from '../../shared/middleware/validation.middleware.js';
import { 
  authenticate, 
  optionalAuth,
  verifyRefreshToken,
  extractDeviceInfo 
} from '../../shared/middleware/auth.middleware.js';
import {
  authLimiter,
  registrationLimiter,
  passwordResetLimiter,
  customRateLimiter
} from '../../shared/middleware/rateLimiter.middleware.js';
import {
  sanitizeRequest,
  validateEmail,
  validatePhone,
  validatePassword,
  validateAge,
  validateObjectId
} from '../../shared/middleware/validation.middleware.js';
import { 
  cacheMiddleware, 
  clearCache 
} from '../../shared/middleware/cache.middleware.js';

const router = Router();

/**
 * @route   /api/auth
 * @desc    Authentication routes
 */

// ============================
// Public Routes (No Auth Required)
// ============================

/**
 * @route   POST /api/auth/register
 * @desc    Register new user
 * @access  Public
 */
router.post(
  '/register',
  registrationLimiter,
  sanitizeRequest,
  extractDeviceInfo,
  authValidators.register,
  validate,
  validateAge,
  AuthController.register
);

/**
 * @route   POST /api/auth/login
 * @desc    Login user with email/phone and password
 * @access  Public
 */
router.post(
  '/login',
  authLimiter,
  sanitizeRequest,
  extractDeviceInfo,
  authValidators.login,
  validate,
  AuthController.login
);

/**
 * @route   POST /api/auth/2fa/verify
 * @desc    Complete 2FA login
 * @access  Public
 */
router.post(
  '/2fa/verify',
  authLimiter,
  sanitizeRequest,
  extractDeviceInfo,
  AuthController.completeTwoFactorLogin
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public (requires refresh token)
 */
router.post(
  '/refresh',
  customRateLimiter({ limit: 10, window: 60 }),
  verifyRefreshToken,
  AuthController.refreshToken
);

/**
 * @route   GET /api/auth/verify-email/:token
 * @desc    Verify email address
 * @access  Public
 */
router.get(
  '/verify-email/:token',
  customRateLimiter({ limit: 5, window: 300 }),
  authValidators.verifyEmail,
  validate,
  AuthController.verifyEmail
);

/**
 * @route   POST /api/auth/password/forgot
 * @desc    Request password reset
 * @access  Public
 */
router.post(
  '/password/forgot',
  passwordResetLimiter,
  sanitizeRequest,
  authValidators.forgotPassword,
  validate,
  AuthController.forgotPassword
);

/**
 * @route   POST /api/auth/password/reset/:token
 * @desc    Reset password with token
 * @access  Public
 */
router.post(
  '/password/reset/:token',
  passwordResetLimiter,
  sanitizeRequest,
  authValidators.resetPassword,
  validate,
  validatePassword,
  AuthController.resetPassword
);

/**
 * @route   POST /api/auth/account/recover
 * @desc    Recover deleted account
 * @access  Public
 */
router.post(
  '/account/recover',
  customRateLimiter({ limit: 3, window: 3600 }),
  sanitizeRequest,
  validateEmail,
  AuthController.recoverAccount
);

/**
 * @route   GET /api/auth/check-email
 * @desc    Check if email is available
 * @access  Public
 */
router.get(
  '/check-email',
  customRateLimiter({ limit: 10, window: 60 }),
  cacheMiddleware({ ttl: 300 }),
  AuthController.checkEmailAvailability
);

/**
 * @route   GET /api/auth/check-phone
 * @desc    Check if phone number is available
 * @access  Public
 */
router.get(
  '/check-phone',
  customRateLimiter({ limit: 10, window: 60 }),
  cacheMiddleware({ ttl: 300 }),
  AuthController.checkPhoneAvailability
);

/**
 * @route   POST /api/auth/password/strength
 * @desc    Check password strength
 * @access  Public
 */
router.post(
  '/password/strength',
  customRateLimiter({ limit: 20, window: 60 }),
  sanitizeRequest,
  AuthController.checkPasswordStrength
);

// ============================
// OAuth Routes
// ============================

/**
 * @route   GET /api/auth/google
 * @desc    Initiate Google OAuth
 * @access  Public
 */
router.get(
  '/google',
  passport.authenticate('google', { 
    scope: ['profile', 'email'] 
  })
);

/**
 * @route   GET /api/auth/google/callback
 * @desc    Google OAuth callback
 * @access  Public
 */
router.get(
  '/google/callback',
  passport.authenticate('google', { 
    failureRedirect: `${process.env.FRONTEND_URL}/auth/error` 
  }),
  AuthController.oauthCallback
);

/**
 * @route   GET /api/auth/facebook
 * @desc    Initiate Facebook OAuth
 * @access  Public
 */
router.get(
  '/facebook',
  passport.authenticate('facebook', { 
    scope: ['email', 'public_profile'] 
  })
);

/**
 * @route   GET /api/auth/facebook/callback
 * @desc    Facebook OAuth callback
 * @access  Public
 */
router.get(
  '/facebook/callback',
  passport.authenticate('facebook', { 
    failureRedirect: `${process.env.FRONTEND_URL}/auth/error` 
  }),
  AuthController.oauthCallback
);

/**
 * @route   POST /api/auth/apple
 * @desc    Initiate Apple Sign In
 * @access  Public
 */
router.post(
  '/apple',
  passport.authenticate('apple')
);

/**
 * @route   POST /api/auth/apple/callback
 * @desc    Apple Sign In callback
 * @access  Public
 */
router.post(
  '/apple/callback',
  passport.authenticate('apple', { 
    failureRedirect: `${process.env.FRONTEND_URL}/auth/error` 
  }),
  AuthController.oauthCallback
);

// ============================
// Protected Routes (Auth Required)
// ============================

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post(
  '/logout',
  authenticate,
  extractDeviceInfo,
  clearCache(['user:*', 'session:*']),
  AuthController.logout
);

/**
 * @route   GET /api/auth/status
 * @desc    Get authentication status
 * @access  Optional Auth
 */
router.get(
  '/status',
  optionalAuth,
  cacheMiddleware({ ttl: 60, includeUser: true }),
  AuthController.getAuthStatus
);

/**
 * @route   POST /api/auth/validate
 * @desc    Validate current token
 * @access  Private
 */
router.post(
  '/validate',
  authenticate,
  AuthController.validateToken
);

/**
 * @route   POST /api/auth/verify-email/send
 * @desc    Send verification email
 * @access  Private
 */
router.post(
  '/verify-email/send',
  authenticate,
  customRateLimiter({ limit: 3, window: 3600 }),
  AuthController.sendVerificationEmail
);

/**
 * @route   POST /api/auth/verify-phone/send
 * @desc    Send phone verification OTP
 * @access  Private
 */
router.post(
  '/verify-phone/send',
  authenticate,
  customRateLimiter({ limit: 3, window: 3600 }),
  AuthController.sendPhoneVerification
);

/**
 * @route   POST /api/auth/verify-phone
 * @desc    Verify phone number with OTP
 * @access  Private
 */
router.post(
  '/verify-phone',
  authenticate,
  customRateLimiter({ limit: 5, window: 300 }),
  sanitizeRequest,
  AuthController.verifyPhone
);

/**
 * @route   POST /api/auth/password/change
 * @desc    Change password (logged in users)
 * @access  Private
 */
router.post(
  '/password/change',
  authenticate,
  sanitizeRequest,
  authValidators.changePassword,
  validate,
  clearCache(['session:*']),
  AuthController.changePassword
);

/**
 * @route   POST /api/auth/resend-verification
 * @desc    Resend verification email/SMS
 * @access  Private
 */
router.post(
  '/resend-verification',
  authenticate,
  customRateLimiter({ limit: 3, window: 3600 }),
  sanitizeRequest,
  AuthController.resendVerification
);

// ============================
// Session Management Routes
// ============================

/**
 * @route   GET /api/auth/sessions
 * @desc    Get all active sessions
 * @access  Private
 */
router.get(
  '/sessions',
  authenticate,
  cacheMiddleware({ ttl: 60, includeUser: true }),
  AuthController.getSessions
);

/**
 * @route   DELETE /api/auth/sessions/:sessionId
 * @desc    Revoke specific session
 * @access  Private
 */
router.delete(
  '/sessions/:sessionId',
  authenticate,
  validateObjectId('sessionId'),
  clearCache(['session:*']),
  AuthController.revokeSession
);

// ============================
// Two-Factor Authentication Routes
// ============================

/**
 * @route   POST /api/auth/2fa/enable
 * @desc    Enable 2FA
 * @access  Private
 */
router.post(
  '/2fa/enable',
  authenticate,
  sanitizeRequest,
  customRateLimiter({ limit: 5, window: 3600 }),
  AuthController.enable2FA
);

/**
 * @route   POST /api/auth/2fa/verify-setup
 * @desc    Verify 2FA setup
 * @access  Private
 */
router.post(
  '/2fa/verify-setup',
  authenticate,
  sanitizeRequest,
  customRateLimiter({ limit: 5, window: 300 }),
  AuthController.verify2FASetup
);

/**
 * @route   POST /api/auth/2fa/disable
 * @desc    Disable 2FA
 * @access  Private
 */
router.post(
  '/2fa/disable',
  authenticate,
  sanitizeRequest,
  customRateLimiter({ limit: 3, window: 3600 }),
  AuthController.disable2FA
);

/**
 * @route   POST /api/auth/2fa/backup-codes
 * @desc    Regenerate backup codes
 * @access  Private
 */
router.post(
  '/2fa/backup-codes',
  authenticate,
  sanitizeRequest,
  customRateLimiter({ limit: 3, window: 3600 }),
  AuthController.regenerateBackupCodes
);

/**
 * @route   POST /api/auth/2fa/send
 * @desc    Send 2FA code via SMS/Email
 * @access  Private
 */
router.post(
  '/2fa/send',
  authenticate,
  customRateLimiter({ limit: 3, window: 300 }),
  AuthController.send2FACode
);

// ============================
// OAuth Account Management Routes
// ============================

/**
 * @route   POST /api/auth/oauth/:provider/link
 * @desc    Link OAuth account
 * @access  Private
 */
router.post(
  '/oauth/:provider/link',
  authenticate,
  (req, res, next) => {
    const { provider } = req.params;
    if (!['google', 'facebook', 'apple'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid OAuth provider' }
      });
    }
    // Initiate OAuth flow with state containing user ID
    req.session = { linkAccount: true, userId: req.user._id };
    passport.authenticate(provider)(req, res, next);
  }
);

/**
 * @route   DELETE /api/auth/oauth/:provider
 * @desc    Unlink OAuth account
 * @access  Private
 */
router.delete(
  '/oauth/:provider',
  authenticate,
  clearCache(['user:profile:*']),
  AuthController.unlinkOAuthAccount
);

// ============================
// Account Management Routes
// ============================

/**
 * @route   DELETE /api/auth/account
 * @desc    Delete user account
 * @access  Private
 */
router.delete(
  '/account',
  authenticate,
  sanitizeRequest,
  customRateLimiter({ limit: 1, window: 3600 }),
  clearCache(['user:*', 'session:*']),
  AuthController.deleteAccount
);

/**
 * @route   GET /api/auth/security
 * @desc    Get security settings
 * @access  Private
 */
router.get(
  '/security',
  authenticate,
  cacheMiddleware({ ttl: 300, includeUser: true }),
  AuthController.getSecuritySettings
);

// ============================
// Admin Routes (Admin Only)
// ============================

/**
 * @route   POST /api/auth/admin/impersonate
 * @desc    Impersonate a user (admin only)
 * @access  Admin
 */
router.post(
  '/admin/impersonate',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { message: 'Admin access required' }
      });
    }
    next();
  },
  validateObjectId('userId'),
  async (req, res) => {
    // Implementation would generate tokens for target user
    // This is a sensitive operation and should be logged
    res.json({
      success: false,
      error: { message: 'Impersonation not implemented for security' }
    });
  }
);

/**
 * @route   POST /api/auth/admin/unlock-account
 * @desc    Unlock a locked account (admin only)
 * @access  Admin
 */
router.post(
  '/admin/unlock-account',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: { message: 'Admin access required' }
      });
    }
    next();
  },
  validateObjectId('userId'),
  async (req, res) => {
    const User = (await import('../user/user.model.js')).default;
    await User.findByIdAndUpdate(req.body.userId, {
      $set: {
        'security.loginAttempts': 0,
        'security.lockUntil': null,
      }
    });
    res.json({
      success: true,
      message: 'Account unlocked successfully'
    });
  }
);

// ============================
// Health Check Route
// ============================

/**
 * @route   GET /api/auth/health
 * @desc    Health check for auth service
 * @access  Public
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'auth',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================
// Error Handling Middleware
// ============================

// Handle passport authentication errors
router.use((err, req, res, next) => {
  if (err.name === 'AuthenticationError') {
    return res.status(401).json({
      success: false,
      error: {
        message: err.message || 'Authentication failed',
        code: 'AUTH_ERROR'
      }
    });
  }
  next(err);
});

export default router;