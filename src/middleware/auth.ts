import { Request, Response, NextFunction } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../services/bigcommerce';
import logger from '../config/logger';
import { UnauthorizedError } from './errors';

async function authenticateBCToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = req.headers['x-auth-token'];

    if (!token || typeof token !== 'string') {
        next(new UnauthorizedError('Missing X-Auth-Token header'));
        return;
    }

    try {
        // Validate by hitting a lightweight BC endpoint with the caller's token.
        // bcClient interceptor handles logging of any BC-level error.
        await bcClient.get('/v2/store', { headers: { 'X-Auth-Token': token } });
        next();
    } catch (err) {
        const status = (err as AxiosError).response?.status;
        if (status === 401 || status === 403) {
            logger.warn(`Rejected request with invalid X-Auth-Token from ${req.ip}`);
            next(new UnauthorizedError('Invalid X-Auth-Token'));
            return;
        }
        next(err);
    }
}

export default authenticateBCToken;
