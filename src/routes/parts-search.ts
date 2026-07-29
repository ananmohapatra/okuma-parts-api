import { Router, Request, Response } from 'express';
import bcClient from '../services/bigcommerce';
import fetchCustomerProfile from '../services/customerProfile';
import {
    fetchLocationInventory,
    resolveStock,
    resolveDealerLocationId,
    BcInventoryItem,
    StockStatus,
    StockResult,
} from '../services/inventory';
import logger from '../config/logger';
import config from '../config';

const router = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURRENCY_CODE = 'USD';

/** Shape of a product entry returned by BC GET /v3/catalog/products keyword search. */
interface BcSearchProduct {
    id: number;
    sku: string;
    name: string;
    description: string;
    availability: string;
    inventory_tracking: 'none' | 'product' | 'variant';
    inventory_level: number;
    custom_fields: Array<{ name: string; value: string }>;
}

/** Shape of a single pricing item returned by BC POST /v3/pricing/products. */
interface BcPricingItem {
    product_id: number;
    price: { as_entered: number };
    calculated_price: { as_entered: number };
    sale_price: { as_entered: number } | null;
}

/** Normalised per-product pricing output produced by fetchPricing. */
interface PricingResult {
    unitPrice: number | null;
    originalPrice: number | null;
}

/** Normalised part result shape returned in each element of the search response array. */
interface PartResult {
    productId: number;
    partNumber: string;
    partName: string;
    description: string;
    unitPrice: number | null;
    originalPrice: number | null;
    status: string;
    stockStatus: StockStatus;
    stockSource: StockResult['stockSource'];
    availableStock: number | null;
    shippingDetails: string;
}

/**
 * Fetch dealer-specific pricing for a batch of product IDs.
 * BC OOTB: POST /v3/pricing/products
 * customer_group_id is omitted from the payload (not from BC's required fields —
 * only channel_id + currency_code are mandatory) when the customer has none,
 * so pricing still resolves to base price instead of failing outright.
 * @param productIds - BC product IDs to price.
 * @param customerGroupId - Dealer's BC customer group ID for group-specific pricing, or null to use base pricing.
 * @returns Map of product ID to `{ unitPrice, originalPrice }` (originalPrice is null when no discount applies).
 */
async function fetchPricing(
    productIds: number[],
    customerGroupId: number | null
): Promise<Record<number, PricingResult>> {
    const payload: Record<string, unknown> = {
        channel_id: config.bc.channelId,
        currency_code: CURRENCY_CODE,
        items: productIds.map(id => ({ product_id: id })),
    };
    if (customerGroupId !== null) payload.customer_group_id = customerGroupId;

    const res = await bcClient.post<{ data: BcPricingItem[] }>('/v3/pricing/products', payload);
    const priceByProductId: Record<number, PricingResult> = {};
    (res.data?.data ?? []).forEach(item => {
        const listPrice = item.price?.as_entered ?? null;
        const finalPrice = item.calculated_price?.as_entered ?? listPrice;
        // originalPrice is only meaningful when it differs from the final price
        priceByProductId[item.product_id] = {
            unitPrice: finalPrice,
            originalPrice: finalPrice !== listPrice ? listPrice : null,
        };
    });
    return priceByProductId;
}

/**
 * GET /v1/parts/search
 *
 * Dealer part search by part number or name (Order for Self — not machine-scoped).
 * Combines BC's native keyword search (matches sku + name + description in one call)
 * with dealer-specific pricing and per-location inventory.
 *
 * Stock priority:
 *   1. Dealer's inventory location (dealerLocationId) — if provided and has stock.
 *   2. Okuma US Warehouse location — matched by name containing "okuma".
 *   3. backorder — no stock at either source.
 *
 * dealerLocationId comes from the Stencil theme, which resolves it from the
 * logged-in user's B2B session (the distributor's BC inventory location ID).
 * BC does not aggregate multi-location stock into inventory_level, so we must
 * query /v3/inventory/items for per-location quantities.
 *
 * Query params:
 *   q               — required, search term (matched against SKU, name, description)
 *   customerId      — required, BC customer ID of the logged-in dealer
 *   dealerLocationId — optional, BC inventory location ID for the dealer's warehouse
 *   sort            — optional, "name_asc" | "name_desc"
 *   page            — optional, default 1, must be a positive integer
 *   limit           — optional, default 50, must be a positive integer, capped at 100
 *
 * Response: { total, page, limit, results: [{ productId, partNumber, partName, description, unitPrice, originalPrice, status, stockStatus, stockSource, shippingDetails }] }
 */
