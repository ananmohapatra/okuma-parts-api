"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const express_1 = require("express");
const config_1 = __importDefault(require("../config"));
const bigcommerce_1 = __importDefault(require("../services/bigcommerce"));
const router = (0, express_1.Router)();
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function fetchDataJson(relativePath) {
    const cdnBase = config_1.default.partsBook.cdnBaseUrl;
    const url = `${cdnBase}/${relativePath}`;
    try {
        const res = await axios_1.default.get(url, { timeout: 15000 });
        return res.data;
    }
    catch (err) {
        if (axios_1.default.isAxiosError(err) && err.response?.status === 404) {
            return null;
        }
        console.error(`parts-book: failed to fetch ${url}:`, err.message);
        return null;
    }
}
function rewriteTocImagePaths(toc) {
    const cdnBase = config_1.default.partsBook.cdnBaseUrl;
    const rewrite = (relPath) => `${cdnBase}/${relPath}`;
    const documents = toc.documents.map(doc => {
        const assemblies = doc.assemblies.map(assembly => {
            const sheets = assembly.sheets.map(sheet => ({
                ...sheet,
                assembly_image: sheet.assembly_image ? rewrite(sheet.assembly_image) : sheet.assembly_image,
            }));
            return {
                ...assembly,
                overview_image: assembly.overview_image ? rewrite(assembly.overview_image) : assembly.overview_image,
                sheets,
            };
        });
        return {
            ...doc,
            overview_image: doc.overview_image ? rewrite(doc.overview_image) : doc.overview_image,
            assemblies,
        };
    });
    return { ...toc, documents };
}
function boxToPercent(box) {
    if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number' || Number.isNaN(v))) {
        return null;
    }
    const [ymin, xmin, ymax, xmax] = box;
    const cx = parseFloat(((xmin + xmax) / 2 / 10).toFixed(2));
    const cy = parseFloat(((ymin + ymax) / 2 / 10).toFixed(2));
    return { calloutX: cx, calloutY: cy };
}
async function fetchCategoryImages(categoryIds) {
    if (!categoryIds.length)
        return {};
    try {
        const response = await bigcommerce_1.default.get('/v3/catalog/categories', {
            params: {
                'id:in': categoryIds.join(','),
                limit: categoryIds.length,
                include_fields: 'id,image_url',
            },
        });
        const result = {};
        (response.data?.data || []).forEach(cat => {
            result[cat.id] = cat.image_url ?? '';
        });
        return result;
    }
    catch (err) {
        console.error('parts-book: category image lookup failed:', err.message);
        return {};
    }
}
// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/**
 * GET /api/parts-book/toc
 * GET /api/parts-book/toc?id=<pdfId>
 *
 * Without ?id  — returns the full table of contents enriched with BC CDN image
 *               paths and category images.
 * With    ?id  — returns a single document entry matching that pdfId.
 *               Responds 404 when the id is not found.
 */
