"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = __importDefault(require("net"));
const app_1 = __importDefault(require("./app"));
const config_1 = __importDefault(require("./config"));
const logger_1 = __importDefault(require("./config/logger"));
function isPortAvailable(port) {
    return new Promise(resolve => {
        const tester = net_1.default
            .createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.close(() => resolve(true)))
            .listen(port);
    });
}
async function start() {
    const preferred = config_1.default.port;
    const available = await isPortAvailable(preferred);
    if (!available) {
        logger_1.default.warn(`Port ${preferred} in use, finding an available port`);
    }
    const server = app_1.default.listen(available ? preferred : 0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : preferred;
        logger_1.default.info(`Okuma BC app running at http://localhost:${port}`);
    });
}
start().catch(err => {
    logger_1.default.error('Failed to start server', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map