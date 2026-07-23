import axios from 'axios';
import b2bClient from './b2b';
import { B2BUserExtraField, buildExtraFieldsMap, normalizeFieldName } from './b2b-user';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface B2BCompanyRecord {
    companyId: number;
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
 * Merge updates into a company extra fields array, preserving original field names.
 * Matching is case-insensitive / space-tolerant (normalized to snake_case).
 */
function mergeCompanyExtraFields(existing: B2BUserExtraField[], updates: Record<string, string>): B2BUserExtraField[] {
    const normalizedUpdates = new Map(Object.entries(updates).map(([k, v]) => [normalizeFieldName(k), v]));

    const merged = existing.map(f => {
        const v = normalizedUpdates.get(normalizeFieldName(f.fieldName));
        return v !== undefined ? { fieldName: f.fieldName, fieldValue: v } : f;
    });

    const existingNormalized = new Set(existing.map(f => normalizeFieldName(f.fieldName)));
    normalizedUpdates.forEach((value, normalized) => {
        if (!existingNormalized.has(normalized)) {
            const originalKey = Object.keys(updates).find(k => normalizeFieldName(k) === normalized)!;
            merged.push({ fieldName: originalKey, fieldValue: value });
        }
    });

    return merged;
}

/**
 * Upsert a single extra field on a B2B company.
 * All existing extra fields are preserved; the target key is added or overwritten.
 */
export async function upsertB2BCompanyExtraField(company: B2BCompanyRecord, key: string, value: string): Promise<void> {
    try {
        await b2bClient.put(`/api/v3/io/companies/${company.companyId}`, {
            companyName: company.companyName,
            companyEmail: company.companyEmail,
            phoneNumber: company.phoneNumber,
            bcGroupName: company.bcGroupName,
            extraFields: mergeCompanyExtraFields(company.extraFields ?? [], { [key]: value }),
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(`b2b-company: PUT /companies/${company.companyId} failed: status=${err.response?.status}`);
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
    try {
        await b2bClient.put(`/api/v3/io/companies/${company.companyId}`, {
            companyName: company.companyName,
            companyEmail: company.companyEmail,
            phoneNumber: company.phoneNumber,
            bcGroupName: company.bcGroupName,
            extraFields: mergeCompanyExtraFields(company.extraFields ?? [], updates),
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(
                `b2b-company: PUT /companies/${company.companyId} failed: status=${err.response?.status} body=${JSON.stringify(err.response?.data)}`
            );
        }
        throw err;
    }
}
