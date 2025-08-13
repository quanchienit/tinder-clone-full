// src/modules/auth/strategies/jwt.strategy.js
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import User from '../../user/user.model.js';
import redis from '../../../config/redis.js';
import logger from '../../../shared/utils/logger.js';
import { ERROR_CODES } from '../../../config/constants.js';
import AppError from '../../../shared/errors/AppError.js';

/**
 * JWT Access Token Strategy
 */
export const jwtAccessStrategy = new JwtStrategy(
  {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: process.env.JWT_ACCESS_SECRET,
    issuer: process.env.JWT_ISSUER || 'tinder-clone',
    audience: process.env.JWT_AUDIENCE || 'tinder-clone-users',
    passReqToCallback: true,
  },
  async (req, payload, done) => {
    try {
      // Check if token type is correct
      if (payload.type !== 'access') {
        return done(new AppError('Invalid token type', 401, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check token expiration
      if (payload.exp && Date.now() >= payload.exp * 1000) {
        return done(new AppError('Token expired', 401, ERROR_CODES.TOKEN_EXPIRED), false);
      }

      // Check if token is blacklisted
      const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
      const isBlacklisted = await redis.exists(`blacklist:token:${token}`);
      if (isBlacklisted) {
        return done(new AppError('Token has been revoked', 401, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check session validity if sessionId exists
      if (payload.sessionId) {
        const sessionExists = await redis.exists(`session:${payload.sessionId}`);
        if (!sessionExists) {
          return done(new AppError('Session expired', 401, ERROR_CODES.SESSION_EXPIRED), false);
        }

        // Update session activity
        await redis.expire(`session:${payload.sessionId}`, 86400); // Extend for 24 hours
      }

      // Get user from cache or database
      let user = await redis.get(`user:profile:${payload.userId}`);
      
      if (user) {
        user = JSON.parse(user);
      } else {
        user = await User.findById(payload.userId)
          .select('-password')
          .lean();

        if (user) {
          // Cache user for 5 minutes
          await redis.set(
            `user:profile:${payload.userId}`,
            JSON.stringify(user),
            300
          );
        }
      }

      if (!user) {
        return done(new AppError('User not found', 401, ERROR_CODES.USER_NOT_FOUND), false);
      }

      // Check if user is active
      if (user.status?.isBanned) {
        return done(new AppError('Account has been banned', 403, ERROR_CODES.USER_BANNED), false);
      }

      if (!user.status?.isActive) {
        return done(new AppError('Account is inactive', 403, ERROR_CODES.USER_INACTIVE), false);
      }

      // Update last activity
      await redis.set(
        `user:activity:${payload.userId}`,
        new Date().toISOString(),
        300
      );

      // Attach additional info to user object
      user.tokenInfo = {
        sessionId: payload.sessionId,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
      };

      return done(null, user);
    } catch (error) {
      logger.error('JWT strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * JWT Refresh Token Strategy
 */
export const jwtRefreshStrategy = new JwtStrategy(
  {
    jwtFromRequest: (req) => {
      // Extract from cookie or body
      return req.cookies?.refreshToken || req.body?.refreshToken;
    },
    secretOrKey: process.env.JWT_REFRESH_SECRET,
    issuer: process.env.JWT_ISSUER || 'tinder-clone',
    audience: process.env.JWT_AUDIENCE || 'tinder-clone-users',
    passReqToCallback: true,
  },
  async (req, payload, done) => {
    try {
      // Check if token type is correct
      if (payload.type !== 'refresh') {
        return done(new AppError('Invalid token type', 401, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check token expiration
      if (payload.exp && Date.now() >= payload.exp * 1000) {
        return done(new AppError('Refresh token expired', 401, ERROR_CODES.TOKEN_EXPIRED), false);
      }

      // Check if refresh token exists in Redis
      const tokenKey = `refresh:token:${payload.userId}:${payload.sessionId}`;
      const storedToken = await redis.get(tokenKey);
      
      if (!storedToken) {
        return done(new AppError('Refresh token not found', 401, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Verify token matches stored token (optional extra security)
      const token = req.cookies?.refreshToken || req.body?.refreshToken;
      if (storedToken !== token) {
        return done(new AppError('Token mismatch', 401, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Get user
      const user = await User.findById(payload.userId)
        .select('_id email status')
        .lean();

      if (!user) {
        return done(new AppError('User not found', 401, ERROR_CODES.USER_NOT_FOUND), false);
      }

      // Check if user is active
      if (user.status?.isBanned || !user.status?.isActive) {
        // Remove refresh token if user is banned/inactive
        await redis.del(tokenKey);
        return done(new AppError('Account is not active', 403, ERROR_CODES.USER_INACTIVE), false);
      }

      // Attach session info
      user.sessionId = payload.sessionId;

      return done(null, user);
    } catch (error) {
      logger.error('Refresh token strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * JWT Email Verification Token Strategy
 */
export const jwtEmailVerificationStrategy = new JwtStrategy(
  {
    jwtFromRequest: ExtractJwt.fromUrlQueryParameter('token'),
    secretOrKey: process.env.JWT_EMAIL_SECRET || process.env.JWT_ACCESS_SECRET,
    passReqToCallback: true,
  },
  async (req, payload, done) => {
    try {
      // Check token type
      if (payload.type !== 'email-verification') {
        return done(new AppError('Invalid token type', 400, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check if token has been used
      const usedKey = `used:email:token:${payload.jti}`;
      const isUsed = await redis.exists(usedKey);
      if (isUsed) {
        return done(new AppError('Token has already been used', 400, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Get user
      const user = await User.findById(payload.userId);
      if (!user) {
        return done(new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND), false);
      }

      // Check if email matches
      if (user.email !== payload.email) {
        return done(new AppError('Email mismatch', 400, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check if already verified
      if (user.verification?.email?.verified) {
        return done(new AppError('Email already verified', 400, ERROR_CODES.ALREADY_EXISTS), false);
      }

      return done(null, user);
    } catch (error) {
      logger.error('Email verification strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * JWT Password Reset Token Strategy
 */
export const jwtPasswordResetStrategy = new JwtStrategy(
  {
    jwtFromRequest: ExtractJwt.fromUrlQueryParameter('token'),
    secretOrKey: process.env.JWT_RESET_SECRET || process.env.JWT_ACCESS_SECRET,
    passReqToCallback: true,
  },
  async (req, payload, done) => {
    try {
      // Check token type
      if (payload.type !== 'password-reset') {
        return done(new AppError('Invalid token type', 400, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Check if token has been used
      const usedKey = `used:reset:token:${payload.jti}`;
      const isUsed = await redis.exists(usedKey);
      if (isUsed) {
        return done(new AppError('Token has already been used', 400, ERROR_CODES.TOKEN_INVALID), false);
      }

      // Get user
      const user = await User.findById(payload.userId);
      if (!user) {
        return done(new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND), false);
      }

      // Check if password hash matches (ensures token is invalidated if password changed)
      if (payload.passwordHash) {
        const currentPasswordHash = user.password.substring(0, 10);
        if (currentPasswordHash !== payload.passwordHash) {
          return done(new AppError('Token invalidated due to password change', 400, ERROR_CODES.TOKEN_INVALID), false);
        }
      }

      return done(null, user);
    } catch (error) {
      logger.error('Password reset strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * Configure Passport with JWT strategies
 */
export const configureJwtStrategies = (passport) => {
  passport.use('jwt-access', jwtAccessStrategy);
  passport.use('jwt-refresh', jwtRefreshStrategy);
  passport.use('jwt-email-verification', jwtEmailVerificationStrategy);
  passport.use('jwt-password-reset', jwtPasswordResetStrategy);

  logger.info('JWT strategies configured');
};

export default {
  jwtAccessStrategy,
  jwtRefreshStrategy,
  jwtEmailVerificationStrategy,
  jwtPasswordResetStrategy,
  configureJwtStrategies,
};