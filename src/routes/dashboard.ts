import { Router, Request, Response } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import logger from '../config/logger';

const router = Router();

const STATUS_MAP: Record<number, string> = {
    1: 'Pending',
    2: 'Shipped',
    3: 'Partially Shipped',
    4: 'Refunded',
    5: 'Cancelled',
    6: 'Declined',
    7: 'Awaiting Payment',
    8: 'Awaiting Pickup',
    9: 'Awaiting Shipment',
    10: 'Completed',
    11: 'Processing',
    12: 'Manual Verification Required',
    13: 'Disputed',
    14: 'Partially Refunded',
};

const METAFIELD_NAMESPACE = 'okuma';
const METAFIELD_KEY = 'dealer_customer_ids';
const CACHE_TTL_HOURS = 24;

// Fix #4: concurrency-limited map — mirrors the batchedMap pattern in routes/dealers.ts
async function batchedMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    async function worker(): Promise<void> {
        while (index < items.length) {
            const i = index;
            index += 1;
            // eslint-disable-next-line no-await-in-loop
            results[i] = await fn(items[i]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

interface MetafieldCache {
    ids: number[];
    cachedAt: string;
}

interface BcCustomerGroup {
    id: number;
    name: string;
}

interface BcCustomerRow {
    id: number;
    first_name: string;
    last_name: string;
    company: string;
}

interface BcOrder {
    id: number;
    customer_id: number;
    date_created: string;
    status_id: number;
    status: string;
    items_total: number;
    total_inc_tax: number;
    currency_code: string;
    is_deleted: boolean;
}

interface B2BQuoteExtraField {
    fieldName: string;
    fieldValue: string | number;
}

interface B2BQuote {
    quoteId: number;
    quoteNumber: string;
    quoteTitle: string;
    createdAt: number | null;
    expiredAt: number | null;
    createdBy: string;
    company: string | null;
    subtotal: number;
    grandTotal: number | null;
    currency: { currencyCode: string } | null;
    status: number;
    bcOrderId: string | null;
    extraFields: B2BQuoteExtraField[];
}

async function getDealerCustomerIds(dealerId: number): Promise<number[]> {
    const metaRes = await bcClient.get(
        `/v3/customers/${dealerId}/metafields?namespace=${METAFIELD_NAMESPACE}&key=${METAFIELD_KEY}`
    );
    const existing = metaRes.data.data?.[0];

    if (existing) {
        // Fix #2: guard against malformed metafield values — treat as cache miss
        try {
            const parsed: MetafieldCache = JSON.parse(existing.value);
            const ageHours = (Date.now() - new Date(parsed.cachedAt).getTime()) / (1000 * 60 * 60);
            if (ageHours < CACHE_TTL_HOURS) {
                logger.info(`Dashboard: using cached customer IDs for dealer ${dealerId}`);
                return parsed.ids;
            }
        } catch {
            logger.warn(`Dashboard: malformed metafield cache for dealer ${dealerId}, re-resolving`);
        }
    }

    logger.info(`Dashboard: resolving customer IDs for dealer ${dealerId}`);

    const customerRes = await bcClient.get(`/v3/customers?id:in=${dealerId}`);
    const dealer = customerRes.data.data?.[0];
    if (!dealer) throw new Error(`Dealer customer ${dealerId} not found`);

    const companyName: string = dealer.company;
    let customerIds: number[] = [dealerId];

    if (companyName) {
        const groupsRes = await bcClient.get('/v2/customer_groups');
        const matchedGroup = (groupsRes.data as BcCustomerGroup[]).find(g => g.name === companyName);

        if (matchedGroup) {
            const custRes = await bcClient.get(`/v3/customers?customer_group_id:in=${matchedGroup.id}&limit=250`);
            const groupIds: number[] = (custRes.data.data as BcCustomerRow[]).map(c => c.id);
            customerIds = [...new Set([...customerIds, ...groupIds])];
        }
    }

    // Fix #3: use read_and_sf_access to match permission_set convention in this codebase
    const metafieldPayload = {
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        value: JSON.stringify({ ids: customerIds, cachedAt: new Date().toISOString() } as MetafieldCache),
        permission_set: 'read_and_sf_access',
    };

    if (existing) {
        await bcClient.put(`/v3/customers/${dealerId}/metafields/${existing.id}`, metafieldPayload);
    } else {
        await bcClient.post(`/v3/customers/${dealerId}/metafields`, metafieldPayload);
    }

    return customerIds;
}

// GET /v1/dashboard/recent-orders?customerId=248&limit=3
router.get('/recent-orders', async (req: Request, res: Response) => {
    try {
        const dealerId = Number(req.query.customerId);
        // Fix #6: clamp limit to a safe range
        const limitRaw = Number(req.query.limit);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 3;

        if (!dealerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const customerIds = await getDealerCustomerIds(dealerId);

        // Fix #4: batch order fetches at 10 concurrent to avoid BC rate limiting
        // Fix #5: fetch 250 orders per customer so counts reflect actual totals
        const [orderResults, customersRes] = await Promise.all([
            batchedMap(
                customerIds,
                id =>
                    bcClient
                        .get(`/v2/orders?customer_id=${id}&sort=date_created:desc&limit=250&is_deleted=false`)
                        .then(r => (Array.isArray(r.data) ? r.data : []))
                        .catch(() => []),
                10
            ),
            bcClient
                .get(`/v3/customers?id:in=${customerIds.join(',')}&limit=250`)
                .catch(() => ({ data: { data: [] } })),
        ]);

        const customerNameMap: Record<number, string> = {};
        ((customersRes.data.data as BcCustomerRow[]) ?? []).forEach(c => {
            customerNameMap[c.id] = c.company || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Customer';
        });

        const allOrders = (orderResults.flat().filter(Boolean) as BcOrder[]).filter(o => !o.is_deleted);
        allOrders.sort((a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime());

        const totalOrderCount = allOrders.length;
        const openOrderCount = allOrders.filter(o => o.status_id === 1).length;

        const recentOrders = allOrders.slice(0, limit).map(o => ({
            orderId: o.id,
            orderNumber: String(o.id),
            date: o.date_created,
            orderedFor: o.customer_id === dealerId ? 'Self' : (customerNameMap[o.customer_id] ?? 'Customer'),
            itemsTotal: o.items_total ?? 0,
            total: o.total_inc_tax,
            currency: o.currency_code,
            statusId: o.status_id,
            status: STATUS_MAP[o.status_id] ?? o.status,
            customerId: o.customer_id,
        }));

        res.json({
            summary: { totalOrderCount, openOrderCount },
            data: recentOrders,
        });
    } catch (err) {
        logger.error(`Dashboard recent-orders error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch recent orders' });
    }
});

// GET /v1/dashboard/quotes?customerId=248&limit=10
router.get('/quotes', async (req: Request, res: Response) => {
    try {
        const dealerId = Number(req.query.customerId);
        // Fix #7: clamp limit to a safe range
        const limitRaw = Number(req.query.limit);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 10;

        if (!dealerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const [customerIds, quotesRes] = await Promise.all([
            getDealerCustomerIds(dealerId),
            b2bClient.get('/api/v3/io/rfq?status=0&limit=250'),
        ]);

        const customerIdSet = new Set(customerIds.map(String));
        const allQuotes: B2BQuote[] = quotesRes.data?.data ?? [];

        const dealerQuotes = allQuotes.filter(q => {
            const field = q.extraFields.find(f => f.fieldName === 'Customer Account ID');
            return field && customerIdSet.has(String(field.fieldValue));
        });

        const openQuoteCount = dealerQuotes.length;
        const data = dealerQuotes.slice(0, limit).map(q => ({
            quoteId: q.quoteId,
            quoteNumber: q.quoteNumber,
            quoteTitle: q.quoteTitle,
            date: q.createdAt ? new Date(q.createdAt * 1000).toISOString() : null,
            expiresAt: q.expiredAt ? new Date(q.expiredAt * 1000).toISOString() : null,
            createdBy: q.createdBy,
            companyName: q.company ?? '',
            subtotal: q.subtotal,
            grandTotal: q.grandTotal ?? q.subtotal,
            currency: q.currency?.currencyCode ?? 'USD',
            status: q.status,
            bcOrderId: q.bcOrderId ?? '',
        }));

        res.json({
            summary: { openQuoteCount },
            data,
        });
    } catch (err) {
        logger.error(`Dashboard quotes error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch quotes' });
    }
});

export default router;
