import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import config from '../../config';
import authenticateBCToken from '../../middleware/auth';
import products from './products';
import partsBook from './parts-book';

const router = Router();

const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});

router.use(apiLimiter);
router.use(authenticateBCToken);

router.use('/products', products);
router.use('/', partsBook);

export default router;
