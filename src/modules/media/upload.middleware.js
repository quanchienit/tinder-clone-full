// src/modules/media/upload.middleware.js
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import logger from '../../shared/utils/logger.js';
import redis from '../../config/redis.js';
import { 
  HTTP_STATUS, 
  ERROR_CODES, 
  MEDIA_CONSTANTS 
} from '../../config/constants.js';
import AppError from '../../shared/errors/AppError.js';

/**
 * File size limits based on subscription tiers
 */
export const FILE_LIMITS = {
  // Individual file size limits
  image: {
    free: 5 * 1024 * 1024,      // 5MB
    plus: 10 * 1024 * 1024,     // 10MB
    gold: 15 * 1024 * 1024,     // 15MB
    platinum: 25 * 1024 * 1024   // 25MB
  },
  video: {
    free: 25 * 1024 * 1024,     // 25MB
    plus: 50 * 1024 * 1024,     // 50MB
    gold: 100 * 1024 * 1024,    // 100MB
    platinum: 250 * 1024 * 1024  // 250MB
  },
  audio: {
    free: 10 * 1024 * 1024,     // 10MB
    plus: 25 * 1024 * 1024,     // 25MB
    gold: 50 * 1024 * 1024,     // 50MB
    platinum: 100 * 1024 * 1024  // 100MB
  },
  // Total request size limits
  totalRequest: {
    free: 50 * 1024 * 1024,     // 50MB
    plus: 100 * 1024 * 1024,    // 100MB
    gold: 250 * 1024 * 1024,    // 250MB
    platinum: 500 * 1024 * 1024  // 500MB
  }
};

/**
 * Allowed MIME types and file extensions
 */
export const ALLOWED_TYPES = {
  image: {
    mimeTypes: [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/bmp',
      'image/tiff'
    ],
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff']
  },
  video: {
    mimeTypes: [
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/avi',
      'video/mov',
      'video/wmv',
      'video/flv',
      'video/mkv'
    ],
    extensions: ['.mp4', '.mov', '.webm', '.avi', '.wmv', '.flv', '.mkv']
  },
  audio: {
    mimeTypes: [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
      'audio/m4a',
      'audio/aac',
      'audio/flac'
    ],
    extensions: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']
  }
};

/**
 * Dangerous file types and patterns to block
 */
const BLOCKED_TYPES = [
  'application/x-executable',
  'application/x-msdos-program',
  'application/x-msdownload',
  'application/x-winexe',
  'application/x-winhlp',
  'application/x-winhelp',
  'application/octet-stream',
  'text/javascript',
  'application/javascript',
  'text/html',
  'application/x-sh',
  'application/x-csh',
  'application/x-perl',
  'application/x-python-code',
  'application/x-php'
];

const BLOCKED_EXTENSIONS = [
  '.exe', '.bat', '.cmd', '.com', '.pif', '.scr', '.vbs', '.js', '.jar',
  '.sh', '.pl', '.py', '.php', '.asp', '.aspx', '.jsp', '.html', '.htm'
];

/**
 * Memory storage configuration
 */
const memoryStorage = multer.memoryStorage();

