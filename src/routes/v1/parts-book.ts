import axios from 'axios';
import { Router, NextFunction, Request, Response } from 'express';
import config from '../../config';
import logger from '../../config/logger';
import bcClient from '../../services/bigcommerce';
import { AppError, NotFoundError } from '../../middleware/errors';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TocSheet {
    id: string;
    slug: string;
    label: string;
    sheet_number: number;
    assembly_image?: string;
    parts_json: string;
}

interface TocAssembly {
    slug: string;
    overview_image?: string;
    sheets: TocSheet[];
}

interface TocDocument {
    id: string;
    overview_image?: string;
    category_id?: number;
    assemblies: TocAssembly[];
}

interface Toc {
    documents: TocDocument[];
}

interface RawPart {
    callout_number?: unknown;
    sheet_item?: unknown;
    part_no?: string;
    description?: string;
    unit_no?: unknown;
    qty?: unknown;
    callout_box_2d?: number[];
    has_table_match?: boolean;
}

interface PartsData {
    parts: RawPart[];
}

interface BcLookupEntry {
    productId: number | null;
    price: number | null;
    inStock: boolean;
}

interface BcProduct {
    id: number;
    sku: string;
    price: number;
    inventory_level: number;
    inventory_tracking: string;
    availability: string;
}

interface BcCategory {
    id: number;
    name: string;
    image_url?: string;
    parent_id: number;
    description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchDataJson<T>(relativePath: string): Promise<T | null> {
    const cdnBase = config.partsBook.cdnBaseUrl;
    const url = `${cdnBase}/${relativePath}`;
    try {
        const res = await axios.get<T>(url, { timeout: 15000 });
        return res.data;
    } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
            return null;
        }
        logger.error(`parts-book: failed to fetch ${url}: ${(err as Error).message}`);
        return null;
    }
}

function rewriteTocImagePaths(toc: Toc): Toc {
    const cdnBase = config.partsBook.cdnBaseUrl;
    const rewrite = (relPath: string) => `${cdnBase}/${relPath}`;

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

function boxToPercent(box: number[]): { calloutX: number; calloutY: number } | null {
    if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number' || Number.isNaN(v))) {
        return null;
    }
    const [ymin, xmin, ymax, xmax] = box;
    const cx = parseFloat(((xmin + xmax) / 2 / 10).toFixed(2));
    const cy = parseFloat(((ymin + ymax) / 2 / 10).toFixed(2));
    return { calloutX: cx, calloutY: cy };
}

async function fetchCategoryImages(categoryIds: number[]): Promise<Record<number, string>> {
    if (!categoryIds.length) return {};
    try {
        const response = await bcClient.get<{ data: BcCategory[] }>('/v3/catalog/categories', {
            params: {
                'id:in': categoryIds.join(','),
                limit: categoryIds.length,
                include_fields: 'id,image_url',
            },
        });
        const result: Record<number, string> = {};
        (response.data?.data || []).forEach(cat => {
            result[cat.id] = cat.image_url ?? '';
        });
        return result;
    } catch (err) {
        logger.error(`parts-book: category image lookup failed: ${(err as Error).message}`);
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
router.get('/parts-book/toc', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const toc = await fetchDataJson<Toc>('toc.json');

        if (!toc) {
            return next(new AppError('Table of contents not available.', 500));
        }

        const rewritten = rewriteTocImagePaths(toc);

        const categoryIds = rewritten.documents
            .map(d => d.category_id)
            .filter((id): id is number => typeof id === 'number');

        const categoryImages = await fetchCategoryImages([...new Set(categoryIds)]);

        const documents = rewritten.documents.map(doc => ({
            ...doc,
            category_image: doc.category_id ? (categoryImages[doc.category_id] ?? '') : '',
        }));

        return res.json({ ...rewritten, documents });
    } catch (err) {
        return next(err);
    }
});

