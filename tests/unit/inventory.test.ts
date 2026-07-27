jest.mock('../../src/services/bigcommerce', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

jest.mock('../../src/services/b2b', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

jest.mock('../../src/services/customerProfile', () => ({
    __esModule: true,
    default: jest.fn(),
}));

import bcClient from '../../src/services/bigcommerce';
import b2bClient from '../../src/services/b2b';
import fetchCustomerProfile from '../../src/services/customerProfile';
import { resolveDealerLocationId, resolveStock, type BcInventoryItem } from '../../src/services/inventory';

const mockBcGet = bcClient.get as jest.Mock;
const mockB2bGet = b2bClient.get as jest.Mock;
const mockFetchCustomerProfile = fetchCustomerProfile as jest.Mock;

function location(id: number, name: string, available: number, enabled = true) {
    return {
        location_id: id,
        location_code: `${id}`,
        location_name: name,
        available_to_sell: available,
        location_enabled: enabled,
    };
}

function inventoryItem(locations: BcInventoryItem['locations']): BcInventoryItem {
    return {
        identity: { sku: 'TEST-SKU', product_id: 1 },
        locations,
    };
}

describe('inventory service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('resolveStock', () => {
        it('prefers dealer stock when dealer location is in stock', () => {
            const result = resolveStock(
                inventoryItem([location(18, 'Dealer Location', 4), location(9, 'OKUMA (US) Warehouse', 12)]),
                18
            );

            expect(result).toEqual(
                expect.objectContaining({
                    inStock: true,
                    stockSource: 'dealer',
                    availableStock: 4,
                })
            );
        });

        it('falls back to okuma stock when dealer location has no stock', () => {
            const result = resolveStock(
                inventoryItem([location(18, 'Dealer Location', 0), location(9, 'Okuma-US Warehouse', 3)]),
                18
            );

            expect(result).toEqual(
                expect.objectContaining({
                    inStock: true,
                    stockSource: 'okuma',
                    availableStock: 3,
                })
            );
        });

        it('returns none when no enabled location has stock', () => {
            const result = resolveStock(
                inventoryItem([location(18, 'Dealer Location', 0), location(9, 'Okuma-US Warehouse', 0, false)]),
                18
            );

            expect(result).toEqual(
                expect.objectContaining({
                    inStock: false,
                    stockSource: 'none',
                    availableStock: null,
                })
            );
        });
    });

    describe('resolveDealerLocationId', () => {
        it('resolves distributor id to matching BC inventory location', async () => {
            mockFetchCustomerProfile.mockResolvedValue({ email: 'dealer@test.com' });
            mockB2bGet
                .mockResolvedValueOnce({ data: { data: [{ companyId: 77 }] } })
                .mockResolvedValueOnce({
                    data: {
                        data: { extraFields: [{ fieldName: 'Distributor ID', fieldValue: '100322' }] },
                    },
                });
            mockBcGet.mockResolvedValue({
                data: { data: [{ id: 18, code: 'US-100322', label: 'Gosiger Dayton', enabled: true }] },
            });

            await expect(resolveDealerLocationId('customer-1')).resolves.toBe(18);
        });

        it('caches resolved dealer location by customer id', async () => {
            mockFetchCustomerProfile.mockResolvedValue({ email: 'dealer2@test.com' });
            mockB2bGet
                .mockResolvedValueOnce({ data: { data: [{ companyId: 88 }] } })
                .mockResolvedValueOnce({
                    data: {
                        data: { extraFields: [{ fieldName: 'Distributor ID', fieldValue: '100322' }] },
                    },
                });
            mockBcGet.mockResolvedValue({
                data: { data: [{ id: 18, code: 'US-100322', label: 'Gosiger Dayton', enabled: true }] },
            });

            await expect(resolveDealerLocationId('cache-customer')).resolves.toBe(18);
            await expect(resolveDealerLocationId('cache-customer')).resolves.toBe(18);

            expect(mockFetchCustomerProfile).toHaveBeenCalledTimes(1);
            expect(mockB2bGet).toHaveBeenCalledTimes(2);
        });

        it('returns null when distributor id is missing', async () => {
            mockFetchCustomerProfile.mockResolvedValue({ email: 'nodistributor@test.com' });
            mockB2bGet
                .mockResolvedValueOnce({ data: { data: [{ companyId: 99 }] } })
                .mockResolvedValueOnce({ data: { data: { extraFields: [] } } });
            mockBcGet.mockResolvedValue({ data: { data: [] } });

            await expect(resolveDealerLocationId('customer-no-distributor')).resolves.toBeNull();
        });
    });
});