router.get('/parts/search', async (req: Request, res: Response) => {
    const {
        q,
        customerId,
        dealerLocationId,
        sort,
        page = '1',
        limit = String(DEFAULT_LIMIT),
    } = req.query as Record<string, string>;

    if (!q || !q.trim()) {
        return res.status(400).json({ error: 'q (search term) is required.' });
    }
    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'customerId is required and must be numeric.' });
    }
    if (dealerLocationId !== undefined && !/^[1-9]\d*$/.test(dealerLocationId)) {
        return res.status(400).json({ error: 'dealerLocationId must be a positive integer when provided.' });
    }
    if (sort !== undefined && sort !== 'name_asc' && sort !== 'name_desc') {
        return res.status(400).json({ error: 'sort must be "name_asc" or "name_desc" when provided.' });
    }

    if (!/^\d+$/.test(page)) {
        return res.status(400).json({ error: 'page must be a positive integer.' });
    }
    const pageNum = parseInt(page, 10);
    if (pageNum < 1) {
        return res.status(400).json({ error: 'page must be a positive integer.' });
    }
    if (!/^\d+$/.test(limit)) {
        return res.status(400).json({ error: 'limit must be a positive integer.' });
    }
    const rawLimitNum = parseInt(limit, 10);
    if (rawLimitNum < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer.' });
    }
    const limitNum = Math.min(rawLimitNum, MAX_LIMIT);

    const session = req.session as unknown as { customerId?: string };
    if (session.customerId && session.customerId !== customerId) {
        return res.status(403).json({ error: 'Forbidden.' });
    }

    let sortParams: Record<string, string> = {};
    if (sort === 'name_asc') sortParams = { sort: 'name', direction: 'asc' };
    else if (sort === 'name_desc') sortParams = { sort: 'name', direction: 'desc' };

    try {
        const [profile, searchRes, resolvedDealerLocId] = await Promise.all([
            fetchCustomerProfile(customerId),
            bcClient.get<{ data: BcSearchProduct[]; meta: { pagination: { total: number } } }>('/v3/catalog/products', {
                params: { keyword: q.trim(), page: pageNum, limit: limitNum, ...sortParams, include: 'custom_fields' },
            }),
            dealerLocationId ? Promise.resolve(parseInt(dealerLocationId, 10)) : resolveDealerLocationId(customerId),
        ]);

        if (!profile) {
            return res.status(404).json({ error: 'Customer not found.' });
        }

        const products = searchRes.data?.data ?? [];
        const total = searchRes.data?.meta?.pagination?.total ?? 0;

        const skus = [...new Set(products.filter(p => p.sku).map(p => p.sku))];

        const [priceByProductId, inventoryBySku] = await Promise.all([
            products.length > 0
                ? fetchPricing(
                      products.map(p => p.id),
                      profile.customer_group_id
                  )
                : Promise.resolve({} as Record<number, PricingResult>),
            skus.length > 0 ? fetchLocationInventory(skus) : Promise.resolve({} as Record<string, BcInventoryItem>),
        ]);

        const dealerLocId = resolvedDealerLocId;

        const results: PartResult[] = products.map(p => {
            const pricing = priceByProductId[p.id] ?? { unitPrice: null, originalPrice: null };
            const customFields = p.custom_fields ?? [];
            const soStop = customFields.find(f => f.name === 'so_stop_flag')?.value?.toLowerCase() === 'true';
            const poStop = customFields.find(f => f.name === 'po_stop_flag')?.value?.toLowerCase() === 'true';

            let stockResult: StockResult;
            if (p.availability !== 'available') {
                stockResult = {
                    inStock: false,
                    stockStatus: 'not_available',
                    stockSource: 'none',
                    availableStock: null,
                    shippingDetails: 'Not available.',
                };
            } else if (soStop) {
                stockResult = {
                    inStock: false,
                    stockStatus: 'not_available',
                    stockSource: 'none',
                    availableStock: null,
                    shippingDetails: 'This part is not available.',
                };
            } else if (p.inventory_tracking === 'none') {
                stockResult = {
                    inStock: true,
                    stockStatus: 'in_stock',
                    stockSource: 'okuma',
                    availableStock: null,
                    shippingDetails: 'Ships from Okuma in 5-7 business days',
                };
            } else {
                stockResult = resolveStock(inventoryBySku[p.sku], dealerLocId, soStop, poStop);
            }

            return {
                productId: p.id,
                partNumber: p.sku,
                partName: p.name,
                description: p.description || '',
                unitPrice: pricing.unitPrice,
                originalPrice: pricing.originalPrice,
                status: p.availability,
                stockStatus: stockResult.stockStatus,
                stockSource: stockResult.stockSource,
                availableStock: stockResult.availableStock,
                shippingDetails: stockResult.shippingDetails,
            };
        });

        return res.json({ total, page: pageNum, limit: limitNum, results });
    } catch (err) {
        logger.error(`parts search failed for q="${q}": ${(err as Error).message}`);
        return res.status(502).json({ error: 'Could not complete parts search.' });
    }
});

export default router;
