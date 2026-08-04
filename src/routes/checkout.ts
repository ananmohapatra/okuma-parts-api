import { Router, Request, Response } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import logger from '../config/logger';

const router = Router();

const VALID_CARRIER_TYPES = ['Prepaid', 'FedEx', 'UPS', 'MachineDown', 'OtherCarrier', 'Freight'] as const;
type CarrierType = (typeof VALID_CARRIER_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Payment type and PO number echoed back to the caller from PUT /payment-selection. */
interface CheckoutPaymentSelection {
    paymentType: 'PO' | 'CreditCard';
    poNumber: string | null;
}

/** BC physical line item shape inside a checkout response. */
interface BcCheckoutLineItem {
    id: string;
    product_id: number;
    variant_id: number;
    name: string;
    sku: string;
    quantity: number;
    list_price: number;
    sale_price: number;
    image_url?: string;
}

/** BC consignment shape inside a checkout response. */
interface BcCheckoutConsignment {
    id: string;
    shipping_address: {
        first_name: string;
        last_name: string;
        address1: string;
        city: string;
        state_or_province: string;
        country_code: string;
        postal_code: string;
    };
    selected_shipping_option: {
        id: string;
        type: string;
        description: string;
        price: number;
    } | null;
    shipping_cost_inc_tax: number;
}

/** Full BC checkout object returned by GET /v3/checkouts/:id. */
interface BcCheckoutFull {
    id: string;
    cart: {
        id: string;
        customer_id: number;
        base_amount: number;
        cart_amount: number;
        line_items: { physical_items: BcCheckoutLineItem[] };
    };
    consignments: BcCheckoutConsignment[];
    taxes: Array<{ name: string; amount: number }>;
    tax_total: number;
    shipping_cost_total_inc_tax: number;
    subtotal_inc_tax: number;
    grand_total: number;
}

interface B2BAddress {
    addressId: number;
    companyId: string;
    firstName: string;
    lastName: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    stateName: string;
    stateCode: string;
    countryName: string;
    countryCode: string;
    zipCode?: string;
    phoneNumber?: string;
}

interface B2BOrderExtraField {
    fieldName: string;
    fieldValue: string;
}

interface CheckoutSubmitBody {
    cartId?: unknown;
    shipToAddressId?: unknown;
    billToAddressId?: unknown;
    carrierType?: unknown;
    carrierAccountNumber?: unknown;
    machineDownContactName?: unknown;
    machineDownContactPhone?: unknown;
    shippingMethod?: unknown;
    poNumber?: unknown;
    paymentMethod?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchB2BAddress(addressId: number): Promise<B2BAddress | null> {
    try {
        const res = await b2bClient.get<{ data: B2BAddress }>(`/api/v3/io/addresses/${addressId}`);
        return res.data?.data ?? null;
    } catch (err) {
        const status = (err as AxiosError).response?.status;
        if (status === 404) return null;
        throw err;
    }
}

/**
 * Write checkout metadata to B2B order extra fields in a single PUT call.
 * Fields are visible in the B2B admin portal and Buyer Portal against the order.
 */
async function writeB2BOrderExtraFields(bcOrderId: number, fields: B2BOrderExtraField[]): Promise<void> {
    await b2bClient.put(`/api/v3/io/orders/${bcOrderId}`, { extraFields: fields });
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/**
 * POST /v1/checkout/submit
 *
 * Full checkout orchestration: resolves B2B addresses, wires up BC checkout consignment
 * and billing address, creates the BC order, then writes carrier/PO data as B2B order
 * extra fields — visible in B2B admin portal and Buyer Portal against the order.
 *
 * Body:
 *   cartId                  - BC cart UUID (required)
 *   shipToAddressId         - B2B address ID for shipping destination (required)
 *   billToAddressId         - B2B address ID for billing (required)
 *   carrierType             - Prepaid | FedEx | UPS | MachineDown | OtherCarrier | Freight (required)
 *   carrierAccountNumber    - account number for FedEx, UPS, MachineDown (required for those carriers)
 *   machineDownContactName  - contact name (required when carrierType=MachineDown)
 *   machineDownContactPhone - contact phone (required when carrierType=MachineDown)
 *   shippingMethod          - method id selected by the user, e.g. "next_day" (required)
 *   poNumber                - purchase order number (required when paymentMethod is "purchase_order")
 *   paymentMethod           - "credit_card" | "purchase_order" (required)
 *
 * Response: { orderId: number, orderStatus: string }
 *
 * Note: credit-card payment completion is handled separately through the BlueSnap flow
 * (POST /payments/bc/token + BlueSnap hosted fields). This endpoint creates the BC order;
 * payment capture is a subsequent step for credit_card orders.
 */
router.post('/checkout/submit', async (req: Request, res: Response) => {
    const body = req.body as CheckoutSubmitBody;
    const {
        cartId,
        shipToAddressId,
        billToAddressId,
        carrierType,
        carrierAccountNumber,
        machineDownContactName,
        machineDownContactPhone,
        shippingMethod,
        poNumber,
        paymentMethod,
    } = body;

    // --- Validation ---
    if (!cartId || typeof cartId !== 'string' || !/^[0-9a-f-]{36}$/.test(cartId)) {
        return res.status(400).json({ error: 'cartId must be a valid UUID' });
    }

    if (
        !shipToAddressId ||
        typeof shipToAddressId !== 'number' ||
        !Number.isInteger(shipToAddressId) ||
        shipToAddressId <= 0
    ) {
        return res.status(400).json({ error: 'shipToAddressId must be a positive integer' });
    }
    if (
        !billToAddressId ||
        typeof billToAddressId !== 'number' ||
        !Number.isInteger(billToAddressId) ||
        billToAddressId <= 0
    ) {
        return res.status(400).json({ error: 'billToAddressId must be a positive integer' });
    }
    if (!carrierType || typeof carrierType !== 'string' || !VALID_CARRIER_TYPES.includes(carrierType as CarrierType)) {
        return res.status(400).json({ error: `carrierType must be one of: ${VALID_CARRIER_TYPES.join(', ')}` });
    }
    if (
        (carrierType === 'FedEx' || carrierType === 'UPS' || carrierType === 'MachineDown') &&
        (!carrierAccountNumber || typeof carrierAccountNumber !== 'string' || !(carrierAccountNumber as string).trim())
    ) {
        return res.status(400).json({ error: `carrierAccountNumber is required for ${carrierType}` });
    }
    if (carrierType === 'MachineDown') {
        if (
            !machineDownContactName ||
            typeof machineDownContactName !== 'string' ||
            !(machineDownContactName as string).trim()
        ) {
            return res.status(400).json({ error: 'machineDownContactName is required for MachineDown' });
        }
        if (
            !machineDownContactPhone ||
            typeof machineDownContactPhone !== 'string' ||
            !(machineDownContactPhone as string).trim()
        ) {
            return res.status(400).json({ error: 'machineDownContactPhone is required for MachineDown' });
        }
    }
    if (carrierType !== 'OtherCarrier') {
        if (!shippingMethod || typeof shippingMethod !== 'string' || !shippingMethod.trim()) {
            return res.status(400).json({ error: 'shippingMethod is required' });
        }
    } else if (shippingMethod !== undefined && shippingMethod !== null && typeof shippingMethod !== 'string') {
        return res.status(400).json({ error: 'shippingMethod must be a string when provided' });
    }
    if (paymentMethod !== 'credit_card' && paymentMethod !== 'purchase_order') {
        return res.status(400).json({ error: 'paymentMethod must be "credit_card" or "purchase_order"' });
    }
    if (paymentMethod === 'purchase_order') {
        if (!poNumber || typeof poNumber !== 'string' || !(poNumber as string).trim()) {
            return res.status(400).json({ error: 'poNumber is required when paymentMethod is "purchase_order"' });
        }
    } else if (poNumber !== undefined && poNumber !== null && typeof poNumber !== 'string') {
        return res.status(400).json({ error: 'poNumber must be a string when provided' });
    }

    try {
        // 1. Fetch the BC cart and both B2B addresses in parallel.
        //    Using the Cart API (not Checkout API) — the cart was created via the Cart API
        //    and order creation goes directly through the V2 Orders API, so the Checkout
        //    API pipeline is never needed.
        const [cartRes, shipAddr, billAddr] = await Promise.all([
            bcClient.get<{
                data: {
                    id: string;
                    customer_id: number;
                    line_items: {
                        physical_items: Array<{ product_id: number; variant_id: number; quantity: number }>;
                    };
                };
            }>(`/v3/carts/${cartId}`),
            fetchB2BAddress(shipToAddressId as number),
            fetchB2BAddress(billToAddressId as number),
        ]);

        if (!shipAddr) {
            return res.status(400).json({ error: `Ship-to address ${shipToAddressId} not found` });
        }
        if (!billAddr) {
            return res.status(400).json({ error: `Bill-to address ${billToAddressId} not found` });
        }
        if (!billAddr.zipCode?.trim()) {
            return res
                .status(400)
                .json({ error: 'Bill-to address is missing a postal code — update the address in the B2B portal' });
        }
        if (!shipAddr.zipCode?.trim()) {
            return res
                .status(400)
                .json({ error: 'Ship-to address is missing a postal code — update the address in the B2B portal' });
        }

        const cart = cartRes.data.data;
        const lineItems = (cart.line_items?.physical_items ?? []).map(item => ({
            product_id: item.product_id,
            variant_id: item.variant_id,
            quantity: item.quantity,
        }));

        if (lineItems.length === 0) {
            return res.status(400).json({ error: 'Cart has no items' });
        }

        // 2. Resolve customer email from BC using the cart's customer_id.
        const cartCustomerId = cart.customer_id;
        if (!cartCustomerId) {
            return res.status(403).json({ error: 'Forbidden: cart is not associated with a customer' });
        }
        const customerLookup = await bcClient.get<{ data: Array<{ email: string }> }>('/v3/customers', {
            params: { 'id:in': cartCustomerId },
        });
        const customerEmail = customerLookup.data?.data?.[0]?.email ?? '';
        if (!customerEmail) {
            return res.status(403).json({ error: 'Forbidden: could not resolve customer email' });
        }

        // 3. Create the BC order directly via V2 Orders API — bypasses shipping zone requirement.
        //    Carrier/method details are stored as B2B extra fields below, not in BC shipping fields.
        const bcAddress = (addr: B2BAddress, email: string) => ({
            first_name: addr.firstName,
            last_name: addr.lastName,
            email,
            street_1: addr.addressLine1,
            street_2: addr.addressLine2 ?? '',
            city: addr.city,
            state: addr.stateName,
            zip: addr.zipCode ?? '',
            country: addr.countryName,
            country_iso2: addr.countryCode,
            phone: addr.phoneNumber ?? '',
        });

        const orderRes = await bcClient.post<{ id: number; status: string }>('/v2/orders', {
            customer_id: cartCustomerId,
            billing_address: bcAddress(billAddr, customerEmail),
            shipping_addresses: [bcAddress(shipAddr, customerEmail)],
            products: lineItems,
            status_id: 11,
            payment_method: paymentMethod === 'purchase_order' ? 'Purchase Order' : 'Credit Card',
            ...(paymentMethod === 'purchase_order' && poNumber
                ? { payment_provider_id: (poNumber as string).trim() }
                : {}),
        });
        const { id: orderId, status: orderStatus } = orderRes.data;

        // 7. Build the B2B order extra fields payload — always-present fields first
        const extraFields: B2BOrderExtraField[] = [
            { fieldName: 'carrierType', fieldValue: carrierType as string },
            { fieldName: 'paymentMethod', fieldValue: paymentMethod as string },
        ];

        if (typeof shippingMethod === 'string' && shippingMethod.trim()) {
            extraFields.push({ fieldName: 'shippingMethod', fieldValue: shippingMethod.trim() });
        }

        if (typeof carrierAccountNumber === 'string' && carrierAccountNumber.trim()) {
            extraFields.push({ fieldName: 'carrierAccountNumber', fieldValue: carrierAccountNumber.trim() });
        }
        if (carrierType === 'MachineDown') {
            extraFields.push(
                { fieldName: 'machineDownContactName', fieldValue: (machineDownContactName as string).trim() },
                { fieldName: 'machineDownContactPhone', fieldValue: (machineDownContactPhone as string).trim() }
            );
        }
        if (typeof poNumber === 'string' && poNumber.trim()) {
            extraFields.push({ fieldName: 'poNumber', fieldValue: poNumber.trim() });
        }

        // 8. Write all fields to B2B in a single PUT — best-effort; order is already created so
        //    a B2B sync failure must not roll back the response.
        try {
            await writeB2BOrderExtraFields(orderId, extraFields);
        } catch (b2bErr) {
            logger.error(
                `checkout submit: B2B extra fields write failed for orderId=${orderId}: ${(b2bErr as Error).message} — B2B body: ${JSON.stringify((b2bErr as AxiosError).response?.data)}`
            );
        }

        logger.info(`checkout submit: orderId=${orderId} status=${orderStatus} carrier=${carrierType}`);
        return res.status(201).json({ orderId, orderStatus });
    } catch (err) {
        const axErr = err as AxiosError;
        const bcStatus = axErr.response?.status;
        if (bcStatus === 404) {
            return res.status(404).json({ error: 'Cart not found — it may have expired or been deleted' });
        }
        if (bcStatus === 400) {
            logger.error(`checkout submit 400 (cartId=${cartId}): ${JSON.stringify(axErr.response?.data)}`);
            return res.status(400).json({ error: 'BC rejected the order request — check server logs for details' });
        }
        if (bcStatus === 422) {
            logger.error(`checkout submit 422 (cartId=${cartId}): ${JSON.stringify(axErr.response?.data)}`);
            return res
                .status(422)
                .json({ error: 'Checkout could not be completed — invalid or incomplete checkout state' });
        }
        logger.error(
            `checkout submit error (cartId=${cartId}): ${(err as Error).message} — BC body: ${JSON.stringify(axErr.response?.data)}`
        );
        return res.status(500).json({ error: 'Failed to submit checkout' });
    }
});

// ---------------------------------------------------------------------------
// PUT /v1/checkout/:checkoutId/payment-selection
//
// Validates and echoes back the payment selection — stateless, nothing is stored.
// Callers are responsible for persisting the returned values client-side.
//
// Body:
//   paymentType - "PO" | "CreditCard" (required)
//   poNumber    - purchase order number (required when paymentType is "PO")
//
// Response: { checkoutId, paymentType, poNumber }
// ---------------------------------------------------------------------------

interface PaymentSelectionBody {
    paymentType?: unknown;
    poNumber?: unknown;
}

router.put('/checkout/:checkoutId/payment-selection', (req: Request<{ checkoutId: string }>, res: Response) => {
    const { checkoutId } = req.params;

    if (!/^[0-9a-f-]{36}$/.test(checkoutId)) {
        return res.status(400).json({ error: 'checkoutId must be a valid UUID' });
    }

    const { paymentType, poNumber } = req.body as PaymentSelectionBody;

    if (paymentType !== 'PO' && paymentType !== 'CreditCard') {
        return res.status(400).json({ error: 'paymentType must be "PO" or "CreditCard"' });
    }
    if (paymentType === 'PO' && (typeof poNumber !== 'string' || !poNumber.trim())) {
        return res.status(400).json({ error: 'poNumber is required when paymentType is "PO"' });
    }

    const selection: CheckoutPaymentSelection = {
        paymentType,
        poNumber: paymentType === 'PO' ? (poNumber as string).trim() : null,
    };

    logger.info(`payment-selection: checkoutId=${checkoutId} paymentType=${paymentType}`);
    return res.json({ checkoutId, ...selection });
});

// ---------------------------------------------------------------------------
// GET /v1/checkout/:checkoutId/review
//
// Aggregates BC checkout data (line items, shipping, totals).
//
// Response:
//   checkoutId, lineItems[], shipping{ address, methodDescription, cost },
//   totals{ subtotal, shippingCost, taxTotal, grandTotal }
// ---------------------------------------------------------------------------

async function fetchBcCheckoutFull(checkoutId: string): Promise<BcCheckoutFull | null> {
    try {
        const res = await bcClient.get<{ data: BcCheckoutFull }>(`/v3/checkouts/${checkoutId}`);
        return res.data?.data ?? null;
    } catch (err) {
        if ((err as AxiosError).response?.status === 404) return null;
        throw err;
    }
}

router.get('/checkout/:checkoutId/review', async (req: Request<{ checkoutId: string }>, res: Response) => {
    const { checkoutId } = req.params;

    if (!/^[0-9a-f-]{36}$/.test(checkoutId)) {
        return res.status(400).json({ error: 'checkoutId must be a valid UUID' });
    }

    try {
        const checkout = await fetchBcCheckoutFull(checkoutId);
        if (!checkout) {
            return res.status(404).json({ error: 'Checkout not found or has expired' });
        }

        const physicalItems = checkout.cart?.line_items?.physical_items ?? [];
        const consignment = checkout.consignments?.[0] ?? null;

        return res.json({
            checkoutId,
            lineItems: physicalItems.map(item => ({
                id: item.id,
                productId: item.product_id,
                variantId: item.variant_id,
                name: item.name,
                sku: item.sku,
                quantity: item.quantity,
                listPrice: item.list_price,
                salePrice: item.sale_price,
                imageUrl: item.image_url ?? null,
            })),
            shipping: consignment
                ? {
                      address: {
                          firstName: consignment.shipping_address.first_name,
                          lastName: consignment.shipping_address.last_name,
                          address1: consignment.shipping_address.address1,
                          city: consignment.shipping_address.city,
                          stateOrProvince: consignment.shipping_address.state_or_province,
                          countryCode: consignment.shipping_address.country_code,
                          postalCode: consignment.shipping_address.postal_code,
                      },
                      methodDescription: consignment.selected_shipping_option?.description ?? null,
                      cost: consignment.shipping_cost_inc_tax,
                  }
                : null,
            totals: {
                subtotal: checkout.subtotal_inc_tax,
                shippingCost: checkout.shipping_cost_total_inc_tax,
                taxTotal: checkout.tax_total,
                grandTotal: checkout.grand_total,
            },
        });
    } catch (err) {
        logger.error(`checkout review (checkoutId=${checkoutId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to load checkout review' });
    }
});

export default router;
