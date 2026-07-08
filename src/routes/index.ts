import { Router } from 'express';
import health from './health';
import auth from './auth';
import webhooks from './webhooks';
import v1Router from './v1';
import dealers from './dealers';
import customer from './customer';
import customers from './customers';
import partsBook from './parts-book';

const router = Router();

// Public routes — not versioned
router.use('/health', health);
router.use('/auth', auth);
router.use('/webhooks', webhooks);

// Versioned API (auth-gated, server-to-server)
router.use('/api/v1', v1Router);

// Public v1 routes
router.use('/v1', dealers);
router.use('/v1', customer);
router.use('/v1', customers);
router.use('/v1', partsBook);

export default router;
