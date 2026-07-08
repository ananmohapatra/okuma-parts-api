"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bigcommerce_1 = __importDefault(require("../services/bigcommerce"));
const logger_1 = __importDefault(require("../config/logger"));
const errors_1 = require("./errors");
async function authenticateBCToken(req, _res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || typeof token !== 'string') {
        next(new errors_1.UnauthorizedError('Missing X-Auth-Token header'));
        return;
    }
    try {
        // Validate by hitting a lightweight BC endpoint with the caller's token.
        // bcClient interceptor handles logging of any BC-level error.
        await bigcommerce_1.default.get('/v2/store', { headers: { 'X-Auth-Token': token } });
        next();
    }
    catch (err) {
        const status = err.response?.status;
        if (status === 401 || status === 403) {
            logger_1.default.warn(`Rejected request with invalid X-Auth-Token from ${req.ip}`);
            next(new errors_1.UnauthorizedError('Invalid X-Auth-Token'));
            return;
        }
        next(err);
    }
}
exports.default = authenticateBCToken;
//# sourceMappingURL=auth.js.map