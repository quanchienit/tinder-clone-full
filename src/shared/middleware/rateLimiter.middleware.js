// src/shared/middleware/rateLimiter.middleware.js
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import { HTTP_STATUS, ERROR_CODES, RATE_LIMITS } from '../../config/constants.js';
import MetricsService from '../services/metrics.service.js';

/**
 * Create a rate limiter with Redis store
 */
const createRateLimiter = (options = {}) => {
  const {
    windowMs = 60 * 1000, // 1 minute default
    max = 100, // 100 requests per window
    message = 'Too many requests, please try again later',
    keyPrefix = 'rl:',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = options;

  return rateLimit({
    store: new RedisStore({
      client: redis.client,
      prefix: keyPrefix,
    }),
    windowMs,
    max,
    message: {
      success: false,
      error: {
        message,
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        retryAfter: windowMs / 1000,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    skipFailedRequests,
    handler: async (req, res) => {
      // Log rate limit hit
      logger.warn(`Rate limit exceeded for ${req.ip} on ${req.path}`);
      
      // Track metrics
      await MetricsService.incrementCounter('rateLimit.exceeded', 1, {
        path: req.path,
        ip: req.ip,
      });

      res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
        success: false,
        error: {
          message,
          code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
          retryAfter: Math.ceil(windowMs / 1000),
        },
      });
    },
    keyGenerator: (req) => {
      // Use user ID if authenticated, otherwise use IP
      return req.user?._id || req.ip;
    },
  });
};

/**
 * Global API rate limiter
 */
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMITS.API_REQUESTS,
  message: 'Too many API requests',
  keyPrefix: 'rl:api:',
});

/**
 * Auth endpoints rate limiter (stricter)
 */
export const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: RATE_LIMITS.LOGIN_ATTEMPTS,
  message: 'Too many authentication attempts, please try again later',
  keyPrefix: 'rl:auth:',
  skipSuccessfulRequests: true, // Don't count successful logins
});

/**
 * Registration rate limiter
 */
export const registrationLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: RATE_LIMITS.REGISTER_ATTEMPTS,
  message: 'Too many registration attempts',
  keyPrefix: 'rl:register:',
});

/**
 * Password reset rate limiter
 */
export const passwordResetLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: RATE_LIMITS.PASSWORD_RESET,
  message: 'Too many password reset requests',
  keyPrefix: 'rl:reset:',
});

/**
 * Message sending rate limiter
 */
export const messageLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: RATE_LIMITS.MESSAGE_SEND,
  message: 'Slow down! You\'re sending messages too quickly',
  keyPrefix: 'rl:message:',
});

/**
 * Swipe action rate limiter
 */
export const swipeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: RATE_LIMITS.SWIPE_ACTIONS,
  message: 'You\'re swiping too fast! Take a break',
  keyPrefix: 'rl:swipe:',
});

/**
 * Report user rate limiter
 */
export const reportLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: RATE_LIMITS.REPORT_USER,
  message: 'Too many reports submitted',
  keyPrefix: 'rl:report:',
});

/**
 * File upload rate limiter
 */
export const uploadLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 uploads per hour
  message: 'Too many file uploads',
  keyPrefix: 'rl:upload:',
});

/**
 * Custom rate limiter middleware with Redis
 */
export const customRateLimiter = (options = {}) => {
  return async (req, res, next) => {
    const {
      key = req.ip,
      limit = 100,
      window = 60, // seconds
      message = 'Rate limit exceeded',
    } = options;

    try {
      const redisKey = `ratelimit:custom:${key}`;
      const current = await redis.incr(redisKey);
      
      if (current === 1) {
        await redis.expire(redisKey, window);
      }
      
      const ttl = await redis.ttl(redisKey);
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current));
      res.setHeader('X-RateLimit-Reset', new Date(Date.now() + ttl * 1000).toISOString());
      
      if (current > limit) {
        logger.warn(`Custom rate limit exceeded for ${key}`);
        
        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          success: false,
          error: {
            message,
            code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
            retryAfter: ttl,
          },
        });
      }
      
      next();
    } catch (error) {
      logger.error('Rate limiter error:', error);
      // Don't block request if rate limiter fails
      next();
    }
  };
};

