// src/config/redis.js
import { createClient } from 'redis';
import logger from '../shared/utils/logger.js';

class RedisClient {
  constructor() {
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Main client for general operations
      this.client = createClient({
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT) || 6379,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis: Max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            const delay = Math.min(retries * 100, 3000);
            logger.info(`Redis: Reconnecting in ${delay}ms...`);
            return delay;
          },
        },
        password: process.env.REDIS_PASSWORD || undefined,
        database: parseInt(process.env.REDIS_DB) || 0,
        commandsQueueMaxLength: 100,
      });

      // Subscriber client for Pub/Sub
      this.subscriber = this.client.duplicate();
      this.publisher = this.client.duplicate();

      // Error handling
      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        logger.info('Redis Client is connecting...');
      });

      this.client.on('ready', () => {
        logger.info('✅ Redis Client connected and ready');
        this.isConnected = true;
      });

      this.client.on('end', () => {
        logger.warn('Redis Client connection closed');
        this.isConnected = false;
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis Client reconnecting...');
      });

      // Connect all clients
      await Promise.all([
        this.client.connect(),
        this.subscriber.connect(),
        this.publisher.connect(),
      ]);

      // Test connection
      await this.client.ping();
      
      return this.client;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  async disconnect() {
    try {
      if (this.client) {
        await this.client.quit();
      }
      if (this.subscriber) {
        await this.subscriber.quit();
      }
      if (this.publisher) {
        await this.publisher.quit();
      }
      logger.info('Redis disconnected successfully');
    } catch (error) {
      logger.error('Error disconnecting from Redis:', error);
      throw error;
    }
  }

  // Helper methods for common operations

  // Cache operations
  async get(key) {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  }

  async set(key, value, ttl) {
    try {
      if (ttl) {
        return await this.client.setEx(key, ttl, value);
      }
      return await this.client.set(key, value);
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      return null;
    }
  }

  async del(key) {
    try {
      return await this.client.del(key);
    } catch (error) {
      logger.error(`Redis DEL error for key ${key}:`, error);
      return 0;
    }
  }

  async exists(key) {
    try {
      return await this.client.exists(key);
    } catch (error) {
      logger.error(`Redis EXISTS error for key ${key}:`, error);
      return 0;
    }
  }

  async expire(key, seconds) {
    try {
      return await this.client.expire(key, seconds);
    } catch (error) {
      logger.error(`Redis EXPIRE error for key ${key}:`, error);
      return false;
    }
  }

  async ttl(key) {
    try {
      return await this.client.ttl(key);
    } catch (error) {
      logger.error(`Redis TTL error for key ${key}:`, error);
      return -1;
    }
  }

  // List operations
  async lpush(key, ...values) {
    try {
      return await this.client.lPush(key, values);
    } catch (error) {
      logger.error(`Redis LPUSH error for key ${key}:`, error);
      return 0;
    }
  }

  async rpop(key) {
    try {
      return await this.client.rPop(key);
    } catch (error) {
      logger.error(`Redis RPOP error for key ${key}:`, error);
      return null;
    }
  }

  async lrange(key, start, stop) {
    try {
      return await this.client.lRange(key, start, stop);
    } catch (error) {
      logger.error(`Redis LRANGE error for key ${key}:`, error);
      return [];
    }
  }

  // Set operations
  async sadd(key, ...members) {
    try {
      return await this.client.sAdd(key, members);
    } catch (error) {
      logger.error(`Redis SADD error for key ${key}:`, error);
      return 0;
    }
  }

  async srem(key, ...members) {
    try {
      return await this.client.sRem(key, members);
    } catch (error) {
      logger.error(`Redis SREM error for key ${key}:`, error);
      return 0;
    }
  }

  async smembers(key) {
    try {
      return await this.client.sMembers(key);
    } catch (error) {
      logger.error(`Redis SMEMBERS error for key ${key}:`, error);
      return [];
    }
  }

  async sismember(key, member) {
    try {
      return await this.client.sIsMember(key, member);
    } catch (error) {
      logger.error(`Redis SISMEMBER error for key ${key}:`, error);
      return false;
    }
  }

  // Sorted set operations
  async zadd(key, score, member) {
    try {
      return await this.client.zAdd(key, { score, value: member });
    } catch (error) {
      logger.error(`Redis ZADD error for key ${key}:`, error);
      return 0;
    }
  }

  async zrem(key, member) {
    try {
      return await this.client.zRem(key, member);
    } catch (error) {
      logger.error(`Redis ZREM error for key ${key}:`, error);
      return 0;
    }
  }

  async zrange(key, start, stop, withScores = false) {
    try {
      if (withScores) {
        return await this.client.zRangeWithScores(key, start, stop);
      }
      return await this.client.zRange(key, start, stop);
    } catch (error) {
      logger.error(`Redis ZRANGE error for key ${key}:`, error);
      return [];
    }
  }

  async zrevrange(key, start, stop, withScores = false) {
    try {
      if (withScores) {
        return await this.client.zRangeWithScores(key, start, stop, { REV: true });
      }
      return await this.client.zRange(key, start, stop, { REV: true });
    } catch (error) {
      logger.error(`Redis ZREVRANGE error for key ${key}:`, error);
      return [];
    }
  }

  async zrank(key, member) {
    try {
      return await this.client.zRank(key, member);
    } catch (error) {
      logger.error(`Redis ZRANK error for key ${key}:`, error);
      return null;
    }
  }

  // Hash operations
  async hset(key, field, value) {
    try {
      return await this.client.hSet(key, field, value);
    } catch (error) {
      logger.error(`Redis HSET error for key ${key}:`, error);
      return 0;
    }
  }

  async hget(key, field) {
    try {
      return await this.client.hGet(key, field);
    } catch (error) {
      logger.error(`Redis HGET error for key ${key}:`, error);
      return null;
    }
  }

  async hgetall(key) {
    try {
      return await this.client.hGetAll(key);
    } catch (error) {
      logger.error(`Redis HGETALL error for key ${key}:`, error);
      return {};
    }
  }

  async hdel(key, field) {
    try {
      return await this.client.hDel(key, field);
    } catch (error) {
      logger.error(`Redis HDEL error for key ${key}:`, error);
      return 0;
    }
  }

  // Increment operations
  async incr(key) {
    try {
      return await this.client.incr(key);
    } catch (error) {
      logger.error(`Redis INCR error for key ${key}:`, error);
      return 0;
    }
  }

  async incrby(key, increment) {
    try {
      return await this.client.incrBy(key, increment);
    } catch (error) {
      logger.error(`Redis INCRBY error for key ${key}:`, error);
      return 0;
    }
  }

  // Pub/Sub operations
  async publish(channel, message) {
    try {
      return await this.publisher.publish(channel, JSON.stringify(message));
    } catch (error) {
      logger.error(`Redis PUBLISH error for channel ${channel}:`, error);
      return 0;
    }
  }

  async subscribe(channel, callback) {
    try {
      await this.subscriber.subscribe(channel, (message) => {
        try {
          const parsed = JSON.parse(message);
          callback(parsed);
        } catch (error) {
          callback(message);
        }
      });
    } catch (error) {
      logger.error(`Redis SUBSCRIBE error for channel ${channel}:`, error);
    }
  }

  async unsubscribe(channel) {
    try {
      await this.subscriber.unsubscribe(channel);
    } catch (error) {
      logger.error(`Redis UNSUBSCRIBE error for channel ${channel}:`, error);
    }
  }

  // Pattern operations
  async keys(pattern) {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error(`Redis KEYS error for pattern ${pattern}:`, error);
      return [];
    }
  }

  async scan(cursor, pattern, count = 10) {
    try {
      return await this.client.scan(cursor, {
        MATCH: pattern,
        COUNT: count,
      });
    } catch (error) {
      logger.error(`Redis SCAN error:`, error);
      return { cursor: 0, keys: [] };
    }
  }

  // Batch operations
  async pipeline(commands) {
    try {
      const multi = this.client.multi();
      for (const cmd of commands) {
        multi[cmd.method](...cmd.args);
      }
      return await multi.exec();
    } catch (error) {
      logger.error('Redis pipeline error:', error);
      return [];
    }
  }

  // Geo operations
  async geoadd(key, longitude, latitude, member) {
    try {
      return await this.client.geoAdd(key, {
        longitude,
        latitude,
        member,
      });
    } catch (error) {
      logger.error(`Redis GEOADD error for key ${key}:`, error);
      return 0;
    }
  }

  async georadius(key, longitude, latitude, radius, unit = 'km') {
    try {
      return await this.client.geoRadius(key, {
        longitude,
        latitude,
      }, radius, unit);
    } catch (error) {
      logger.error(`Redis GEORADIUS error for key ${key}:`, error);
      return [];
    }
  }

  async geodist(key, member1, member2, unit = 'km') {
    try {
      return await this.client.geoDist(key, member1, member2, unit);
    } catch (error) {
      logger.error(`Redis GEODIST error for key ${key}:`, error);
      return null;
    }
  }

  // Flush operations (use with caution!)
  async flushdb() {
    try {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Cannot flush database in production');
      }
      return await this.client.flushDb();
    } catch (error) {
      logger.error('Redis FLUSHDB error:', error);
      return null;
    }
  }

  // Health check
  async ping() {
    try {
      return await this.client.ping();
    } catch (error) {
      logger.error('Redis PING error:', error);
      return null;
    }
  }

  // Get info
  async info() {
    try {
      return await this.client.info();
    } catch (error) {
      logger.error('Redis INFO error:', error);
      return null;
    }
  }
}

export default new RedisClient();