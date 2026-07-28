import { Router } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import {
    fetchB2BCompanyById,
    fetchB2BCompanyByUserEmail,
    buildCompanyExtraFieldsMap,
    upsertB2BCompanyExtraField,
} from '../services/b2b-company';
import {
    B2B_PAGE_LIMIT,
    collectPages,
    fetchB2BCompanyIdByEmail,
    fetchB2BSubsidiaries,
    fetchB2BCompanyUsers,
    fetchB2BCompaniesByGroupName,
} from '../services/b2b-hierarchy';
import logger from '../config/logger';

const router = Router();

/** Cache TTL for the BC customer group map, in milliseconds. */
const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — groups change rarely
/** Maximum number of BC customer IDs that can be passed in a single id:in filter call. */
const BC_CUSTOMER_FILTER_LIMIT = 250;
/** Maximum number of recent customer search entries stored per dealer. */
const RECENT_SEARCH_LIMIT = 3;

// ---------------------------------------------------------------------------
// Types — BC
// ---------------------------------------------------------------------------

/** A registered machine on a customer account. */
interface Machine {
    serial: string | null;
    model: string | null;
    installDate: string | null;
    status: string | null;
}

// ---------------------------------------------------------------------------
// Types — B2B Machines extra field
// ---------------------------------------------------------------------------

/** Raw machine entry as stored in the B2B company "Machines" extra field JSON array. */
interface B2BMachineRecord {
    modelNo?: string;
    serialNo?: string;
    installDate?: string;
    status?: string;
}

/** A BigCommerce customer record subset returned by GET /v3/customers. */
interface BcCustomer {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    company: string;
    customer_group_id: number | null;
    date_created: string | null;
    date_modified: string | null;
}

/** A recent customer search entry stored in the dealer's B2B company extra field. */
interface RecentCustomerSearch {
    customerId: number;
    customerName: string;
    companyName: string;
    searchedAt: string; // ISO 8601
}

/** A BigCommerce customer group record returned by GET /v2/customer_groups. */
interface BcCustomerGroup {
    id: number;
    name: string;
}

// ---------------------------------------------------------------------------
// Types — B2B Edition hierarchy
// ---------------------------------------------------------------------------

/** Result of resolving a dealer's B2B hierarchy: customer IDs and their registered machines. */
interface DealerCustomerResult {
    customerIds: number[];
    totalCustomerIds: number;
    truncated: boolean;
    machinesByCustomerId: Record<number, Machine[]>;
}

// ---------------------------------------------------------------------------
// BC Helpers
// ---------------------------------------------------------------------------

/** In-memory cache of BC customer group id → name. Null when not yet loaded. */
let groupCache: Record<number, string> | null = null;
/** Unix timestamp (ms since epoch) of the last successful groupCache population. */
let groupCacheAt = 0;

// ---------------------------------------------------------------------------
// Types — Dealer Address Review
// ---------------------------------------------------------------------------

/** A single name/value extra field entry on a B2B address record. */
interface B2BAddressExtraFieldEntry {
    fieldName: string;
    fieldValue: string;
}

/** Full B2B address record as returned by GET /api/v3/io/addresses/{id}. */
interface B2BAddressItem {
    addressId: number;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    zipCode: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    stateName: string;
    countryName: string;
    stateCode: string;
    countryCode: string;
    companyId: string;
    isBilling: boolean;
    isShipping: boolean;
    isDefaultBilling: boolean;
    isDefaultShipping: boolean;
    label: string;
    createdAt: number;
    updatedAt: number;
    extraFields?: B2BAddressExtraFieldEntry[];
}

/** Paginated response envelope from GET /api/v3/io/addresses. */
interface B2BAddressListResponse {
    data: B2BAddressItem[];
}

/** Single address detail response from GET /api/v3/io/addresses/{id}. */
interface B2BAddressDetailResponse {
    data: B2BAddressItem;
}

