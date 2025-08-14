// src/modules/auth/strategies/oauth.strategy.js
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import { Strategy as AppleStrategy } from 'passport-apple';
import User from '../../user/user.model.js';
import redis from '../../../config/redis.js';
import logger from '../../../shared/utils/logger.js';
import { generateUniqueId } from '../../../shared/utils/helpers.js';
import MetricsService from '../../../shared/services/metrics.service.js';
import AppError from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../config/constants.js';

/**
 * Process OAuth profile data
 */
const processOAuthProfile = async (provider, profile, accessToken, refreshToken) => {
  try {
    // Extract common fields from different providers
    let email, firstName, lastName, photos, gender;

    switch (provider) {
      case 'google':
        email = profile.emails?.[0]?.value;
        firstName = profile.name?.givenName;
        lastName = profile.name?.familyName;
        photos = profile.photos?.map(photo => ({
          url: photo.value,
          thumbnailUrl: photo.value,
          isMain: true,
          isVerified: true,
          uploadedAt: new Date(),
        }));
        break;

      case 'facebook':
        email = profile.emails?.[0]?.value;
        firstName = profile.name?.givenName;
        lastName = profile.name?.familyName;
        gender = profile.gender;
        photos = profile.photos?.map(photo => ({
          url: photo.value,
          thumbnailUrl: photo.value,
          isMain: true,
          isVerified: true,
          uploadedAt: new Date(),
        }));
        break;

      case 'apple':
        email = profile.email;
        firstName = profile.name?.firstName;
        lastName = profile.name?.lastName;
        break;

      default:
        throw new Error(`Unsupported OAuth provider: ${provider}`);
    }

    // Find or create user
    let user = await User.findOne({
      $or: [
        { email },
        { [`social.${provider}.id`]: profile.id },
      ],
    });

    if (user) {
      // Update existing user
      const updates = {
        [`social.${provider}`]: {
          id: profile.id,
          email,
          connected: true,
          lastSync: new Date(),
          accessToken: accessToken?.substring(0, 50), // Store partial token for security
          profile: {
            displayName: profile.displayName,
            photos: profile.photos,
          },
        },
      };

      // Update verification status if email matches
      if (email && email === user.email && !user.verification?.email?.verified) {
        updates['verification.email'] = {
          verified: true,
          verifiedAt: new Date(),
        };
      }

      // Update profile photos if user doesn't have any
      if (photos?.length > 0 && (!user.profile?.photos || user.profile.photos.length === 0)) {
        updates['profile.photos'] = photos;
      }

      user = await User.findByIdAndUpdate(
        user._id,
        { $set: updates },
        { new: true }
      );

      logger.info(`User logged in via ${provider}`, {
        userId: user._id,
        provider,
      });
    } else {
      // Create new user
      const userData = {
        email,
        profile: {
          firstName: firstName || 'User',
          lastName: lastName || '',
          displayName: firstName || profile.displayName || 'User',
          gender: gender || 'other',
          photos: photos || [],
        },
        social: {
          [provider]: {
            id: profile.id,
            email,
            connected: true,
            lastSync: new Date(),
            accessToken: accessToken?.substring(0, 50),
            profile: {
              displayName: profile.displayName,
              photos: profile.photos,
            },
          },
        },
        verification: {
          email: {
            verified: !!email,
            verifiedAt: email ? new Date() : null,
          },
        },
        preferences: {
          ageRange: { min: 18, max: 50 },
          maxDistance: 50,
          showMe: true,
        },
        scoring: {
          eloScore: 1500,
          activityScore: 1.0,
          profileCompleteness: 0.3,
        },
        status: {
          isActive: true,
          isOnline: false,
          lastActive: new Date(),
        },
        subscription: {
          type: 'free',
        },
      };

      // Generate a random password for OAuth users
      userData.password = await bcrypt.hash(generateUniqueId(), 10);

      user = await User.create(userData);

      logger.info(`New user registered via ${provider}`, {
        userId: user._id,
        provider,
      });

      // Track metrics
      await MetricsService.incrementCounter('auth.oauth.register', 1, { provider });
    }

    // Track login metrics
    await MetricsService.incrementCounter('auth.oauth.login', 1, { provider });

    return user;
  } catch (error) {
    logger.error(`OAuth profile processing error (${provider}):`, error);
    throw error;
  }
};

/**
 * Google OAuth Strategy
 */
