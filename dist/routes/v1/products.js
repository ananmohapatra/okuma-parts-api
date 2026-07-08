"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bigcommerce_1 = __importDefault(require("../../services/bigcommerce"));
const router = (0, express_1.Router)();
router.get('/', async (req, res, next) => {
    try {
        const { page = 1, limit = 50, keyword } = req.query;
        const params = { page, limit };
        if (keyword)
            params.keyword = keyword;
        const { data } = await bigcommerce_1.default.get('/v3/catalog/products', { params });
        res.json(data);
    }
    catch (err) {
        next(err);
    }
});
router.get('/:id', async (req, res, next) => {
    try {
        const { data } = await bigcommerce_1.default.get(`/v3/catalog/products/${req.params.id}`);
        res.json(data);
    }
    catch (err) {
        if (err.response?.status === 404) {
            res.status(404).json({ error: 'Product not found' });
            return;
        }
        next(err);
    }
});
exports.default = router;
//# sourceMappingURL=products.js.map