/** Permitted approval status values for the dealer address review workflow. */
type DealerAddressApprovalStatus = 'pending' | 'approved' | 'rejected';
/** B2B address extra field name that holds the dealer address approval status. */
const DEALER_APPROVAL_FIELD = 'Approval Status';
/** B2B address extra field name that holds rejection remarks for a declined address. */
const DEALER_REJECTION_REMARKS_FIELD = 'Rejection Remarks';

/**
 * Fetch all BC customer groups and return a map of id → name.
 * Cached for 5 minutes.
 */
async function fetchCustomerGroupMap(): Promise<Record<number, string>> {
    const now = Date.now();
    if (groupCache && now - groupCacheAt < GROUP_CACHE_TTL) return groupCache;

    const res = await bcClient.get<BcCustomerGroup[]>('/v2/customer_groups', {
        params: { limit: 250 },
    });
    const groups = Array.isArray(res.data) ? res.data : [];
    const map: Record<number, string> = {};
    groups.forEach(g => {
        map[g.id] = g.name;
    });
    groupCache = map;
    groupCacheAt = now;
    return map;
}

/**
 * Fetch machines for a B2B company from its Machines extra field.
 * Returns [] on missing field, invalid JSON, or API failure.
 */
async function fetchB2BCompanyMachines(companyId: number): Promise<Machine[]> {
    try {
        const res = await b2bClient.get<{ data: { extraFields?: Array<{ fieldName: string; fieldValue: string }> } }>(
            `/api/v3/io/companies/${companyId}`
        );
        const extraFields = res.data?.data?.extraFields ?? [];
        const field = extraFields.find(f => f.fieldName.toLowerCase() === 'machines');
        if (!field) return [];

        let raw: B2BMachineRecord[];
        try {
            const sanitized = field.fieldValue.replace(/,(\s*[}\]])/g, '$1');
            const parsed = JSON.parse(sanitized);
            raw = Array.isArray(parsed) ? parsed : (parsed?.machines ?? []);
        } catch {
            logger.error(`dealers: company ${companyId} Machines extra field is not valid JSON`);
            return [];
        }

        if (!Array.isArray(raw)) return [];

        return raw
            .filter(m => m.status !== 'Inactive')
            .map(m => ({
                serial: m.serialNo ?? null,
                model: m.modelNo ?? null,
                installDate: m.installDate || null,
                status: m.status ?? null,
            }));
    } catch (err) {
        logger.error(`dealers: company ${companyId} machines fetch failed: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Run an async fn over items with at most `concurrency` in-flight at once.
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

/**
 * Build a minimal dealer summary object from a BC customer record.
 * @param dealer - The raw BC customer record.
 * @returns Dealer summary with id, firstName, lastName, email, and company.
 */
function buildDealerSummary(dealer: BcCustomer) {
    return {
        id: dealer.id,
        firstName: dealer.first_name,
        lastName: dealer.last_name,
        email: dealer.email,
        company: dealer.company || null,
    };
}

// ---------------------------------------------------------------------------
// B2B Hierarchy Helpers
// ---------------------------------------------------------------------------

/**
 * Core hierarchy resolver.
 *
 * Given a dealer's email, finds their B2B company via the users endpoint,
 * walks all direct subsidiaries (as shown in the Hierarchy tab in the BC portal),
 * and collects the BC customer IDs of every user within those subsidiaries.
 *
 * Returns no customer IDs when:
 *  - no B2B user matches the email
 *  - the company has no subsidiaries
 */
async function fetchCustomerIdsFromHierarchy(dealerEmail: string): Promise<DealerCustomerResult> {
    const dealerCompanyId = await fetchB2BCompanyIdByEmail(dealerEmail);
    if (!dealerCompanyId) {
        logger.warn(`dealer-hierarchy: no B2B company found for email ${dealerEmail}`);
        return { customerIds: [], totalCustomerIds: 0, truncated: false, machinesByCustomerId: {} };
    }

    logger.info(`dealer-hierarchy: resolved B2B company ${dealerCompanyId} for ${dealerEmail}`);

    const subsidiaries = await fetchB2BSubsidiaries(dealerCompanyId);
    if (subsidiaries.length === 0) {
        logger.warn(`dealer-hierarchy: company ${dealerCompanyId} has no subsidiaries`);
        return { customerIds: [], totalCustomerIds: 0, truncated: false, machinesByCustomerId: {} };
    }

    logger.info(`dealer-hierarchy: found ${subsidiaries.length} subsidiaries under company ${dealerCompanyId}`);

    const subsidiaryData = await batchedMap(
        subsidiaries,
        async sub => {
            const [users, machines] = await Promise.all([
                fetchB2BCompanyUsers(sub.companyId),
                fetchB2BCompanyMachines(sub.companyId),
            ]);
            return { users, machines };
        },
        5
    );

    const seen = new Set<number>();
    const customerIds: number[] = [];
    const machinesByCustomerId: Record<number, Machine[]> = {};

    subsidiaryData.forEach(({ users, machines }) => {
        users.forEach(user => {
            if (user.customerId > 0) {
                if (!seen.has(user.customerId)) {
                    seen.add(user.customerId);
                    customerIds.push(user.customerId);
                }
                machinesByCustomerId[user.customerId] = machines;
            }
        });
    });

    const validCustomerIds = customerIds.filter(id => Number.isInteger(id) && id > 0);
    const totalCustomerIds = validCustomerIds.length;
    const truncated = totalCustomerIds > BC_CUSTOMER_FILTER_LIMIT;

    if (truncated) {
        logger.warn(`dealer-hierarchy: truncated customer IDs from ${totalCustomerIds} to ${BC_CUSTOMER_FILTER_LIMIT}`);
    }

    logger.info(`dealer-hierarchy: collected ${totalCustomerIds} unique customer IDs`);

    return {
        customerIds: validCustomerIds.slice(0, BC_CUSTOMER_FILTER_LIMIT),
        totalCustomerIds,
        truncated,
        machinesByCustomerId,
    };
}

// ---------------------------------------------------------------------------
// B2B company-group helpers
// ---------------------------------------------------------------------------
//
// Note: fetchB2BCompaniesByGroupName used to be defined locally here — it now
// lives in services/b2b-hierarchy.ts (shared with dashboard.ts's order-placement
// feature) and is imported above instead of duplicated.

/**
 * Fetch a B2B company's default shipping address (city + state code only).
 * Returns null when the company has no address flagged as default shipping.
 * List endpoint already returns city/stateCode/isDefaultShipping — no per-address
 * detail call is needed here (that's only required for extraFields, e.g. approval status).
 * @param companyId - B2B company ID.
 * @returns The default shipping address's city/stateCode, or null if none is set.
 */
async function fetchCompanyDefaultShippingAddress(
    companyId: number
): Promise<{ city: string; stateCode: string } | null> {
    const addresses = await collectPages<B2BAddressItem>(async off => {
        try {
            const res = await b2bClient.get<B2BAddressListResponse>('/api/v3/io/addresses', {
                params: { companyId, limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`dealers: company ${companyId} address fetch failed: ${(err as Error).message}`);
            return [];
        }
    });
    const defaultShipping = addresses.find(a => a.isDefaultShipping === true);
    if (!defaultShipping) return null;
    return { city: defaultShipping.city, stateCode: defaultShipping.stateCode };
}

/**
 * Fetch a B2B company's Account Number extra field. Returns null on any lookup failure.
 * @param companyId - B2B company ID.
 * @returns The trimmed account number, or null if unset or the lookup fails.
 */
async function fetchCompanyAccountNumber(companyId: number): Promise<string | null> {
    const company = await fetchB2BCompanyById(companyId);
    const extraFieldMap = buildCompanyExtraFieldsMap(company?.extraFields);
    const raw = extraFieldMap.account_number;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

// ---------------------------------------------------------------------------
// Recent-search helpers
// ---------------------------------------------------------------------------

/**
 * Persist a new recent customer search for the dealer.
 *
 * - De-duplicates by customerId (a repeated search moves the entry to the front with an updated timestamp).
 * - Keeps at most RECENT_SEARCH_LIMIT entries, ordered most-recent first.
 * - Reads and writes the recent_customer_searches B2B user extra field.
 *
 * B2B calls:
 *   GET /api/v3/io/users?email=<dealerEmail>            → B2B user record + extraFields
 *   PUT /api/v3/io/users/<userId>                       → updated extra fields
 */
async function upsertRecentCustomerSearches(
    dealerEmail: string,
    newEntry: RecentCustomerSearch
): Promise<RecentCustomerSearch[]> {
    const company = await fetchB2BCompanyByUserEmail(dealerEmail);
    const companyExtraFields = buildCompanyExtraFieldsMap(company?.extraFields);

    let current: RecentCustomerSearch[] = [];
    if (companyExtraFields.recent_customer_searches) {
        try {
            const parsed = JSON.parse(companyExtraFields.recent_customer_searches);
            if (Array.isArray(parsed)) current = parsed as RecentCustomerSearch[];
        } catch {
            logger.warn(
                `dealer ${dealerEmail}: recent_customer_searches company extra field contained invalid JSON — resetting`
            );
        }
    }

    const updated = [newEntry, ...current.filter(s => s.customerId !== newEntry.customerId)].slice(
        0,
        RECENT_SEARCH_LIMIT
    );

    if (company) {
        await upsertB2BCompanyExtraField(company, 'recent_customer_searches', JSON.stringify(updated));
    }

    return updated;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /v1/api/dealers/context?email=<dealerEmail>
 *
 * Looks up a dealer by email, resolves their BC customer group by matching the
 * dealer's company name against BC customer groups, then finds all B2B companies
 * whose bcGroupName equals that group name, collects their users' BC customer IDs,
 * and returns the enriched customer list.
 *
 * Calls:
 *   [1] GET /v3/customers?email:in=<email>&limit=1                     → dealer record
 *   [2] GET /v2/customer_groups                                        → group map (cached 5 min)
 *   [3] GET /api/v3/io/companies (paginated, filtered by bcGroupName)  → matching B2B companies
 *   [4] GET /api/v3/io/users?companyId=<id> ×companies (batched 5)     → BC customer IDs
 *       GET /api/v3/io/companies/<id> ×companies (batched 5)          → account number
 *       GET /api/v3/io/addresses?companyId=<id> ×companies (batched 5) → default shipping city/state
 *   [5] GET /v3/customers?id:in=<ids>&limit=250                        → customer profiles
 *
 * Response:
 * {
 *   dealer:    { id, firstName, lastName, email, company },
 *   customers: [{ id, companyName, accountNumber, cityState }],
 *   meta:      { totalCustomerIds, returnedCustomerIds, truncated }
 * }
 */
router.get('/dealers/context', async (req, res) => {
    const { email } = req.query;

    if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'email query parameter is required.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format.' });
    }

    const emailNorm = email.trim().toLowerCase();

    const emptyResponse = (dealerRecord: BcCustomer) =>
        res.json({
            dealer: buildDealerSummary(dealerRecord),
            customers: [],
            meta: { totalCustomerIds: 0, returnedCustomerIds: 0, truncated: false },
        });

    try {
        // -- 1. Dealer lookup --
        const dealerLookup = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'email:in': emailNorm, limit: 1 },
        });
        const dealerRecord = dealerLookup.data?.data?.[0] ?? null;

        if (!dealerRecord) {
            return res.status(404).json({ error: 'No customer found for the supplied email.' });
        }

        const companyName = dealerRecord.company?.trim();

        if (!companyName) {
            logger.warn(`dealer context: ${emailNorm} has no company name`);
            return emptyResponse(dealerRecord);
        }

        // -- 2. Confirm a BC customer group with this name exists --
        const groupMap = await fetchCustomerGroupMap();
        const groupExists = Object.values(groupMap).some(name => name === companyName);

        if (!groupExists) {
            logger.warn(`dealer context: no BC customer group matching "${companyName}"`);
            return emptyResponse(dealerRecord);
        }

        // -- 3. Find all B2B companies linked to this customer group --
        const b2bCompanies = await fetchB2BCompaniesByGroupName(companyName);

        if (b2bCompanies.length === 0) {
            logger.warn(`dealer context: no B2B companies with bcGroupName "${companyName}"`);
            return emptyResponse(dealerRecord);
        }

        // -- 4. Collect BC customer IDs and per-company account number / default shipping address (batched) --
        const perCompanyData = await batchedMap(
            b2bCompanies,
            async company => {
                const [users, accountNumber, defaultAddress] = await Promise.all([
                    fetchB2BCompanyUsers(company.companyId),
                    fetchCompanyAccountNumber(company.companyId),
                    fetchCompanyDefaultShippingAddress(company.companyId),
                ]);
                return { company, users, accountNumber, defaultAddress };
            },
            5
        );

        const seen = new Set<number>();
        const customerIds: number[] = [];
        const customerIdToCompanyId: Record<number, number> = {};
        const companyMetaById: Record<number, { accountNumber: string | null; cityState: string | null }> = {};

        perCompanyData.forEach(({ company, users, accountNumber, defaultAddress }) => {
            companyMetaById[company.companyId] = {
                accountNumber,
                cityState: defaultAddress ? `${defaultAddress.city}, ${defaultAddress.stateCode}` : null,
            };
            users.forEach(user => {
                if (user.customerId > 0 && !seen.has(user.customerId)) {
                    seen.add(user.customerId);
                    customerIds.push(user.customerId);
                    customerIdToCompanyId[user.customerId] = company.companyId;
                }
            });
        });

        if (customerIds.length === 0) {
            return emptyResponse(dealerRecord);
        }

        // -- 5. Fetch BC customer profiles --
        const totalCustomerIds = customerIds.length;
        const truncated = totalCustomerIds > BC_CUSTOMER_FILTER_LIMIT;
        const idsToFetch = customerIds.slice(0, BC_CUSTOMER_FILTER_LIMIT);

        const customersRes = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': idsToFetch.join(','), limit: BC_CUSTOMER_FILTER_LIMIT },
        });

        const customers = (customersRes.data?.data ?? []).map((c: BcCustomer) => {
            const meta = companyMetaById[customerIdToCompanyId[c.id]];
            return {
                id: c.id,
                companyName: c.company || null,
                accountNumber: meta?.accountNumber ?? null,
                cityState: meta?.cityState ?? null,
            };
        });

        return res.json({
            dealer: buildDealerSummary(dealerRecord),
            customers,
            meta: { totalCustomerIds, returnedCustomerIds: customers.length, truncated },
        });
    } catch (err) {
        logger.error(`dealer context lookup for ${emailNorm} failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load dealer context.' });
    }
});

