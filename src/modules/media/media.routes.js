// src/modules/media/media.routes.js
import { Router } from 'express';
import MediaController from './media.controller.js';
import { 
  authenticate, 
  requireCompleteProfile,
  requirePremium,
  requireVerifiedEmail,
  requireAdmin,
  optionalAuth 
} from '../../shared/middleware/auth.middleware.js';
import {
  apiLimiter,
  customRateLimiter,
  uploadLimiter,
  tieredRateLimiter,
  strictRateLimiter,
  adminRateLimiter
} from '../../shared/middleware/rateLimiter.middleware.js';
import {
  cacheMiddleware,
  clearCache,
  invalidateCache,
  cachePagination,
  conditionalCache,
  bypassCache
} from '../../shared/middleware/cache.middleware.js';
import {
  sanitizeRequest,
  validatePagination,
  validateObjectId,
  validate,
  validateFileUpload,
  validateMediaQuery
} from '../../shared/middleware/validation.middleware.js';
import { mediaValidators } from '../../shared/utils/validators.js';
import { upload, uploadMultiple, uploadAny } from './upload.middleware.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { verifyWebhookSignature } from '../../shared/middleware/webhook.middleware.js';

const router = Router();

/**
 * @route   /api/media
 * @desc    Media management routes
 */

// ============================
// Public Routes
// ============================

/**
 * @route   GET /api/media/health
 * @desc    Health check for media service
 * @access  Public
 */
router.get('/health', 
  customRateLimiter({ limit: 100, window: 60 }),
  MediaController.healthCheck
);

/**
 * @route   POST /api/media/process-webhook
 * @desc    Process media upload webhooks
 * @access  Public (with signature verification)
 */
router.post('/process-webhook',
  customRateLimiter({ limit: 1000, window: 60 }),
  verifyWebhookSignature,
  MediaController.processWebhook
);

// ============================
// Authenticated Routes
// ============================

// Apply authentication to all routes below
router.use(authenticate);

// ============================
// Upload Routes
// ============================

/**
 * @route   POST /api/media/upload
 * @desc    Upload single media file
 * @access  Private
 */
router.post('/upload',
  requireCompleteProfile,
  uploadLimiter,
  upload.single('media'),
  validateFileUpload,
  sanitizeRequest,
  mediaValidators.uploadMedia,
  validate,
  clearCache(['media:stats:*', 'user:profile:*']),
  MediaController.uploadMedia
);

/**
 * @route   POST /api/media/batch-upload
 * @desc    Upload multiple media files
 * @access  Private
 */
router.post('/batch-upload',
  requireCompleteProfile,
  tieredRateLimiter,
  uploadMultiple.array('media', 10), // Max 10 files
  validateFileUpload,
  sanitizeRequest,
  mediaValidators.batchUpload,
  validate,
  clearCache(['media:stats:*', 'user:profile:*']),
  MediaController.batchUploadMedia
);

/**
 * @route   POST /api/media/signed-url
 * @desc    Generate signed URL for direct upload
 * @access  Private
 */
router.post('/signed-url',
  customRateLimiter({ limit: 50, window: 3600 }),
  sanitizeRequest,
  mediaValidators.generateSignedUrl,
  validate,
  MediaController.generateSignedUploadUrl
);

// ============================
// Media Information Routes
// ============================

/**
 * @route   GET /api/media/:mediaId
 * @desc    Get media information
 * @access  Private
 */
router.get('/:mediaId',
  validateObjectId('mediaId'),
  conditionalCache(
    (req) => req.query.include_metadata !== 'true',
    { ttl: 3600, includeUser: true }
  ),
  MediaController.getMedia
);

/**
 * @route   DELETE /api/media/:mediaId
 * @desc    Delete media file
 * @access  Private
 */
router.delete('/:mediaId',
  validateObjectId('mediaId'),
  customRateLimiter({ limit: 100, window: 3600 }),
  clearCache(['media:stats:*', 'user:profile:*']),
  MediaController.deleteMedia
);

/**
 * @route   GET /api/media/:mediaId/download
 * @desc    Get secure download URL
 * @access  Private
 */
