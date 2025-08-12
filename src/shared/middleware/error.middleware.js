// src/shared/middleware/error.middleware.js
import logger from '../utils/logger.js';
import { HTTP_STATUS, ERROR_CODES } from '../../config/constants.js';
import AppError from '../errors/AppError.js';
import MetricsService from '../services/metrics.service.js';

/**
 * Async error handler wrapper
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Not found error handler
 */
export const notFound = (req, res, next) => {
  const error = new AppError(
    `Route not found: ${req.originalUrl}`,
    HTTP_STATUS.NOT_FOUND,
    ERROR_CODES.NOT_FOUND
  );
  next(error);
};

/**
 * Global error handler
 */
export const errorHandler = async (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  logger.error({
    error: {
      message: err.message,
      stack: err.stack,
      code: err.errorCode || err.code,
      statusCode: err.statusCode,
    },
    request: {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.user?._id,
      requestId: req.id,
    },
    timestamp: new Date().toISOString(),
  });

  // Track error metrics
  await MetricsService.incrementCounter('errors.total', 1, {
    statusCode: err.statusCode || 500,
    path: req.route?.path || 'unknown',
  });

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Invalid ID format';
    error = new AppError(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    const message = `${field} already exists`;
    error = new AppError(message, HTTP_STATUS.CONFLICT, ERROR_CODES.ALREADY_EXISTS);
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map(e => ({
      field: e.path,
      message: e.message,
    }));
    const message = 'Validation failed';
    error = new AppError(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
    error.errors = errors;
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = new AppError(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_INVALID);
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = new AppError(message, HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_EXPIRED);
  }

  // Multer errors
  if (err.name === 'MulterError') {
    let message = 'File upload error';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = 'File too large';
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      message = 'Too many files';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      message = 'Unexpected file field';
    }
    error = new AppError(message, HTTP_STATUS.BAD_REQUEST, ERROR_CODES.VALIDATION_ERROR);
  }

  // Rate limit error
  if (err.statusCode === 429) {
    error = new AppError(
      'Too many requests. Please try again later.',
      HTTP_STATUS.TOO_MANY_REQUESTS,
      ERROR_CODES.RATE_LIMIT_EXCEEDED
    );
  }

  // Send error response
  res.status(error.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
    success: false,
    error: {
      message: error.message || 'Server Error',
      code: error.errorCode || ERROR_CODES.INTERNAL_ERROR,
      ...(process.env.NODE_ENV === 'development' && {
        stack: err.stack,
        details: err,
      }),
      ...(error.errors && { errors: error.errors }),
    },
    requestId: req.id,
  });
};

/**
 * Validation error formatter
 */
export const validationErrorFormatter = (errors) => {
  const formattedErrors = errors.array().map(error => ({
    field: error.param,
    message: error.msg,
    value: error.value,
    location: error.location,
  }));

  return new AppError(
    'Validation failed',
    HTTP_STATUS.BAD_REQUEST,
    ERROR_CODES.VALIDATION_ERROR,
    formattedErrors
  );
};

/**
 * MongoDB error handler
 */
export const mongoErrorHandler = (error) => {
  if (error.name === 'MongoServerError') {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return new AppError(
        `${field} already exists`,
        HTTP_STATUS.CONFLICT,
        ERROR_CODES.ALREADY_EXISTS
      );
    }
  }

  if (error.name === 'ValidationError') {
    const errors = Object.values(error.errors).map(err => ({
      field: err.path,
      message: err.message,
    }));
    
    return new AppError(
      'Validation failed',
      HTTP_STATUS.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR,
      errors
    );
  }

  if (error.name === 'CastError') {
    return new AppError(
      `Invalid ${error.path}: ${error.value}`,
      HTTP_STATUS.BAD_REQUEST,
      ERROR_CODES.VALIDATION_ERROR
    );
  }

  return error;
};

/**
 * Payload too large handler
 */
export const payloadTooLarge = (err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        message: 'Request payload too large',
        code: ERROR_CODES.VALIDATION_ERROR,
        maxSize: '10MB',
      },
    });
  }
  next(err);
};

/**
 * CORS error handler
 */
export const corsErrorHandler = (err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(HTTP_STATUS.FORBIDDEN).json({
      success: false,
      error: {
        message: 'CORS policy violation',
        code: ERROR_CODES.FORBIDDEN,
        origin: req.headers.origin,
      },
    });
  }
  next(err);
};

/**
 * Timeout handler
 */
export const timeoutHandler = (timeout = 30000) => {
  return (req, res, next) => {
    const timeoutId = setTimeout(() => {
      const error = new AppError(
        'Request timeout',
        HTTP_STATUS.REQUEST_TIMEOUT,
        ERROR_CODES.TIMEOUT
      );
      next(error);
    }, timeout);

    res.on('finish', () => {
      clearTimeout(timeoutId);
    });

    next();
  };
};

/**
 * Syntax error handler (for JSON parsing errors)
 */
export const syntaxErrorHandler = (err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        message: 'Invalid JSON payload',
        code: ERROR_CODES.VALIDATION_ERROR,
      },
    });
  }
  next(err);
};

/**
 * Database connection error handler
 */
export const dbConnectionErrorHandler = (err, req, res, next) => {
  if (err.name === 'MongooseServerSelectionError' || 
      err.name === 'MongoNetworkError') {
    logger.error('Database connection error:', err);
    
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      success: false,
      error: {
        message: 'Database service temporarily unavailable',
        code: ERROR_CODES.DATABASE_ERROR,
      },
    });
  }
  next(err);
};

/**
 * Unhandled rejection handler
 */
export const unhandledRejectionHandler = () => {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit the process in production
    if (process.env.NODE_ENV !== 'production') {
      process.exit(1);
    }
  });
};

/**
 * Uncaught exception handler
 */
export const uncaughtExceptionHandler = () => {
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    // Exit the process as the application is in an undefined state
    process.exit(1);
  });
};

/**
 * Graceful shutdown handler
 */
export const gracefulShutdownHandler = (server) => {
  const shutdown = async (signal) => {
    logger.info(`${signal} received, starting graceful shutdown...`);
    
    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Close database connections
    try {
      // Close MongoDB
      const mongoose = await import('mongoose');
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
      
      // Close Redis
      const redis = await import('../../config/redis.js');
      await redis.default.disconnect();
      logger.info('Redis connection closed');
      
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};