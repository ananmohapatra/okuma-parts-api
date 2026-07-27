
import { Router, Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import logger from '../config/logger';
import config from '../config';
import bcClient from '../services/bigcommerce';

const router = Router();

function bluesnapBase(): string {
    return config.bluesnap.env === 'production'
        ? 'https://ws.bluesnap.com'
        : 'https://sandbox.bluesnap.com';
}

function bluesnapAuthHeader(): string {
    const credentials = Buffer.from(
        `${config.bluesnap.apiUsername}:${config.bluesnap.apiPassword}`
    ).toString('base64');
    return `Basic ${credentials}`;
}

interface BluesnapErrorEntry {
    errorName?: string;
    code?: string;
    description?: string;
}

interface BluesnapErrorBody {
    message?: BluesnapErrorEntry[] | string;
    description?: string;
}

function bluesnapErrorMessage(err: unknown): string {
    const axErr = err as AxiosError<BluesnapErrorBody>;
    const data  = axErr.response?.data;
    if (Array.isArray(data?.message) && data.message.length > 0) {
        const entry = data.message[0];
        return `${entry.errorName ?? 'UNKNOWN'} (code ${entry.code ?? '?'}): ${entry.description ?? ''}`.trim();
    }
    if (typeof data?.message === 'string') return data.message;
    if (typeof data?.description === 'string') return data.description;
    return (err as Error).message ?? 'BlueSnap error';
}

function bluesnapDebugDetail(err: unknown): object {
    const axErr = err as AxiosError<BluesnapErrorBody>;
    return {
        bsStatus: axErr.response?.status,
        bsBody:   axErr.response?.data ?? null,
    };
}

/**
 * GET /payments/bluesnap/hpf-token
 *
 * Issues a BlueSnap Hosted Payment Fields token (pfToken) so the browser can
 * initialise the card input iframes. BlueSnap returns the token inside the
 * Location response header.
 *
 * Response: { pfToken: string }
 */
router.get('/bluesnap/hpf-token', async (_req: Request, res: Response) => {
    const { apiUsername, apiPassword } = config.bluesnap;
    if (!apiUsername || !apiPassword) {
        logger.warn('bluesnap hpf-token: BLUESNAP_API_USERNAME or BLUESNAP_API_PASSWORD not set');
        return res.status(503).json({ error: 'Payment service not configured' });
    }
    logger.debug(`bluesnap hpf-token: using user=${apiUsername.slice(0, 8)}…`);

    try {
        const response = await axios.post(
            `${bluesnapBase()}/services/2/payment-fields-tokens`,
            null,
            {
                headers: {
                    Authorization:  bluesnapAuthHeader(),
                    'Content-Type': 'application/json',
                },
                validateStatus: status => status >= 200 && status < 300,
            }
        );

        const location = (response.headers['location'] as string) ?? '';
        const pfToken  = location.split('/').pop() ?? '';

        if (!pfToken) {
            logger.error('bluesnap hpf-token: Location header missing or empty', { location });
            return res.status(502).json({ error: 'BlueSnap did not return a pfToken' });
        }

        logger.info('bluesnap hpf-token: issued successfully');
        return res.json({ pfToken });
    } catch (err) {
        const axErr = err as AxiosError;
        const bsStatus = axErr.response?.status;
        const bsBody   = axErr.response?.data;
        logger.error(`bluesnap hpf-token failed (BS HTTP ${bsStatus}): ${JSON.stringify(bsBody)}`);
        return res.status(502).json({ error: 'Failed to create payment fields token' });
    }
});

interface ChargeBody {
    pfToken?: unknown;
    amount?: unknown;
    currency?: unknown;
    cardHolderName?: unknown;
}

/**
 * POST /payments/bluesnap/charge
 *
 * Processes a payment using the pfToken returned by the BlueSnap HPF SDK after
 * the user submits their card. Raw card data never reaches this server.
 *
 * Body: { pfToken: string, amount: number, currency: string, cardHolderName?: string }
 * Response: { success: true }
 */
router.post('/bluesnap/charge', async (req: Request, res: Response) => {
    const { pfToken, amount, currency, cardHolderName } = req.body as ChargeBody;

    if (typeof pfToken !== 'string' || !pfToken.trim()) {
        return res.status(400).json({ error: 'pfToken is required' });
    }
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (typeof currency !== 'string' || currency.length !== 3) {
        return res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
    }

    const holderParts = typeof cardHolderName === 'string' ? cardHolderName.trim().split(' ') : [];
    const holderFirst = holderParts[0] ?? '';
    const holderLast  = holderParts.slice(1).join(' ') ?? '';

    try {
        await axios.post(
            `${bluesnapBase()}/services/2/transactions`,
            {
                amount,
                currency,
                paymentSources: {
                    creditCardInfo: [{
                        pfToken: pfToken.trim(),
                    }],
                },
                cardHolderInfo: {
                    firstName: holderFirst,
                    lastName:  holderLast,
                },
                transactionType: 'AUTH_CAPTURE',
            },
            {
                headers: {
                    Authorization:  bluesnapAuthHeader(),
                    'Content-Type': 'application/json',
                    Accept:         'application/json',
                },
            }
        );

        logger.info(`bluesnap charge: success (amount=${amount} ${currency})`);
        return res.json({ success: true });
    } catch (err) {
        const msg    = bluesnapErrorMessage(err);
        const detail = bluesnapDebugDetail(err);
        const status = (err as AxiosError).response?.status ?? 502;
        logger.error(`bluesnap charge failed (amount=${amount}): ${msg}`, detail);

        const httpStatus = status === 402 ? 402 : 502;
        return res.status(httpStatus).json({
            error:  'Payment could not be processed',
            detail: msg,
        });
    }
});

interface BcTokenBody {
    amount?: unknown;
    currency?: unknown;
    cardHolderName?: unknown;
    customerId?: unknown;
    email?: unknown;
}

interface BcPaymentMethod {
    id: string;
    supported_instruments: Array<{ type: string }>;
}

/**
 * POST /payments/bc/token
 *
 * Creates a BC order from the checkout total, obtains a payment access token,
 * and resolves the first available card payment method. The browser then posts
 * card data directly to payments.bigcommerce.com — card data never reaches
 * this server.
 *
 * Body:   { amount: number, currency: string, cardHolderName?: string }
 * Response: { token, orderId, storeHash, paymentMethodId }
 */
router.post('/bc/token', async (req: Request, res: Response) => {
    const { amount, currency = 'USD', cardHolderName = 'Guest User', customerId, email } = req.body as BcTokenBody;

    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (typeof currency !== 'string' || currency.length !== 3) {
        return res.status(400).json({ error: 'currency must be a 3-letter ISO code' });
    }

    const nameParts = typeof cardHolderName === 'string' ? cardHolderName.trim().split(' ') : ['Guest'];
    const firstName = nameParts[0] || 'Guest';
    const lastName  = nameParts.slice(1).join(' ') || '';

    let bcCustomerId = 0;
    if (typeof customerId === 'number' && customerId > 0) {
        bcCustomerId = customerId;
    } else if (typeof customerId === 'string') {
        const parsed = parseInt(customerId, 10);
        if (parsed > 0) bcCustomerId = parsed;
    }

    const orderEmail = typeof email === 'string' && email.includes('@') ? email : 'guest@example.com';

    try {
        // Step 1 — Create a BC order
        const orderRes = await bcClient.post<{ id: number }>('/v2/orders', {
            status_id:   0,
            customer_id: bcCustomerId,
            billing_address: {
                first_name:   firstName,
                last_name:    lastName,
                email:        orderEmail,
                street_1:     '123 Demo Street',
                city:         'Charlotte',
                state:        'NC',
                zip:          '28278',
                country:      'United States',
                country_iso2: 'US',
            },
            products: [{
                name:          'Okuma Parts Order',
                quantity:      1,
                price_inc_tax: amount,
                price_ex_tax:  amount,
                weight:        0.1,
            }],
        });
        const orderId = orderRes.data.id;
        logger.info(`bc-token: order ${orderId} created`);

        // Step 2 — Get payment access token
        const patRes = await bcClient.post<{ data: { id: string } }>('/v3/payments/access_tokens', {
            order: { id: orderId },
        });
        const token = patRes.data.data.id;

        // Step 3 — Resolve first available payment method
        let paymentMethodId = '';
        try {
            const methodsRes = await bcClient.get<{ data: BcPaymentMethod[] }>(
                `/v3/payments/methods?order_id=${orderId}`
            );
            const methods = methodsRes.data.data;
            logger.info(`bc-token: available payment methods: ${JSON.stringify(methods.map(m => ({ id: m.id, instruments: m.supported_instruments })))}`);
            // Prefer a card-instrument method; fall back to the first available method
            const cardMethod = methods.find(m =>
                m.supported_instruments?.some(i => /card/i.test(i.type))
            ) ?? methods[0];
            if (cardMethod) paymentMethodId = cardMethod.id;
        } catch (methodsErr) {
            const axMethodsErr = methodsErr as AxiosError;
            logger.warn(`bc-token: payment methods fetch failed (BC HTTP ${axMethodsErr.response?.status}): ${JSON.stringify(axMethodsErr.response?.data ?? (methodsErr as Error).message)}`);
        }

        if (!paymentMethodId) {
            logger.error(`bc-token: no payment method resolved for order ${orderId}`);
            return res.status(502).json({ error: 'No payment method available for this order' });
        }

        logger.info(`bc-token: PAT issued for order ${orderId} (method=${paymentMethodId})`);
        return res.json({
            token,
            orderId,
            storeHash:       config.bc.storeHash,
            paymentMethodId,
        });

    } catch (err) {
        const axErr = err as AxiosError;
        const bsStatus = axErr.response?.status;
        const bsBody   = JSON.stringify(axErr.response?.data ?? {});
        logger.error(`bc-token failed (BC HTTP ${bsStatus}): ${bsBody}`);
        return res.status(502).json({ error: 'Could not initialise payment' });
    }
});

export default router;