export const googleStrategy = new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/api/auth/google/callback',
    scope: ['profile', 'email'],
    passReqToCallback: true,
  },
  async (req, accessToken, refreshToken, profile, done) => {
    try {
      // Check if user is linking account
      if (req.user) {
        const userId = req.user._id;
        
        // Check if Google account is already linked to another user
        const existingUser = await User.findOne({
          'social.google.id': profile.id,
          _id: { $ne: userId },
        });

        if (existingUser) {
          return done(
            new AppError('This Google account is already linked to another user', 409, ERROR_CODES.ALREADY_EXISTS),
            false
          );
        }

        // Link Google account to current user
        const user = await User.findByIdAndUpdate(
          userId,
          {
            $set: {
              'social.google': {
                id: profile.id,
                email: profile.emails?.[0]?.value,
                connected: true,
                lastSync: new Date(),
                profile: {
                  displayName: profile.displayName,
                  photos: profile.photos,
                },
              },
            },
          },
          { new: true }
        );

        logger.info('Google account linked', { userId, googleId: profile.id });
        return done(null, user);
      }

      // Process OAuth login/registration
      const user = await processOAuthProfile('google', profile, accessToken, refreshToken);
      return done(null, user);
    } catch (error) {
      logger.error('Google strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * Facebook OAuth Strategy
 */
export const facebookStrategy = new FacebookStrategy(
  {
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: process.env.FACEBOOK_CALLBACK_URL || '/api/auth/facebook/callback',
    profileFields: ['id', 'emails', 'name', 'displayName', 'photos', 'gender'],
    passReqToCallback: true,
  },
  async (req, accessToken, refreshToken, profile, done) => {
    try {
      // Check if user is linking account
      if (req.user) {
        const userId = req.user._id;
        
        // Check if Facebook account is already linked
        const existingUser = await User.findOne({
          'social.facebook.id': profile.id,
          _id: { $ne: userId },
        });

        if (existingUser) {
          return done(
            new AppError('This Facebook account is already linked to another user', 409, ERROR_CODES.ALREADY_EXISTS),
            false
          );
        }

        // Link Facebook account
        const user = await User.findByIdAndUpdate(
          userId,
          {
            $set: {
              'social.facebook': {
                id: profile.id,
                email: profile.emails?.[0]?.value,
                connected: true,
                lastSync: new Date(),
                profile: {
                  displayName: profile.displayName,
                  photos: profile.photos,
                },
              },
            },
          },
          { new: true }
        );

        logger.info('Facebook account linked', { userId, facebookId: profile.id });
        return done(null, user);
      }

      // Process OAuth login/registration
      const user = await processOAuthProfile('facebook', profile, accessToken, refreshToken);
      return done(null, user);
    } catch (error) {
      logger.error('Facebook strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * Apple OAuth Strategy
 */
export const appleStrategy = new AppleStrategy(
  {
    clientID: process.env.APPLE_CLIENT_ID,
    teamID: process.env.APPLE_TEAM_ID,
    keyID: process.env.APPLE_KEY_ID,
    privateKeyLocation: process.env.APPLE_PRIVATE_KEY_LOCATION,
    callbackURL: process.env.APPLE_CALLBACK_URL || '/api/auth/apple/callback',
    passReqToCallback: true,
  },
  async (req, accessToken, refreshToken, idToken, profile, done) => {
    try {
      // Parse Apple profile
      const appleProfile = {
        id: idToken.sub,
        email: idToken.email,
        emailVerified: idToken.email_verified,
        name: req.body?.user ? JSON.parse(req.body.user).name : {},
      };

      // Check if user is linking account
      if (req.user) {
        const userId = req.user._id;
        
        const existingUser = await User.findOne({
          'social.apple.id': appleProfile.id,
          _id: { $ne: userId },
        });

        if (existingUser) {
          return done(
            new AppError('This Apple account is already linked to another user', 409, ERROR_CODES.ALREADY_EXISTS),
            false
          );
        }

        const user = await User.findByIdAndUpdate(
          userId,
          {
            $set: {
              'social.apple': {
                id: appleProfile.id,
                email: appleProfile.email,
                connected: true,
                lastSync: new Date(),
              },
            },
          },
          { new: true }
        );

        logger.info('Apple account linked', { userId, appleId: appleProfile.id });
        return done(null, user);
      }

      // Process OAuth login/registration
      const user = await processOAuthProfile('apple', appleProfile, accessToken, refreshToken);
      return done(null, user);
    } catch (error) {
      logger.error('Apple strategy error:', error);
      return done(error, false);
    }
  }
);

/**
 * OAuth Unlink Handler
 */
export const unlinkOAuthAccount = async (userId, provider) => {
  try {
    const user = await User.findById(userId);
    
    if (!user) {
      throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
    }

    if (!user.social?.[provider]?.connected) {
      throw new AppError(`${provider} account is not linked`, 400, ERROR_CODES.NOT_FOUND);
    }

    // Check if user has other login methods
    const hasPassword = !!user.password;
    const hasOtherOAuth = Object.keys(user.social || {})
      .filter(p => p !== provider && user.social[p]?.connected)
      .length > 0;

    if (!hasPassword && !hasOtherOAuth) {
      throw new AppError(
        'Cannot unlink the only login method. Please set a password first.',
        400,
        ERROR_CODES.VALIDATION_ERROR
      );
    }

    // Unlink the account
    await User.findByIdAndUpdate(userId, {
      $unset: {
        [`social.${provider}`]: '',
      },
    });

    logger.info('OAuth account unlinked', { userId, provider });
    await MetricsService.incrementCounter('auth.oauth.unlink', 1, { provider });

    return { success: true, message: `${provider} account unlinked successfully` };
  } catch (error) {
    logger.error('OAuth unlink error:', error);
    throw error;
  }
};

/**
 * OAuth Token Refresh Handler
 */
export const refreshOAuthToken = async (userId, provider, refreshToken) => {
  try {
    // This would typically use provider-specific token refresh logic
    // For now, we'll just update the last sync time
    
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          [`social.${provider}.lastSync`]: new Date(),
        },
      },
      { new: true }
    );

    if (!user) {
      throw new AppError('User not found', 404, ERROR_CODES.USER_NOT_FOUND);
    }

    logger.info('OAuth token refreshed', { userId, provider });
    
    return { success: true };
  } catch (error) {
    logger.error('OAuth token refresh error:', error);
    throw error;
  }
};

/**
 * Configure Passport with OAuth strategies
 */
export const configureOAuthStrategies = (passport) => {
  // Only configure strategies if credentials are provided
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use('google', googleStrategy);
    logger.info('Google OAuth strategy configured');
  }

  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use('facebook', facebookStrategy);
    logger.info('Facebook OAuth strategy configured');
  }

  if (process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID) {
    passport.use('apple', appleStrategy);
    logger.info('Apple OAuth strategy configured');
  }
};

export default {
  googleStrategy,
  facebookStrategy,
  appleStrategy,
  processOAuthProfile,
  unlinkOAuthAccount,
  refreshOAuthToken,
  configureOAuthStrategies,
};