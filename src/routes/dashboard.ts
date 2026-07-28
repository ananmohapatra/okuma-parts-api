import { Router, Request, Response } from 'express';
import axios from 'axios';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import { fetchB2BUserByEmail, buildExtraFieldsMap, upsertB2BUserExtraField } from '../services/b2b-user';
import { fetchB2BCompanyById } from '../services/b2b-company';
import {
    B2BCompany,
    B2BCompanyUser,
    fetchB2BCompanyIdByEmail,
    fetchB2BCompaniesByGroupName,
    fetchB2BCompanyUsers,
} from '../services/b2b-hierarchy';
import logger from '../config/logger';

const router = Router();

/** Maps BC order status_id values to their human-readable status labels. */
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
    11: 'Awaiting Fulfillment',
    12: 'Manual Verification Required',
    13: 'Disputed',
    14: 'Partially Refunded',
};

/** TTL in hours for the dealer_customer_ids B2B user extra field cache. */
const CACHE_TTL_HOURS = 24;
/** B2B order extra field name recording which company the order was placed for. */
const ORDER_EXTRA_FIELD_ORDERED_FOR = 'orderedFor';
/** B2B order extra field name recording which dealer company placed the order. */
const ORDER_EXTRA_FIELD_CREATED_BY = 'createdBy';
/** Default BC order status label applied when the caller omits the status field. */
const DEFAULT_PLACE_ORDER_STATUS = 'Pending';
/** Cache TTL for dealer hierarchy resolution, in milliseconds (5 minutes). */
const HIERARCHY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — mirrors dealers.ts's group cache pattern

// BigCommerce OOTB status label -> BC status_id, for orders placed via POST /orders (no payment collected — NET-terms/PO)
/** Maps BigCommerce OOTB order status labels to their corresponding status_id values. */
const ORDER_STATUS_ID_BY_LABEL: Record<string, number> = {
    Pending: 1,
    'Awaiting Fulfillment': 11,
    Shipped: 2,
    Completed: 10,
    Cancelled: 5,
};

/**
 * Run an async fn over items with at most `concurrency` in-flight at once.
 * Mirrors the batchedMap pattern in routes/dealers.ts.
 * @param items - Array of items to process.
 * @param fn - Async function to apply to each item.
 * @param concurrency - Maximum number of concurrent in-flight promises.
 * @returns Promise resolving to an array of results in the same order as items.
 */
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

/** Cached dealer customer ID list stored as a B2B user extra field. */
interface CustomerIdCache {
    ids: number[];
    cachedAt: string;
}

/** A BigCommerce customer group record returned by GET /v2/customer_groups. */
interface BcCustomerGroup {
    id: number;
    name: string;
}

/** Minimal BC customer row needed for group-based customer ID resolution. */
interface BcCustomerRow {
    id: number;
    first_name: string;
    last_name: string;
    company: string;
}

/** A BC order record returned by GET /v2/orders. */
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

/** A single extra field entry on a B2B quote record. */
interface B2BQuoteExtraField {
    fieldName: string;
    fieldValue: string | number;
}

/** A B2B RFQ/quote record returned by GET /api/v3/io/rfq. */
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

/** A B2B company address record used when placing orders. */
interface B2BCompanyAddress {
    firstName: string;
    lastName: string;
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    stateName: string;
    countryName: string;
    countryCode: string;
    zipCode: string;
    isDefaultBilling: boolean;
}

/** A single line item in a place-order request. */
interface PlaceOrderLineItem {
    productId: number;
    quantity: number;
}

/** A single extra field entry on a B2B order record. */
interface B2BOrderExtraField {
    fieldName: string;
    fieldValue: string;
}

/** A B2B order record as returned by GET /api/v3/io/orders/{bcOrderId}. */
interface B2BOrderRecord {
    bcOrderId: number;
    extraFields?: B2BOrderExtraField[];
}

/** The BC order record returned immediately after POST /v2/orders. */
interface BcCreatedOrder {
    id: number;
    date_created: string;
    status_id: number;
    status: string;
    items_total: number;
    total_inc_tax: number;
    currency_code: string;
}

