import { Router } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../../services/bigcommerce';

const router = Router();

/**
 * GET /
 *
 * Proxies BigCommerce's catalog product list, with optional keyword search
 * and pagination.
 *
 * Query: page (default 1), limit (default 50), keyword (optional).
 * Response: raw BC `/v3/catalog/products` list response.
 */
router.get('/', async (req, res, next) => {
    try {
        const { page = 1, limit = 50, keyword } = req.query;
        const params: Record<string, unknown> = { page, limit };
        if (keyword) params.keyword = keyword;

        const { data } = await bcClient.get('/v3/catalog/products', { params });
        res.json(data);
    } catch (err) {
        next(err);
    }
});

/**
 * GET /:id
 *
 * Proxies a single BigCommerce catalog product by ID.
 *
 * Params: id - BC product ID.
 * Response: raw BC `/v3/catalog/products/:id` response, or 404 if not found.
 */
router.get('/:id', async (req, res, next) => {
    try {
        const { data } = await bcClient.get(`/v3/catalog/products/${req.params.id}`);
        res.json(data);
    } catch (err) {
        if ((err as AxiosError).response?.status === 404) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }
        next(err);
    }
});

export default router;
