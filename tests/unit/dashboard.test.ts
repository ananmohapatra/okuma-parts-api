import request from 'supertest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Jest before any import is resolved
// ---------------------------------------------------------------------------

jest.mock('axios', () => ({
    __esModule: true,
    default: { isAxiosError: jest.fn().mockReturnValue(false) },
    isAxiosError: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/services/bigcommerce', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../src/services/b2b', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));

import axios from 'axios';
import app from '../../src/app';
import bcClient from '../../src/services/bigcommerce';
import b2bClient from '../../src/services/b2b';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH = { 'X-Auth-Token': 'test-bc-token' };
const ORDERS_URL = '/v1/dashboard/orders';
const RECENT_ORDERS_URL = '/v1/dashboard/recent-orders';
const ORDER_DETAIL_URL = (id: number | string): string => `${ORDERS_URL}/${id}`;

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockBcGet = bcClient.get as jest.Mock;
const mockBcPost = bcClient.post as jest.Mock;
const mockB2bGet = b2bClient.get as jest.Mock;

(b2bClient.post as jest.Mock).mockResolvedValue({ data: {} });
(b2bClient.put as jest.Mock).mockResolvedValue({ data: {} });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dealerRecord(id: number, email: string) {
    return { data: { data: [{ id, email, first_name: 'Test', last_name: 'Dealer' }] } };
}

function b2bUserByEmail(companyId: number) {
    return { data: { data: [{ companyId }] } };
}

function b2bCompanyById(companyName: string) {
    return { data: { data: { companyName } } };
}

function b2bCompanyList(companies: Array<{ companyId: number; companyName: string; bcGroupName: string }>) {
    return {
        data: {
            data: companies.map(c => ({
                companyId: c.companyId,
                companyName: c.companyName,
                companyEmail: '',
                bcGroupName: c.bcGroupName,
                parentCompany: { id: null, name: '' },
            })),
        },
    };
}

function b2bCompanyUsers(users: Array<{ customerId: number; email: string; companyRoleName?: string }>) {
    return { data: { data: users.map(u => ({ id: u.customerId, ...u, companyId: 0 })) } };
}

function b2bAddresses(addresses: Array<{ isDefaultBilling: boolean }>) {
    return {
        data: {
            data: addresses.map(a => ({
                firstName: 'Jane',
                lastName: 'Doe',
                addressLine1: '123 Main St',
                addressLine2: '',
                city: 'Austin',
                stateName: 'Texas',
                countryName: 'United States',
                countryCode: 'US',
                zipCode: '78701',
                isDefaultBilling: a.isDefaultBilling,
            })),
        },
    };
}

function createdOrder(id: number, statusId = 1) {
    return {
        data: {
            id,
            date_created: '2026-01-01T00:00:00Z',
            status_id: statusId,
            status: 'Pending',
            items_total: 1,
            total_inc_tax: '10.0000',
            currency_code: 'USD',
        },
    };
}

/**
 * Wires up the B2B GET dispatcher (email lookup, company lookup, subsidiary
 * list, company users, addresses) that both POST /orders and GET /recent-orders
 * rely on via resolveDealerHierarchy. URL-dispatched rather than order-dependent
 * since both routes make many distinct B2B calls.
 */
function setupHierarchy(opts: {
    dealerCompanyId: number;
    dealerCompanyName: string;
    subsidiaries?: Array<{ companyId: number; companyName: string }>;
    companyUsersByCompanyId?: Record<number, Array<{ customerId: number; email: string; companyRoleName?: string }>>;
    addressesByCompanyId?: Record<number, Array<{ isDefaultBilling: boolean }>>;
}): void {
    const subsidiaries = opts.subsidiaries ?? [];

    mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
        const params = config?.params ?? {};

        if (url === '/api/v3/io/users' && params.email) {
            return Promise.resolve(b2bUserByEmail(opts.dealerCompanyId));
        }
        if (url === '/api/v3/io/users' && params.companyId) {
            const users = opts.companyUsersByCompanyId?.[params.companyId as number] ?? [];
            return Promise.resolve(b2bCompanyUsers(users));
        }
        if (url === `/api/v3/io/companies/${opts.dealerCompanyId}`) {
            return Promise.resolve(b2bCompanyById(opts.dealerCompanyName));
        }
        if (url === '/api/v3/io/companies') {
            return Promise.resolve(
                b2bCompanyList(subsidiaries.map(s => ({ ...s, bcGroupName: opts.dealerCompanyName })))
            );
        }
        if (url === '/api/v3/io/addresses') {
            const addresses = opts.addressesByCompanyId?.[params.companyId as number] ?? [];
            return Promise.resolve(b2bAddresses(addresses));
        }
        if (url.startsWith('/api/v3/io/orders/')) {
            return Promise.resolve({ data: { data: { extraFields: [] } } });
        }
        return Promise.reject(new Error(`Unhandled b2bClient.get ${url}`));
    });
}

/**
 * Minimal BC order fixture for GET /orders scenarios — mirrors the shape
 * returned by GET /v2/orders?customer_id=...
 */
function orderFixture(
    id: number,
    customerId: number,
    dateCreated: string,
    statusId: number,
    status: string,
    overrides: Partial<{ items_total: number; total_inc_tax: string; currency_code: string; is_deleted: boolean }> = {}
) {
    return {
        id,
        customer_id: customerId,
        date_created: dateCreated,
        status_id: statusId,
        status,
        items_total: overrides.items_total ?? 1,
        total_inc_tax: overrides.total_inc_tax ?? '10.0000',
        currency_code: overrides.currency_code ?? 'USD',
        is_deleted: overrides.is_deleted ?? false,
    };
}

/** B2B order-record extraFields response for a single GET /api/v3/io/orders/{id}. */
function b2bOrderExtraFields(fields: Record<string, string>) {
    return {
        data: {
            data: {
                extraFields: Object.entries(fields).map(([fieldName, fieldValue]) => ({ fieldName, fieldValue })),
            },
        },
    };
}

/**
 * Shared "big" scenario for GET /orders — one dealer (500 / "Dealer Co 500")
 * with one subsidiary ("Client Co 500", user customerId 850) and 5 candidate
 * orders: 4 placed by the dealer (attributed createdBy === dealer company
 * name — 2 for himself, 2 for the subsidiary) plus 1 self-service order under
 * the subsidiary's own customer with no B2B attribution at all, which must be
 * excluded from every /orders response. Re-invoked per test so bcClient's
 * order-list mock (never cached) is always fresh; the B2B hierarchy/company-
 * users/order-attribution caches are safe to reuse across tests since the
 * underlying fixture data never changes for dealerId 500.
 */
