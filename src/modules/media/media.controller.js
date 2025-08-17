// src/modules/media/media.controller.js
import MediaService from './media.service.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import {
  successResponse,
  createdResponse,
  badRequestResponse,
  notFoundResponse,
  forbiddenResponse,
  paginatedResponse,
  serverErrorResponse,
  cachedResponse,
  batchResponse,
  asyncResponse,
} from '../../shared/utils/response.js';
import logger from '../../shared/utils/logger.js';
import MetricsService from '../../shared/services/metrics.service.js';
import CacheService from '../../shared/services/cache.service.js';
import { 
  HTTP_STATUS, 
  ERROR_CODES,
  MEDIA_CONSTANTS
} from '../../config/constants.js';

class MediaController {
  /**
   * Upload single media file
   * @route POST /api/media/upload
   * @access Private
   */
  uploadMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const file = req.file;

    if (!file) {
      return badRequestResponse(res, 'No file provided');
    }

    // Parse upload options from request body
    const options = {
      quality: req.body.quality || 'auto',
      resize: req.body.resize !== 'false',
      format: req.body.format || 'auto',
      maxWidth: parseInt(req.body.maxWidth) || undefined,
      maxHeight: parseInt(req.body.maxHeight) || undefined,
      cloudinaryOptions: req.body.cloudinaryOptions ? 
        JSON.parse(req.body.cloudinaryOptions) : {}
    };

    // Add context for tracking
    const context = {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      uploadSource: req.body.source || 'web',
      originalFilename: file.originalname
    };

    const result = await MediaService.uploadMedia(file, userId, options);

    // Track upload metrics
    await MetricsService.trackMediaUpload(userId, result.type, file.size, {
      processingTime: result.processingTime,
      source: context.uploadSource
    });

    logger.info('Media uploaded successfully', {
      userId,
      mediaId: result.id,
      type: result.type,
      size: file.size,
      processingTime: result.processingTime
    });

