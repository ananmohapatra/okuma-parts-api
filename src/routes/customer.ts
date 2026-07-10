import { Router, Request, Response } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import logger from '../config/logger';
import authenticateBCToken from '../middleware/auth';

const router = Router();

const RECENT_MACHINES_LIMIT = 3;
const RECENT_SEARCHES_LIMIT = 3;

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
    model: string;
    serial: string;
    display: string;
    installDate: string | null;
    status: string | null;
}

interface OkumaMetafields {
    registered_machines?: string;
    registered_customers?: string;
    dealer_id?: string;
    last_viewed_machine?: string; // serial of the last explicitly selected machine
    recent_machines?: string; // JSON array of serials, most-recent first (capped at 3)
    recent_customer_searches?: string; // JSON array of search strings, most-recent first (capped at 10)
    _ids: Record<string, number>; // key → BC metafield record ID (not serialised to callers)
}

interface BcCustomer {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    company: string;
    phone: string;
    customer_group_id: number | null;
}

interface BcMetafieldRecord {
    id: number;
    key: string;
    value: string;
    namespace: string;
}

interface MachineSessionState {
    selected: string | null;
    recent: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all okuma-namespace metafields for a customer in one BC call.
 * Retains record IDs in `_ids` so callers can skip a redundant GET on upsert.
 * BC OOTB: GET /v3/customers/:id/metafields?namespace=okuma
 */
async function fetchOkumaMetafields(customerId: string): Promise<OkumaMetafields> {
    const res = await bcClient.get<{ data: Array<{ id: number; key: string; value: string }> }>(
        `/v3/customers/${customerId}/metafields`,
        { params: { namespace: 'okuma' } }
    );
    const fields = res.data?.data ?? [];
    const map: OkumaMetafields = { _ids: {} };
    // Guard against reserved and prototype-polluting keys. Writing '_ids' would
    // overwrite internal bookkeeping; writing '__proto__', 'constructor', or
    // 'prototype' could mutate Object.prototype and cause hard-to-debug runtime issues.
    const RESERVED_KEYS = new Set<string>([...Object.keys(map), '__proto__', 'constructor', 'prototype']);
    fields.forEach(f => {
        if (RESERVED_KEYS.has(f.key)) return;
        (map as unknown as Record<string, string>)[f.key] = f.value;
        map._ids[f.key] = f.id;
    });
    return map;
}

/**
 * Upsert a single okuma-namespace metafield on a customer.
 * When `existingId` is supplied (from a prior fetchOkumaMetafields call) the
 * redundant GET to discover the record is skipped — PUT is issued directly.
 * When omitted, falls back to GET → PUT/POST.
 */
async function upsertOkumaMetafield(
    customerId: string,
    key: string,
    value: string,
    existingId?: number
): Promise<void> {
    const payload = { value, namespace: 'okuma', key, permission_set: 'read_and_sf_access' };

    if (existingId !== undefined) {
        await bcClient.put(`/v3/customers/${customerId}/metafields/${existingId}`, payload);
        return;
    }

    const getRes = await bcClient.get<{ data: BcMetafieldRecord[] }>(`/v3/customers/${customerId}/metafields`, {
        params: { namespace: 'okuma', key },
    });
    const existing = getRes.data?.data?.[0] ?? null;
    if (existing) {
        await bcClient.put(`/v3/customers/${customerId}/metafields/${existing.id}`, payload);
    } else {
        await bcClient.post(`/v3/customers/${customerId}/metafields`, payload);
    }
}

/**
 * Fetch customer profile (company, phone, email) from BC.
 * BC OOTB: GET /v3/customers?id:in=:customerId
 */
async function fetchCustomerProfile(customerId: string): Promise<BcCustomer | null> {
    try {
        const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': customerId },
        });
        return res.data?.data?.[0] ?? null;
    } catch (err) {
        logger.warn(`fetchCustomerProfile ${customerId}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Fetch a customer record by ID.
 * Returns company name, or falls back to first + last name.
 */
async function fetchCustomerName(customerId: string): Promise<{ id: number; name: string } | null> {
    try {
        const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': customerId },
        });
        const c = res.data?.data?.[0] ?? null;
        if (!c) return null;
        return {
            id: c.id,
            name: c.company || `${c.first_name} ${c.last_name}`.trim(),
        };
    } catch (err) {
        logger.warn(`fetchCustomerName ${customerId}: ${(err as Error).message}`);
        return null;
    }
}

/** Fetch a BC customer group name by ID via GET /v2/customer_groups/:id. Returns null on failure. */
async function fetchCustomerGroupName(groupId: number): Promise<string | null> {
    try {
        const res = await bcClient.get<{ id: number; name: string }>(`/v2/customer_groups/${groupId}`);
        return res.data?.name ?? null;
    } catch (err) {
        logger.warn(`fetchCustomerGroupName ${groupId}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Parse and normalise the registered_machines metafield value.
 * Filters inactive machines, adds display string, sorts alphabetically.
 */
function parseMachines(raw: string | undefined): Machine[] {
    if (!raw) return [];
    let list: RawMachine[];
    try {
        list = JSON.parse(raw) as RawMachine[];
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];

    return list
        .filter(m => m.status !== 'Inactive')
        .map(m => ({
            model: m.model ?? '',
            serial: m.serial ?? '',
            display: `${m.model ?? ''} ${m.serial ?? ''}`.trim(),
            installDate: m.install_date ?? null,
            status: m.status ?? null,
        }))
        .sort((a, b) => {
            const cmp = a.model.localeCompare(b.model);
            return cmp !== 0 ? cmp : a.serial.localeCompare(b.serial);
        });
}

/**
 * Read per-customer machine context from Express session without mutating it.
 * Returns a default value when the key is absent so GET handlers do not
 * dirty the session store on cold requests.
 */
function readSessionState(req: Request, customerId: string): MachineSessionState {
    const session = req.session as unknown as Record<string, unknown> & {
        machineContext?: Record<string, MachineSessionState>;
    };
    return session.machineContext?.[customerId] ?? { selected: null, recent: [] };
}

/** Persist updated machine context to the session (write handlers only). */
function writeSessionState(req: Request, customerId: string, state: MachineSessionState): void {
    const session = req.session as unknown as Record<string, unknown> & {
        machineContext?: Record<string, MachineSessionState>;
    };
    if (!session.machineContext) session.machineContext = {};
    session.machineContext[customerId] = state;
}

/**
 * Resolve the default selected machine.
 * Priority: BC last_viewed_machine metafield → session → first alphabetically.
 * Uses || (not ??) so that an empty-string metafield value falls through to session.
 */
function resolveDefaultMachine(
    machines: Machine[],
    lastViewedSerial: string | null | undefined,
    sessionSerial: string | null
): Machine | null {
    if (!machines.length) return null;
    const preferred = lastViewedSerial || sessionSerial;
    if (preferred) {
        const found = machines.find(m => m.serial === preferred);
        if (found) return found;
    }
    return machines[0];
}

/**
 * Parse the recent_machines metafield value into an array of serials.
 * Falls back to the session list on missing value, invalid JSON, or non-array.
 */
function parseRecentSerials(raw: string | undefined, sessionFallback: string[]): string[] {
    if (!raw) return sessionFallback;
    try {
        const parsed = JSON.parse(raw) as string[];
        return Array.isArray(parsed) ? parsed : sessionFallback;
    } catch {
        return sessionFallback;
    }
}

/** Parse the recent_customer_searches metafield value into an array of query strings. */
function parseRecentSearches(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as string[];
        return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Session-based customer authorization
// ---------------------------------------------------------------------------

/**
 * Bind the caller's session to the given customer ID.
 * Called by the Stencil front-end after BC native login has been confirmed.
 * The customer's existence in BC is verified before the session is written.
 */
async function bindCustomerSession(req: Request, customerId: string): Promise<void> {
    const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
        params: { 'id:in': customerId },
    });
    if (!res.data?.data?.[0]) {
        throw Object.assign(new Error('Customer not found'), { statusCode: 404 });
    }
    req.session.customerId = customerId;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /customer/:customerId/session
 *
 * Establishes a session for the authenticated customer.
 * This route is restricted to trusted server-to-server callers so an arbitrary
 * browser client cannot bind a session to another customer's ID.
 * Existence in BC is verified before the session is written.
 *
 * Response: 204 No Content on success.
 */
router.post(
    '/customer/:customerId/session',
    authenticateBCToken,
    async (req: Request<{ customerId: string }>, res: Response) => {
        const { customerId } = req.params;

        if (!customerId || !/^\d+$/.test(customerId)) {
            return res.status(400).json({ error: 'Invalid customerId.' });
        }

        try {
            await bindCustomerSession(req, customerId);
            return res.status(204).send();
        } catch (err) {
            const { statusCode } = err as { statusCode?: number };
            if (statusCode === 404) {
                return res.status(404).json({ error: 'Customer not found.' });
            }
            logger.error(`customer ${customerId}: session bind failed: ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not establish customer session.' });
        }
    }
);

/**
 * GET /customer/:customerId/distributor
 *
 * Returns the distributor/dealer assigned to the customer.
 * The binding is stored as an okuma/dealer_id metafield on the customer.
 *
 * Response: { dealerId: number, dealerName: string } | { dealerId: null, dealerName: null }
 */
router.get('/customer/:customerId/distributor', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const meta = await fetchOkumaMetafields(customerId);

        if (!meta.dealer_id) {
            return res.json({ dealerId: null, dealerName: null });
        }

        const dealerIdNum = parseInt(meta.dealer_id, 10);
        if (Number.isNaN(dealerIdNum)) {
            logger.warn(`customer ${customerId}: dealer_id metafield is non-numeric: "${meta.dealer_id}"`);
            return res.json({ dealerId: null, dealerName: null });
        }

        const dealer = await fetchCustomerName(meta.dealer_id);

        return res.json({
            dealerId: dealer ? dealer.id : dealerIdNum,
            dealerName: dealer ? dealer.name : null,
        });
    } catch (err) {
        logger.error(`customer ${customerId}: distributor lookup failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load distributor.' });
    }
});

/**
 * GET /customer/:customerId/machines
 *
 * Returns assigned machines (model + serial) from the registered_machines metafield.
 *
 * Response: { count: number, machines: [{ model, serial, display, installDate, status }] }
 */
router.get('/customer/:customerId/machines', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const meta = await fetchOkumaMetafields(customerId);
        const machines = parseMachines(meta.registered_machines);
        return res.json({ count: machines.length, machines });
    } catch (err) {
        logger.error(`customer ${customerId}: machines fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load customer machines.' });
    }
});

/**
 * GET /customer/:customerId/header-context
 *
 * Returns all data needed for the machine-selector sub-header and account
 * summary card in one response.
 *
 * Default machine priority: BC last_viewed_machine metafield → session → first alphabetically.
 * Recent machines: BC recent_machines metafield (survives logout) → session fallback, capped at 3.
 *
 * Response for dealer:        { isDealer: true }
 * Response for regular user:
 * {
 *   isDealer: false,
 *   customer:        { firstName, lastName, email, company, phone },
 *   dealerName:      string | null,
 *   selectedMachine: { model, serial, display, installDate, status } | null,
 *   machines:        [...],              // all active, sorted A→Z
 *   recentMachines:  [...]              // last 3 selected, most-recent first
 * }
 */
router.get('/customer/:customerId/header-context', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const [meta, profile] = await Promise.all([fetchOkumaMetafields(customerId), fetchCustomerProfile(customerId)]);

        if (meta.registered_customers !== undefined) {
            return res.json({ isDealer: true });
        }

        const machines = parseMachines(meta.registered_machines);
        const dealerName = profile?.customer_group_id ? await fetchCustomerGroupName(profile.customer_group_id) : null;

        // readSessionState never mutates req.session — avoids a store write on every GET
        const sessionState = readSessionState(req, customerId);
        const selectedMachine = resolveDefaultMachine(machines, meta.last_viewed_machine, sessionState.selected);

        const recentSerials = parseRecentSerials(meta.recent_machines, sessionState.recent ?? []);
        const recentMachines = recentSerials
            .slice(0, RECENT_MACHINES_LIMIT)
            .map(serial => machines.find(m => m.serial === serial))
            .filter((m): m is Machine => m !== undefined);

        return res.json({
            isDealer: false,
            customer: profile
                ? {
                      firstName: profile.first_name,
                      lastName: profile.last_name,
                      email: profile.email,
                      company: profile.company || null,
                      phone: profile.phone || null,
                  }
                : null,
            dealerName,
            selectedMachine,
            machines,
            recentMachines,
        });
    } catch (err) {
        logger.error(`customer ${customerId}: header-context failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load customer context.' });
    }
});

/**
 * POST /customer/:customerId/machine/select
 *
 * Records the customer's machine selection.
 * - Updates session (immediate)
 * - Persists last_viewed_machine to BC metafield (survives logout, sets default on next visit)
 * - Persists recent_machines to BC metafield (survives logout, drives Recent section, capped at 3)
 *
 * Body:     { "serial": "M5-2891-K" }
 * Response: { "selectedMachine": { model, serial, display, installDate, status } }
 */
router.post('/customer/:customerId/machine/select', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;
    const { serial } = req.body as { serial?: string };

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!serial || typeof serial !== 'string' || !serial.trim()) {
        return res.status(400).json({ error: 'serial is required.' });
    }

    try {
        const meta = await fetchOkumaMetafields(customerId);
        const machines = parseMachines(meta.registered_machines);
        const machine = machines.find(m => m.serial === serial.trim());

        if (!machine) {
            return res.status(404).json({
                error: `Machine with serial '${serial}' not found in customer's assigned machines.`,
            });
        }

        // Seed recent list from BC metafield so cross-session history is preserved
        const sessionState = readSessionState(req, customerId);
        const baseRecent = parseRecentSerials(meta.recent_machines, sessionState.recent ?? []);

        const updatedRecent = [machine.serial, ...baseRecent.filter(s => s !== machine.serial)].slice(
            0,
            RECENT_MACHINES_LIMIT
        );

        writeSessionState(req, customerId, { selected: machine.serial, recent: updatedRecent });

        // Persist to BC metafields (fire-and-forget — do not block the response).
        // Pass metafield IDs from the initial fetch to skip a redundant GET per upsert.
        // Promise.allSettled ensures both writes are attempted independently.
        Promise.allSettled([
            upsertOkumaMetafield(customerId, 'last_viewed_machine', machine.serial, meta._ids.last_viewed_machine),
            upsertOkumaMetafield(
                customerId,
                'recent_machines',
                JSON.stringify(updatedRecent),
                meta._ids.recent_machines
            ),
        ]).then(results => {
            const keys = ['last_viewed_machine', 'recent_machines'];
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    logger.error(
                        `customer ${customerId}: metafield upsert [${keys[i]}] failed: ${(r.reason as Error).message}`
                    );
                }
            });
        });

        return res.json({ selectedMachine: machine });
    } catch (err) {
        logger.error(`customer ${customerId}: machine select failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not select machine.' });
    }
});

/**
 * GET /customer/:customerId/searches
 *
 * Returns the customer's recent search history from the BC metafield.
 *
 * Response: { searches: string[] }
 */
router.get('/customer/:customerId/searches', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const meta = await fetchOkumaMetafields(customerId);
        const searches = parseRecentSearches(meta.recent_customer_searches);
        return res.json({ searches });
    } catch (err) {
        logger.error(`customer ${customerId}: searches fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load recent searches.' });
    }
});

