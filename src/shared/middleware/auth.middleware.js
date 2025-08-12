// src/shared/middleware/auth.middleware.js
import jwt from 'jsonwebtoken';
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import { HTTP_STATUS, ERROR_CODES } from '../../config/constants.js';
import AppError from '../errors/AppError.js';

/**
 * Verify JWT token and attach user to request
 */
export const authenticate = async (req, res, next) => {
  try {
    // Extract token from header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      throw new AppError(
        'No authentication token provided',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_INVALID
      );
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new AppError(
          'Token has expired',
          HTTP_STATUS.UNAUTHORIZED,
          ERROR_CODES.TOKEN_EXPIRED
        );
      }
      throw new AppError(
        'Invalid token',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_INVALID
      );
    }

    // Check if token is blacklisted (for logout)
    const isBlacklisted = await redis.exists(`blacklist:token:${token}`);
    if (isBlacklisted) {
      throw new AppError(
        'Token has been revoked',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_INVALID
      );
    }

    // Check if user session exists
    const sessionExists = await redis.exists(`session:${decoded.sessionId}`);
    if (decoded.sessionId && !sessionExists) {
      throw new AppError(
        'Session has expired',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.SESSION_EXPIRED
      );
    }

    // Get user from cache or database
    const userKey = `user:profile:${decoded.userId}`;
    let user = await redis.get(userKey);
    
    if (user) {
      user = JSON.parse(user);
    } else {
      // Fetch from database (would import User model)
      // user = await User.findById(decoded.userId).select('-password');
      // For now, we'll just use the decoded data
      user = { _id: decoded.userId, ...decoded };
    }

    if (!user) {
      throw new AppError(
        'User not found',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.USER_NOT_FOUND
      );
    }

    // Check if user is active
    if (user.status?.isBanned) {
      throw new AppError(
        'Account has been banned',
        HTTP_STATUS.FORBIDDEN,
        ERROR_CODES.USER_BANNED
      );
    }

    if (!user.status?.isActive) {
      throw new AppError(
        'Account is inactive',
        HTTP_STATUS.FORBIDDEN,
        ERROR_CODES.USER_INACTIVE
      );
    }

    // Attach user to request
    req.user = user;
    req.token = token;
    req.sessionId = decoded.sessionId;

    // Update last activity
    await redis.set(
      `user:activity:${decoded.userId}`,
      new Date().toISOString(),
      300 // 5 minutes TTL
    );

    next();
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: error.errorCode,
        },
      });
    }

    logger.error('Authentication error:', error);
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'Authentication failed',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }
};

/**
 * Optional authentication - doesn't fail if no token
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : null;

    if (!token) {
      return next();
    }

    // Try to verify token
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      
      // Get user from cache
      const userKey = `user:profile:${decoded.userId}`;
      let user = await redis.get(userKey);
      
      if (user) {
        user = JSON.parse(user);
        req.user = user;
        req.token = token;
        req.sessionId = decoded.sessionId;
      }
    } catch (error) {
      // Token is invalid but we don't fail the request
      logger.debug('Optional auth: Invalid token provided');
    }

    next();
  } catch (error) {
    logger.error('Optional auth error:', error);
    next();
  }
};

/**
 * Verify refresh token
 */
export const verifyRefreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.cookies;
    
    if (!refreshToken) {
      throw new AppError(
        'No refresh token provided',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_INVALID
      );
    }

    // Verify refresh token
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch (error) {
      throw new AppError(
        'Invalid refresh token',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_INVALID
      );
    }

    // Check if refresh token exists in database
    const tokenExists = await redis.exists(`refresh:token:${decoded.userId}:${decoded.sessionId}`);
    if (!tokenExists) {
      throw new AppError(
        'Refresh token not found or expired',
        HTTP_STATUS.UNAUTHORIZED,
        ERROR_CODES.TOKEN_EXPIRED
      );
    }

    req.userId = decoded.userId;
    req.sessionId = decoded.sessionId;
    req.refreshToken = refreshToken;

    next();
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          message: error.message,
          code: error.errorCode,
        },
      });
    }

    logger.error('Refresh token verification error:', error);
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'Invalid refresh token',
        code: ERROR_CODES.TOKEN_INVALID,
      },
    });
  }
};

/**
 * Check if user has required role
 */
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          message: 'Authentication required',
          code: ERROR_CODES.UNAUTHORIZED,
        },
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          message: 'Insufficient permissions',
          code: ERROR_CODES.UNAUTHORIZED,
        },
      });
    }

    next();
  };
};

/**
 * Check if user has premium subscription
 */
export const requirePremium = (tierRequired = null) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        success: false,
        error: {
          message: 'Authentication required',
          code: ERROR_CODES.UNAUTHORIZED,
        },
      });
    }

    const userTier = req.user.subscription?.type || 'free';
    
    if (userTier === 'free') {
      return res.status(HTTP_STATUS.FORBIDDEN).json({
        success: false,
        error: {
          message: 'Premium subscription required',
          code: ERROR_CODES.UNAUTHORIZED,
        },
      });
    }

    // Check specific tier if required
    if (tierRequired) {
      const tierHierarchy = {
        'plus': 1,
        'gold': 2,
        'platinum': 3,
      };

      const userTierLevel = tierHierarchy[userTier] || 0;
      const requiredTierLevel = tierHierarchy[tierRequired] || 0;

      if (userTierLevel < requiredTierLevel) {
        return res.status(HTTP_STATUS.FORBIDDEN).json({
          success: false,
          error: {
            message: `${tierRequired} subscription or higher required`,
            code: ERROR_CODES.UNAUTHORIZED,
          },
        });
      }
    }

    next();
  };
};

/**
 * Check if user's profile is complete
 */
export const requireCompleteProfile = (req, res, next) => {
  if (!req.user) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'Authentication required',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }

  const profile = req.user.profile;
  
  // Check required profile fields
  const requiredFields = [
    'firstName',
    'dateOfBirth',
    'gender',
    'photos',
  ];

  const missingFields = requiredFields.filter(field => {
    if (field === 'photos') {
      return !profile?.photos?.length;
    }
    return !profile?.[field];
  });

  if (missingFields.length > 0) {
    return res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: {
        message: 'Please complete your profile',
        code: ERROR_CODES.PROFILE_INCOMPLETE,
        data: { missingFields },
      },
    });
  }

  next();
};

/**
 * Check if user email is verified
 */
export const requireVerifiedEmail = (req, res, next) => {
  if (!req.user) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'Authentication required',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }

  if (!req.user.verification?.email?.verified) {
    return res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: {
        message: 'Please verify your email address',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }

  next();
};

/**
 * Extract device info from request
 */
export const extractDeviceInfo = (req, res, next) => {
  req.deviceInfo = {
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection.remoteAddress,
    platform: req.headers['x-platform'] || 'unknown',
    appVersion: req.headers['x-app-version'] || 'unknown',
    deviceId: req.headers['x-device-id'] || 'unknown',
  };
  next();
};

/**
 * Check API key for external services
 */
export const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'API key required',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }

  if (apiKey !== process.env.API_KEY) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: {
        message: 'Invalid API key',
        code: ERROR_CODES.UNAUTHORIZED,
      },
    });
  }

  next();
};