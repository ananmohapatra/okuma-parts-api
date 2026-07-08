import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';

interface HttpError extends Error {
    status?: number;
    response?: { status: number };
}

function errorHandler(err: HttpError, _req: Request, res: Response, _next: NextFunction): void {
    const status = err.status ?? err.response?.status ?? 500;
    const message = status < 500 ? err.message : 'Internal server error';

    if (status >= 500) {
        logger.error('Unhandled error:', err);
    }

    res.status(status).json({ error: message });
}

export default errorHandler;
