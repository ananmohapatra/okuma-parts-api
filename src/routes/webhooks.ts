import express, { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../config';
import logger from '../config/logger';
import { AppError, UnauthorizedError } from '../middleware/errors';

interface WebhookPayload {
    hash?: string;
    data?: unknown;
}

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        // eslint-disable-next-line no-shadow
        interface Request {
            webhookPayload?: WebhookPayload;
        }
    }
}

const router = Router();

// Must parse raw body (not JSON) so we can verify the HMAC signature
router.use(express.raw({ type: 'application/json' }));

function verifySignature(rawBody: Buffer, hash: string | undefined): boolean {
    if (!config.bc.clientSecret || !hash) return false;
    const computed = crypto.createHmac('sha256', config.bc.clientSecret).update(rawBody).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
    } catch {
        return false;
    }
}

function parseAndVerify(req: Request, _res: Response, next: NextFunction): void {
    let payload: WebhookPayload;
    try {
        payload = JSON.parse((req.body as Buffer).toString()) as WebhookPayload;
    } catch {
        next(new AppError('Invalid JSON payload', 400));
        return;
    }

    if (!verifySignature(req.body as Buffer, payload.hash)) {
        next(new UnauthorizedError('Invalid webhook signature'));
        return;
    }

    req.webhookPayload = payload;
    next();
}

async function handleOrderWebhook(payload: WebhookPayload | undefined): Promise<void> {
    // TODO: implement order status update logic
    logger.info(`Order webhook received: ${JSON.stringify(payload?.data)}`);
}

router.post('/order', parseAndVerify, (req: Request, res: Response) => {
    // Acknowledge within 5s — heavy processing runs asynchronously
    res.status(200).json({ received: true });
    handleOrderWebhook(req.webhookPayload).catch(err => {
        logger.error('Order webhook processing error:', err);
    });
});

export default router;
