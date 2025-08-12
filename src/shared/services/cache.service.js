// shared/services/cache.service.js
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';

class CacheService {
  constructor() {
    this.defaultTTL = 3600; // 1 hour
    this.client = redis.client;
  }

  // Generate cache key
  generateKey(...parts) {
    return parts.filter(Boolean).join(':');
  }

  // Get or set cache
  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    try {
      // Try to get from cache
      const cached = await this.client.get(key);
      if (cached) {
        logger.debug(`Cache hit for key: ${key}`);
        return JSON.parse(cached);
      }

      // Fetch fresh data
      logger.debug(`Cache miss for key: ${key}`);
      const data = await fetchFn();
      
      // Store in cache
      if (data !== null && data !== undefined) {
        await this.client.setex(key, ttl, JSON.stringify(data));
      }
      
      return data;
    } catch (error) {
      logger.error(`Cache error for key ${key}:`, error);
      // Fallback to fetch function if cache fails
      return fetchFn();
    }
  }

  // Delete cache by pattern
  async invalidatePattern(pattern) {
    const keys = await this.client.keys(pattern);
    if (keys.length > 0) {
      await this.client.del(...keys);
      logger.debug(`Invalidated ${keys.length} cache keys with pattern: ${pattern}`);
    }
  }

  // Cache user data
  async cacheUser(userId, userData, ttl = 3600) {
    const key = this.generateKey('user', userId);
    await this.client.setex(key, ttl, JSON.stringify(userData));
  }

  // Get cached user
  async getCachedUser(userId) {
    const key = this.generateKey('user', userId);
    const cached = await this.client.get(key);
    return cached ? JSON.parse(cached) : null;
  }

  // Cache recommendations
  async cacheRecommendations(userId, recommendations, ttl = 1800) {
    const key = this.generateKey('recommendations', userId);
    await this.client.setex(key, ttl, JSON.stringify(recommendations));
  }

  // Rate limiting using Redis
  async checkRateLimit(identifier, limit = 100, window = 3600) {
    const key = this.generateKey('ratelimit', identifier);
    
    const current = await this.client.incr(key);
    if (current === 1) {
      await this.client.expire(key, window);
    }
    
    return {
      allowed: current <= limit,
      remaining: Math.max(0, limit - current),
      resetIn: await this.client.ttl(key)
    };
  }
}

export default new CacheService();