router.get('/api/parts-book/toc', async (req, res) => {
    const toc = await fetchDataJson('toc.json');
    if (!toc) {
        console.error('parts-book: toc.json not found at', config_1.default.partsBook.cdnBaseUrl);
        return res.status(500).json({ error: 'Table of contents not available.' });
    }
    const rewritten = rewriteTocImagePaths(toc);
    // When ?id is provided, scope to that single document only
    const { id } = req.query;
    const sourceDocuments = id ? rewritten.documents.filter(d => d.id === id) : rewritten.documents;
    if (id && sourceDocuments.length === 0) {
        return res.status(404).json({ error: `Document '${id}' not found.` });
    }
    const categoryIds = sourceDocuments.map(d => d.category_id).filter((id1) => typeof id1 === 'number');
    const categoryImages = await fetchCategoryImages([...new Set(categoryIds)]);
    const documents = sourceDocuments.map(doc => ({
        ...doc,
        category_image: doc.category_id ? (categoryImages[doc.category_id] ?? '') : '',
    }));
    // When a single document was requested return it unwrapped for convenience
    if (id) {
        return res.json(documents[0]);
    }
    return res.json({ ...rewritten, documents });
});
router.get('/api/parts-book/sheets/:pdfId/:assemblySlug/:sheetSlug/parts', async (req, res) => {
    const { pdfId, assemblySlug, sheetSlug } = req.params;
    const toc = await fetchDataJson('toc.json');
    if (!toc) {
        console.error('parts-book: toc.json not found');
        return res.status(500).json({ error: 'Table of contents not available.' });
    }
    const doc = toc.documents.find(d => d.id === pdfId);
    if (!doc) {
        return res.status(404).json({ error: `Document '${pdfId}' not found.` });
    }
    const assembly = doc.assemblies.find(a => a.slug === assemblySlug);
    if (!assembly) {
        return res.status(404).json({ error: `Assembly '${assemblySlug}' not found.` });
    }
    const sheet = assembly.sheets.find(s => s.slug === sheetSlug);
    if (!sheet) {
        return res.status(404).json({ error: `Sheet '${sheetSlug}' not found.` });
    }
    const partsData = await fetchDataJson(sheet.parts_json);
    if (!partsData) {
        console.error(`parts-book: parts.json not found at ${sheet.parts_json}`);
        return res.status(500).json({ error: 'Parts data not available for this sheet.' });
    }
    const rawParts = partsData.parts ?? [];
    const matchedSkus = [
        ...new Set(rawParts.filter(p => p.has_table_match && p.part_no).map(p => p.part_no)),
    ];
    const bcLookup = {};
    if (matchedSkus.length > 0) {
        try {
            const response = await bigcommerce_1.default.get('/v3/catalog/products', {
                params: {
                    'sku:in': matchedSkus.join(','),
                    limit: 50,
                    include_fields: 'id,sku,name,price,inventory_level,inventory_tracking,availability',
                },
            });
            const bcProducts = response.data?.data ?? [];
            bcProducts.forEach(product => {
                const notTracked = product.inventory_tracking === 'none';
                const inStock = product.availability === 'available' && (notTracked || product.inventory_level > 0);
                bcLookup[product.sku] = {
                    productId: product.id,
                    price: product.price,
                    inStock,
                };
            });
        }
        catch (err) {
            console.error('parts-book: BC product lookup failed:', err.message);
        }
    }
    const parts = rawParts.map(p => {
        const coords = p.callout_box_2d != null ? boxToPercent(p.callout_box_2d) : null;
        const { calloutX = null, calloutY = null } = coords ?? {};
        const bc = p.part_no ? (bcLookup[p.part_no] ?? null) : null;
        return {
            calloutNumber: p.callout_number,
            sheetItem: p.sheet_item,
            partNo: p.part_no,
            description: p.description,
            unitNo: p.unit_no,
            qty: p.qty,
            calloutX,
            calloutY,
            price: bc ? bc.price : null,
            inStock: bc ? bc.inStock : false,
            productId: bc ? bc.productId : null,
            hasTableMatch: p.has_table_match === true,
        };
    });
    const cdnBase = config_1.default.partsBook.cdnBaseUrl;
    return res.json({
        sheet: {
            id: sheet.id,
            label: sheet.label,
            sheetNumber: sheet.sheet_number,
            diagramUrl: sheet.assembly_image ? `${cdnBase}/${sheet.assembly_image}` : null,
        },
        parts,
    });
});
// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------
const MACHINE_PARENT_IDS = [301, 302, 303, 304];
const PARENT_LABELS = {
    301: 'Grinding Machines',
    302: 'Turning Centers',
    303: 'Multi-Tasking Machines',
    304: 'Machining Centers',
};
const PUB_NO_RE = /Pub\s+No\.\s*([A-Z]{2}\d{2}-\d{3}-[A-Z0-9]+)/gi;
function parsePubNos(description) {
    if (!description)
        return [];
    const plain = description.replace(/<[^>]+>/g, ' ');
    return [...plain.matchAll(PUB_NO_RE)].map(m => m[1]);
}
// Cache for machine categories — avoids a BC API call on every request.
// TTL of 5 minutes; categories change rarely in production.
let _machineCategoryCache = null;
let _machineCategoryCachedAt = 0;
const MACHINE_CATEGORY_TTL = 5 * 60 * 1000;
/**
 * Fetch all machine model categories from BC OOTB categories API and cache
 * the result for MACHINE_CATEGORY_TTL milliseconds.
 *
 * BC OOTB: GET /v3/catalog/categories?parent_id:in=301,302,303,304
 *   &include_fields=id,name,image_url,parent_id,description&limit=250
 *
 * image_url  → category image (direct from BC)
 * description → pub numbers parsed out of the HTML description field
 */
