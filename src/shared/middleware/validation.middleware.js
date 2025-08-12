// src/shared/middleware/validation.middleware.js
import { validationResult } from 'express-validator';
import { HTTP_STATUS, ERROR_CODES } from '../../config/constants.js';
import AppError from '../errors/AppError.js';
import logger from '../utils/logger.js';

/**
 * Validate request using express-validator
 */
export const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map(error => ({
      field: error.param,
      message: error.msg,
      value: error.value,
      location: error.location,
    }));

    logger.debug('Validation errors:', formattedErrors);

    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      success: false,
      error: {
        message: 'Validation failed',
        code: ERROR_CODES.VALIDATION_ERROR,
        errors: formattedErrors,
      },
    });
  }

  next();
};

/**
 * Sanitize request data
 */
export const sanitizeRequest = (req, res, next) => {
  // Sanitize common XSS attempts
  const sanitizeString = (str) => {
    if (typeof str !== 'string') return str;
    
    return str
      .replace(/[<>]/g, '') // Remove < and >
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+\s*=/gi, '') // Remove inline event handlers
      .trim();
  };

  const sanitizeObject = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        sanitized[key] = sanitizeString(value);
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map(item => 
          typeof item === 'object' ? sanitizeObject(item) : sanitizeString(item)
        );
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };

  if (req.body) {
    req.body = sanitizeObject(req.body);
  }

  if (req.query) {
    req.query = sanitizeObject(req.query);
  }

  if (req.params) {
    req.params = sanitizeObject(req.params);
  }

  next();
};

/**
 * Validate MongoDB ObjectId
 */
export const validateObjectId = (paramName = 'id') => {
  return (req, res, next) => {
    const id = req.params[paramName];
    
    // MongoDB ObjectId pattern
    const objectIdPattern = /^[0-9a-fA-F]{24}$/;
    
    if (!objectIdPattern.test(id)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: `Invalid ${paramName} format`,
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    
    next();
  };
};

/**
 * Validate pagination parameters
 */
export const validatePagination = (req, res, next) => {
  const { page, limit, sort, order } = req.query;
  
  // Parse and validate page
  if (page) {
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid page number',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    req.query.page = pageNum;
  } else {
    req.query.page = 1;
  }
  
  // Parse and validate limit
  if (limit) {
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid limit. Must be between 1 and 100',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    req.query.limit = limitNum;
  } else {
    req.query.limit = 20;
  }
  
  // Validate sort field
  if (sort) {
    const allowedSortFields = ['createdAt', 'updatedAt', 'name', 'age', 'distance'];
    if (!allowedSortFields.includes(sort)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid sort field',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
  }
  
  // Validate order
  if (order) {
    if (!['asc', 'desc', '1', '-1'].includes(order)) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid sort order. Must be asc or desc',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    req.query.order = order === 'asc' || order === '1' ? 1 : -1;
  } else {
    req.query.order = -1;
  }
  
  next();
};

/**
 * Validate date range
 */
export const validateDateRange = (req, res, next) => {
  const { startDate, endDate } = req.query;
  
  if (startDate) {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid start date format',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    req.query.startDate = start;
  }
  
  if (endDate) {
    const end = new Date(endDate);
    if (isNaN(end.getTime())) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Invalid end date format',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
    req.query.endDate = end;
  }
  
  if (startDate && endDate) {
    if (req.query.startDate > req.query.endDate) {
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        success: false,
        error: {
          message: 'Start date must be before end date',
          code: ERROR_CODES.VALIDATION_ERROR,
        },
      });
    }
}}