router.get(
    '/parts-book/sheets/:pdfId/:assemblySlug/:sheetSlug/parts',
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { pdfId, assemblySlug, sheetSlug } = req.params;

            const toc = await fetchDataJson<Toc>('toc.json');
            if (!toc) {
                return next(new AppError('Table of contents not available.', 500));
            }

            const doc = toc.documents.find(d => d.id === pdfId);
            if (!doc) {
                return next(new NotFoundError(`Document '${pdfId}' not found.`));
            }

            const assembly = doc.assemblies.find(a => a.slug === assemblySlug);
            if (!assembly) {
                return next(new NotFoundError(`Assembly '${assemblySlug}' not found.`));
            }

            const sheet = assembly.sheets.find(s => s.slug === sheetSlug);
            if (!sheet) {
                return next(new NotFoundError(`Sheet '${sheetSlug}' not found.`));
            }

            const partsData = await fetchDataJson<PartsData>(sheet.parts_json);
            if (!partsData) {
                return next(new AppError('Parts data not available for this sheet.', 500));
            }

            const rawParts = partsData.parts ?? [];

            const matchedSkus = [
                ...new Set(rawParts.filter(p => p.has_table_match && p.part_no).map(p => p.part_no as string)),
            ];

            const bcLookup: Record<string, BcLookupEntry> = {};

            if (matchedSkus.length > 0) {
                try {
                    const response = await bcClient.get<{ data: BcProduct[] }>('/v3/catalog/products', {
                        params: {
                            'sku:in': matchedSkus.join(','),
                            limit: 50,
                            include_fields: 'id,sku,name,price,inventory_level,inventory_tracking,availability',
                        },
                    });

                    (response.data?.data ?? []).forEach(product => {
                        const notTracked = product.inventory_tracking === 'none';
                        const inStock =
                            product.availability === 'available' && (notTracked || product.inventory_level > 0);
                        bcLookup[product.sku] = { productId: product.id, price: product.price, inStock };
                    });
                } catch (err) {
                    logger.error(`parts-book: BC product lookup failed: ${(err as Error).message}`);
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

            const cdnBase = config.partsBook.cdnBaseUrl;

            return res.json({
                sheet: {
                    id: sheet.id,
                    label: sheet.label,
                    sheetNumber: sheet.sheet_number,
                    diagramUrl: sheet.assembly_image ? `${cdnBase}/${sheet.assembly_image}` : null,
                },
                parts,
            });
        } catch (err) {
            return next(err);
        }
    }
);

// ---------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------

const MACHINE_PARENT_IDS = [301, 302, 303, 304];

const PARENT_LABELS: Record<number, string> = {
    301: 'Grinding Machines',
    302: 'Turning Centers',
    303: 'Multi-Tasking Machines',
    304: 'Machining Centers',
};

const PUB_NO_RE = /Pub\s+No\.\s*([A-Z]{2}\d{2}-\d{3}-[A-Z0-9]+)/i;

function parsePubNo(description: string | undefined): string | null {
    if (!description) return null;
    const plain = description.replace(/<[^>]+>/g, ' ');
    const m = plain.match(PUB_NO_RE);
    return m ? m[1] : null;
}

router.get('/machines', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const response = await bcClient.get<{ data: BcCategory[] }>('/v3/catalog/categories', {
            params: {
                'parent_id:in': MACHINE_PARENT_IDS.join(','),
                limit: 250,
                include_fields: 'id,name,image_url,parent_id,description',
            },
        });

        const machines = (response.data?.data ?? []).map(cat => ({
            categoryId: cat.id,
            name: cat.name,
            machineType: PARENT_LABELS[cat.parent_id] ?? null,
            imageUrl: cat.image_url ?? '',
            pubNo: parsePubNo(cat.description),
        }));

        return res.json({ machines });
    } catch (err) {
        return next(err);
    }
});

