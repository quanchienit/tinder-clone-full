// src/shared/middleware/cache.middleware.js
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import { CACHE_TTL } from '../../config/constants.js';
import crypto from 'crypto';

/**
 * Generate cache key from request
 */
const generateCacheKey = (req) => {
  const { originalUrl, method, user } = req;
  const userId = user?._id || 'anonymous';
  
  // Create a hash of query parameters and body for uniqueness
  const queryHash = crypto
    .createHash('md5')
    .update(JSON.stringify(req.query || {}))
    .digest('hex');
  
  const bodyHash = crypto
    .createHash('md5')
    .update(JSON.stringify(req.body || {}))
    .digest('hex');
  
  return `cache:${method}:${originalUrl}:${userId}:${queryHash}:${bodyHash}`;
};

/**
 * Cache middleware for GET requests
 */
export const cacheMiddleware = (options = {}) => {
  const {
    ttl = CACHE_TTL.USER_PROFILE,
    keyPrefix = 'cache:',
    excludeFields = [],
    includeUser = true,
    cacheEmpty = false,
  } = options;

  return async (req, res, next) => {
    // Only cache GET requests by default
    if (req.method !== 'GET') {
      return next();
    }

    // Skip cache if no-cache header is present
    if (req.headers['cache-control'] === 'no-cache') {
      return next();
    }

    const cacheKey = generateCacheKey(req);

    try {
      // Try to get from cache
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        const data = JSON.parse(cached);
        
        // Add cache headers
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Key', cacheKey);
        res.setHeader('X-Cache-TTL', ttl);
        
        logger.debug(`Cache hit: ${cacheKey}`);
        
        return res.json(data);
      }

      // Cache miss - continue to route handler
      res.setHeader('X-Cache', 'MISS');
      
      // Store original res.json method
      const originalJson = res.json.bind(res);
      
      // Override res.json to cache the response
      res.json = function(data) {
        // Only cache successful responses
        if (res.statusCode === 200) {
          // Check if response should be cached
          if (data && (cacheEmpty || Object.keys(data).length > 0)) {
            // Remove excluded fields from cached data
            const dataToCache = { ...data };
            excludeFields.forEach(field => {
              delete dataToCache[field];
            });
            
            // Cache the response
            redis.set(cacheKey, JSON.stringify(dataToCache), ttl)
              .catch(err => logger.error('Cache set error:', err));
            
            logger.debug(`Cached response: ${cacheKey}`);
          }
        }
        
        // Call original json method
        return originalJson(data);
      };
      
      next();
    } catch (error) {
      logger.error('Cache middleware error:', error);
      // Continue without cache on error
      next();
    }
  };
};

/**
 * Clear cache middleware
 */
export const clearCache = (patterns = []) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?._id;
      
      // Default patterns to clear
      const defaultPatterns = [
        `cache:*:${userId}:*`, // User-specific cache
        `user:profile:${userId}`, // User profile cache
        `user:recommendations:${userId}`, // Recommendations cache
        `user:matches:${userId}`, // Matches cache
      ];
      
      const allPatterns = [...defaultPatterns, ...patterns];
      
      for (const pattern of allPatterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.client.del(...keys);
          logger.debug(`Cleared ${keys.length} cache keys matching: ${pattern}`);
        }
      }
      
      next();
    } catch (error) {
      logger.error('Clear cache error:', error);
      next();
    }
  };
};

/**
 * Conditional cache middleware based on conditions
 */
export const conditionalCache = (conditionFn, options = {}) => {
  return async (req, res, next) => {
    if (await conditionFn(req)) {
      return cacheMiddleware(options)(req, res, next);
    }
    next();
  };
};

/**
 * Cache warming middleware
 */
export const warmCache = (dataFetcher, options = {}) => {
  const { ttl = 3600, keyGenerator } = options;
  
  return async (req, res, next) => {
    try {
      const cacheKey = keyGenerator ? keyGenerator(req) : generateCacheKey(req);
      
      // Check if cache exists
      const exists = await redis.exists(cacheKey);
      
      if (!exists) {
        // Fetch and cache data in background
        dataFetcher(req)
          .then(data => {
            if (data) {
              return redis.set(cacheKey, JSON.stringify(data), ttl);
            }
          })
          .catch(err => logger.error('Cache warming error:', err));
      }
      
      next();
    } catch (error) {
      logger.error('Warm cache error:', error);
      next();
    }
  };
};

/**
 * Invalidate cache on mutation
 */
