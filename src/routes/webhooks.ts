import express, { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import config from '../config';
import logger from '../config/logger';
import { AppError, UnauthorizedError } from '../middleware/errors';

/** Shape of an incoming BigCommerce webhook request body after JSON parsing. */
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

/**
 * Verifies a BigCommerce webhook's HMAC-SHA256 signature against the raw request
 * body, using a timing-safe comparison to avoid leaking the expected hash via
 * response-time side channels.
 * @param rawBody - Raw (unparsed) request body buffer, as received.
 * @param hash - The `hash` field from the parsed webhook payload.
 * @returns True if the signature is valid; false if invalid, missing, or the secret isn't configured.
 */
function verifySignature(rawBody: Buffer, hash: string | undefined): boolean {
    if (!config.bc.clientSecret || !hash) return false;
    const computed = crypto.createHmac('sha256', config.bc.clientSecret).update(rawBody).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
    } catch {
        return false;
    }
}

/**
 * Middleware that parses the raw webhook body as JSON, verifies its HMAC
 * signature, and attaches the parsed payload to `req.webhookPayload` for
 * downstream handlers. Forwards a 400 AppError on invalid JSON or a 401
 * UnauthorizedError on a bad/missing signature.
 * @param req - Express request; `req.body` must be the raw Buffer (see `express.raw()` above).
 * @param _res - Express response (unused).
 * @param next - Express next function; called with no args on success, or an error on failure.
 * @returns Nothing — delegates to `next()`.
 */
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

/**
 * Processes a verified order webhook payload asynchronously, after the request
 * has already been acknowledged with a 200 (see `POST /order` below).
 * @param payload - The parsed, signature-verified webhook payload.
 * @returns Nothing — currently only logs; order status update logic is not yet implemented.
 */
async function handleOrderWebhook(payload: WebhookPayload | undefined): Promise<void> {
    // TODO: implement order status update logic
    logger.info(`Order webhook received: ${JSON.stringify(payload?.data)}`);
}

/**
 * POST /order
 *
 * BigCommerce `store/order/statusUpdated` webhook receiver. Verifies the HMAC
 * signature (via `parseAndVerify`), acknowledges immediately with 200 (BC
 * requires a response within 5s), then processes the payload asynchronously.
 *
 * Body: raw JSON BC webhook payload (parsed by `parseAndVerify` into `req.webhookPayload`).
 * Response: { received: true }
 */
router.post('/order', parseAndVerify, (req: Request, res: Response) => {
    // Acknowledge within 5s — heavy processing runs asynchronously
    res.status(200).json({ received: true });
    handleOrderWebhook(req.webhookPayload).catch(err => {
        logger.error('Order webhook processing error:', err);
    });
});

export default router;
