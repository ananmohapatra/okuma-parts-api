import { Router, Request, Response } from 'express';
import { AxiosError } from 'axios';
import bcClient from '../services/bigcommerce';
import b2bClient from '../services/b2b';
import { fetchB2BCompanyByUserEmail } from '../services/b2b-company';
import logger from '../config/logger';

const router = Router();

const VALID_CARRIER_TYPES = ['Prepaid', 'FedEx', 'UPS', 'MachineDown', 'OtherCarrier'] as const;
type CarrierType = (typeof VALID_CARRIER_TYPES)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface BcCheckoutAddress {
    first_name: string;
    last_name: string;
    email: string;
    address1: string;
    address2: string;
    city: string;
    state_or_province: string;
    state_or_province_code: string;
    country_code: string;
    postal_code: string;
    phone: string;
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

function toCheckoutAddress(addr: B2BAddress, email: string): BcCheckoutAddress {
    return {
        first_name: addr.firstName,
        last_name: addr.lastName,
        email,
        address1: addr.addressLine1,
        address2: addr.addressLine2 ?? '',
        city: addr.city,
        state_or_province: addr.stateName,
        state_or_province_code: addr.stateCode,
        country_code: addr.countryCode,
        postal_code: addr.zipCode ?? '',
        phone: addr.phoneNumber ?? '',
    };
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
 *   carrierType             - Prepaid | FedEx | UPS | MachineDown | OtherCarrier (required)
 *   carrierAccountNumber    - account number for FedEx, UPS, MachineDown (required for those carriers)
 *   machineDownContactName  - contact name (required when carrierType=MachineDown)
 *   machineDownContactPhone - contact phone (required when carrierType=MachineDown)
 *   shippingMethod          - method id selected by the user, e.g. "next_day_air" (required)
 *   poNumber                - purchase order number (optional)
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

    const session = req.session as unknown as { cartId?: string };
    if (!session.cartId) {
        return res.status(404).json({ error: 'No active cart.' });
    }
    if (session.cartId !== cartId) {
        return res.status(403).json({ error: 'Forbidden.' });
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
    if (poNumber !== undefined && poNumber !== null && typeof poNumber !== 'string') {
        return res.status(400).json({ error: 'poNumber must be a string when provided' });
    }

    try {
        // 1. Fetch the BC checkout and both B2B addresses in parallel
        const [checkoutRes, shipAddr, billAddr] = await Promise.all([
            bcClient.get<{
                data: {
                    id: string;
                    customer: { email: string };
                    line_items: { physical_items: Array<{ id: string; quantity: number }> };
                };
            }>(`/v3/checkouts/${cartId}`),
            fetchB2BAddress(shipToAddressId as number),
            fetchB2BAddress(billToAddressId as number),
        ]);

        if (!shipAddr) {
            return res.status(400).json({ error: `Ship-to address ${shipToAddressId} not found` });
        }
        if (!billAddr) {
            return res.status(400).json({ error: `Bill-to address ${billToAddressId} not found` });
        }

        const checkout = checkoutRes.data.data;
        const customerEmail = checkout.customer?.email ?? '';
        const lineItems = (checkout.line_items?.physical_items ?? []).map(item => ({
            item_id: item.id,
            quantity: item.quantity,
        }));

        if (lineItems.length === 0) {
            return res.status(400).json({ error: 'Cart has no items' });
        }

        // 2. Verify both addresses belong to the session customer's own company.
        //    This prevents a caller from submitting a checkout using another company's address IDs.
        const customerCompany = await fetchB2BCompanyByUserEmail(customerEmail);
        if (!customerCompany) {
            return res.status(403).json({ error: 'Forbidden: could not resolve your B2B company' });
        }
        const expectedCompanyId = String(customerCompany.companyId);
        if (String(shipAddr.companyId) !== expectedCompanyId) {
            return res.status(403).json({ error: 'Forbidden: ship-to address does not belong to your company' });
        }
        if (String(billAddr.companyId) !== expectedCompanyId) {
            return res.status(403).json({ error: 'Forbidden: bill-to address does not belong to your company' });
        }

        const shipCheckoutAddr = toCheckoutAddress(shipAddr, customerEmail);
        const billCheckoutAddr = toCheckoutAddress(billAddr, customerEmail);

        // 3. Add shipping consignment (ship-to address + all line items)
        const consignmentRes = await bcClient.post<{
            data: {
                consignments: Array<{
                    id: string;
                    available_shipping_options: Array<{ id: string; description: string }>;
                }>;
            };
        }>(`/v3/checkouts/${cartId}/consignments`, [
            {
                shipping_address: shipCheckoutAddr,
                line_items: lineItems,
            },
        ]);

        const consignment = consignmentRes.data.data.consignments?.[0];
        if (!consignment) {
            return res.status(502).json({ error: 'Failed to create checkout consignment' });
        }

        // 4. Select a shipping option if BC has any configured — BC requires a selection before
        //    an order can be created. The actual carrier and method the customer chose are stored
        //    as B2B order extra fields below.
        const availableOptions = consignment.available_shipping_options ?? [];
        if (availableOptions.length === 0) {
            return res
                .status(422)
                .json({
                    error: 'No shipping options are available for this checkout. Check shipping configuration/address.',
                });
        }
        await bcClient.put(`/v3/checkouts/${cartId}/consignments/${consignment.id}`, {
            shipping_option_id: availableOptions[0].id,
        });

        // 5. Set billing address on the checkout
        await bcClient.post(`/v3/checkouts/${cartId}/billing-address`, billCheckoutAddr);

        // 6. Create the BC order from the checkout
        const orderRes = await bcClient.post<{ data: { id: number; status: string } }>(
            `/v3/checkouts/${cartId}/orders`
        );
        const { id: orderId, status: orderStatus } = orderRes.data.data;

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

        // 8. Write all fields to B2B in a single PUT — visible in B2B admin portal and Buyer Portal
        await writeB2BOrderExtraFields(orderId, extraFields);

        logger.info(`checkout submit: orderId=${orderId} status=${orderStatus} carrier=${carrierType}`);
        return res.status(201).json({ orderId, orderStatus });
    } catch (err) {
        const axErr = err as AxiosError;
        const bcStatus = axErr.response?.status;
        if (bcStatus === 404) {
            return res.status(404).json({ error: 'Cart or checkout not found — it may have expired' });
        }
        if (bcStatus === 422) {
            logger.error(`checkout submit 422 (cartId=${cartId}): ${JSON.stringify(axErr.response?.data)}`);
            return res
                .status(422)
                .json({ error: 'Checkout could not be completed — invalid or incomplete checkout state' });
        }
        logger.error(`checkout submit error (cartId=${cartId}): ${(err as Error).message}`);
        return res.status(500).json({ error: 'Failed to submit checkout' });
    }
});

export default router;
