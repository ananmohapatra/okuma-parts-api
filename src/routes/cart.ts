import { Router, Request, Response } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../services/bigcommerce';
import { fetchLocationInventory, resolveStock, resolveDealerLocationId, BcInventoryItem } from '../services/inventory';
import logger from '../config/logger';
import config from '../config';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a physical line item returned in BC cart responses. */
interface LineItem {
    id: string;
    product_id: number;
    variant_id: number;
    name: string;
    sku: string;
    quantity: number;
    sale_price: number;
    list_price: number;
    image_url?: string;
}

/** Top-level cart object returned by the BC V3 Carts API. */
interface BcCart {
    id: string;
    customer_id: number;
    base_amount: number;
    discount_amount: number;
    cart_amount: number;
    line_items: {
        physical_items: LineItem[];
        digital_items: LineItem[];
        gift_certificates: unknown[];
        custom_items: unknown[];
    };
}

/** Redirect URL set returned by BC POST /v3/carts/:cartId/redirect_urls. */
interface BcRedirectUrls {
    cart_url: string;
    checkout_url: string;
    embedded_checkout_url: string;
}

/** Expected request body shape for POST /cart/items. */
interface AddItemBody {
    cartId?: unknown;
    productId?: unknown;
    quantity?: unknown;
    variantId?: unknown;
    customerId?: unknown;
    sku?: unknown;
    dealerLocationId?: unknown;
    inventoryTracking?: unknown;
}

// ---------------------------------------------------------------------------
// BC Cart helpers
// ---------------------------------------------------------------------------

/**
 * Fetch checkout redirect URLs for an existing BC cart.
 * BC OOTB: POST /v3/carts/:cartId/redirect_urls
 * @param cartId - BC cart UUID.
 * @returns Object containing cart_url, checkout_url, and embedded_checkout_url.
 */
async function fetchRedirectUrls(cartId: string): Promise<BcRedirectUrls> {
    const res = await bcClient.post<{ data: BcRedirectUrls }>(`/v3/carts/${cartId}/redirect_urls`);
    return res.data.data;
}

/**
 * Create a new BC cart with one line item.
 * BC OOTB: POST /v3/carts
 * customer_id is set at creation only — BC resolves that customer's price-list
 * pricing (e.g. dealer/Distributor group) for every line item in the cart.
 * Appending items to an already-created cart does not need it again, since
 * the cart's customer binding was already set here.
 * @param productId - BC product ID to add.
 * @param quantity - Quantity of the product to add.
 * @param variantId - Optional BC variant ID, if the product has variants.
 * @param customerId - Optional BC customer ID to bind the cart to, for group-specific pricing.
 * @returns The newly created BC cart.
 */
async function createCart(
    productId: number,
    quantity: number,
    variantId?: number,
    customerId?: number
): Promise<BcCart> {
    const lineItem: Record<string, unknown> = { product_id: productId, quantity };
    if (variantId) lineItem.variant_id = variantId;

    const payload: Record<string, unknown> = {
        channel_id: config.bc.channelId,
        line_items: [lineItem],
    };
    if (customerId) payload.customer_id = customerId;

    const res = await bcClient.post<{ data: BcCart }>('/v3/carts', payload);
    return res.data.data;
}

/**
 * Append a line item to an existing cart.
 * BC OOTB: POST /v3/carts/:cartId/items
 */
