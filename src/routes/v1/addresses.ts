import { Router, Request, Response } from 'express';
import b2bClient from '../../services/b2b';
import { fetchB2BCompanyById, fetchB2BCompanyByUserEmail } from '../../services/b2b-company';
import { buildExtraFieldsMap } from '../../services/b2b-user';
import fetchCustomerProfile from '../../services/customerProfile';
import logger from '../../config/logger';

const router = Router();

// Pre-configured B2B address extra field name for the approval workflow
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
    isBilling?: number | boolean;
    isShipping?: number | boolean;
    isDefaultBilling?: number | boolean;
    isDefaultShipping?: number | boolean;
    extraFields?: B2BAddressExtraField[];
}

const BATCH_CONCURRENCY = 10;

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
        createdAt: a.createdAt ?? null,
        updatedAt: a.updatedAt ?? null,
        approvalStatus: getApprovalStatus(a.extraFields),
    };
}

async function mapInBatches<T, U>(
    items: T[],
    mapper: (item: T) => Promise<U>,
    index = 0,
    accumulated: U[] = []
): Promise<U[]> {
    if (index >= items.length) return accumulated;

    const batch = items.slice(index, index + BATCH_CONCURRENCY);
    const mapped = await Promise.all(batch.map(mapper));
    return mapInBatches(items, mapper, index + BATCH_CONCURRENCY, [...accumulated, ...mapped]);
}

async function fetchAddressById(addressId: string): Promise<B2BAddress | null> {
    try {
        const res = await b2bClient.get<B2BSingleAddressResponse>(`/api/v3/io/addresses/${addressId}`);
        return res.data?.data ?? null;
    } catch {
        return null;
    }
}

async function applyApprovalStatus(address: B2BAddress, status: ApprovalStatus): Promise<void> {
    const otherFields = (address.extraFields ?? []).filter(f => f.fieldName !== APPROVAL_STATUS_FIELD);

    // Approved → enable for both shipping and billing.
    // Pending / rejected → locked (false) so the address cannot be selected at checkout.
    const usable = status === 'approved';

    await b2bClient.put(`/api/v3/io/addresses/${address.addressId}`, {
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
        isBilling: usable,
        isShipping: usable,
        isDefaultBilling: false,
        isDefaultShipping: false,
        companyId: Number(address.companyId),
        extraFields: [...otherFields, { fieldName: APPROVAL_STATUS_FIELD, fieldValue: status }],
    });
}

/**
 * Returns the distributor's account_number if the BC customer has relationship_type = distributor,
 * or null if the customer is not a distributor or cannot be resolved.
 */
