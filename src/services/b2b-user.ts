import axios from 'axios';
import b2bClient from './b2b';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface B2BUserExtraField {
    fieldName: string;
    fieldValue: string;
}

/**
 * Minimal shape of a B2B user record as returned by GET /api/v3/io/users.
 * Only fields needed for identity + extra field management are included.
 * Note: the API returns `id` (not `userId`) and `phoneNumber` (not `phone`).
 */
export interface B2BUserRecord {
    id: number;
    customerId: number;
    email: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    role?: number;
    companyId?: number;
    extraFields?: B2BUserExtraField[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a B2B user by email address, including extraFields.
 * The list endpoint (/users?email=) omits extraFields; a second GET /users/{id}
 * is required to retrieve them. Returns null on any API error or when not found.
 */
export async function fetchB2BUserByEmail(email: string): Promise<B2BUserRecord | null> {
    try {
        const listRes = await b2bClient.get<{ data: B2BUserRecord[] }>('/api/v3/io/users', {
            params: { email, limit: 1 },
        });
        const stub = listRes.data?.data?.[0];
        if (!stub) return null;

        const detailRes = await b2bClient.get<{ data: B2BUserRecord }>(`/api/v3/io/users/${stub.id}`);
        return detailRes.data?.data ?? stub;
    } catch (err) {
        logger.warn(`b2b-user: fetchByEmail ${email}: ${(err as Error).message}`);
        return null;
    }
}

/** Normalize a B2B extra field name to the snake_case key used for lookups. */
function normalizeFieldName(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Build a key→value map from a B2B extra fields array for easy lookup.
 * Keys are normalized to snake_case so lookups like `map.last_viewed_machine`
 * work regardless of how the field was named in B2B admin (e.g. "Last Viewed Machine").
 */
export function buildExtraFieldsMap(extraFields?: B2BUserExtraField[]): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = Object.create(null);
    (extraFields ?? []).forEach(f => {
        map[normalizeFieldName(f.fieldName)] = f.fieldValue;
    });
    return map;
}

export { normalizeFieldName };

/**
 * Merge updates into an existing extra fields array.
 * Matching is case-insensitive / space-tolerant (normalized to snake_case).
 * The original fieldName from B2B is preserved so the API accepts the payload.
 * New keys (not found in existing) are appended using the provided key string.
 */
function mergeExtraFields(existing: B2BUserExtraField[], updates: Record<string, string>): B2BUserExtraField[] {
    const normalizedUpdates = new Map(Object.entries(updates).map(([k, v]) => [normalizeFieldName(k), v]));

    // Update matching fields in-place (preserve original fieldName)
    const merged = existing.map(f => {
        const v = normalizedUpdates.get(normalizeFieldName(f.fieldName));
        return v !== undefined ? { fieldName: f.fieldName, fieldValue: v } : f;
    });

    // Append fields that had no match in existing
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
 * Upsert a single extra field on a B2B user.
 * All existing extra fields are preserved; the target key is added or overwritten.
 * Uses PUT (full user replacement) as required by the B2B Edition API.
 */
export async function upsertB2BUserExtraField(user: B2BUserRecord, key: string, value: string): Promise<void> {
    try {
        await b2bClient.put(`/api/v3/io/users/${user.id}`, {
            customerId: user.customerId,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNumber: user.phoneNumber,
            role: user.role,
            companyId: user.companyId,
            extraFields: mergeExtraFields(user.extraFields ?? [], { [key]: value }),
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(`b2b-user: PUT /users/${user.id} failed: status=${err.response?.status}`);
        }
        throw err;
    }
}

/**
 * Upsert multiple extra fields on a B2B user in a single PUT call.
 * All existing extra fields not in the `updates` map are preserved.
 */
export async function upsertB2BUserExtraFields(user: B2BUserRecord, updates: Record<string, string>): Promise<void> {
    try {
        await b2bClient.put(`/api/v3/io/users/${user.id}`, {
            customerId: user.customerId,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNumber: user.phoneNumber,
            role: user.role,
            companyId: user.companyId,
            extraFields: mergeExtraFields(user.extraFields ?? [], updates),
        });
    } catch (err) {
        if (axios.isAxiosError(err)) {
            logger.error(
                `b2b-user: PUT /users/${user.id} failed: status=${err.response?.status} body=${JSON.stringify(err.response?.data)}`
            );
        }
        throw err;
    }
}
