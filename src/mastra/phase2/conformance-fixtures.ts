import type { ProviderConformanceCases } from './conformance.ts'
import { ProviderUnavailableError } from './ports.ts'

export const fixtureConformanceCases = {
  vendors: {
    found: { name: 'Acme Supplies', taxId: 'US-12-3456789' }, missing: { name: 'Missing Vendor' },
    transportFailure: { lookup: { name: 'Acme Supplies' }, repository: { find: async () => { throw new ProviderUnavailableError('faulting-fixture', 'find vendor') } } },
  },
  purchaseOrders: {
    found: 'PO-1001', missing: 'PO-MISSING',
    transportFailure: { poNumber: 'PO-1001', repository: { findByNumber: async () => { throw new ProviderUnavailableError('faulting-fixture', 'find purchase order') } } },
  },
  goodsReceipts: {
    found: 'po_1001', missing: 'po_missing',
    transportFailure: { purchaseOrderId: 'po_1001', repository: { findByPurchaseOrderId: async () => { throw new ProviderUnavailableError('faulting-fixture', 'find receipt') } } },
  },
} satisfies ProviderConformanceCases
