import { Router } from 'express';
import products from './products';
import partsBook from './parts-book';
import dealers from '../dealers';
import customers from './customers';
import addresses from './addresses';

const router = Router();

router.use('/products', products);
router.use('/', partsBook);
router.use('/', dealers);
router.use('/', customers);
router.use('/', addresses);

export default router;