/**
 * Type guard that returns true when value is a positive integer.
 * @param value - Value to check.
 * @returns True if value is a number, integer, and greater than zero.
 */
function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates and normalizes the lineItems array from a place-order request body.
 * Returns null if the array is empty or any entry has a non-positive-integer
 * productId/quantity.
 * @param raw - Unvalidated `lineItems` value from the request body.
 * @returns Normalized `{ productId, quantity }[]`, or null if the input is invalid.
 */
function parseLineItems(raw: unknown): PlaceOrderLineItem[] | null {
    if (!Array.isArray(raw) || raw.length === 0) return null;

    const items: PlaceOrderLineItem[] = [];
    const allValid = raw.every(item => {
        const productId = (item as Record<string, unknown>)?.productId;
        const quantity = (item as Record<string, unknown>)?.quantity;
        if (!isPositiveInteger(productId) || !isPositiveInteger(quantity)) return false;
        items.push({ productId, quantity });
        return true;
    });

    return allValid ? items : null;
}

/**
 * Fetch a B2B company's address book.
 * BC OOTB: GET /api/v3/io/addresses?companyId={companyId}
 * @param companyId - B2B company ID.
 * @returns The company's addresses, or an empty array on failure.
 */
async function fetchB2BCompanyAddresses(companyId: number): Promise<B2BCompanyAddress[]> {
    try {
        const res = await b2bClient.get<{ data: B2BCompanyAddress[] }>('/api/v3/io/addresses', {
            params: { companyId, limit: 250 },
        });
        return res.data?.data ?? [];
    } catch (err) {
        logger.error(`Dashboard: address fetch for company ${companyId} failed: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Turns a B2B order's extraFields array into a plain fieldName -> fieldValue map.
 * @param extraFields - Raw extraFields array from a B2B order record, if any.
 * @returns Flattened key/value map; empty object when there are no extra fields.
 */
function buildOrderExtraFieldsMap(extraFields?: B2BOrderExtraField[]): Record<string, string> {
    const map: Record<string, string> = {};
    (extraFields ?? []).forEach(f => {
        map[f.fieldName] = f.fieldValue;
    });
    return map;
}

/**
 * Registers a B2B order record for a core BigCommerce order.
 * BC does not automatically create this record for orders placed via the plain
 * REST Management `POST /v2/orders` (confirmed empirically in this store), so this
 * must be called explicitly right after order creation. Does not create a second
 * real order — only attaches B2B metadata to the existing BC order.
 * B2B OOTB: POST /api/v3/io/orders
 * @param bcOrderId - BigCommerce order ID to attach a B2B order record to.
 * @param customerId - BC customer ID the order was created under.
 * @returns Nothing — logs and swallows failures rather than throwing.
 */
async function registerB2BOrder(bcOrderId: number, customerId: number): Promise<void> {
    try {
        await b2bClient.post('/api/v3/io/orders', { bcOrderId, customerId });
    } catch (err) {
        logger.warn(`Dashboard: B2B order registration for order ${bcOrderId} failed: ${(err as Error).message}`);
    }
}

/**
 * Sets extra fields on a B2B order record (must already be registered).
 * B2B OOTB: PUT /api/v3/io/orders/{bcOrderId}
 * @param bcOrderId - BigCommerce order ID (must already have a registered B2B order record).
 * @param fields - Extra fields to set, as a plain fieldName -> fieldValue map.
 * @returns Nothing — logs and swallows failures rather than throwing.
 */
async function setB2BOrderExtraFields(bcOrderId: number, fields: Record<string, string>): Promise<void> {
    try {
        const extraFields = Object.entries(fields).map(([fieldName, fieldValue]) => ({ fieldName, fieldValue }));
        await b2bClient.put(`/api/v3/io/orders/${bcOrderId}`, { extraFields });
    } catch (err) {
        logger.warn(`Dashboard: B2B order extraFields write for order ${bcOrderId} failed: ${(err as Error).message}`);
    }
}

// Cache keyed by BC order ID — an order's own createdBy/orderedFor never change once
// set (or never get set at all, for a self-service order), so this never goes stale.
// Cuts the dominant cost of GET /recent-orders: re-checking the same orders' B2B
// attribution on every single page load.
const MAX_CACHE_SIZE = 5000; // shared cap for all in-memory dashboard caches below

/**
 * Sets a key on a size-capped Map, evicting the oldest entry first (FIFO — Map
 * preserves insertion order) once the map is already at its limit. Keeps the
 * long-lived in-memory caches in this file bounded in a long-running process
 * without a full LRU/TTL implementation.
 * @param map - Cache to write into.
 * @param key - Key to set.
 * @param value - Value to store.
 * @param maxSize - Maximum entries to retain before evicting the oldest (defaults to MAX_CACHE_SIZE).
 * @returns Nothing — mutates `map` in place.
 */
function setWithLimit<K, V>(map: Map<K, V>, key: K, value: V, maxSize = MAX_CACHE_SIZE): void {
    if (map.size >= maxSize) {
        const oldestKey = map.keys().next().value;
        if (oldestKey !== undefined) map.delete(oldestKey);
    }
    map.set(key, value);
}

/** Per-order attribution cache: maps BC order ID → B2B extra fields map. Never invalidated (attribution is immutable). */
const orderAttributionCache = new Map<number, Record<string, string>>();

/**
 * Fetch a single B2B order's extra fields.
 *
 * The bulk `GET /api/v3/io/orders?companyId=` list does NOT include extraFields
 * (confirmed empirically — no query parameter unlocks it), so attribution has to
 * be read per order via the single-order endpoint instead.
 *
 * A 404 here is an expected, normal case — it means this order was never placed
 * through POST /orders (e.g. a company's own self-service order), not an error.
 * B2B OOTB: GET /api/v3/io/orders/{bcOrderId}
 * @param bcOrderId - BigCommerce order ID to look up.
 * @returns Map of extra field name to value; empty object if the order has no B2B record.
 */
async function fetchB2BOrderExtraFields(bcOrderId: number): Promise<Record<string, string>> {
    const cached = orderAttributionCache.get(bcOrderId);
    if (cached) return cached;

    try {
        const res = await b2bClient.get<{ data: B2BOrderRecord }>(`/api/v3/io/orders/${bcOrderId}`);
        const fields = buildOrderExtraFieldsMap(res.data?.data?.extraFields);
        setWithLimit(orderAttributionCache, bcOrderId, fields);
        return fields;
    } catch (err) {
        // A 404 means this order was never registered with B2B (e.g. a self-service
        // order) — that will never change, so it's safe to cache permanently. Any
        // other error (timeout, 5xx, rate limit) is transient — don't cache it, so
        // the next request retries instead of permanently hiding an attributed order.
        if (axios.isAxiosError(err) && err.response?.status === 404) {
            setWithLimit(orderAttributionCache, bcOrderId, {});
        } else {
            logger.warn(
                `Dashboard: B2B order attribution fetch for order ${bcOrderId} failed: ${(err as Error).message}`
            );
        }
        return {};
    }
}

/** Cached result of resolving a dealer's B2B company and its subsidiary companies. */
interface DealerHierarchy {
    dealerCompanyId: number;
    dealerCompanyName: string;
    subsidiaries: B2BCompany[];
    cachedAt: number;
}

/** In-memory hierarchy cache: maps dealer BC customer ID → their resolved DealerHierarchy. */
const dealerHierarchyCache = new Map<number, DealerHierarchy>();

/**
 * Resolves (and caches, 5 min TTL) a dealer's own B2B company, its name, and its
 * companies — shared by POST /orders and GET /recent-orders so neither has to
 * re-walk the full company list on every request for the same dealer.
 *
 * Companies are matched by `bcGroupName === dealer's own company name`, not by
 * B2B's `parentCompany` link — confirmed against real data that `parentCompany`
 * only covers a small fraction of a dealer's actual client companies in this
 * store, while bcGroupName correctly reflects all of them.
 * @param dealerId - BC customer ID of the dealer.
 * @param dealerEmail - Dealer's BC email, used to resolve their B2B company.
 * @returns The dealer's own company plus its subsidiaries, or null if no B2B company/name resolves.
 */
async function resolveDealerHierarchy(dealerId: number, dealerEmail: string): Promise<DealerHierarchy | null> {
    const cached = dealerHierarchyCache.get(dealerId);
    if (cached && Date.now() - cached.cachedAt < HIERARCHY_CACHE_TTL_MS) {
        return cached;
    }

    const dealerCompanyId = await fetchB2BCompanyIdByEmail(dealerEmail);
    if (!dealerCompanyId) return null;

    const dealerCompany = await fetchB2BCompanyById(dealerCompanyId);

    // Treat a missing company name as a resolution failure, not a silent empty
    // string — an empty createdBy would get written on POST /orders and would
    // never match anything on GET /recent-orders, hiding orders without any error.
    if (!dealerCompany?.companyName) {
        logger.warn(`Dashboard: failed to resolve dealer company name for companyId=${dealerCompanyId}`);
        return null;
    }

    const subsidiaries = await fetchB2BCompaniesByGroupName(dealerCompany.companyName);

    const resolved: DealerHierarchy = {
        dealerCompanyId,
        dealerCompanyName: dealerCompany.companyName,
        subsidiaries,
        cachedAt: Date.now(),
    };
    setWithLimit(dealerHierarchyCache, dealerId, resolved);
    return resolved;
}

/** Cached B2B company user list with a timestamp for TTL checks. */
interface CachedCompanyUsers {
    users: B2BCompanyUser[];
    cachedAt: number;
}

/** In-memory company users cache: maps B2B company ID → their users and fetch timestamp. */
const companyUsersCache = new Map<number, CachedCompanyUsers>();

/**
 * Cached wrapper (5 min TTL, same as the hierarchy cache) around fetchB2BCompanyUsers —
 * GET /recent-orders calls this once per subsidiary on every page load; company
 * membership doesn't change minute-to-minute, so this is a large repeat-call saving.
 * @param companyId - B2B company ID.
 * @returns The company's B2B users (cached for up to 5 minutes).
 */
async function fetchB2BCompanyUsersCached(companyId: number): Promise<B2BCompanyUser[]> {
    const cached = companyUsersCache.get(companyId);
    if (cached && Date.now() - cached.cachedAt < HIERARCHY_CACHE_TTL_MS) {
        return cached.users;
    }
    const users = await fetchB2BCompanyUsers(companyId);
    setWithLimit(companyUsersCache, companyId, { users, cachedAt: Date.now() });
    return users;
}

/**
 * Resolves every BC customer ID belonging to a dealer's own customer group,
 * caching the result on the dealer's B2B user extra field (`dealer_customer_ids`)
 * for up to CACHE_TTL_HOURS so GET /quotes doesn't re-walk the customer group on
 * every request.
 * @param dealerId - BC customer ID of the dealer.
 * @returns All customer IDs in the dealer's own group, including the dealer's own ID.
 */
async function getDealerCustomerIds(dealerId: number): Promise<number[]> {
    // Step 1 — resolve dealer email from BC
    const customerRes = await bcClient.get('/v3/customers', { params: { 'id:in': dealerId } });
    const dealer = customerRes.data.data?.[0];
    if (!dealer) throw new Error(`Dealer customer ${dealerId} not found`);

    // Step 2 — fetch B2B user to check the dealer_customer_ids extra field cache
    const b2bUser = await fetchB2BUserByEmail(dealer.email);
    const extraFieldsMap = buildExtraFieldsMap(b2bUser?.extraFields);

    if (extraFieldsMap.dealer_customer_ids) {
        // Fix #2: guard against malformed extra field values — treat as cache miss
        try {
            const parsed: CustomerIdCache = JSON.parse(extraFieldsMap.dealer_customer_ids);
            const ageHours = (Date.now() - new Date(parsed.cachedAt).getTime()) / (1000 * 60 * 60);
            if (ageHours < CACHE_TTL_HOURS) {
                logger.info(`Dashboard: using cached customer IDs for dealer ${dealerId}`);
                return parsed.ids;
            }
        } catch {
            logger.warn(`Dashboard: malformed extra field cache for dealer ${dealerId}, re-resolving`);
        }
    }

    logger.info(`Dashboard: resolving customer IDs for dealer ${dealerId}`);

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

    // Persist the resolved IDs as a B2B user extra field for caching
    if (b2bUser) {
        const cacheValue = JSON.stringify({ ids: customerIds, cachedAt: new Date().toISOString() } as CustomerIdCache);
        await upsertB2BUserExtraField(b2bUser, 'dealer_customer_ids', cacheValue);
    }

    return customerIds;
}

/**
 * GET /recent-orders
 *
 * Returns a dealer's recent orders plus total/open counts, scoped to orders the
 * dealer actually placed — his own, or ones he placed for a company via POST
 * /orders — not every order under his company hierarchy. That distinction lives
 * on each order's own B2B `createdBy` extra field (written by POST /orders), not
 * on the order's customer_id, since BigCommerce has no native concept of "who
 * placed this order" separate from whose account it belongs to.
 *
 * Scoped by dealer company, not by the individual querying customerId: if a
 * dealer company has more than one Admin (e.g. two co-admins), any of them can
 * query with their own customerId and get the same company-wide result set,
 * including self-placed orders from the *other* admin.
 *
 * Query: ?customerId=248&limit=3 (limit defaults to 3, capped at 50)
 *
 * Response:
 * {
 *   summary: { totalOrderCount, openOrderCount },
 *   data: [{ orderId, orderNumber, date, orderedFor, createdBy, itemsTotal, total, currency, statusId, status, customerId }]
 * }
 */
router.get('/recent-orders', async (req: Request, res: Response) => {
    try {
        const dealerId = Number(req.query.customerId);
        // Fix #6: clamp limit to a safe range
        const limitRaw = Number(req.query.limit);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 3;

        if (!dealerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        // -- 1. Dealer record + B2B company --
        const dealerRes = await bcClient.get('/v3/customers', { params: { 'id:in': dealerId } });
        const dealerRecord = dealerRes.data?.data?.[0];
        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        const hierarchy = await resolveDealerHierarchy(dealerId, dealerRecord.email);
        if (!hierarchy) {
            return res.json({ summary: { totalOrderCount: 0, openOrderCount: 0 }, data: [] });
        }
        const { dealerCompanyId, dealerCompanyName, subsidiaries } = hierarchy;

        // -- 2. Resolve every individual customer ID across the hierarchy — including the
        // dealer's OWN company's other users (e.g. a co-admin), not just subsidiaries, so
        // one admin's self-placed order is visible to another admin of the same company --
        const usersPerCompany = await batchedMap(
            [dealerCompanyId, ...subsidiaries.map(sub => sub.companyId)],
            companyId => fetchB2BCompanyUsersCached(companyId),
            5
        );
        const seenCustomerIds = new Set<number>([dealerId]);
        const customerIds: number[] = [dealerId];
        usersPerCompany.forEach(users => {
            users.forEach(u => {
                if (u.customerId > 0 && !seenCustomerIds.has(u.customerId)) {
                    seenCustomerIds.add(u.customerId);
                    customerIds.push(u.customerId);
                }
            });
        });

        // -- 3. Fetch core order details for every customer in the hierarchy --
        // Fix #4: batch order fetches at 10 concurrent to avoid BC rate limiting
        // Fix #5: fetch 250 orders per customer so counts reflect actual totals
        const orderResults = await batchedMap(
            customerIds,
            id =>
                bcClient
                    .get(`/v2/orders?customer_id=${id}&sort=date_created:desc&limit=250&is_deleted=false`)
                    .then(r => (Array.isArray(r.data) ? r.data : []))
                    .catch(() => []),
            10
        );
        const candidateOrders = (orderResults.flat().filter(Boolean) as BcOrder[]).filter(o => !o.is_deleted);

        // -- 4. Read each candidate order's own attribution — the bulk B2B orders-by-company
        // list does NOT include extraFields (confirmed empirically), so this has to be
        // read per order via the single-order endpoint --
        const attributionResults = await batchedMap(
            candidateOrders,
            async o => ({ orderId: o.id, fields: await fetchB2BOrderExtraFields(o.id) }),
            10
        );
        const attributionByOrderId = new Map<number, Record<string, string>>();
        attributionResults.forEach(({ orderId, fields }) => attributionByOrderId.set(orderId, fields));

        const allOrders = candidateOrders.filter(
            o => attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_CREATED_BY] === dealerCompanyName
        );

        allOrders.sort((a, b) => new Date(b.date_created).getTime() - new Date(a.date_created).getTime());

        const totalOrderCount = allOrders.length;
        const openOrderCount = allOrders.filter(o => o.status_id === 1).length;

        const recentOrders = allOrders.slice(0, limit).map(o => ({
            orderId: o.id,
            orderNumber: String(o.id),
            date: o.date_created,
            orderedFor:
                attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_ORDERED_FOR] ??
                (o.customer_id === dealerId ? 'Self' : 'Customer'),
            createdBy: attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_CREATED_BY] ?? dealerCompanyName,
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

/**
 * POST /orders
 *
 * Lets a dealer place a no-payment BC order for themself (companyId === their own
 * B2B companyId) or on behalf of one of their subsidiary companies. BigCommerce
 * orders can only attach to one BC customer_id, so for a subsidiary the order is
 * created under that company's Admin user (first one found), using the company's
 * default billing address. BigCommerce has no native "placed by" field on an
 * order, so who really placed it is recorded on the order's own B2B extra fields
 * (`orderedFor`, `createdBy`) — visible in the B2B admin panel and read back by
 * GET /recent-orders to scope results.
 *
 * Body: { customerId: number, companyId: number, lineItems: [{ productId, quantity }], status?: string }
 *
 * `customerId` is the dealer's own BC customer ID — named to match the customerId
 * convention already used by GET /recent-orders and GET /quotes. `status` is one
 * of BigCommerce's OOTB status labels — Pending, Awaiting Fulfillment, Shipped,
 * Completed, Cancelled — mapped to the corresponding BC status_id. Defaults to
 * "Pending" when omitted.
 *
 * Response: { orderId, orderNumber, date, orderedFor, createdBy, itemsTotal, total, currency, statusId, status, companyId }
 */
router.post('/orders', async (req: Request, res: Response) => {
    try {
        const {
            customerId: dealerId,
            companyId,
            lineItems: rawLineItems,
            status: rawStatus,
        } = req.body as {
            customerId?: unknown;
            companyId?: unknown;
            lineItems?: unknown;
            status?: unknown;
        };

        if (!isPositiveInteger(dealerId)) {
            return res.status(400).json({ error: 'customerId must be a positive integer.' });
        }
        if (!isPositiveInteger(companyId)) {
            return res.status(400).json({ error: 'companyId must be a positive integer.' });
        }
        const lineItems = parseLineItems(rawLineItems);
        if (!lineItems) {
            return res
                .status(400)
                .json({ error: 'lineItems must be a non-empty array of { productId, quantity } positive integers.' });
        }

        const statusLabel = rawStatus === undefined ? DEFAULT_PLACE_ORDER_STATUS : rawStatus;
        if (
            typeof statusLabel !== 'string' ||
            !Object.prototype.hasOwnProperty.call(ORDER_STATUS_ID_BY_LABEL, statusLabel)
        ) {
            return res.status(400).json({
                error: `status must be one of: ${Object.keys(ORDER_STATUS_ID_BY_LABEL).join(', ')}.`,
            });
        }
        const statusId = ORDER_STATUS_ID_BY_LABEL[statusLabel];

        // -- 1. Dealer record (needed for email — the B2B API keys on email, not customer_id) --
        const dealerRes = await bcClient.get('/v3/customers', { params: { 'id:in': dealerId } });
        const dealerRecord = dealerRes.data?.data?.[0];
        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        // -- 2. Authorize: companyId must be the dealer's own company or a direct subsidiary --
        const hierarchy = await resolveDealerHierarchy(dealerId, dealerRecord.email);
        if (!hierarchy) {
            return res.status(404).json({ error: 'Dealer has no associated B2B company.' });
        }
        const { dealerCompanyId, dealerCompanyName, subsidiaries } = hierarchy;

        const isSelf = companyId === dealerCompanyId;
        let companyName = 'Self';

        if (!isSelf) {
            const targetCompany = subsidiaries.find(c => c.companyId === companyId);
            if (!targetCompany) {
                return res.status(403).json({ error: 'This company does not belong to the dealer.' });
            }
            companyName = targetCompany.companyName;
        }

        // -- 3. Resolve the BC customer_id the order attaches to --
        let targetCustomerId: number;
        let targetEmail: string;

        if (isSelf) {
            targetCustomerId = dealerId;
            targetEmail = dealerRecord.email;
        } else {
            const companyUsers = await fetchB2BCompanyUsers(companyId);
            const admin = companyUsers.find(u => u.companyRoleName === 'Admin');
            if (!admin) {
                return res.status(400).json({ error: `No admin user found for ${companyName}.` });
            }
            if (!isPositiveInteger(admin.customerId) || typeof admin.email !== 'string' || !admin.email) {
                return res
                    .status(400)
                    .json({ error: `Admin user for ${companyName} is missing a valid customerId/email.` });
            }
            targetCustomerId = admin.customerId;
            targetEmail = admin.email;
        }

        // -- 4. Resolve the company's default billing address --
        const addresses = await fetchB2BCompanyAddresses(companyId);
        const defaultAddress = addresses.find(a => a.isDefaultBilling);
        if (!defaultAddress) {
            return res.status(400).json({ error: `${companyName} has no billing address on file.` });
        }

        const billingAddress = {
            first_name: defaultAddress.firstName,
            last_name: defaultAddress.lastName,
            street_1: defaultAddress.addressLine1,
            street_2: defaultAddress.addressLine2 || undefined,
            city: defaultAddress.city,
            state: defaultAddress.stateName,
            zip: defaultAddress.zipCode,
            country: defaultAddress.countryName,
            country_iso2: defaultAddress.countryCode,
            email: targetEmail,
        };

        // -- 5. Create the order directly — no cart/checkout, no payment collected --
        const orderRes = await bcClient.post<BcCreatedOrder>('/v2/orders', {
            customer_id: targetCustomerId,
            billing_address: billingAddress,
            status_id: statusId,
            products: lineItems.map(li => ({ product_id: li.productId, quantity: li.quantity })),
        });
        const order = orderRes.data;

        // -- 6. Record who really placed it, directly on the order — visible in the B2B admin panel --
        await registerB2BOrder(order.id, targetCustomerId);
        await setB2BOrderExtraFields(order.id, {
            [ORDER_EXTRA_FIELD_ORDERED_FOR]: isSelf ? 'Self' : companyName,
            [ORDER_EXTRA_FIELD_CREATED_BY]: dealerCompanyName,
        });

        // -- 7. Respond --
        res.status(201).json({
            orderId: order.id,
            orderNumber: String(order.id),
            date: order.date_created,
            orderedFor: isSelf ? 'Self' : companyName,
            createdBy: dealerCompanyName,
            itemsTotal: order.items_total ?? lineItems.length,
            total: order.total_inc_tax,
            currency: order.currency_code,
            statusId: order.status_id,
            status: STATUS_MAP[order.status_id] ?? order.status,
            companyId,
        });
    } catch (err) {
        logger.error(`Dashboard place-order error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to place order.' });
    }
});

/**
 * GET /quotes
 *
 * Returns open B2B RFQ/quotes scoped to a dealer's own customer group, plus an
 * open-quote count. A quote is attributed to the dealer via its `Customer
 * Account ID` extra field matching one of the dealer's group's customer IDs.
 *
 * Query: ?customerId=248&limit=10 (limit defaults to 10, capped at 50)
 *
 * Response:
 * {
 *   summary: { openQuoteCount },
 *   data: [{ quoteId, quoteNumber, quoteTitle, date, expiresAt, createdBy, companyName, subtotal, grandTotal, currency, status, bcOrderId }]
 * }
 */
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
