import axios from 'axios';
import { Router, NextFunction, Request, Response } from 'express';
import config from '../../config';
import logger from '../../config/logger';
import bcClient from '../../services/bigcommerce';
import b2bClient from '../../services/b2b';
import { AppError, NotFoundError } from '../../middleware/errors';

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TocSheet {
    id?: string;
    slug: string;
    label: string;
    sheet_number: number;
    assembly_image?: string;
    table_image?: string;
    parts_json: string;
}

interface TocAssembly {
    slug: string;
    label?: string;
    assembly_json?: string;
    overview_image?: string;
    sheets: TocSheet[];
    subassemblies?: TocAssembly[];
}

interface TocDocument {
    id: string;
    label?: string;
    overview_image?: string;
    category_id?: number;
    assemblies: TocAssembly[];
}

interface Toc {
    documents: TocDocument[];
}

interface RawPart {
    box_id?: string;
    callout_number?: unknown;
    callout_instance_index?: number;
    sheet_item?: unknown;
    item_number?: number;
    part_no?: string;
    description?: string;
    unit_no?: unknown;
    qty?: unknown;
    callout_box_2d?: number[];
    table_row_box_2d?: number[];
    has_table_match?: boolean;
    matching_table_row_count?: number;
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

function rewriteAssembly(assembly: TocAssembly, rewrite: (p: string) => string): TocAssembly {
    const sheets = assembly.sheets.map(sheet => ({
        ...sheet,
        assembly_image: sheet.assembly_image ? rewrite(sheet.assembly_image) : sheet.assembly_image,
        table_image: sheet.table_image ? rewrite(sheet.table_image) : sheet.table_image,
    }));

    const subassemblies = (assembly.subassemblies ?? []).map(sub => rewriteAssembly(sub, rewrite));

    return {
        ...assembly,
        overview_image: assembly.overview_image ? rewrite(assembly.overview_image) : assembly.overview_image,
        sheets,
        ...(subassemblies.length > 0 ? { subassemblies } : {}),
    };
}

function rewriteTocImagePaths(toc: Toc): Toc {
    const cdnBase = config.partsBook.cdnBaseUrl;
    const rewrite = (relPath: string) => `${cdnBase}/${relPath}`;

    const documents = toc.documents.map(doc => {
        const assemblies = doc.assemblies.map(asm => rewriteAssembly(asm, rewrite));
        return {
            ...doc,
            overview_image: doc.overview_image ? rewrite(doc.overview_image) : doc.overview_image,
            assemblies,
        };
    });

    return { ...toc, documents };
}

function findAssemblyBySlug(assemblies: TocAssembly[], slug: string): TocAssembly | null {
    return assemblies.reduce<TocAssembly | null>((found, asm) => {
        if (found) return found;
        if (asm.slug === slug) return asm;
        return findAssemblyBySlug(asm.subassemblies ?? [], slug);
    }, null);
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/parts-book/toc', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const toc = await fetchDataJson<Toc>('toc.json');

        if (!toc) {
            return next(new AppError('Table of contents not available.', 500));
        }

        return res.json(rewriteTocImagePaths(toc));
    } catch (err) {
        return next(err);
    }
});

// GET /v1/api/parts-book/toc/:pdfId — single document
router.get('/parts-book/toc/:pdfId', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { pdfId } = req.params;

        const toc = await fetchDataJson<Toc>('toc.json');
        if (!toc) {
            return next(new AppError('Table of contents not available.', 500));
        }

        const doc = toc.documents.find(d => d.id === pdfId);
        if (!doc) {
            return next(new NotFoundError(`Document '${pdfId}' not found.`));
        }

        const rewritten = rewriteTocImagePaths({ documents: [doc] });
        return res.json(rewritten.documents[0]);
    } catch (err) {
        return next(err);
    }
});

