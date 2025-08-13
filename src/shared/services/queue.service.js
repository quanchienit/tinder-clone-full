// src/shared/services/queue.service.js
import redis from '../../config/redis.js';
import logger from '../utils/logger.js';
import { REDIS_KEYS } from '../../config/constants.js';

class QueueService {
  constructor() {
    this.client = redis;
    this.processing = new Map(); // Track processing status
    this.handlers = new Map(); // Queue handlers
  }

  /**
   * Register a queue handler
   * @param {string} queueName - Name of the queue
   * @param {Function} handler - Handler function for processing jobs
   */
  registerHandler(queueName, handler) {
    this.handlers.set(queueName, handler);
    logger.info(`Handler registered for queue: ${queueName}`);
  }

  /**
   * Add job to queue
   * @param {string} queueName - Name of the queue
   * @param {Object} data - Job data
   * @param {Object} options - Job options
   * @returns {Promise<string>} - Job ID
   */
  async addJob(queueName, data, options = {}) {
    try {
      const job = {
        id: this.generateJobId(),
        queue: queueName,
        data,
        attempts: 0,
        maxAttempts: options.maxAttempts || 3,
        createdAt: new Date().toISOString(),
        priority: options.priority || 0,
        delay: options.delay || 0,
      };

      const queueKey = this.getQueueKey(queueName);

      if (job.delay > 0) {
        // Add to delayed queue
        const executeAt = Date.now() + job.delay;
        await this.client.zadd(
          this.getDelayedQueueKey(queueName),
          executeAt,
          JSON.stringify(job)
        );
        logger.debug(`Job ${job.id} added to delayed queue ${queueName}`);
      } else if (job.priority > 0) {
        // Add to priority queue
        await this.client.zadd(
          this.getPriorityQueueKey(queueName),
          job.priority,
          JSON.stringify(job)
        );
        logger.debug(`Job ${job.id} added to priority queue ${queueName}`);
      } else {
        // Add to regular queue
        await this.client.lpush(queueKey, JSON.stringify(job));
        logger.debug(`Job ${job.id} added to queue ${queueName}`);
      }

      // Track job
      await this.saveJobStatus(job.id, 'pending', job);

      return job.id;
    } catch (error) {
      logger.error(`Error adding job to queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Add multiple jobs to queue (batch)
   * @param {string} queueName - Name of the queue
   * @param {Array} jobs - Array of job data
   * @returns {Promise<string[]>} - Array of job IDs
   */
  async addBatch(queueName, jobs) {
    try {
      const jobIds = [];
      const pipeline = this.client.client.pipeline();
      const queueKey = this.getQueueKey(queueName);

      for (const jobData of jobs) {
        const job = {
          id: this.generateJobId(),
          queue: queueName,
          data: jobData,
          attempts: 0,
          maxAttempts: 3,
          createdAt: new Date().toISOString(),
        };

        pipeline.lpush(queueKey, JSON.stringify(job));
        jobIds.push(job.id);
      }

      await pipeline.exec();
      logger.info(`Added ${jobs.length} jobs to queue ${queueName}`);
      
      return jobIds;
    } catch (error) {
      logger.error(`Error adding batch to queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Process queue jobs
   * @param {string} queueName - Name of the queue
   * @param {Object} options - Processing options
   */
  async processQueue(queueName, options = {}) {
    const { 
      concurrency = 1, 
      pollInterval = 1000,
      batchSize = 1 
    } = options;

    if (this.processing.get(queueName)) {
      logger.warn(`Queue ${queueName} is already being processed`);
      return;
    }

    this.processing.set(queueName, true);
    const handler = this.handlers.get(queueName);

    if (!handler) {
      logger.error(`No handler registered for queue ${queueName}`);
      this.processing.set(queueName, false);
      return;
    }

    logger.info(`Starting to process queue ${queueName} with concurrency ${concurrency}`);

    // Process with concurrency control
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(this.worker(queueName, handler, pollInterval, batchSize));
    }

    await Promise.all(workers);
  }

  /**
   * Worker to process jobs
   * @private
   */
  async worker(queueName, handler, pollInterval, batchSize) {
    while (this.processing.get(queueName)) {
      try {
        // Check for delayed jobs that are ready
        await this.moveDelayedJobs(queueName);

        // Get job from priority queue first, then regular queue
        const job = await this.getNextJob(queueName);

        if (job) {
          await this.executeJob(job, handler);
        } else {
          // No job available, wait before polling again
          await this.sleep(pollInterval);
        }
      } catch (error) {
        logger.error(`Worker error for queue ${queueName}:`, error);
        await this.sleep(pollInterval);
      }
    }
  }

  /**
   * Get next job from queue
   * @private
   */
  async getNextJob(queueName) {
    try {
      // Try priority queue first
      const priorityKey = this.getPriorityQueueKey(queueName);
      const priorityJobs = await this.client.zrevrange(priorityKey, 0, 0);
      
      if (priorityJobs.length > 0) {
        await this.client.zrem(priorityKey, priorityJobs[0]);
        return JSON.parse(priorityJobs[0]);
      }

      // Then try regular queue
      const queueKey = this.getQueueKey(queueName);
      const jobData = await this.client.rpop(queueKey);
      
      if (jobData) {
        return JSON.parse(jobData);
      }

      return null;
    } catch (error) {
      logger.error(`Error getting next job from ${queueName}:`, error);
      return null;
    }
  }

  /**
   * Execute a job
   * @private
   */
  async executeJob(job, handler) {
    const startTime = Date.now();
    
    try {
      // Update job status
      await this.saveJobStatus(job.id, 'processing', job);

      // Execute handler
      const result = await handler(job.data, job);

      // Job completed successfully
      const duration = Date.now() - startTime;
      await this.saveJobStatus(job.id, 'completed', {
        ...job,
        result,
        completedAt: new Date().toISOString(),
        duration,
      });

      logger.debug(`Job ${job.id} completed in ${duration}ms`);
    } catch (error) {
      job.attempts++;
      logger.error(`Job ${job.id} failed (attempt ${job.attempts}):`, error);

      if (job.attempts < job.maxAttempts) {
        // Retry with exponential backoff
        const delay = Math.pow(2, job.attempts) * 1000;
        await this.retryJob(job, delay);
      } else {
        // Move to dead letter queue
        await this.moveToDeadLetter(job, error.message);
      }
    }
  }

  /**
   * Retry a failed job
   * @private
   */
  async retryJob(job, delay) {
    try {
      job.retryAt = new Date(Date.now() + delay).toISOString();
      
      const delayedKey = this.getDelayedQueueKey(job.queue);
      const executeAt = Date.now() + delay;
      
      await this.client.zadd(delayedKey, executeAt, JSON.stringify(job));
      await this.saveJobStatus(job.id, 'retry', job);
      
      logger.info(`Job ${job.id} scheduled for retry in ${delay}ms`);
    } catch (error) {
      logger.error(`Error retrying job ${job.id}:`, error);
    }
  }

  /**
   * Move delayed jobs to main queue
   * @private
   */
  async moveDelayedJobs(queueName) {
    try {
      const delayedKey = this.getDelayedQueueKey(queueName);
      const queueKey = this.getQueueKey(queueName);
      const now = Date.now();

      // Get jobs that are ready
      const readyJobs = await this.client.client.zrangebyscore(
        delayedKey,
        '-inf',
        now
      );

      if (readyJobs.length > 0) {
        const pipeline = this.client.client.pipeline();

        for (const jobData of readyJobs) {
          pipeline.lpush(queueKey, jobData);
          pipeline.zrem(delayedKey, jobData);
        }

        await pipeline.exec();
        logger.debug(`Moved ${readyJobs.length} delayed jobs to queue ${queueName}`);
      }
    } catch (error) {
      logger.error(`Error moving delayed jobs for ${queueName}:`, error);
    }
  }

  /**
   * Move job to dead letter queue
   * @private
   */
  async moveToDeadLetter(job, errorMessage) {
    try {
      const dlqKey = this.getDeadLetterKey(job.queue);
      
      const deadJob = {
        ...job,
        failedAt: new Date().toISOString(),
        error: errorMessage,
      };

      await this.client.lpush(dlqKey, JSON.stringify(deadJob));
      await this.saveJobStatus(job.id, 'failed', deadJob);
      
      logger.error(`Job ${job.id} moved to dead letter queue`);
    } catch (error) {
      logger.error(`Error moving job ${job.id} to DLQ:`, error);
    }
  }

  /**
   * Get job status
   * @param {string} jobId - Job ID
   * @returns {Promise<Object|null>} - Job status
   */
  async getJobStatus(jobId) {
    try {
      const key = this.getJobStatusKey(jobId);
      const status = await this.client.get(key);
      return status ? JSON.parse(status) : null;
    } catch (error) {
      logger.error(`Error getting job status for ${jobId}:`, error);
      return null;
    }
  }

  /**
   * Save job status
   * @private
   */
  async saveJobStatus(jobId, status, data) {
    try {
      const key = this.getJobStatusKey(jobId);
      const statusData = {
        status,
        updatedAt: new Date().toISOString(),
        ...data,
      };
      
      await this.client.set(key, JSON.stringify(statusData), 86400); // 24 hours
    } catch (error) {
      logger.error(`Error saving job status for ${jobId}:`, error);
    }
  }

  /**
   * Get queue statistics
   * @param {string} queueName - Name of the queue
   * @returns {Promise<Object>} - Queue statistics
   */
  async getQueueStats(queueName) {
    try {
      const queueKey = this.getQueueKey(queueName);
      const delayedKey = this.getDelayedQueueKey(queueName);
      const priorityKey = this.getPriorityQueueKey(queueName);
      const dlqKey = this.getDeadLetterKey(queueName);

      const [pending, delayed, priority, failed] = await Promise.all([
        this.client.client.llen(queueKey),
        this.client.client.zcard(delayedKey),
        this.client.client.zcard(priorityKey),
        this.client.client.llen(dlqKey),
      ]);

      return {
        queue: queueName,
        pending,
        delayed,
        priority,
        failed,
        processing: this.processing.get(queueName) || false,
      };
    } catch (error) {
      logger.error(`Error getting queue stats for ${queueName}:`, error);
      return {
        queue: queueName,
        error: error.message,
      };
    }
  }

  /**
   * Clear queue
   * @param {string} queueName - Name of the queue
   * @param {boolean} includeDLQ - Also clear dead letter queue
   */
  async clearQueue(queueName, includeDLQ = false) {
    try {
      const keys = [
        this.getQueueKey(queueName),
        this.getDelayedQueueKey(queueName),
        this.getPriorityQueueKey(queueName),
      ];

      if (includeDLQ) {
        keys.push(this.getDeadLetterKey(queueName));
      }

      await this.client.client.del(...keys);
      logger.info(`Cleared queue ${queueName}`);
    } catch (error) {
      logger.error(`Error clearing queue ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Retry failed jobs from dead letter queue
   * @param {string} queueName - Name of the queue
   * @param {number} limit - Maximum number of jobs to retry
   */
  async retryFailedJobs(queueName, limit = 10) {
    try {
      const dlqKey = this.getDeadLetterKey(queueName);
      const queueKey = this.getQueueKey(queueName);
      
      const jobs = await this.client.lrange(dlqKey, 0, limit - 1);
      
      if (jobs.length > 0) {
        const pipeline = this.client.client.pipeline();
        
        for (const jobData of jobs) {
          const job = JSON.parse(jobData);
          job.attempts = 0; // Reset attempts
          job.retriedAt = new Date().toISOString();
          
          pipeline.lpush(queueKey, JSON.stringify(job));
          pipeline.lrem(dlqKey, 1, jobData);
        }
        
        await pipeline.exec();
        logger.info(`Retried ${jobs.length} failed jobs from ${queueName}`);
      }
      
      return jobs.length;
    } catch (error) {
      logger.error(`Error retrying failed jobs for ${queueName}:`, error);
      throw error;
    }
  }

  /**
   * Stop processing queue
   * @param {string} queueName - Name of the queue
   */
  stopProcessing(queueName) {
    this.processing.set(queueName, false);
    logger.info(`Stopped processing queue ${queueName}`);
  }

  /**
   * Stop all queue processing
   */
  stopAll() {
    for (const [queueName] of this.processing) {
      this.stopProcessing(queueName);
    }
    logger.info('Stopped all queue processing');
  }

  // Helper methods

  generateJobId() {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  getQueueKey(queueName) {
    return `queue:${queueName}`;
  }

  getDelayedQueueKey(queueName) {
    return `queue:${queueName}:delayed`;
  }

  getPriorityQueueKey(queueName) {
    return `queue:${queueName}:priority`;
  }

  getDeadLetterKey(queueName) {
    return `queue:${queueName}:dlq`;
  }

  getJobStatusKey(jobId) {
    return `job:${jobId}:status`;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default new QueueService();