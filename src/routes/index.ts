import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import authenticateBCToken from '../middleware/auth';
import config from '../config';
import health from './health';
import auth from './auth';
import webhooks from './webhooks';
import v1Router from './v1';
import customer from './customer';
import customers from './customers';
import cart from './cart';
import checkout from './checkout';
import dashboard from './dashboard';
import partsSearch from './parts-search';
import payments from './payments';

const router = Router();
// Rate limiter
const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
    validate: { xForwardedForHeader: false },
});

// Public routes — not versioned
router.use('/health', health);
router.use('/auth', auth);
router.use('/webhooks', webhooks);
// Rate-limited even though unauthenticated — these accept card/charge input and are a
// prime target for card-testing/abuse, so they must not be exempt from apiLimiter.
router.use('/payments', apiLimiter, payments);

// Public v1 routes — registered before the '/v1/api' mount below. `customers.ts` declares
// its route as the full path '/api/customer/:customerId/profile', which (mounted here at
// '/v1') resolves to '/v1/api/customer/:customerId/profile' — a path that would otherwise
// also match the '/v1/api' prefix. Routers try mounts in registration order, so these public
// routes must come first or that endpoint would incorrectly hit apiLimiter + authenticateBCToken
// (and 401 for any real Stencil/browser caller with no X-Auth-Token) before ever reaching its
// own handler.
router.use('/v1', apiLimiter, customer);
router.use('/v1', apiLimiter, customers);
router.use('/v1', apiLimiter, cart);
router.use('/v1', apiLimiter, checkout);
router.use('/v1', apiLimiter, partsSearch);
router.use('/v1/dashboard', apiLimiter, authenticateBCToken, dashboard);

// Versioned API (auth-gated, server-to-server)
router.use('/v1/api', apiLimiter, authenticateBCToken, v1Router);

export default router;