router.get('/:mediaId/download',
  validateObjectId('mediaId'),
  customRateLimiter({ limit: 100, window: 3600 }),
  mediaValidators.downloadMedia,
  validate,
  MediaController.getDownloadUrl
);

// ============================
// Media Processing Routes
// ============================

/**
 * @route   POST /api/media/:mediaId/optimize
 * @desc    Optimize media for different formats
 * @access  Private
 */
router.post('/:mediaId/optimize',
  validateObjectId('mediaId'),
  customRateLimiter({ limit: 20, window: 3600 }),
  sanitizeRequest,
  mediaValidators.optimizeMedia,
  validate,
  MediaController.optimizeMedia
);

/**
 * @route   POST /api/media/detect-duplicates
 * @desc    Detect duplicate media files
 * @access  Private (Premium)
 */
router.post('/detect-duplicates',
  requirePremium('plus'),
  customRateLimiter({ limit: 5, window: 3600 }),
  sanitizeRequest,
  mediaValidators.detectDuplicates,
  validate,
  MediaController.detectDuplicates
);

// ============================
// Search & Browse Routes
// ============================

/**
 * @route   GET /api/media/search
 * @desc    Search user's media
 * @access  Private
 */
router.get('/search',
  validatePagination,
  validateMediaQuery,
  sanitizeRequest,
  mediaValidators.searchMedia,
  validate,
  conditionalCache(
    (req) => !req.query.query || req.query.query.trim().length === 0,
    { ttl: 300, includeUser: true }
  ),
  MediaController.searchMedia
);

/**
 * @route   GET /api/media/browse
 * @desc    Browse media with filters
 * @access  Private
 */
router.get('/browse',
  validatePagination,
  sanitizeRequest,
  mediaValidators.browseMedia,
  validate,
  cachePagination({ ttl: 600 }),
  asyncHandler(async (req, res) => {
    // Placeholder for browse functionality
    const { 
      type = 'all',
      date_range = 'all',
      size_range = 'all',
      page = 1,
      limit = 20 
    } = req.query;

    // This would implement browsing logic
    const results = {
      media: [],
      total: 0,
      filters: {
        types: ['image', 'video', 'audio'],
        dateRanges: ['today', 'week', 'month', 'year', 'all'],
        sizeRanges: ['small', 'medium', 'large', 'all']
      }
    };

    return res.json({
      success: true,
      data: results,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: results.total,
        totalPages: Math.ceil(results.total / limit)
      }
    });
  })
);

// ============================
// Statistics & Analytics Routes
// ============================

/**
 * @route   GET /api/media/stats
 * @desc    Get user media statistics
 * @access  Private
 */
router.get('/stats',
  cacheMiddleware({ ttl: 300, includeUser: true }),
  MediaController.getUserMediaStats
);

/**
 * @route   GET /api/media/analytics
 * @desc    Get detailed media analytics
 * @access  Private
 */
router.get('/analytics',
  validatePagination,
  sanitizeRequest,
  mediaValidators.getAnalytics,
  validate,
  conditionalCache(
    (req) => req.query.period === 'year',
    { ttl: 3600, includeUser: true }
  ),
  MediaController.getMediaAnalytics
);

/**
 * @route   GET /api/media/usage-report
 * @desc    Generate usage report
 * @access  Private
 */
router.get('/usage-report',
  customRateLimiter({ limit: 10, window: 3600 }),
  sanitizeRequest,
  mediaValidators.generateReport,
  validate,
  MediaController.getUsageReport
);

// ============================
// Bulk Operations Routes
// ============================

/**
 * @route   DELETE /api/media/bulk-delete
 * @desc    Delete multiple media files
 * @access  Private
 */
router.delete('/bulk-delete',
  customRateLimiter({ limit: 10, window: 3600 }),
  sanitizeRequest,
  mediaValidators.bulkDelete,
  validate,
  clearCache(['media:stats:*', 'user:profile:*']),
  MediaController.bulkDeleteMedia
);

/**
 * @route   POST /api/media/bulk-optimize
 * @desc    Optimize multiple media files
 * @access  Private (Premium)
 */
