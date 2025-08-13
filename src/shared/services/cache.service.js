// src/shared/services/cache.service.js
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import { CACHE_TTL, REDIS_KEYS } from '../../config/constants.js';

class CacheService {
  constructor() {
    this.defaultTTL = CACHE_TTL.USER_PROFILE;
    this.client = redis;
  }

  /**
   * Generate cache key with prefix
   * @param {...string} parts - Key parts to join
   * @returns {string} - Generated cache key
   */
  generateKey(...parts) {
    return parts.filter(Boolean).join(':');
  }

  /**
   * Get or set cache with automatic fetch
   * @param {string} key - Cache key
   * @param {Function} fetchFn - Function to fetch data if not cached
   * @param {number} ttl - Time to live in seconds
   * @returns {Promise<any>} - Cached or fetched data
   */
  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    try {
      // Try to get from cache
      const cached = await this.client.get(key);
      if (cached) {
        logger.debug(`Cache hit: ${key}`);
        return JSON.parse(cached);
      }

      // Cache miss - fetch fresh data
      logger.debug(`Cache miss: ${key}`);
      const data = await fetchFn();

      // Store in cache if data exists
      if (data !== null && data !== undefined) {
        await this.client.set(key, JSON.stringify(data), ttl);
      }

      return data;
    } catch (error) {
      logger.error(`Cache getOrSet error for ${key}:`, error);
      // Fallback to fetch function if cache fails
      return fetchFn();
    }
  }

  /**
   * Get multiple keys at once
   * @param {string[]} keys - Array of cache keys
   * @returns {Promise<Object>} - Object with key-value pairs
   */
  async getMultiple(keys) {
    try {
      if (!keys || keys.length === 0) return {};

      const pipeline = this.client.client.pipeline();
      keys.forEach(key => pipeline.get(key));
      const results = await pipeline.exec();

      const data = {};
      keys.forEach((key, index) => {
        const [error, value] = results[index];
        if (!error && value) {
          try {
            data[key] = JSON.parse(value);
          } catch (e) {
            data[key] = value;
          }
        }
      });

      return data;
    } catch (error) {
      logger.error('Cache getMultiple error:', error);
      return {};
    }
  }

  /**
   * Set multiple keys at once
   * @param {Object} keyValuePairs - Object with key-value pairs
   * @param {number} ttl - Time to live in seconds
   */
  async setMultiple(keyValuePairs, ttl = this.defaultTTL) {
    try {
      const pipeline = this.client.client.pipeline();
      
      Object.entries(keyValuePairs).forEach(([key, value]) => {
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        pipeline.setex(key, ttl, stringValue);
      });

      await pipeline.exec();
      logger.debug(`Set ${Object.keys(keyValuePairs).length} cache keys`);
    } catch (error) {
      logger.error('Cache setMultiple error:', error);
    }
  }

  /**
   * Invalidate cache by pattern
   * @param {string} pattern - Redis pattern (e.g., 'user:*')
   */
  async invalidatePattern(pattern) {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.client.del(...keys);
        logger.debug(`Invalidated ${keys.length} keys matching pattern: ${pattern}`);
      }
    } catch (error) {
      logger.error(`Cache invalidation error for pattern ${pattern}:`, error);
    }
  }

  /**
   * Invalidate multiple specific keys
   * @param {string[]} keys - Array of cache keys to invalidate
   */
  async invalidateKeys(keys) {
    try {
      if (keys.length > 0) {
        await this.client.client.del(...keys);
        logger.debug(`Invalidated ${keys.length} cache keys`);
      }
    } catch (error) {
      logger.error('Cache invalidation error:', error);
    }
  }

  // User-specific cache methods

  /**
   * Cache user profile
   * @param {string} userId - User ID
   * @param {Object} userData - User data to cache
   * @param {number} ttl - Time to live
   */
  async cacheUser(userId, userData, ttl = CACHE_TTL.USER_PROFILE) {
    const key = this.generateKey(REDIS_KEYS.USER_PROFILE, userId);
    await this.client.set(key, JSON.stringify(userData), ttl);
  }

  /**
   * Get cached user profile
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} - Cached user data or null
   */
  async getCachedUser(userId) {
    const key = this.generateKey(REDIS_KEYS.USER_PROFILE, userId);
    const cached = await this.client.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  /**
   * Invalidate user cache
   * @param {string} userId - User ID
   */
  async invalidateUser(userId) {
    const patterns = [
      `${REDIS_KEYS.USER_PROFILE}${userId}`,
      `${REDIS_KEYS.USER_RECOMMENDATIONS}${userId}`,
      `${REDIS_KEYS.USER_MATCHES}${userId}`,
    ];
    
    for (const pattern of patterns) {
      await this.invalidatePattern(pattern + '*');
    }
  }

  /**
   * Cache recommendations for user
   * @param {string} userId - User ID
   * @param {Array} recommendations - Array of recommended profiles
   * @param {number} ttl - Time to live
   */
  async cacheRecommendations(userId, recommendations, ttl = CACHE_TTL.RECOMMENDATIONS) {
    const key = this.generateKey(REDIS_KEYS.USER_RECOMMENDATIONS, userId);
    await this.client.set(key, JSON.stringify(recommendations), ttl);
  }

  /**
   * Get cached recommendations
   * @param {string} userId - User ID
   * @returns {Promise<Array|null>} - Cached recommendations or null
   */
  async getCachedRecommendations(userId) {
    const key = this.generateKey(REDIS_KEYS.USER_RECOMMENDATIONS, userId);
    const cached = await this.client.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  /**
   * Cache user matches
   * @param {string} userId - User ID
   * @param {Array} matches - Array of matches
   * @param {number} ttl - Time to live
   */
  async cacheMatches(userId, matches, ttl = CACHE_TTL.MATCHES) {
    const key = this.generateKey(REDIS_KEYS.USER_MATCHES, userId);
    await this.client.set(key, JSON.stringify(matches), ttl);
  }

  /**
   * Get cached matches
   * @param {string} userId - User ID
   * @returns {Promise<Array|null>} - Cached matches or null
   */
  async getCachedMatches(userId) {
    const key = this.generateKey(REDIS_KEYS.USER_MATCHES, userId);
    const cached = await this.client.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  /**
   * Remember data temporarily (for multi-step processes)
   * @param {string} key - Unique key
   * @param {any} data - Data to remember
   * @param {number} ttl - Time to live (default 5 minutes)
   */
  async remember(key, data, ttl = 300) {
    const tempKey = this.generateKey('temp', key);
    await this.client.set(tempKey, JSON.stringify(data), ttl);
  }

  /**
   * Recall temporarily stored data
   * @param {string} key - Unique key
   * @returns {Promise<any|null>} - Stored data or null
   */
  async recall(key) {
    const tempKey = this.generateKey('temp', key);
    const data = await this.client.get(tempKey);
    if (data) {
      await this.client.del(tempKey); // Delete after recall
      return JSON.parse(data);
    }
    return null;
  }

  /**
   * Lock mechanism for preventing race conditions
   * @param {string} resource - Resource identifier
   * @param {number} ttl - Lock timeout in seconds
   * @returns {Promise<boolean>} - True if lock acquired
   */
  async acquireLock(resource, ttl = 10) {
    const lockKey = this.generateKey('lock', resource);
    const lockId = Date.now().toString();
    
    const result = await this.client.client.set(
      lockKey,
      lockId,
      'NX', // Only set if not exists
      'EX', // Expire time in seconds
      ttl
    );
    
    return result === 'OK';
  }

  /**
   * Release lock
   * @param {string} resource - Resource identifier
   */
  async releaseLock(resource) {
    const lockKey = this.generateKey('lock', resource);
    await this.client.del(lockKey);
  }

  /**
   * Increment counter with optional expiry
   * @param {string} key - Counter key
   * @param {number} ttl - Optional TTL
   * @returns {Promise<number>} - New counter value
   */
  async incrementCounter(key, ttl = null) {
    const count = await this.client.incr(key);
    if (ttl && count === 1) {
      await this.client.expire(key, ttl);
    }
    return count;
  }

  /**
   * Get cache statistics
   * @returns {Promise<Object>} - Cache statistics
   */
  async getStats() {
    try {
      const info = await this.client.info();
      const dbSize = await this.client.client.dbsize();
      
      // Parse memory usage from info
      const memoryMatch = info.match(/used_memory_human:(.+)/);
      const memory = memoryMatch ? memoryMatch[1].trim() : 'unknown';
      
      return {
        keys: dbSize,
        memory,
        connected: this.client.isConnected,
      };
    } catch (error) {
      logger.error('Error getting cache stats:', error);
      return {
        keys: 0,
        memory: 'unknown',
        connected: false,
      };
    }
  }

  /**
   * Warm up cache with frequently accessed data
   */
  async warmUp() {
    try {
      logger.info('Starting cache warm-up...');
      
      // This would typically load frequently accessed data
      // For example, popular users, trending content, etc.
      // Implementation depends on specific business logic
      
      logger.info('Cache warm-up completed');
    } catch (error) {
      logger.error('Cache warm-up error:', error);
    }
  }

  /**
   * Clear all cache (use with caution!)
   */
  async clearAll() {
    try {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Cannot clear all cache in production');
      }
      
      await this.client.flushdb();
      logger.warn('All cache cleared');
    } catch (error) {
      logger.error('Error clearing cache:', error);
      throw error;
    }
  }
}

export default new CacheService();