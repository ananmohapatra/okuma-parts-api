import { Router } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../../services/bigcommerce';

const router = Router();

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