router.get(
    '/parts-book/sheets/:pdfId/:assemblySlug/:sheetSlug/parts',
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            const { pdfId, assemblySlug, sheetSlug } = req.params as Record<string, string>;

            const toc = await fetchDataJson<Toc>('toc.json');
            if (!toc) {
                return next(new AppError('Table of contents not available.', 500));
            }

            const doc = toc.documents.find(d => d.id === pdfId);
            if (!doc) {
                return next(new NotFoundError(`Document '${pdfId}' not found.`));
            }

            const assembly = findAssemblyBySlug(doc.assemblies, assemblySlug);
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
                const tableCoords = p.table_row_box_2d != null ? boxToPercent(p.table_row_box_2d) : null;
                const bc = p.part_no ? (bcLookup[p.part_no] ?? null) : null;

                return {
                    boxId: p.box_id ?? null,
                    calloutNumber: p.callout_number,
                    calloutInstanceIndex: p.callout_instance_index ?? 1,
                    itemNumber: p.item_number ?? null,
                    sheetItem: p.sheet_item,
                    partNo: p.part_no,
                    description: p.description,
                    unitNo: p.unit_no,
                    qty: p.qty,
                    calloutX,
                    calloutY,
                    tableRowX: tableCoords?.calloutX ?? null,
                    tableRowY: tableCoords?.calloutY ?? null,
                    hasTableMatch: p.has_table_match === true,
                    matchingTableRowCount: p.matching_table_row_count ?? null,
                    price: bc ? bc.price : null,
                    inStock: bc ? bc.inStock : false,
                    productId: bc ? bc.productId : null,
                };
            });

            const cdnBase = config.partsBook.cdnBaseUrl;

            return res.json({
                sheet: {
                    id: sheet.id ?? sheet.slug,
                    label: sheet.label,
                    sheetNumber: sheet.sheet_number,
                    diagramUrl: sheet.assembly_image ? `${cdnBase}/${sheet.assembly_image}` : null,
                    tableUrl: sheet.table_image ? `${cdnBase}/${sheet.table_image}` : null,
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

interface B2BMachine {
    modelNo?: string;
    serialNo?: string;
    publicationNos?: string[];
    installDate?: string;
    status?: string;
}

router.get('/customer/:customerId/machines', async (req: Request, res: Response, next: NextFunction) => {
    const customerId = req.params.customerId as string;

    if (!customerId || !/^\d+$/.test(customerId)) {
        return next(new AppError('Invalid customerId.', 400));
    }

    const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '10', 10)));

    try {
        // Step 1 — resolve B2B companyId: get customer email from BC, then look up B2B user by email
        const customerRes = await bcClient.get<{ data: Array<{ email: string }> }>(`/v3/customers`, {
            params: { 'id:in': customerId },
        });
        const email = customerRes.data?.data?.[0]?.email;
        if (!email) {
            return res.json({ machines: [] });
        }

        const usersRes = await b2bClient.get<{ data: Array<{ companyId?: number }> }>(`/api/v3/io/users`, {
            params: { email },
        });
        const b2bUser = usersRes.data?.data?.[0];
        const companyId = b2bUser?.companyId;

        if (!companyId) {
            return res.json({ machines: [] });
        }

        // Step 2 — fetch company extra fields
        const companyRes = await b2bClient.get<{
            data: { extraFields?: Array<{ fieldName: string; fieldValue: string }> };
        }>(`/api/v3/io/companies/${companyId}`);

        const extraFields = companyRes.data?.data?.extraFields ?? [];
        const machinesField = extraFields.find(f => f.fieldName.toLowerCase() === 'machines');

        if (!machinesField) {
            return res.json({ machines: [] });
        }

        let rawMachines: B2BMachine[];
        try {
            const sanitized = machinesField.fieldValue.replace(/,(\s*[}\]])/g, '$1');
            const parsed = JSON.parse(sanitized);
            rawMachines = Array.isArray(parsed) ? parsed : (parsed?.machines ?? []);
        } catch {
            logger.error(`customer ${customerId}: company ${companyId} machines extra field is not valid JSON`);
            return res.json({ machines: [] });
        }

        if (!Array.isArray(rawMachines)) {
            return res.json({ machines: [] });
        }

        const seenSerials = new Set<string>();
        const machines = rawMachines
            .filter(m => m.status !== 'Inactive')
            .filter(m => {
                const serial = m.serialNo ?? '';
                if (!serial || seenSerials.has(serial)) return false;
                seenSerials.add(serial);
                return true;
            })
            .map(m => {
                const pubNos = m.publicationNos ?? [];
                return {
                    serial: m.serialNo ?? null,
                    model: m.modelNo ?? null,
                    installDate: m.installDate || 'pending',
                    status: m.status ?? null,
                    pubNos,
                    hasPartsBook: pubNos.length > 0,
                };
            });

        const total = machines.length;
        const totalPages = Math.ceil(total / limit);
        const paginated = machines.slice((page - 1) * limit, page * limit);

        return res.json({
            count: total,
            pagination: { page, limit, totalPages },
            machines: paginated,
        });
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
    });
});

export default router;
