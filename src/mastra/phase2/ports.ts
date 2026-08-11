import type { GoodsReceipt, PolicyConfig, PriorInvoice, PurchaseOrder, SanctionsResult, VendorRecord } from './schemas.ts'

export type VendorLookup = { name: string; taxId?: string | null }
export interface VendorRepository { find(input: VendorLookup): Promise<VendorRecord[]> }
export interface PurchaseOrderRepository { findByNumber(poNumber: string): Promise<PurchaseOrder[]> }
export interface GoodsReceiptRepository { findByPurchaseOrderId(purchaseOrderId: string): Promise<GoodsReceipt[]> }
export interface InvoiceHistoryRepository {
  findPotentialDuplicates(input: { vendorId: string; invoiceNumber: string; totalMinor: number }): Promise<PriorInvoice[]>
  seed(invoices: PriorInvoice[]): Promise<void>
  save(invoice: PriorInvoice): Promise<void>
}
export interface SanctionsScreener { screen(vendor: VendorRecord): Promise<SanctionsResult> }
export interface PolicyProvider { getPolicy(): Promise<PolicyConfig> }
export interface VendorStatusRestrictionSource { getRestriction(input: { providerId: string; vendorId: string }): Promise<'on_hold' | 'blocked' | null> }
export interface ReferenceCrosswalk { mapPurchaseOrderId(input: { id: string; fromNamespace: string; toNamespace: string }): Promise<string | null> }

export class ProviderUnavailableError extends Error {
  readonly retryable = true
  constructor(readonly providerId: string, readonly operation: string, options?: { cause?: unknown }) {
    super(`${providerId} unavailable during ${operation}`, options); this.name = 'ProviderUnavailableError'
  }
}
