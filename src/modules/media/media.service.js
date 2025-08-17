// src/modules/media/media.service.js
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import redis from '../../config/redis.js';
import cloudinary from '../../config/cloudinary.js';
import logger from '../../shared/utils/logger.js';
import CacheService from '../../shared/services/cache.service.js';
import MetricsService from '../../shared/services/metrics.service.js';
import QueueService from '../../shared/services/queue.service.js';
import AppError from '../../shared/errors/AppError.js';
import {
  HTTP_STATUS,
  ERROR_CODES,
  MEDIA_CONSTANTS,
  SUBSCRIPTION_FEATURES,
} from '../../config/constants.js';

class MediaService {
  constructor() {
    this.supportedImageTypes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/webp',
      'image/gif'
    ];
    
    this.supportedVideoTypes = [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/avi',
      'video/mov'
    ];
    
    this.supportedAudioTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
      'audio/m4a'
    ];

    this.maxFileSizes = {
      image: 10 * 1024 * 1024,      // 10MB
      video: 100 * 1024 * 1024,     // 100MB
      audio: 50 * 1024 * 1024,      // 50MB
      document: 25 * 1024 * 1024    // 25MB
    };

    this.subscriptionLimits = {
      free: {
        dailyUploads: 10,
        monthlyStorage: 500 * 1024 * 1024, // 500MB
        maxVideoLength: 30, // seconds
        qualityLevel: 'standard'
      },
      plus: {
        dailyUploads: 50,
        monthlyStorage: 2 * 1024 * 1024 * 1024, // 2GB
        maxVideoLength: 120, // seconds
        qualityLevel: 'high'
      },
      gold: {
        dailyUploads: 100,
        monthlyStorage: 5 * 1024 * 1024 * 1024, // 5GB
        maxVideoLength: 300, // seconds
        qualityLevel: 'premium'
      },
      platinum: {
        dailyUploads: -1, // unlimited
        monthlyStorage: -1, // unlimited
        maxVideoLength: 600, // seconds
        qualityLevel: 'premium'
      }
    };
  }

  /**
   * Upload and process media file
   * @param {Object} file - File object from multer
   * @param {string} userId - User ID
   * @param {Object} options - Upload options
   */
  async uploadMedia(file, userId, options = {}) {
    try {
      const startTime = Date.now();
      
      // Validate file
      const validation = await this.validateFile(file, userId);
      if (!validation.valid) {
        throw new AppError(validation.error, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
      }

      // Check user limits
      await this.checkUserLimits(userId, file);

      // Determine media type
      const mediaType = this.getMediaType(file.mimetype);
      
      // Process file based on type
      let processedFile;
      let metadata = {};

      switch (mediaType) {
        case 'image':
          processedFile = await this.processImage(file, options);
          metadata = await this.extractImageMetadata(file);
          break;
        case 'video':
          processedFile = await this.processVideo(file, options);
          metadata = await this.extractVideoMetadata(file);
          break;
        case 'audio':
          processedFile = await this.processAudio(file, options);
          metadata = await this.extractAudioMetadata(file);
          break;
        default:
          throw new AppError('Unsupported media type', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.INVALID_FILE_TYPE);
      }

      // Upload to Cloudinary
      const uploadResult = await this.uploadToCloudinary(processedFile, userId, mediaType, options);

      // Generate additional sizes/formats if needed
      const variants = await this.generateMediaVariants(uploadResult, mediaType, options);

      // Content moderation
      const moderationResult = await this.moderateContent(uploadResult.secure_url, mediaType);

      // Create media record
      const mediaRecord = {
        id: uploadResult.public_id,
        userId,
        type: mediaType,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        url: uploadResult.secure_url,
        thumbnailUrl: variants.thumbnail?.secure_url,
        variants,
        metadata,
        moderation: moderationResult,
        cloudinaryData: uploadResult,
        uploadedAt: new Date(),
        processingTime: Date.now() - startTime
      };

      // Update user storage usage
      await this.updateStorageUsage(userId, file.size);

      // Track metrics
      await MetricsService.trackMediaUpload(userId, mediaType, file.size);

      // Cache result
      await CacheService.setWithTTL(
        `media:${uploadResult.public_id}`,
        mediaRecord,
        3600 // 1 hour
      );

      logger.info(`Media uploaded successfully`, {
        userId,
        mediaId: uploadResult.public_id,
        type: mediaType,
        size: file.size,
        processingTime: mediaRecord.processingTime
      });

      return mediaRecord;

    } catch (error) {
      logger.error('Error uploading media:', error);
      throw error;
    }
  }

  /**
   * Process image file
   * @param {Object} file - File object
   * @param {Object} options - Processing options
   */
  async processImage(file, options = {}) {
    try {
      const { quality = 85, resize = true, format = 'auto' } = options;
      
      let pipeline = sharp(file.buffer);

      // Auto-rotate based on EXIF
      pipeline = pipeline.rotate();

      // Resize if needed
      if (resize) {
        const maxWidth = options.maxWidth || 1920;
        const maxHeight = options.maxHeight || 1920;
        
        pipeline = pipeline.resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      // Remove EXIF data for privacy
      pipeline = pipeline.withMetadata(false);

      // Optimize quality
      if (format === 'auto' || format === 'jpeg') {
        pipeline = pipeline.jpeg({ quality, progressive: true });
      } else if (format === 'webp') {
        pipeline = pipeline.webp({ quality });
      }

      const processedBuffer = await pipeline.toBuffer();
      
      return {
        buffer: processedBuffer,
        mimetype: format === 'webp' ? 'image/webp' : file.mimetype,
        originalname: file.originalname
      };

    } catch (error) {
      logger.error('Error processing image:', error);
      throw new AppError('Image processing failed', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.UPLOAD_FAILED);
    }
  }

  /**
   * Process video file
   * @param {Object} file - File object  
   * @param {Object} options - Processing options
   */
  async processVideo(file, options = {}) {
    try {
      return new Promise((resolve, reject) => {
        const tempInput = `/tmp/input_${Date.now()}.${this.getFileExtension(file.originalname)}`;
        const tempOutput = `/tmp/output_${Date.now()}.mp4`;

        // Write input file
        fs.writeFile(tempInput, file.buffer)
          .then(() => {
            let command = ffmpeg(tempInput);

            // Video processing options
            const { 
              quality = 'medium',
              maxDuration = 300,
              resolution = '1280x720'
            } = options;

            // Set video codec and quality
            command = command
              .videoCodec('libx264')
              .audioCodec('aac')
              .format('mp4')
              .size(resolution);

            // Quality settings
            if (quality === 'high') {
              command = command.videoBitrate('2000k').audioBitrate('128k');
            } else if (quality === 'medium') {
              command = command.videoBitrate('1000k').audioBitrate('96k');
            } else {
              command = command.videoBitrate('500k').audioBitrate('64k');
            }

            // Limit duration
            if (maxDuration) {
              command = command.duration(maxDuration);
            }

            // Process video
            command
              .on('end', async () => {
                try {
                  const processedBuffer = await fs.readFile(tempOutput);
                  
                  // Cleanup temp files
                  await Promise.all([
                    fs.unlink(tempInput).catch(() => {}),
                    fs.unlink(tempOutput).catch(() => {})
                  ]);

                  resolve({
                    buffer: processedBuffer,
                    mimetype: 'video/mp4',
                    originalname: file.originalname.replace(/\.[^/.]+$/, '.mp4')
                  });
                } catch (err) {
                  reject(err);
                }
              })
              .on('error', (err) => {
                // Cleanup on error
                Promise.all([
                  fs.unlink(tempInput).catch(() => {}),
                  fs.unlink(tempOutput).catch(() => {})
                ]);
                reject(err);
              })
              .save(tempOutput);
          })
          .catch(reject);
      });

    } catch (error) {
      logger.error('Error processing video:', error);
      throw new AppError('Video processing failed', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.UPLOAD_FAILED);
    }
  }

  /**
   * Process audio file
   * @param {Object} file - File object
   * @param {Object} options - Processing options
   */
  async processAudio(file, options = {}) {
    try {
      return new Promise((resolve, reject) => {
        const tempInput = `/tmp/audio_input_${Date.now()}.${this.getFileExtension(file.originalname)}`;
        const tempOutput = `/tmp/audio_output_${Date.now()}.mp3`;

        // Write input file
        fs.writeFile(tempInput, file.buffer)
          .then(() => {
            const { 
              bitrate = '128k',
              maxDuration = 300 
            } = options;

            let command = ffmpeg(tempInput)
              .audioCodec('mp3')
              .audioBitrate(bitrate)
              .format('mp3');

            // Limit duration
            if (maxDuration) {
              command = command.duration(maxDuration);
            }

            command
              .on('end', async () => {
                try {
                  const processedBuffer = await fs.readFile(tempOutput);
                  
                  // Cleanup
                  await Promise.all([
                    fs.unlink(tempInput).catch(() => {}),
                    fs.unlink(tempOutput).catch(() => {})
                  ]);

                  resolve({
                    buffer: processedBuffer,
                    mimetype: 'audio/mpeg',
                    originalname: file.originalname.replace(/\.[^/.]+$/, '.mp3')
                  });
                } catch (err) {
                  reject(err);
                }
              })
              .on('error', (err) => {
                // Cleanup on error
                Promise.all([
                  fs.unlink(tempInput).catch(() => {}),
                  fs.unlink(tempOutput).catch(() => {})
                ]);
                reject(err);
              })
              .save(tempOutput);
          })
          .catch(reject);
      });

    } catch (error) {
      logger.error('Error processing audio:', error);
      throw new AppError('Audio processing failed', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.UPLOAD_FAILED);
    }
  }

  /**
   * Upload to Cloudinary
   * @param {Object} processedFile - Processed file
   * @param {string} userId - User ID
   * @param {string} mediaType - Media type
   * @param {Object} options - Upload options
   */
  async uploadToCloudinary(processedFile, userId, mediaType, options = {}) {
    try {
      const folder = `${mediaType}s/${userId}/${new Date().getFullYear()}/${new Date().getMonth() + 1}`;
      
      const uploadOptions = {
        folder,
        resource_type: mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'video' : 'image',
        public_id: `${userId}_${Date.now()}`,
        unique_filename: true,
        overwrite: false,
        invalidate: true,
        ...options.cloudinaryOptions
      };

      // Type-specific options
      if (mediaType === 'image') {
        uploadOptions.transformation = [
          { quality: 'auto:good' },
          { fetch_format: 'auto' }
        ];
      } else if (mediaType === 'video') {
        uploadOptions.video = {
          quality: 'auto:good'
        };
      }

      const result = await cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) throw error;
          return result;
        }
      );

      // Upload buffer
      return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(processedFile.buffer);
      });

    } catch (error) {
      logger.error('Error uploading to Cloudinary:', error);
      throw new AppError('Upload to cloud storage failed', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.UPLOAD_FAILED);
    }
  }

  /**
   * Generate media variants (thumbnails, different sizes)
   * @param {Object} uploadResult - Cloudinary upload result
   * @param {string} mediaType - Media type
   * @param {Object} options - Generation options
   */
  async generateMediaVariants(uploadResult, mediaType, options = {}) {
    try {
      const variants = {};

      if (mediaType === 'image') {
        // Generate thumbnail
        variants.thumbnail = {
          secure_url: cloudinary.url(uploadResult.public_id, {
            width: 200,
            height: 200,
            crop: 'fill',
            quality: 'auto',
            format: 'webp'
          })
        };

        // Generate medium size
        variants.medium = {
          secure_url: cloudinary.url(uploadResult.public_id, {
            width: 600,
            height: 600,
            crop: 'limit',
            quality: 'auto',
            format: 'webp'
          })
        };

      } else if (mediaType === 'video') {
        // Generate video thumbnail
        variants.thumbnail = {
          secure_url: cloudinary.url(uploadResult.public_id, {
            resource_type: 'video',
            format: 'jpg',
            width: 300,
            height: 300,
            crop: 'fill',
            start_offset: '1s'
          })
        };

        // Generate preview GIF
        variants.preview = {
          secure_url: cloudinary.url(uploadResult.public_id, {
            resource_type: 'video',
            format: 'gif',
            width: 200,
            duration: '3s',
            crop: 'scale'
          })
        };
      }

      return variants;

    } catch (error) {
      logger.error('Error generating media variants:', error);
      // Don't throw error here, variants are optional
      return {};
    }
  }

  /**
   * Content moderation
   * @param {string} mediaUrl - Media URL
   * @param {string} mediaType - Media type
   */
  async moderateContent(mediaUrl, mediaType) {
    try {
      // For images, check for inappropriate content
      if (mediaType === 'image') {
        // Integration point for content moderation API
        // This is a placeholder - integrate with actual moderation service
        const moderationResult = {
          isAppropriate: true,
          confidence: 0.95,
          categories: {
            adult: 0.01,
            violence: 0.01,
            racy: 0.02
          },
          flags: []
        };

        return moderationResult;
      }

      // For videos and audio, more complex moderation would be needed
      return {
        isAppropriate: true,
        confidence: 1.0,
        requiresReview: false
      };

    } catch (error) {
      logger.error('Error moderating content:', error);
      // Default to requiring manual review on error
      return {
        isAppropriate: false,
        confidence: 0,
        requiresReview: true,
        error: error.message
      };
    }
  }

  /**
   * Validate file
   * @param {Object} file - File object
   * @param {string} userId - User ID
   */
  async validateFile(file, userId) {
    try {
      if (!file) {
        return { valid: false, error: 'No file provided' };
      }

      // Check file size
      const mediaType = this.getMediaType(file.mimetype);
      const maxSize = this.maxFileSizes[mediaType];
      
      if (file.size > maxSize) {
        return { 
          valid: false, 
          error: `File size exceeds ${Math.round(maxSize / 1024 / 1024)}MB limit` 
        };
      }

      // Check file type
      const supportedTypes = [
        ...this.supportedImageTypes,
        ...this.supportedVideoTypes,
        ...this.supportedAudioTypes
      ];

      if (!supportedTypes.includes(file.mimetype)) {
        return { 
          valid: false, 
          error: 'File type not supported' 
        };
      }

      // Check if file is corrupted
      const isCorrupted = await this.checkFileIntegrity(file);
      if (isCorrupted) {
        return { 
          valid: false, 
          error: 'File appears to be corrupted' 
        };
      }

      return { valid: true };

    } catch (error) {
      logger.error('Error validating file:', error);
      return { 
        valid: false, 
        error: 'File validation failed' 
      };
    }
  }

  /**
   * Check user upload limits
   * @param {string} userId - User ID
   * @param {Object} file - File object
   */
  async checkUserLimits(userId, file) {
    try {
      // Get user subscription
      const User = (await import('../user/user.model.js')).default;
      const user = await User.findById(userId).select('subscription');
      const subscriptionType = user?.subscription?.type || 'free';
      const limits = this.subscriptionLimits[subscriptionType];

      // Check daily upload limit
      if (limits.dailyUploads !== -1) {
        const dailyKey = `media:uploads:${userId}:${new Date().toISOString().split('T')[0]}`;
        const dailyCount = await redis.get(dailyKey) || 0;
        
        if (parseInt(dailyCount) >= limits.dailyUploads) {
          throw new AppError(
            'Daily upload limit reached',
            HTTP_STATUS.FORBIDDEN,
            ERROR_CODES.LIMIT_EXCEEDED
          );
        }

        // Increment counter
        await redis.multi()
          .incr(dailyKey)
          .expire(dailyKey, 86400) // 24 hours
          .exec();
      }

      // Check monthly storage limit
      if (limits.monthlyStorage !== -1) {
        const monthlyKey = `media:storage:${userId}:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
        const monthlyUsage = await redis.get(monthlyKey) || 0;
        
        if (parseInt(monthlyUsage) + file.size > limits.monthlyStorage) {
          throw new AppError(
            'Monthly storage limit exceeded',
            HTTP_STATUS.FORBIDDEN,
            ERROR_CODES.LIMIT_EXCEEDED
          );
        }
      }

      // Check video duration limits for videos
      if (file.mimetype.startsWith('video/')) {
        const metadata = await this.extractVideoMetadata(file);
        if (metadata.duration > limits.maxVideoLength) {
          throw new AppError(
            `Video length exceeds ${limits.maxVideoLength} seconds limit`,
            HTTP_STATUS.BAD_REQUEST,
            ERROR_CODES.VALIDATION_ERROR
          );
        }
      }

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error checking user limits:', error);
      throw new AppError(
        'Failed to verify upload limits',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Update user storage usage
   * @param {string} userId - User ID
   * @param {number} fileSize - File size in bytes
   */
  async updateStorageUsage(userId, fileSize) {
    try {
      const monthlyKey = `media:storage:${userId}:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
      await redis.incrby(monthlyKey, fileSize);
      await redis.expire(monthlyKey, 32 * 24 * 3600); // 32 days
    } catch (error) {
      logger.error('Error updating storage usage:', error);
      // Non-critical error, don't throw
    }
  }

  /**
   * Delete media
   * @param {string} mediaId - Media ID (Cloudinary public_id)
   * @param {string} userId - User ID
   */
  async deleteMedia(mediaId, userId) {
    try {
      // Verify ownership
      const cacheKey = `media:${mediaId}`;
      let mediaRecord = await CacheService.get(cacheKey);
      
      if (!mediaRecord) {
        // Fetch from database if not in cache
        // This would require a media database model
        throw new AppError('Media not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
      }

      if (mediaRecord.userId !== userId) {
        throw new AppError('Unauthorized to delete this media', HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
      }

      // Delete from Cloudinary
      const deletionResult = await cloudinary.uploader.destroy(mediaId, {
        resource_type: 'auto',
        invalidate: true
      });

      if (deletionResult.result !== 'ok') {
        throw new AppError('Failed to delete media from storage', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR);
      }

      // Remove from cache
      await CacheService.delete(cacheKey);

      // Update storage usage
      await this.updateStorageUsage(userId, -mediaRecord.size);

      // Track metrics
      await MetricsService.trackMediaDeletion(userId, mediaRecord.type);

      logger.info(`Media deleted successfully`, {
        userId,
        mediaId,
        type: mediaRecord.type
      });

      return {
        success: true,
        message: 'Media deleted successfully'
      };

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error deleting media:', error);
      throw new AppError(
        'Failed to delete media',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Get media info
   * @param {string} mediaId - Media ID
   * @param {string} userId - User ID (for access control)
   */
  async getMediaInfo(mediaId, userId) {
    try {
      const cacheKey = `media:${mediaId}`;
      let mediaRecord = await CacheService.get(cacheKey);
      
      if (!mediaRecord) {
        throw new AppError('Media not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
      }

      // Basic access control - can be extended
      if (mediaRecord.userId !== userId) {
        // Remove sensitive information for non-owners
        delete mediaRecord.cloudinaryData;
        delete mediaRecord.metadata.exif;
      }

      return mediaRecord;

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error getting media info:', error);
      throw new AppError(
        'Failed to retrieve media info',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Get user media statistics
   * @param {string} userId - User ID
   */
  async getUserMediaStats(userId) {
    try {
      const monthlyKey = `media:storage:${userId}:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
      const dailyKey = `media:uploads:${userId}:${new Date().toISOString().split('T')[0]}`;
      
      const [monthlyUsage, dailyUploads] = await Promise.all([
        redis.get(monthlyKey),
        redis.get(dailyKey)
      ]);

      // Get user subscription limits
      const User = (await import('../user/user.model.js')).default;
      const user = await User.findById(userId).select('subscription');
      const subscriptionType = user?.subscription?.type || 'free';
      const limits = this.subscriptionLimits[subscriptionType];

      return {
        usage: {
          monthlyStorage: parseInt(monthlyUsage) || 0,
          dailyUploads: parseInt(dailyUploads) || 0
        },
        limits: {
          monthlyStorage: limits.monthlyStorage,
          dailyUploads: limits.dailyUploads,
          maxVideoLength: limits.maxVideoLength,
          qualityLevel: limits.qualityLevel
        },
        subscription: subscriptionType
      };

    } catch (error) {
      logger.error('Error getting user media stats:', error);
      throw new AppError(
        'Failed to get media statistics',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  // Helper methods

  /**
   * Get media type from MIME type
   * @param {string} mimeType - MIME type
   */
  getMediaType(mimeType) {
    if (this.supportedImageTypes.includes(mimeType)) return 'image';
    if (this.supportedVideoTypes.includes(mimeType)) return 'video';
    if (this.supportedAudioTypes.includes(mimeType)) return 'audio';
    return 'unknown';
  }

  /**
   * Get file extension from filename
   * @param {string} filename - Filename
   */
  getFileExtension(filename) {
    return path.extname(filename).slice(1).toLowerCase();
  }

  /**
   * Check file integrity
   * @param {Object} file - File object
   */
  async checkFileIntegrity(file) {
    try {
      const mediaType = this.getMediaType(file.mimetype);
      
      if (mediaType === 'image') {
        // Try to read image with sharp
        await sharp(file.buffer).metadata();
      }
      
      return false; // File is not corrupted
    } catch (error) {
      return true; // File appears corrupted
    }
  }

  /**
   * Extract image metadata
   * @param {Object} file - File object
   */
  async extractImageMetadata(file) {
    try {
      const metadata = await sharp(file.buffer).metadata();
      
      return {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        colorSpace: metadata.space,
        channels: metadata.channels,
        density: metadata.density,
        hasAlpha: metadata.hasAlpha,
        orientation: metadata.orientation
      };
    } catch (error) {
      logger.error('Error extracting image metadata:', error);
      return {};
    }
  }

  /**
   * Extract video metadata
   * @param {Object} file - File object
   */
  async extractVideoMetadata(file) {
    try {
      return new Promise((resolve, reject) => {
        const tempPath = `/tmp/video_${Date.now()}.${this.getFileExtension(file.originalname)}`;
        
        fs.writeFile(tempPath, file.buffer)
          .then(() => {
            ffmpeg.ffprobe(tempPath, (err, metadata) => {
              // Cleanup temp file
              fs.unlink(tempPath).catch(() => {});
              
              if (err) {
                reject(err);
                return;
              }

              const videoStream = metadata.streams.find(s => s.codec_type === 'video');
              const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
              
              resolve({
                duration: parseFloat(metadata.format.duration) || 0,
                width: videoStream?.width || 0,
                height: videoStream?.height || 0,
                frameRate: videoStream?.r_frame_rate || '0/0',
                videoCodec: videoStream?.codec_name || 'unknown',
                audioCodec: audioStream?.codec_name || 'unknown',
                bitrate: parseInt(metadata.format.bit_rate) || 0,
                size: parseInt(metadata.format.size) || file.size
              });
            });
          })
          .catch(reject);
      });
    } catch (error) {
      logger.error('Error extracting video metadata:', error);
      return { duration: 0 };
    }
  }

  /**
   * Extract audio metadata
   * @param {Object} file - File object
   */
  async extractAudioMetadata(file) {
    try {
      return new Promise((resolve, reject) => {
        const tempPath = `/tmp/audio_${Date.now()}.${this.getFileExtension(file.originalname)}`;
        
        fs.writeFile(tempPath, file.buffer)
          .then(() => {
            ffmpeg.ffprobe(tempPath, (err, metadata) => {
              // Cleanup temp file
              fs.unlink(tempPath).catch(() => {});
              
              if (err) {
                reject(err);
                return;
              }

              const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
              
              resolve({
                duration: parseFloat(metadata.format.duration) || 0,
                codec: audioStream?.codec_name || 'unknown',
                bitrate: parseInt(audioStream?.bit_rate) || 0,
                sampleRate: parseInt(audioStream?.sample_rate) || 0,
                channels: audioStream?.channels || 1,
                channelLayout: audioStream?.channel_layout || 'mono',
                size: parseInt(metadata.format.size) || file.size
              });
            });
          })
          .catch(reject);
      });
    } catch (error) {
      logger.error('Error extracting audio metadata:', error);
      return { duration: 0 };
    }
  }

  /**
   * Optimize media for different use cases
   * @param {string} mediaId - Media ID
   * @param {string} optimization - Optimization type (web, mobile, thumbnail)
   */
  async optimizeMedia(mediaId, optimization = 'web') {
    try {
      const cacheKey = `media:${mediaId}`;
      const mediaRecord = await CacheService.get(cacheKey);
      
      if (!mediaRecord) {
        throw new AppError('Media not found', HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
      }

      const optimizationKey = `media:optimized:${mediaId}:${optimization}`;
      let optimizedUrl = await CacheService.get(optimizationKey);
      
      if (optimizedUrl) {
        return { url: optimizedUrl, cached: true };
      }

      // Generate optimized version
      let transformOptions = {};
      
      switch (optimization) {
        case 'thumbnail':
          transformOptions = {
            width: 150,
            height: 150,
            crop: 'fill',
            quality: 'auto:low',
            format: 'webp'
          };
          break;
        case 'mobile':
          transformOptions = {
            width: 800,
            height: 600,
            crop: 'limit',
            quality: 'auto:good',
            format: 'webp'
          };
          break;
        case 'web':
        default:
          transformOptions = {
            width: 1200,
            height: 900,
            crop: 'limit',
            quality: 'auto:good',
            format: 'webp'
          };
          break;
      }

      if (mediaRecord.type === 'video') {
        transformOptions.resource_type = 'video';
        transformOptions.format = 'mp4';
        if (optimization === 'thumbnail') {
          transformOptions.format = 'jpg';
          transformOptions.start_offset = '1s';
        }
      }

      optimizedUrl = cloudinary.url(mediaRecord.id, transformOptions);

      // Cache the optimized URL
      await CacheService.setWithTTL(optimizationKey, optimizedUrl, 3600 * 24); // 24 hours

      return { url: optimizedUrl, cached: false };

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error optimizing media:', error);
      throw new AppError(
        'Failed to optimize media',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Batch upload multiple files
   * @param {Array} files - Array of file objects
   * @param {string} userId - User ID
   * @param {Object} options - Upload options
   */
  async batchUpload(files, userId, options = {}) {
    try {
      if (!Array.isArray(files) || files.length === 0) {
        throw new AppError('No files provided', HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
      }

      const maxBatchSize = options.maxBatchSize || 10;
      if (files.length > maxBatchSize) {
        throw new AppError(
          `Batch size exceeds limit of ${maxBatchSize} files`,
          HTTP_STATUS.BAD_REQUEST,
          ERROR_CODES.VALIDATION_ERROR
        );
      }

      // Pre-validate all files
      const validationResults = await Promise.all(
        files.map(file => this.validateFile(file, userId))
      );

      const failedValidations = validationResults.filter(result => !result.valid);
      if (failedValidations.length > 0) {
        throw new AppError(
          `File validation failed: ${failedValidations.map(f => f.error).join(', ')}`,
          HTTP_STATUS.BAD_REQUEST,
          ERROR_CODES.VALIDATION_ERROR
        );
      }

      // Check batch limits
      const totalSize = files.reduce((sum, file) => sum + file.size, 0);
      await this.checkBatchLimits(userId, files.length, totalSize);

      // Process files in parallel with concurrency limit
      const concurrency = options.concurrency || 3;
      const results = [];
      
      for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map(file => this.uploadMedia(file, userId, options))
        );
        results.push(...batchResults);
      }

      // Separate successful and failed uploads
      const successful = [];
      const failed = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          successful.push({
            index,
            originalName: files[index].originalname,
            result: result.value
          });
        } else {
          failed.push({
            index,
            originalName: files[index].originalname,
            error: result.reason.message || 'Upload failed'
          });
        }
      });

      // Track metrics
      await MetricsService.trackBatchUpload(userId, successful.length, failed.length);

      logger.info(`Batch upload completed`, {
        userId,
        total: files.length,
        successful: successful.length,
        failed: failed.length
      });

      return {
        total: files.length,
        successful: successful.length,
        failed: failed.length,
        results: {
          successful,
          failed
        }
      };

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error in batch upload:', error);
      throw new AppError(
        'Batch upload failed',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Check batch upload limits
   * @param {string} userId - User ID
   * @param {number} fileCount - Number of files
   * @param {number} totalSize - Total size in bytes
   */
  async checkBatchLimits(userId, fileCount, totalSize) {
    try {
      const User = (await import('../user/user.model.js')).default;
      const user = await User.findById(userId).select('subscription');
      const subscriptionType = user?.subscription?.type || 'free';
      const limits = this.subscriptionLimits[subscriptionType];

      // Check if batch would exceed daily limits
      const dailyKey = `media:uploads:${userId}:${new Date().toISOString().split('T')[0]}`;
      const currentDailyCount = await redis.get(dailyKey) || 0;
      
      if (limits.dailyUploads !== -1 && 
          parseInt(currentDailyCount) + fileCount > limits.dailyUploads) {
        throw new AppError(
          'Batch upload would exceed daily upload limit',
          HTTP_STATUS.FORBIDDEN,
          ERROR_CODES.LIMIT_EXCEEDED
        );
      }

      // Check if batch would exceed monthly storage
      const monthlyKey = `media:storage:${userId}:${new Date().getFullYear()}-${new Date().getMonth() + 1}`;
      const currentMonthlyUsage = await redis.get(monthlyKey) || 0;
      
      if (limits.monthlyStorage !== -1 && 
          parseInt(currentMonthlyUsage) + totalSize > limits.monthlyStorage) {
        throw new AppError(
          'Batch upload would exceed monthly storage limit',
          HTTP_STATUS.FORBIDDEN,
          ERROR_CODES.LIMIT_EXCEEDED
        );
      }

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error checking batch limits:', error);
      throw new AppError(
        'Failed to verify batch upload limits',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Get media usage analytics
   * @param {string} userId - User ID
   * @param {Object} options - Analytics options
   */
  async getMediaAnalytics(userId, options = {}) {
    try {
      const { 
        period = 'month',
        includeBreakdown = true 
      } = options;

      const analytics = {
        period,
        userId,
        timestamp: new Date().toISOString()
      };

      // Get current usage
      const stats = await this.getUserMediaStats(userId);
      analytics.currentUsage = stats;

      if (includeBreakdown) {
        // Get usage breakdown by type
        const typeBreakdown = await this.getUsageBreakdownByType(userId, period);
        analytics.typeBreakdown = typeBreakdown;

        // Get upload trends
        const uploadTrends = await this.getUploadTrends(userId, period);
        analytics.uploadTrends = uploadTrends;
      }

      return analytics;

    } catch (error) {
      logger.error('Error getting media analytics:', error);
      throw new AppError(
        'Failed to get media analytics',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Get usage breakdown by media type
   * @param {string} userId - User ID
   * @param {string} period - Time period
   */
  async getUsageBreakdownByType(userId, period = 'month') {
    try {
      // This would typically query a database
      // For now, return mock data based on Redis counters
      const breakdown = {
        image: { count: 0, size: 0 },
        video: { count: 0, size: 0 },
        audio: { count: 0, size: 0 }
      };

      // In a real implementation, you'd query your media database
      // and aggregate by type within the specified period

      return breakdown;

    } catch (error) {
      logger.error('Error getting usage breakdown:', error);
      return {};
    }
  }

  /**
   * Get upload trends
   * @param {string} userId - User ID
   * @param {string} period - Time period
   */
  async getUploadTrends(userId, period = 'month') {
    try {
      const trends = [];
      const now = new Date();
      
      // Get daily trends for the period
      for (let i = 0; i < (period === 'month' ? 30 : 7); i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        
        const dayKey = `media:uploads:${userId}:${date.toISOString().split('T')[0]}`;
        const uploads = await redis.get(dayKey) || 0;
        
        trends.unshift({
          date: date.toISOString().split('T')[0],
          uploads: parseInt(uploads)
        });
      }

      return trends;

    } catch (error) {
      logger.error('Error getting upload trends:', error);
      return [];
    }
  }

  /**
   * Clean up expired media
   * @param {Object} options - Cleanup options
   */
  async cleanupExpiredMedia(options = {}) {
    try {
      const { 
        dryRun = false,
        batchSize = 100 
      } = options;

      logger.info('Starting media cleanup', { dryRun, batchSize });

      // This would typically query a database for expired media
      // For this implementation, we'll clean up old cache entries
      
      const cleanupResults = {
        processed: 0,
        deleted: 0,
        errors: 0,
        freed_space: 0
      };

      if (!dryRun) {
        // Actual cleanup would happen here
        // For now, just log the operation
        logger.info('Media cleanup completed', cleanupResults);
      } else {
        logger.info('Media cleanup dry run completed', cleanupResults);
      }

      return cleanupResults;

    } catch (error) {
      logger.error('Error during media cleanup:', error);
      throw new AppError(
        'Media cleanup failed',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }

  /**
   * Generate signed URL for direct upload
   * @param {string} userId - User ID
   * @param {Object} uploadParams - Upload parameters
   */
  async generateSignedUploadUrl(userId, uploadParams = {}) {
    try {
      const {
        resourceType = 'auto',
        folder = `temp/${userId}`,
        allowedFormats = ['jpg', 'png', 'webp', 'mp4', 'mov'],
        maxFileSize = 50000000, // 50MB
        transformation
      } = uploadParams;

      // Check user permissions
      await this.checkUserLimits(userId, { size: maxFileSize });

      const timestamp = Math.round(Date.now() / 1000);
      const params = {
        timestamp,
        folder,
        resource_type: resourceType,
        allowed_formats: allowedFormats.join(','),
        max_file_size: maxFileSize,
        ...(transformation && { transformation }),
        // Add user identification
        context: `user_id=${userId}`
      };

      // Generate signature
      const signature = cloudinary.utils.api_sign_request(params, cloudinary.config().api_secret);

      return {
        url: `https://api.cloudinary.com/v1_1/${cloudinary.config().cloud_name}/${resourceType}/upload`,
        params: {
          ...params,
          api_key: cloudinary.config().api_key,
          signature
        },
        expires_at: new Date((timestamp + 3600) * 1000) // 1 hour from now
      };

    } catch (error) {
      if (error instanceof AppError) throw error;
      
      logger.error('Error generating signed upload URL:', error);
      throw new AppError(
        'Failed to generate upload URL',
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        ERROR_CODES.INTERNAL_ERROR
      );
    }
  }
}

export default new MediaService();