"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const logger_1 = __importDefault(require("../config/logger"));
function errorHandler(err, _req, res, _next) {
    const status = err.status ?? err.response?.status ?? 500;
    const message = status < 500 ? err.message : 'Internal server error';
    if (status >= 500) {
        logger_1.default.error('Unhandled error:', err);
    }
    res.status(status).json({ error: message });
}
exports.default = errorHandler;
//# sourceMappingURL=errorHandler.js.map