async function appendCartItem(
    cartId: string,
    productId: number,
    quantity: number,
    variantId?: number
): Promise<BcCart> {
    const lineItem: Record<string, unknown> = { product_id: productId, quantity };
    if (variantId) lineItem.variant_id = variantId;

    const res = await bcClient.post<{ data: BcCart }>(`/v3/carts/${cartId}/items`, {
        line_items: [lineItem],
    });
    return res.data.data;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /cart/items
 *
 * Add a product to the cart. If cartId is provided in the body, appends to that
 * existing cart (creates a new one if it has expired on BC). If cartId is omitted,
 * always creates a new cart.
 *
 * Body: { productId: number, quantity?: number, variantId?: number, customerId?: number }
 *
 * customerId identifies the logged-in dealer so BC applies their group-specific
 * (e.g. Distributor) pricing to the cart — only used when the cart is first
 * created; an already-created cart keeps its original customer binding.
 *
 * Response:
 * {
 *   cartId:       string,
 *   cart:         { id, baseAmount, cartAmount, lineItems },
 *   redirectUrls: { cartUrl, checkoutUrl, embeddedCheckoutUrl }
 * }
 */
router.post('/cart/items', async (req: Request, res: Response) => {
    const {
        cartId: bodyCartId,
        productId,
        quantity = 1,
        variantId,
        customerId,
        sku,
        dealerLocationId,
        inventoryTracking,
    } = req.body as AddItemBody;

    if (bodyCartId !== undefined && (typeof bodyCartId !== 'string' || !/^[0-9a-f-]{36}$/.test(bodyCartId as string))) {
        return res.status(400).json({ error: 'cartId must be a valid UUID when provided.' });
    }
    if (!productId || typeof productId !== 'number' || !Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ error: 'productId must be a positive integer.' });
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
        return res.status(400).json({ error: 'quantity must be an integer between 1 and 999.' });
    }
    if (variantId !== undefined && (typeof variantId !== 'number' || !Number.isInteger(variantId) || variantId <= 0)) {
        return res.status(400).json({ error: 'variantId must be a positive integer.' });
    }
    if (
        customerId !== undefined &&
        (typeof customerId !== 'number' || !Number.isInteger(customerId) || customerId <= 0)
    ) {
        return res.status(400).json({ error: 'customerId must be a positive integer.' });
    }
    if (sku !== undefined && typeof sku !== 'string') {
        return res.status(400).json({ error: 'sku must be a string when provided.' });
    }
    if (
        dealerLocationId !== undefined &&
        (typeof dealerLocationId !== 'number' || !Number.isInteger(dealerLocationId) || dealerLocationId <= 0)
    ) {
        return res.status(400).json({ error: 'dealerLocationId must be a positive integer when provided.' });
    }

    // Kick off stock fetch, custom fields, and dealer location resolution in parallel with cart operation.
    const stockFetchPromise: Promise<Record<string, BcInventoryItem>> =
        typeof sku === 'string' ? fetchLocationInventory([sku]) : Promise.resolve({});
    const customFieldsPromise: Promise<Array<{ name: string; value: string }>> = bcClient
        .get<{ data: Array<{ name: string; value: string }> }>(`/v3/catalog/products/${productId}/custom-fields`)
        .then(r => r.data?.data ?? [])
        .catch(() => []);
    let dealerLocPromise: Promise<number | null> = Promise.resolve(null);
    if (typeof sku === 'string' && customerId) {
        dealerLocPromise =
            typeof dealerLocationId === 'number'
                ? Promise.resolve(dealerLocationId)
                : resolveDealerLocationId(String(customerId));
    }

    try {
        let cart: BcCart;

        if (bodyCartId) {
            try {
                cart = await appendCartItem(bodyCartId as string, productId, quantity, variantId as number | undefined);
            } catch (err) {
                if ((err as AxiosError).response?.status === 404) {
                    logger.warn(`cart ${bodyCartId}: not found on BC, creating new cart`);
                    cart = await createCart(
                        productId,
                        quantity,
                        variantId as number | undefined,
                        customerId as number | undefined
                    );
                } else {
                    throw err;
                }
            }
        } else {
            cart = await createCart(
                productId,
                quantity,
                variantId as number | undefined,
                customerId as number | undefined
            );
        }

        const [redirectUrls, invMap, dealerLocId, customFields] = await Promise.all([
            fetchRedirectUrls(cart.id),
            stockFetchPromise,
            dealerLocPromise,
            customFieldsPromise,
        ]);

        const physicalItems = cart.line_items?.physical_items ?? [];

        const soStop = customFields.find(f => f.name === 'so_stop_flag')?.value?.toLowerCase() === 'true';
        const poStop = customFields.find(f => f.name === 'po_stop_flag')?.value?.toLowerCase() === 'true';

        let stockResult: ReturnType<typeof resolveStock> | null = null;
        if (typeof sku === 'string') {
            if (soStop) {
                stockResult = resolveStock(undefined, null, true, false);
            } else if (inventoryTracking === 'none') {
                stockResult = {
                    inStock: true,
                    stockStatus: 'in_stock',
                    stockSource: 'okuma',
                    availableStock: null,
                    shippingDetails: 'Ships from Okuma in 5-7 business days',
                };
            } else {
                stockResult = resolveStock(invMap[sku], dealerLocId, soStop, poStop);
            }
        }

        return res.status(201).json({
            cartId: cart.id,
            cart: {
                id: cart.id,
                customerId: cart.customer_id,
                baseAmount: cart.base_amount,
                cartAmount: cart.cart_amount,
                lineItemCount: physicalItems.length,
                lineItems: physicalItems.map(item => ({
                    id: item.id,
                    productId: item.product_id,
                    variantId: item.variant_id,
                    name: item.name,
                    sku: item.sku,
                    quantity: item.quantity,
                    salePrice: item.sale_price,
                    listPrice: item.list_price,
                    imageUrl: item.image_url ?? null,
                })),
            },
            redirectUrls: {
                cartUrl: redirectUrls.cart_url,
                checkoutUrl: redirectUrls.checkout_url,
                embeddedCheckoutUrl: redirectUrls.embedded_checkout_url,
            },
            ...(stockResult !== null && {
                stockStatus: stockResult.stockStatus,
                stockSource: stockResult.stockSource,
                availableStock: stockResult.availableStock,
                shippingDetails: stockResult.shippingDetails,
            }),
        });
    } catch (err) {
        const axErr = err as import('axios').AxiosError;
        const bcStatus = axErr.response?.status;
        const detail = axErr.response
            ? `BC ${bcStatus}: ${JSON.stringify(axErr.response.data)}`
            : (err as Error).message;
        logger.error(`cart add item failed (productId=${productId}): ${detail}`);
        if (bcStatus === 422) {
            return res
                .status(422)
                .json({ error: 'This item cannot be added to cart — it may be out of stock or unavailable.' });
        }
        return res.status(500).json({ error: 'Could not add item to cart.' });
    }
});