function setupBigOrdersScenario(): void {
    const dealerId = 500;
    const dealerCompanyId = 1500;
    const dealerCompanyName = 'Dealer Co 500';
    const subCompanyId = 2500;
    const subCompanyName = 'Client Co 500';

    mockBcGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
        if (url === '/v3/customers' && config?.params?.['id:in'] === dealerId) {
            return Promise.resolve(dealerRecord(dealerId, 'dealer500@test.com'));
        }
        if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=500')) {
            return Promise.resolve({
                data: [
                    orderFixture(9001, 500, '2026-01-01T00:00:00Z', 1, 'Pending'),
                    orderFixture(9002, 500, '2026-01-05T00:00:00Z', 2, 'Shipped'),
                ],
            });
        }
        if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=850')) {
            return Promise.resolve({
                data: [
                    orderFixture(9003, 850, '2026-01-03T00:00:00Z', 2, 'Shipped'),
                    orderFixture(9004, 850, '2026-01-10T00:00:00Z', 10, 'Completed'),
                    orderFixture(9005, 850, '2026-01-02T00:00:00Z', 1, 'Pending'), // self-service — no B2B record
                ],
            });
        }
        return Promise.resolve({ data: { data: [] } });
    });

    mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
        const params = config?.params ?? {};
        if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(dealerCompanyId));
        if (url === '/api/v3/io/users' && params.companyId === subCompanyId) {
            return Promise.resolve(b2bCompanyUsers([{ customerId: 850, email: 'buyer850@client500.com' }]));
        }
        // Co-admin visibility fix fans out over the dealer's own company too, not just
        // subsidiaries — no co-admin scenario here, so this dealer has none.
        if (url === '/api/v3/io/users' && params.companyId === dealerCompanyId) {
            return Promise.resolve(b2bCompanyUsers([]));
        }
        if (url === `/api/v3/io/companies/${dealerCompanyId}`) return Promise.resolve(b2bCompanyById(dealerCompanyName));
        if (url === '/api/v3/io/companies') {
            return Promise.resolve(
                b2bCompanyList([{ companyId: subCompanyId, companyName: subCompanyName, bcGroupName: dealerCompanyName }])
            );
        }
        if (url === '/api/v3/io/orders/9001') {
            return Promise.resolve(b2bOrderExtraFields({ orderedFor: 'Self', createdBy: dealerCompanyName }));
        }
        if (url === '/api/v3/io/orders/9002') {
            return Promise.resolve(b2bOrderExtraFields({ orderedFor: 'Self', createdBy: dealerCompanyName }));
        }
        if (url === '/api/v3/io/orders/9003') {
            return Promise.resolve(b2bOrderExtraFields({ orderedFor: subCompanyName, createdBy: dealerCompanyName }));
        }
        if (url === '/api/v3/io/orders/9004') {
            return Promise.resolve(b2bOrderExtraFields({ orderedFor: subCompanyName, createdBy: dealerCompanyName }));
        }
        if (url === '/api/v3/io/orders/9005') {
            return Promise.resolve(b2bOrderExtraFields({})); // never placed via POST /orders — no attribution
        }
        return Promise.reject(new Error(`Unhandled b2bClient.get ${url}`));
    });
}

/**
 * Core order fixture for GET /orders/:orderId — mirrors GET /v2/orders/{id}
 * (BcOrderDetail — richer than the list-shape `orderFixture` above, since the
 * detail route needs subtotal/shipping/tax breakdown fields the list route doesn't).
 */
function orderDetailFixture(
    id: number,
    customerId: number,
    overrides: Partial<{
        status_id: number;
        status: string;
        date_created: string;
        subtotal_ex_tax: number;
        shipping_cost_ex_tax: number;
        total_tax: number;
        total_inc_tax: number;
        currency_code: string;
        payment_method: string;
    }> = {}
) {
    return {
        data: {
            id,
            customer_id: customerId,
            date_created: overrides.date_created ?? '2026-01-01T00:00:00Z',
            status_id: overrides.status_id ?? 1,
            status: overrides.status ?? 'Pending',
            // ex-tax, not inc-tax -- costBreakdown is additive (subtotal + shipping +
            // tax === total), matching the fixture's default 190 + 15 + 10 === 225
            subtotal_ex_tax: overrides.subtotal_ex_tax ?? 190,
            shipping_cost_ex_tax: overrides.shipping_cost_ex_tax ?? 15,
            total_tax: overrides.total_tax ?? 10,
            total_inc_tax: overrides.total_inc_tax ?? 225,
            currency_code: overrides.currency_code ?? 'USD',
            payment_method: overrides.payment_method ?? 'Manual',
        },
    };
}

/** GET /v2/orders/{id}/products line-item fixture. */
function productFixture(
    overrides: Partial<{
        product_id: number;
        sku: string;
        name: string;
        quantity: number;
        price_inc_tax: number;
        total_inc_tax: number;
    }> = {}
) {
    return {
        product_id: overrides.product_id ?? 1,
        sku: overrides.sku ?? 'SKU-A',
        name: overrides.name ?? 'Widget A',
        quantity: overrides.quantity ?? 2,
        price_inc_tax: overrides.price_inc_tax ?? 50,
        total_inc_tax: overrides.total_inc_tax ?? 100,
    };
}

/** GET /v2/orders/{id}/shipping_addresses fixture. */
function shippingAddressFixture(
    overrides: Partial<{
        first_name: string;
        last_name: string;
        street_1: string;
        street_2: string;
        city: string;
        state: string;
        zip: string;
        country: string;
        shipping_method: string;
    }> = {}
) {
    return {
        first_name: overrides.first_name ?? 'Jane',
        last_name: overrides.last_name ?? 'Doe',
        street_1: overrides.street_1 ?? '123 Main St',
        street_2: overrides.street_2 ?? '',
        city: overrides.city ?? 'Austin',
        state: overrides.state ?? 'Texas',
        zip: overrides.zip ?? '78701',
        country: overrides.country ?? 'United States',
        ...(overrides.shipping_method ? { shipping_method: overrides.shipping_method } : {}),
    };
}

/** GET /v2/orders/{id}/shipments fixture. */
function shipmentFixture(
    overrides: Partial<{
        tracking_number: string;
        tracking_carrier: string;
        date_created: string;
        shipping_method: string;
    }> = {}
) {
    return {
        tracking_number: overrides.tracking_number ?? '1Z999AA10123456784',
        tracking_carrier: overrides.tracking_carrier ?? 'UPS',
        date_created: overrides.date_created ?? '2026-01-05T00:00:00Z',
        shipping_method: overrides.shipping_method ?? 'Ground',
    };
}

/**
 * Wires up the bcClient GET dispatcher for GET /orders/:orderId — the core
 * order, the dealer record, and the three concurrent sub-resource calls
 * (products/shipping_addresses/shipments). Pass 'reject' for any sub-resource
 * to simulate that individual call failing (per-branch `.catch(() => [])`
 * resilience) without failing the other two.
 */