/**
 * GET /v1/api/dealers/:dealerId/customers
 *
 * Returns all customers under a dealer's B2B hierarchy subsidiaries, enriched
 * with basic identity, customer group, and registered machines.
 *
 * B2B hierarchy calls:
 *   [1] GET /api/v3/io/users?email=<email>                        → dealer's B2B user → companyId
 *   [2] GET /api/v3/io/companies (all pages, filtered client-side on parentCompany.id) → subsidiaries
 *   [3] GET /api/v3/io/users?companyId=<id> ×subsidiaries (batched 5) → BC customer IDs
 *
 * BC OOTB calls:
 *   [4] GET /v3/customers?id:in=<dealerId>                        → dealer customer record (for email)
 *   [5] GET /v3/customers?id:in=<customerIds>&limit=250           → customer profiles
 *   [6] GET /api/v3/io/companies/{id} ×subsidiaries (batched 5)   → company Machines extra field
 *   [7] GET /v2/customer_groups                                    → group names (cached 5 min)
 *
 * Response:
 * {
 *   dealerId:  number,
 *   customers: [{ id, email, firstName, lastName, customerGroup, dateCreated, dateModified, registeredMachines }],
 *   meta:      { totalCustomerIds, returnedCustomerIds, truncated }
 * }
 */
