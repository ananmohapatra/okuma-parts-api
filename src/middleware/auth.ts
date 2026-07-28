import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import config from '../config';
import logger from '../config/logger';
import { UnauthorizedError } from './errors';

/**
 * Express middleware that validates the BigCommerce X-Auth-Token request header.
 * Compares the supplied token against the configured BC access token using a
 * timing-safe byte comparison to prevent timing attacks. Passes control to the
 * next handler on success; calls next(UnauthorizedError) on a missing or invalid token.
 */
function authenticateBCToken(req: Request, _res: Response, next: NextFunction): void {
    const rawToken = req.headers['x-auth-token'];

    if (!rawToken || Array.isArray(rawToken)) {
        next(new UnauthorizedError('Missing X-Auth-Token header'));
        return;
    }

    const token = rawToken;
    const expected = config.bc.accessToken ?? '';

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);

    const valid = tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf);

    if (!valid) {
        logger.warn(`Invalid X-Auth-Token from ${req.ip}`);
        next(new UnauthorizedError('Invalid X-Auth-Token'));
        return;
    }

    next();
}

export default authenticateBCToken;