export const invalidateCache = (patterns = []) => {
  return async (req, res, next) => {
    // Store original methods
    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let statusCode = 200;
    
    // Track status code
    res.status = function(code) {
      statusCode = code;
      return originalStatus(code);
    };
    
    // Override res.json to invalidate cache after successful mutation
    res.json = async function(data) {
      // Only invalidate on successful mutations
      if (statusCode >= 200 && statusCode < 300) {
        try {
          const userId = req.user?._id;
          const dynamicPatterns = patterns.map(pattern => 
            pattern.replace(':userId', userId)
          );
          
          for (const pattern of dynamicPatterns) {
            const keys = await redis.keys(pattern);
            if (keys.length > 0) {
              await redis.client.del(...keys);
              logger.debug(`Invalidated ${keys.length} cache keys: ${pattern}`);
            }
          }
        } catch (error) {
          logger.error('Cache invalidation error:', error);
        }
      }
      
      return originalJson(data);
    };
    
    next();
  };
};

/**
 * ETags support for cache validation
 */
export const etagCache = (options = {}) => {
  const { weak = true } = options;
  
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      // Generate ETag from response data
      const hash = crypto
        .createHash('md5')
        .update(JSON.stringify(data))
        .digest('hex');
      
      const etag = weak ? `W/"${hash}"` : `"${hash}"`;
      
      // Set ETag header
      res.setHeader('ETag', etag);
      
      // Check if client has matching ETag
      const clientEtag = req.headers['if-none-match'];
      
      if (clientEtag === etag) {
        // Data hasn't changed
        return res.status(304).end();
      }
      
      return originalJson(data);
    };
    
    next();
  };
};

/**
 * Cache user session data
 */
export const cacheSession = async (req, res, next) => {
  if (!req.user) {
    return next();
  }
  
  try {
    const sessionKey = `session:${req.sessionId || req.user._id}`;
    const cached = await redis.get(sessionKey);
    
    if (cached) {
      req.session = JSON.parse(cached);
    } else {
      // Initialize session
      req.session = {
        userId: req.user._id,
        startedAt: new Date().toISOString(),
      };
      
      await redis.set(sessionKey, JSON.stringify(req.session), 3600); // 1 hour
    }
    
    // Update session on response
    const originalJson = res.json.bind(res);
    res.json = async function(data) {
      if (req.session) {
        await redis.set(sessionKey, JSON.stringify(req.session), 3600);
      }
      return originalJson(data);
    };
    
    next();
  } catch (error) {
    logger.error('Session cache error:', error);
    next();
  }
};

/**
 * Cache pagination results
 */
export const cachePagination = (options = {}) => {
  const { ttl = 300 } = options; // 5 minutes default
  
  return async (req, res, next) => {
    const { page = 1, limit = 20, sort = 'createdAt', order = 'desc' } = req.query;
    
    // Generate cache key including pagination params
    const cacheKey = `${generateCacheKey(req)}:page:${page}:limit:${limit}:sort:${sort}:order:${order}`;
    
    try {
      const cached = await redis.get(cacheKey);
      
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('X-Cache-Type', 'pagination');
        return res.json(JSON.parse(cached));
      }
      
      // Cache miss
      res.setHeader('X-Cache', 'MISS');
      
      const originalJson = res.json.bind(res);
      res.json = function(data) {
        // Cache pagination results
        if (res.statusCode === 200 && data?.data && Array.isArray(data.data)) {
          redis.set(cacheKey, JSON.stringify(data), ttl)
            .catch(err => logger.error('Pagination cache error:', err));
        }
        
        return originalJson(data);
      };
      
      next();
    } catch (error) {
      logger.error('Pagination cache error:', error);
      next();
    }
  };
};

/**
 * Redis cache health check
 */
export const cacheHealthCheck = async (req, res, next) => {
  try {
    const isConnected = redis.isConnected;
    
    if (!isConnected) {
      logger.warn('Redis cache is not connected');
      res.setHeader('X-Cache-Status', 'unavailable');
    } else {
      res.setHeader('X-Cache-Status', 'available');
    }
    
    next();
  } catch (error) {
    logger.error('Cache health check error:', error);
    res.setHeader('X-Cache-Status', 'error');
    next();
  }
};

/**
 * Bypass cache for specific conditions
 */
export const bypassCache = (conditions = []) => {
  return (req, res, next) => {
    const shouldBypass = conditions.some(condition => {
      if (typeof condition === 'function') {
        return condition(req);
      }
      return false;
    });
    
    if (shouldBypass) {
      req.headers['cache-control'] = 'no-cache';
    }
    
    next();
  };
};

/**
 * Cache statistics middleware
 */
export const cacheStats = async (req, res, next) => {
  try {
    const stats = {
      hits: await redis.get('cache:stats:hits') || 0,
      misses: await redis.get('cache:stats:misses') || 0,
      sets: await redis.get('cache:stats:sets') || 0,
      deletes: await redis.get('cache:stats:deletes') || 0,
    };
    
    res.setHeader('X-Cache-Stats', JSON.stringify(stats));
    
    // Track current request
    if (res.getHeader('X-Cache') === 'HIT') {
      await redis.incr('cache:stats:hits');
    } else if (res.getHeader('X-Cache') === 'MISS') {
      await redis.incr('cache:stats:misses');
    }
    
    next();
  } catch (error) {
    logger.error('Cache stats error:', error);
    next();
  }
};