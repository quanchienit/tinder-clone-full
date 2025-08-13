// src/shared/services/metrics.service.js
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';

class MetricsService {
  constructor() {
    this.client = redis;
    this.metrics = new Map();
    this.intervals = new Map();
  }

  /**
   * Initialize metrics collection
   */
  initialize() {
    // Collect metrics every minute
    this.intervals.set('collect', setInterval(() => {
      this.collectSystemMetrics();
    }, 60000));

    // Aggregate metrics every 5 minutes
    this.intervals.set('aggregate', setInterval(() => {
      this.aggregateMetrics();
    }, 300000));

    logger.info('Metrics service initialized');
  }

  /**
   * Shutdown metrics collection
   */
  shutdown() {
    for (const [name, interval] of this.intervals) {
      clearInterval(interval);
      logger.debug(`Cleared interval: ${name}`);
    }
    this.intervals.clear();
    logger.info('Metrics service shut down');
  }

  /**
   * Increment a counter metric
   * @param {string} name - Metric name
   * @param {number} value - Value to increment by (default 1)
   * @param {Object} tags - Optional tags
   */
  async incrementCounter(name, value = 1, tags = {}) {
    try {
      const key = this.buildMetricKey('counter', name, tags);
      const dayKey = this.buildDailyKey(key);
      const hourKey = this.buildHourlyKey(key);

      // Increment multiple time windows
      const pipeline = this.client.client.pipeline();
      pipeline.incrby(key, value);
      pipeline.incrby(dayKey, value);
      pipeline.incrby(hourKey, value);
      
      // Set expiry
      pipeline.expire(dayKey, 86400 * 7); // Keep daily metrics for 7 days
      pipeline.expire(hourKey, 3600 * 24); // Keep hourly metrics for 24 hours
      
      await pipeline.exec();

      // Update in-memory metrics
      const current = this.metrics.get(name) || 0;
      this.metrics.set(name, current + value);
    } catch (error) {
      logger.error(`Error incrementing counter ${name}:`, error);
    }
  }

  /**
   * Set a gauge metric
   * @param {string} name - Metric name
   * @param {number} value - Value to set
   * @param {Object} tags - Optional tags
   */
  async setGauge(name, value, tags = {}) {
    try {
      const key = this.buildMetricKey('gauge', name, tags);
      await this.client.set(key, value.toString(), 3600); // 1 hour TTL
      
      // Update in-memory metrics
      this.metrics.set(name, value);
    } catch (error) {
      logger.error(`Error setting gauge ${name}:`, error);
    }
  }

  /**
   * Record a histogram metric
   * @param {string} name - Metric name
   * @param {number} value - Value to record
   * @param {Object} tags - Optional tags
   */
  async recordHistogram(name, value, tags = {}) {
    try {
      const key = this.buildMetricKey('histogram', name, tags);
      const timestamp = Date.now();
      
      // Add to sorted set with timestamp as score
      await this.client.zadd(key, timestamp, `${value}:${timestamp}`);
      
      // Keep only last hour of data
      const oneHourAgo = timestamp - 3600000;
      await this.client.client.zremrangebyscore(key, '-inf', oneHourAgo);
      
      // Calculate percentiles
      await this.calculatePercentiles(name, key);
    } catch (error) {
      logger.error(`Error recording histogram ${name}:`, error);
    }
  }

  /**
   * Record timing metric
   * @param {string} name - Metric name
   * @param {number} duration - Duration in milliseconds
   * @param {Object} tags - Optional tags
   */
  async recordTiming(name, duration, tags = {}) {
    await this.recordHistogram(`${name}.timing`, duration, tags);
  }

  /**
   * Start timing
   * @param {string} name - Timer name
   * @returns {Function} - End timer function
   */
  startTimer(name) {
    const startTime = Date.now();
    return async (tags = {}) => {
      const duration = Date.now() - startTime;
      await this.recordTiming(name, duration, tags);
      return duration;
    };
  }

