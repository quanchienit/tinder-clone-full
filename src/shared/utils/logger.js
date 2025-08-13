// src/shared/utils/logger.js
import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define log colors
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

// Tell winston to use our custom colors
winston.addColors(colors);

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    
    return msg;
  })
);

// Define console format (colored for development)
const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    
    if (metadata.error) {
      msg += `\n${metadata.error.stack || metadata.error}`;
    } else if (Object.keys(metadata).length > 0) {
      msg += `\n${JSON.stringify(metadata, null, 2)}`;
    }
    
    return msg;
  })
);

// Create transports
const transports = [];

// Console transport (always active)
transports.push(
  new winston.transports.Console({
    format: process.env.NODE_ENV === 'production' ? logFormat : consoleFormat,
    level: process.env.LOG_LEVEL || 'debug',
  })
);

// File transports (only in production)
if (process.env.NODE_ENV === 'production') {
  // Daily rotate file for all logs
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(__dirname, '../../../logs/app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      format: logFormat,
      level: 'info',
    })
  );

  // Daily rotate file for errors only
  transports.push(
    new winston.transports.DailyRotateFile({
      filename: path.join(__dirname, '../../../logs/error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '30d',
      format: logFormat,
      level: 'error',
    })
  );
}

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  levels,
  format: logFormat,
  transports,
  exitOnError: false,
});

// Handle exceptions and rejections
logger.exceptions.handle(
  new winston.transports.File({ 
    filename: path.join(__dirname, '../../../logs/exceptions.log'),
    format: logFormat,
  })
);

logger.rejections.handle(
  new winston.transports.File({ 
    filename: path.join(__dirname, '../../../logs/rejections.log'),
    format: logFormat,
  })
);

// Stream for Morgan HTTP logger
logger.stream = {
  write: (message) => logger.http(message.trim()),
};

// Helper methods for structured logging
logger.logRequest = (req, additionalInfo = {}) => {
  logger.http('Request', {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    userId: req.user?._id,
    ...additionalInfo,
  });
};

logger.logResponse = (req, res, additionalInfo = {}) => {
  logger.http('Response', {
    method: req.method,
    url: req.originalUrl,
    statusCode: res.statusCode,
    userId: req.user?._id,
    responseTime: res.responseTime,
    ...additionalInfo,
  });
};

logger.logError = (error, req = null, additionalInfo = {}) => {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    code: error.code || error.errorCode,
    statusCode: error.statusCode,
    ...additionalInfo,
  };

  if (req) {
    errorInfo.request = {
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.user?._id,
    };
  }

  logger.error('Error occurred', errorInfo);
};

logger.logDatabase = (operation, collection, additionalInfo = {}) => {
  logger.debug('Database operation', {
    operation,
    collection,
    ...additionalInfo,
  });
};

logger.logPerformance = (operation, duration, additionalInfo = {}) => {
  const level = duration > 1000 ? 'warn' : 'debug';
  logger[level]('Performance metric', {
    operation,
    duration: `${duration}ms`,
    ...additionalInfo,
  });
};

// Utility to measure performance
logger.startTimer = () => {
  const start = Date.now();
  return {
    done: (operation, additionalInfo = {}) => {
      const duration = Date.now() - start;
      logger.logPerformance(operation, duration, additionalInfo);
      return duration;
    },
  };
};

export default logger;