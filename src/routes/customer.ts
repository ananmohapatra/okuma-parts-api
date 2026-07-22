import axios from 'axios';
import { Router, Request, Response } from 'express';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import fetchCustomerProfile, { BcCustomer } from '../services/customerProfile';
import {
    B2BCompanyRecord,
    buildCompanyExtraFieldsMap,
    fetchB2BCompanyById,
    fetchB2BCompanyByUserEmail,
    upsertB2BCompanyExtraField,
    upsertB2BCompanyExtraFields,
} from '../services/b2b-company';
import { fetchB2BUserByEmail, buildExtraFieldsMap as buildUserExtraFieldsMap } from '../services/b2b-user';
import logger from '../config/logger';
import authenticateBCToken from '../middleware/auth';
import config from '../config';

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
    pubNos: string[];
    hasPartsBook: boolean;
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
interface B2BMachinesResult {
    machines: Machine[];
    companyId: number | null;
    accountNumber: string | null;
    relationshipType: string | null;
    distributorId: string | null;
    company: B2BCompanyRecord | null;
    companyExtraFields: Record<string, string | undefined>;
}

const EMPTY_MACHINES_RESULT: B2BMachinesResult = {
    machines: [],
    companyId: null,
    accountNumber: null,
    relationshipType: null,
    distributorId: null,
    company: null,
    companyExtraFields: {},
};

async function fetchB2BMachines(email: string): Promise<B2BMachinesResult> {
    try {
        const usersRes = await b2bClient.get<{ data: Array<{ companyId?: number }> }>('/api/v3/io/users', {
            params: { email },
        });
        const companyId = usersRes.data?.data?.[0]?.companyId ?? null;
        if (!companyId) return EMPTY_MACHINES_RESULT;

        const company = await fetchB2BCompanyById(companyId);
        const extraFields = company?.extraFields ?? [];
        const companyExtraFields = buildCompanyExtraFieldsMap(extraFields);
        const machinesField = extraFields.find(f => f.fieldName.toLowerCase() === 'machines');
        const accountNumber = extraFields.find(f => f.fieldName.toLowerCase() === 'account number')?.fieldValue ?? null;
        const relationshipType =
            extraFields.find(f => f.fieldName.toLowerCase() === 'relationship type')?.fieldValue ?? null;
        const distributorId = extraFields.find(f => f.fieldName.toLowerCase() === 'distributor id')?.fieldValue ?? null;
        if (!machinesField)
            return {
                machines: [],
                companyId,
                accountNumber,
                relationshipType,
                distributorId,
                company,
                companyExtraFields,
            };

        let raw: B2BMachineRecord[];
        try {
            const sanitized = machinesField.fieldValue.replace(/,(\s*[}\]])/g, '$1');
            const parsed = JSON.parse(sanitized);
            raw = Array.isArray(parsed) ? parsed : (parsed?.machines ?? []);
        } catch {
            logger.warn(`fetchB2BMachines: Machines field for company ${companyId} is not valid JSON`);
            return {
                machines: [],
                companyId,
                accountNumber,
                relationshipType,
                distributorId,
                company,
                companyExtraFields,
            };
        }

        logger.debug(
            `fetchB2BMachines company ${companyId}: raw=${raw.length} records — ${raw
                .map(m => `[model=${m.modelNo ?? '?'} serial=${m.serialNo ?? '(empty)'} status=${m.status ?? 'null'}]`)
                .join(', ')}`
        );

        const afterStatus = raw.filter(m => m.status?.toLowerCase() !== 'inactive');
        if (afterStatus.length !== raw.length) {
            logger.warn(
                `fetchB2BMachines company ${companyId}: dropped ${raw.length - afterStatus.length} inactive machines`
            );
        }

        const seenSerials = new Set<string>();
        const afterSerial = afterStatus.filter(m => {
            const serial = (m.serialNo ?? '').trim();
            if (!serial || seenSerials.has(serial)) return false;
            seenSerials.add(serial);
            return true;
        });
        if (afterSerial.length !== afterStatus.length) {
            logger.warn(
                `fetchB2BMachines company ${companyId}: dropped ${afterStatus.length - afterSerial.length} machines with missing/duplicate serialNo`
            );
        }

        const machines = afterSerial
            .map(m => {
                const pubNos = m.publicationNos ?? [];
                return {
                    model: m.modelNo ?? '',
                    serial: m.serialNo ?? '',
                    display: `${m.modelNo ?? ''} ${m.serialNo ?? ''}`.trim(),
                    installDate: m.installDate || 'pending',
                    status: m.status ?? null,
                    pubNos,
                    hasPartsBook: pubNos.length > 0,
                };
            })
            .sort((a, b) => {
                const cmp = a.model.localeCompare(b.model);
                return cmp !== 0 ? cmp : a.serial.localeCompare(b.serial);
            });
        return { machines, companyId, accountNumber, relationshipType, distributorId, company, companyExtraFields };
    } catch (err) {
        logger.warn(`fetchB2BMachines: ${(err as Error).message}`);
        return EMPTY_MACHINES_RESULT;
    }
}