  /**
   * Track user action
   * @param {string} userId - User ID
   * @param {string} action - Action name
   * @param {Object} metadata - Additional metadata
   */
  async trackUserAction(userId, action, metadata = {}) {
    try {
      // Increment action counter
      await this.incrementCounter(`user.action.${action}`, 1, { userId });
      
      // Store action event
      const event = {
        userId,
        action,
        metadata,
        timestamp: new Date().toISOString(),
      };
      
      const key = `events:${action}:${new Date().toISOString().split('T')[0]}`;
      await this.client.lpush(key, JSON.stringify(event));
      await this.client.expire(key, 86400 * 30); // Keep for 30 days
      
      // Update user activity score
      await this.updateUserActivityScore(userId);
    } catch (error) {
      logger.error(`Error tracking user action ${action}:`, error);
    }
  }

  /**
   * Update user activity score
   * @private
   */
  async updateUserActivityScore(userId) {
    try {
      const now = Date.now();
      const score = now; // Use timestamp as score for recency
      
      await this.client.zadd('users:activity', score, userId);
      
      // Keep only active users from last 30 days
      const thirtyDaysAgo = now - (30 * 86400000);
      await this.client.client.zremrangebyscore('users:activity', '-inf', thirtyDaysAgo);
    } catch (error) {
      logger.error(`Error updating activity score for ${userId}:`, error);
    }
  }

  /**
   * Get user activity metrics
   * @param {string} userId - User ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   */
  async getUserMetrics(userId, startDate, endDate) {
    try {
      const metrics = {
        actions: {},
        totalActions: 0,
        dailyActivity: [],
      };

      // Get action counts
      const actionKeys = await this.client.keys(`metrics:counter:user.action.*:userId:${userId}:*`);
      for (const key of actionKeys) {
        const count = await this.client.get(key);
        const action = key.match(/user\.action\.([^:]+)/)?.[1];
        if (action) {
          metrics.actions[action] = parseInt(count) || 0;
          metrics.totalActions += metrics.actions[action];
        }
      }

      // Get daily activity
      const current = new Date(startDate);
      while (current <= endDate) {
        const dayKey = current.toISOString().split('T')[0];
        const dayCount = await this.client.get(`metrics:daily:user:${userId}:${dayKey}`);
        metrics.dailyActivity.push({
          date: dayKey,
          actions: parseInt(dayCount) || 0,
        });
        current.setDate(current.getDate() + 1);
      }

      return metrics;
    } catch (error) {
      logger.error(`Error getting user metrics for ${userId}:`, error);
      return null;
    }
  }

  /**
   * Get system metrics
   */
  async getSystemMetrics() {
    try {
      const metrics = {
        timestamp: new Date().toISOString(),
        counters: {},
        gauges: {},
        rates: {},
      };

      // Get all counter metrics
      const counterKeys = await this.client.keys('metrics:counter:*');
      for (const key of counterKeys) {
        const value = await this.client.get(key);
        const name = key.replace('metrics:counter:', '').split(':')[0];
        metrics.counters[name] = (metrics.counters[name] || 0) + parseInt(value || 0);
      }

      // Get all gauge metrics
      const gaugeKeys = await this.client.keys('metrics:gauge:*');
      for (const key of gaugeKeys) {
        const value = await this.client.get(key);
        const name = key.replace('metrics:gauge:', '').split(':')[0];
        metrics.gauges[name] = parseFloat(value || 0);
      }

      // Calculate rates
      metrics.rates = await this.calculateRates();

      return metrics;
    } catch (error) {
      logger.error('Error getting system metrics:', error);
      return null;
    }
  }