router.post('/bulk-optimize',
  requirePremium('gold'),
  customRateLimiter({ limit: 5, window: 3600 }),
  sanitizeRequest,
  mediaValidators.bulkOptimize,
  validate,
  asyncHandler(async (req, res) => {
    const { media_ids, optimization = 'web' } = req.body;
    
    // Placeholder for bulk optimization
    const results = media_ids.map(id => ({
      mediaId: id,
      status: 'queued',
      estimatedTime: '2-5 minutes'
    }));

    return res.json({
      success: true,
      message: 'Bulk optimization queued',
      data: {
        queued: results.length,
        results,
        jobId: `bulk_opt_${Date.now()}`
      }
    });
  })
);

/**
 * @route   POST /api/media/bulk-move
 * @desc    Move multiple media files to different folder
 * @access  Private (Premium)
 */
router.post('/bulk-move',
  requirePremium('plus'),
  customRateLimiter({ limit: 20, window: 3600 }),
  sanitizeRequest,
  mediaValidators.bulkMove,
  validate,
  clearCache(['media:search:*']),
  asyncHandler(async (req, res) => {
    const { media_ids, destination_folder } = req.body;
    
    // Placeholder for bulk move
    return res.json({
      success: true,
      message: `${media_ids.length} media files moved to ${destination_folder}`,
      data: { moved: media_ids.length, destination: destination_folder }
    });
  })
);

// ============================
// Queue & Processing Routes
// ============================

/**
 * @route   GET /api/media/queue/status
 * @desc    Get processing queue status
 * @access  Private
 */
router.get('/queue/status',
  cacheMiddleware({ ttl: 30, includeUser: true }),
  MediaController.getQueueStatus
);

/**
 * @route   GET /api/media/jobs/:jobId
 * @desc    Get specific job status
 * @access  Private
 */
router.get('/jobs/:jobId',
  validateObjectId('jobId'),
  cacheMiddleware({ ttl: 30, includeUser: true }),
  asyncHandler(async (req, res) => {
    const { jobId } = req.params;
    
    // Placeholder for job status
    const jobStatus = {
      id: jobId,
      status: 'processing', // queued, processing, completed, failed
      progress: 75,
      startedAt: new Date(),
      estimatedCompletion: new Date(Date.now() + 60000),
      result: null,
      error: null
    };

    return res.json({
      success: true,
      data: jobStatus
    });
  })
);

/**
 * @route   DELETE /api/media/jobs/:jobId
 * @desc    Cancel processing job
 * @access  Private
 */
router.delete('/jobs/:jobId',
  validateObjectId('jobId'),
  customRateLimiter({ limit: 50, window: 3600 }),
  asyncHandler(async (req, res) => {
    const { jobId } = req.params;
    
    // Placeholder for job cancellation
    return res.json({
      success: true,
      message: 'Job cancelled successfully',
      data: { jobId, status: 'cancelled' }
    });
  })
);

// ============================
// Organization & Management Routes
// ============================

/**
 * @route   GET /api/media/folders
 * @desc    Get user's media folders
 * @access  Private (Premium)
 */
router.get('/folders',
  requirePremium('plus'),
  cacheMiddleware({ ttl: 600, includeUser: true }),
  asyncHandler(async (req, res) => {
    // Placeholder for folder structure
    const folders = [
      { id: 'default', name: 'All Media', count: 0, created: new Date() },
      { id: 'profile', name: 'Profile Photos', count: 0, created: new Date() },
      { id: 'chat', name: 'Chat Media', count: 0, created: new Date() }
    ];

    return res.json({
      success: true,
      data: { folders, total: folders.length }
    });
  })
);

/**
 * @route   POST /api/media/folders
 * @desc    Create new media folder
 * @access  Private (Premium)
 */
router.post('/folders',
  requirePremium('plus'),
  customRateLimiter({ limit: 20, window: 3600 }),
  sanitizeRequest,
  mediaValidators.createFolder,
  validate,
  clearCache(['media:folders:*']),
  asyncHandler(async (req, res) => {
    const { name, description, privacy = 'private' } = req.body;
    
    const folder = {
      id: `folder_${Date.now()}`,
      name,
      description,
      privacy,
      count: 0,
      created: new Date(),
      userId: req.user._id
    };

    return res.status(201).json({
      success: true,
      message: 'Folder created successfully',
      data: folder
    });
  })
);

/**
 * @route   GET /api/media/tags
 * @desc    Get user's media tags
 * @access  Private (Premium)
 */
