import type { GoodsReceiptRepository } from '../ports.ts'
import { assertProvider, sourceId, type AccountingProvider, type CompositeIdentityConfig } from './types.ts'

export interface CompositeProviderConfig {
  id: string; displayName: string; vendors?: AccountingProvider; purchaseOrders?: AccountingProvider; goodsReceipts?: AccountingProvider;
  sanctions?: AccountingProvider; billHistory?: AccountingProvider; identity?: CompositeIdentityConfig;
}
class CrosswalkReceiptRepository implements GoodsReceiptRepository {
  constructor(private readonly delegate: GoodsReceiptRepository, private readonly from: string, private readonly to: string, private readonly config: CompositeIdentityConfig) {}
  async findByPurchaseOrderId(id: string) {
    const mapped = this.from === this.to ? id : await this.config.crosswalk?.mapPurchaseOrderId({ id, fromNamespace: this.from, toNamespace: this.to })
    if (!mapped) return []
    return (await this.delegate.findByPurchaseOrderId(mapped)).map(receipt => ({ ...receipt, purchaseOrderId: id }))
  }
}
export function makeCompositeProvider(config: CompositeProviderConfig): AccountingProvider {
  const vendor = config.vendors, po = config.purchaseOrders, receipt = config.goodsReceipts, sanctions = config.sanctions, history = config.billHistory
  let goodsReceipts = receipt?.goodsReceipts
  if (po && receipt && po.id !== receipt.id) {
    const from = po.identityNamespaces?.purchaseOrders, to = receipt.identityNamespaces?.goodsReceipts
    if (!from || !to) throw new Error('Composite PO/receipt sources must declare identity namespaces')
    const shared = from === to && (!config.identity?.sharedReferenceNamespace || config.identity.sharedReferenceNamespace === from)
    if (!shared && !config.identity?.crosswalk) throw new Error('Composite PO/receipt sources require a shared namespace or ID crosswalk')
    if (!shared && goodsReceipts) goodsReceipts = new CrosswalkReceiptRepository(goodsReceipts, from, to, config.identity ?? {})
  }
  return assertProvider({
    id: config.id, displayName: config.displayName,
    capabilities: {
      vendors: Boolean(vendor?.vendors), vendorBankDetails: vendor?.capabilities.vendorBankDetails ?? false,
      vendorStatusRichness: vendor?.capabilities.vendorStatusRichness ?? 'none', purchaseOrders: Boolean(po?.purchaseOrders),
      goodsReceipts: Boolean(goodsReceipts), sanctions: Boolean(sanctions?.sanctions), billHistory: Boolean(history?.billHistorySeed),
      invoiceChannel: history?.capabilities.invoiceChannel ?? false, posting: false,
    },
    vendors: vendor?.vendors, purchaseOrders: po?.purchaseOrders, goodsReceipts, sanctions: sanctions?.sanctions, billHistorySeed: history?.billHistorySeed,
    sources: {
      ...(vendor && { vendors: sourceId(vendor, 'vendors') }), ...(po && { purchaseOrders: sourceId(po, 'purchaseOrders') }),
      ...(receipt && { goodsReceipts: sourceId(receipt, 'goodsReceipts') }), ...(sanctions && { sanctions: sourceId(sanctions, 'sanctions') }),
      ...(history && { billHistory: sourceId(history, 'billHistory') }),
    },
    identityNamespaces: { vendors: vendor?.identityNamespaces?.vendors, purchaseOrders: po?.identityNamespaces?.purchaseOrders, goodsReceipts: po?.identityNamespaces?.purchaseOrders },
  })
}
