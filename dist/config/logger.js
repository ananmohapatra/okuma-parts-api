"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = require("winston");
const env = process.env.NODE_ENV || 'development';
const devFormat = winston_1.format.combine(winston_1.format.colorize(), winston_1.format.timestamp({ format: 'HH:mm:ss' }), winston_1.format.errors({ stack: true }), winston_1.format.printf(({ level, message, timestamp, stack }) => stack ? `[${timestamp}] ${level}: ${String(message)}\n${stack}` : `[${timestamp}] ${level}: ${String(message)}`));
const prodFormat = winston_1.format.combine(winston_1.format.timestamp(), winston_1.format.errors({ stack: true }), winston_1.format.json());
const LEVELS = {
    development: 'debug',
    test: 'warn',
};
const logger = (0, winston_1.createLogger)({
    level: LEVELS[env] || 'http',
    format: env === 'development' ? devFormat : prodFormat,
    transports: [new winston_1.transports.Console()],
});
exports.default = logger;
//# sourceMappingURL=logger.js.map