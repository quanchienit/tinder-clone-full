// src/modules/media/media.model.js
import mongoose from 'mongoose';
import { MEDIA_CONSTANTS } from '../../config/constants.js';

const { Schema } = mongoose;

/**
 * Media Schema for storing file metadata and relationships
 */
const mediaSchema = new Schema({
  // Basic Information
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // File Details
  originalName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 255
  },
  
  filename: {
    type: String,
    required: true,
    unique: true
  },
  
  mimeType: {
    type: String,
    required: true,
    enum: [
      // Images
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
      // Videos  
      'video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'video/mov',
      // Audio
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/m4a'
    ]
  },
  
  type: {
    type: String,
    required: true,
    enum: ['image', 'video', 'audio'],
    index: true
  },
  
  size: {
    type: Number,
    required: true,
    min: 0
  },
  
  // Cloudinary Information
  cloudinaryId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  cloudinaryUrl: {
    type: String,
    required: true
  },
  
  // File Variants (thumbnails, different sizes)
  variants: {
    thumbnail: {
      url: String,
      width: Number,
      height: Number,
      size: Number
    },
    medium: {
      url: String,
      width: Number,
      height: Number,
      size: Number
    },
    large: {
      url: String,
      width: Number,
      height: Number,
      size: Number
    },
    compressed: {
      url: String,
      quality: Number,
      size: Number
    }
  },
  
  // Media Metadata
  metadata: {
    // Image specific
    width: Number,
    height: Number,
    aspectRatio: Number,
    colorSpace: String,
    hasAlpha: Boolean,
    orientation: Number,
    
    // Video/Audio specific
    duration: Number,
    bitrate: Number,
    frameRate: String,
    codec: String,
    
    // Audio specific
    sampleRate: Number,
    channels: Number,
    
    // EXIF data (sanitized)
    cameraMake: String,
    cameraModel: String,
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        index: '2dsphere'
      }
    }
  },
  
  // Usage Context
  context: {
    type: String,
    enum: ['profile', 'chat', 'story', 'verification', 'general'],
    default: 'general',
    index: true
  },
  
  // Associated with specific entities
  associatedWith: {
    profileId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    matchId: {
      type: Schema.Types.ObjectId,
      ref: 'Match'
    },
    messageId: {
      type: Schema.Types.ObjectId,
      ref: 'Message'
    },
    storyId: {
      type: Schema.Types.ObjectId,
      ref: 'Story'
    }
  },
  
  // Status and Moderation
  status: {
    type: String,
    enum: ['uploading', 'processing', 'active', 'flagged', 'blocked', 'deleted'],
    default: 'uploading',
    index: true
  },
  
  moderation: {
    isScanned: {
      type: Boolean,
      default: false
    },
    scanResult: {
      isAppropriate: Boolean,
      confidence: Number,
      flags: [{
        type: String,
        confidence: Number,
        reason: String
      }],
      scanProvider: String,
      scannedAt: Date
    },
    isApproved: {
      type: Boolean,
      default: null // null = pending, true = approved, false = rejected
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    approvedAt: Date,
    rejectionReason: String
  },
  
  // Privacy and Sharing
  privacy: {
    isPublic: {
      type: Boolean,
      default: false
    },
    isShared: {
      type: Boolean,
      default: false
    },
    sharedWith: [{
      userId: {
        type: Schema.Types.ObjectId,
        ref: 'User'
      },
      sharedAt: Date,
      permissions: {
        canView: { type: Boolean, default: true },
        canDownload: { type: Boolean, default: false },
        canShare: { type: Boolean, default: false }
      }
    }],
    shareToken: String,
    shareExpiresAt: Date
  },
  
  // Analytics and Usage
  analytics: {
    viewCount: {
      type: Number,
      default: 0
    },
    downloadCount: {
      type: Number,
      default: 0
    },
    shareCount: {
      type: Number,
      default: 0
    },
    lastAccessed: Date,
    accessLog: [{
      userId: Schema.Types.ObjectId,
      action: {
        type: String,
        enum: ['view', 'download', 'share', 'report']
      },
      timestamp: {
        type: Date,
        default: Date.now
      },
      ipAddress: String,
      userAgent: String
    }]
  },
  
  // Organization
  folder: {
    type: String,
    default: 'default',
    index: true
  },
  
  tags: [{
    type: String,
    trim: true,
    lowercase: true,
    maxlength: 50
  }],
  
  // Processing Information
  processing: {
    isProcessed: {
      type: Boolean,
      default: false
    },
    processingStarted: Date,
    processingCompleted: Date,
    processingTime: Number, // milliseconds
    processingSteps: [{
      step: String,
      status: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed']
      },
      startedAt: Date,
      completedAt: Date,
      error: String
    }],
    processingErrors: [String]
  },
  
  // Backup and Recovery
  backup: {
    isBackedUp: {
      type: Boolean,
      default: false
    },
    backupLocation: String,
    backupAt: Date,
    checksumMD5: String,
    checksumSHA256: String
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
mediaSchema.index({ userId: 1, createdAt: -1 });
mediaSchema.index({ userId: 1, type: 1 });
mediaSchema.index({ userId: 1, context: 1 });
mediaSchema.index({ userId: 1, status: 1 });
mediaSchema.index({ cloudinaryId: 1 }, { unique: true });
mediaSchema.index({ 'metadata.location': '2dsphere' });
mediaSchema.index({ tags: 1 });
mediaSchema.index({ folder: 1 });
mediaSchema.index({ createdAt: -1 });
mediaSchema.index({ 'moderation.isApproved': 1 });

// Virtual for file URL (primary)
mediaSchema.virtual('url').get(function() {
  return this.cloudinaryUrl;
});

// Virtual for file size in MB
mediaSchema.virtual('sizeMB').get(function() {
  return (this.size / (1024 * 1024)).toFixed(2);
});

// Virtual for total storage used by variants
mediaSchema.virtual('totalSize').get(function() {
  let total = this.size;
  
  if (this.variants) {
    Object.values(this.variants).forEach(variant => {
      if (variant.size) total += variant.size;
    });
  }
  
  return total;
});

// Virtual for media age
mediaSchema.virtual('age').get(function() {
  return Date.now() - this.createdAt.getTime();
});

// Virtual for processing duration
mediaSchema.virtual('processingDuration').get(function() {
  if (this.processing.processingStarted && this.processing.processingCompleted) {
    return this.processing.processingCompleted - this.processing.processingStarted;
  }
  return null;
});

// Pre-save middleware
mediaSchema.pre('save', function(next) {
  // Generate filename if not provided
  if (!this.filename) {
    this.filename = `${this.userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // Set type based on mimeType if not provided
  if (!this.type && this.mimeType) {
    if (this.mimeType.startsWith('image/')) this.type = 'image';
    else if (this.mimeType.startsWith('video/')) this.type = 'video';
    else if (this.mimeType.startsWith('audio/')) this.type = 'audio';
  }
  
  // Calculate aspect ratio for images/videos
  if (this.metadata && this.metadata.width && this.metadata.height) {
    this.metadata.aspectRatio = this.metadata.width / this.metadata.height;
  }
  
  next();
});

// Instance methods
mediaSchema.methods.toPublicJSON = function(includePrivate = false) {
  const obj = this.toObject();
  
  // Remove sensitive information
  delete obj.__v;
  delete obj.backup;
  delete obj.processing.processingErrors;
  
  if (!includePrivate) {
    delete obj.analytics.accessLog;
    delete obj.moderation.scanResult;
    delete obj.cloudinaryId;
    delete obj.metadata.location;
  }
  
  return obj;
};

mediaSchema.methods.incrementView = function(userId, ipAddress, userAgent) {
  this.analytics.viewCount += 1;
  this.analytics.lastAccessed = new Date();
  
  // Log access (keep only last 100 entries)
  this.analytics.accessLog.push({
    userId,
    action: 'view',
    ipAddress,
    userAgent
  });
  
  if (this.analytics.accessLog.length > 100) {
    this.analytics.accessLog = this.analytics.accessLog.slice(-100);
  }
  
  return this.save();
};

mediaSchema.methods.updateStatus = function(status, error = null) {
  this.status = status;
  
  if (status === 'processing') {
    this.processing.processingStarted = new Date();
  } else if (status === 'active') {
    this.processing.processingCompleted = new Date();
    this.processing.isProcessed = true;
    
    if (this.processing.processingStarted) {
      this.processing.processingTime = this.processing.processingCompleted - this.processing.processingStarted;
    }
  } else if (status === 'blocked' && error) {
    this.processing.processingErrors.push(error);
  }
  
  return this.save();
};

mediaSchema.methods.addProcessingStep = function(step, status = 'pending') {
  this.processing.processingSteps.push({
    step,
    status,
    startedAt: status === 'processing' ? new Date() : undefined
  });
  
  return this.save();
};

mediaSchema.methods.updateProcessingStep = function(stepIndex, status, error = null) {
  if (this.processing.processingSteps[stepIndex]) {
    this.processing.processingSteps[stepIndex].status = status;
    
    if (status === 'completed' || status === 'failed') {
      this.processing.processingSteps[stepIndex].completedAt = new Date();
    }
    
    if (error) {
      this.processing.processingSteps[stepIndex].error = error;
    }
  }
  
  return this.save();
};

// Static methods
mediaSchema.statics.findByUser = function(userId, options = {}) {
  const {
    type,
    context,
    status = 'active',
    limit = 20,
    page = 1,
    sort = { createdAt: -1 }
  } = options;
  
  const query = { userId, status };
  
  if (type) query.type = type;
  if (context) query.context = context;
  
  return this.find(query)
    .sort(sort)
    .limit(limit)
    .skip((page - 1) * limit)
    .populate('userId', 'profile.firstName profile.displayName');
};

mediaSchema.statics.getUserStorageUsage = function(userId) {
  return this.aggregate([
    { $match: { userId: mongoose.Types.ObjectId(userId), status: { $ne: 'deleted' } } },
    {
      $group: {
        _id: '$type',
        totalSize: { $sum: '$size' },
        count: { $sum: 1 },
        avgSize: { $avg: '$size' }
      }
    }
  ]);
};

mediaSchema.statics.getSystemStats = function() {
  return this.aggregate([
    {
      $group: {
        _id: '$type',
        totalFiles: { $sum: 1 },
        totalSize: { $sum: '$size' },
        avgSize: { $avg: '$size' }
      }
    }
  ]);
};

mediaSchema.statics.findDuplicates = function(userId, threshold = 0.95) {
  // This would implement duplicate detection logic
  // For now, return empty array
  return Promise.resolve([]);
};

mediaSchema.statics.cleanupExpired = function(maxAge = 30 * 24 * 60 * 60 * 1000) {
  const cutoffDate = new Date(Date.now() - maxAge);
  
  return this.updateMany(
    {
      status: 'deleted',
      updatedAt: { $lt: cutoffDate }
    },
    {
      $set: { status: 'purged' }
    }
  );
};

// Create and export model
const Media = mongoose.model('Media', mediaSchema);

export default Media;