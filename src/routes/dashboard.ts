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
// Not yet written by any order-placement flow — reserved for the upcoming order-
// placement story (OCI61-96 machine association follow-up). Reading it now is a
// no-op until that story starts writing this key; nothing here needs to change
// once it does.
const ORDER_EXTRA_FIELD_MACHINE_SERIAL = 'machineSerial';
// Same status as ORDER_EXTRA_FIELD_MACHINE_SERIAL above — not yet written by any
// order-placement flow, reserved for the same not-yet-built order-placement
// story. Reading these now defaults to empty strings ('') until that story
// starts writing these keys.
// B2B key confirmed as 'poNumber' (not 'poReference') via live GraphQL schema
// inspection against a real order's extraFields — 'poReference' was a guessed
// name with no backing data before this was checked. Our own response field
// stays named `poReference` (matches the design/FE contract already built
// against); only the underlying B2B key this reads from changed.
const ORDER_EXTRA_FIELD_PO_REFERENCE = 'poNumber';
// Unlike poNumber/machineSerial, this key has NOT been confirmed to exist as a
// real defined B2B field (it never appeared in a live extraFields response) --
// GET /orders/:orderId falls back to the querying dealer's own BC name when
// this is empty, so the field is never actually blank in practice today, even
// though the underlying key itself may not be real yet.
const ORDER_EXTRA_FIELD_PLACED_BY_NAME = 'placedByName';
// Confirmed real B2B order extra fields (live GraphQL schema inspection), not
// yet surfaced by this endpoint until now. No OOTB/native BC equivalent exists
// for any of these four -- unlike paymentMethod (see BcOrderDetail.payment_method)
// or shipping method (see shipping.method below), which do have native fields
// and are intentionally NOT sourced from B2B extra fields even though B2B also
// defines its own versions of them.
const ORDER_EXTRA_FIELD_CARRIER_TYPE = 'carrierType';
const ORDER_EXTRA_FIELD_CARRIER_ACCOUNT_NUMBER = 'carrierAccountNumber';
const ORDER_EXTRA_FIELD_MACHINE_DOWN_CONTACT_NAME = 'machineDownContactName';
const ORDER_EXTRA_FIELD_MACHINE_DOWN_CONTACT_PHONE = 'machineDownContactPhone';
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
 * Runs `fn` over `items` with at most `concurrency` in flight at once, preserving
 * input order in the result array. Mirrors the batchedMap pattern in
 * routes/dealers.ts — used throughout this file to fan out BC/B2B calls across a
 * dealer's hierarchy without tripping BC's rate limits.
 * @param items - Items to process.
 * @param fn - Async function to run for each item.
 * @param concurrency - Maximum number of `fn` calls in flight at once.
 * @returns Results in the same order as `items`.
 */
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

interface BcOrderDetail {
    id: number;
    customer_id: number;
    date_created: string;
    status_id: number;
    status: string;
    // Ex-tax, not inc-tax — costBreakdown must be additive (subtotal + shipping +
    // tax === total), which only holds if subtotal/shipping are tax-exclusive and
    // total_tax is added on top to reach total_inc_tax. Using the inc-tax variants
    // here previously double-counted tax and broke that arithmetic.
    subtotal_ex_tax: number;
    shipping_cost_ex_tax: number;
    total_tax: number;
    total_inc_tax: number;
    currency_code: string;
    // Native BC field, already returned by GET /v2/orders/{id} today — no new
    // API call needed to read it, just not previously captured on this interface.
    payment_method: string;
}

interface BcOrderProduct {
    product_id: number;
    sku: string;
    name: string;
    quantity: number;
    price_inc_tax: number;
    total_inc_tax: number;
}

interface BcOrderShippingAddress {
    first_name: string;
    last_name: string;
    street_1: string;
    street_2: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    shipping_method?: string;
}

interface BcOrderShipment {
    tracking_number?: string;
    tracking_carrier?: string;
    date_created?: string;
    shipping_method?: string;
}

