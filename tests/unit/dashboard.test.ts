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

import app from '../../src/app';
import bcClient from '../../src/services/bigcommerce';
import b2bClient from '../../src/services/b2b';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH = { 'X-Auth-Token': 'test-bc-token' };
const ORDERS_URL = '/v1/dashboard/orders';
const RECENT_ORDERS_URL = '/v1/dashboard/recent-orders';

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
});
