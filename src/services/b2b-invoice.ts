import b2bClient from './b2b';
import { collectPages, B2BPage, B2B_PAGE_LIMIT } from './b2b-hierarchy';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A B2B invoice record as returned by the B2B Invoice Portal /api/v3/io/ip/invoices endpoint. */
export interface B2BInvoice {
    id: number;
    invoiceNumber: string;
    orderNumber: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch every invoice recorded in the B2B Invoice Portal (all pages).
 *
 * The B2B API does not support server-side filtering by order — confirmed live
 * against a real store: requesting `?orderNumber={id}` still returns every
 * invoice, unfiltered. So, same as fetchB2BCompaniesByGroupName in
 * b2b-hierarchy.ts, all pages are fetched and the caller filters client-side.
 *
 * B2B API: GET /api/v3/io/ip/invoices (paginated)
 * @returns Every invoice in the store, across all pages.
 */
export async function fetchAllB2BInvoices(): Promise<B2BInvoice[]> {
    return collectPages(async off => {
        try {
            const res = await b2bClient.get<B2BPage<B2BInvoice>>('/api/v3/io/ip/invoices', {
                params: { limit: B2B_PAGE_LIMIT, offset: off },
            });
            return res.data?.data ?? [];
        } catch (err) {
            logger.error(`b2b-invoice: invoices fetch failed: ${(err as Error).message}`);
            throw err;
        }
    });
}