interface DealerOrderSummary {
    orderId: number;
    orderNumber: string;
    date: string;
    orderedFor: string;
    createdBy: string;
    machineSerial: string;
    itemsTotal: number;
    total: number;
    currency: string;
    statusId: number;
    status: string;
    customerId: number;
}

interface OrderSummaryCounts {
    totalOrderCount: number;
    openOrderCount: number;
}

type OrderListSort = 'date_desc' | 'date_asc';

interface OrderListFilters {
    status?: string;
    orderedFor?: string;
    machineSerial?: string;
    search?: string;
    sort: OrderListSort;
    page: number;
    limit: number;
}

/**
 * Type guard for request input that must be a positive integer (customer IDs,
 * product IDs, quantities, etc.) — used throughout this file's inline validation
 * instead of a schema library.
 * @param value - Unvalidated value from a request body/query/param.
 * @returns Whether `value` is a positive integer.
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
 * companies — shared by POST /orders and resolveDealerPlacedOrders (in turn shared
 * by GET /recent-orders and GET /orders) so none of them has to re-walk the full
 * company list on every request for the same dealer.
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
 * resolveDealerPlacedOrders (shared by GET /recent-orders and GET /orders) calls this
 * once per subsidiary on every page load; company membership doesn't change
 * minute-to-minute, so this is a large repeat-call saving.
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
 * Filters, sorts, and paginates an already hierarchy-scoped list of dealer order
 * summaries for GET /orders. Pure/no I/O by design: every BC/B2B call (hierarchy
 * resolution, order fetch, attribution lookup) happens in the route handler first,
 * so this function only has to reason about the in-memory presentation concerns —
 * status/orderedFor/search filtering, sort order, and page slicing — which keeps it
 * trivially unit-testable and reusable if a future endpoint needs the same slicing.
 * @param orders - Dealer-placed order summaries already scoped to the dealer's hierarchy.
 * @param filters - Optional status/orderedFor/search filters, plus required sort/page/limit.
 * @returns The filtered+sorted list's total count and the requested page's slice.
 */
function filterSortPaginateOrders(
    orders: DealerOrderSummary[],
    filters: OrderListFilters
): { data: DealerOrderSummary[]; total: number } {
    let filtered = orders;

    if (filters.status) {
        filtered = filtered.filter(o => o.status === filters.status);
    }
    if (filters.orderedFor) {
        filtered = filtered.filter(o => o.orderedFor === filters.orderedFor);
    }
    if (filters.machineSerial) {
        // No order carries a machineSerial extra field yet (pending a future
        // order-placement story) — this filter always yields zero matches today,
        // exactly like any other not-yet-populated attribute, until that story
        // starts writing this key. No further change needed here once it does.
        filtered = filtered.filter(o => o.machineSerial === filters.machineSerial);
    }
    if (filters.search) {
        const { search } = filters;
        filtered = filtered.filter(o => o.orderNumber.includes(search));
    }

    const sorted = [...filtered].sort((a, b) => {
        const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
        return filters.sort === 'date_asc' ? diff : -diff;
    });

    const offset = (filters.page - 1) * filters.limit;
    return { data: sorted.slice(offset, offset + filters.limit), total: sorted.length };
}

interface DealerPlacedOrdersResolution {
    dealerFound: boolean;
    orders: DealerOrderSummary[];
}

/**
 * Resolves a dealer's B2B hierarchy, fetches every order across it, and scopes
 * the result down to orders the dealer personally placed — for himself, or on
 * behalf of a subsidiary company via POST /orders — never every order under the
 * dealer's company hierarchy at large. That distinction lives on each order's own
 * B2B `createdBy` extra field (written by POST /orders), not on the order's
 * customer_id, since BigCommerce has no native concept of "who placed this order"
 * separate from whose account it belongs to.
 *
 * This is the single implementation of that resolution, shared by GET /orders and
 * GET /recent-orders — the two routes differ only in what they do with the result
 * (real filter/sort/pagination vs. a flat top-N slice), not in how the underlying
 * list is produced. No filtering, sorting, or pagination happens here; callers get
 * back the dealer's complete placed-order set and decide their own presentation.
 * @param dealerId - BC customer ID of the dealer.
 * @returns `{ dealerFound: false, orders: [] }` when no BC customer matches
 *   dealerId (callers should respond 404); otherwise `{ dealerFound: true, orders }`
 *   where `orders` is empty when the dealer has no resolvable B2B company/hierarchy,
 *   or the dealer's full set of placed order summaries otherwise.
 */
