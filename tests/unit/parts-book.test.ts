import request from 'supertest';
import axios from 'axios';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Jest before any import is resolved
// ---------------------------------------------------------------------------

jest.mock('axios', () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        isAxiosError: jest.fn().mockReturnValue(false),
    },
    get: jest.fn(),
    isAxiosError: jest.fn().mockReturnValue(false),
    create: jest.fn().mockReturnValue({
        get: jest.fn(),
        interceptors: { response: { use: jest.fn() } },
    }),
}));

jest.mock('../../src/services/bigcommerce', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

jest.mock('../../src/services/b2b', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

import app from '../../src/app';
import bcClient from '../../src/services/bigcommerce';
import b2bClient from '../../src/services/b2b';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_TOKEN = 'test-bc-token';
const AUTH = { 'X-Auth-Token': AUTH_TOKEN };
const CDN_BASE = 'https://cdn.test/parts-book';
const DOC_ID = 'LE15-173-R2';
const ASSEMBLY_SLUG = 'bed-group';
const SHEET_SLUG = 'sheet-no-1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DOC = {
    id: DOC_ID,
    label: 'LU300-M',
    category_id: 306,
    overview_image: `${DOC_ID}/overview.png`,
    assemblies: [
        {
            slug: ASSEMBLY_SLUG,
            label: '1 - Bed Group',
            overview_image: `${DOC_ID}/${ASSEMBLY_SLUG}/overview.png`,
            sheets: [
                {
                    id: 'sheet-1',
                    slug: SHEET_SLUG,
                    label: 'Sheet No.1 Bed',
                    sheet_number: 1,
                    assembly_image: `${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/assembly.png`,
                    table_image: `${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/table.png`,
                    parts_json: `${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/parts.json`,
                },
            ],
        },
    ],
};

// callout_box_2d [ymin=200, xmin=400, ymax=300, xmax=600] → calloutX=50, calloutY=25
// table_row_box_2d [ymin=100, xmin=50, ymax=200, xmax=450] → tableRowX=25, tableRowY=15
const MOCK_PARTS_DATA = {
    parts: [
        {
            box_id: 'part_001',
            callout_number: 1,
            callout_instance_index: 1,
            item_number: 1,
            sheet_item: '1-001',
            part_no: '525-0000-01-01',
            description: 'BED',
            unit_no: 'S1000-0525-008A01',
            qty: 1,
            callout_box_2d: [200, 400, 300, 600],
            table_row_box_2d: [100, 50, 200, 450],
            has_table_match: true,
            matching_table_row_count: 1,
        },
        {
            box_id: 'part_002',
            callout_number: 2,
            item_number: 2,
            part_no: '999-NO-MATCH',
            description: 'COVER',
            qty: 2,
            has_table_match: false,
        },
    ],
};

const MOCK_TOC = { documents: [MOCK_DOC] };

const MOCK_BC_PRODUCT = {
    id: 42,
    sku: '525-0000-01-01',
    price: 199.99,
    inventory_tracking: 'product',
    availability: 'available',
};

const MOCK_INVENTORY_ITEM = {
    identity: { sku: '525-0000-01-01', product_id: 42 },
    locations: [
        {
            location_id: 1,
            location_code: 'WH01',
            location_name: 'Okuma US Warehouse',
            available_to_sell: 10,
            location_enabled: true,
        },
    ],
};

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockAxiosGet = axios.get as jest.Mock;
const mockBcGet = bcClient.get as jest.Mock;
const mockB2bGet = b2bClient.get as jest.Mock;

// ---------------------------------------------------------------------------
// Shared helper — sets up the full B2B customer-lookup chain
// ---------------------------------------------------------------------------

function setupMachinesChain(machinesJson: string | null = null): void {
    const defaultMachines = JSON.stringify([
        { modelNo: 'LU300-M', serialNo: 'SN001', publicationNos: ['LE15-173-R2'], installDate: '2023-01-15', status: 'Active' },
        { modelNo: 'LU300-M', serialNo: 'SN002', publicationNos: [], installDate: 'pending', status: 'Active' },
    ]);

    mockBcGet.mockResolvedValueOnce({ data: { data: [{ email: 'user@test.com' }] } });
    mockB2bGet.mockResolvedValueOnce({ data: { data: [{ companyId: 99 }] } });
    mockB2bGet.mockResolvedValueOnce({
        data: {
            data: {
                extraFields: [{ fieldName: 'machines', fieldValue: machinesJson ?? defaultMachines }],
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Parts Book API', () => {
    beforeEach(() => {
        jest.resetAllMocks();
    });

    // -----------------------------------------------------------------------
    // Authentication guard
    // -----------------------------------------------------------------------

    describe('Authentication', () => {
        it('returns 401 when X-Auth-Token header is absent', async () => {
            const res = await request(app).get('/v1/api/parts-book/toc');
            expect(res.status).toBe(401);
        });

        it('returns 401 when X-Auth-Token does not match BC_ACCESS_TOKEN', async () => {
            const res = await request(app)
                .get('/v1/api/parts-book/toc')
                .set('X-Auth-Token', 'wrong-token');
            expect(res.status).toBe(401);
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/api/parts-book/toc
    // -----------------------------------------------------------------------

    describe('GET /v1/api/parts-book/toc', () => {
        it('fetches toc.json and returns documents with rewritten CDN paths', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: MOCK_TOC });

            const res = await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.documents).toHaveLength(1);

            const doc = res.body.documents[0];
            expect(doc.id).toBe(DOC_ID);
            expect(doc.overview_image).toBe(`${CDN_BASE}/${DOC_ID}/overview.png`);

            const asm = doc.assemblies[0];
            expect(asm.overview_image).toBe(`${CDN_BASE}/${DOC_ID}/${ASSEMBLY_SLUG}/overview.png`);

            const sheet = asm.sheets[0];
            expect(sheet.assembly_image).toBe(
                `${CDN_BASE}/${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/assembly.png`
            );
            expect(sheet.table_image).toBe(
                `${CDN_BASE}/${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/table.png`
            );
        });

        it('requests the correct toc.json CDN URL', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: MOCK_TOC });

            await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(mockAxiosGet).toHaveBeenCalledTimes(1);
            expect(mockAxiosGet).toHaveBeenCalledWith(
                `${CDN_BASE}/toc.json`,
                expect.objectContaining({ timeout: 15000 })
            );
        });

        it('returns 500 when toc.json is unavailable', async () => {
            mockAxiosGet.mockRejectedValue(new Error('Network error'));

            const res = await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(res.status).toBe(500);
        });

        it('returns 200 with empty documents list when toc.json has no documents', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [] } });

            const res = await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.documents).toHaveLength(0);
        });

        it('returns 500 when toc.json fails to load', async () => {
            mockAxiosGet.mockRejectedValue(new Error('CDN error'));

            const res = await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(res.status).toBe(500);
        });

        it('returns all documents from toc.json', async () => {
            const MOCK_DOC_2 = { ...MOCK_DOC, id: 'DOC-2', label: 'Other Machine' };
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [MOCK_DOC, MOCK_DOC_2] } });

            const res = await request(app).get('/v1/api/parts-book/toc').set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.documents).toHaveLength(2);
            expect(res.body.documents[0].id).toBe(DOC_ID);
            expect(res.body.documents[1].id).toBe('DOC-2');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/api/parts-book/toc/:pdfId
    // -----------------------------------------------------------------------

    describe('GET /v1/api/parts-book/toc/:pdfId', () => {
        it('fetches toc.json and returns the matching document with rewritten paths', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [MOCK_DOC] } });

            const res = await request(app)
                .get(`/v1/api/parts-book/toc/${DOC_ID}`)
                .set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.id).toBe(DOC_ID);
            expect(res.body.overview_image).toBe(`${CDN_BASE}/${DOC_ID}/overview.png`);
            expect(mockAxiosGet).toHaveBeenCalledWith(
                `${CDN_BASE}/toc.json`,
                expect.objectContaining({ timeout: 15000 })
            );
        });

        it('returns 404 when the document is not present in toc.json', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [] } });

            const res = await request(app)
                .get('/v1/api/parts-book/toc/NONEXISTENT-DOC')
                .set(AUTH);

            expect(res.status).toBe(404);
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/api/parts-book/sheets/:pdfId/:assemblySlug/:sheetSlug/parts
    // -----------------------------------------------------------------------

    describe('GET /v1/api/parts-book/sheets/:pdfId/:assemblySlug/:sheetSlug/parts', () => {
        const PARTS_URL = `/v1/api/parts-book/sheets/${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/parts`;

        it('returns parts with sheet metadata and BC price/stock data', async () => {
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet
                .mockResolvedValueOnce({ data: { data: [MOCK_BC_PRODUCT] } })       // catalog/products
                .mockResolvedValueOnce({ data: { data: [MOCK_INVENTORY_ITEM] } });  // inventory/items

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(200);

            expect(res.body.sheet.label).toBe('Sheet No.1 Bed');
            expect(res.body.sheet.sheetNumber).toBe(1);
            expect(res.body.sheet.diagramUrl).toBe(
                `${CDN_BASE}/${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/assembly.png`
            );
            expect(res.body.sheet.tableUrl).toBe(
                `${CDN_BASE}/${DOC_ID}/${ASSEMBLY_SLUG}/${SHEET_SLUG}/table.png`
            );

            expect(res.body.parts).toHaveLength(2);
            const matched = res.body.parts[0];
            expect(matched.partNo).toBe('525-0000-01-01');
            expect(matched.price).toBe(199.99);
            expect(matched.inStock).toBe(true);
            expect(matched.productId).toBe(42);
        });

        it('converts callout_box_2d [ymin,xmin,ymax,xmax] to percentage centre coords', async () => {
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet.mockResolvedValue({ data: { data: [] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            // [200, 400, 300, 600]: cx=(400+600)/2/10=50, cy=(200+300)/2/10=25
            expect(res.body.parts[0].calloutX).toBe(50);
            expect(res.body.parts[0].calloutY).toBe(25);
        });

        it('converts table_row_box_2d to percentage centre coords', async () => {
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet.mockResolvedValue({ data: { data: [] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            // [100, 50, 200, 450]: cx=(50+450)/2/10=25, cy=(100+200)/2/10=15
            expect(res.body.parts[0].tableRowX).toBe(25);
            expect(res.body.parts[0].tableRowY).toBe(15);
        });

        it('returns null callout coords when callout_box_2d is absent', async () => {
            const partsNoCoords = { parts: [{ box_id: 'p1', part_no: 'SKU-1', has_table_match: false }] };
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: partsNoCoords });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.parts[0].calloutX).toBeNull();
            expect(res.body.parts[0].calloutY).toBeNull();
        });

        it('skips BC product lookup when no parts have has_table_match=true', async () => {
            const noMatch = { parts: [{ box_id: 'p1', part_no: 'SKU-1', has_table_match: false }] };
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: noMatch });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(mockBcGet).not.toHaveBeenCalled();
        });

        it('returns parts with null price when BC lookup throws', async () => {
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet.mockRejectedValue(new Error('BC unavailable'));

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.parts[0].price).toBeNull();
            expect(res.body.parts[0].inStock).toBe(false);
            expect(res.body.parts[0].productId).toBeNull();
        });

        it('marks part as in-stock when inventory_tracking is "none" regardless of per-location inventory', async () => {
            const untrackedProduct = { ...MOCK_BC_PRODUCT, inventory_tracking: 'none' };
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet
                .mockResolvedValueOnce({ data: { data: [untrackedProduct] } })  // catalog/products
                .mockResolvedValueOnce({ data: { data: [] } });                 // inventory/items — empty; tracking=none so still in stock

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.body.parts[0].inStock).toBe(true);
        });

        it('marks part as out-of-stock when availability is not "available"', async () => {
            const disabledProduct = { ...MOCK_BC_PRODUCT, availability: 'disabled' };
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet
                .mockResolvedValueOnce({ data: { data: [disabledProduct] } })  // catalog/products
                .mockResolvedValueOnce({ data: { data: [] } });                // inventory/items

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.body.parts[0].inStock).toBe(false);
        });

        it('marks part as out-of-stock when tracked and no location has available stock', async () => {
            const noStockItem = {
                identity: { sku: '525-0000-01-01', product_id: 42 },
                locations: [
                    {
                        location_id: 1,
                        location_code: 'WH01',
                        location_name: 'Okuma US Warehouse',
                        available_to_sell: 0,
                        location_enabled: true,
                    },
                ],
            };
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet
                .mockResolvedValueOnce({ data: { data: [MOCK_BC_PRODUCT] } })  // catalog/products — availability: available, tracking: product
                .mockResolvedValueOnce({ data: { data: [noStockItem] } });     // inventory/items — all locations at 0

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.body.parts[0].inStock).toBe(false);
        });

        it('returns 404 when document is not found in toc.json', async () => {
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(404);
        });

        it('returns 404 when assembly slug does not exist in the document', async () => {
            const docNoAsm = { ...MOCK_DOC, assemblies: [] };
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [docNoAsm] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(404);
        });

        it('returns 404 when sheet slug does not exist in the assembly', async () => {
            const docNoSheet = {
                ...MOCK_DOC,
                assemblies: [{ ...MOCK_DOC.assemblies[0], sheets: [] }],
            };
            mockAxiosGet.mockResolvedValueOnce({ data: { documents: [docNoSheet] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(404);
        });

        it('returns 500 when parts.json is unavailable', async () => {
            mockAxiosGet
                .mockResolvedValueOnce({ data: MOCK_TOC })
                .mockRejectedValue(new Error('CDN error'));

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(500);
        });

        it('resolves assembly by slug recursively through subassemblies', async () => {
            const docWithSub = {
                ...MOCK_DOC,
                assemblies: [
                    {
                        slug: 'parent-group',
                        label: 'Parent',
                        sheets: [],
                        subassemblies: [
                            {
                                slug: ASSEMBLY_SLUG,
                                label: '1 - Bed Group',
                                sheets: MOCK_DOC.assemblies[0].sheets,
                            },
                        ],
                    },
                ],
            };
            mockAxiosGet
                .mockResolvedValueOnce({ data: { documents: [docWithSub] } })
                .mockResolvedValueOnce({ data: MOCK_PARTS_DATA });
            mockBcGet.mockResolvedValue({ data: { data: [] } });

            const res = await request(app).get(PARTS_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.sheet.label).toBe('Sheet No.1 Bed');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/api/customer/:customerId/machines
    // -----------------------------------------------------------------------

    describe('GET /v1/api/customer/:customerId/machines', () => {
        const CUSTOMER_ID = '12345';
        const MACHINES_URL = `/v1/api/customer/${CUSTOMER_ID}/machines`;

        it('returns 400 for a non-numeric customerId', async () => {
            const res = await request(app).get('/v1/api/customer/abc/machines').set(AUTH);
            expect(res.status).toBe(400);
        });

        it('returns empty machines when customer is not found in BC', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [] } });

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.machines).toEqual([]);
        });

        it('returns empty machines when B2B user is not found', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [{ email: 'user@test.com' }] } });
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } });

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.machines).toEqual([]);
        });

        it('returns empty machines when B2B user has no companyId', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [{ email: 'user@test.com' }] } });
            mockB2bGet.mockResolvedValueOnce({ data: { data: [{}] } });

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.machines).toEqual([]);
        });

        it('returns empty machines when machines extra field is absent from company', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [{ email: 'user@test.com' }] } });
            mockB2bGet
                .mockResolvedValueOnce({ data: { data: [{ companyId: 99 }] } })
                .mockResolvedValueOnce({ data: { data: { extraFields: [] } } });

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.machines).toEqual([]);
        });

        it('returns empty machines when machines field contains invalid JSON', async () => {
            setupMachinesChain('not valid json {{{{');

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.machines).toEqual([]);
        });

        it('returns paginated machine list with count and pagination metadata', async () => {
            setupMachinesChain();

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.count).toBe(2);
            expect(res.body.pagination.page).toBe(1);
            expect(res.body.pagination.limit).toBe(10);
            expect(res.body.pagination.totalPages).toBe(1);

            const machine = res.body.machines[0];
            expect(machine.serial).toBe('SN001');
            expect(machine.model).toBe('LU300-M');
            expect(machine.installDate).toBe('2023-01-15');
            expect(machine.pubNos).toEqual(['LE15-173-R2']);
            expect(machine.hasPartsBook).toBe(true);
        });

        it('sets hasPartsBook to false when publicationNos is empty', async () => {
            setupMachinesChain();

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.body.machines[1].hasPartsBook).toBe(false);
        });

        it('excludes machines with status "Inactive"', async () => {
            const machines = JSON.stringify([
                { modelNo: 'LU300-M', serialNo: 'SN001', publicationNos: [], status: 'Active' },
                { modelNo: 'LU300-M', serialNo: 'SN002', publicationNos: [], status: 'Inactive' },
            ]);
            setupMachinesChain(machines);

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.body.machines).toHaveLength(1);
            expect(res.body.machines[0].serial).toBe('SN001');
        });

        it('deduplicates machines with the same serialNo, keeping the first occurrence', async () => {
            const machines = JSON.stringify([
                { modelNo: 'LU300-M', serialNo: 'SN001', publicationNos: ['PUB-1'], status: 'Active' },
                { modelNo: 'LU300-M', serialNo: 'SN001', publicationNos: ['PUB-2'], status: 'Active' },
            ]);
            setupMachinesChain(machines);

            const res = await request(app).get(MACHINES_URL).set(AUTH);

            expect(res.body.machines).toHaveLength(1);
            expect(res.body.machines[0].pubNos).toEqual(['PUB-1']);
        });

        it('respects page and limit query parameters', async () => {
            const machines = JSON.stringify(
                Array.from({ length: 5 }, (_, i) => ({
                    modelNo: 'LU300-M',
                    serialNo: `SN00${i + 1}`,
                    publicationNos: [],
                    status: 'Active',
                }))
            );
            setupMachinesChain(machines);

            const res = await request(app)
                .get(`${MACHINES_URL}?page=2&limit=2`)
                .set(AUTH);

            expect(res.body.count).toBe(5);
            expect(res.body.pagination.page).toBe(2);
            expect(res.body.pagination.limit).toBe(2);
            expect(res.body.pagination.totalPages).toBe(3);
            expect(res.body.machines).toHaveLength(2);
            expect(res.body.machines[0].serial).toBe('SN003');
        });

        it('clamps limit to a maximum of 100', async () => {
            setupMachinesChain();

            const res = await request(app)
                .get(`${MACHINES_URL}?limit=999`)
                .set(AUTH);

            expect(res.body.pagination.limit).toBe(100);
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/api/parts-book/machine/verify
    // -----------------------------------------------------------------------

    describe('GET /v1/api/parts-book/machine/verify', () => {
        it('returns 400 when serialNo query parameter is absent', async () => {
            const res = await request(app)
                .get('/v1/api/parts-book/machine/verify')
                .set(AUTH);

            expect(res.status).toBe(400);
        });

        it('returns verified:true with the provided serialNo', async () => {
            const res = await request(app)
                .get('/v1/api/parts-book/machine/verify?serialNo=SN001')
                .set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.verified).toBe(true);
            expect(res.body.serialNo).toBe('SN001');
            expect(res.body.model).toBeDefined();
        });
    });
});