  /**
   * Calculate rates (per second/minute)
   * @private
   */
  async calculateRates() {
    try {
      const rates = {};
      const now = Date.now();
      const oneMinuteAgo = now - 60000;

      // Message rate
      const messageCount = await this.client.client.zcount(
        'metrics:messages:timeline',
        oneMinuteAgo,
        now
      );
      rates.messagesPerMinute = messageCount;

      // Swipe rate
      const swipeCount = await this.client.client.zcount(
        'metrics:swipes:timeline',
        oneMinuteAgo,
        now
      );
      rates.swipesPerMinute = swipeCount;

      // Match rate
      const matchCount = await this.client.client.zcount(
        'metrics:matches:timeline',
        oneMinuteAgo,
        now
      );
      rates.matchesPerMinute = matchCount;

      return rates;
    } catch (error) {
      logger.error('Error calculating rates:', error);
      return {};
    }
  }

  /**
   * Calculate percentiles for histogram
   * @private
   */
  async calculatePercentiles(name, key) {
    try {
      const values = await this.client.zrange(key, 0, -1);
      if (values.length === 0) return;

      const numbers = values.map(v => parseFloat(v.split(':')[0])).sort((a, b) => a - b);
      
      const percentiles = {
        p50: this.getPercentile(numbers, 50),
        p75: this.getPercentile(numbers, 75),
        p90: this.getPercentile(numbers, 90),
        p95: this.getPercentile(numbers, 95),
        p99: this.getPercentile(numbers, 99),
        min: numbers[0],
        max: numbers[numbers.length - 1],
        avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
      };

      // Store percentiles
      const percentilesKey = `metrics:percentiles:${name}`;
      await this.client.set(percentilesKey, JSON.stringify(percentiles), 3600);
    } catch (error) {
      logger.error(`Error calculating percentiles for ${name}:`, error);
    }
  }

