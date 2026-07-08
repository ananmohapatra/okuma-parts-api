"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const health_1 = __importDefault(require("./health"));
const auth_1 = __importDefault(require("./auth"));
const webhooks_1 = __importDefault(require("./webhooks"));
const v1_1 = __importDefault(require("./v1"));
const dealers_1 = __importDefault(require("./dealers"));
const customer_1 = __importDefault(require("./customer"));
const customers_1 = __importDefault(require("./customers"));
const parts_book_1 = __importDefault(require("./parts-book"));
const router = (0, express_1.Router)();
// Public routes — not versioned
router.use('/health', health_1.default);
router.use('/auth', auth_1.default);
router.use('/webhooks', webhooks_1.default);
// Versioned API (auth-gated, server-to-server)
router.use('/api/v1', v1_1.default);
// Public v1 routes
router.use('/v1', dealers_1.default);
router.use('/v1', customer_1.default);
router.use('/v1', customers_1.default);
router.use('/v1', parts_book_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map