router.get('/dealers/:dealerId/customers', async (req, res) => {
    const { dealerId } = req.params;

    if (!dealerId || !/^\d+$/.test(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealerId — must be a numeric BC customer ID.' });
    }

    const dealerIdNum = Number(dealerId);

    try {
        // -- 1. Fetch dealer BC record to get email (needed for B2B lookup) --
        const dealerRes = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': dealerId },
        });
        const dealerRecord = dealerRes.data?.data?.[0] ?? null;

        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        // -- 2. Resolve customer IDs and company machines from B2B hierarchy --
        const { customerIds, totalCustomerIds, truncated, machinesByCustomerId } = await fetchCustomerIdsFromHierarchy(
            dealerRecord.email
        );

        if (customerIds.length === 0) {
            return res.json({
                dealerId: dealerIdNum,
                customers: [],
                meta: { totalCustomerIds, returnedCustomerIds: 0, truncated },
            });
        }

        // -- 3. Enrich: customer profiles and groups in parallel (machines already resolved) --
        const [customersRes, groupMap] = await Promise.all([
            bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
                params: { 'id:in': customerIds.join(','), limit: BC_CUSTOMER_FILTER_LIMIT },
            }),
            fetchCustomerGroupMap(),
        ]);

        const bcCustomers = customersRes.data?.data ?? [];

        const customers = bcCustomers.map(c => ({
            id: c.id,
            email: c.email,
            firstName: c.first_name,
            lastName: c.last_name,
            customerGroup: {
                id: c.customer_group_id ?? null,
                name: c.customer_group_id ? (groupMap[c.customer_group_id] ?? null) : null,
            },
            dateCreated: c.date_created ?? null,
            dateModified: c.date_modified ?? null,
            registeredMachines: machinesByCustomerId[c.id] ?? [],
        }));

        return res.json({
            dealerId: dealerIdNum,
            customers,
            meta: { totalCustomerIds, returnedCustomerIds: customerIds.length, truncated },
        });
    } catch (err) {
        logger.error(`dealer ${dealerId}: customer fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load dealer customers.' });
    }
});

/**
 * POST /v1/api/dealers/:dealerId/recent-customer-search
 *
 * Records a customer the dealer selected/searched, storing the last 3 unique
 * entries (most-recent first) in the dealer's B2B user extra field.
 *
 * Body:
 * {
 *   "customerId":   123,
 *   "customerName": "ACME Corp"
 * }
 *
 * Response:
 * {
 *   "recentSearches": [
 *     { "customerId": 123, "customerName": "ACME Corp", "searchedAt": "2026-07-10T14:30:00.000Z" },
 *     ...
 *   ]
 * }
 *
 * B2B calls:
 *   GET /v3/customers?id:in=<dealerId>                                    → dealer email
 *   GET /api/v3/io/users?email=<email>                                    → B2B user + extraFields
 *   PUT /api/v3/io/users/<userId>                                         → updated extra fields
 */
router.post('/dealers/:dealerId/recent-customer-search', async (req, res) => {
    const { dealerId } = req.params;

    if (!dealerId || !/^\d+$/.test(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealerId — must be a numeric BC customer ID.' });
    }

    const { customerId, customerName, companyName } = req.body as {
        customerId?: unknown;
        customerName?: unknown;
        companyName?: unknown;
    };

    if (
        customerId === undefined ||
        customerId === null ||
        typeof customerId !== 'number' ||
        !Number.isInteger(customerId) ||
        customerId <= 0
    ) {
        return res.status(400).json({ error: 'customerId must be a positive integer.' });
    }
    if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
        return res.status(400).json({ error: 'customerName is required.' });
    }
    if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
        return res.status(400).json({ error: 'companyName is required.' });
    }

    const newEntry: RecentCustomerSearch = {
        customerId,
        customerName: customerName.trim(),
        companyName: companyName.trim(),
        searchedAt: new Date().toISOString(),
    };

    try {
        // Resolve dealer email (needed for B2B user lookup)
        const dealerRes = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': dealerId },
        });
        const dealerRecord = dealerRes.data?.data?.[0] ?? null;
        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        await upsertRecentCustomerSearches(dealerRecord.email, newEntry);
        return res.status(200).json({ message: 'Recent customer search saved successfully.' });
    } catch (err) {
        logger.error(`dealer ${dealerId}: recent-customer-search POST failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not save recent customer search.' });
    }
});

