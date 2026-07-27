
import path from 'path';
import dotenv from 'dotenv';

// APP_ENV selects the env file: dev → .env.dev, qa → .env.qa, unset → .env
const envSuffix = process.env.APP_ENV ? `.${process.env.APP_ENV}` : '';
dotenv.config({ path: path.resolve(__dirname, `../../.env${envSuffix}`) });

interface BcConfig {
    clientId: string | undefined;
    clientSecret: string | undefined;
    accessToken: string | undefined;
    b2bAuthToken: string | undefined;
    storeHash: string | undefined;
    appCallbackUrl: string | undefined;
    apiBaseUrl: string;
    b2bApiBaseUrl: string;
    channelId: number;
}

interface BluesnapConfig {
    apiUsername: string | undefined;
    apiPassword: string | undefined;
    env: string;
}

interface AppConfig {
    port: number;
    trustProxy: boolean;
    sessionSecret: string | undefined;
    bc: BcConfig;
    bluesnap: BluesnapConfig;
    partsBook: {
        cdnBaseUrl: string | undefined;
    };
    rateLimit: {
        windowMs: number;
        max: number;
    };
}

const config: AppConfig = {
    port: parseInt(process.env.PORT || '3000', 10),
    trustProxy: process.env.TRUST_PROXY === 'true',
    sessionSecret: process.env.SESSION_SECRET,
    bc: {
        clientId: process.env.BC_CLIENT_ID,
        clientSecret: process.env.BC_CLIENT_SECRET,
        accessToken: process.env.BC_ACCESS_TOKEN,
        b2bAuthToken: process.env.B2B_AUTH_TOKEN ?? process.env.BC_ACCESS_TOKEN,
        storeHash: process.env.BC_STORE_HASH,
        appCallbackUrl: process.env.BC_APP_CALLBACK_URL,
        apiBaseUrl: `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}`,
        b2bApiBaseUrl: 'https://api-b2b.bigcommerce.com',
        // TODO: confirm the real channel ID per environment via GET /v3/channels — defaults to 1 (BC's default channel)
        channelId: (() => {
            const parsed = parseInt(process.env.BC_CHANNEL_ID || '1', 10);
            return Number.isFinite(parsed) ? parsed : 1;
        })(),
    },
    bluesnap: {
        apiUsername: process.env.BLUESNAP_API_USERNAME,
        apiPassword: process.env.BLUESNAP_API_PASSWORD,
        env:         process.env.BLUESNAP_ENV ?? 'sandbox',
    },
    partsBook: {
        cdnBaseUrl: process.env.PARTS_BOOK_CDN_BASE_URL,
    },
    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
        max: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    },
};

const required = ['BC_ACCESS_TOKEN', 'BC_STORE_HASH', 'SESSION_SECRET', 'PARTS_BOOK_CDN_BASE_URL'];
const missing = required.filter(key => !process.env[key]);
if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

export default config;