async function resolveDealerPlacedOrders(dealerId: number): Promise<DealerPlacedOrdersResolution> {
    // -- 1. Dealer record + B2B company --
    const dealerRes = await bcClient.get('/v3/customers', { params: { 'id:in': dealerId } });
    const dealerRecord = dealerRes.data?.data?.[0];
    if (!dealerRecord) {
        return { dealerFound: false, orders: [] };
    }

    const hierarchy = await resolveDealerHierarchy(dealerId, dealerRecord.email);
    if (!hierarchy) {
        return { dealerFound: true, orders: [] };
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

    const dealerPlacedOrders = candidateOrders.filter(
        o => attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_CREATED_BY] === dealerCompanyName
    );

    // -- 5. Map to the shared response DTO shape --
    const orders: DealerOrderSummary[] = dealerPlacedOrders.map(o => ({
        orderId: o.id,
        orderNumber: String(o.id),
        date: o.date_created,
        orderedFor:
            attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_ORDERED_FOR] ??
            (o.customer_id === dealerId ? 'Self' : 'Customer'),
        createdBy: attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_CREATED_BY] ?? dealerCompanyName,
        // Defaults to '' rather than null — B2B includes this key with an empty
        // string on every order once the field type is defined in B2B admin,
        // rather than omitting it until a value is set, so '' is the real "unset"
        // value here, not null. Kept consistent even for orders predating the
        // field definition, so FE never has to null-check this field.
        machineSerial: attributionByOrderId.get(o.id)?.[ORDER_EXTRA_FIELD_MACHINE_SERIAL] || '',
        itemsTotal: o.items_total ?? 0,
        // BC v2 order monetary fields are commonly serialized as strings (confirmed
        // both in this file's own test fixtures and live Postman testing) -- Number()
        // guards against a string leaking into a field this DTO types as `number`.
        total: Number(o.total_inc_tax),
        currency: o.currency_code,
        statusId: o.status_id,
        status: STATUS_MAP[o.status_id] ?? o.status,
        customerId: o.customer_id,
    }));

    return { dealerFound: true, orders };
}

/**
 * Computes the `summary` counts shared by GET /orders and GET /recent-orders from
 * a dealer's full placed-order set. `openOrderCount` intentionally counts only
 * BC `status_id === 1` (Pending) as "open" — that is the definition already live
 * on GET /recent-orders today; it is narrower than the broader "open statuses"
 * concept described elsewhere, but changing it is a separate, out-of-scope concern.
 * @param orders - The dealer's complete placed-order set (unfiltered).
 * @returns `{ totalOrderCount, openOrderCount }`.
 */
