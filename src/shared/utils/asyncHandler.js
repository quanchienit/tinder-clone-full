// src/shared/utils/asyncHandler.js

/**
 * Wrapper for async route handlers to catch errors
 * @param {Function} fn - Async function to wrap
 * @returns {Function} - Express middleware function
 */
export const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next))
            .catch(next);
    };
};

/**
 * Wrapper for async route handlers with automatic response
 * @param {Function} fn - Async function that returns data
 * @returns {Function} - Express middleware function
 */
export const asyncAutoResponse = (fn) => {
    return async (req, res, next) => {
        try {
            const result = await fn(req, res);

            // If function already sent response, don't send again
            if (res.headersSent) {
                return;
            }

            // Send success response with result
            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Wrapper for async middleware
 * @param {Function} fn - Async middleware function
 * @returns {Function} - Express middleware function
 */
export const asyncMiddleware = (fn) => {
    return async (req, res, next) => {
        try {
            await fn(req, res, next);
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Execute multiple async functions in parallel
 * @param {...Function} fns - Async functions to execute
 * @returns {Function} - Express middleware function
 */
export const asyncParallel = (...fns) => {
    return async (req, res, next) => {
        try {
            await Promise.all(fns.map(fn => fn(req, res)));
            next();
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Execute multiple async functions in sequence
 * @param {...Function} fns - Async functions to execute
 * @returns {Function} - Express middleware function
 */
export const asyncSequence = (...fns) => {
    return async (req, res, next) => {
        try {
            for (const fn of fns) {
                await fn(req, res);
                if (res.headersSent) {
                    return;
                }
            }
            next();
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Retry async function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {Object} options - Retry options
 * @returns {Function} - Express middleware function
 */
export const asyncRetry = (fn, options = {}) => {
    const {
        retries = 3,
        delay = 1000,
        backoff = 2,
        shouldRetry = () => true,
    } = options;

    return async (req, res, next) => {
        let lastError;

        for (let i = 0; i < retries; i++) {
            try {
                const result = await fn(req, res);

                if (!res.headersSent) {
                    res.status(200).json({
                        success: true,
                        data: result,
                    });
                }

                return;
            } catch (error) {
                lastError = error;

                if (!shouldRetry(error) || i === retries - 1) {
                    break;
                }

                const waitTime = delay * Math.pow(backoff, i);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        next(lastError);
    };
};

/**
 * Timeout wrapper for async functions
 * @param {Function} fn - Async function to wrap
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Function} - Express middleware function
 */
export const asyncTimeout = (fn, timeout = 30000) => {
    return async (req, res, next) => {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Request timeout after ${timeout}ms`));
            }, timeout);
        });

        try {
            const result = await Promise.race([
                fn(req, res),
                timeoutPromise,
            ]);

            if (!res.headersSent) {
                res.status(200).json({
                    success: true,
                    data: result,
                });
            }
        } catch (error) {
            if (error.message.includes('timeout')) {
                res.status(408).json({
                    success: false,
                    error: {
                        message: 'Request timeout',
                        code: 'TIMEOUT',
                    },
                });
            } else {
                next(error);
            }
        }
    };
};

/**
 * Cache wrapper for async functions
 * @param {Function} fn - Async function to cache
 * @param {Function} keyGenerator - Function to generate cache key
 * @param {number} ttl - Cache TTL in seconds
 * @returns {Function} - Express middleware function
 */
export const asyncCache = (fn, keyGenerator, ttl = 3600) => {
    const cache = new Map();

    return async (req, res, next) => {
        try {
            const key = keyGenerator(req);

            // Check cache
            if (cache.has(key)) {
                const cached = cache.get(key);
                if (cached.expiry > Date.now()) {
                    return res.status(200).json({
                        success: true,
                        data: cached.data,
                        cached: true,
                    });
                }
                cache.delete(key);
            }

            // Execute function
            const result = await fn(req, res);

            // Cache result
            cache.set(key, {
                data: result,
                expiry: Date.now() + ttl * 1000,
            });

            if (!res.headersSent) {
                res.status(200).json({
                    success: true,
                    data: result,
                    cached: false,
                });
            }
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Conditional async wrapper
 * @param {Function} condition - Function to check condition
 * @param {Function} fn - Async function to execute if condition is true
 * @param {Function} elseFn - Async function to execute if condition is false
 * @returns {Function} - Express middleware function
 */
export const asyncConditional = (condition, fn, elseFn = null) => {
    return async (req, res, next) => {
        try {
            const shouldExecute = await condition(req);

            if (shouldExecute) {
                await fn(req, res, next);
            } else if (elseFn) {
                await elseFn(req, res, next);
            } else {
                next();
            }
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Transform async function result
 * @param {Function} fn - Async function
 * @param {Function} transformer - Function to transform result
 * @returns {Function} - Express middleware function
 */
export const asyncTransform = (fn, transformer) => {
    return async (req, res, next) => {
        try {
            const result = await fn(req, res);
            const transformed = await transformer(result, req);

            if (!res.headersSent) {
                res.status(200).json({
                    success: true,
                    data: transformed,
                });
            }
        } catch (error) {
            next(error);
        }
    };
};

/**
 * Validate async function result
 * @param {Function} fn - Async function
 * @param {Function} validator - Function to validate result
 * @returns {Function} - Express middleware function
 */
export const asyncValidate = (fn, validator) => {
    return async (req, res, next) => {
        try {
            const result = await fn(req, res);
            const validation = await validator(result);

            if (!validation.valid) {
                return res.status(400).json({
                    success: false,
                    error: {
                        message: validation.message || 'Validation failed',
                        errors: validation.errors,
                    },
                });
            }

            if (!res.headersSent) {
                res.status(200).json({
                    success: true,
                    data: result,
                });
            }
        } catch (error) {
            next(error);
        }
    };
};

export default asyncHandler;