/**
 * Dynamic rate limiter based on user tier
 */
export const tieredRateLimiter = async (req, res, next) => {
  try {
    const userTier = req.user?.subscription?.type || 'free';
    
    // Different limits based on subscription tier
    const limits = {
      free: 100,
      plus: 500,
      gold: 1000,
      platinum: 5000,
    };
    
    const limit = limits[userTier] || limits.free;
    const key = req.user?._id || req.ip;
    const redisKey = `ratelimit:tiered:${key}`;
    
    const current = await redis.incr(redisKey);
    
    if (current === 1) {
      await redis.expire(redisKey, 60); // 1 minute window
    }
    
    const ttl = await redis.ttl(redisKey);
    
    // Set headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current));
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + ttl * 1000).toISOString());
    res.setHeader('X-RateLimit-Tier', userTier);
    
    if (current > limit) {
      logger.warn(`Tiered rate limit exceeded for ${key} (tier: ${userTier})`);
      
      return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
        success: false,
        error: {
          message: `Rate limit exceeded for ${userTier} tier`,
          code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
          retryAfter: ttl,
          upgradeUrl: userTier === 'free' ? '/api/subscription/upgrade' : null,
        },
      });
    }
    
    next();
  } catch (error) {
    logger.error('Tiered rate limiter error:', error);
    next();
  }
};

/**
 * Sliding window rate limiter
 */
export const slidingWindowLimiter = (options = {}) => {
  return async (req, res, next) => {
    const {
      limit = 100,
      window = 60000, // milliseconds
      key = req.user?._id || req.ip,
    } = options;

    try {
      const now = Date.now();
      const windowStart = now - window;
      const redisKey = `ratelimit:sliding:${key}`;
      
      // Remove old entries outside the window
      await redis.client.zremrangebyscore(redisKey, '-inf', windowStart);
      
      // Count requests in current window
      const count = await redis.client.zcard(redisKey);
      
      if (count >= limit) {
        // Get the oldest request time to calculate retry after
        const oldestRequest = await redis.client.zrange(redisKey, 0, 0, 'WITHSCORES');
        const retryAfter = oldestRequest.length > 0 
          ? Math.ceil((parseInt(oldestRequest[1]) + window - now) / 1000)
          : 60;
        
        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          success: false,
          error: {
            message: 'Rate limit exceeded',
            code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
            retryAfter,
          },
        });
      }
      
      // Add current request
      await redis.client.zadd(redisKey, now, `${now}:${Math.random()}`);
      await redis.expire(redisKey, Math.ceil(window / 1000));
      
      // Set headers
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', limit - count - 1);
      
      next();
    } catch (error) {
      logger.error('Sliding window limiter error:', error);
      next();
    }
  };
};

/**
 * IP-based rate limiter
 */
export const ipRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.ip,
  keyPrefix: 'rl:ip:',
  message: 'Too many requests from this IP',
});

/**
 * Reset rate limit for a specific key
 */
export const resetRateLimit = async (key, prefix = 'rl:') => {
  try {
    const redisKey = `${prefix}${key}`;
    await redis.del(redisKey);
    logger.info(`Rate limit reset for ${key}`);
  } catch (error) {
    logger.error('Error resetting rate limit:', error);
  }
};

/**
 * Get remaining rate limit for a key
 */
export const getRateLimitStatus = async (key, limit = 100, prefix = 'rl:') => {
  try {
    const redisKey = `${prefix}${key}`;
    const current = await redis.get(redisKey);
    const ttl = await redis.ttl(redisKey);
    
    return {
      limit,
      used: parseInt(current) || 0,
      remaining: Math.max(0, limit - (parseInt(current) || 0)),
      resetAt: ttl > 0 ? new Date(Date.now() + ttl * 1000) : null,
    };
  } catch (error) {
    logger.error('Error getting rate limit status:', error);
    return null;
  }
};