  /**
   * Get percentile value
   * @private
   */
  getPercentile(sortedArray, percentile) {
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  /**
   * Collect system metrics
   * @private
   */
  async collectSystemMetrics() {
    try {
      // Memory usage
      const memUsage = process.memoryUsage();
      await this.setGauge('system.memory.heapUsed', memUsage.heapUsed);
      await this.setGauge('system.memory.heapTotal', memUsage.heapTotal);
      await this.setGauge('system.memory.rss', memUsage.rss);
      await this.setGauge('system.memory.external', memUsage.external);

      // CPU usage
      const cpuUsage = process.cpuUsage();
      await this.setGauge('system.cpu.user', cpuUsage.user);
      await this.setGauge('system.cpu.system', cpuUsage.system);

      // Event loop lag
      const start = Date.now();
      setImmediate(() => {
        const lag = Date.now() - start;
        this.setGauge('system.eventLoop.lag', lag);
      });

      // Active handles and requests
      await this.setGauge('system.handles', process._getActiveHandles?.().length || 0);
      await this.setGauge('system.requests', process._getActiveRequests?.().length || 0);

      // Uptime
      await this.setGauge('system.uptime', process.uptime());

      logger.debug('System metrics collected');
    } catch (error) {
      logger.error('Error collecting system metrics:', error);
    }
  }

  /**
   * Aggregate metrics
   * @private
   */
  async aggregateMetrics() {
    try {
      const now = new Date();
      const hour = now.getHours();
      const day = now.toISOString().split('T')[0];

      // Aggregate hourly metrics to daily
      if (hour === 0) {
        await this.aggregateHourlyToDaily(day);
      }

      // Clean up old metrics
      await this.cleanupOldMetrics();

      logger.debug('Metrics aggregated');
    } catch (error) {
      logger.error('Error aggregating metrics:', error);
    }
  }

  /**
   * Aggregate hourly metrics to daily
   * @private
   */
  async aggregateHourlyToDaily(day) {
    try {
      const hourlyKeys = await this.client.keys(`metrics:hourly:*:${day}:*`);
      const aggregates = {};

      for (const key of hourlyKeys) {
        const value = await this.client.get(key);
        const metricName = key.split(':')[2];
        aggregates[metricName] = (aggregates[metricName] || 0) + parseInt(value || 0);
      }

      // Store daily aggregates
      for (const [metric, value] of Object.entries(aggregates)) {
        const dailyKey = `metrics:daily:${metric}:${day}`;
        await this.client.set(dailyKey, value.toString(), 86400 * 30); // Keep for 30 days
      }

      logger.info(`Aggregated ${Object.keys(aggregates).length} metrics for ${day}`);
    } catch (error) {
      logger.error('Error aggregating hourly to daily:', error);
    }
  }

  /**
   * Clean up old metrics
   * @private
   */
  async cleanupOldMetrics() {
    try {
      const sevenDaysAgo = Date.now() - (7 * 86400000);
      const thirtyDaysAgo = Date.now() - (30 * 86400000);

      // Clean up hourly metrics older than 7 days
      await this.client.client.zremrangebyscore('metrics:cleanup:hourly', '-inf', sevenDaysAgo);

      // Clean up daily metrics older than 30 days
      await this.client.client.zremrangebyscore('metrics:cleanup:daily', '-inf', thirtyDaysAgo);

      logger.debug('Old metrics cleaned up');
    } catch (error) {
      logger.error('Error cleaning up old metrics:', error);
    }
  }

  /**
   * Export metrics for monitoring
   */
  async exportMetrics() {
    try {
      const metrics = await this.getSystemMetrics();
      const timestamp = Date.now();

      // Format for Prometheus
      const prometheusFormat = [];
      
      // Counters
      for (const [name, value] of Object.entries(metrics.counters || {})) {
        prometheusFormat.push(`# TYPE ${name} counter`);
        prometheusFormat.push(`${name} ${value} ${timestamp}`);
      }

      // Gauges
      for (const [name, value] of Object.entries(metrics.gauges || {})) {
        prometheusFormat.push(`# TYPE ${name} gauge`);
        prometheusFormat.push(`${name} ${value} ${timestamp}`);
      }

      return prometheusFormat.join('\n');
    } catch (error) {
      logger.error('Error exporting metrics:', error);
      return '';
    }
  }

  /**
   * Get dashboard metrics
   */
  async getDashboardMetrics() {
    try {
      const [
        totalUsers,
        activeUsers,
        totalMatches,
        totalMessages,
        systemMetrics
      ] = await Promise.all([
        this.client.get('metrics:counter:users.total'),
        this.client.client.zcard('users:activity'),
        this.client.get('metrics:counter:matches.total'),
        this.client.get('metrics:counter:messages.total'),
        this.getSystemMetrics()
      ]);

      return {
        users: {
          total: parseInt(totalUsers) || 0,
          active: activeUsers || 0,
        },
        matches: {
          total: parseInt(totalMatches) || 0,
          rate: systemMetrics.rates?.matchesPerMinute || 0,
        },
        messages: {
          total: parseInt(totalMessages) || 0,
          rate: systemMetrics.rates?.messagesPerMinute || 0,
        },
        system: {
          uptime: systemMetrics.gauges?.['system.uptime'] || 0,
          memory: systemMetrics.gauges?.['system.memory.heapUsed'] || 0,
          cpu: systemMetrics.gauges?.['system.cpu.user'] || 0,
        },
      };
    } catch (error) {
      logger.error('Error getting dashboard metrics:', error);
      return null;
    }
  }

  // Helper methods

  buildMetricKey(type, name, tags = {}) {
    const tagString = Object.entries(tags)
      .map(([k, v]) => `${k}:${v}`)
      .join(':');
    return tagString 
      ? `metrics:${type}:${name}:${tagString}`
      : `metrics:${type}:${name}`;
  }

  buildDailyKey(baseKey) {
    const date = new Date().toISOString().split('T')[0];
    return `${baseKey}:daily:${date}`;
  }

  buildHourlyKey(baseKey) {
    const now = new Date();
    const dateHour = `${now.toISOString().split('T')[0]}:${now.getHours()}`;
    return `${baseKey}:hourly:${dateHour}`;
  }
}

export default new MetricsService();