import axios from 'axios';
import b2bClient from './b2b';
import { B2BUserExtraField, buildExtraFieldsMap } from './b2b-user';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface B2BCompanyRecord {
    id: number;
    companyName: string;
    companyEmail?: string;
    phoneNumber?: string;
    bcGroupName?: string;
    extraFields?: B2BUserExtraField[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { buildExtraFieldsMap as buildCompanyExtraFieldsMap };

/**
 * Fetch a B2B company record by ID, including its extraFields.
 * Returns null on API error or when the company is not found.
 */
export async function fetchB2BCompanyById(companyId: number): Promise<B2BCompanyRecord | null> {
    try {
        const res = await b2bClient.get<{ data: B2BCompanyRecord }>(`/api/v3/io/companies/${companyId}`);
        return res.data?.data ?? null;
    } catch (err) {
        logger.warn(`b2b-company: fetchById ${companyId}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Resolve a B2B company from a user's email address.
 * One list call (/users?email=) to get companyId, then one detail call (/companies/{id}).
 * Returns null if the user has no company or on any API error.
 */
export async function fetchB2BCompanyByUserEmail(email: string): Promise<B2BCompanyRecord | null> {
    try {
        const usersRes = await b2bClient.get<{ data: Array<{ companyId?: number }> }>('/api/v3/io/users', {
            params: { email, limit: 1 },
        });
        const companyId = usersRes.data?.data?.[0]?.companyId ?? null;
        if (!companyId) return null;
        return fetchB2BCompanyById(companyId);
    } catch (err) {
        logger.warn(`b2b-company: fetchByUserEmail ${email}: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Upsert a single extra field on a B2B company.
 * All existing extra fields are preserved; the target key is added or overwritten.
 */
export async function upsertB2BCompanyExtraField(company: B2BCompanyRecord, key: string, value: string): Promise<void> {
    const other = (company.extraFields ?? []).filter(f => f.fieldName !== key);
    try {
        await b2bClient.put(`/api/v3/io/companies/${company.id}`, {
            companyName: company.companyName,
            companyEmail: company.companyEmail,
            phoneNumber: company.phoneNumber,
            bcGroupName: company.bcGroupName,
            extraFields: [...other, { fieldName: key, fieldValue: value }],
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(`b2b-company: PUT /companies/${company.id} failed: status=${err.response?.status}`);
        }
        throw err;
    }
}

/**
 * Upsert multiple extra fields on a B2B company in a single PUT call.
 * All existing extra fields not in the `updates` map are preserved.
 */
export async function upsertB2BCompanyExtraFields(
    company: B2BCompanyRecord,
    updates: Record<string, string>
): Promise<void> {
    const keysToUpdate = new Set(Object.keys(updates));
    const other = (company.extraFields ?? []).filter(f => !keysToUpdate.has(f.fieldName));
    const newFields: B2BUserExtraField[] = Object.entries(updates).map(([k, v]) => ({
        fieldName: k,
        fieldValue: v,
    }));
    try {
        await b2bClient.put(`/api/v3/io/companies/${company.id}`, {
            companyName: company.companyName,
            companyEmail: company.companyEmail,
            phoneNumber: company.phoneNumber,
            bcGroupName: company.bcGroupName,
            extraFields: [...other, ...newFields],
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(
                `b2b-company: PUT /companies/${company.id} failed: status=${err.response?.status} body=${JSON.stringify(err.response?.data)}`
            );
        }
        throw err;
    }
}
