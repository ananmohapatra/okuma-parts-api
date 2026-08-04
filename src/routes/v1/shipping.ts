import { Router, Request, Response } from 'express';

const router = Router();

type CarrierType = 'Prepaid' | 'FedEx' | 'UPS' | 'MachineDown' | 'OtherCarrier';

interface ShippingMethod {
    id: string;
    name: string;
    estimatedDelivery: string;
}

// Freight is a carrier-agnostic shipping method included for every carrier that supports method selection.
const FREIGHT_METHOD: ShippingMethod = {
    id: 'freight',
    name: 'Freight (carrier-agnostic)',
    estimatedDelivery: 'Varies by carrier',
};

// Base methods shared by Prepaid, FedEx, UPS, and MachineDown. No pricing in Phase 1 — timelines only.
const STANDARD_METHODS: ShippingMethod[] = [
    { id: 'next_day', name: 'Next Day', estimatedDelivery: '1 business day' },
    { id: 'two_day', name: '2-Day', estimatedDelivery: '2 business days' },
    { id: 'three_day', name: '3-Day', estimatedDelivery: '3 business days' },
    { id: 'ground', name: 'Ground', estimatedDelivery: '5–7 business days' },
    FREIGHT_METHOD,
];

const SHIPPING_METHODS: Record<CarrierType, ShippingMethod[]> = {
    // Okuma-managed via FedEx; no carrier account number required.
    Prepaid: STANDARD_METHODS,

    // Customer's FedEx account; account number required.
    FedEx: STANDARD_METHODS,

    // Customer's UPS account; account number required.
    UPS: STANDARD_METHODS,

    // FedEx International Expedite for urgent global shipments; account number + contact required.
    MachineDown: [
        ...STANDARD_METHODS,
        { id: 'expedited_delivery', name: 'Expedited Delivery', estimatedDelivery: 'Same day / next available flight' },
    ],

    // Distributor arranges shipment; no method selection needed.
    OtherCarrier: [],
};

// Carriers that require no method selection (frontend should hide the method picker).
const CARRIERS_WITHOUT_METHODS: CarrierType[] = ['OtherCarrier'];

const VALID_CARRIERS = Object.keys(SHIPPING_METHODS) as CarrierType[];

/**
 * GET /v1/api/shipping/methods?carrier=<type>
 *
 * Returns available shipping methods and estimated delivery text for the given carrier type.
 * OtherCarrier returns an empty methods array (carrier-managed, no method selection).
 * Freight is a method included in every carrier list that supports method selection — not a carrier itself.
 * No shipping cost calculation in Phase 1 — all methods expose estimatedDelivery only.
 *
 * Query params:
 *   carrier - Prepaid | FedEx | UPS | MachineDown | OtherCarrier (required)
 *
 * Response: { carrier, requiresMethodSelection, methods: [{ id, name, estimatedDelivery }] }
 */
router.get('/shipping/methods', (req: Request, res: Response) => {
    const { carrier } = req.query;

    if (!carrier || typeof carrier !== 'string') {
        return res
            .status(400)
            .json({ error: `carrier query param is required. Valid values: ${VALID_CARRIERS.join(', ')}` });
    }

    if (!VALID_CARRIERS.includes(carrier as CarrierType)) {
        return res.status(400).json({ error: `Invalid carrier. Valid values: ${VALID_CARRIERS.join(', ')}` });
    }

    const carrierType = carrier as CarrierType;

    return res.json({
        carrier: carrierType,
        requiresMethodSelection: !CARRIERS_WITHOUT_METHODS.includes(carrierType),
        methods: SHIPPING_METHODS[carrierType],
    });
});

export default router;