/** Normalised cart shape returned by all cart read endpoints. */
interface ShapedCart {
    cartId: string;
    customerId: number;
    baseAmount: number;
    cartAmount: number;
    lineItemCount: number;
    lineItems: {
        id: string;
        productId: number;
        variantId: number;
        name: string;
        sku: string;
        quantity: number;
        salePrice: number;
        listPrice: number;
        imageUrl: string | null;
    }[];
    redirectUrls: {
        cartUrl: string;
        checkoutUrl: string;
        embeddedCheckoutUrl: string;
    };
}

/**
 * Fetch a cart from BC and return it as a plain shaped object.
 * Throws AxiosError on BC failure so callers can distinguish 404 from 5xx.
 */
async function shapeCart(cartId: string): Promise<ShapedCart> {
    const cartRes = await bcClient.get<{ data: BcCart }>(`/v3/carts/${cartId}`, {
        params: { include: 'line_items.physical_items.options' },
    });
    const cart = cartRes.data.data;
    const redirectUrls = await fetchRedirectUrls(cartId);
    const physicalItems = cart.line_items?.physical_items ?? [];

    return {
        cartId: cart.id,
        customerId: cart.customer_id,
        baseAmount: cart.base_amount,
        cartAmount: cart.cart_amount,
        lineItemCount: physicalItems.length,
        lineItems: physicalItems.map(item => ({
            id: item.id,
            productId: item.product_id,
            variantId: item.variant_id,
            name: item.name,
            sku: item.sku,
            quantity: item.quantity,
            salePrice: item.sale_price,
            listPrice: item.list_price,
            imageUrl: item.image_url ?? null,
        })),
        redirectUrls: {
            cartUrl: redirectUrls.cart_url,
            checkoutUrl: redirectUrls.checkout_url,
            embeddedCheckoutUrl: redirectUrls.embedded_checkout_url,
        },
    };
}

/**
 * Shared cart fetch logic for explicit-ID routes.
 * Used by GET /cart/:cartId.
 */
async function fetchAndShapeCart(cartId: string, res: Response, onNotFound: () => void): Promise<Response> {
    try {
        const shaped = await shapeCart(cartId);
        return res.json(shaped);
    } catch (err) {
        if ((err as AxiosError).response?.status === 404) {
            onNotFound();
            return res.status(404).json({ error: 'Cart has expired or does not exist.' });
        }
        logger.error(`cart fetch failed (cartId=${cartId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load cart.' });
    }
}

/**
 * GET /cart?cartId=<uuid>
 *
 * Fetch a cart by the cartId query parameter.
 * Returns an array envelope for forwards-compatibility.
 * An empty array is returned when cartId is absent (never 404).
 *
 * Response: { carts: ShapedCart[] }
 */
router.get('/cart', async (req: Request, res: Response) => {
    const { cartId } = req.query as { cartId?: string };

    if (!cartId) {
        return res.json({ carts: [] });
    }

    if (!/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'cartId must be a valid UUID.' });
    }

    try {
        const shaped = await shapeCart(cartId);
        return res.json({ carts: [shaped] });
    } catch (err) {
        if ((err as AxiosError).response?.status === 404) {
            return res.json({ carts: [] });
        }
        logger.error(`cart fetch failed (cartId=${cartId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load cart.' });
    }
});

/**
 * GET /cart/:cartId
 *
 * Fetch a cart by explicit ID — useful for server-to-server calls or when
 * the Stencil theme passes the cartId directly.
 * Returns 404 when the cart does not exist or has expired on BC.
 */
router.get('/cart/:cartId', async (req: Request<{ cartId: string }>, res: Response) => {
    const { cartId } = req.params;

    if (!cartId || !/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'Invalid cartId.' });
    }

    return fetchAndShapeCart(cartId, res, () => {});
});

/**
 * DELETE /cart/:cartId/items/:itemId
 *
 * Remove a single line item from the cart.
 * Returns 204 on success or when the last item causes BC to auto-delete the cart.
 *
 * Response: 204 No Content on success.
 */
