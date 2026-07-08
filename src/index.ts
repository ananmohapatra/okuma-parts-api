import net from 'net';
import app from './app';
import config from './config';
import logger from './config/logger';

function isPortAvailable(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const tester = net
            .createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.close(() => resolve(true)))
            .listen(port);
    });
}

async function start(): Promise<void> {
    const preferred = config.port;
    const available = await isPortAvailable(preferred);

    if (!available) {
        logger.warn(`Port ${preferred} in use, finding an available port`);
    }

    const server = app.listen(available ? preferred : 0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : preferred;
        logger.info(`Okuma BC app running at http://localhost:${port}`);
    });
}

start().catch(err => {
    logger.error('Failed to start server', err);
    process.exit(1);
});
