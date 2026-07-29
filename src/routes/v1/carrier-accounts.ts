import { Router, Request, Response } from 'express';
import bcClient from '../../services/bigcommerce';
import logger from '../../config/logger';

const router = Router();

const OKUMA_NAMESPACE = 'okuma';
const CARRIER_ACCOUNTS_KEY = 'carrier_accounts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BcMetafield {
    id: number;
    namespace: string;
    key: string;
    value: string;
    permission_set: string;
}

interface BcMetafieldsResponse {
    data: BcMetafield[];
}

interface FedExUPSAccount {
    accountNumber: string;
}

interface MachineDownAccount {
    accountNumber: string;
    contactName: string;
    contactPhone: string;
}

interface CarrierAccountMap {
    FedEx?: FedExUPSAccount;
    UPS?: FedExUPSAccount;
    MachineDown?: MachineDownAccount;
}

interface PutCarrierAccountBody {
    carrier?: unknown;
    accountNumber?: unknown;
    contactName?: unknown;
    contactPhone?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the carrier_accounts metafield for a BC customer.
 * Returns { metafieldId, accounts } — metafieldId is null when the field does not exist yet.
 */
async function fetchCarrierMetafield(
    customerId: string
): Promise<{ metafieldId: number | null; accounts: CarrierAccountMap }> {
    const res = await bcClient.get<BcMetafieldsResponse>(`/v3/customers/${customerId}/metafields`, {
        params: { namespace: OKUMA_NAMESPACE, key: CARRIER_ACCOUNTS_KEY },
    });
    const existing = res.data?.data?.[0] ?? null;
    if (!existing) return { metafieldId: null, accounts: {} };
    try {
        return { metafieldId: existing.id, accounts: JSON.parse(existing.value) as CarrierAccountMap };
    } catch {
        return { metafieldId: existing.id, accounts: {} };
    }
}

/**
 * Write the carrier_accounts metafield for a BC customer.
 * Creates the metafield on first use; updates it in place on subsequent calls.
 */
async function saveCarrierMetafield(
    customerId: string,
    metafieldId: number | null,
    accounts: CarrierAccountMap
): Promise<void> {
    const value = JSON.stringify(accounts);
    if (metafieldId === null) {
        await bcClient.post(`/v3/customers/${customerId}/metafields`, {
            namespace: OKUMA_NAMESPACE,
            key: CARRIER_ACCOUNTS_KEY,
            value,
            permission_set: 'write',
        });
    } else {
        await bcClient.put(`/v3/customers/${customerId}/metafields/${metafieldId}`, { value });
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /v1/api/customer/:customerId/carrier-accounts
 *
 * Returns carrier account info stored for this BC customer.
 * Backed by a BC customer metafield (namespace=okuma, key=carrier_accounts).
 *
 * Response: { accounts: { FedEx?, UPS?, MachineDown? } }
 */
router.get('/customer/:customerId/carrier-accounts', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!/^\d+$/.test(customerId) || parseInt(customerId, 10) < 1) {
        return res.status(400).json({ error: 'customerId must be a positive integer' });
    }

    try {
        const { accounts } = await fetchCarrierMetafield(customerId);
        return res.json({ accounts });
    } catch (err) {
        logger.error(`carrier-accounts GET (customerId=${customerId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to fetch carrier accounts' });
    }
});

/**
 * PUT /v1/api/customer/:customerId/carrier-accounts
 *
 * Store or update one carrier account entry for a BC customer.
 * Existing entries for other carriers are preserved (merge, not replace).
 *
 * Body (FedEx / UPS):  { carrier: "FedEx" | "UPS", accountNumber: string }
 * Body (MachineDown):  { carrier: "MachineDown", accountNumber: string, contactName: string, contactPhone: string }
 *
 * Response: { accounts: { FedEx?, UPS?, MachineDown? } } — full updated map
 */
router.put('/customer/:customerId/carrier-accounts', async (req: Request<{ customerId: string }>, res: Response) => {
    const { customerId } = req.params;

    if (!/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'customerId must be a positive integer' });
    }

    const { carrier, accountNumber, contactName, contactPhone } = req.body as PutCarrierAccountBody;

    if (!carrier || typeof carrier !== 'string') {
        return res.status(400).json({ error: 'carrier is required (FedEx, UPS, MachineDown)' });
    }
    if (carrier !== 'FedEx' && carrier !== 'UPS' && carrier !== 'MachineDown') {
        return res.status(400).json({ error: 'carrier must be one of: FedEx, UPS, MachineDown' });
    }
    if (!accountNumber || typeof accountNumber !== 'string' || !(accountNumber as string).trim()) {
        return res.status(400).json({ error: 'accountNumber is required' });
    }
    if (carrier === 'MachineDown') {
        if (!contactName || typeof contactName !== 'string' || !(contactName as string).trim()) {
            return res.status(400).json({ error: 'contactName is required for MachineDown' });
        }
        if (!contactPhone || typeof contactPhone !== 'string' || !(contactPhone as string).trim()) {
            return res.status(400).json({ error: 'contactPhone is required for MachineDown' });
        }
    }

    try {
        const { metafieldId, accounts } = await fetchCarrierMetafield(customerId);

        if (carrier === 'MachineDown') {
            accounts.MachineDown = {
                accountNumber: (accountNumber as string).trim(),
                contactName: (contactName as string).trim(),
                contactPhone: (contactPhone as string).trim(),
            };
        } else {
            accounts[carrier as 'FedEx' | 'UPS'] = { accountNumber: (accountNumber as string).trim() };
        }

        await saveCarrierMetafield(customerId, metafieldId, accounts);

        logger.info(`carrier-accounts updated customerId=${customerId} carrier=${carrier}`);
        return res.json({ accounts });
    } catch (err) {
        logger.error(`carrier-accounts PUT (customerId=${customerId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to update carrier account' });
    }
});

export default router;
