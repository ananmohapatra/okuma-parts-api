import { Router } from 'express';
import fetchCustomerProfile from '../services/customerProfile';
import { fetchB2BCompanyByUserEmail, buildCompanyExtraFieldsMap } from '../services/b2b-company';
import logger from '../config/logger';

const router = Router();

/**
 * GET /api/customer/:customerId/profile
 *
 * Returns a customer's basic profile plus their B2B job title (read from the
 * customer's B2B company's extra fields via their email).
 *
 * Params: customerId - BC customer ID (route param, numeric).
 * Response: { firstName, lastName, email, phone, company, jobTitle }
 */
router.get('/api/customer/:customerId/profile', async (req, res) => {
    const { customerId } = req.params;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    if (req.session.customerId !== customerId) {
        return res.status(403).json({ error: 'Forbidden.' });
    }

    try {
        const customer = await fetchCustomerProfile(customerId);

        if (!customer) {
            return res.status(404).json({ error: 'Customer not found.' });
        }

        // Fetch job_title from B2B company extra fields
        const company = await fetchB2BCompanyByUserEmail(customer.email);
        const companyExtraFields = buildCompanyExtraFieldsMap(company?.extraFields);

        return res.json({
            firstName: customer.first_name,
            lastName: customer.last_name,
            email: customer.email,
            phone: customer.phone || null,
            company: customer.company || null,
            jobTitle: companyExtraFields.job_title ?? null,
        });
    } catch (err) {
        logger.error(`customer ${customerId}: profile fetch failed: ${(err as Error).message}`);
        return res.status(500).json({ error: 'Could not load customer profile.' });
    }
});

export default router;
