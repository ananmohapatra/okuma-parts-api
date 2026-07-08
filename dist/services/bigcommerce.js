"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("../config/logger"));
const bcClient = axios_1.default.create({
    baseURL: config_1.default.bc.apiBaseUrl,
    headers: {
        'X-Auth-Token': config_1.default.bc.accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    },
    timeout: 10000,
});
bcClient.interceptors.response.use(res => res, (err) => {
    const status = err.response?.status;
    const message = err.response?.data?.title ?? err.message;
    logger_1.default.error(`BC API error [${status}]: ${message}`);
    return Promise.reject(err);
});
exports.default = bcClient;
//# sourceMappingURL=bigcommerce.js.map