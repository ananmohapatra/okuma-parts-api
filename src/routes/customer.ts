import { Router, Request, Response } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import logger from '../config/logger';
import authenticateBCToken from '../middleware/auth';

const router = Router();

const RECENT_MACHINES_LIMIT = 3;
const RECENT_SEARCHES_LIMIT = 3;
const COMPANY_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Company profile cache
// ---------------------------------------------------------------------------

interface CompanyProfileData {
    companyName: string | null;
    accountNumber: string | null;
    address: {
        line1: string;
        city: string;
        state: string;
        zipCode: string;
        country: string;
        formatted: string;
    };
}

interface CompanyProfileCacheEntry {
    data: CompanyProfileData;
    expiresAt: number;
}

const companyProfileCache = new Map<string, CompanyProfileCacheEntry>();

function getProfileCache(companyId: string): CompanyProfileData | null {
    const entry = companyProfileCache.get(companyId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        companyProfileCache.delete(companyId);
        return null;
    }
    return entry.data;
}

function setProfileCache(companyId: string, data: CompanyProfileData): void {
    companyProfileCache.set(companyId, { data, expiresAt: Date.now() + COMPANY_PROFILE_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Machine {
    model: string;
    serial: string;
    display: string;
    installDate: string | null;
    status: string | null;
}

interface OkumaMetafields {
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

interface CustomerSearchEntry {
    customerId: number;
    customerName: string;
    companyName: string | null;
    searchedAt: string;
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

interface B2BMachineRecord {
    modelNo?: string;
    serialNo?: string;
    publicationNos?: string[];
    installDate?: string;
    status?: string;
}

/**
 * Fetch machines from the B2B company Machines extra field.
 * Resolves: BC email → B2B user → companyId → company extraFields → Machines JSON.
 * Returns an empty array on any lookup failure.
 */
async function fetchB2BMachines(email: string): Promise<Machine[]> {
    try {
        const usersRes = await b2bClient.get<{ data: Array<{ companyId?: number }> }>('/api/v3/io/users', {
            params: { email },
        });
        const companyId = usersRes.data?.data?.[0]?.companyId;
        if (!companyId) return [];

        const companyRes = await b2bClient.get<{
            data: { extraFields?: Array<{ fieldName: string; fieldValue: string }> };
        }>(`/api/v3/io/companies/${companyId}`);
        const machinesField = (companyRes.data?.data?.extraFields ?? []).find(
            f => f.fieldName.toLowerCase() === 'machines'
        );
        if (!machinesField) return [];

        let raw: B2BMachineRecord[];
        try {
            const sanitized = machinesField.fieldValue.replace(/,(\s*[}\]])/g, '$1');
            const parsed = JSON.parse(sanitized);
            raw = Array.isArray(parsed) ? parsed : (parsed?.machines ?? []);
        } catch {
            logger.warn(`fetchB2BMachines: Machines field for company ${companyId} is not valid JSON`);
            return [];
        }

        const seenSerials = new Set<string>();
        return raw
            .filter(m => m.status !== 'Inactive')
            .filter(m => {
                const serial = m.serialNo ?? '';
                if (!serial || seenSerials.has(serial)) return false;
                seenSerials.add(serial);
                return true;
            })
            .map(m => ({
                model: m.modelNo ?? '',
                serial: m.serialNo ?? '',
                display: `${m.modelNo ?? ''} ${m.serialNo ?? ''}`.trim(),
                installDate: m.installDate || 'pending',
                status: m.status ?? null,
            }))
            .sort((a, b) => {
                const cmp = a.model.localeCompare(b.model);
                return cmp !== 0 ? cmp : a.serial.localeCompare(b.serial);
            });
    } catch (err) {
        logger.warn(`fetchB2BMachines: ${(err as Error).message}`);
        return [];
    }
}

/**
 * Fetch job title from BC customer form field values.
 * BC OOTB: GET /v3/customers/form-field-values?customer_id:in=:customerId
 * Matches any field whose name normalises to "jobtitle".
 */
async function fetchCustomerJobTitle(customerId: string): Promise<string | null> {
    try {
        const res = await bcClient.get<{ data: Array<{ name: string; value: string }> }>(
            '/v3/customers/form-field-values',
            { params: { 'customer_id:in': customerId } }
        );
        const field = (res.data?.data ?? []).find(f => f.name?.toLowerCase().replace(/[\s_-]/g, '') === 'jobtitle');
        return field?.value ?? null;
    } catch (err) {
        logger.warn(`fetchCustomerJobTitle ${customerId}: ${(err as Error).message}`);
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

/** Parse the recent_customer_searches metafield value into an array of CustomerSearchEntry objects. */
function parseRecentSearches(raw: string | undefined): CustomerSearchEntry[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown[];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (s): s is CustomerSearchEntry =>
                typeof s === 'object' && s !== null && typeof (s as CustomerSearchEntry).customerId === 'number'
        );
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
 * Returns assigned machines from the B2B company Machines extra field.
 *
 * Response: { count: number, machines: [{ model, serial, display, installDate, status }] }
 */
router.get('/customer/:customerId/machines', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const profile = await fetchCustomerProfile(customerId);
        const machines = profile?.email ? await fetchB2BMachines(profile.email) : [];
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
        const [meta, profile, jobTitle] = await Promise.all([
            fetchOkumaMetafields(customerId),
            fetchCustomerProfile(customerId),
            fetchCustomerJobTitle(customerId),
        ]);

        if (meta.registered_customers !== undefined) {
            return res.json({ isDealer: true });
        }

        const [machines, dealerName] = await Promise.all([
            profile?.email ? fetchB2BMachines(profile.email) : Promise.resolve([]),
            profile?.customer_group_id ? fetchCustomerGroupName(profile.customer_group_id) : Promise.resolve(null),
        ]);

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
                      jobTitle,
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
    const { serial, model } = req.body as { serial?: string; model?: string };

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!serial || typeof serial !== 'string' || !serial.trim()) {
        return res.status(400).json({ error: 'serial is required.' });
    }

    try {
        const [meta, profile] = await Promise.all([fetchOkumaMetafields(customerId), fetchCustomerProfile(customerId)]);
        const machines = profile?.email ? await fetchB2BMachines(profile.email) : [];
        const machine = machines.find(m => m.serial === serial.trim() && (model ? m.model === model.trim() : true));

        if (!machine) {
            return res.status(404).json({
                error: `Machine with serial '${serial}'${model ? ` and model '${model}'` : ''} not found in customer's assigned machines.`,
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

        const recentMachines = updatedRecent
            .map(s => machines.find(m => m.serial === s))
            .filter((m): m is Machine => m !== undefined);

        // Await both BC metafield writes so GET /header-context reads fresh data immediately after.
        const results = await Promise.allSettled([
            upsertOkumaMetafield(customerId, 'last_viewed_machine', machine.serial, meta._ids.last_viewed_machine),
            upsertOkumaMetafield(
                customerId,
                'recent_machines',
                JSON.stringify(updatedRecent),
                meta._ids.recent_machines
            ),
        ]);
        const keys = ['last_viewed_machine', 'recent_machines'];
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                logger.error(
                    `customer ${customerId}: metafield upsert [${keys[i]}] failed: ${(r.reason as Error).message}`
                );
            }
        });

        return res.json({ selectedMachine: machine, recentMachines });
    } catch (err) {
        logger.error(`customer ${customerId}: machine select failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not select machine.' });
    }
});

/**
 * GET /customer/:customerId/searches
 *
 * Returns the customer's recent searched-customer history from the BC metafield.
 *
 * Response: { searches: CustomerSearchEntry[] }
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
 * Prepends a searched customer entry to the dealer's recent search history and
 * persists it to the BC metafield. Deduplicates by searchedCustomerId. Capped
 * at RECENT_SEARCHES_LIMIT.
 *
 * Body:     { "customerId": 248, "customerName": "John Smith", "companyName": "Gosiger Inc." }
 * Response: { "searches": CustomerSearchEntry[] }
 */
router.post('/customer/:customerId/searches', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;
    const {
        customerId: searchedCustomerId,
        customerName,
        companyName,
    } = req.body as {
        customerId?: unknown;
        customerName?: unknown;
        companyName?: unknown;
    };

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!searchedCustomerId || typeof searchedCustomerId !== 'number') {
        return res.status(400).json({ error: 'customerId (searched customer) must be a number.' });
    }
    if (!customerName || typeof customerName !== 'string' || !customerName.trim()) {
        return res.status(400).json({ error: 'customerName is required.' });
    }

    const entry: CustomerSearchEntry = {
        customerId: searchedCustomerId,
        customerName: (customerName as string).trim(),
        companyName: typeof companyName === 'string' ? companyName.trim() || null : null,
        searchedAt: new Date().toISOString(),
    };

    try {
        const meta = await fetchOkumaMetafields(customerId);
        const current = parseRecentSearches(meta.recent_customer_searches);
        const updated = [entry, ...current.filter(s => s.customerId !== entry.customerId)].slice(
            0,
            RECENT_SEARCHES_LIMIT
        );

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
 * GET /customer/:customerId/metafields?namespace=okuma&key=recent_customer_searches
 *
 * General-purpose BC customer metafield proxy. Returns the raw value for the
 * given namespace + key combination, proxied server-side to avoid CORS.
 *
 * Query params:
 *   namespace  — required, e.g. "okuma"
 *   key        — required, e.g. "recent_customer_searches"
 *
 * Response: { customerId, namespace, key, value: string | null }
 */
router.get('/customer/:customerId/metafields', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;
    const { namespace, key } = req.query as Record<string, string>;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!namespace || !namespace.trim()) {
        return res.status(400).json({ error: 'namespace query param is required.' });
    }
    if (!key || !key.trim()) {
        return res.status(400).json({ error: 'key query param is required.' });
    }

    try {
        const bcRes = await bcClient.get<{ data: BcMetafieldRecord[] }>(`/v3/customers/${customerId}/metafields`, {
            params: { namespace: namespace.trim(), key: key.trim() },
        });
        const record = bcRes.data?.data?.[0] ?? null;

        return res.json({
            customerId: parseInt(customerId, 10),
            namespace: namespace.trim(),
            key: key.trim(),
            value: record ? record.value : null,
        });
    } catch (err) {
        logger.error(`customer ${customerId}: metafield fetch [${namespace}/${key}] failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load metafield.' });
    }
});
/*
 * GET /customer/companyProfile?companyId={companyId}
 *
 * Returns company name, account number, and default shipping address.
 * FE supplies companyId directly — no B3 users lookup needed.
 *
 * Call A [OOTB B3]: GET /api/v3/io/companies/{companyId}            → companyName, accountNumber
 * Call B [OOTB B3]: GET /api/v3/io/addresses?companyId={companyId}  → default shipping address
 *
 * Calls A and B run in parallel. Result cached by companyId for 5 minutes.
 *
 * Response: { companyName, accountNumber, address }
 */
router.get('/customer/companyProfile', authenticateBCToken, async (req: Request, res: Response) => {
    const companyId = req.query.companyId as string | undefined;

    if (!companyId || !/^\d+$/.test(companyId)) {
        return res.status(400).json({ error: 'Invalid or missing companyId.' });
    }
    const cached = getProfileCache(companyId);
    if (cached) {
        logger.debug(`companyProfile cache hit for company ${companyId}`);
        return res.json(cached);
    }

    try {
        const [companyRes, addressesRes] = await Promise.all([
            b2bClient.get(`/api/v3/io/companies/${companyId}`),
            b2bClient.get(`/api/v3/io/addresses?companyId=${companyId}`),
        ]);

        const company = companyRes.data?.data;
        if (!company) {
            return res.status(404).json({ error: 'Company not found.' });
        }

        const accountNumber =
            (company.extraFields ?? []).find(
                (f: { fieldName: string; fieldValue: string | null }) => f.fieldName === 'Account Number'
            )?.fieldValue ?? null;

        interface B3Address {
            addressLine1: string;
            city: string;
            stateName: string;
            zipCode: string;
            countryName: string;
            isDefaultShipping: boolean;
        }

        const addresses: B3Address[] = addressesRes.data?.data ?? [];
        const defaultShipping = addresses.find(a => a.isDefaultShipping === true) ?? addresses[0] ?? null;

        const addressParts = [
            defaultShipping?.addressLine1,
            defaultShipping?.city,
            defaultShipping?.stateName,
            defaultShipping?.zipCode,
            defaultShipping?.countryName,
        ]
            .map(p => (p ?? '').trim())
            .filter(Boolean);

        const profile: CompanyProfileData = {
            companyName: company.companyName ?? null,
            accountNumber,
            address: {
                line1: defaultShipping?.addressLine1 ?? '',
                city: defaultShipping?.city ?? '',
                state: defaultShipping?.stateName ?? '',
                zipCode: defaultShipping?.zipCode ?? '',
                country: defaultShipping?.countryName ?? '',
                formatted: addressParts.join(', '),
            },
        };

        setProfileCache(companyId, profile);
        return res.json(profile);
    } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status === 404) {
            return res.status(404).json({ error: 'Company not found.' });
        }
        logger.error(`companyProfile failed for company ${companyId}: ${(err as Error)?.message ?? 'Unknown error'}`);
        return res.status(500).json({ error: 'Could not load company profile.' });
    }
});

// GET /v1/customer/:customerId/b2b-token
// Returns a B2B storefront customer token for use with the B2B Storefront GraphQL API.
router.get('/customer/:customerId/b2b-token', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const tokenRes = await b2bClient.post('/api/io/auth/customers/storefront', {
            customerId: parseInt(customerId, 10),
        });

        const raw = tokenRes.data?.data?.token ?? tokenRes.data?.token;
        const token = Array.isArray(raw) ? raw[0] : raw;

        if (!token) {
            logger.error(`customer ${customerId}: b2b-token response missing token field`);
            return res.status(502).json({ error: 'No token returned from B2B.' });
        }

        return res.json({ token });
    } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
            return res.status(404).json({ error: 'Customer not found in B2B.' });
        }
        logger.error(`customer ${customerId}: b2b-token failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not generate B2B storefront token.' });
    }
});

export default router;