async function resolveDistributorAccountNumber(distributorId: string): Promise<string | null> {
    const profile = await fetchCustomerProfile(distributorId);
    if (!profile?.email) return null;
    const company = await fetchB2BCompanyByUserEmail(profile.email);
    if (!company) return null;
    const fields = buildExtraFieldsMap(company.extraFields);
    if (fields.relationship_type?.toLowerCase() !== 'distributor') return null;
    return fields.account_number ?? null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Fetch all B2B customer company IDs whose distributor_id matches the given account number.
 * The company list endpoint omits extraFields, so each company is fetched individually for its detail.
 */
async function fetchCompanyStubs(
    offset: number,
    accumulated: Array<{ companyId: number }>
): Promise<Array<{ companyId: number }>> {
    const PAGE = 250;
    const res = await b2bClient.get<{ data: Array<{ companyId: number }> }>('/api/v3/io/companies', {
        params: { limit: PAGE, offset },
    });
    const page = res.data?.data ?? [];
    const all = [...accumulated, ...page];
    return page.length < PAGE ? all : fetchCompanyStubs(offset + PAGE, all);
}

async function fetchDistributorCustomerCompanyIds(accountNumber: string): Promise<number[]> {
    const stubs = await fetchCompanyStubs(0, []);
    const details = await mapInBatches(stubs, stub => fetchB2BCompanyById(stub.companyId));
    return details
        .filter((c): c is NonNullable<typeof c> => {
            if (!c) return false;
            const fields = buildExtraFieldsMap(c.extraFields);
            return fields.distributor_id === accountNumber;
        })
        .map(c => c.companyId);
}

/**
 * Fetch all addresses for a single company, enriched with extraFields.
 */
async function fetchAddressPage(companyId: number, offset: number, accumulated: B2BAddress[]): Promise<B2BAddress[]> {
    const PAGE = 250;
    const res = await b2bClient.get<B2BAddressesResponse>('/api/v3/io/addresses', {
        params: { companyId, limit: PAGE, offset },
    });
    const page = res.data?.data ?? [];
    const all = [...accumulated, ...page];
    return page.length < PAGE ? all : fetchAddressPage(companyId, offset + PAGE, all);
}

async function fetchAllAddressesForCompany(companyId: number): Promise<B2BAddress[]> {
    const all = await fetchAddressPage(companyId, 0, []);
    return mapInBatches(all, address => fetchAddressById(String(address.addressId)).then(full => full ?? address));
}

// GET /v1/api/addresses?companyId=13802422&approvalStatus=pending&limit=20&page=1
// GET /v1/api/addresses?distributorId=326&companyId=13802422&approvalStatus=pending&limit=20&page=1
// distributorId is optional. When provided, scopes results to the distributor's customers.
// When omitted, companyId is required and addresses are returned directly for that company.
router.get('/addresses', async (req: Request, res: Response) => {
    try {
        const distributorIdRaw = req.query.distributorId as string | undefined;
        const companyIdRaw = req.query.companyId as string | undefined;
        const limitRaw = Number(req.query.limit);
        const pageRaw = Number(req.query.page);

        if (distributorIdRaw !== undefined && !/^\d+$/.test(distributorIdRaw)) {
            return res.status(400).json({ error: 'distributorId must be a positive integer' });
        }
        if (companyIdRaw !== undefined && !/^\d+$/.test(companyIdRaw)) {
            return res.status(400).json({ error: 'companyId must be a positive integer' });
        }

        let statusFilter: ApprovalStatus | undefined;
        const statusFilterRaw = req.query.approvalStatus;
        if (typeof statusFilterRaw === 'string') {
            const s = statusFilterRaw.toLowerCase();
            if (s === 'pending' || s === 'approved' || s === 'rejected') statusFilter = s;
            else return res.status(400).json({ error: 'approvalStatus must be one of: pending, approved, rejected' });
        }

        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 250) : 50;
        const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;

        let companyIds: number[];

        if (distributorIdRaw) {
            // Distributor flow: validate distributor and scope to their customers
            const accountNumber = await resolveDistributorAccountNumber(distributorIdRaw);
            if (!accountNumber) {
                return res.status(403).json({ error: 'Forbidden: only distributors may view address requests' });
            }

            if (companyIdRaw) {
                // Validate the requested company belongs to this distributor
                const company = await fetchB2BCompanyById(Number(companyIdRaw));
                if (!company) {
                    return res.status(502).json({ error: 'Unable to resolve requested company from B2B API' });
                }
                const companyFields = buildExtraFieldsMap(company.extraFields);
                if (companyFields.distributor_id !== accountNumber) {
                    return res.status(403).json({ error: 'Forbidden: this company does not belong to your customers' });
                }
                companyIds = [Number(companyIdRaw)];
            } else {
                companyIds = await fetchDistributorCustomerCompanyIds(accountNumber);
            }
        } else {
            // Customer flow: companyId is required when distributorId is not provided
            if (!companyIdRaw) {
                return res.status(400).json({ error: 'companyId is required when distributorId is not provided' });
            }
            companyIds = [Number(companyIdRaw)];
        }

        if (companyIds.length === 0) {
            return res.json({
                pagination: { total: 0, perPage: limit, currentPage: page, totalPages: 0, offset: 0 },
                data: [],
            });
        }

        // Fetch and enrich addresses for all companies with bounded concurrency
        const nested = await mapInBatches(companyIds, fetchAllAddressesForCompany);
        let addresses = nested.flat().map(mapAddress);

        if (statusFilter) {
            addresses = addresses.filter(a => a.approvalStatus === statusFilter);
        }

        // Sort by creation date descending (newest first)
        addresses.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

        const total = addresses.length;
        const totalPages = Math.ceil(total / limit) || 1;
        const offset = (page - 1) * limit;
        const paginated = addresses.slice(offset, offset + limit);

        return res.json({
            pagination: { total, perPage: limit, currentPage: page, totalPages, offset },
            data: paginated,
        });
    } catch (err) {
        logger.error(`Addresses GET error: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to fetch addresses' });
    }
});

// POST /v1/api/addresses
// Creates an address. If distributorId is provided and the caller is a distributor,
// the address is immediately approved. Otherwise it is created as pending.
router.post('/addresses', async (req: Request, res: Response) => {
    try {
        const body = req.body as Partial<CreateAddressBody> & { distributorId?: unknown };

        const missing = (
            ['firstName', 'lastName', 'companyId', 'addressLine1', 'city', 'stateName', 'countryName'] as const
        ).filter(f => !body[f]);
        if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
        }

        if (!Number.isInteger(Number(body.companyId)) || Number(body.companyId) <= 0) {
            return res.status(400).json({ error: 'companyId must be a positive integer' });
        }

        // If the caller is a distributor, auto-approve only for companies associated to that distributor.
        let initialStatus: ApprovalStatus = 'pending';
        if (body.distributorId && /^[1-9]\d*$/.test(String(body.distributorId))) {
            const accountNumber = await resolveDistributorAccountNumber(String(body.distributorId));
            if (accountNumber) {
                const company = await fetchB2BCompanyById(Number(body.companyId));
                if (!company) {
                    return res.status(502).json({ error: 'Unable to resolve company for distributor approval' });
                }
                const fields = buildExtraFieldsMap(company.extraFields);
                if (fields.distributor_id !== accountNumber) {
                    return res
                        .status(403)
                        .json({ error: 'Forbidden: distributorId is not associated with this company' });
                }
                initialStatus = 'approved';
            }
        }

        const usable = initialStatus === 'approved';

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
            extraFields: [{ fieldName: APPROVAL_STATUS_FIELD, fieldValue: initialStatus }],
        };

        const b2bRes = await b2bClient.post<B2BSingleAddressResponse>('/api/v3/io/addresses', payload);
        const created = b2bRes.data?.data;

        if (!created) {
            logger.error(`Addresses create: unexpected B2B response for companyId ${payload.companyId}`);
            return res.status(502).json({ error: 'Unexpected response from B2B API' });
        }

        // B2B always defaults isShipping/isBilling to true on creation — set them
        // based on whether the address is immediately approved or pending.
        await b2bClient.put(`/api/v3/io/addresses/${created.addressId}`, {
            firstName: created.firstName,
            lastName: created.lastName,
            addressLine1: created.addressLine1,
            addressLine2: created.addressLine2,
            city: created.city,
            stateName: created.stateName,
            countryName: created.countryName,
            zipCode: created.zipCode,
            phoneNumber: created.phoneNumber,
            label: created.label,
            isBilling: usable,
            isShipping: usable,
            isDefaultBilling: false,
            isDefaultShipping: false,
            companyId: Number(created.companyId),
            extraFields: [{ fieldName: APPROVAL_STATUS_FIELD, fieldValue: initialStatus }],
        });

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

async function authorizeAddressAction(
    addressId: string,
    distributorAccountNumber: string
): Promise<{ address: B2BAddress } | { error: string; status: number }> {
    const address = await fetchAddressById(addressId);
    if (!address) {
        return { error: `Address ${addressId} not found`, status: 404 };
    }

    if (getApprovalStatus(address.extraFields) !== 'pending') {
        return { error: 'Only pending addresses can be approved or rejected', status: 422 };
    }

    const addressCompany = await fetchB2BCompanyById(Number(address.companyId));
    if (!addressCompany) {
        return { error: 'Unable to resolve address company from B2B API', status: 502 };
    }
    const addressCompanyFields = buildExtraFieldsMap(addressCompany.extraFields);
    if (addressCompanyFields.distributor_id !== distributorAccountNumber) {
        return { error: 'Forbidden: this address does not belong to one of your customers', status: 403 };
    }

    return { address };
}

interface BulkActionItem {
    addressId: unknown;
    action: unknown;
}

interface BulkActionResult {
    addressId: number;
    approvalStatus?: string;
    error?: string;
}

// PATCH /v1/api/addresses/:distributorId
// Distributor bulk-approves or rejects pending address requests for their associated customers.
// Body: [{ addressId: number, action: "approve" | "reject" }, ...]
router.patch('/addresses/:distributorId', async (req: Request, res: Response) => {
    const { distributorId } = req.params as Record<string, string>;

    if (!/^\d+$/.test(distributorId)) {
        return res.status(400).json({ error: 'Invalid distributorId' });
    }

    const items = req.body as unknown;
    if (!Array.isArray(items) || items.length === 0) {
        return res
            .status(400)
            .json({ error: 'Request body must be a non-empty array of { addressId, action } objects' });
    }

    // Validate each item before doing any B2B calls
    const invalidItem = (items as BulkActionItem[]).find(
        item => !item.addressId || !/^\d+$/.test(String(item.addressId))
    );
    if (invalidItem) {
        return res.status(400).json({ error: `Invalid addressId: ${invalidItem.addressId}` });
    }
    const invalidAction = (items as BulkActionItem[]).find(
        item => item.action !== 'approve' && item.action !== 'reject'
    );
    if (invalidAction) {
        return res.status(400).json({ error: `action must be "approve" or "reject", got: ${invalidAction.action}` });
    }

    // Resolve distributor once — fails fast if not a valid distributor
    const distributorAccountNumber = await resolveDistributorAccountNumber(distributorId);
    if (!distributorAccountNumber) {
        return res.status(403).json({ error: 'Forbidden: only distributors may perform this action' });
    }

    const results: BulkActionResult[] = await Promise.all(
        (items as BulkActionItem[]).map(async item => {
            const addrId = String(item.addressId);
            const newStatus: ApprovalStatus = item.action === 'approve' ? 'approved' : 'rejected';

            try {
                const auth = await authorizeAddressAction(addrId, distributorAccountNumber);
                if ('error' in auth) {
                    return { addressId: Number(addrId), error: auth.error };
                }
                await applyApprovalStatus(auth.address, newStatus);
                logger.info(`Address ${addrId} ${newStatus} by distributor ${distributorId}`);
                return { addressId: Number(addrId), approvalStatus: newStatus };
            } catch (err) {
                logger.error(`Addresses bulk update error (${addrId}): ${(err as Error).message}`);
                return { addressId: Number(addrId), error: 'Failed to update address approval status' };
            }
        })
    );

    return res.json(results);
});

export default router;