router.delete(
    '/cart/:cartId/items/:itemId',
    async (req: Request<{ cartId: string; itemId: string }>, res: Response) => {
        const { cartId, itemId } = req.params;

        if (!cartId || !/^[0-9a-f-]{36}$/.test(cartId)) {
            return res.status(400).json({ error: 'Invalid cartId.' });
        }

        try {
            await bcClient.delete(`/v3/carts/${cartId}/items/${itemId}`);
            return res.status(204).send();
        } catch (err) {
            const status = (err as AxiosError).response?.status;
            if (status === 404) {
                return res.status(204).send();
            }
            logger.error(`cart remove item failed (cartId=${cartId}, itemId=${itemId}): ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not remove item from cart.' });
        }
    }
);

/**
 * DELETE /cart?cartId=<uuid>
 *
 * Delete a cart by cartId query parameter.
 *
 * Response: 204 No Content on success or when the cart is already gone.
 */
router.delete('/cart', async (req: Request, res: Response) => {
    const { cartId } = req.query as { cartId?: string };

    if (!cartId) {
        return res.status(400).json({ error: 'cartId query parameter is required.' });
    }
    if (!/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'cartId must be a valid UUID.' });
    }

    try {
        await bcClient.delete(`/v3/carts/${cartId}`);
    } catch (err) {
        if ((err as AxiosError).response?.status !== 404) {
            logger.error(`cart delete failed (cartId=${cartId}): ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not delete cart.' });
        }
    }

    return res.status(204).send();
});

/**
 * DELETE /cart/:cartId
 *
 * Delete a cart by explicit ID.
 *
 * Response: 204 No Content on success or when the cart is already gone.
 */
router.delete('/cart/:cartId', async (req: Request<{ cartId: string }>, res: Response) => {
    const { cartId } = req.params;

    if (!cartId || !/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'Invalid cartId.' });
    }

    try {
        await bcClient.delete(`/v3/carts/${cartId}`);
    } catch (err) {
        if ((err as AxiosError).response?.status !== 404) {
            logger.error(`cart delete by id failed (cartId=${cartId}): ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not delete cart.' });
        }
    }

    return res.status(204).send();
});

/**
 * PUT /cart/:cartId
 *
 * Update the customer_id bound to an existing cart.
 * BC docs: changing customer_id removes any promotions or shipping calculations
 * tied to the previous customer's group.
 * Pass customerId=0 to convert a customer cart back to a guest cart.
 *
 * BC OOTB: PUT /v3/carts/:cartId  { customer_id }
 *
 * Body:     { "customerId": number }  — 0 = guest, positive integer = customer
 * Response: shaped cart (same shape as GET /cart/:cartId)
 */
router.put('/cart/:cartId', async (req: Request<{ cartId: string }>, res: Response) => {
    const { cartId } = req.params;
    const { customerId } = req.body as { customerId?: unknown };

    if (!cartId || !/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'Invalid cartId.' });
    }
    if (
        customerId === undefined ||
        customerId === null ||
        typeof customerId !== 'number' ||
        !Number.isInteger(customerId) ||
        customerId < 0
    ) {
        return res.status(400).json({ error: 'customerId must be a non-negative integer (0 = guest cart).' });
    }

    try {
        const cartRes = await bcClient.put<{ data: BcCart }>(`/v3/carts/${cartId}`, {
            customer_id: customerId,
        });
        const cart = cartRes.data.data;
        const redirectUrls = await fetchRedirectUrls(cartId);
        const physicalItems = cart.line_items?.physical_items ?? [];

        return res.json({
            cartId: cart.id,
            customerId: cart.customer_id,
            baseAmount: cart.base_amount,
            cartAmount: cart.cart_amount,
            lineItemCount: physicalItems.length,
            lineItems: physicalItems.map(item => ({
                id: item.id,
                productId: item.product_id,
                variantId: item.variant_id,
                name: item.name,
                sku: item.sku,
                quantity: item.quantity,
                salePrice: item.sale_price,
                listPrice: item.list_price,
                imageUrl: item.image_url ?? null,
            })),
            redirectUrls: {
                cartUrl: redirectUrls.cart_url,
                checkoutUrl: redirectUrls.checkout_url,
                embeddedCheckoutUrl: redirectUrls.embedded_checkout_url,
            },
        });
    } catch (err) {
        const status = (err as AxiosError).response?.status;
        if (status === 404) {
            return res.status(404).json({ error: 'Cart not found.' });
        }
        if (status === 422) {
            return res.status(422).json({ error: 'Customer not found or cannot be assigned to this cart.' });
        }
        logger.error(`cart update customerId failed (cartId=${cartId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not update cart.' });
    }
});

export { router as cartRouter };
export default router;
