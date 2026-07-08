"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bigcommerce_1 = __importDefault(require("../services/bigcommerce"));
const router = (0, express_1.Router)();
const RECENT_MACHINES_LIMIT = 3;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Fetch all okuma-namespace metafields for a customer in one BC OOTB call.
 * BC OOTB: GET /v3/customers/:id/metafields?namespace=okuma
 */
async function fetchOkumaMetafields(customerId) {
    const res = await bigcommerce_1.default.get(`/v3/customers/${customerId}/metafields`, { params: { namespace: 'okuma' } });
    const fields = res.data?.data ?? [];
    const map = {};
    fields.forEach(f => {
        map[f.key] = f.value;
    });
    return map;
}
/**
 * Fetch customer profile (company, phone, email) from BC OOTB customers API.
 * BC OOTB: GET /v3/customers?id:in=:customerId
 */
async function fetchCustomerProfile(customerId) {
    try {
        const res = await bigcommerce_1.default.get('/v3/customers', {
            params: { 'id:in': customerId },
        });
        return res.data?.data?.[0] ?? null;
    }
    catch {
        return null;
    }
}
/**
 * Fetch the dealer's display name from BC.
 * Prefers company field; falls back to first + last name.
 * BC OOTB: GET /v3/customers?id:in=:dealerId
 */
async function fetchDealerName(dealerId) {
    try {
        const res = await bigcommerce_1.default.get('/v3/customers', {
            params: { 'id:in': dealerId },
        });
        const dealer = res.data?.data?.[0] ?? null;
        if (!dealer)
            return null;
        return dealer.company || `${dealer.first_name} ${dealer.last_name}`.trim() || null;
    }
    catch {
        return null;
    }
}
/**
 * Parse and normalise the registered_machines metafield value.
 * Filters inactive machines, adds display string, sorts alphabetically.
 */
function parseMachines(raw) {
    if (!raw)
        return [];
    let list;
    try {
        list = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];
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
 * Persist the recent machines list to the customer's BC metafield.
 * Creates the metafield on first write; updates it on subsequent writes.
 * BC OOTB:
 *   GET /v3/customers/:id/metafields?namespace=okuma&key=recent_machines → check existence + get id
 *   POST /v3/customers/:id/metafields → create
 *   PUT  /v3/customers/:id/metafields/:metafieldId → update
 */
async function upsertRecentMachines(customerId, serials) {
    const value = JSON.stringify(serials);
    const getRes = await bigcommerce_1.default.get(`/v3/customers/${customerId}/metafields`, { params: { namespace: 'okuma', key: 'recent_machines' } });
    const existing = getRes.data?.data?.[0] ?? null;
    if (existing) {
        await bigcommerce_1.default.put(`/v3/customers/${customerId}/metafields/${existing.id}`, {
            value,
            namespace: 'okuma',
            key: 'recent_machines',
            permission_set: 'read_and_sf_access',
        });
    }
    else {
        await bigcommerce_1.default.post(`/v3/customers/${customerId}/metafields`, {
            value,
            namespace: 'okuma',
            key: 'recent_machines',
            permission_set: 'read_and_sf_access',
        });
    }
}
/** Read per-customer machine context from Express session. */
function getSessionState(req, customerId) {
    const session = req.session;
    if (!session.machineContext)
        session.machineContext = {};
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
function resolveDefaultMachine(machines, sessionState) {
    if (!machines.length)
        return null;
    if (sessionState.selected) {
        const found = machines.find(m => m.serial === sessionState.selected);
        if (found)
            return found;
    }
    return machines[0];
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * GET /api/customer/:customerId/machines
 *
 * Returns the list of active registered machines for a customer.
 *
 * Response: { machines: [{ model, serial, display, installDate, status }] }
 */
router.get('/api/customer/:customerId/machines', async (req, res) => {
    const { customerId } = req.params;
    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    try {
        const meta = await fetchOkumaMetafields(customerId);
        const machines = parseMachines(meta.registered_machines);
        return res.json({ machines });
    }
    catch (err) {
        console.error(`customer ${customerId}: machines fetch failed:`, err.message);
        return res.status(500).json({ error: 'Could not load customer machines.' });
    }
});
/**
 * GET /api/customer/:customerId/header-context
 *
 * Returns all data needed for the machine-selector sub-header and account
 * summary card in one response.
 *
 * BC OOTB calls (single parallel batch):
 *   - GET /v3/customers/:id/metafields?namespace=okuma  → machines, dealer_id, dealer flag, recent_machines
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
 *   machines:        [...],         // all active, sorted A→Z
 *   recentMachines:  [...]          // last 3 selected, most-recent first (from metafield, session fallback)
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
        // Stamp customerId into session so downstream auth guards can use it
        req.session.customerId = customerId;
        // Dealers have registered_customers metafield — sub-header not shown for them
        if (meta.registered_customers !== undefined) {
            return res.json({ isDealer: true });
        }
        const machines = parseMachines(meta.registered_machines);
        // Fetch dealer name only if dealer_id exists
        const dealerName = meta.dealer_id ? await fetchDealerName(meta.dealer_id) : null;
        const sessionState = getSessionState(req, customerId);
        const selectedMachine = resolveDefaultMachine(machines, sessionState);
        // Recent machines: prefer BC metafield (survives logout) over session
        let recentSerials = [];
        if (meta.recent_machines) {
            try {
                recentSerials = JSON.parse(meta.recent_machines);
            }
            catch {
                recentSerials = sessionState.recent ?? [];
            }
        }
        else {
            recentSerials = sessionState.recent ?? [];
        }
        const recentMachines = recentSerials
            .map(serial => machines.find(m => m.serial === serial))
            .filter((m) => m !== undefined);
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
    }
    catch (err) {
        console.error(`customer ${customerId}: header-context failed:`, err.message);
        return res.status(500).json({ error: 'Could not load customer context.' });
    }
});
/**
 * POST /api/customer/:customerId/machine/select
 *
 * Persists the selected machine in session and in BC customer metafield
 * (okuma/recent_machines) so the recent list survives session clear and logout.
 * Capped at RECENT_MACHINES_LIMIT (3) entries, most-recent first.
 *
 * Body:     { "serial": "M5-2891-K" }
 * Response: { "selectedMachine": { model, serial, display, installDate, status } }
 */
router.post('/api/customer/:customerId/machine/select', async (req, res) => {
    const { customerId } = req.params;
    const { serial } = req.body;
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
        // Build updated recent list
        const sessionState = getSessionState(req, customerId);
        const updatedRecent = [
            machine.serial,
            ...(sessionState.recent ?? []).filter(s => s !== machine.serial),
        ].slice(0, RECENT_MACHINES_LIMIT);
        // Update session
        sessionState.selected = machine.serial;
        sessionState.recent = updatedRecent;
        // Persist to BC metafield (fire-and-forget — don't block the response)
        upsertRecentMachines(customerId, updatedRecent).catch(err => {
            console.error(`customer ${customerId}: failed to persist recent machines:`, err.message);
        });
        return res.json({ selectedMachine: machine });
    }
    catch (err) {
        console.error(`customer ${customerId}: machine select failed:`, err.message);
        return res.status(500).json({ error: 'Could not select machine.' });
    }
});
exports.default = router;
//# sourceMappingURL=customer.js.map