function setupOrderDetailBc(opts: {
    orderId: number;
    order: ReturnType<typeof orderDetailFixture>;
    dealerId: number;
    dealerEmail: string;
    products?: Array<ReturnType<typeof productFixture>> | 'reject';
    shippingAddresses?: Array<ReturnType<typeof shippingAddressFixture>> | 'reject';
    shipments?: Array<ReturnType<typeof shipmentFixture>> | 'reject';
}): void {
    mockBcGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
        if (url === `/v2/orders/${opts.orderId}`) return Promise.resolve(opts.order);
        if (url === '/v3/customers' && config?.params?.['id:in'] === opts.dealerId) {
            return Promise.resolve(dealerRecord(opts.dealerId, opts.dealerEmail));
        }
        if (url === `/v2/orders/${opts.orderId}/products`) {
            return opts.products === 'reject'
                ? Promise.reject(new Error('BC unavailable'))
                : Promise.resolve({ data: opts.products ?? [] });
        }
        if (url === `/v2/orders/${opts.orderId}/shipping_addresses`) {
            return opts.shippingAddresses === 'reject'
                ? Promise.reject(new Error('BC unavailable'))
                : Promise.resolve({ data: opts.shippingAddresses ?? [] });
        }
        if (url === `/v2/orders/${opts.orderId}/shipments`) {
            return opts.shipments === 'reject'
                ? Promise.reject(new Error('BC unavailable'))
                : Promise.resolve({ data: opts.shipments ?? [] });
        }
        return Promise.reject(new Error(`Unhandled bcClient.get ${url}`));
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard orders API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (b2bClient.post as jest.Mock).mockResolvedValue({ data: {} });
        (b2bClient.put as jest.Mock).mockResolvedValue({ data: {} });
    });

    // -----------------------------------------------------------------------
    // POST /v1/dashboard/orders — validation
    // -----------------------------------------------------------------------

    describe('POST /v1/dashboard/orders — validation', () => {
        it('returns 400 when customerId is missing', async () => {
            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ companyId: 1, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/customerId/);
        });

        it('returns 400 when companyId is missing', async () => {
            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 1, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/companyId/);
        });

        it('returns 400 when lineItems is empty', async () => {
            const res = await request(app).post(ORDERS_URL).set(AUTH).send({ customerId: 1, companyId: 1, lineItems: [] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/lineItems/);
        });

        it('returns 400 when status is not one of the allowed labels', async () => {
            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 1, companyId: 1, lineItems: [{ productId: 1, quantity: 1 }], status: 'Bogus' });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/status must be one of/);
        });

        it('returns 400 when status is an inherited Object.prototype property name', async () => {
            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 1, companyId: 1, lineItems: [{ productId: 1, quantity: 1 }], status: 'constructor' });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/status must be one of/);
        });

        it('returns 404 when the dealer customer does not exist', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [] } });

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 101, companyId: 101, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(404);
        });

        it('returns 404 when the dealer has no associated B2B company', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(102, 'nodealer@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } }); // no B2B user found

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 102, companyId: 102, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(404);
        });

        it("returns 403 when companyId is not the dealer's own company or a subsidiary", async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(103, 'dealer103@test.com'));
            setupHierarchy({ dealerCompanyId: 1103, dealerCompanyName: 'Dealer Co 103', subsidiaries: [] });

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 103, companyId: 9999, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(403);
        });

        it('returns 400 when no Admin user is found for the target company', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(104, 'dealer104@test.com'));
            setupHierarchy({
                dealerCompanyId: 1104,
                dealerCompanyName: 'Dealer Co 104',
                subsidiaries: [{ companyId: 2104, companyName: 'Client Co 104' }],
                companyUsersByCompanyId: { 2104: [{ customerId: 501, email: 'buyer@client.com', companyRoleName: 'Senior Buyer' }] },
            });

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 104, companyId: 2104, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/No admin user found/);
        });

        it('returns 400 when the resolved admin has an invalid customerId', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(105, 'dealer105@test.com'));
            setupHierarchy({
                dealerCompanyId: 1105,
                dealerCompanyName: 'Dealer Co 105',
                subsidiaries: [{ companyId: 2105, companyName: 'Client Co 105' }],
                companyUsersByCompanyId: { 2105: [{ customerId: 0, email: 'admin@client.com', companyRoleName: 'Admin' }] },
            });

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 105, companyId: 2105, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/missing a valid customerId\/email/);
        });

        it('returns 400 when the target company has no default billing address', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(106, 'dealer106@test.com'));
            setupHierarchy({
                dealerCompanyId: 1106,
                dealerCompanyName: 'Dealer Co 106',
                subsidiaries: [{ companyId: 2106, companyName: 'Client Co 106' }],
                companyUsersByCompanyId: { 2106: [{ customerId: 601, email: 'admin@client.com', companyRoleName: 'Admin' }] },
                addressesByCompanyId: { 2106: [] },
            });

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 106, companyId: 2106, lineItems: [{ productId: 1, quantity: 1 }] });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/has no billing address on file/);
        });
    });

    // -----------------------------------------------------------------------
    // POST /v1/dashboard/orders — happy paths
    // -----------------------------------------------------------------------

    describe('POST /v1/dashboard/orders — happy paths', () => {
        it('places an order for the dealer themself and tags it orderedFor: Self', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(200, 'dealer200@test.com'));
            setupHierarchy({
                dealerCompanyId: 1200,
                dealerCompanyName: 'Dealer Co 200',
                subsidiaries: [],
                addressesByCompanyId: { 1200: [{ isDefaultBilling: true }] },
            });
            mockBcPost.mockResolvedValueOnce(createdOrder(9200));

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 200, companyId: 1200, lineItems: [{ productId: 1, quantity: 2 }] });

            expect(res.status).toBe(201);
            expect(res.body.orderId).toBe(9200);
            expect(res.body.orderedFor).toBe('Self');
            expect(res.body.createdBy).toBe('Dealer Co 200');

            expect(mockBcPost).toHaveBeenCalledWith(
                '/v2/orders',
                expect.objectContaining({
                    customer_id: 200,
                    status_id: 1, // default "Pending"
                    products: [{ product_id: 1, quantity: 2 }],
                })
            );
        });

        it('places an order for a subsidiary company under its Admin user', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(201, 'dealer201@test.com'));
            setupHierarchy({
                dealerCompanyId: 1201,
                dealerCompanyName: 'Dealer Co 201',
                subsidiaries: [{ companyId: 2201, companyName: 'Client Co 201' }],
                companyUsersByCompanyId: {
                    2201: [{ customerId: 701, email: 'admin@client201.com', companyRoleName: 'Admin' }],
                },
                addressesByCompanyId: { 2201: [{ isDefaultBilling: true }] },
            });
            mockBcPost.mockResolvedValueOnce(createdOrder(9201));

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({ customerId: 201, companyId: 2201, lineItems: [{ productId: 5, quantity: 1 }] });

            expect(res.status).toBe(201);
            expect(res.body.orderedFor).toBe('Client Co 201');
            expect(res.body.createdBy).toBe('Dealer Co 201');

            expect(mockBcPost).toHaveBeenCalledWith(
                '/v2/orders',
                expect.objectContaining({ customer_id: 701 }) // the Admin's customerId, not the dealer's
            );
        });

        it('maps an explicit status label to the correct BC status_id', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(202, 'dealer202@test.com'));
            setupHierarchy({
                dealerCompanyId: 1202,
                dealerCompanyName: 'Dealer Co 202',
                subsidiaries: [],
                addressesByCompanyId: { 1202: [{ isDefaultBilling: true }] },
            });
            mockBcPost.mockResolvedValueOnce(createdOrder(9202, 11));

            const res = await request(app)
                .post(ORDERS_URL)
                .set(AUTH)
                .send({
                    customerId: 202,
                    companyId: 1202,
                    lineItems: [{ productId: 1, quantity: 1 }],
                    status: 'Awaiting Fulfillment',
                });

            expect(res.status).toBe(201);
            expect(mockBcPost).toHaveBeenCalledWith('/v2/orders', expect.objectContaining({ status_id: 11 }));
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/recent-orders
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/recent-orders', () => {
        it('returns 400 when customerId is missing', async () => {
            const res = await request(app).get(RECENT_ORDERS_URL).set(AUTH);
            expect(res.status).toBe(400);
        });

        it('returns 404 when the dealer customer does not exist', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [] } });

            const res = await request(app).get(`${RECENT_ORDERS_URL}?customerId=301`).set(AUTH);

            expect(res.status).toBe(404);
        });

        it('returns an empty result when the dealer has no B2B company', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(302, 'dealer302@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } }); // no B2B user found

            const res = await request(app).get(`${RECENT_ORDERS_URL}?customerId=302`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ summary: { totalOrderCount: 0, openOrderCount: 0 }, data: [] });
        });

        it("excludes an order whose createdBy does not match the dealer's company (self-service order)", async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(303, 'dealer303@test.com'));
            setupHierarchy({
                dealerCompanyId: 1303,
                dealerCompanyName: 'Dealer Co 303',
                subsidiaries: [{ companyId: 2303, companyName: 'Client Co 303' }],
                companyUsersByCompanyId: {
                    2303: [{ customerId: 801, email: 'buyer@client303.com', companyRoleName: 'Admin' }],
                },
            });

            mockBcGet.mockImplementation((url: string) => {
                if (url.startsWith('/v2/orders?customer_id=303')) {
                    return Promise.resolve({ data: [] });
                }
                if (url.startsWith('/v2/orders?customer_id=801')) {
                    return Promise.resolve({
                        data: [
                            {
                                id: 5001,
                                customer_id: 801,
                                date_created: '2026-01-02T00:00:00Z',
                                status_id: 1,
                                status: 'Pending',
                                items_total: 1,
                                total_inc_tax: '20.0000',
                                currency_code: 'USD',
                                is_deleted: false,
                            },
                        ],
                    });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            // Order 5001 exists but was never placed via POST /orders — no B2B record for it
            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                const params = config?.params ?? {};
                if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(1303));
                if (url === '/api/v3/io/users' && params.companyId === 2303) {
                    return Promise.resolve(b2bCompanyUsers([{ customerId: 801, email: 'buyer@client303.com' }]));
                }
                if (url === '/api/v3/io/companies/1303') return Promise.resolve(b2bCompanyById('Dealer Co 303'));
                if (url === '/api/v3/io/companies') {
                    return Promise.resolve(
                        b2bCompanyList([{ companyId: 2303, companyName: 'Client Co 303', bcGroupName: 'Dealer Co 303' }])
                    );
                }
                if (url === '/api/v3/io/orders/5001') {
                    // No createdBy/orderedFor — this order was never placed via POST /orders
                    return Promise.resolve({ data: { data: { extraFields: [] } } });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            const res = await request(app).get(`${RECENT_ORDERS_URL}?customerId=303`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.summary.totalOrderCount).toBe(0);
            expect(res.body.data).toEqual([]);
        });

        it("includes an order whose createdBy matches the dealer's company, with correct summary counts", async () => {
            mockBcGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                if (url === '/v3/customers' && config?.params?.['id:in'] === 304) {
                    return Promise.resolve(dealerRecord(304, 'dealer304@test.com'));
                }
                if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=304')) {
                    return Promise.resolve({
                        data: [
                            {
                                id: 6001,
                                customer_id: 304,
                                date_created: '2026-01-03T00:00:00Z',
                                status_id: 1,
                                status: 'Pending',
                                items_total: 1,
                                total_inc_tax: '15.0000',
                                currency_code: 'USD',
                                is_deleted: false,
                            },
                            {
                                id: 6002,
                                customer_id: 304,
                                date_created: '2026-01-04T00:00:00Z',
                                status_id: 12,
                                status: 'Manual Verification Required',
                                items_total: 1,
                                total_inc_tax: '25.0000',
                                currency_code: 'USD',
                                is_deleted: false,
                            },
                        ],
                    });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                const params = config?.params ?? {};
                if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(1304));
                if (url === '/api/v3/io/companies/1304') return Promise.resolve(b2bCompanyById('Dealer Co 304'));
                if (url === '/api/v3/io/companies') return Promise.resolve(b2bCompanyList([]));
                if (url === '/api/v3/io/orders/6001') {
                    return Promise.resolve({
                        data: { data: { extraFields: [{ fieldName: 'orderedFor', fieldValue: 'Self' }, { fieldName: 'createdBy', fieldValue: 'Dealer Co 304' }] } },
                    });
                }
                if (url === '/api/v3/io/orders/6002') {
                    return Promise.resolve({
                        data: { data: { extraFields: [{ fieldName: 'orderedFor', fieldValue: 'Self' }, { fieldName: 'createdBy', fieldValue: 'Dealer Co 304' }] } },
                    });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            const res = await request(app).get(`${RECENT_ORDERS_URL}?customerId=304&limit=10`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.summary.totalOrderCount).toBe(2);
            expect(res.body.summary.openOrderCount).toBe(1); // only status_id 1 counts as "open"
            expect(res.body.data).toHaveLength(2);
            expect(res.body.data[0].orderedFor).toBe('Self');
            expect(res.body.data[0].createdBy).toBe('Dealer Co 304');
        });

        it("includes a self-order placed by a co-admin of the dealer's own company, not just the querying user", async () => {
            // Two Admins share the same dealer company: customer 305 is querying, customer
            // 999 is a co-admin who placed a self-order. Both must resolve as candidates.
            mockBcGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                if (url === '/v3/customers' && config?.params?.['id:in'] === 305) {
                    return Promise.resolve(dealerRecord(305, 'dealer305@test.com'));
                }
                if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=305')) {
                    return Promise.resolve({ data: [] });
                }
                if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=999')) {
                    return Promise.resolve({
                        data: [
                            {
                                id: 7002,
                                customer_id: 999,
                                date_created: '2026-01-05T00:00:00Z',
                                status_id: 1,
                                status: 'Pending',
                                items_total: 1,
                                total_inc_tax: '25.0000',
                                currency_code: 'USD',
                                is_deleted: false,
                            },
                        ],
                    });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            setupHierarchy({
                dealerCompanyId: 1305,
                dealerCompanyName: 'Dealer Co 305',
                subsidiaries: [],
                companyUsersByCompanyId: {
                    1305: [{ customerId: 999, email: 'coadmin@dealer305.com', companyRoleName: 'Admin' }],
                },
            });
            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                const params = config?.params ?? {};
                if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(1305));
                if (url === '/api/v3/io/users' && params.companyId === 1305) {
                    return Promise.resolve(
                        b2bCompanyUsers([{ customerId: 999, email: 'coadmin@dealer305.com', companyRoleName: 'Admin' }])
                    );
                }
                if (url === '/api/v3/io/companies/1305') return Promise.resolve(b2bCompanyById('Dealer Co 305'));
                if (url === '/api/v3/io/companies') return Promise.resolve(b2bCompanyList([]));
                if (url === '/api/v3/io/orders/7002') {
                    return Promise.resolve({
                        data: {
                            data: {
                                extraFields: [
                                    { fieldName: 'orderedFor', fieldValue: 'Self' },
                                    { fieldName: 'createdBy', fieldValue: 'Dealer Co 305' },
                                ],
                            },
                        },
                    });
                }
                return Promise.resolve({ data: { data: [] } });
            });

            const res = await request(app).get(`${RECENT_ORDERS_URL}?customerId=305`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.summary.totalOrderCount).toBe(1);
            expect(res.body.data[0].orderId).toBe(7002);
            expect(res.body.data[0].customerId).toBe(999);
            expect(res.body.data[0].createdBy).toBe('Dealer Co 305');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders — validation
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders — validation', () => {
        it('returns 400 when customerId is missing', async () => {
            const res = await request(app).get(ORDERS_URL).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/customerId/);
        });

        it('returns 400 when customerId is zero', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=0`).set(AUTH);
            expect(res.status).toBe(400);
        });

        it('returns 400 when customerId is non-numeric', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=abc`).set(AUTH);
            expect(res.status).toBe(400);
        });

        it('returns 400 when sort is not date_desc or date_asc', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=600&sort=bogus`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/sort must be one of/);
        });

        it('returns 400 when status is not one of STATUS_MAP\'s values', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=600&status=Bogus`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/status must be one of/);
        });

        it('returns 400 when status is supplied as a repeated query param (array) — regression', async () => {
            const res = await request(app)
                .get(`${ORDERS_URL}?customerId=600&status=Pending&status=Shipped`)
                .set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/status must be one of/);
        });

        it('returns 404 when the dealer customer does not exist', async () => {
            mockBcGet.mockResolvedValueOnce({ data: { data: [] } });
            const res = await request(app).get(`${ORDERS_URL}?customerId=601`).set(AUTH);
            expect(res.status).toBe(404);
        });

        it('returns an empty page when the dealer has no resolvable B2B company/hierarchy', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(602, 'dealer602@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } }); // no B2B user found
            const res = await request(app).get(`${ORDERS_URL}?customerId=602`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                summary: { totalOrderCount: 0, openOrderCount: 0 },
                pagination: { total: 0, perPage: 20, currentPage: 1, totalPages: 0, offset: 0 },
                data: [],
            });
        });

        it('computes offset from page (not hardcoded 0) when the dealer has no resolvable B2B company/hierarchy', async () => {
            // Regression: the empty-hierarchy short-circuit used to hardcode offset: 0
            // regardless of the requested page. It now flows through the same
            // pagination math as every other zero-result case in this route.
            mockBcGet.mockResolvedValueOnce(dealerRecord(606, 'dealer606@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } }); // no B2B user found
            const res = await request(app).get(`${ORDERS_URL}?customerId=606&page=3&limit=20`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination).toEqual({ total: 0, perPage: 20, currentPage: 3, totalPages: 0, offset: 40 });
        });

        it('clamps limit to a maximum of 100', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(603, 'dealer603@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } });
            const res = await request(app).get(`${ORDERS_URL}?customerId=603&limit=500`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.perPage).toBe(100);
        });

        it('defaults limit to 20 when omitted or invalid', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(604, 'dealer604@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } });
            const res = await request(app).get(`${ORDERS_URL}?customerId=604&limit=abc`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.perPage).toBe(20);
        });

        it('defaults page to 1 when omitted or invalid', async () => {
            mockBcGet.mockResolvedValueOnce(dealerRecord(605, 'dealer605@test.com'));
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } });
            const res = await request(app).get(`${ORDERS_URL}?customerId=605&page=abc`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.currentPage).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders — orderedFor validation (post-hierarchy-resolution)
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders — orderedFor validation', () => {
        beforeEach(() => {
            setupBigOrdersScenario();
        });

        it("returns zero matches (not a 400) when orderedFor doesn't match any order's stored attribution", async () => {
            // orderedFor filters directly against each order's own stored attribution
            // rather than a separately-resolved company allowlist — the two are
            // independent data sources that can drift (e.g. a B2B company record
            // edited after an order was placed under the old name), so a value that
            // doesn't match anything degrades to an empty result, matching the
            // story's "no matching orders found" requirement instead of a false 400.
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&orderedFor=Bogus%20Co`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(0);
            expect(res.body.data).toEqual([]);
        });

        it('returns 400 when orderedFor is supplied as a repeated query param (array) — regression', async () => {
            const res = await request(app)
                .get(`${ORDERS_URL}?customerId=500&orderedFor=Self&orderedFor=${encodeURIComponent('Client Co 500')}`)
                .set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('orderedFor must be a single string value.');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders — filtering, sorting, pagination, scoping
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders — filtering, sorting, pagination, scoping', () => {
        beforeEach(() => {
            setupBigOrdersScenario();
        });

        it('scopes results to dealer-placed orders only, excluding an un-attributed self-service order', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(4);
            const orderIds = res.body.data.map((o: { orderId: number }) => o.orderId);
            expect(orderIds).not.toContain(9005);
            expect([...orderIds].sort()).toEqual([9001, 9002, 9003, 9004]);
        });

        it('sorts by date_desc by default', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500`).set(AUTH);
            expect(res.body.data.map((o: { orderId: number }) => o.orderId)).toEqual([9004, 9002, 9003, 9001]);
        });

        it('sorts by date_asc when requested', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&sort=date_asc`).set(AUTH);
            expect(res.body.data.map((o: { orderId: number }) => o.orderId)).toEqual([9001, 9003, 9002, 9004]);
        });

        it('filters by status exact match', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&status=Shipped`).set(AUTH);
            expect(res.body.pagination.total).toBe(2);
            expect([...res.body.data.map((o: { orderId: number }) => o.orderId)].sort()).toEqual([9002, 9003]);
        });

        it('filters by orderedFor exact match', async () => {
            const res = await request(app)
                .get(`${ORDERS_URL}?customerId=500&orderedFor=${encodeURIComponent('Client Co 500')}`)
                .set(AUTH);
            expect(res.body.pagination.total).toBe(2);
            expect([...res.body.data.map((o: { orderId: number }) => o.orderId)].sort()).toEqual([9003, 9004]);
        });

        it('filters by search as a substring match against orderNumber', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&search=9003`).set(AUTH);
            expect(res.body.pagination.total).toBe(1);
            expect(res.body.data[0].orderId).toBe(9003);
        });

        it('combines status + orderedFor + search filters to narrow the result set', async () => {
            const res = await request(app)
                .get(
                    `${ORDERS_URL}?customerId=500&status=Shipped&orderedFor=${encodeURIComponent(
                        'Client Co 500'
                    )}&search=9003`
                )
                .set(AUTH);
            expect(res.body.pagination.total).toBe(1);
            expect(res.body.data[0].orderId).toBe(9003);
        });

        it('paginates a multi-page result set correctly', async () => {
            const page1 = await request(app).get(`${ORDERS_URL}?customerId=500&limit=2&page=1`).set(AUTH);
            expect(page1.body.pagination).toEqual({ total: 4, perPage: 2, currentPage: 1, totalPages: 2, offset: 0 });
            expect(page1.body.data.map((o: { orderId: number }) => o.orderId)).toEqual([9004, 9002]);

            const page2 = await request(app).get(`${ORDERS_URL}?customerId=500&limit=2&page=2`).set(AUTH);
            expect(page2.body.pagination).toEqual({ total: 4, perPage: 2, currentPage: 2, totalPages: 2, offset: 2 });
            expect(page2.body.data.map((o: { orderId: number }) => o.orderId)).toEqual([9003, 9001]);
        });

        it('returns an empty data page but correct total/totalPages when the page is beyond the last page', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&limit=2&page=5`).set(AUTH);
            expect(res.body.pagination).toEqual({ total: 4, perPage: 2, currentPage: 5, totalPages: 2, offset: 8 });
            expect(res.body.data).toEqual([]);
        });

        it('accepts machineSerial/machine params (no 400) and yields zero matches since no order has that field set yet', async () => {
            // No order-placement flow writes machineSerial yet — this filter behaves
            // exactly like any other not-yet-populated attribute: a value that
            // matches nothing degrades to an empty result, not an error. Once a
            // future story starts writing machineSerial on new orders, this same
            // filter starts returning real matches with no code change here.
            const res = await request(app)
                .get(`${ORDERS_URL}?customerId=500&machineSerial=SN-123`)
                .set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(0);
            expect(res.body.data).toEqual([]);
        });

        it('accepts the machine alias for machineSerial', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&machine=Genos-L300`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(0);
        });

        it('omitting machineSerial/machine leaves the result set unaffected', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(4);
        });

        it('returns orderNumber as String(orderId) and the full DTO shape including createdBy', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&limit=1&page=1`).set(AUTH);
            const item = res.body.data[0];

            expect(item.orderId).toBe(9004);
            expect(item.orderNumber).toBe('9004');
            expect(Object.keys(item).sort()).toEqual(
                [
                    'createdBy',
                    'currency',
                    'customerId',
                    'date',
                    'itemsTotal',
                    'machineSerial',
                    'orderId',
                    'orderNumber',
                    'orderedFor',
                    'status',
                    'statusId',
                    'total',
                ].sort()
            );
            expect(item.createdBy).toBe('Dealer Co 500');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders — summary (independent of filters)
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders — summary', () => {
        beforeEach(() => {
            setupBigOrdersScenario();
        });

        it('computes summary from the full dealer-placed order set, unfiltered', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500`).set(AUTH);
            expect(res.status).toBe(200);
            // 4 dealer-placed orders (9001-9004); only 9001 is status_id 1 (Pending)
            expect(res.body.summary).toEqual({ totalOrderCount: 4, openOrderCount: 1 });
        });

        it('keeps summary counts unchanged when a status filter narrows data to fewer results', async () => {
            const res = await request(app).get(`${ORDERS_URL}?customerId=500&status=Shipped`).set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(2); // data narrowed to Shipped-only orders
            expect(res.body.summary).toEqual({ totalOrderCount: 4, openOrderCount: 1 }); // summary unaffected
        });

        it('keeps summary counts unchanged when orderedFor/machineSerial/search filters narrow data to zero results', async () => {
            const res = await request(app)
                .get(`${ORDERS_URL}?customerId=500&orderedFor=Bogus%20Co&machineSerial=SN-999&search=nomatch`)
                .set(AUTH);
            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(0);
            expect(res.body.data).toEqual([]);
            expect(res.body.summary).toEqual({ totalOrderCount: 4, openOrderCount: 1 }); // summary still reflects full set
        });

        it('keeps summary counts unchanged across pagination pages', async () => {
            const page1 = await request(app).get(`${ORDERS_URL}?customerId=500&limit=2&page=1`).set(AUTH);
            const page2 = await request(app).get(`${ORDERS_URL}?customerId=500&limit=2&page=2`).set(AUTH);
            expect(page1.body.summary).toEqual({ totalOrderCount: 4, openOrderCount: 1 });
            expect(page2.body.summary).toEqual({ totalOrderCount: 4, openOrderCount: 1 });
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders — error handling
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders — error handling', () => {
        it("excludes a hierarchy customer whose order fetch fails, without failing the whole request", async () => {
            const dealerId = 700;
            const dealerCompanyId = 1700;
            const dealerCompanyName = 'Dealer Co 700';
            const subCompanyId = 2700;
            const subCompanyName = 'Client Co 700';

            mockBcGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                if (url === '/v3/customers' && config?.params?.['id:in'] === dealerId) {
                    return Promise.resolve(dealerRecord(dealerId, 'dealer700@test.com'));
                }
                if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=700')) {
                    return Promise.resolve({
                        data: [orderFixture(9101, dealerId, '2026-01-01T00:00:00Z', 1, 'Pending')],
                    });
                }
                if (typeof url === 'string' && url.startsWith('/v2/orders?customer_id=950')) {
                    // Simulates a BC rate-limit/timeout for this one hierarchy customer —
                    // batchedMap's per-call .catch(() => []) must swallow it so the rest
                    // of the request still succeeds.
                    return Promise.reject(new Error('BC rate limit'));
                }
                return Promise.resolve({ data: { data: [] } });
            });

            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                const params = config?.params ?? {};
                if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(dealerCompanyId));
                if (url === '/api/v3/io/users' && params.companyId === subCompanyId) {
                    return Promise.resolve(b2bCompanyUsers([{ customerId: 950, email: 'buyer950@client700.com' }]));
                }
                // Co-admin visibility fix fans out over the dealer's own company too, not
                // just subsidiaries — no co-admin scenario here, so this dealer has none.
                if (url === '/api/v3/io/users' && params.companyId === dealerCompanyId) {
                    return Promise.resolve(b2bCompanyUsers([]));
                }
                if (url === `/api/v3/io/companies/${dealerCompanyId}`) {
                    return Promise.resolve(b2bCompanyById(dealerCompanyName));
                }
                if (url === '/api/v3/io/companies') {
                    return Promise.resolve(
                        b2bCompanyList([{ companyId: subCompanyId, companyName: subCompanyName, bcGroupName: dealerCompanyName }])
                    );
                }
                if (url === '/api/v3/io/orders/9101') {
                    return Promise.resolve(b2bOrderExtraFields({ orderedFor: 'Self', createdBy: dealerCompanyName }));
                }
                return Promise.reject(new Error(`Unhandled b2bClient.get ${url}`));
            });

            const res = await request(app).get(`${ORDERS_URL}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.pagination.total).toBe(1);
            expect(res.body.data[0].orderId).toBe(9101);
        });

        it('returns 500 when an unexpected error occurs', async () => {
            mockBcGet.mockImplementationOnce(() => Promise.reject(new Error('BC unavailable')));

            const res = await request(app).get(`${ORDERS_URL}?customerId=701`).set(AUTH);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Failed to fetch orders');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — validation
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — validation', () => {
        it('returns 400 when customerId is missing', async () => {
            const res = await request(app).get(ORDER_DETAIL_URL(1)).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/customerId/);
        });

        it('returns 400 when orderId is not numeric', async () => {
            const res = await request(app).get(`${ORDER_DETAIL_URL('abc')}?customerId=1`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/orderId must be a positive integer/);
        });

        it('returns 400 when orderId is zero', async () => {
            const res = await request(app).get(`${ORDER_DETAIL_URL(0)}?customerId=1`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/orderId must be a positive integer/);
        });

        it('returns 400 when orderId is negative', async () => {
            const res = await request(app).get(`${ORDER_DETAIL_URL(-1)}?customerId=1`).set(AUTH);
            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/orderId must be a positive integer/);
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — order lookup
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — order lookup', () => {
        it('returns 404 when the core order response has no id', async () => {
            mockBcGet.mockResolvedValueOnce({ data: {} });

            const res = await request(app).get(`${ORDER_DETAIL_URL(9808)}?customerId=1`).set(AUTH);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Order not found.');
        });

        it('returns 404 when the BC order fetch 404s', async () => {
            (axios.isAxiosError as unknown as jest.Mock).mockReturnValueOnce(true);
            mockBcGet.mockRejectedValueOnce({ response: { status: 404 } });

            const res = await request(app).get(`${ORDER_DETAIL_URL(9809)}?customerId=1`).set(AUTH);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Order not found.');
        });

        it('returns 500 when the BC order fetch fails with a non-404 error', async () => {
            // axios.isAxiosError defaults to false (module mock), so this rejection
            // is treated as an unexpected error and rethrown to the outer 500 handler
            // rather than mapped to 404 — distinct from the 404 case above.
            mockBcGet.mockRejectedValueOnce(new Error('BC unavailable'));

            const res = await request(app).get(`${ORDER_DETAIL_URL(9810)}?customerId=1`).set(AUTH);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Failed to fetch order detail.');
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — authorization
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — authorization', () => {
        it('returns 404 when the dealer customer does not exist', async () => {
            const dealerId = 804;
            const orderId = 9804;
            mockBcGet.mockImplementation((url: string) => {
                if (url === `/v2/orders/${orderId}`) return Promise.resolve(orderDetailFixture(orderId, dealerId));
                if (url === '/v3/customers') return Promise.resolve({ data: { data: [] } });
                return Promise.reject(new Error(`Unhandled bcClient.get ${url}`));
            });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Dealer not found.');
        });

        it("returns 403 when the dealer has no resolvable B2B hierarchy", async () => {
            const dealerId = 805;
            const orderId = 9805;
            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId),
                dealerId,
                dealerEmail: 'dealer805@test.com',
            });
            mockB2bGet.mockResolvedValueOnce({ data: { data: [] } }); // no B2B user found

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(403);
            expect(res.body.error).toBe("Order does not belong to this dealer's hierarchy.");
        });

        it("returns 403 when the order's customer_id falls outside the dealer's resolved hierarchy", async () => {
            const dealerId = 806;
            const dealerCompanyId = 1806;
            const dealerCompanyName = 'Dealer Co 806';
            const subCompanyId = 2806;
            const subCompanyName = 'Client Co 806';
            const orderId = 9806;
            const outsideCustomerId = 777806; // real BC customer, but not in this dealer's hierarchy

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, outsideCustomerId),
                dealerId,
                dealerEmail: 'dealer806@test.com',
            });
            setupHierarchy({
                dealerCompanyId,
                dealerCompanyName,
                subsidiaries: [{ companyId: subCompanyId, companyName: subCompanyName }],
                companyUsersByCompanyId: {
                    [subCompanyId]: [{ customerId: 886, email: 'buyer886@client806.com' }],
                },
            });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(403);
            expect(res.body.error).toBe("Order does not belong to this dealer's hierarchy.");
        });

        it('returns 403 for a self-service order under a subsidiary customer_id the dealer did not place (Copilot-flagged authorization gap)', async () => {
            // Hierarchy-membership alone is NOT sufficient authorization: this order's
            // customer_id IS inside the dealer's hierarchy (a real subsidiary user), but
            // no B2B extraFields record attributes it to this dealer's company -- i.e.
            // the subsidiary customer placed it themselves, not through this dealer.
            // GET /orders already excludes exactly this case from the list; the detail
            // page must not be reachable for it either, even by guessing the order id.
            const dealerId = 807;
            const dealerCompanyId = 1807;
            const dealerCompanyName = 'Dealer Co 807';
            const subCompanyId = 2807;
            const subCompanyName = 'Client Co 807';
            const subUserCustomerId = 887;
            const orderId = 9807;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, subUserCustomerId),
                dealerId,
                dealerEmail: 'dealer807@test.com',
            });
            setupHierarchy({
                dealerCompanyId,
                dealerCompanyName,
                subsidiaries: [{ companyId: subCompanyId, companyName: subCompanyName }],
                companyUsersByCompanyId: {
                    [subCompanyId]: [{ customerId: subUserCustomerId, email: 'buyer887@client807.com' }],
                },
            });
            // setupHierarchy's default: this order has no B2B record at all (empty
            // extraFields) -- exactly the self-service-order scenario being tested.

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(403);
            expect(res.body.error).toBe("Order does not belong to this dealer's hierarchy.");
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — happy paths
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — happy paths', () => {
        it('returns the full DTO shape for a self-service order (customer_id === dealerId)', async () => {
            const dealerId = 800;
            const dealerCompanyId = 1800;
            const dealerCompanyName = 'Dealer Co 800';
            const orderId = 9800;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId, {
                    status_id: 1,
                    date_created: '2026-01-01T00:00:00Z',
                    subtotal_ex_tax: 200,
                    shipping_cost_ex_tax: 15,
                    total_tax: 10,
                    total_inc_tax: 225,
                    currency_code: 'USD',
                }),
                dealerId,
                dealerEmail: 'dealer800@test.com',
                products: [productFixture({ product_id: 1, sku: 'SKU-A', name: 'Widget A', quantity: 2, price_inc_tax: 50, total_inc_tax: 100 })],
                shippingAddresses: [shippingAddressFixture()],
                shipments: [
                    shipmentFixture({
                        tracking_number: '1Z999AA10123456784',
                        tracking_carrier: 'UPS',
                        date_created: '2026-01-05T00:00:00Z',
                        shipping_method: 'Ground',
                    }),
                ],
            });
            setupHierarchy({ dealerCompanyId, dealerCompanyName, subsidiaries: [] });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                orderId,
                orderNumber: String(orderId),
                orderDate: '2026-01-01T00:00:00Z',
                statusId: 1,
                status: 'Pending',
                orderedFor: 'Self',
                poReference: '',
                // Falls back to the querying dealer's own BC name ('Test Dealer' --
                // the mocked dealer record's first/last name) since no real
                // placedByName B2B field is set in this fixture.
                placedByName: 'Test Dealer',
                machineSerial: '',
                paymentMethod: 'Manual',
                carrierType: '',
                carrierAccountNumber: '',
                machineDownContactName: '',
                machineDownContactPhone: '',
                invoiceId: null,
                invoiceNumber: null,
                lineItems: [
                    {
                        productId: 1,
                        sku: 'SKU-A',
                        name: 'Widget A',
                        quantity: 2,
                        unitPrice: 50,
                        lineTotal: 100,
                    },
                ],
                costBreakdown: {
                    subtotal: 200,
                    shipping: 15,
                    tax: 10,
                    total: 225,
                    currency: 'USD',
                },
                shipping: {
                    address: {
                        firstName: 'Jane',
                        lastName: 'Doe',
                        street1: '123 Main St',
                        street2: null, // empty string maps to null
                        city: 'Austin',
                        state: 'Texas',
                        zip: '78701',
                        country: 'United States',
                    },
                    method: 'Ground',
                    trackingNumber: '1Z999AA10123456784',
                    trackingCarrier: 'UPS',
                    shippedOn: '2026-01-05T00:00:00Z',
                    estimatedDelivery: null,
                },
                customerId: dealerId,
            });
        });

        it('authorizes and returns detail for an order placed under a subsidiary company user (not the dealer\'s own id)', async () => {
            const dealerId = 801;
            const dealerCompanyId = 1801;
            const dealerCompanyName = 'Dealer Co 801';
            const subCompanyId = 2801;
            const subCompanyName = 'Client Co 801';
            const subUserCustomerId = 881;
            const orderId = 9801;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, subUserCustomerId, { status_id: 2 }),
                dealerId,
                dealerEmail: 'dealer801@test.com',
                products: [productFixture()],
                shippingAddresses: [],
                shipments: [],
            });
            setupHierarchy({
                dealerCompanyId,
                dealerCompanyName,
                subsidiaries: [{ companyId: subCompanyId, companyName: subCompanyName }],
                companyUsersByCompanyId: {
                    [subCompanyId]: [{ customerId: subUserCustomerId, email: 'buyer881@client801.com' }],
                },
            });
            // Override setupHierarchy's default empty extraFields for this one order:
            // this order must carry a createdBy matching the dealer's company, or the
            // second-tier authorization check (order.customer_id === dealerId OR
            // createdBy === dealerCompanyName) would now correctly 403 it -- this test
            // verifies the LEGITIMATE case (dealer placed this order for the
            // subsidiary), not the self-service-order case that check exists to block.
            const baseMockB2bGet = (mockB2bGet as jest.Mock).getMockImplementation();
            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                if (url === `/api/v3/io/orders/${orderId}`) {
                    return Promise.resolve(
                        b2bOrderExtraFields({ orderedFor: subCompanyName, createdBy: dealerCompanyName })
                    );
                }
                return baseMockB2bGet!(url, config);
            });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.customerId).toBe(subUserCustomerId);
            expect(res.body.statusId).toBe(2);
            expect(res.body.status).toBe('Shipped');
            expect(res.body.orderedFor).toBe(subCompanyName);
            expect(res.body.shipping.address).toBeNull();
            // placedByName still falls back to the *querying dealer's* own name even
            // though this order belongs to a different (subsidiary) customer_id —
            // confirmed correct against real dev data, not just this mock.
            expect(res.body.placedByName).toBe('Test Dealer');
        });

        it('returns real orderedFor/poReference/placedByName/machineSerial values when the order has a registered B2B order record', async () => {
            const dealerId = 802;
            const dealerCompanyId = 1802;
            const dealerCompanyName = 'Dealer Co 802';
            const orderId = 9802;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId),
                dealerId,
                dealerEmail: 'dealer802@test.com',
                products: [],
                shippingAddresses: [],
                shipments: [],
            });

            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                const params = config?.params ?? {};
                if (url === '/api/v3/io/users' && params.email) return Promise.resolve(b2bUserByEmail(dealerCompanyId));
                // Co-admin visibility fix fans out over the dealer's own company too, even
                // with zero subsidiaries — no co-admin scenario here, so this dealer has none.
                if (url === '/api/v3/io/users' && params.companyId === dealerCompanyId) {
                    return Promise.resolve(b2bCompanyUsers([]));
                }
                if (url === `/api/v3/io/companies/${dealerCompanyId}`) return Promise.resolve(b2bCompanyById(dealerCompanyName));
                if (url === '/api/v3/io/companies') return Promise.resolve(b2bCompanyList([]));
                if (url === `/api/v3/io/orders/${orderId}`) {
                    return Promise.resolve(
                        b2bOrderExtraFields({
                            orderedFor: 'Client Co 802',
                            poNumber: 'PO-4521', // real B2B key -- confirmed via live GraphQL schema check
                            placedByName: 'Jane Buyer',
                            machineSerial: 'SN-9802',
                            createdBy: dealerCompanyName,
                        })
                    );
                }
                return Promise.reject(new Error(`Unhandled b2bClient.get ${url}`));
            });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.orderedFor).toBe('Client Co 802');
            expect(res.body.poReference).toBe('PO-4521');
            expect(res.body.placedByName).toBe('Jane Buyer');
            expect(res.body.machineSerial).toBe('SN-9802');
        });

        it('returns 200 with defaulted fields when one of the three concurrent sub-resource calls fails', async () => {
            const dealerId = 803;
            const dealerCompanyId = 1803;
            const dealerCompanyName = 'Dealer Co 803';
            const orderId = 9803;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId),
                dealerId,
                dealerEmail: 'dealer803@test.com',
                products: [productFixture()],
                shippingAddresses: 'reject', // simulates a BC timeout/rate-limit for this one call
                shipments: [shipmentFixture({ shipping_method: 'Express' })],
            });
            setupHierarchy({ dealerCompanyId, dealerCompanyName, subsidiaries: [] });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            // products and shipments succeeded independently of the failed shipping_addresses call
            expect(res.body.lineItems).toHaveLength(1);
            expect(res.body.shipping.method).toBe('Express');
            // shipping_addresses failed -> defaults to [] -> no address on the response
            expect(res.body.shipping.address).toBeNull();
        });

        it('defaults lineItems to [] when the products call fails, independently of the other two sub-resource calls', async () => {
            const dealerId = 810;
            const dealerCompanyId = 1810;
            const dealerCompanyName = 'Dealer Co 810';
            const orderId = 9820;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId),
                dealerId,
                dealerEmail: 'dealer810@test.com',
                products: 'reject',
                shippingAddresses: [shippingAddressFixture()],
                shipments: [shipmentFixture({ shipping_method: 'Freight' })],
            });
            setupHierarchy({ dealerCompanyId, dealerCompanyName, subsidiaries: [] });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            expect(res.body.lineItems).toEqual([]);
            // shipping_addresses and shipments succeeded independently of the failed products call
            expect(res.body.shipping.address).not.toBeNull();
            expect(res.body.shipping.method).toBe('Freight');
        });

        it('defaults shipping method/tracking/shippedOn to null when the shipments call fails, independently of the other two sub-resource calls', async () => {
            const dealerId = 811;
            const dealerCompanyId = 1811;
            const dealerCompanyName = 'Dealer Co 811';
            const orderId = 9821;

            setupOrderDetailBc({
                orderId,
                order: orderDetailFixture(orderId, dealerId),
                dealerId,
                dealerEmail: 'dealer811@test.com',
                products: [productFixture()],
                shippingAddresses: [shippingAddressFixture()],
                shipments: 'reject',
            });
            setupHierarchy({ dealerCompanyId, dealerCompanyName, subsidiaries: [] });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(200);
            // products and shipping_addresses succeeded independently of the failed shipments call
            expect(res.body.lineItems).toHaveLength(1);
            expect(res.body.shipping.address).not.toBeNull();
            // shipments failed -> shipment is undefined -> method falls back to shippingAddress.shipping_method (undefined) -> null
            expect(res.body.shipping.method).toBeNull();
            expect(res.body.shipping.trackingNumber).toBeNull();
            expect(res.body.shipping.trackingCarrier).toBeNull();
            expect(res.body.shipping.shippedOn).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — invoice population
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — invoice population', () => {
        it('returns invoiceId/invoiceNumber for an order with a matching B2B invoice, and null for one without', async () => {
            const dealerId = 820;
            const dealerCompanyId = 1820;
            const dealerCompanyName = 'Dealer Co 820';
            const orderIdWithInvoice = 9840;
            const orderIdWithoutInvoice = 9841;

            // setupHierarchy's own dispatcher has no branch for the B2B Invoice
            // Portal endpoint (out of scope for every other test) -- wrap it here
            // rather than editing the shared helper, so this stays the only test
            // that cares about invoice matching.
            setupHierarchy({ dealerCompanyId, dealerCompanyName, subsidiaries: [] });
            const hierarchyB2bGet = mockB2bGet.getMockImplementation()!;
            mockB2bGet.mockImplementation((url: string, config?: { params?: Record<string, unknown> }) => {
                if (url === '/api/v3/io/ip/invoices') {
                    return Promise.resolve({
                        data: { data: [{ id: 555111, invoiceNumber: '555111', orderNumber: orderIdWithInvoice }] },
                    });
                }
                return hierarchyB2bGet(url, config);
            });

            setupOrderDetailBc({
                orderId: orderIdWithInvoice,
                order: orderDetailFixture(orderIdWithInvoice, dealerId),
                dealerId,
                dealerEmail: 'dealer820@test.com',
                products: [],
                shippingAddresses: [],
                shipments: [],
            });
            const resWithInvoice = await request(app)
                .get(`${ORDER_DETAIL_URL(orderIdWithInvoice)}?customerId=${dealerId}`)
                .set(AUTH);
            expect(resWithInvoice.status).toBe(200);
            expect(resWithInvoice.body.invoiceId).toBe(555111);
            expect(resWithInvoice.body.invoiceNumber).toBe('555111');

            // Same cached invoice list (fetched once above, within its 5-minute TTL)
            // correctly yields no match for a different order — proves the match is
            // per-order, not "an invoice exists somewhere so every order gets one".
            setupOrderDetailBc({
                orderId: orderIdWithoutInvoice,
                order: orderDetailFixture(orderIdWithoutInvoice, dealerId),
                dealerId,
                dealerEmail: 'dealer820@test.com',
                products: [],
                shippingAddresses: [],
                shipments: [],
            });
            const resWithoutInvoice = await request(app)
                .get(`${ORDER_DETAIL_URL(orderIdWithoutInvoice)}?customerId=${dealerId}`)
                .set(AUTH);
            expect(resWithoutInvoice.status).toBe(200);
            expect(resWithoutInvoice.body.invoiceId).toBeNull();
            expect(resWithoutInvoice.body.invoiceNumber).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // GET /v1/dashboard/orders/:orderId — error handling
    // -----------------------------------------------------------------------

    describe('GET /v1/dashboard/orders/:orderId — error handling', () => {
        it('returns 500 when an unexpected error occurs during dealer lookup', async () => {
            const dealerId = 807;
            const orderId = 9807;

            mockBcGet.mockImplementation((url: string) => {
                if (url === `/v2/orders/${orderId}`) return Promise.resolve(orderDetailFixture(orderId, dealerId));
                if (url === '/v3/customers') return Promise.reject(new Error('BC unavailable'));
                return Promise.reject(new Error(`Unhandled bcClient.get ${url}`));
            });

            const res = await request(app).get(`${ORDER_DETAIL_URL(orderId)}?customerId=${dealerId}`).set(AUTH);

            expect(res.status).toBe(500);
            expect(res.body.error).toBe('Failed to fetch order detail.');
        });
    });
});
