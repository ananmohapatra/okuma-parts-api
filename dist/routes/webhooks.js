"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importStar(require("express"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../config/logger"));
const errors_1 = require("../middleware/errors");
const router = (0, express_1.Router)();
// Must parse raw body (not JSON) so we can verify the HMAC signature
router.use(express_1.default.raw({ type: 'application/json' }));
function verifySignature(rawBody, hash) {
    if (!config_1.default.bc.clientSecret || !hash)
        return false;
    const computed = crypto_1.default.createHmac('sha256', config_1.default.bc.clientSecret).update(rawBody).digest('base64');
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
    }
    catch {
        return false;
    }
}
function parseAndVerify(req, _res, next) {
    let payload;
    try {
        payload = JSON.parse(req.body.toString());
    }
    catch {
        next(new errors_1.AppError('Invalid JSON payload', 400));
        return;
    }
    if (!verifySignature(req.body, payload.hash)) {
        next(new errors_1.UnauthorizedError('Invalid webhook signature'));
        return;
    }
    req.webhookPayload = payload;
    next();
}
async function handleOrderWebhook(payload) {
    // TODO: implement order status update logic
    logger_1.default.info(`Order webhook received: ${JSON.stringify(payload?.data)}`);
}
router.post('/order', parseAndVerify, (req, res) => {
    // Acknowledge within 5s — heavy processing runs asynchronously
    res.status(200).json({ received: true });
    handleOrderWebhook(req.webhookPayload).catch(err => {
        logger_1.default.error('Order webhook processing error:', err);
    });
});
exports.default = router;
//# sourceMappingURL=webhooks.js.map