// ---------------------------------------------------------------------------
// Address Helpers — Dealer Address Review
// ---------------------------------------------------------------------------

/**
 * Extract the dealer address approval status from B2B extra fields.
 * @param extraFields - The address's extra fields array.
 * @returns The parsed status, or null if absent or unrecognised.
 */
function getDealerAddressApprovalStatus(extraFields?: B2BAddressExtraFieldEntry[]): DealerAddressApprovalStatus | null {
    const field = (extraFields ?? []).find(
        f => f.fieldName.trim().toLowerCase() === DEALER_APPROVAL_FIELD.toLowerCase()
    );
    const raw = field?.fieldValue;
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    if (v === 'pending' || v === 'approved' || v === 'rejected') return v as DealerAddressApprovalStatus;
    return null;
}

/**
 * Extract the rejection remarks text from B2B address extra fields.
 * @param extraFields - The address's extra fields array.
 * @returns The rejection remarks value, or null if the field is absent.
 */
function getDealerRejectionRemarks(extraFields?: B2BAddressExtraFieldEntry[]): string | null {
    const field = (extraFields ?? []).find(
        f => f.fieldName.trim().toLowerCase() === DEALER_REJECTION_REMARKS_FIELD.toLowerCase()
    );
    return field?.fieldValue ?? null;
}

