"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bigcommerce_1 = __importDefault(require("../services/bigcommerce"));
const router = (0, express_1.Router)();
router.get('/api/customer/:customerId/profile', async (req, res) => {
    const { customerId } = req.params;
    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    // TODO: add auth guard once session population is confirmed (req.session.customerId === customerId)
    try {
        const metaRes = await bigcommerce_1.default.get(`/v3/customers/${customerId}/metafields`);
        const okumaMeta = (metaRes.data?.data ?? []).filter(m => m.namespace === 'okuma');
        const getValue = (key) => okumaMeta.find(m => m.key === key)?.value ?? null;
        return res.json({
            jobTitle: getValue('job_title'),
        });
    }
    catch (err) {
        console.error(`customer ${customerId}: profile metafield lookup failed:`, err.message);
        return res.status(500).json({ error: 'Could not load customer profile.' });
    }
});
/**
 * GET /api/customer/:customerId/addresses
 *
 * Proxies BC v2 customer addresses server-side so the X-Auth-Token
 * is never exposed to the browser.
 *
 * BC OOTB: GET /v2/customers/:customerId/addresses
 */
router.get('/api/customer/:customerId/addresses', async (req, res) => {
    const { customerId } = req.params;
    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    try {
        const bcRes = await bigcommerce_1.default.get(`/v2/customers/${customerId}/addresses`);
        const addresses = Array.isArray(bcRes.data) ? bcRes.data : [];
        return res.json({
            count: addresses.length,
            addresses: addresses.map(a => ({
                id: a.id,
                firstName: a.first_name,
                lastName: a.last_name,
                company: a.company || null,
                street1: a.street_1,
                street2: a.street_2 || null,
                city: a.city,
                state: a.state,
                zip: a.zip,
                country: a.country,
                countryCode: a.country_code,
                phone: a.phone || null,
                addressType: a.address_type,
            })),
        });
    }
    catch (err) {
        console.error(`customer ${customerId}: address fetch failed:`, err.message);
        return res.status(500).json({ error: 'Could not load customer addresses.' });
    }
});
exports.default = router;
//# sourceMappingURL=customers.js.map