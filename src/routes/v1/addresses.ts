import { Router, Request, Response } from 'express';
import b2bClient from '../../services/b2b';
import logger from '../../config/logger';

const router = Router();

// The pre-configured B2B address extra field name for approval workflow
const APPROVAL_STATUS_FIELD = 'Approval Status';
type ApprovalStatus = 'pending' | 'approved' | 'rejected';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface B2BAddressExtraField {
    fieldName: string;
    fieldValue: string;
    fieldType?: number;
}

interface B2BAddress {
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
    externalId: string;
    createdAt: number;
    updatedAt: number;
    extraFields?: B2BAddressExtraField[];
}

interface B2BAddressesResponse {
    code: number;
    data: B2BAddress[];
    meta: {
        pagination: { totalCount: number; offset: number; limit: number };
        message: string;
    };
}

interface B2BSingleAddressResponse {
    code: number;
    data: B2BAddress;
}

interface CreateAddressBody {
    firstName: string;
    lastName: string;
    companyId: number;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateName: string;
    countryName: string;
    zipCode?: string;
    phoneNumber?: string;
    label?: string;
    isBilling?: number;
    isShipping?: number;
    isDefaultBilling?: number;
    isDefaultShipping?: number;
    extraFields?: B2BAddressExtraField[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApprovalStatus(extraFields?: B2BAddressExtraField[]): ApprovalStatus | null {
    const field = (extraFields ?? []).find(f => f.fieldName === APPROVAL_STATUS_FIELD);
    if (!field) return null;
    const v = field.fieldValue.toLowerCase();
    if (v === 'approved' || v === 'rejected' || v === 'pending') return v;
    return null;
}

function mapAddress(a: B2BAddress) {
    return {
        addressId: a.addressId,
        label: a.label || null,
        firstName: a.firstName,
        lastName: a.lastName,
        phoneNumber: a.phoneNumber || null,
        addressLine1: a.addressLine1,
        addressLine2: a.addressLine2 || null,
        city: a.city,
        state: a.stateName,
        stateCode: a.stateCode,
        zip: a.zipCode,
        country: a.countryName,
        countryCode: a.countryCode,
        isBilling: a.isBilling,
        isShipping: a.isShipping,
        isDefaultBilling: a.isDefaultBilling,
        isDefaultShipping: a.isDefaultShipping,
        externalId: a.externalId || null,
        companyId: a.companyId,
        approvalStatus: getApprovalStatus(a.extraFields),
    };
}

async function fetchAddressById(addressId: string): Promise<B2BAddress | null> {
    try {
        const res = await b2bClient.get<B2BSingleAddressResponse>(`/api/v3/io/addresses/${addressId}`);
        return res.data?.data ?? null;
    } catch {
        return null;
    }
}

async function setApprovalStatus(addressId: string, status: ApprovalStatus): Promise<boolean> {
    const address = await fetchAddressById(addressId);
    if (!address) return false;

    const otherFields = (address.extraFields ?? []).filter(f => f.fieldName !== APPROVAL_STATUS_FIELD);

    await b2bClient.put(`/api/v3/io/addresses/${addressId}`, {
        firstName: address.firstName,
        lastName: address.lastName,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2,
        city: address.city,
        stateName: address.stateName,
        countryName: address.countryName,
        zipCode: address.zipCode,
        phoneNumber: address.phoneNumber,
        label: address.label,
        isBilling: address.isBilling ? 1 : 0,
        isShipping: address.isShipping ? 1 : 0,
        isDefaultBilling: address.isDefaultBilling ? 1 : 0,
        isDefaultShipping: address.isDefaultShipping ? 1 : 0,
        companyId: Number(address.companyId),
        extraFields: [...otherFields, { fieldName: APPROVAL_STATUS_FIELD, fieldValue: status }],
    });
    return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /v1/api/addresses?companyId=13675067&limit=10&page=1
router.get('/addresses', async (req: Request, res: Response) => {
    try {
        const companyIdRaw = req.query.companyId as string | undefined;
        const limitRaw = Number(req.query.limit);
        const pageRaw = Number(req.query.page);
        const statusFilter = req.query.approvalStatus as ApprovalStatus | undefined;

        if (!companyIdRaw || !/^\d+$/.test(companyIdRaw)) {
            return res.status(400).json({ error: 'companyId must be a positive integer' });
        }

        const companyId = Number(companyIdRaw);
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
        const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
        const offset = (page - 1) * limit;

        const b2bRes = await b2bClient.get<B2BAddressesResponse>('/api/v3/io/addresses', {
            params: { companyId, limit, offset },
        });

        const list: B2BAddress[] = b2bRes.data?.data ?? [];
        const b2bPagination = b2bRes.data?.meta?.pagination;
        const totalCount = b2bPagination?.totalCount ?? list.length;
        const totalPages = Math.ceil(totalCount / limit) || 1;

        // Fetch full detail for each address to get extraFields (list endpoint omits them)
        const detailed = await Promise.all(
            list.map(a => fetchAddressById(String(a.addressId)).then(full => full ?? a))
        );

        let addresses = detailed.map(mapAddress);
        if (statusFilter) {
            addresses = addresses.filter(a => a.approvalStatus === statusFilter);
        }

        return res.json({
            pagination: { total: totalCount, perPage: limit, currentPage: page, totalPages, offset },
            data: addresses,
        });
    } catch (err) {
        logger.error(`Addresses GET error: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to fetch addresses' });
    }
});

// POST /v1/api/addresses
// Creates address under Pending Approval status (customer-initiated request)
router.post('/addresses', async (req: Request, res: Response) => {
    try {
        const body = req.body as Partial<CreateAddressBody>;

        const missing = (
            ['firstName', 'lastName', 'companyId', 'addressLine1', 'city', 'stateName', 'countryName'] as const
        ).filter(f => !body[f]);
        if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
        }

        if (!Number.isInteger(Number(body.companyId)) || Number(body.companyId) <= 0) {
            return res.status(400).json({ error: 'companyId must be a positive integer' });
        }

        const payload: CreateAddressBody = {
            firstName: body.firstName as string,
            lastName: body.lastName as string,
            companyId: Number(body.companyId),
            addressLine1: body.addressLine1 as string,
            addressLine2: body.addressLine2,
            city: body.city as string,
            stateName: body.stateName as string,
            countryName: body.countryName as string,
            zipCode: body.zipCode,
            phoneNumber: body.phoneNumber,
            label: body.label,
            isBilling: body.isBilling ?? 0,
            isShipping: body.isShipping ?? 0,
            isDefaultBilling: body.isDefaultBilling ?? 0,
            isDefaultShipping: body.isDefaultShipping ?? 0,
            extraFields: [{ fieldName: APPROVAL_STATUS_FIELD, fieldValue: 'pending' }],
        };

        const b2bRes = await b2bClient.post<B2BSingleAddressResponse>('/api/v3/io/addresses', payload);
        const created = b2bRes.data?.data;

        if (!created) {
            logger.error(`Addresses create: unexpected B2B response for companyId ${payload.companyId}`);
            return res.status(502).json({ error: 'Unexpected response from B2B API' });
        }

        // Fetch full record so extraFields are populated in the response
        const full = await fetchAddressById(String(created.addressId));

        return res.status(201).json(mapAddress(full ?? created));
    } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 400) {
            return res
                .status(400)
                .json({ error: 'Invalid address data — check required fields and country/state names' });
        }
        logger.error(`Addresses create error: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to create address' });
    }
});

// PATCH /v1/api/addresses/:addressId/approve
// Dealer/distributor approves a pending address request
router.patch('/addresses/:addressId/approve', async (req: Request, res: Response) => {
    const { addressId } = req.params as Record<string, string>;

    if (!/^\d+$/.test(addressId)) {
        return res.status(400).json({ error: 'Invalid addressId' });
    }

    try {
        const ok = await setApprovalStatus(addressId, 'approved');
        if (!ok) return res.status(404).json({ error: `Address ${addressId} not found` });

        logger.info(`Address ${addressId} approved`);
        return res.json({ addressId: Number(addressId), approvalStatus: 'approved' });
    } catch (err) {
        logger.error(`Addresses approve error (${addressId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to approve address' });
    }
});

// PATCH /v1/api/addresses/:addressId/reject
// Dealer/distributor rejects a pending address request
router.patch('/addresses/:addressId/reject', async (req: Request, res: Response) => {
    const { addressId } = req.params as Record<string, string>;

    if (!/^\d+$/.test(addressId)) {
        return res.status(400).json({ error: 'Invalid addressId' });
    }

    try {
        const ok = await setApprovalStatus(addressId, 'rejected');
        if (!ok) return res.status(404).json({ error: `Address ${addressId} not found` });

        logger.info(`Address ${addressId} rejected`);
        return res.json({ addressId: Number(addressId), approvalStatus: 'rejected' });
    } catch (err) {
        logger.error(`Addresses reject error (${addressId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to reject address' });
    }
});

export default router;
