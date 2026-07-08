"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const config_1 = __importDefault(require("../../config"));
const auth_1 = __importDefault(require("../../middleware/auth"));
const products_1 = __importDefault(require("./products"));
const parts_book_1 = __importDefault(require("./parts-book"));
const router = (0, express_1.Router)();
const apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: config_1.default.rateLimit.windowMs,
    max: config_1.default.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});
router.use(apiLimiter);
router.use(auth_1.default);
router.use('/products', products_1.default);
router.use('/', parts_book_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map