/**
 * Fetch a single B2B address record by ID, including its extra fields.
 * List endpoint omits extraFields — a detail call per address is required to read Approval Status.
 * @param addressId - The B2B address ID to fetch.
 * @returns The full address record, or null on any error.
 */
async function fetchB2BAddressDetail(addressId: number): Promise<B2BAddressItem | null> {
    try {
        const res = await b2bClient.get<B2BAddressDetailResponse>(`/api/v3/io/addresses/${addressId}`);
        return res.data?.data ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch all B2B addresses for a company and enrich each with its full detail (including extra fields).
 * Uses paginated list + batched per-address detail calls.
 * @param companyId - The B2B company ID.
 * @returns All addresses with extra fields populated.
 */
async function fetchAllCompanyAddressesWithDetail(companyId: number): Promise<B2BAddressItem[]> {
    const list = await collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BAddressListResponse>('/api/v3/io/addresses', {
                params: { companyId, limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(
                `dealer-addresses: company ${companyId} offset=${off} fetch failed: ${(err as Error).message}`
            );
            return [];
        }
    });
    return batchedMap(list, a => fetchB2BAddressDetail(a.addressId).then(full => full ?? a), 10);
}

/**
 * Map a raw B2B address item to the dealer-facing address response shape.
 * @param a - The raw B2B address record.
 * @param companyName - The company name to embed in the response.
 * @returns Normalised dealer address object with approval status and rejection remarks.
 */
function mapDealerAddress(a: B2BAddressItem, companyName: string) {
    return {
        addressId: a.addressId,
        companyId: /^\d+$/.test(a.companyId) ? Number(a.companyId) : null,
        companyName,
        label: a.label || null,
        firstName: a.firstName,
        lastName: a.lastName,
        phoneNumber: a.phoneNumber || null,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2 || null,
        city: a.city,
        state: a.stateName,
        stateCode: a.stateCode || null,
        zip: a.zipCode || null,
        country: a.countryName,
        countryCode: a.countryCode || null,
        isBilling: a.isBilling,
        isShipping: a.isShipping,
        isDefaultBilling: a.isDefaultBilling,
        isDefaultShipping: a.isDefaultShipping,
        approvalStatus: getDealerAddressApprovalStatus(a.extraFields),
        rejectionRemarks: getDealerRejectionRemarks(a.extraFields),
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
    };
}

/**
 * GET /v1/api/dealers/:dealerId/addresses
 *
 * Returns paginated B2B addresses for all customer companies under the dealer's group,
 * optionally filtered by approval status. Each address is enriched with its extra fields
 * (approval status, rejection remarks) via per-address detail calls.
 *
 * Query params:
 *   limit          - Number of results per page (1–100, default 20).
 *   page           - Page number (default 1).
 *   approvalStatus - Filter to "pending" | "approved" | "rejected" (optional).
 *
 * Response:
 * {
 *   dealerId:   number,
 *   pagination: { total, perPage, currentPage, totalPages, offset },
 *   data:       [{ addressId, companyId, companyName, approvalStatus, rejectionRemarks, ... }]
 * }
 */
router.get('/dealers/:dealerId/addresses', async (req, res) => {
    const { dealerId } = req.params;

    if (!dealerId || !/^\d+$/.test(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealerId — must be a numeric BC customer ID.' });
    }

    const dealerIdNum = Number(dealerId);

    const limitRaw = Number(req.query.limit);
    const pageRaw = Number(req.query.page);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
    const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

    let statusFilter: DealerAddressApprovalStatus | undefined;
    const statusRaw = req.query.approvalStatus;
    if (typeof statusRaw === 'string') {
        const s = statusRaw.toLowerCase();
        if (s === 'pending' || s === 'approved' || s === 'rejected') {
            statusFilter = s as DealerAddressApprovalStatus;
        } else {
            return res.status(400).json({ error: 'approvalStatus must be one of: pending, approved, rejected' });
        }
    }

    const emptyPage = () =>
        res.json({
            dealerId: dealerIdNum,
            pagination: { total: 0, perPage: limit, currentPage: page, totalPages: 0, offset: 0 },
            data: [],
        });

    try {
        const dealerRes = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': dealerId },
        });
        const dealerRecord = dealerRes.data?.data?.[0] ?? null;

        if (!dealerRecord) {
            return res.status(404).json({ error: 'Dealer not found.' });
        }

        const companyName = dealerRecord.company?.trim();

        if (!companyName) {
            logger.warn(`dealer-addresses: dealer ${dealerIdNum} has no company name on their BC record`);
            return emptyPage();
        }

        const groupMap = await fetchCustomerGroupMap();
        const groupExists = Object.values(groupMap).some(name => name === companyName);

        if (!groupExists) {
            logger.warn(`dealer-addresses: no BC customer group matching "${companyName}"`);
            return emptyPage();
        }

        // bcGroupName match mirrors dealers/context — companies tagged with the dealer's group name are their customers.
        const customerCompanies = await fetchB2BCompaniesByGroupName(companyName);

        if (customerCompanies.length === 0) {
            logger.info(`dealer-addresses: no B2B companies with bcGroupName "${companyName}"`);
            return emptyPage();
        }

        logger.info(`dealer-addresses: dealer ${dealerIdNum} (${companyName}) — ${customerCompanies.length} companies`);

        const addressesByCompany = await batchedMap(
            customerCompanies,
            sub =>
                fetchAllCompanyAddressesWithDetail(sub.companyId).then(addrs =>
                    addrs.map(a => mapDealerAddress(a, sub.companyName))
                ),
            5
        );

        let allAddresses = addressesByCompany.flat();

        if (statusFilter) {
            allAddresses = allAddresses.filter(a => a.approvalStatus === statusFilter);
        }

        const total = allAddresses.length;
        const offset = (page - 1) * limit;
        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
        const pageData = allAddresses.slice(offset, offset + limit);

        logger.info(`dealer-addresses: dealer ${dealerIdNum} — returning ${pageData.length}/${total} addresses`);

        return res.json({
            dealerId: dealerIdNum,
            pagination: { total, perPage: limit, currentPage: page, totalPages, offset },
            data: pageData,
        });
    } catch (err) {
        logger.error(`dealer ${dealerId}: addresses fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load dealer addresses.' });
    }
});

export default router;
