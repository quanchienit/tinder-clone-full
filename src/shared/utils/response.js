// src/shared/utils/response.js
import { HTTP_STATUS } from '../../config/constants.js';
import logger from './logger.js';

/**
 * Standard success response
 */
export const successResponse = (res, data = null, message = 'Success', statusCode = HTTP_STATUS.OK) => {
    const response = {
        success: true,
        message,
    };

    if (data !== null && data !== undefined) {
        // Check if data has pagination
        if (data.pagination) {
            response.data = data.data;
            response.pagination = data.pagination;
        } else {
            response.data = data;
        }
    }

    // Add request ID if available
    if (res.req?.id) {
        response.requestId = res.req.id;
    }

    return res.status(statusCode).json(response);
};

/**
 * Standard error response
 */
export const errorResponse = (res, message = 'An error occurred', statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, errorCode = null, errors = null) => {
    const response = {
        success: false,
        error: {
            message,
        },
    };

    if (errorCode) {
        response.error.code = errorCode;
    }

    if (errors) {
        response.error.errors = errors;
    }

    // Add request ID if available
    if (res.req?.id) {
        response.requestId = res.req.id;
    }

    // Log error
    logger.error('Error response', {
        statusCode,
        message,
        errorCode,
        errors,
        requestId: res.req?.id,
        path: res.req?.originalUrl,
    });

    return res.status(statusCode).json(response);
};

/**
 * Created response (201)
 */
export const createdResponse = (res, data, message = 'Resource created successfully') => {
    return successResponse(res, data, message, HTTP_STATUS.CREATED);
};

/**
 * No content response (204)
 */
export const noContentResponse = (res) => {
    return res.status(HTTP_STATUS.NO_CONTENT).send();
};

/**
 * Bad request response (400)
 */
export const badRequestResponse = (res, message = 'Bad request', errors = null) => {
    return errorResponse(res, message, HTTP_STATUS.BAD_REQUEST, 'BAD_REQUEST', errors);
};

/**
 * Unauthorized response (401)
 */
export const unauthorizedResponse = (res, message = 'Unauthorized') => {
    return errorResponse(res, message, HTTP_STATUS.UNAUTHORIZED, 'UNAUTHORIZED');
};

/**
 * Forbidden response (403)
 */
export const forbiddenResponse = (res, message = 'Forbidden') => {
    return errorResponse(res, message, HTTP_STATUS.FORBIDDEN, 'FORBIDDEN');
};

/**
 * Not found response (404)
 */
export const notFoundResponse = (res, message = 'Resource not found') => {
    return errorResponse(res, message, HTTP_STATUS.NOT_FOUND, 'NOT_FOUND');
};

/**
 * Conflict response (409)
 */
export const conflictResponse = (res, message = 'Resource already exists') => {
    return errorResponse(res, message, HTTP_STATUS.CONFLICT, 'CONFLICT');
};

/**
 * Unprocessable entity response (422)
 */
export const unprocessableEntityResponse = (res, message = 'Unprocessable entity', errors = null) => {
    return errorResponse(res, message, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY', errors);
};

/**
 * Too many requests response (429)
 */
export const tooManyRequestsResponse = (res, message = 'Too many requests', retryAfter = 60) => {
    res.setHeader('Retry-After', retryAfter);
    return errorResponse(res, message, HTTP_STATUS.TOO_MANY_REQUESTS, 'RATE_LIMIT_EXCEEDED');
};

/**
 * Internal server error response (500)
 */
export const serverErrorResponse = (res, message = 'Internal server error') => {
    return errorResponse(res, message, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR');
};

/**
 * Service unavailable response (503)
 */
export const serviceUnavailableResponse = (res, message = 'Service temporarily unavailable') => {
    return errorResponse(res, message, HTTP_STATUS.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
};

/**
 * Paginated response
 */
export const paginatedResponse = (res, data, total, page, limit, message = 'Success') => {
    const totalPages = Math.ceil(total / limit);

    const response = {
        success: true,
        message,
        data,
        pagination: {
            total,
            page,
            limit,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
        },
    };

    // Add request ID if available
    if (res.req?.id) {
        response.requestId = res.req.id;
    }

    return res.status(HTTP_STATUS.OK).json(response);
};

/**
 * File response
 */
export const fileResponse = (res, file, filename = 'file') => {
    res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', file.size);

    return res.send(file.buffer);
};

/**
 * Stream response
 */
export const streamResponse = (res, stream, contentType = 'application/octet-stream') => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');

    stream.pipe(res);

    stream.on('error', (error) => {
        logger.error('Stream error:', error);
        if (!res.headersSent) {
            serverErrorResponse(res, 'Stream error occurred');
        }
    });
};

/**
 * Redirect response
 */
export const redirectResponse = (res, url, permanent = false) => {
    const statusCode = permanent ? 301 : 302;
    return res.redirect(statusCode, url);
};

/**
 * Custom response with headers
 */
export const customResponse = (res, data, statusCode = HTTP_STATUS.OK, headers = {}) => {
    Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
    });

    return res.status(statusCode).json(data);
};

