import { Router, Request, Response } from 'express';

const router = Router();

type CarrierType = 'Prepaid' | 'FedEx' | 'UPS' | 'MachineDown' | 'OtherCarrier';

interface ShippingMethod {
    id: string;
    name: string;
    estimatedDelivery: string;
}

const SHIPPING_METHODS: Record<CarrierType, ShippingMethod[]> = {
    Prepaid: [
        { id: 'next_day_air', name: 'Next Day Air', estimatedDelivery: '1 business day' },
        { id: 'two_day_air', name: '2-Day Air', estimatedDelivery: '2 business days' },
        { id: 'three_day_select', name: '3-Day Select', estimatedDelivery: '3 business days' },
        { id: 'ground', name: 'Ground', estimatedDelivery: '5–7 business days' },
    ],
    FedEx: [
        { id: 'next_day_air', name: 'FedEx Overnight', estimatedDelivery: '1 business day' },
        { id: 'two_day_air', name: 'FedEx 2Day', estimatedDelivery: '2 business days' },
        { id: 'three_day_select', name: 'FedEx Express Saver', estimatedDelivery: '3 business days' },
        { id: 'ground', name: 'FedEx Ground', estimatedDelivery: '5–7 business days' },
    ],
    UPS: [
        { id: 'next_day_air', name: 'UPS Next Day Air', estimatedDelivery: '1 business day' },
        { id: 'two_day_air', name: 'UPS 2nd Day Air', estimatedDelivery: '2 business days' },
        { id: 'three_day_select', name: 'UPS 3 Day Select', estimatedDelivery: '3 business days' },
        { id: 'ground', name: 'UPS Ground', estimatedDelivery: '5–7 business days' },
    ],
    MachineDown: [
        { id: 'next_day_air', name: 'Next Day Air', estimatedDelivery: '1 business day' },
        { id: 'two_day_air', name: '2-Day Air', estimatedDelivery: '2 business days' },
        { id: 'three_day_select', name: '3-Day Select', estimatedDelivery: '3 business days' },
        { id: 'ground', name: 'Ground', estimatedDelivery: '5–7 business days' },
        { id: 'expedited', name: 'Expedited Delivery', estimatedDelivery: 'Same day / next available flight' },
    ],
    OtherCarrier: [],
};

const VALID_CARRIERS = Object.keys(SHIPPING_METHODS) as CarrierType[];

/**
 * GET /v1/api/shipping/methods?carrier=<type>
 *
 * Returns available shipping methods and estimated delivery text for the given carrier type.
 * OtherCarrier returns an empty methods array (carrier-managed, no method selection).
 *
 * Query params:
 *   carrier - Prepaid | FedEx | UPS | MachineDown | OtherCarrier (required)
 *
 * Response: { carrier: string, methods: [{ id, name, estimatedDelivery }] }
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

    return res.json({ carrier, methods: SHIPPING_METHODS[carrier as CarrierType] });
});

export default router;
