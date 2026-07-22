import { Router } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import {
    fetchB2BCompanyByUserEmail,
    buildCompanyExtraFieldsMap,
    upsertB2BCompanyExtraField,
} from '../services/b2b-company';
import logger from '../config/logger';

const router = Router();

const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — groups change rarely
const B2B_PAGE_LIMIT = 100;
const BC_CUSTOMER_FILTER_LIMIT = 250;
const RECENT_SEARCH_LIMIT = 3;

// ---------------------------------------------------------------------------
// Types — BC
// ---------------------------------------------------------------------------

interface Machine {
    serial: string | null;
    model: string | null;
    installDate: string | null;
    status: string | null;
}

// ---------------------------------------------------------------------------
// Types — B2B Machines extra field
// ---------------------------------------------------------------------------

interface B2BMachineRecord {
    modelNo?: string;
    serialNo?: string;
    installDate?: string;
    status?: string;
}

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

interface RecentCustomerSearch {
    customerId: number;
    customerName: string;
    companyName: string;
    searchedAt: string; // ISO 8601
}

interface BcCustomerGroup {
    id: number;
    name: string;
}

// ---------------------------------------------------------------------------
// Types — B2B Edition hierarchy
// ---------------------------------------------------------------------------

interface B2BCompany {
    companyId: number;
    companyName: string;
    companyEmail: string;
    bcGroupName?: string;
    parentCompany: {
        id: number | null;
        name: string;
    };
}

interface B2BCompanyUser {
    id: number;
    email: string;
    customerId: number; // BC customer ID
    companyId: number;
}

interface B2BPage<T> {
    data: T[];
    meta?: {
        pagination?: {
            totalCount?: number;
            offset?: number;
            limit?: number;
        };
    };
}

interface DealerCustomerResult {
    customerIds: number[];
    totalCustomerIds: number;
    truncated: boolean;
    machinesByCustomerId: Record<number, Machine[]>;
}

// ---------------------------------------------------------------------------
// BC Helpers
// ---------------------------------------------------------------------------

let groupCache: Record<number, string> | null = null;
let groupCacheAt = 0;

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
 * Recursively collects all pages from a paginated B2B endpoint.
 * Uses recursion instead of a loop to satisfy the no-restricted-syntax rule.
 */
async function collectPages<T>(fetcher: (off: number) => Promise<T[]>, pageOffset = 0, acc: T[] = []): Promise<T[]> {
    const page = await fetcher(pageOffset);
    acc.push(...page);
    if (page.length < B2B_PAGE_LIMIT) return acc;
    return collectPages(fetcher, pageOffset + B2B_PAGE_LIMIT, acc);
}

/**
 * Find the dealer's B2B company ID by looking up the admin user via their email.
 *
 * B2B API: GET /api/v3/io/users?email={email}
 * The returned user object contains `companyId` which is the dealer's B2B company.
 */
async function fetchB2BCompanyIdByEmail(email: string): Promise<number | null> {
    try {
        const res = await b2bClient.get<B2BPage<B2BCompanyUser>>('/api/v3/io/users', {
            params: { email, limit: 1 },
        });
        const user = res.data?.data?.[0] ?? null;
        return user ? user.companyId : null;
    } catch (err) {
        logger.error(`B2B user lookup by email ${email} failed: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Fetch all direct subsidiaries of a B2B company.
 *
 * The B2B API does not support server-side parent filtering, so all companies
 * are fetched (paginated) and filtered client-side on parentCompany.id.
 *
 * B2B API: GET /api/v3/io/companies (paginated)
 */
async function fetchB2BSubsidiaries(dealerCompanyId: number): Promise<B2BCompany[]> {
    const all = await collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompany>>('/api/v3/io/companies', {
                params: { limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`B2B companies fetch failed: ${(err as Error).message}`);
            throw err;
        }
    });
    return all.filter(c => c.parentCompany?.id === dealerCompanyId);
}

/**
 * Fetch all B2B users (and their BC customer IDs) for a given company (all pages).
 *
 * B2B API: GET /api/v3/io/users?companyId={companyId}
 */
async function fetchB2BCompanyUsers(companyId: number): Promise<B2BCompanyUser[]> {
    return collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompanyUser>>('/api/v3/io/users', {
                params: { companyId, limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`B2B users fetch for company ${companyId} failed: ${(err as Error).message}`);
            throw err;
        }
    });
}

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

/**
 * Fetch all B2B companies whose bcGroupName exactly matches the supplied name.
 * The B2B API has no server-side filter for this field, so all pages are fetched
 * and filtered client-side.
 */
async function fetchB2BCompaniesByGroupName(groupName: string): Promise<B2BCompany[]> {
    const all = await collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompany>>('/api/v3/io/companies', {
                params: { limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`B2B companies fetch failed: ${(err as Error).message}`);
            throw err;
        }
    });
    return all.filter(c => c.bcGroupName === groupName);
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
 *   [1] GET /v3/customers?email:in=<email>&limit=1                    → dealer record
 *   [2] GET /v2/customer_groups                                        → group map (cached 5 min)
 *   [3] GET /api/v3/io/companies (paginated, filtered by bcGroupName)  → matching B2B companies
 *   [4] GET /api/v3/io/users?companyId=<id> ×companies (batched 5)    → BC customer IDs
 *   [5] GET /v3/customers?id:in=<ids>&limit=250                        → customer profiles
 *
 * Response:
 * {
 *   dealer:    { id, firstName, lastName, email, company },
 *   customers: [{ id, companyName }],
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

        // -- 4. Collect BC customer IDs from each company's users (batched) --
        const usersPerCompany = await batchedMap(b2bCompanies, company => fetchB2BCompanyUsers(company.companyId), 5);

        const seen = new Set<number>();
        const customerIds: number[] = [];

        usersPerCompany.forEach(users => {
            users.forEach(user => {
                if (user.customerId > 0 && !seen.has(user.customerId)) {
                    seen.add(user.customerId);
                    customerIds.push(user.customerId);
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

        const customers = (customersRes.data?.data ?? []).map((c: BcCustomer) => ({
            id: c.id,
            companyName: c.company || null,
        }));

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

export default router;