function computeOrderSummary(orders: DealerOrderSummary[]): OrderSummaryCounts {
    return {
        totalOrderCount: orders.length,
        openOrderCount: orders.filter(o => o.statusId === 1).length,
    };
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
 * This route is now a thin wrapper around resolveDealerPlacedOrders — the same
 * hierarchy-resolution/order-fetch/attribution-scoping logic GET /orders uses —
 * reproducing its historical flat top-N response shape (no pagination object, no
 * status/orderedFor/machineSerial/search/sort params). Kept only for backward
 * compatibility with the existing Dashboard widget (separate Stencil theme repo)
 * until the frontend team migrates it to call GET /orders directly, at which
 * point this route can be deleted.
 *
 * Scoped by dealer company, not by the individual querying customerId: if a
 * dealer company has more than one Admin (e.g. two co-admins), any of them can
 * query with their own customerId and get the same company-wide result set,
 * including self-placed orders from the *other* admin. resolveDealerPlacedOrders
 * implements this by fanning out over the dealer's own company plus subsidiaries,
 * not just subsidiaries.
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

        const resolution = await resolveDealerPlacedOrders(dealerId);
        if (!resolution.dealerFound) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        const { orders } = resolution;
        const summary = computeOrderSummary(orders);

        const sortedByDateDesc = [...orders].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        // -- Reproduce the historical flat DTO shape exactly — no machineSerial,
        // no pagination — regardless of what fields resolveDealerPlacedOrders' full
        // DealerOrderSummary carries for GET /orders' benefit --
        const recentOrders = sortedByDateDesc.slice(0, limit).map(o => ({
            orderId: o.orderId,
            orderNumber: o.orderNumber,
            date: o.date,
            orderedFor: o.orderedFor,
            createdBy: o.createdBy,
            itemsTotal: o.itemsTotal,
            total: o.total,
            currency: o.currency,
            statusId: o.statusId,
            status: o.status,
            customerId: o.customerId,
        }));

        res.json({ summary, data: recentOrders });
    } catch (err) {
        logger.error(`Dashboard recent-orders error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch recent orders' });
    }
});

/**
 * GET /orders
 *
 * "My Orders" list for the dealer view (OCI61-96), and — per product decision —
 * the canonical order-listing endpoint going forward, superseding GET /recent-orders
 * once the frontend Dashboard widget migrates to it. Deliberately scoped the same
 * way as GET /recent-orders — orders the dealer personally placed, for himself or
 * on behalf of a subsidiary company via POST /orders — not every order across the
 * whole hierarchy. That distinction lives on each order's own B2B `createdBy`
 * extra field, not on the order's customer_id, since BigCommerce has no native
 * concept of "who placed this order" separate from whose account it belongs to.
 * Both routes now share that resolution via resolveDealerPlacedOrders; this
 * endpoint adds real filtering/sorting/pagination on top of the same scoped list,
 * where /recent-orders only ever returns a flat top-N slice.
 *
 * `summary` (`totalOrderCount`/`openOrderCount`) is always computed from the
 * dealer's FULL placed-order set, independent of whatever status/orderedFor/
 * machineSerial/search filter narrows `data` — it reflects the whole hierarchy's
 * placed orders, not the current page/filter. `openOrderCount` uses the same
 * `status_id === 1` definition as GET /recent-orders (not reinterpreted here).
 *
 * `machineSerial` (alias: `machine`) filters against the machineSerial B2B order
 * extra field, same as orderedFor. No order-placement flow writes this field yet
 * — that's a separate, not-yet-built story — so today this filter always yields
 * zero matches rather than an error, exactly like any other not-yet-populated
 * attribute. Once that story starts writing machineSerial on new orders, this
 * starts working with no further change here.
 *
 * Query: ?customerId=248&status=Shipped&orderedFor=Self&machineSerial=M5-2891-K&search=1001&sort=date_desc&page=1&limit=20
 *
 * Response:
 * {
 *   summary: { totalOrderCount, openOrderCount },
 *   pagination: { total, perPage, currentPage, totalPages, offset },
 *   data: [{ orderId, orderNumber, date, orderedFor, createdBy, machineSerial, itemsTotal, total, currency, statusId, status, customerId }]
 * }
 */
router.get('/orders', async (req: Request, res: Response) => {
    try {
        const dealerId = Number(req.query.customerId);
        if (!dealerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        // -- Parse/validate pagination, sort, and status up front — mirrors the
        // page/limit clamping style used by GET /dealers/:dealerId/addresses --
        const limitRaw = Number(req.query.limit);
        const pageRaw = Number(req.query.page);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
        const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

        let sort: OrderListSort = 'date_desc';
        const sortRaw = req.query.sort;
        if (sortRaw !== undefined) {
            if (sortRaw === 'date_desc' || sortRaw === 'date_asc') {
                sort = sortRaw;
            } else {
                return res.status(400).json({ error: 'sort must be one of: date_desc, date_asc' });
            }
        }

        let statusFilter: string | undefined;
        const statusRaw = req.query.status;
        // Guard on `!== undefined` rather than `typeof === 'string'` alone — Express
        // parses repeated query keys (?status=A&status=B) into an array, which must
        // be rejected here rather than silently skipping the filter.
        if (statusRaw !== undefined) {
            const validStatuses = Object.values(STATUS_MAP);
            if (typeof statusRaw !== 'string' || !validStatuses.includes(statusRaw)) {
                return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
            }
            statusFilter = statusRaw;
        }

        const searchRaw = req.query.search;
        const search = typeof searchRaw === 'string' && searchRaw.trim() ? searchRaw.trim() : undefined;

        // -- orderedFor filters directly against each order's own stored attribution
        // rather than a separately-resolved company list. A stricter allowlist check
        // against `subsidiaries.map(s => s.companyName)` was tried and dropped: that
        // list is a live B2B company lookup, independent from the `orderedFor` value
        // frozen on an order at placement time, so the two can drift (e.g. a B2B
        // company record edited after the order was placed) and falsely 400 a value
        // that's actually valid. An unrecognized value now simply yields zero matches,
        // matching the story's own "no matching orders found" empty-state requirement.
        const orderedForRaw = req.query.orderedFor;
        if (orderedForRaw !== undefined && typeof orderedForRaw !== 'string') {
            return res.status(400).json({ error: 'orderedFor must be a single string value.' });
        }
        const orderedForFilter = orderedForRaw as string | undefined;

        // -- machineSerial filters against the machineSerial B2B order extra field,
        // same shape as orderedFor above. No order-placement flow writes this field
        // yet (a separate follow-up story owns that), so this filter always yields
        // zero matches today — not an error, just an empty result, exactly like an
        // orderedFor value that doesn't match anything. Once that story starts
        // writing machineSerial on new orders, this starts working with no further
        // change here. Accepts `machineSerial` or `machine` as the query key. --
        const machineSerialRaw = req.query.machineSerial ?? req.query.machine;
        if (machineSerialRaw !== undefined && typeof machineSerialRaw !== 'string') {
            return res.status(400).json({ error: 'machineSerial must be a single string value.' });
        }
        const machineSerialFilter = machineSerialRaw as string | undefined;

        // -- Dealer hierarchy resolution + full placed-order set, shared with
        // GET /recent-orders via resolveDealerPlacedOrders --
        const resolution = await resolveDealerPlacedOrders(dealerId);
        if (!resolution.dealerFound) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        const { orders } = resolution;

        // -- summary reflects the dealer's FULL placed-order set — computed before
        // any status/orderedFor/machineSerial/search filter narrows `data` below,
        // and unaffected by it. Naturally { totalOrderCount: 0, openOrderCount: 0 }
        // when the dealer has no resolvable B2B company/hierarchy (orders === []). --
        const summary = computeOrderSummary(orders);

        // -- Filter, sort, paginate (pure helper — see filterSortPaginateOrders) --
        const { data, total } = filterSortPaginateOrders(orders, {
            status: statusFilter,
            orderedFor: orderedForFilter,
            machineSerial: machineSerialFilter,
            search,
            sort,
            page,
            limit,
        });

        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
        const offset = (page - 1) * limit;

        res.json({
            summary,
            pagination: { total, perPage: limit, currentPage: page, totalPages, offset },
            data,
        });
    } catch (err) {
        logger.error(`Dashboard orders error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

/**
 * GET /orders/:orderId
 *
 * Order detail for the dealer view (OCI61-96) — the full detail page for a
 * single order already surfaced by GET /orders.
 *
 * BigCommerce has no single REST endpoint that returns full order detail
 * (confirmed — researched, not assumed). Building this response therefore
 * requires four separate BC v2 REST calls: `GET /v2/orders/{id}` for the core
 * order, then `GET /v2/orders/{id}/products`, `GET /v2/orders/{id}/shipping_addresses`,
 * and `GET /v2/orders/{id}/shipments`. The core order is fetched first since
 * the route needs its `customer_id` to authorize the request before doing any
 * further work; the three sub-resource calls are independent of each other and
 * only possible once the order is known to exist, so they run concurrently via
 * `Promise.all` rather than sequentially.
 *
 * Authorization is two-tier, matching GET /orders's scoping exactly:
 * (1) the order's `customer_id` must fall anywhere within the dealer's
 * resolved hierarchy, not just their own exact BC customer_id — a dealer must
 * be able to open the detail page for an order placed under a subsidiary
 * company's account, not only orders under their own account; AND
 * (2) the order must be one this dealer's company actually placed on record —
 * either `order.customer_id === dealerId` (their own order), or the order's
 * B2B `createdBy` extra field matches the dealer's company name. Hierarchy
 * membership alone is not sufficient: without tier 2, a dealer could open the
 * detail page for a self-service order a subsidiary customer placed
 * themselves (not through this dealer) just by guessing/knowing the order id,
 * even though GET /orders already excludes exactly that case from the list.
 *

 * `poReference`, `machineSerial`, `carrierType`, `carrierAccountNumber`,
 * `machineDownContactName`, and `machineDownContactPhone` are intentionally
 * returned as '' (not null) today — FE should never need a null-check on
 * these. No order-placement flow writes these B2B order extra fields yet —
 * that is a separate, not-yet-built order-placement story — so reading them
 * now is a no-op, exactly like `machineSerial` on GET /orders. Once that
 * story starts writing these keys, this endpoint starts returning real
 * values with no further change here. All six were confirmed as real,
 * already-defined B2B order extra fields via live GraphQL schema inspection
 * (not guessed) — except `placedByName`, see next paragraph.
 *
 * `placedByName` has NOT been confirmed to exist as a real B2B field (unlike
 * the six above) — it never appeared in a live extraFields response. It
 * falls back to the querying dealer's own BC name when empty, which is safe
 * in practice today since a dealer only ever reaches this page via his own
 * My Orders list (already scoped to orders he personally placed), but is an
 * approximation, not a guarantee, if this store ever has multiple dealer
 * users per company. Prefers a real B2B field automatically if one is ever
 * defined.
 *
 * `paymentMethod` is a native BC order field (`payment_method`), not a B2B
 * extra field — already returned by the core order fetch above, no new call
 * needed. Per an explicit OOTB-first decision, this stays the source of
 * truth over B2B's own `paymentMethod`-style extra field (not used).
 * `shipping.method` is likewise sourced from BC's native shipment/shipping-
 * address `shipping_method` field, not B2B's own `shippingMethod` extra
 * field (also not used), for the same reason.
 *
 * `shipping.estimatedDelivery` is always null — BigCommerce has no field
 * anywhere (order, shipment, or otherwise) for an estimated delivery date, so
 * this is a permanent placeholder, not a not-yet-populated one.
 *
 * Query: ?customerId=248
 *
 * Response:
 * {
 *   orderId, orderNumber, orderDate, statusId, status,
 *   orderedFor, poReference, placedByName, machineSerial, paymentMethod,
 *   carrierType, carrierAccountNumber, machineDownContactName, machineDownContactPhone,
 *   lineItems: [{ productId, sku, name, quantity, unitPrice, lineTotal }],
 *   costBreakdown: { subtotal, shipping, tax, total, currency },
 *   shipping: {
 *     address: { firstName, lastName, street1, street2, city, state, zip, country } | null,
 *     method, trackingNumber, trackingCarrier, shippedOn, estimatedDelivery: null
 *   },
 *   customerId
 * }
 */
router.get('/orders/:orderId', async (req: Request, res: Response) => {
    try {
        const dealerId = Number(req.query.customerId);
        if (!dealerId) {
            return res.status(400).json({ error: 'customerId is required' });
        }

        const orderId = Number(req.params.orderId);
        if (!isPositiveInteger(orderId)) {
            return res.status(400).json({ error: 'orderId must be a positive integer.' });
        }

        // -- 1. Fetch the core order first — its customer_id is required to
        // authorize the request before any further BC/B2B calls are made --
        let order: BcOrderDetail;
        try {
            const orderRes = await bcClient.get<BcOrderDetail>(`/v2/orders/${orderId}`);
            if (!orderRes.data?.id) {
                return res.status(404).json({ error: 'Order not found.' });
            }
            order = orderRes.data;
        } catch (err) {
            if (axios.isAxiosError(err) && err.response?.status === 404) {
                return res.status(404).json({ error: 'Order not found.' });
            }
            throw err;
        }

        // -- 2. Dealer record + hierarchy (same resolution as GET /orders) --
        const dealerRes = await bcClient.get('/v3/customers', { params: { 'id:in': dealerId } });
        const dealerRecord = dealerRes.data?.data?.[0];
        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        const hierarchy = await resolveDealerHierarchy(dealerId, dealerRecord.email);
        if (!hierarchy) {
            return res.status(403).json({ error: "Order does not belong to this dealer's hierarchy." });
        }
        const { dealerCompanyId, dealerCompanyName, subsidiaries } = hierarchy;

        // -- 3. Resolve every individual customer ID across the hierarchy and
        // authorize: the order's customer_id must fall somewhere within it. Fans
        // out over the dealer's OWN company plus subsidiaries, not just
        // subsidiaries, so a co-admin at the dealer's own company can also open
        // this page for an order placed by another admin at the same company --
        const usersPerCompany = await batchedMap(
            [dealerCompanyId, ...subsidiaries.map(sub => sub.companyId)],
            companyId => fetchB2BCompanyUsersCached(companyId),
            5
        );
        const hierarchyCustomerIds = new Set<number>([dealerId]);
        usersPerCompany.forEach(users => {
            users.forEach(u => {
                if (u.customerId > 0) hierarchyCustomerIds.add(u.customerId);
            });
        });

        if (!hierarchyCustomerIds.has(order.customer_id)) {
            return res.status(403).json({ error: "Order does not belong to this dealer's hierarchy." });
        }

        // -- 4. Authorized — fetch the remaining sub-resources in parallel, plus
        // this order's own B2B extra fields --
        const [products, shippingAddresses, shipments, extraFields] = await Promise.all([
            bcClient
                .get<BcOrderProduct[]>(`/v2/orders/${orderId}/products`)
                .then(r => (Array.isArray(r.data) ? r.data : []))
                .catch(() => [] as BcOrderProduct[]),
            bcClient
                .get<BcOrderShippingAddress[]>(`/v2/orders/${orderId}/shipping_addresses`)
                .then(r => (Array.isArray(r.data) ? r.data : []))
                .catch(() => [] as BcOrderShippingAddress[]),
            bcClient
                .get<BcOrderShipment[]>(`/v2/orders/${orderId}/shipments`)
                .then(r => (Array.isArray(r.data) ? r.data : []))
                .catch(() => [] as BcOrderShipment[]),
            fetchB2BOrderExtraFields(orderId),
        ]);

        const shippingAddress = shippingAddresses[0];
        const shipment = shipments[0];

        // Second-tier authorization check, on top of the hierarchy-membership check
        // above: hierarchy membership alone would let a dealer open any order under
        // any hierarchy customer_id, including a self-service order a subsidiary
        // customer placed themselves (not through this dealer) -- GET /orders
        // deliberately excludes those from the list, so the detail page must not be
        // reachable for them either. Allowed here: the dealer's own order, or one
        // this dealer's company placed on record (createdBy matches). Fetched (not
        // pre-checked) before this point so both checks share the same Promise.all
        // round-trip rather than adding a second sequential B2B call.
        if (order.customer_id !== dealerId && extraFields[ORDER_EXTRA_FIELD_CREATED_BY] !== dealerCompanyName) {
            return res.status(403).json({ error: "Order does not belong to this dealer's hierarchy." });
        }

        // Falls back to the querying dealer's own BC name (already fetched above for
        // hierarchy resolution -- no extra call) when no real B2B field is set. Safe
        // in practice today: a dealer only ever reaches this page by clicking through
        // his own My Orders list, which is already scoped to orders he personally
        // placed -- see GET /orders. Prefers a real B2B field automatically if one
        // is ever defined, so this isn't a hardcoded assumption long-term.
        const dealerFallbackName = [dealerRecord.first_name, dealerRecord.last_name].filter(Boolean).join(' ').trim();

        res.json({
            orderId: order.id,
            orderNumber: String(order.id),
            orderDate: order.date_created,
            statusId: order.status_id,
            status: STATUS_MAP[order.status_id] ?? order.status,
            orderedFor:
                extraFields[ORDER_EXTRA_FIELD_ORDERED_FOR] ?? (order.customer_id === dealerId ? 'Self' : 'Customer'),
            // These default to '' rather than null — see the matching comment on
            // machineSerial in resolveDealerPlacedOrders above for why '' is the real
            // "unset" value here, not null, once a field type exists in B2B admin.
            poReference: extraFields[ORDER_EXTRA_FIELD_PO_REFERENCE] || '',
            placedByName: extraFields[ORDER_EXTRA_FIELD_PLACED_BY_NAME] || dealerFallbackName,
            machineSerial: extraFields[ORDER_EXTRA_FIELD_MACHINE_SERIAL] || '',
            // Native BC field (payment_method), not a B2B extra field — OOTB per
            // request, already returned by the order fetch above, no new call.
            paymentMethod: order.payment_method || '',
            carrierType: extraFields[ORDER_EXTRA_FIELD_CARRIER_TYPE] || '',
            carrierAccountNumber: extraFields[ORDER_EXTRA_FIELD_CARRIER_ACCOUNT_NUMBER] || '',
            machineDownContactName: extraFields[ORDER_EXTRA_FIELD_MACHINE_DOWN_CONTACT_NAME] || '',
            machineDownContactPhone: extraFields[ORDER_EXTRA_FIELD_MACHINE_DOWN_CONTACT_PHONE] || '',
            // Number(...) throughout -- BC v2 order/product monetary fields are
            // commonly serialized as strings (confirmed in this file's test fixtures
            // and live Postman testing), which would otherwise leak into fields
            // this DTO types as `number`.
            lineItems: products.map(p => ({
                productId: p.product_id,
                sku: p.sku,
                name: p.name,
                quantity: p.quantity,
                unitPrice: Number(p.price_inc_tax),
                lineTotal: Number(p.total_inc_tax),
            })),
            // Additive: subtotal + shipping + tax === total. Requires ex-tax
            // subtotal/shipping with total_tax added on top -- using the inc-tax
            // variants here previously double-counted tax and broke this sum.
            costBreakdown: {
                subtotal: Number(order.subtotal_ex_tax),
                shipping: Number(order.shipping_cost_ex_tax),
                tax: Number(order.total_tax),
                total: Number(order.total_inc_tax),
                currency: order.currency_code,
            },
            shipping: {
                address: shippingAddress
                    ? {
                          firstName: shippingAddress.first_name,
                          lastName: shippingAddress.last_name,
                          street1: shippingAddress.street_1,
                          street2: shippingAddress.street_2 || null,
                          city: shippingAddress.city,
                          state: shippingAddress.state,
                          zip: shippingAddress.zip,
                          country: shippingAddress.country,
                      }
                    : null,
                // Native BC field (shipment/shipping-address shipping_method) -- the
                // B2B extra field of the same name is intentionally not used here,
                // per the OOTB-first decision: BC's own field stays authoritative.
                method: shipment?.shipping_method ?? shippingAddress?.shipping_method ?? null,
                trackingNumber: shipment?.tracking_number ?? null,
                trackingCarrier: shipment?.tracking_carrier ?? null,
                shippedOn: shipment?.date_created ?? null,
                estimatedDelivery: null,
            },
            customerId: order.customer_id,
        });
    } catch (err) {
        logger.error(`Dashboard order-detail error: ${(err as Error).message}`);
        res.status(500).json({ error: 'Failed to fetch order detail.' });
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