    return createdResponse(res, result, 'Media uploaded successfully');
  });

  /**
   * Upload multiple media files
   * @route POST /api/media/batch-upload
   * @access Private
   */
  batchUploadMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const files = req.files;

    if (!files || files.length === 0) {
      return badRequestResponse(res, 'No files provided');
    }

    // Parse batch options
    const options = {
      maxBatchSize: parseInt(req.body.maxBatchSize) || 10,
      concurrency: parseInt(req.body.concurrency) || 3,
      quality: req.body.quality || 'auto',
      resize: req.body.resize !== 'false',
      stopOnError: req.body.stopOnError === 'true'
    };

    const result = await MediaService.batchUpload(files, userId, options);

    // Track batch upload metrics
    await MetricsService.trackBatchUpload(userId, result.successful, result.failed, {
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      batchSize: files.length
    });

    logger.info('Batch upload completed', {
      userId,
      total: result.total,
      successful: result.successful,
      failed: result.failed
    });

    return batchResponse(res, result.results, 
      `Batch upload completed: ${result.successful}/${result.total} successful`);
  });

  /**
   * Get media information
   * @route GET /api/media/:mediaId
   * @access Private
   */
  getMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { mediaId } = req.params;
    const { include_metadata = false } = req.query;

    const media = await MediaService.getMediaInfo(mediaId, userId);

    // Remove sensitive metadata for non-owners
    if (media.userId !== userId && !include_metadata) {
      delete media.metadata;
      delete media.cloudinaryData;
    }

    // Track media access
    await MetricsService.trackMediaAccess(userId, mediaId, media.type);

    return successResponse(res, media, 'Media information retrieved');
  });

  /**
   * Delete media
   * @route DELETE /api/media/:mediaId
   * @access Private
   */
  deleteMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { mediaId } = req.params;

    const result = await MediaService.deleteMedia(mediaId, userId);

    // Track deletion
    await MetricsService.trackMediaDeletion(userId, mediaId);

    logger.info('Media deleted', {
      userId,
      mediaId
    });

    return successResponse(res, result, 'Media deleted successfully');
  });

  /**
   * Optimize media for different use cases
   * @route POST /api/media/:mediaId/optimize
   * @access Private
   */
  optimizeMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { mediaId } = req.params;
    const { optimization = 'web' } = req.body;

    // Validate optimization type
    const validOptimizations = ['thumbnail', 'mobile', 'web', 'high_quality'];
    if (!validOptimizations.includes(optimization)) {
      return badRequestResponse(res, 'Invalid optimization type');
    }

    const result = await MediaService.optimizeMedia(mediaId, optimization);

    // Track optimization
    await MetricsService.trackMediaOptimization(userId, mediaId, optimization);

    // Cache response for optimized media
    return cachedResponse(res, result, 3600, 'Media optimized successfully');
  });

  /**
   * Get user media statistics
   * @route GET /api/media/stats
   * @access Private
   */
  getUserMediaStats = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    // Check cache first
    const cacheKey = `media:stats:${userId}`;
    let stats = await CacheService.get(cacheKey);

    if (!stats) {
      stats = await MediaService.getUserMediaStats(userId);
      // Cache for 5 minutes
      await CacheService.setWithTTL(cacheKey, stats, 300);
    }

    return successResponse(res, stats, 'Media statistics retrieved');
  });

  /**
   * Get media analytics
   * @route GET /api/media/analytics
   * @access Private
   */
  getMediaAnalytics = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { 
      period = 'month',
      include_breakdown = true 
    } = req.query;

    const options = {
      period,
      includeBreakdown: include_breakdown === 'true'
    };

    const analytics = await MediaService.getMediaAnalytics(userId, options);

    // Track analytics access
    await MetricsService.trackAnalyticsAccess(userId, 'media', period);

    return successResponse(res, analytics, 'Media analytics retrieved');
  });

  /**
   * Generate signed upload URL for direct uploads
   * @route POST /api/media/signed-url
   * @access Private
   */
  generateSignedUploadUrl = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const {
      resource_type = 'auto',
      folder,
      allowed_formats,
      max_file_size,
      transformation
    } = req.body;

    const uploadParams = {
      resourceType: resource_type,
      folder: folder || `temp/${userId}`,
      allowedFormats: allowed_formats || ['jpg', 'png', 'webp', 'mp4', 'mov'],
      maxFileSize: max_file_size || 50000000, // 50MB default
      transformation
    };

    const signedUrl = await MediaService.generateSignedUploadUrl(userId, uploadParams);

    // Track signed URL generation
    await MetricsService.trackSignedUrlGeneration(userId, resource_type);

    return successResponse(res, signedUrl, 'Signed upload URL generated');
  });

  /**
   * Search user media
   * @route GET /api/media/search
   * @access Private
   */
  searchMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const {
      query = '',
      type = 'all',
      date_from,
      date_to,
      page = 1,
      limit = 20,
      sort_by = 'uploadedAt',
      sort_order = 'desc'
    } = req.query;

    // This would require a media database model
    // For now, return a placeholder response
    const searchOptions = {
      query,
      type,
      dateFrom: date_from ? new Date(date_from) : null,
      dateTo: date_to ? new Date(date_to) : null,
      page: parseInt(page),
      limit: parseInt(limit),
      sortBy: sort_by,
      sortOrder: sort_order
    };

    // Placeholder implementation
    const results = {
      media: [],
      total: 0,
      page: parseInt(page),
      limit: parseInt(limit),
      hasNext: false,
      hasPrev: false
    };

    // Track search
    await MetricsService.trackMediaSearch(userId, query, type);

    return paginatedResponse(
      res, 
      results.media, 
      results.total, 
      results.page, 
      results.limit,
      'Media search completed'
    );
  });

  /**
   * Get media download URL with access control
   * @route GET /api/media/:mediaId/download
   * @access Private
   */
  getDownloadUrl = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { mediaId } = req.params;
    const { quality = 'original' } = req.query;

    // Get media info to verify ownership
    const media = await MediaService.getMediaInfo(mediaId, userId);

    // Check if user owns the media or has permission
    if (media.userId !== userId) {
      return forbiddenResponse(res, 'Unauthorized to download this media');
    }

    // Generate download URL based on quality
    let downloadUrl = media.url;
    
    if (quality !== 'original' && media.variants[quality]) {
      downloadUrl = media.variants[quality].secure_url;
    }

    // Track download
    await MetricsService.trackMediaDownload(userId, mediaId, quality);

    return successResponse(res, {
      downloadUrl,
      mediaId,
      quality,
      expiresAt: new Date(Date.now() + 3600000) // 1 hour from now
    }, 'Download URL generated');
  });

  /**
   * Process uploaded media (webhook handler)
   * @route POST /api/media/process-webhook
   * @access Public (with signature verification)
   */
  processWebhook = asyncHandler(async (req, res) => {
    const { notification_type, public_id, secure_url } = req.body;

    // Verify webhook signature (implement based on your webhook provider)
    // const isValidSignature = verifyWebhookSignature(req);
    // if (!isValidSignature) {
    //   return res.status(401).json({ error: 'Invalid signature' });
    // }

    if (notification_type === 'upload') {
      // Handle successful upload notification
      logger.info('Media upload webhook received', {
        publicId: public_id,
        secureUrl: secure_url
      });

      // Update media record in database if needed
      // await MediaService.updateMediaAfterUpload(public_id, secure_url);

      // Track webhook processing
      await MetricsService.trackWebhookProcessed('upload', public_id);
    }

    return successResponse(res, { processed: true }, 'Webhook processed');
  });

  /**
   * Get media usage report
   * @route GET /api/media/usage-report
   * @access Private
   */
  getUsageReport = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { 
      format = 'json',
      period = 'month',
      include_details = false 
    } = req.query;

    const reportOptions = {
      format,
      period,
      includeDetails: include_details === 'true'
    };

    // Generate usage report
    const report = await MediaService.generateUsageReport(userId, reportOptions);

    // Track report generation
    await MetricsService.trackReportGeneration(userId, 'media_usage', period);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="media-usage-${period}.csv"`);
      return res.send(report.csvData);
    }

    return successResponse(res, report, 'Usage report generated');
  });

  /**
   * Bulk delete media
   * @route DELETE /api/media/bulk-delete
   * @access Private
   */
  bulkDeleteMedia = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { media_ids, confirm = false } = req.body;

    if (!Array.isArray(media_ids) || media_ids.length === 0) {
      return badRequestResponse(res, 'Media IDs array is required');
    }

    if (media_ids.length > 50) {
      return badRequestResponse(res, 'Maximum 50 media items can be deleted at once');
    }

    if (!confirm) {
      return badRequestResponse(res, 'Confirmation required for bulk deletion');
    }

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    // Process deletions in batches
    for (const mediaId of media_ids) {
      try {
        await MediaService.deleteMedia(mediaId, userId);
        results.push({ mediaId, status: 'success' });
        successCount++;
      } catch (error) {
        results.push({ 
          mediaId, 
          status: 'error', 
          error: error.message 
        });
        errorCount++;
      }
    }

    // Track bulk deletion
    await MetricsService.trackBulkDeletion(userId, successCount, errorCount);

    logger.info('Bulk media deletion completed', {
      userId,
      total: media_ids.length,
      successful: successCount,
      failed: errorCount
    });

    return batchResponse(res, results, 
      `Bulk deletion completed: ${successCount}/${media_ids.length} successful`);
  });

  /**
   * Duplicate media detection
   * @route POST /api/media/detect-duplicates
   * @access Private
   */
  detectDuplicates = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();
    const { 
      similarity_threshold = 0.95,
      check_metadata = true 
    } = req.body;

    // This would require implementing duplicate detection algorithm
    // For now, return placeholder response
    const duplicates = [];

    // Track duplicate detection
    await MetricsService.trackDuplicateDetection(userId);

    return successResponse(res, {
      duplicates,
      count: duplicates.length,
      threshold: similarity_threshold
    }, 'Duplicate detection completed');
  });

  /**
   * Media health check
   * @route GET /api/media/health
   * @access Public
   */
  healthCheck = asyncHandler(async (req, res) => {
    const healthStatus = {
      service: 'media',
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      checks: {
        storage: 'healthy',
        processing: 'healthy',
        cache: 'healthy'
      }
    };

    // Perform basic health checks
    try {
      // Check Redis connection
      await CacheService.ping();
      
      // Check Cloudinary connection
      // await cloudinary.api.ping();
      
    } catch (error) {
      healthStatus.status = 'degraded';
      healthStatus.checks.storage = 'unhealthy';
    }

    const statusCode = healthStatus.status === 'healthy' ? 
      HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json(healthStatus);
  });

  /**
   * Clean up expired media (admin endpoint)
   * @route POST /api/media/admin/cleanup
   * @access Admin
   */
  cleanupExpiredMedia = asyncHandler(async (req, res) => {
    const { 
      dry_run = true,
      batch_size = 100,
      max_age_days = 30 
    } = req.body;

    // Check admin permissions
    if (req.user.role !== 'admin') {
      return forbiddenResponse(res, 'Admin access required');
    }

    const options = {
      dryRun: dry_run,
      batchSize: batch_size,
      maxAgeDays: max_age_days
    };

    const result = await MediaService.cleanupExpiredMedia(options);

    // Track cleanup operation
    await MetricsService.trackAdminOperation(req.user._id, 'media_cleanup', {
      dryRun: dry_run,
      processed: result.processed,
      deleted: result.deleted
    });

    logger.info('Media cleanup operation completed', {
      adminUserId: req.user._id,
      ...result,
      options
    });

    return successResponse(res, result, 
      dry_run ? 'Cleanup dry run completed' : 'Cleanup completed');
  });

  /**
   * Get media processing queue status
   * @route GET /api/media/queue/status
   * @access Private
   */
  getQueueStatus = asyncHandler(async (req, res) => {
    const userId = req.user._id.toString();

    // This would integrate with your queue system
    const queueStatus = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      userPending: 0, // Jobs for this specific user
      estimatedWaitTime: 0
    };

    return successResponse(res, queueStatus, 'Queue status retrieved');
  });
}

export default new MediaController();