/**
 * Response with cache headers
 */
export const cachedResponse = (res, data, maxAge = 3600, message = 'Success') => {
    res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
    res.setHeader('Expires', new Date(Date.now() + maxAge * 1000).toUTCString());

    return successResponse(res, data, message);
};

/**
 * Response for async operations
 */
export const asyncResponse = (res, jobId, message = 'Operation started') => {
    return res.status(HTTP_STATUS.ACCEPTED).json({
        success: true,
        message,
        jobId,
        statusUrl: `/api/jobs/${jobId}/status`,
    });
};

/**
 * Batch response for multiple operations
 */
export const batchResponse = (res, results, message = 'Batch operation completed') => {
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    return res.status(HTTP_STATUS.OK).json({
        success: true,
        message,
        summary: {
            total: results.length,
            successful,
            failed,
        },
        results,
    });
};

/**
 * Response wrapper for async handlers
 */
export const handleResponse = async (res, asyncFunction, successMessage = 'Success') => {
    try {
        const result = await asyncFunction();
        return successResponse(res, result, successMessage);
    } catch (error) {
        logger.error('Handler error:', error);

        if (error.statusCode) {
            return errorResponse(res, error.message, error.statusCode, error.errorCode);
        }

        return serverErrorResponse(res);
    }
};

/**
 * Format validation errors for response
 */
export const formatValidationErrors = (errors) => {
    if (Array.isArray(errors)) {
        return errors.map(error => ({
            field: error.param || error.field,
            message: error.msg || error.message,
            value: error.value,
        }));
    }

    return Object.entries(errors).map(([field, error]) => ({
        field,
        message: error.message || error,
    }));
};

/**
 * Response interceptor for adding metadata
 */
export const responseInterceptor = (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = function (data) {
        // Add response time
        if (req.startTime) {
            const duration = Date.now() - req.startTime;
            res.setHeader('X-Response-Time', `${duration}ms`);

            // Log slow responses
            if (duration > 1000) {
                logger.warn('Slow response detected', {
                    path: req.originalUrl,
                    method: req.method,
                    duration,
                });
            }
        }

        // Add request ID header
        if (req.id) {
            res.setHeader('X-Request-ID', req.id);
        }

        // Add rate limit headers if available
        if (req.rateLimit) {
            res.setHeader('X-RateLimit-Limit', req.rateLimit.limit);
            res.setHeader('X-RateLimit-Remaining', req.rateLimit.remaining);
            res.setHeader('X-RateLimit-Reset', new Date(req.rateLimit.resetTime).toISOString());
        }

        return originalJson(data);
    };

    next();
};

export default {
    success: successResponse,
    error: errorResponse,
    created: createdResponse,
    noContent: noContentResponse,
    badRequest: badRequestResponse,
    unauthorized: unauthorizedResponse,
    forbidden: forbiddenResponse,
    notFound: notFoundResponse,
    conflict: conflictResponse,
    unprocessableEntity: unprocessableEntityResponse,
    tooManyRequests: tooManyRequestsResponse,
    serverError: serverErrorResponse,
    serviceUnavailable: serviceUnavailableResponse,
    paginated: paginatedResponse,
    file: fileResponse,
    stream: streamResponse,
    redirect: redirectResponse,
    custom: customResponse,
    cached: cachedResponse,
    async: asyncResponse,
    batch: batchResponse,
    handle: handleResponse,
};