/**
 * POST /customer/:customerId/searches
 *
 * Prepends a new search query to the customer's recent search history and persists
 * it to the BC metafield. Duplicates are removed before prepending. List is capped
 * at RECENT_SEARCHES_LIMIT.
 *
 * Body:     { "query": "LB45-II spindle assembly" }
 * Response: { "searches": string[] }
 */
router.post('/customer/:customerId/searches', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;
    const { query } = req.body as { query?: string };

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'query is required.' });
    }

    const trimmedQuery = query.trim();

    try {
        const meta = await fetchOkumaMetafields(customerId);
        const current = parseRecentSearches(meta.recent_customer_searches);
        const updated = [trimmedQuery, ...current.filter(s => s !== trimmedQuery)].slice(0, RECENT_SEARCHES_LIMIT);

        await upsertOkumaMetafield(
            customerId,
            'recent_customer_searches',
            JSON.stringify(updated),
            meta._ids.recent_customer_searches
        );

        return res.json({ searches: updated });
    } catch (err) {
        logger.error(`customer ${customerId}: searches update failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not update recent searches.' });
    }
});

/**
 * GET /customer/:customerId/companyProfile
 *
 * Returns the customer's name, company name, account number, and address.
 *
 * Call 1 [OOTB B3]: GET /api/v3/io/users?bcCustomerId={id}  → firstName, lastName, companyId
 * Call 2 [OOTB B3]: GET /api/v3/io/companies/{companyId}    → companyName, address, accountNumber
 *
 * Response: { customerName, companyName, accountNumber, address }
 */
router.get(
    '/customer/:customerId/companyProfile',
    authenticateBCToken,
    async (req: Request<{ customerId: string }>, res: Response) => {
        const { customerId } = req.params;

        if (!customerId || !/^\d+$/.test(customerId)) {
            return res.status(400).json({ error: 'Invalid customerId.' });
        }

        try {
            // Call 1 — resolve customer name + companyId from B3
            const usersRes = await b2bClient.get(`/api/v3/io/users?bcCustomerId=${customerId}`);
            const b3User = usersRes.data?.data?.[0];

            if (!b3User) {
                return res.status(404).json({ error: 'Customer not found in B2B.' });
            }

            const { firstName, lastName, companyId } = b3User;

            // Fix #1: guard against missing companyId before calling companies API
            if (companyId === null || companyId === undefined) {
                return res.status(404).json({ error: 'Company not found for customer.' });
            }

            // Call 2 — resolve company details from B3
            const companyRes = await b2bClient.get(`/api/v3/io/companies/${companyId}`);
            const company = companyRes.data?.data;

            if (!company) {
                return res.status(404).json({ error: 'Company not found.' });
            }

            const accountNumber =
                (company.extraFields ?? []).find((f: any) => f.fieldName === 'Account Number')?.fieldValue ?? null;

            const addressParts = [company.addressLine1, company.city, company.state, company.zipCode, company.country]
                .map((p: string) => (p ?? '').trim())
                .filter(Boolean);

            return res.json({
                // Fix #2: coalesce to empty strings to avoid "undefined"/"null" in response
                customerName: `${firstName ?? ''} ${lastName ?? ''}`.trim(),
                companyName: company.companyName ?? null,
                accountNumber,
                address: {
                    line1: company.addressLine1 ?? '',
                    city: company.city ?? '',
                    state: company.state ?? '',
                    zipCode: company.zipCode ?? '',
                    country: company.country ?? '',
                    formatted: addressParts.join(', '),
                },
            });
        } catch (err: any) {
            // Fix #3: map upstream B2B 404s to 404 instead of 500
            if (err?.response?.status === 404) {
                return res.status(404).json({ error: 'Customer or company not found.' });
            }
            logger.error(`customer ${customerId}: companyProfile failed: ${err?.message ?? 'Unknown error'}`);
            return res.status(500).json({ error: 'Could not load company profile.' });
        }
    }
);

export default router;