/** Find a B2B company whose Account Number extra field matches the given value. */

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
 * The binding is sourced from the "Distributor ID" extra field on the customer's B2B company,
 * which holds the distributor's account number (string).
 *
 * Response: { dealerId: string, dealerName: string } | { dealerId: null, dealerName: null }
 */
router.get('/customer/:customerId/distributor', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const profile = await fetchCustomerProfile(customerId);
        if (!profile?.email) {
            return res.json({ dealerId: null, dealerName: null });
        }

        const [b2bResult, b2bUser] = await Promise.all([
            fetchB2BMachines(profile.email),
            fetchB2BUserByEmail(profile.email),
        ]);
        const userExtraFields = buildUserExtraFieldsMap(b2bUser?.extraFields);
        const dealerIdValue = userExtraFields.dealer_id ?? b2bResult.distributorId ?? null;

        if (!dealerIdValue) {
            return res.json({ dealerId: null, dealerName: null });
        }

        return res.json({
            dealerId: dealerIdValue,
            dealerName: b2bResult.company?.bcGroupName ?? null,
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
        const { machines } = profile?.email ? await fetchB2BMachines(profile.email) : { machines: [] };
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
 * Default machine priority: B2B last_viewed_machine extra field → session → first alphabetically.
 * Recent machines: B2B recent_machines extra field (survives logout) → session fallback, capped at 3.
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
        const profile = await fetchCustomerProfile(customerId);

        const [b2bResult, b2bUser] = await Promise.all([
            profile?.email ? fetchB2BMachines(profile.email) : Promise.resolve(EMPTY_MACHINES_RESULT),
            profile?.email ? fetchB2BUserByEmail(profile.email) : Promise.resolve(null),
        ]);
        const { machines, companyId, accountNumber, relationshipType, distributorId, companyExtraFields } = b2bResult;

        const userExtraFields = buildUserExtraFieldsMap(b2bUser?.extraFields);
        const jobTitle = userExtraFields.job_title ?? null;

        // relationshipType from B2B company extra fields identifies account type
        const isDealer = relationshipType?.toLowerCase() === 'distributor';

        // Dealers ARE the distributor — their dealerId is their own accountNumber and
        // dealerName is their own company. Non-dealers use their per-user dealer_id field,
        // falling back to the company-level distributorId for backward compatibility.
        let dealerId: string | null;
        let dealerName: string | null;
        if (isDealer) {
            dealerId = accountNumber ?? null;
            dealerName = b2bResult.company?.companyName ?? null;
        } else {
            dealerId = userExtraFields.dealer_id ?? distributorId ?? null;
            dealerName = b2bResult.company?.bcGroupName ?? null;
        }

        // readSessionState never mutates req.session — avoids a store write on every GET
        const sessionState = readSessionState(req, customerId);
        const selectedMachine = resolveDefaultMachine(
            machines,
            companyExtraFields.last_viewed_machine,
            sessionState.selected
        );

        const recentSerials = parseRecentSerials(companyExtraFields.recent_machines, sessionState.recent ?? []);
        const recentMachines = recentSerials
            .slice(0, RECENT_MACHINES_LIMIT)
            .map(serial => machines.find((m: Machine) => m.serial === serial))
            .filter((m): m is Machine => m !== undefined);

        return res.json({
            isDealer,
            customer: profile
                ? {
                      firstName: profile.first_name,
                      lastName: profile.last_name,
                      email: profile.email,
                      company: profile.company || null,
                      companyId,
                      relationshipType,
                      accountNumber,
                      phone: profile.phone || null,
                      jobTitle,
                  }
                : null,
            dealerId,
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
 * - Persists last_viewed_machine to B2B user extra field (survives logout, sets default on next visit)
 * - Persists recent_machines to B2B user extra field (survives logout, drives Recent section, capped at 3)
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
        const profile = await fetchCustomerProfile(customerId);
        const b2bResult = profile?.email ? await fetchB2BMachines(profile.email) : EMPTY_MACHINES_RESULT;
        const { machines, company, companyExtraFields } = b2bResult;

        const machine = machines.find(
            (m: Machine) => m.serial === serial.trim() && (model ? m.model === model.trim() : true)
        );

        if (!machine) {
            return res.status(404).json({
                error: `Machine with serial '${serial}'${model ? ` and model '${model}'` : ''} not found in customer's assigned machines.`,
            });
        }

        // Seed recent list from company extra field so cross-session history is preserved
        const sessionState = readSessionState(req, customerId);
        const baseRecent = parseRecentSerials(companyExtraFields.recent_machines, sessionState.recent ?? []);

        const updatedRecent = [machine.serial, ...baseRecent.filter(s => s !== machine.serial)].slice(
            0,
            RECENT_MACHINES_LIMIT
        );

        writeSessionState(req, customerId, { selected: machine.serial, recent: updatedRecent });

        const recentMachines = updatedRecent
            .map(s => machines.find((m: Machine) => m.serial === s))
            .filter((m): m is Machine => m !== undefined);

        // Batch both extra field writes into a single B2B PUT call
        if (company) {
            try {
                await upsertB2BCompanyExtraFields(company, {
                    last_viewed_machine: machine.serial,
                    recent_machines: JSON.stringify(updatedRecent),
                });
            } catch (err) {
                logger.error(
                    `customer ${customerId}: B2B company extra field upsert failed: ${(err as Error).message}`
                );
            }
        }

        return res.json({ selectedMachine: machine, recentMachines });
    } catch (err) {
        logger.error(`customer ${customerId}: machine select failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not select machine.' });
    }
});

/**
 * GET /customer/:customerId/searches
 *
 * Returns the customer's recent searched-customer history from the B2B user extra field.
 *
 * Response: { searches: CustomerSearchEntry[] }
 */
router.get('/customer/:customerId/searches', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    try {
        const profile = await fetchCustomerProfile(customerId);
        const company = profile?.email ? await fetchB2BCompanyByUserEmail(profile.email) : null;
        const companyExtraFields = buildCompanyExtraFieldsMap(company?.extraFields);
        const searches = parseRecentSearches(companyExtraFields.recent_customer_searches);
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
 * persists it to the B2B user extra field. Deduplicates by searchedCustomerId. Capped
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
    if (req.session.customerId !== customerId) {
        return res.status(403).json({ error: 'Forbidden.' });
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
        const profile = await fetchCustomerProfile(customerId);
        const company = profile?.email ? await fetchB2BCompanyByUserEmail(profile.email) : null;
        const companyExtraFields = buildCompanyExtraFieldsMap(company?.extraFields);
        const current = parseRecentSearches(companyExtraFields.recent_customer_searches);
        const updated = [entry, ...current.filter(s => s.customerId !== entry.customerId)].slice(
            0,
            RECENT_SEARCHES_LIMIT
        );

        if (company) {
            try {
                await upsertB2BCompanyExtraField(company, 'recent_customer_searches', JSON.stringify(updated));
            } catch (err) {
                logger.error(
                    `customer ${customerId}: searches B2B company extra field write failed: ${(err as Error).message}`
                );
            }
        }

        return res.json({ searches: updated });
    } catch (err) {
        logger.error(`customer ${customerId}: searches update failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not update recent searches.' });
    }
});

/**
 * GET /customer/:customerId/metafields?key=<key>
 *
 * General-purpose B2B user extra field proxy. Returns the raw value for the
 * given key, proxied server-side to avoid CORS.
 *
 * Query params:
 *   key        — required, e.g. "recent_customer_searches"
 *   namespace  — accepted but ignored (B2B extra fields have no namespace concept)
 *
 * Response: { customerId, key, value: string | null }
 */
router.get('/customer/:customerId/metafields', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;
    const { key } = req.query as Record<string, string>;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (!key || !key.trim()) {
        return res.status(400).json({ error: 'key query param is required.' });
    }

    try {
        const profile = await fetchCustomerProfile(customerId);
        const company = profile?.email ? await fetchB2BCompanyByUserEmail(profile.email) : null;
        const companyExtraFields = buildCompanyExtraFieldsMap(company?.extraFields);
        const value = companyExtraFields[key.trim()] ?? null;

        return res.json({
            customerId: parseInt(customerId, 10),
            key: key.trim(),
            value,
        });
    } catch (err) {
        logger.error(`customer ${customerId}: extra field fetch [${key}] failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load extra field.' });
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

/**
 * GET /customer/company/:companyId/default-addresses
 *
 * Proxy for the B2B OOTB endpoint that returns default billing/shipping addresses
 * for a company. FE cannot call this directly due to CORS; the backend forwards
 * the customer's own B2B JWT so no server-side secret is exposed to the browser.
 *
 * The caller must supply the B2B storefront token (obtained from
 * GET /v1/customer/:customerId/b2b-token) as `Authorization: Bearer <token>`.
 *
 * Response: the raw JSON from https://api-b2b.bigcommerce.com/api/v2/companies/{companyId}/default-addresses
 */
router.get(
    '/customer/company/:companyId/default-addresses',
    async (req: Request<{ companyId: string }>, res: Response) => {
        const { companyId } = req.params;

        if (!companyId || !/^\d+$/.test(companyId)) {
            return res.status(400).json({ error: 'Invalid companyId.' });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res
                .status(401)
                .json({ error: 'Missing or invalid Authorization header. Expected: Bearer <b2b-token>.' });
        }

        try {
            const ootbRes = await axios.get(
                `${config.bc.b2bApiBaseUrl}/api/v2/companies/${companyId}/default-addresses`,
                {
                    headers: {
                        Authorization: authHeader,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    timeout: 10000,
                }
            );
            return res.json(ootbRes.data);
        } catch (err) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 401 || status === 403) {
                return res.status(status).json({ error: 'B2B token invalid or expired.' });
            }
            if (status === 404) {
                return res.status(404).json({ error: 'Company not found.' });
            }
            logger.error(`company ${companyId}: default-addresses fetch failed: ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not load default addresses.' });
        }
    }
);

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
