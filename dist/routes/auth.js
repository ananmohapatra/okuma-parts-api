"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../config/logger"));
const router = (0, express_1.Router)();
router.get('/callback', async (req, res, next) => {
    const { code, scope, context } = req.query;
    if (!code || !context) {
        res.status(400).json({ error: 'Missing required OAuth parameters' });
        return;
    }
    try {
        const { data } = await axios_1.default.post('https://login.bigcommerce.com/oauth2/token', {
            client_id: config_1.default.bc.clientId,
            client_secret: config_1.default.bc.clientSecret,
            code,
            scope,
            context,
            grant_type: 'authorization_code',
            redirect_uri: config_1.default.bc.appCallbackUrl,
        });
        // TODO: persist data.access_token and data.context (store_hash) to your data store
        logger_1.default.info(`OAuth install complete for store: ${data.context}`);
        res.json({ installed: true, context: data.context });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map