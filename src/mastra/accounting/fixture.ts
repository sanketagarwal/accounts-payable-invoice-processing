import {
  type GoodsReceipt,
  type PolicyConfig,
  type PostingReceipt,
  type PriorInvoice,
  type PurchaseOrder,
  type VendorRecord,
} from "../invoice/schema.ts";
import type { AccountingProvider, SanctionsScreener } from "./types.ts";

export const fixtureDb: {
  vendors: VendorRecord[];
  purchaseOrders: PurchaseOrder[];
  receipts: GoodsReceipt[];
  priorInvoices: PriorInvoice[];
  policy: PolicyConfig;
} = {
  vendors: [
    {
      id: "vendor_acme",
      name: "Acme Supplies",
      taxId: "US-12-3456789",
      status: "approved",
    },
    {
      id: "vendor_northwind",
      name: "Northwind Trading",
      taxId: null,
      status: "approved",
    },
  ],
  purchaseOrders: [
    {
      id: "po_1001",
      poNumber: "PO-1001",
      vendorId: "vendor_acme",
      currency: "USD",
      totalMinor: 10_800,
      lines: [
        {
          sku: "PEN-01",
          qty: 10,
          unitPriceMinor: 1_000,
          lineTotalMinor: 10_000,
        },
      ],
    },
    {
      id: "po_2002",
      poNumber: "PO-2002",
      vendorId: "vendor_northwind",
      currency: "EUR",
      totalMinor: 6_000,
      lines: [{ sku: null, qty: 1, unitPriceMinor: 5_000, lineTotalMinor: 5_000 }],
    },
  ],
  receipts: [
    {
      id: "receipt_1001",
      purchaseOrderId: "po_1001",
      lines: [{ sku: "PEN-01", qty: 10 }],
    },
    {
      id: "receipt_2002",
      purchaseOrderId: "po_2002",
      lines: [{ sku: null, qty: 1 }],
    },
  ],
  priorInvoices: [
    {
      id: "prior_1",
      vendorId: "vendor_acme",
      invoiceNumber: "ACME-0999",
      invoiceDate: "2026-07-01",
      currency: "USD",
      totalMinor: 10_800,
    },
  ],
  policy: { approvalThresholdMinor: 100_000, amountToleranceMinor: 1, lowConfidenceThreshold: 0.8 },
};

const normalize = (value: string) => value.trim().toLowerCase();
const postedBills = new Map<string, PostingReceipt>();

export const screenFixtureVendor: SanctionsScreener = async (vendor) => ({
  matched: normalize(vendor.name).includes("sanctioned"),
  list: null,
  reference: null,
});

export const fixtureProvider: AccountingProvider = {
  id: "fixture",

  async findVendors(input) {
    return fixtureDb.vendors.filter(
      (vendor) =>
        normalize(vendor.name) === normalize(input.name) ||
        Boolean(input.taxId && vendor.taxId === input.taxId),
    );
  },

  async findPurchaseOrders(poNumber) {
    return fixtureDb.purchaseOrders.filter((order) => order.poNumber === poNumber);
  },

  async findReceipts(purchaseOrderId) {
    return fixtureDb.receipts.filter((receipt) => receipt.purchaseOrderId === purchaseOrderId);
  },

  async listBills() {
    return structuredClone(fixtureDb.priorInvoices);
  },

  screenVendor: screenFixtureVendor,

  async postBill(request) {
    const existing = postedBills.get(request.idempotencyKey);
    if (existing) return { ...existing, status: "already_posted" };

    const receipt: PostingReceipt = {
      status: "posted",
      providerId: "fixture",
      externalBillId: `fixture-${request.idempotencyKey.slice(0, 16)}`,
      postedAt: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
    };
    postedBills.set(request.idempotencyKey, receipt);
    return receipt;
  },
};