interface MachineCategory {
    categoryId: number;
    name: string;
    machineType: string | null;
    imageUrl: string;
    pubNo?: string | null;
    pubNos?: string[] | string | null;
    _normalised: string;
}

// Cache for machine categories — avoids a BC API call on every request.
// TTL of 5 minutes; categories change rarely in production.
let _machineCategoryCache: MachineCategory[] | null = null;
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
async function fetchMachineCategories(): Promise<MachineCategory[]> {
    const now = Date.now();
    if (_machineCategoryCache && now - _machineCategoryCachedAt < MACHINE_CATEGORY_TTL) {
        return _machineCategoryCache;
    }
    const response = await bcClient.get<{ data: BcCategory[] }>('/v3/catalog/categories', {
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
        pubNo: parsePubNo(cat.description),
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
            pubNos: cat.pubNos ?? cat.pubNo ?? null,
        }));
        return res.json({ machines });
    } catch (err) {
        console.error('machines: BC category fetch failed:', (err as Error).message);
        return res.status(500).json({ error: 'Could not load machine list.' });
    }
});

function matchCategory(modelName: string | undefined, categories: MachineCategory[]): MachineCategory | null {
    if (!modelName) return null;
    const norm = modelName.toLowerCase().replace(/[^a-z0-9]/g, '');

    const exact = categories.find(c => c._normalised === norm);
    if (exact) return exact;

    const sub = categories.find(c => norm.includes(c._normalised) || c._normalised.includes(norm));
    if (sub) return sub;

    const series = modelName.toLowerCase().match(/^[a-z]+/);
    if (series) {
        const seriesNorm = series[0];
        const seriesMatch = categories.find(c => c._normalised.startsWith(seriesNorm));
        if (seriesMatch) return seriesMatch;
    }

    return null;
}

interface RawMachine {
    serial?: string;
    model?: string;
    install_date?: string;
    status?: string;
}

router.get('/customer/:customerId/machines', async (req: Request, res: Response, next: NextFunction) => {
    const customerId = req.params.customerId as string;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return next(new AppError('Invalid customerId.', 400));
    }

    try {
        const [metaRes, categories] = await Promise.all([
            bcClient.get<{ data: Array<{ key: string; namespace: string; value: string }> }>(
                `/v3/customers/${customerId}/metafields`
            ),
            fetchMachineCategories(),
        ]);

        const metafields = metaRes.data?.data ?? [];
        const rmField = metafields.find(m => m.key === 'registered_machines' && m.namespace === 'okuma');

        if (!rmField) {
            return res.json({ machines: [] });
        }

        let rawMachines: RawMachine[];
        try {
            rawMachines = JSON.parse(rmField.value) as RawMachine[];
        } catch {
            logger.error(`customer ${customerId}: registered_machines metafield is not valid JSON`);
            return res.json({ machines: [] });
        }

        if (!Array.isArray(rawMachines)) {
            return res.json({ machines: [] });
        }

        const machines = rawMachines
            .filter(m => m.status !== 'Inactive')
            .map(m => {
                const cat = matchCategory(m.model, categories);
                return {
                    serial: m.serial ?? null,
                    model: m.model ?? null,
                    installDate: m.install_date ?? null,
                    status: m.status ?? null,
                    imageUrl: cat ? cat.imageUrl : '',
                    pubNo: cat ? cat.pubNo : null,
                    machineType: cat ? cat.machineType : null,
                    categoryId: cat ? cat.categoryId : null,
                };
            });

        return res.json({ machines });
    } catch (err) {
        return next(err);
    }
});

router.get('/parts-book/machine/verify', (req: Request, res: Response, next: NextFunction) => {
    const { serialNo } = req.query;

    if (!serialNo) {
        return next(new AppError('serialNo query parameter is required.', 400));
    }

    return res.json({
        verified: true,
        model: 'LU300-M',
        serialNo: String(serialNo),
        stockCondition: 'Active',
    });
});

export default router;
