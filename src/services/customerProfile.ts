import bcClient from './bigcommerce';
import logger from '../config/logger';

/** TTL for the customer profile cache (5 minutes — customer_group_id changes rarely). */
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — customer_group_id changes rarely

/** A BC customer record as returned by GET /v3/customers. */
export interface BcCustomer {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    company: string;
    phone: string;
    customer_group_id: number | null;
}

/** In-memory cache entry for a fetched BC customer profile. */
interface ProfileCacheEntry {
    data: BcCustomer | null;
    expiresAt: number;
}

/** In-memory cache of BC customer profiles, keyed by BC customer ID string. */
const profileCache = new Map<string, ProfileCacheEntry>();

/**
 * Fetch a BC customer's profile (including customer_group_id) by BC customer ID.
 * BC OOTB: GET /v3/customers?id:in=:customerId
 * Cached per customerId for PROFILE_CACHE_TTL_MS to avoid re-fetching on repeated calls
 * (e.g. successive searches by the same dealer in a session).
 * @param customerId - BC customer ID, as a string.
 * @returns The customer's BC profile, or null if not found or the lookup fails.
 */
export default async function fetchCustomerProfile(customerId: string): Promise<BcCustomer | null> {
    const cached = profileCache.get(customerId);
    if (cached) {
        if (Date.now() < cached.expiresAt) return cached.data;
        profileCache.delete(customerId);
    }

    try {
        const res = await bcClient.get<{ data: BcCustomer[] }>('/v3/customers', {
            params: { 'id:in': customerId },
        });
        const profile = res.data?.data?.[0] ?? null;
        profileCache.set(customerId, { data: profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
        return profile;
    } catch (err) {
        logger.warn(`fetchCustomerProfile ${customerId}: ${(err as Error).message}`);
        return null;
    }
}
