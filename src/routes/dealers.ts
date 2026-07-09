import { Router } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import logger from '../config/logger';

const router = Router();

const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — groups change rarely
const B2B_PAGE_LIMIT = 100;
const BC_CUSTOMER_FILTER_LIMIT = 250;

// ---------------------------------------------------------------------------
// Types — BC
// ---------------------------------------------------------------------------

interface RawMachine {
    serial?: string;
    model?: string;
    install_date?: string;
    status?: string;
}

interface Machine {
    serial: string | null;
    model: string | null;
    installDate: string | null;
    status: string | null;
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
 * Fetch the registered_machines metafield for one customer.
 * Returns [] on missing metafield, invalid JSON, or API failure.
 */
async function fetchRegisteredMachines(customerId: number): Promise<Machine[]> {
    try {
        const res = await bcClient.get<{ data: Array<{ key: string; namespace: string; value: string }> }>(
            `/v3/customers/${customerId}/metafields`,
            { params: { namespace: 'okuma', key: 'registered_machines' } }
        );
        const field = res.data?.data?.[0] ?? null;
        if (!field) return [];

        let raw: RawMachine[];
        try {
            raw = JSON.parse(field.value) as RawMachine[];
        } catch {
            logger.error(`dealer-customers: registered_machines for customer ${customerId} is not valid JSON`);
            return [];
        }

        if (!Array.isArray(raw)) return [];

        return raw
            .filter(m => m.status !== 'Inactive')
            .map(m => ({
                serial: m.serial ?? null,
                model: m.model ?? null,
                installDate: m.install_date ?? null,
                status: m.status ?? null,
            }));
    } catch (err) {
        logger.error(`dealer-customers: metafield fetch failed for customer ${customerId}: ${(err as Error).message}`);
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
        return { customerIds: [], totalCustomerIds: 0, truncated: false };
    }

    logger.info(`dealer-hierarchy: resolved B2B company ${dealerCompanyId} for ${dealerEmail}`);

    const subsidiaries = await fetchB2BSubsidiaries(dealerCompanyId);
    if (subsidiaries.length === 0) {
        logger.warn(`dealer-hierarchy: company ${dealerCompanyId} has no subsidiaries`);
        return { customerIds: [], totalCustomerIds: 0, truncated: false };
    }

    logger.info(`dealer-hierarchy: found ${subsidiaries.length} subsidiaries under company ${dealerCompanyId}`);

    const userArrays = await batchedMap(subsidiaries, sub => fetchB2BCompanyUsers(sub.companyId), 5);

    const seen = new Set<number>();
    const customerIds: number[] = userArrays
        .flat()
        .filter(user => user.customerId > 0)
        .reduce((acc, user) => {
            if (!seen.has(user.customerId)) {
                seen.add(user.customerId);
                acc.push(user.customerId);
            }
            return acc;
        }, [] as number[]);

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
    };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /v1/api/dealers/context?email=<dealerEmail>
 *
 * Looks up a dealer by email address and returns their profile together with
 * all customers found under their subsidiaries in the B2B hierarchy.
 *
 * B2B hierarchy calls:
 *   [1] GET /api/v3/io/users?email=<email>                  → dealer's B2B companyId
 *   [2] GET /api/v3/io/companies (paginated)               → subsidiaries filtered by parentCompany.id
 *   [3] GET /api/v3/io/users?companyId=<id> (paginated)    → BC customer IDs
 *
 * BC OOTB calls:
 *   [4] GET /v3/customers?email:in=<email>&limit=1         → dealer customer record
 *   [5] GET /v3/customers?id:in=<customerIds>&limit=250    → customer profiles
 *   [6] GET /v3/customers/:id/metafields ×N (batched 10)   → registered machines
 *   [7] GET /v2/customer_groups                            → group names (cached 5 min)
 *
 * Response:
 * {
 *   dealer:    { id, firstName, lastName, email, company },
 *   customers: [{ id, email, firstName, lastName, customerGroup, dateCreated, dateModified, registeredMachines }],
 *   meta:      { totalCustomerIds, returnedCustomerIds, truncated }
 * }
 */
router.get('/api/dealers/context', async (req, res) => {
    const { email } = req.query;

    if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'email query parameter is required.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format.' });
    }

    const emailNorm = email.trim().toLowerCase();

    try {
        // -- 1. Look up dealer BC record (identity only — not for customer list) --
        const dealerLookup = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'email:in': emailNorm, limit: 1 },
        });
        const dealerRecord = dealerLookup.data?.data?.[0] ?? null;

        if (!dealerRecord) {
            return res.status(404).json({ error: 'No customer found for the supplied email.' });
        }

        // -- 2. Resolve customer IDs from B2B hierarchy --
        const { customerIds, totalCustomerIds, truncated } = await fetchCustomerIdsFromHierarchy(emailNorm);

        if (customerIds.length === 0) {
            return res.json({
                dealer: buildDealerSummary(dealerRecord),
                customers: [],
                meta: { totalCustomerIds, returnedCustomerIds: 0, truncated },
            });
        }

        // -- 3. Enrich: customer profiles, machines (batched), and groups in parallel --
        const [customersRes, machinesResults, groupMap] = await Promise.all([
            bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
                params: { 'id:in': customerIds.join(','), limit: BC_CUSTOMER_FILTER_LIMIT },
            }),
            batchedMap(customerIds, id => fetchRegisteredMachines(id).then(machines => ({ id, machines })), 10),
            fetchCustomerGroupMap(),
        ]);

        const bcCustomers = customersRes.data?.data ?? [];

        const machinesById: Record<number, Machine[]> = {};
        machinesResults.forEach(({ id, machines }) => {
            machinesById[id] = machines;
        });

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
            registeredMachines: machinesById[c.id] ?? [],
        }));

        return res.json({
            dealer: buildDealerSummary(dealerRecord),
            customers,
            meta: { totalCustomerIds, returnedCustomerIds: customerIds.length, truncated },
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
 *   [6] GET /v3/customers/:id/metafields ×N (batched 10)          → registered machines
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

        // -- 2. Resolve customer IDs from B2B hierarchy --
        const { customerIds, totalCustomerIds, truncated } = await fetchCustomerIdsFromHierarchy(dealerRecord.email);

        if (customerIds.length === 0) {
            return res.json({
                dealerId: dealerIdNum,
                customers: [],
                meta: { totalCustomerIds, returnedCustomerIds: 0, truncated },
            });
        }

        // -- 3. Enrich: customer profiles, machines (batched), and groups in parallel --
        const [customersRes, machinesResults, groupMap] = await Promise.all([
            bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
                params: { 'id:in': customerIds.join(','), limit: BC_CUSTOMER_FILTER_LIMIT },
            }),
            batchedMap(customerIds, id => fetchRegisteredMachines(id).then(machines => ({ id, machines })), 10),
            fetchCustomerGroupMap(),
        ]);

        const bcCustomers = customersRes.data?.data ?? [];

        const machinesById: Record<number, Machine[]> = {};
        machinesResults.forEach(({ id, machines }) => {
            machinesById[id] = machines;
        });

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
            registeredMachines: machinesById[c.id] ?? [],
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

export default router;
