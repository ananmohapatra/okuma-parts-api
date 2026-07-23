import { Router, Request, Response } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../services/bigcommerce';
import logger from '../config/logger';
import config from '../config';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface BcRedirectUrls {
    cart_url: string;
    checkout_url: string;
    embedded_checkout_url: string;
}

interface AddItemBody {
    productId?: unknown;
    quantity?: unknown;
    variantId?: unknown;
    customerId?: unknown;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getCartId(req: Request): string | null {
    const session = req.session as unknown as Record<string, unknown> & { cartId?: string };
    return session.cartId ?? null;
}

function setCartId(req: Request, cartId: string): void {
    const session = req.session as unknown as Record<string, unknown> & { cartId?: string };
    session.cartId = cartId;
}

function clearCartId(req: Request): void {
    const session = req.session as unknown as Record<string, unknown> & { cartId?: string };
    delete session.cartId;
}

// ---------------------------------------------------------------------------
// BC Cart helpers
// ---------------------------------------------------------------------------

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
 * Add a product to the cart. Creates the cart on the first call; appends on
 * subsequent calls using the cartId stored in the session. If the stored cart
 * has expired on BC (404), a new one is created transparently.
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
    const { productId, quantity = 1, variantId, customerId } = req.body as AddItemBody;

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

    const session = req.session as unknown as { customerId?: string };
    if (customerId !== undefined && session.customerId && session.customerId !== String(customerId)) {
        return res.status(403).json({ error: 'Forbidden.' });
    }

    try {
        let cart: BcCart;
        const existingCartId = getCartId(req);

        if (existingCartId) {
            try {
                cart = await appendCartItem(existingCartId, productId, quantity, variantId as number | undefined);
            } catch (err) {
                // Cart expired or deleted on BC — create a fresh one
                if ((err as AxiosError).response?.status === 404) {
                    logger.warn(`cart ${existingCartId}: not found on BC, creating new cart`);
                    clearCartId(req);
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

        setCartId(req, cart.id);

        const redirectUrls = await fetchRedirectUrls(cart.id);

        const physicalItems = cart.line_items?.physical_items ?? [];

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
        });
    } catch (err) {
        const axErr = err as import('axios').AxiosError;
        const detail = axErr.response
            ? `BC ${axErr.response.status}: ${JSON.stringify(axErr.response.data)}`
            : (err as Error).message;
        logger.error(`cart add item failed (productId=${productId}): ${detail}`);
        return res.status(500).json({ error: 'Could not add item to cart.' });
    }
});

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
 * GET /cart
 *
 * Returns all available carts for the current session as an array.
 * An empty array is returned when no active cart exists (never 404).
 * At most one cart is returned — BC has no multi-cart session support via the
 * management API, but the array envelope keeps the response shape extensible.
 *
 * Response: { carts: ShapedCart[] }
 */
router.get('/cart', async (req: Request, res: Response) => {
    const cartId = getCartId(req);

    if (!cartId) {
        return res.json({ carts: [] });
    }

    try {
        const shaped = await shapeCart(cartId);
        return res.json({ carts: [shaped] });
    } catch (err) {
        if ((err as AxiosError).response?.status === 404) {
            clearCartId(req);
            return res.json({ carts: [] });
        }
        logger.error(`cart fetch failed (cartId=${cartId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load cart.' });
    }
});

/**
 * GET /cart/:cartId
 *
 * Fetch a cart by explicit ID. Does not require a session — useful for
 * server-to-server calls or when the Stencil theme passes the cartId directly.
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
 * DELETE /cart/items/:itemId
 *
 * Remove a single line item from the cart.
 * Clears the session cartId when the last item is removed (BC deletes the cart).
 *
 * Response: 204 No Content on success.
 */
router.delete('/cart/items/:itemId', async (req: Request, res: Response) => {
    const cartId = getCartId(req);
    const { itemId } = req.params;

    if (!cartId) {
        return res.status(404).json({ error: 'No active cart.' });
    }

    try {
        await bcClient.delete(`/v3/carts/${cartId}/items/${itemId}`);
        return res.status(204).send();
    } catch (err) {
        const status = (err as AxiosError).response?.status;
        if (status === 404) {
            // BC returns 404 when the last item is removed (cart is auto-deleted)
            clearCartId(req);
            return res.status(204).send();
        }
        logger.error(`cart remove item failed (cartId=${cartId}, itemId=${itemId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not remove item from cart.' });
    }
});

/**
 * DELETE /cart
 *
 * Delete the cart bound to the current session and clear the session.
 *
 * Response: 204 No Content on success.
 */
router.delete('/cart', async (req: Request, res: Response) => {
    const cartId = getCartId(req);

    if (!cartId) {
        return res.status(204).send();
    }

    try {
        await bcClient.delete(`/v3/carts/${cartId}`);
    } catch (err) {
        // 404 means BC already removed it — that's fine
        if ((err as AxiosError).response?.status !== 404) {
            logger.error(`cart delete failed (cartId=${cartId}): ${(err as Error).message}`);
            return res.status(500).json({ error: 'Could not delete cart.' });
        }
    }

    clearCartId(req);
    return res.status(204).send();
});

/**
 * DELETE /cart/:cartId
 *
 * Delete a cart by explicit ID. Does not require a session.
 * If the cartId matches the session cart, the session is also cleared.
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

    if (getCartId(req) === cartId) {
        clearCartId(req);
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

    const session = req.session as unknown as { customerId?: string };
    if (customerId > 0 && session.customerId && session.customerId !== String(customerId)) {
        return res.status(403).json({ error: 'Forbidden.' });
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
