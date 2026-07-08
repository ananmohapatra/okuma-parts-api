import { Router } from 'express';
import bcClient from '../services/bigcommerce';
import logger from '../config/logger';

const router = Router();

interface BcMetafield {
    key: string;
    namespace: string;
    value: string;
}

interface BcCustomer {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
    company: string;
}

router.get('/api/customer/:customerId/profile', async (req, res) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }

    // TODO: add auth guard once session population is confirmed (req.session.customerId === customerId)

    try {
        const [customerRes, metaRes] = await Promise.all([
            bcClient.get<{ data: BcCustomer[] }>(`/v3/customers?id:in=${customerId}`),
            bcClient.get<{ data: BcMetafield[] }>(`/v3/customers/${customerId}/metafields`),
        ]);

        const customer = customerRes.data?.data?.[0];
        if (!customer) {
            return res.status(404).json({ error: 'Customer not found.' });
        }

        const okumaMeta = (metaRes.data?.data ?? []).filter(m => m.namespace === 'okuma');
        const getValue = (key: string): string | null => okumaMeta.find(m => m.key === key)?.value ?? null;

        return res.json({
            firstName: customer.first_name,
            lastName: customer.last_name,
            email: customer.email,
            phone: customer.phone || null,
            company: customer.company || null,
            jobTitle: getValue('job_title'),
        });
    } catch (err) {
        logger.error(`customer ${customerId}: profile fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load customer profile.' });
    }
});

export default router;
