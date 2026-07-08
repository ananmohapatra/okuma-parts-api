import { Router, Request } from 'express';
import bcClient from '../services/bigcommerce';

const router = Router();

const RECENT_MACHINES_LIMIT = 5;

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
}

interface BcCustomer {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    company: string;
    phone: string;
}

interface MachineSessionState {
    selected: string | null;
    recent: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all okuma-namespace metafields for a customer in one BC OOTB call.
 * BC OOTB: GET /v3/customers/:id/metafields?namespace=okuma
 */
async function fetchOkumaMetafields(customerId: string): Promise<OkumaMetafields> {
    const res = await bcClient.get<{ data: Array<{ key: string; value: string }> }>(
        `/v3/customers/${customerId}/metafields`,
        { params: { namespace: 'okuma' } }
    );
    const fields = res.data?.data ?? [];
    const map: OkumaMetafields = {};
    fields.forEach(f => {
        (map as Record<string, string>)[f.key] = f.value;
    });
    return map;
}

/**
 * Fetch customer profile (company, phone, email) from BC OOTB customers API.
 * BC OOTB: GET /v3/customers?id:in=:customerId
 */
async function fetchCustomerProfile(customerId: string): Promise<BcCustomer | null> {
    try {
        const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': customerId },
        });
        return res.data?.data?.[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch the dealer's display name from BC.
 * Prefers company field; falls back to first + last name.
 * BC OOTB: GET /v3/customers?id:in=:dealerId
 */
async function fetchDealerName(dealerId: string): Promise<string | null> {
    try {
        const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': dealerId },
        });
        const dealer = res.data?.data?.[0] ?? null;
        if (!dealer) return null;
        return dealer.company || `${dealer.first_name} ${dealer.last_name}`.trim() || null;
    } catch {
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

/** Read per-customer machine context from Express session. */
function getSessionState(req: Request, customerId: string): MachineSessionState {
    const session = req.session as unknown as Record<string, unknown> & {
        machineContext?: Record<string, MachineSessionState>;
    };
    if (!session.machineContext) session.machineContext = {};
    if (!session.machineContext[customerId]) {
        session.machineContext[customerId] = { selected: null, recent: [] };
    }
    return session.machineContext[customerId];
}

/**
 * Resolve the default selected machine:
 * 1. Last selected stored in session (if still in assigned list)
 * 2. First machine sorted alphabetically
 */
function resolveDefaultMachine(machines: Machine[], sessionState: MachineSessionState): Machine | null {
    if (!machines.length) return null;
    if (sessionState.selected) {
        const found = machines.find(m => m.serial === sessionState.selected);
        if (found) return found;
    }
    return machines[0];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/:customerId/header-context
 *
 * Returns all data needed for the machine-selector sub-header and account
 * summary card in one response.
 *
 * BC OOTB calls (single parallel batch):
 *   - GET /v3/customers/:id/metafields?namespace=okuma  → machines, dealer_id, dealer flag
 *   - GET /v3/customers?id:in=:id                       → company, phone, email
 *   - GET /v3/customers?id:in=:dealerId                 → dealer display name
 *
 * Response for dealer:        { isDealer: true }
 * Response for regular user:
 * {
 *   isDealer: false,
 *   customer:        { firstName, lastName, email, company, phone },
 *   dealerName:      "ABC Industries" | null,
 *   selectedMachine: { model, serial, display, installDate, status } | null,
 *   machines:        [...],       // all active, sorted A→Z
 *   recentMachines:  [...]        // last 5 selected, most-recent first
 * }
 */
router.get('/api/customer/:customerId/header-context', async (req, res) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        // Single okuma metafield call + customer profile in parallel
        const [meta, profile] = await Promise.all([fetchOkumaMetafields(customerId), fetchCustomerProfile(customerId)]);

        // Dealers have registered_customers metafield — sub-header not shown for them
        if (meta.registered_customers !== undefined) {
            return res.json({ isDealer: true });
        }

        const machines = parseMachines(meta.registered_machines);

        // Fetch dealer name only if dealer_id exists
        const dealerName = meta.dealer_id ? await fetchDealerName(meta.dealer_id) : null;

        const sessionState = getSessionState(req, customerId);
        const selectedMachine = resolveDefaultMachine(machines, sessionState);

        const recentMachines = (sessionState.recent ?? [])
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
        console.error(`customer ${customerId}: header-context failed:`, (err as Error).message);
        return res.status(500).json({ error: 'Could not load customer context.' });
    }
});

/**
 * POST /api/customer/:customerId/machine/select
 *
 * Persists the selected machine in session and prepends it to recent list.
 * Called by the frontend AFTER the user confirms cart clearance (if needed).
 *
 * Body:     { "serial": "M5-2891-K" }
 * Response: { "selectedMachine": { model, serial, display, installDate, status } }
 */
router.post('/api/customer/:customerId/machine/select', async (req, res) => {
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

        const sessionState = getSessionState(req, customerId);
        sessionState.selected = machine.serial;
        sessionState.recent = [machine.serial, ...(sessionState.recent ?? []).filter(s => s !== machine.serial)].slice(
            0,
            RECENT_MACHINES_LIMIT
        );

        return res.json({ selectedMachine: machine });
    } catch (err) {
        console.error(`customer ${customerId}: machine select failed:`, (err as Error).message);
        return res.status(500).json({ error: 'Could not select machine.' });
    }
});

export default router;