async function fetchMachineCategories() {
    const now = Date.now();
    if (_machineCategoryCache && now - _machineCategoryCachedAt < MACHINE_CATEGORY_TTL) {
        return _machineCategoryCache;
    }
    const response = await bigcommerce_1.default.get('/v3/catalog/categories', {
        params: {
            'parent_id:in': MACHINE_PARENT_IDS.join(','),
            limit: 250,
            include_fields: 'id,name,image_url,parent_id,description',
        },
    });
    _machineCategoryCache = (response.data?.data ?? []).map(cat => ({
        categoryId: cat.id,
        name: cat.name,
        machineType: PARENT_LABELS[cat.parent_id] ?? null,
        imageUrl: cat.image_url ?? '',
        pubNos: parsePubNos(cat.description),
        _normalised: cat.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
    }));
    _machineCategoryCachedAt = now;
    return _machineCategoryCache;
}
/**
 * GET /api/machines
 *
 * Returns all machine model categories enriched with BC category image
 * (image_url from BC OOTB) and pub number parsed from the BC description field.
 * Uses the shared fetchMachineCategories cache — no extra BC call when warm.
 */
router.get('/api/machines', async (_req, res) => {
    try {
        const categories = await fetchMachineCategories();
        const machines = categories.map(cat => ({
            categoryId: cat.categoryId,
            name: cat.name,
            machineType: cat.machineType,
            imageUrl: cat.imageUrl,
            pubNos: cat.pubNos,
        }));
        return res.json({ machines });
    }
    catch (err) {
        console.error('machines: BC category fetch failed:', err.message);
        return res.status(500).json({ error: 'Could not load machine list.' });
    }
});
function matchCategory(modelName, categories) {
    if (!modelName)
        return null;
    const norm = modelName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const exact = categories.find(c => c._normalised === norm);
    if (exact)
        return exact;
    const sub = categories.find(c => norm.includes(c._normalised) || c._normalised.includes(norm));
    if (sub)
        return sub;
    const series = modelName.toLowerCase().match(/^[a-z]+/);
    if (series) {
        const seriesNorm = series[0];
        const seriesMatch = categories.find(c => c._normalised.startsWith(seriesNorm));
        if (seriesMatch)
            return seriesMatch;
    }
    return null;
}
router.get('/api/customer/:customerId/machines', async (req, res) => {
    const { customerId } = req.params;
    if (!customerId || !/^\d+$/.test(customerId)) {
        return res.status(400).json({ error: 'Invalid customerId.' });
    }
    try {
        const [metaRes, categories] = await Promise.all([
            bigcommerce_1.default.get(`/v3/customers/${customerId}/metafields`),
            fetchMachineCategories(),
        ]);
        const metafields = metaRes.data?.data ?? [];
        const rmField = metafields.find(m => m.key === 'registered_machines' && m.namespace === 'okuma');
        if (!rmField) {
            return res.json({ machines: [] });
        }
        let rawMachines;
        try {
            rawMachines = JSON.parse(rmField.value);
        }
        catch {
            console.error(`customer ${customerId}: registered_machines metafield is not valid JSON`);
            return res.json({ machines: [] });
        }
        if (!Array.isArray(rawMachines)) {
            return res.json({ machines: [] });
        }
        const seenSerials = new Set();
        const machines = rawMachines
            .filter(m => m.status !== 'Inactive')
            .filter(m => {
            const serial = m.serial ?? '';
            if (!serial || seenSerials.has(serial))
                return false;
            seenSerials.add(serial);
            return true;
        })
            .map(m => {
            const cat = matchCategory(m.model, categories);
            return {
                serial: m.serial ?? null,
                model: m.model ?? null,
                installDate: m.install_date ?? null,
                status: m.status ?? null,
                imageUrl: cat ? cat.imageUrl : '',
                pubNos: cat ? cat.pubNos : [],
                hasPartsBook: !!(cat && cat.pubNos.length),
                machineType: cat ? cat.machineType : null,
                categoryId: cat ? cat.categoryId : null,
            };
        });
        return res.json({ count: machines.length, machines });
    }
    catch (err) {
        console.error(`customer ${customerId}: machine lookup failed:`, err.message);
        return res.status(500).json({ error: 'Could not load customer machines.' });
    }
});
router.get('/api/parts-book/machine/verify', (req, res) => {
    const { serialNo } = req.query;
    if (!serialNo) {
        return res.status(400).json({ error: 'serialNo query parameter is required.' });
    }
    return res.json({
        verified: true,
        model: 'LU300-M',
        serialNo,
        stockCondition: 'Active',
    });
});
exports.default = router;
//# sourceMappingURL=parts-book.js.map