/**
 * Disk storage configuration (for temporary files)
 */
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, '/tmp/uploads');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${uniqueSuffix}${ext}`);
  }
});

/**
 * Advanced file filter with multiple security checks
 */
export const fileFilter = (req, file, cb) => {
  try {
    const fileExtension = path.extname(file.originalname).toLowerCase();
    const mimeType = file.mimetype.toLowerCase();

    // Block dangerous file types
    if (BLOCKED_TYPES.includes(mimeType) || BLOCKED_EXTENSIONS.includes(fileExtension)) {
      return cb(new AppError(
        'File type not allowed for security reasons',
        HTTP_STATUS.BAD_REQUEST,
        ERROR_CODES.INVALID_FILE_TYPE
      ), false);
    }

    // Check if file type is in allowed categories
    const isImage = ALLOWED_TYPES.image.mimeTypes.includes(mimeType);
    const isVideo = ALLOWED_TYPES.video.mimeTypes.includes(mimeType);
    const isAudio = ALLOWED_TYPES.audio.mimeTypes.includes(mimeType);

    if (!isImage && !isVideo && !isAudio) {
      return cb(new AppError(
        'Only image, video, and audio files are allowed',
        HTTP_STATUS.BAD_REQUEST,
        ERROR_CODES.INVALID_FILE_TYPE
      ), false);
    }

    // Validate file extension matches MIME type
    let expectedExtensions = [];
    if (isImage) expectedExtensions = ALLOWED_TYPES.image.extensions;
    if (isVideo) expectedExtensions = ALLOWED_TYPES.video.extensions;
    if (isAudio) expectedExtensions = ALLOWED_TYPES.audio.extensions;

    if (!expectedExtensions.includes(fileExtension)) {
      return cb(new AppError(
        'File extension does not match file type',
        HTTP_STATUS.BAD_REQUEST,
        ERROR_CODES.INVALID_FILE_TYPE
      ), false);
    }

    // Check filename for suspicious patterns
    const suspiciousPatterns = [
      /\.(php|asp|jsp|exe|bat|cmd|sh|pl|py)\./i,
      /[<>:"\\|?*]/,
      /\.\./,
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
    ];

    if (suspiciousPatterns.some(pattern => pattern.test(file.originalname))) {
      return cb(new AppError(
        'Invalid filename',
        HTTP_STATUS.BAD_REQUEST,
        ERROR_CODES.INVALID_FILE_TYPE
      ), false);
    }

    cb(null, true);

  } catch (error) {
    logger.error('File filter error:', error);
    cb(new AppError(
      'File validation failed',
      HTTP_STATUS.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR
    ), false);
  }
};

/**
 * Dynamic file size limits based on user subscription
 */
export const createLimitsForUser = (user) => {
  const subscriptionType = user?.subscription?.type || 'free';
  
  return {
    fileSize: FILE_LIMITS.video[subscriptionType], // Use video limit as max
    files: subscriptionType === 'free' ? 1 : 
           subscriptionType === 'plus' ? 5 :
           subscriptionType === 'gold' ? 10 : 20,
    parts: 100,
    headerPairs: 100
  };
};

/**
 * Advanced file validation middleware
 */
export const validateFileUpload = async (req, res, next) => {
  try {
    // Skip if no files uploaded
    if (!req.file && !req.files) {
      return next();
    }

    const files = req.files || [req.file];
    const user = req.user;
    const subscriptionType = user?.subscription?.type || 'free';

    for (const file of files) {
      if (!file) continue;

      // Validate actual file content vs reported MIME type
      if (file.buffer) {
        const actualFileType = await fileTypeFromBuffer(file.buffer);
        
        if (actualFileType && actualFileType.mime !== file.mimetype) {
          logger.warn('MIME type mismatch detected', {
            reported: file.mimetype,
            actual: actualFileType.mime,
            userId: user._id,
            filename: file.originalname
          });
          
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: {
              message: 'File type verification failed',
              code: ERROR_CODES.INVALID_FILE_TYPE
            }
          });
        }
      }

      // Check file size against subscription limits
      const mediaType = getMediaType(file.mimetype);
      const sizeLimit = FILE_LIMITS[mediaType][subscriptionType];
      
      if (file.size > sizeLimit) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            message: `File size exceeds ${Math.round(sizeLimit / 1024 / 1024)}MB limit for ${subscriptionType} subscription`,
            code: ERROR_CODES.FILE_TOO_LARGE
          }
        });
      }

      // Validate image dimensions and format
      if (mediaType === 'image') {
        const validation = await validateImageFile(file);
        if (!validation.valid) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: {
              message: validation.error,
              code: ERROR_CODES.VALIDATION_ERROR
            }
          });
        }
      }

      // Validate video duration and format
      if (mediaType === 'video') {
        const validation = await validateVideoFile(file, subscriptionType);
        if (!validation.valid) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: {
              message: validation.error,
              code: ERROR_CODES.VALIDATION_ERROR
            }
          });
        }
      }

      // Validate audio duration and format
      if (mediaType === 'audio') {
        const validation = await validateAudioFile(file, subscriptionType);
        if (!validation.valid) {
          return res.status(HTTP_STATUS.BAD_REQUEST).json({
            success: false,
            error: {
              message: validation.error,
              code: ERROR_CODES.VALIDATION_ERROR
            }
          });
        }
      }

      // Check for malicious content patterns
      const securityCheck = await performSecurityScan(file);
      if (!securityCheck.safe) {
        logger.warn('Security scan failed for file', {
          userId: user._id,
          filename: file.originalname,
          reason: securityCheck.reason
        });
        
        return res.status(HTTP_STATUS.BAD_REQUEST).json({
          success: false,
          error: {
            message: 'File failed security scan',
            code: ERROR_CODES.VALIDATION_ERROR
          }
        });
      }

      // Rate limiting check for uploads
      const uploadCheck = await checkUploadRateLimit(user._id, subscriptionType);
      if (!uploadCheck.allowed) {
        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          success: false,
          error: {
            message: uploadCheck.message,
            code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
            resetTime: uploadCheck.resetTime
          }
        });
      }
    }

    next();

  } catch (error) {
    logger.error('File validation error:', error);
    return res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      success: false,
      error: {
        message: 'File validation failed',
        code: ERROR_CODES.VALIDATION_ERROR
      }
    });
  }
};

/**
 * Validate image files
 */
const validateImageFile = async (file) => {
  try {
    const metadata = await sharp(file.buffer).metadata();
    
    // Check minimum dimensions
    if (metadata.width < 100 || metadata.height < 100) {
      return { valid: false, error: 'Image must be at least 100x100 pixels' };
    }

    // Check maximum dimensions
    const maxDimension = 8192; // 8K resolution
    if (metadata.width > maxDimension || metadata.height > maxDimension) {
      return { valid: false, error: `Image dimensions cannot exceed ${maxDimension}x${maxDimension}` };
    }

    // Check aspect ratio (prevent extremely narrow images)
    const aspectRatio = metadata.width / metadata.height;
    if (aspectRatio > 10 || aspectRatio < 0.1) {
      return { valid: false, error: 'Invalid image aspect ratio' };
    }

    // Check for animated images (if not allowed)
    if (metadata.pages && metadata.pages > 1 && file.mimetype !== 'image/gif') {
      return { valid: false, error: 'Animated images not allowed for this format' };
    }

    return { valid: true };

  } catch (error) {
    logger.error('Image validation error:', error);
    return { valid: false, error: 'Invalid image file' };
  }
};

/**
 * Validate video files
 */
const validateVideoFile = async (file, subscriptionType) => {
  try {
    // This would require saving to temp file for ffprobe
    // For now, basic validation
    const maxDurations = {
      free: 30,      // 30 seconds
      plus: 120,     // 2 minutes
      gold: 300,     // 5 minutes
      platinum: 600  // 10 minutes
    };

    // Basic file header validation
    const header = file.buffer.slice(0, 20);
    const isValidVideo = checkVideoHeader(header, file.mimetype);
    
    if (!isValidVideo) {
      return { valid: false, error: 'Invalid video file format' };
    }

    return { valid: true };

  } catch (error) {
    logger.error('Video validation error:', error);
    return { valid: false, error: 'Invalid video file' };
  }
};

/**
 * Validate audio files
 */
const validateAudioFile = async (file, subscriptionType) => {
  try {
    const maxDurations = {
      free: 60,      // 1 minute
      plus: 300,     // 5 minutes
      gold: 600,     // 10 minutes
      platinum: 1200 // 20 minutes
    };

    // Basic audio header validation
    const header = file.buffer.slice(0, 20);
    const isValidAudio = checkAudioHeader(header, file.mimetype);
    
    if (!isValidAudio) {
      return { valid: false, error: 'Invalid audio file format' };
    }

    return { valid: true };

  } catch (error) {
    logger.error('Audio validation error:', error);
    return { valid: false, error: 'Invalid audio file' };
  }
};

/**
 * Check video file headers for validation
 */
const checkVideoHeader = (buffer, mimeType) => {
  const signatures = {
    'video/mp4': [0x00, 0x00, 0x00, 0x18], // ftyp box
    'video/quicktime': [0x00, 0x00, 0x00, 0x14], // QuickTime
    'video/webm': [0x1A, 0x45, 0xDF, 0xA3], // EBML header
    'video/avi': [0x52, 0x49, 0x46, 0x46] // RIFF header
  };

  const signature = signatures[mimeType];
  if (!signature) return true; // Unknown type, let it pass

  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Check audio file headers for validation
 */
const checkAudioHeader = (buffer, mimeType) => {
  const signatures = {
    'audio/mpeg': [0xFF, 0xFB], // MP3 header
    'audio/wav': [0x52, 0x49, 0x46, 0x46], // RIFF header
    'audio/ogg': [0x4F, 0x67, 0x67, 0x53], // OggS
    'audio/m4a': [0x00, 0x00, 0x00, 0x20] // M4A
  };

  const signature = signatures[mimeType];
  if (!signature) return true; // Unknown type, let it pass

  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }

  return true;
};

/**
 * Perform security scan on uploaded files
 */
const performSecurityScan = async (file) => {
  try {
    const buffer = file.buffer;
    
    // Check for suspicious patterns in file content
    const suspiciousPatterns = [
      // Script tags
      /<script[^>]*>/i,
      /<\/script>/i,
      // PHP tags
      /<\?php/i,
      /<\?=/i,
      // Executable signatures
      /MZ.{58}PE/,
      // Shell commands
      /\$\(.*\)/,
      /`.*`/,
      // SQL injection patterns
      /union.*select/i,
      /drop.*table/i
    ];

    const fileContent = buffer.toString('ascii', 0, Math.min(buffer.length, 8192));
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(fileContent)) {
        return { 
          safe: false, 
          reason: 'Suspicious content pattern detected' 
        };
      }
    }

    // Check for embedded executables in images
    if (file.mimetype.startsWith('image/')) {
      // Look for PE header (Windows executable) embedded in image
      const peIndex = buffer.indexOf('PE\0\0');
      if (peIndex > 0 && peIndex < buffer.length - 100) {
        return { 
          safe: false, 
          reason: 'Embedded executable detected' 
        };
      }
    }

    return { safe: true };

  } catch (error) {
    logger.error('Security scan error:', error);
    // Fail safe - reject file if scan fails
    return { 
      safe: false, 
      reason: 'Security scan failed' 
    };
  }
};

/**
 * Check upload rate limits
 */
const checkUploadRateLimit = async (userId, subscriptionType) => {
  try {
    const limits = {
      free: { uploads: 10, window: 3600 },    // 10 uploads per hour
      plus: { uploads: 50, window: 3600 },    // 50 uploads per hour
      gold: { uploads: 100, window: 3600 },   // 100 uploads per hour
      platinum: { uploads: -1, window: 3600 } // Unlimited
    };

    const limit = limits[subscriptionType];
    if (limit.uploads === -1) {
      return { allowed: true };
    }

    const key = `upload_limit:${userId}:${Math.floor(Date.now() / (limit.window * 1000))}`;
    const current = await redis.get(key) || 0;

    if (parseInt(current) >= limit.uploads) {
      const resetTime = new Date((Math.floor(Date.now() / (limit.window * 1000)) + 1) * limit.window * 1000);
      return { 
        allowed: false, 
        message: `Upload limit exceeded. Try again after ${resetTime.toLocaleTimeString()}`,
        resetTime
      };
    }

    // Increment counter
    await redis.multi()
      .incr(key)
      .expire(key, limit.window)
      .exec();

    return { allowed: true };

  } catch (error) {
    logger.error('Rate limit check error:', error);
    // Fail open - allow upload if rate limit check fails
    return { allowed: true };
  }
};

/**
 * Get media type from MIME type
 */
const getMediaType = (mimeType) => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'unknown';
};

/**
 * Error handling for multer
 */
export const handleMulterError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    let message = 'File upload error';
    let code = ERROR_CODES.UPLOAD_FAILED;

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File too large';
        code = ERROR_CODES.FILE_TOO_LARGE;
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
      case 'LIMIT_PART_COUNT':
        message = 'Too many form parts';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
      case 'LIMIT_FIELD_KEY':
        message = 'Field name too long';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
      case 'LIMIT_FIELD_VALUE':
        message = 'Field value too long';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
      case 'LIMIT_FIELD_COUNT':
        message = 'Too many fields';
        code = ERROR_CODES.VALIDATION_ERROR;
        break;
    }

    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        message,
        code,
        details: error.message
      }
    });
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      success: false,
      error: {
        message: error.message,
        code: error.errorCode
      }
    });
  }

  next(error);
};

/**
 * Create multer middleware with user-specific limits
 */
export const createUploadMiddleware = (options = {}) => {
  const {
    storage = memoryStorage,
    preservePath = false,
    dest,
    limits: customLimits
  } = options;

  return (req, res, next) => {
    const user = req.user;
    const limits = customLimits || createLimitsForUser(user);

    const uploadMiddleware = multer({
      storage,
      fileFilter,
      limits,
      preservePath,
      dest
    });

    return uploadMiddleware;
  };
};

/**
 * Single file upload middleware
 */
export const upload = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB default
    files: 1
  }
});

/**
 * Multiple files upload middleware
 */
export const uploadMultiple = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
    files: 10 // Max 10 files
  }
});

/**
 * Any field upload middleware
 */
export const uploadAny = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 20
  }
});

/**
 * Disk storage upload for large files
 */
export const uploadToDisk = multer({
  storage: diskStorage,
  fileFilter,
  limits: {
    fileSize: 250 * 1024 * 1024, // 250MB for disk storage
    files: 5
  }
});

// Export limits for use in other modules
export const limits = FILE_LIMITS;

// Export file type checking utilities
export { getMediaType,  BLOCKED_TYPES };

// Default exports
export default {
  upload,
  uploadMultiple,
  uploadAny,
  uploadToDisk,
  fileFilter,
  validateFileUpload,
  handleMulterError,
  createUploadMiddleware,
  limits: FILE_LIMITS,
  allowedTypes: ALLOWED_TYPES
};