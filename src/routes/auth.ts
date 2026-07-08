import { Router } from 'express';
import axios from 'axios';
import config from '../config';
import logger from '../config/logger';

const router = Router();

router.get('/callback', async (req, res, next) => {
    const { code, scope, context } = req.query;

    if (!code || !context) {
        res.status(400).json({ error: 'Missing required OAuth parameters' });
        return;
    }

    try {
        const { data } = await axios.post<{ context: string }>('https://login.bigcommerce.com/oauth2/token', {
            client_id: config.bc.clientId,
            client_secret: config.bc.clientSecret,
            code,
            scope,
            context,
            grant_type: 'authorization_code',
            redirect_uri: config.bc.appCallbackUrl,
        });

        // TODO: persist data.access_token and data.context (store_hash) to your data store
        logger.info(`OAuth install complete for store: ${data.context}`);
        res.json({ installed: true, context: data.context });
    } catch (err) {
        next(err);
    }
});

export default router;