router.get('/tags',
  requirePremium('gold'),
  cacheMiddleware({ ttl: 3600, includeUser: true }),
  asyncHandler(async (req, res) => {
    // Placeholder for tag system
    const tags = [
      { name: 'selfie', count: 0 },
      { name: 'vacation', count: 0 },
      { name: 'food', count: 0 },
      { name: 'friends', count: 0 }
    ];

    return res.json({
      success: true,
      data: { tags, total: tags.length }
    });
  })
);

// ============================
// Sharing & Collaboration Routes
// ============================

/**
 * @route   POST /api/media/:mediaId/share
 * @desc    Generate shareable link for media
 * @access  Private (Premium)
 */
router.post('/:mediaId/share',
  requirePremium('plus'),
  validateObjectId('mediaId'),
  customRateLimiter({ limit: 50, window: 3600 }),
  sanitizeRequest,
  mediaValidators.shareMedia,
  validate,
  asyncHandler(async (req, res) => {
    const { mediaId } = req.params;
    const { 
      expires_in = 3600,
      allow_download = false,
      password_protected = false 
    } = req.body;

    const shareLink = {
      url: `${process.env.APP_URL}/shared/${mediaId}?token=abc123`,
      expiresAt: new Date(Date.now() + expires_in * 1000),
      allowDownload: allow_download,
      passwordProtected: password_protected,
      accessCount: 0,
      maxAccess: req.body.max_access || null
    };

    return res.json({
      success: true,
      message: 'Share link generated',
      data: shareLink
    });
  })
);

/**
 * @route   GET /api/media/shared/:shareId
 * @desc    Access shared media
 * @access  Public (with token)
 */
router.get('/shared/:shareId',
  customRateLimiter({ limit: 100, window: 3600 }),
  sanitizeRequest,
  asyncHandler(async (req, res) => {
    const { shareId } = req.params;
    const { token, password } = req.query;

    // Placeholder for shared media access
    return res.json({
      success: true,
      message: 'Shared media accessed',
      data: {
        mediaId: shareId,
        url: 'https://example.com/shared-media-url',
        metadata: {
          type: 'image',
          size: 1024000,
          uploadedAt: new Date()
        }
      }
    });
  })
);

// ============================
// Admin Routes
// ============================

/**
 * @route   POST /api/media/admin/cleanup
 * @desc    Clean up expired media (Admin only)
 * @access  Admin
 */
router.post('/admin/cleanup',
  requireAdmin,
  adminRateLimiter,
  sanitizeRequest,
  mediaValidators.adminCleanup,
  validate,
  MediaController.cleanupExpiredMedia
);

/**
 * @route   GET /api/media/admin/stats
 * @desc    Get system-wide media statistics
 * @access  Admin
 */
router.get('/admin/stats',
  requireAdmin,
  cacheMiddleware({ ttl: 3600 }),
  asyncHandler(async (req, res) => {
    // Placeholder for admin stats
    const stats = {
      totalMedia: 0,
      totalStorage: 0,
      userBreakdown: {
        free: { users: 0, storage: 0 },
        plus: { users: 0, storage: 0 },
        gold: { users: 0, storage: 0 },
        platinum: { users: 0, storage: 0 }
      },
      typeBreakdown: {
        image: { count: 0, storage: 0 },
        video: { count: 0, storage: 0 },
        audio: { count: 0, storage: 0 }
      }
    };

    return res.json({
      success: true,
      data: stats
    });
  })
);

/**
 * @route   GET /api/media/admin/users/:userId/media
 * @desc    Get user's media (Admin only)
 * @access  Admin
 */
router.get('/admin/users/:userId/media',
  requireAdmin,
  validateObjectId('userId'),
  validatePagination,
  cachePagination({ ttl: 300 }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    
    // Placeholder for admin user media view
    return res.json({
      success: true,
      data: {
        media: [],
        total: 0,
        user: userId
      },
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0
      }
    });
  })
);

// ============================
// Error Handling Middleware
// ============================

// Handle 404 for media routes
router.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      message: 'Media endpoint not found',
      code: 'NOT_FOUND',
      path: req.originalUrl,
    },
  });
});

// Export router
export default router;