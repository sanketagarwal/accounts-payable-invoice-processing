import { FixtureGoodsReceiptRepository, FixturePurchaseOrderRepository, FixtureSanctionsScreener, FixtureVendorRepository, fixtureDb } from '../adapters/fixture.ts'
import { assertProvider, type AccountingProvider } from './types.ts'

export const fixtureProvider: AccountingProvider = assertProvider({
  id: 'fixture', displayName: 'Fixture accounting data',
  capabilities: { vendors: true, vendorBankDetails: true, vendorStatusRichness: 'full', purchaseOrders: true, goodsReceipts: true, billHistory: true, sanctions: true, invoiceChannel: true, posting: false },
  vendors: new FixtureVendorRepository(), purchaseOrders: new FixturePurchaseOrderRepository(), goodsReceipts: new FixtureGoodsReceiptRepository(),
  sanctions: new FixtureSanctionsScreener(), billHistorySeed: async () => structuredClone(fixtureDb.priorInvoices),
  identityNamespaces: { vendors: 'fixture', purchaseOrders: 'fixture', goodsReceipts: 'fixture' },
})
