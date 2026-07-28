import b2bClient from './b2b';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A B2B company record as returned by the B2B Edition /api/v3/io/companies endpoint. */
export interface B2BCompany {
    companyId: number;
    companyName: string;
    companyEmail: string;
    bcGroupName?: string;
    parentCompany: {
        id: number | null;
        name: string;
    };
}

/** A B2B user record linking a B2B user ID to a BC customer ID and the user's company. */
export interface B2BCompanyUser {
    id: number;
    email: string;
    customerId: number; // BC customer ID
    companyId: number;
    companyRoleName?: string; // e.g. 'Admin', 'Senior Buyer', 'Junior Buyer'
}

/** Generic paginated response envelope from the B2B Edition API. */
export interface B2BPage<T> {
    data: T[];
    meta?: {
        pagination?: {
            totalCount?: number;
            offset?: number;
            limit?: number;
        };
    };
}

/** Maximum number of records to request per page from the B2B Edition API. */
export const B2B_PAGE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collects all pages from a paginated B2B endpoint.
 * Iterative (not recursive) so page count can't overflow the call stack —
 * pagination is inherently sequential (offset N+1 depends on page N's length).
 * @param fetcher - Fetches one page given an offset; should return fewer than
 *   B2B_PAGE_LIMIT items on the last page.
 * @returns All items across every page, concatenated in order.
 */
export async function collectPages<T>(fetcher: (off: number) => Promise<T[]>): Promise<T[]> {
    const acc: T[] = [];
    let offset = 0;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const page = await fetcher(offset);
        acc.push(...page);
        if (page.length < B2B_PAGE_LIMIT) break;
        offset += B2B_PAGE_LIMIT;
    }
    return acc;
}

/**
 * Find a dealer's B2B company ID by looking up their B2B user via email.
 *
 * B2B API: GET /api/v3/io/users?email={email}
 * The returned user object contains `companyId` which is the dealer's B2B company.
 * @param email - Dealer's BC/B2B email address.
 * @returns The dealer's B2B company ID, or null if no matching user is found.
 */
export async function fetchB2BCompanyIdByEmail(email: string): Promise<number | null> {
    try {
        const res = await b2bClient.get<B2BPage<B2BCompanyUser>>('/api/v3/io/users', {
            params: { email, limit: 1 },
        });
        const user = res.data?.data?.[0] ?? null;
        return user ? user.companyId : null;
    } catch (err) {
        logger.error(`b2b-hierarchy: user lookup by email ${email} failed: ${(err as Error).message}`);
        return null;
    }
}

/**
 * Fetch all direct subsidiaries of a B2B company.
 *
 * The B2B API does not support server-side parent filtering, so all companies
 * are fetched (paginated) and filtered client-side on parentCompany.id.
 *
 * B2B API: GET /api/v3/io/companies (paginated)
 * @param dealerCompanyId - B2B company ID of the parent (dealer) company.
 * @returns Direct subsidiary companies whose parentCompany.id matches dealerCompanyId.
 */
export async function fetchB2BSubsidiaries(dealerCompanyId: number): Promise<B2BCompany[]> {
    const all = await collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompany>>('/api/v3/io/companies', {
                params: { limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`b2b-hierarchy: companies fetch failed: ${(err as Error).message}`);
            throw err;
        }
    });
    return all.filter(c => c.parentCompany?.id === dealerCompanyId);
}

/**
 * Fetch all B2B users (and their BC customer IDs) for a given company (all pages).
 *
 * B2B API: GET /api/v3/io/users?companyId={companyId}
 * @param companyId - B2B company ID.
 * @returns All B2B users belonging to the company, across every page.
 */
export async function fetchB2BCompanyUsers(companyId: number): Promise<B2BCompanyUser[]> {
    return collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompanyUser>>('/api/v3/io/users', {
                params: { companyId, limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`b2b-hierarchy: users fetch for company ${companyId} failed: ${(err as Error).message}`);
            throw err;
        }
    });
}

/**
 * Fetch all B2B companies whose bcGroupName exactly matches the supplied name.
 *
 * This is the authoritative way to find a dealer's real client companies —
 * confirmed against real data that `parentCompany` linkage (fetchB2BSubsidiaries)
 * covers only a small fraction of a dealer's actual companies in this store,
 * while bcGroupName correctly reflects all of them.
 *
 * The B2B API has no server-side filter for this field, so all pages are fetched
 * and filtered client-side.
 *
 * B2B API: GET /api/v3/io/companies (paginated)
 * @param groupName - BC customer group name to match against each company's bcGroupName.
 * @returns All B2B companies whose bcGroupName exactly matches groupName.
 */
export async function fetchB2BCompaniesByGroupName(groupName: string): Promise<B2BCompany[]> {
    const all = await collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BCompany>>('/api/v3/io/companies', {
                params: { limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`b2b-hierarchy: companies fetch failed: ${(err as Error).message}`);
            throw err;
        }
    });
    return all.filter(c => c.bcGroupName === groupName);
}
