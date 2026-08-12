import { ReferenceCrosswalkError, type GoodsReceiptRepository, type PurchaseOrderRepository } from '../ports.ts'
import { assertProvider, sourceId, type AccountingProvider, type CompositeIdentityConfig } from './types.ts'

export interface CompositeProviderConfig {
  id: string; displayName: string; vendors?: AccountingProvider; purchaseOrders?: AccountingProvider; goodsReceipts?: AccountingProvider;
  sanctions?: AccountingProvider; billHistory?: AccountingProvider; identity?: CompositeIdentityConfig;
}
const shared = (from: string, to: string, config?: CompositeIdentityConfig) => from === to && (!config?.sharedReferenceNamespace || config.sharedReferenceNamespace === from)
class CrosswalkPurchaseOrderRepository implements PurchaseOrderRepository {
  constructor(private readonly delegate: PurchaseOrderRepository, private readonly from: string, private readonly to: string, private readonly config: CompositeIdentityConfig) {}
  async findByNumber(poNumber: string) {
    return Promise.all((await this.delegate.findByNumber(poNumber)).map(async po => {
      const mapped = await this.config.crosswalk?.mapVendorId?.({ id: po.vendorId, fromNamespace: this.from, toNamespace: this.to })
      if (!mapped) throw new ReferenceCrosswalkError('vendor', po.vendorId)
      return { ...po, vendorId: mapped }
    }))
  }
}
class CrosswalkReceiptRepository implements GoodsReceiptRepository {
  constructor(private readonly delegate: GoodsReceiptRepository, private readonly from: string, private readonly to: string, private readonly config: CompositeIdentityConfig) {}
  async findByPurchaseOrderId(id: string) {
    const mapped = await this.config.crosswalk?.mapPurchaseOrderId?.({ id, fromNamespace: this.from, toNamespace: this.to })
    if (!mapped) throw new ReferenceCrosswalkError('purchaseOrder', id)
    return (await this.delegate.findByPurchaseOrderId(mapped)).map(receipt => ({ ...receipt, purchaseOrderId: id }))
  }
}
export function makeCompositeProvider(config: CompositeProviderConfig): AccountingProvider {
  const vendor = config.vendors, po = config.purchaseOrders, receipt = config.goodsReceipts, sanctions = config.sanctions, history = config.billHistory
  let purchaseOrders = po?.purchaseOrders, goodsReceipts = receipt?.goodsReceipts, billHistorySeed = history?.billHistorySeed
  if (vendor && po && vendor.id !== po.id) {
    const from = po.identityNamespaces?.purchaseOrderVendorIds, to = vendor.identityNamespaces?.vendors
    if (!from || !to) throw new Error('Composite vendor/PO sources must declare identity namespaces')
    if (!shared(from, to, config.identity) && !config.identity?.crosswalk?.mapVendorId) throw new Error('Composite vendor/PO sources require a shared namespace or vendor ID crosswalk')
    if (!shared(from, to, config.identity) && purchaseOrders) purchaseOrders = new CrosswalkPurchaseOrderRepository(purchaseOrders, from, to, config.identity!)
  }
  if (po && receipt && po.id !== receipt.id) {
    const from = po.identityNamespaces?.purchaseOrders, to = receipt.identityNamespaces?.goodsReceipts
    if (!from || !to) throw new Error('Composite PO/receipt sources must declare identity namespaces')
    if (!shared(from, to, config.identity) && !config.identity?.crosswalk?.mapPurchaseOrderId) throw new Error('Composite PO/receipt sources require a shared namespace or purchase-order ID crosswalk')
    if (!shared(from, to, config.identity) && goodsReceipts) goodsReceipts = new CrosswalkReceiptRepository(goodsReceipts, from, to, config.identity!)
  }
  if (vendor && history && vendor.id !== history.id) {
    const from = history.identityNamespaces?.billHistoryVendorIds, to = vendor.identityNamespaces?.vendors
    if (!from || !to) throw new Error('Composite vendor/history sources must declare identity namespaces')
    if (!shared(from, to, config.identity) && !config.identity?.crosswalk?.mapVendorId) throw new Error('Composite vendor/history sources require a shared namespace or vendor ID crosswalk')
    if (!shared(from, to, config.identity) && billHistorySeed) {
      const seed = billHistorySeed
      billHistorySeed = async () => Promise.all((await seed()).map(async invoice => {
        const mapped = await config.identity!.crosswalk!.mapVendorId!({ id: invoice.vendorId, fromNamespace: from, toNamespace: to })
        if (!mapped) throw new ReferenceCrosswalkError('vendor', invoice.vendorId)
        return { ...invoice, vendorId: mapped }
      }))
    }
  }
  return assertProvider({
    id: config.id, displayName: config.displayName,
    capabilities: {
      vendors: Boolean(vendor?.vendors), vendorBankDetails: vendor?.capabilities.vendorBankDetails ?? false,
      vendorStatusRichness: vendor?.capabilities.vendorStatusRichness ?? 'none', purchaseOrders: Boolean(purchaseOrders),
      goodsReceipts: Boolean(goodsReceipts), sanctions: Boolean(sanctions?.sanctions), billHistory: Boolean(billHistorySeed),
      invoiceChannel: history?.capabilities.invoiceChannel ?? false, posting: false,
    },
    vendors: vendor?.vendors, purchaseOrders, goodsReceipts, sanctions: sanctions?.sanctions, billHistorySeed,
    sources: {
      ...(vendor && { vendors: sourceId(vendor, 'vendors') }), ...(po && { purchaseOrders: sourceId(po, 'purchaseOrders') }),
      ...(receipt && { goodsReceipts: sourceId(receipt, 'goodsReceipts') }), ...(sanctions && { sanctions: sourceId(sanctions, 'sanctions') }),
      ...(history && { billHistory: sourceId(history, 'billHistory') }),
    },
    identityNamespaces: { vendors: vendor?.identityNamespaces?.vendors, purchaseOrders: po?.identityNamespaces?.purchaseOrders, purchaseOrderVendorIds: vendor?.identityNamespaces?.vendors, goodsReceipts: po?.identityNamespaces?.purchaseOrders, billHistoryVendorIds: vendor?.identityNamespaces?.vendors },
  })
}
