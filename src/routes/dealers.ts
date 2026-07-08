import { Router } from 'express';
import bcClient from '../services/bigcommerce';

const router = Router();

const GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes — groups change rarely

// ---------------------------------------------------------------------------
// Types
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
    customer_group_id: number | null;
    date_created: string | null;
    date_modified: string | null;
}

interface BcCustomerGroup {
    id: number;
    name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let groupCache: Record<number, string> | null = null;
let groupCacheAt = 0;

/**
 * Fetch all BC customer groups and return a map of id → name.
 * Cached for 5 minutes.
 * BC OOTB: GET /v2/customer_groups
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
 * BC OOTB: GET /v3/customers/:id/metafields?namespace=okuma&key=registered_machines
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
            console.error(`dealer-customers: registered_machines for customer ${customerId} is not valid JSON`);
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
        console.error(`dealer-customers: metafield fetch failed for customer ${customerId}:`, (err as Error).message);
        return [];
    }
}

/**
 * Run an async fn over items with at most `concurrency` in-flight at once.
 * Prevents rate-limit issues when a dealer has a large customer list.
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/dealers/:dealerId/customers
 *
 * Returns all registered customers under a dealer / distributor, enriched
 * with basic identity, account status, customer group, and registered machines.
 *
 * Dealer-customer relationship: the dealer customer record stores a
 * `registered_customers` metafield (namespace: okuma, key: registered_customers)
 * as a JSON array of BC customer IDs.
 *
 * BC OOTB calls:
 *   [1] GET /v3/customers/:dealerId/metafields?namespace=okuma&key=registered_customers
 *   [2] GET /v3/customers?id:in=...                    → customer records (parallel with 3+4)
 *   [3] GET /v3/customers/:id/metafields (×N, batched 10 at a time) → registered machines
 *   [4] GET /v2/customer_groups                        → group names (cached 5 min)
 */
router.get('/api/dealers/:dealerId/customers', async (req, res) => {
    const { dealerId } = req.params;

    if (!dealerId || !/^\d+$/.test(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealerId — must be a numeric BC customer ID.' });
    }

    const dealerIdNum = Number(dealerId);

    try {
        // -- 1. Fetch dealer's registered_customers metafield (server-side filtered) --
        const metaRes = await bcClient.get<{ data: Array<{ key: string; value: string }> }>(
            `/v3/customers/${dealerId}/metafields`,
            { params: { namespace: 'okuma', key: 'registered_customers' } }
        );
        const rcField = metaRes.data?.data?.[0] ?? null;

        if (!rcField) {
            return res.json({ dealerId: dealerIdNum, customers: [] });
        }

        let customerIds: number[];
        try {
            customerIds = JSON.parse(rcField.value) as number[];
        } catch {
            console.error(`dealer ${dealerId}: registered_customers metafield is not valid JSON`);
            return res.json({ dealerId: dealerIdNum, customers: [] });
        }

        if (!Array.isArray(customerIds) || customerIds.length === 0) {
            return res.json({ dealerId: dealerIdNum, customers: [] });
        }

        // BC id:in accepts up to 250 IDs per request
        const validIds = customerIds.filter(id => Number.isInteger(id) && id > 0).slice(0, 250);

        // -- 2. Batch-fetch customer records, machines (batched), and groups in parallel --
        const [customersRes, machinesResults, groupMap] = await Promise.all([
            bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
                params: {
                    'id:in': validIds.join(','),
                    limit: 250,
                },
            }),
            batchedMap(validIds, id => fetchRegisteredMachines(id).then(machines => ({ id, machines })), 10),
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

        return res.json({ dealerId: dealerIdNum, customers });
    } catch (err) {
        console.error(`dealer ${dealerId}: customer fetch failed:`, (err as Error).message);
        return res.status(500).json({ error: 'Could not load dealer customers.' });
    }
});

export default router;
