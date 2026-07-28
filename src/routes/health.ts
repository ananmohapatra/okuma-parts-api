import { Router } from 'express';

const router = Router();

/**
 * GET /health
 * Liveness check endpoint. Returns the current server status and UTC timestamp.
 * @returns {{ status: string, timestamp: string }} JSON body with `status: 'ok'` and an ISO 8601 timestamp.
 */
router.get('/', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
