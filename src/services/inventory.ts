import bcClient from './bigcommerce';
import b2bClient from './b2b';
import fetchCustomerProfile from './customerProfile';
import logger from '../config/logger';

/** A single inventory location entry as returned by the BC /v3/inventory/items endpoint. */
export interface BcInventoryLocation {
    location_id: number;
    location_code: string;
    location_name: string;
    available_to_sell: number;
    location_enabled: boolean;
}

/** A single inventory item (SKU + product ID) with per-location stock levels. */
export interface BcInventoryItem {
    identity: { sku: string; product_id: number };
    locations: BcInventoryLocation[];
}

/** Identifies which location is fulfilling a stock check: dealer warehouse, Okuma warehouse, or none (backorder). */
export type StockSource = 'dealer' | 'okuma' | 'none';

/** Resolved stock availability result for a single SKU, including source and shipping message. */
export interface StockResult {
    inStock: boolean;
    stockSource: StockSource;
    availableStock: number | null;
    shippingDetails: string;
}

/**
 * Normalise a location or company name for fuzzy matching by lowercasing and
 * stripping all non-alphanumeric characters.
 * @param name - The raw name string to normalise.
 * @returns The normalised string (lowercase, alphanumeric only).
 */
export function normalizeForMatch(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Fetch per-location inventory for a batch of SKUs.
 * Returns a map keyed by SKU. Failures are non-fatal — returns an empty map so
 * callers can fall back gracefully.
 */
export async function fetchLocationInventory(skus: string[]): Promise<Record<string, BcInventoryItem>> {
    if (skus.length === 0) return {};
    try {
        const res = await bcClient.get<{ data: BcInventoryItem[] }>('/v3/inventory/items', {
            params: { 'sku:in': skus.join(',') },
        });
        const bySku: Record<string, BcInventoryItem> = {};
        (res.data?.data ?? []).forEach(item => {
            bySku[item.identity.sku] = item;
        });
        return bySku;
    } catch (err) {
        logger.warn(`fetchLocationInventory: ${(err as Error).message}`);
        return {};
    }
}

/**
 * Resolve stock source for a single inventory item.
 *
 * Priority:
 *   1. Dealer's location (matched by location_id when dealerLocId is provided).
 *   2. Okuma US Warehouse (location name contains "okuma").
 *   3. none — backorder.
 *
 * BC does not aggregate multi-location stock into the product's inventory_level,
 * so all stock checks must go through the /v3/inventory/items response.
 */
export function resolveStock(invItem: BcInventoryItem | undefined, dealerLocId: number | null): StockResult {
    if (invItem) {
        if (dealerLocId !== null) {
            const dealerLoc = invItem.locations.find(loc => loc.location_enabled && loc.location_id === dealerLocId);
            if (dealerLoc && dealerLoc.available_to_sell > 0) {
                return {
                    inStock: true,
                    stockSource: 'dealer',
                    availableStock: dealerLoc.available_to_sell,
                    shippingDetails: 'In stock at your dealer — ships in 1-3 business days',
                };
            }
        }

        const okumaLoc = invItem.locations.find(
            loc => loc.location_enabled && normalizeForMatch(loc.location_name).includes('okuma')
        );
        if (okumaLoc && okumaLoc.available_to_sell > 0) {
            return {
                inStock: true,
                stockSource: 'okuma',
                availableStock: okumaLoc.available_to_sell,
                shippingDetails: 'Ships from Okuma in 5-7 business days',
            };
        }
    }

    return {
        inStock: false,
        stockSource: 'none',
        availableStock: null,
        shippingDetails: 'Will be shipped once available',
    };
}

/**
 * Returns true if any enabled location has available stock.
 * Used where dealer context is unavailable (e.g. server-to-server parts-book calls).
 */
export function hasAnyStock(invItem: BcInventoryItem | undefined): boolean {
    if (!invItem) return false;
    return invItem.locations.some(loc => loc.location_enabled && loc.available_to_sell > 0);
}

// ---------------------------------------------------------------------------
// Dealer location resolution
// ---------------------------------------------------------------------------

/** Slim inventory location record used for dealer-location resolution. */
interface BcLocationEntry {
    id: number;
    code: string;
    label: string;
    enabled: boolean;
}

/** TTL for the cached BC inventory locations list (30 minutes — location codes rarely change). */
const LOCATION_LIST_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — location codes rarely change
/** TTL for the per-customer dealer location ID cache (5 minutes). */
const DEALER_LOC_CACHE_TTL_MS = 5 * 60 * 1000;

/** In-memory cache for the full BC inventory locations list. */
let locationListCache: { data: BcLocationEntry[]; expiresAt: number } | null = null;
/** In-memory per-customer cache mapping customer IDs to their resolved dealer location IDs. */
const dealerLocCache = new Map<string, { locationId: number | null; expiresAt: number }>();

/**
 * Fetch all enabled BC inventory locations, using an in-memory cache to avoid
 * repeated API calls within the TTL window.
 * @returns The full list of BC inventory location entries.
 */
async function fetchAllLocations(): Promise<BcLocationEntry[]> {
    if (locationListCache && Date.now() < locationListCache.expiresAt) return locationListCache.data;
    const res = await bcClient.get<{ data: BcLocationEntry[] }>('/v3/inventory/locations');
    const data = res.data?.data ?? [];
    locationListCache = { data, expiresAt: Date.now() + LOCATION_LIST_CACHE_TTL_MS };
    return data;
}

/**
 * Resolve the BC inventory location ID for a dealer from the end customer's B2B
 * company extra fields.
 *
 * Chain: customerId → customer email → B2B user → companyId →
 *        company extraFields["Distributor ID"] → match BC inventory location.code
 *        → location.id.
 *
 * BC inventory locations are coded with the distributor ID (e.g. location code
 * "100322" = Gosiger Dayton, location id 18). The "Distributor ID" extra field on
 * the B2B end-customer company holds that same value.
 *
 * Result is cached per customerId for DEALER_LOC_CACHE_TTL_MS.
 * Returns null when the chain breaks at any step (guest cart, no B2B account,
 * missing extra field, no matching location) — callers fall back to Okuma-only stock.
 */
export async function resolveDealerLocationId(customerId: string): Promise<number | null> {
    const cached = dealerLocCache.get(customerId);
    if (cached && Date.now() < cached.expiresAt) return cached.locationId;

    const cache = (locationId: number | null): number | null => {
        const now = Date.now();
        Array.from(dealerLocCache.entries()).forEach(([key, entry]) => {
            if (now >= entry.expiresAt) dealerLocCache.delete(key);
        });
        dealerLocCache.set(customerId, { locationId, expiresAt: now + DEALER_LOC_CACHE_TTL_MS });
        return locationId;
    };

    try {
        const profile = await fetchCustomerProfile(customerId);
        if (!profile?.email) return cache(null);

        const usersRes = await b2bClient.get<{ data: Array<{ companyId?: number }> }>('/api/v3/io/users', {
            params: { email: profile.email },
        });
        const companyId = usersRes.data?.data?.[0]?.companyId;
        if (!companyId) return cache(null);

        const [companyRes, locations] = await Promise.all([
            b2bClient.get<{ data: { extraFields?: Array<{ fieldName: string; fieldValue: string }> } }>(
                `/api/v3/io/companies/${companyId}`
            ),
            fetchAllLocations(),
        ]);

        const extraFields = companyRes.data?.data?.extraFields ?? [];
        const distributorField = extraFields.find(f => f.fieldName.toLowerCase() === 'distributor id');
        const distributorId = distributorField?.fieldValue?.trim();

        if (!distributorId) {
            logger.warn(
                `resolveDealerLocationId: no "Distributor ID" extra field for customer ${customerId} (company ${companyId})`
            );
            return cache(null);
        }

        const match = locations.find(
            loc => loc.enabled && (loc.code === distributorId || loc.code.includes(distributorId))
        );

        if (!match) {
            logger.warn(
                `resolveDealerLocationId: no BC location with code "${distributorId}" for customer ${customerId}`
            );
            return cache(null);
        }

        logger.info(
            `resolveDealerLocationId: customer ${customerId} → distributor ${distributorId} → location ${match.id} (${match.label})`
        );
        return cache(match.id);
    } catch (err) {
        logger.warn(`resolveDealerLocationId(${customerId}): ${(err as Error).message}`);
        return null;
    }
}
