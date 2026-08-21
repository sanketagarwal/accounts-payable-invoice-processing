import type {
  GoodsReceipt,
  PolicyConfig,
  PostingReceipt,
  PostingRequest,
  PriorInvoice,
  PurchaseOrder,
  SanctionsResult,
  VendorRecord,
} from "../invoice/schema.ts";

export type VendorLookup = { name: string; taxId?: string | null };
export interface VendorRepository {
  find(input: VendorLookup): Promise<VendorRecord[]>;
}
export interface PurchaseOrderRepository {
  findByNumber(poNumber: string): Promise<PurchaseOrder[]>;
}
export interface GoodsReceiptRepository {
  findByPurchaseOrderId(purchaseOrderId: string): Promise<GoodsReceipt[]>;
}
export interface InvoiceHistoryRepository {
  findPotentialDuplicates(input: {
    vendorId: string;
    invoiceNumber: string;
    currency: string;
    totalMinor: number;
  }): Promise<PriorInvoice[]>;
  seed(invoices: PriorInvoice[]): Promise<void>;
  save(invoice: PriorInvoice): Promise<void>;
}
export interface SanctionsScreener {
  screen(vendor: VendorRecord): Promise<SanctionsResult>;
}
export interface PolicyProvider {
  getPolicy(): Promise<PolicyConfig>;
}
export interface VendorStatusRestrictionSource {
  getRestriction(input: {
    providerId: string;
    vendorId: string;
  }): Promise<"on_hold" | "blocked" | null>;
}
export interface PostingAdapter {
  postBill(input: PostingRequest): Promise<PostingReceipt>;
}

export class ProviderUnavailableError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly providerId: string,
    readonly operation: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(`${providerId} unavailable during ${operation}`, options);
    this.name = "ProviderUnavailableError";
    this.retryable = options?.retryable ?? true;
  }
}
export class PostingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostingConflictError";
  }
}

export const booleanCapabilities = [
  "vendors",
  "vendorBankDetails",
  "purchaseOrders",
  "goodsReceipts",
  "billHistory",
  "sanctions",
  "invoiceChannel",
  "posting",
] as const;
export type BooleanCapability = (typeof booleanCapabilities)[number];
export interface ProviderCapabilities {
  vendors: boolean;
  vendorBankDetails: boolean;
  vendorStatusRichness: "none" | "binary" | "full";
  purchaseOrders: boolean;
  goodsReceipts: boolean;
  billHistory: boolean;
  sanctions: boolean;
  invoiceChannel: boolean;
  posting: boolean;
}
export type ProviderPort =
  | "vendors"
  | "purchaseOrders"
  | "goodsReceipts"
  | "sanctions"
  | "billHistory"
  | "posting";
export interface AccountingProvider {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  vendors?: VendorRepository;
  purchaseOrders?: PurchaseOrderRepository;
  goodsReceipts?: GoodsReceiptRepository;
  sanctions?: SanctionsScreener;
  billHistorySeed?: () => Promise<PriorInvoice[]>;
  posting?: PostingAdapter;
  sources?: Partial<Record<ProviderPort, string>>;
  identityNamespaces?: {
    vendors?: string;
    purchaseOrders?: string;
    purchaseOrderVendorIds?: string;
    goodsReceipts?: string;
    billHistoryVendorIds?: string;
    postingVendorIds?: string;
    postingPurchaseOrders?: string;
  };
}
export interface CapabilityPolicy {
  required: BooleanCapability[];
  degradable: BooleanCapability[];
  optional: BooleanCapability[];
}
export const defaultCapabilityPolicy: CapabilityPolicy = {
  required: ["vendors", "purchaseOrders", "sanctions"],
  degradable: ["goodsReceipts", "vendorBankDetails"],
  optional: ["billHistory", "invoiceChannel", "posting"],
};
export function assertProvider(provider: AccountingProvider): AccountingProvider {
  const pairs: Array<[BooleanCapability, unknown]> = [
    ["vendors", provider.vendors],
    ["purchaseOrders", provider.purchaseOrders],
    ["goodsReceipts", provider.goodsReceipts],
    ["sanctions", provider.sanctions],
    ["billHistory", provider.billHistorySeed],
    ["posting", provider.posting],
  ];
  for (const [capability, port] of pairs)
    if (provider.capabilities[capability] !== Boolean(port))
      throw new Error(`Provider ${provider.id}: ${capability} capability/port mismatch`);
  if (
    !provider.capabilities.vendors &&
    (provider.capabilities.vendorBankDetails ||
      provider.capabilities.vendorStatusRichness !== "none")
  )
    throw new Error(`Provider ${provider.id}: vendor sub-capabilities require vendors`);
  if (provider.capabilities.vendors && provider.capabilities.vendorStatusRichness === "none")
    throw new Error(`Provider ${provider.id}: vendorStatusRichness cannot be none`);
  if (provider.capabilities.invoiceChannel && !provider.capabilities.billHistory)
    throw new Error(`Provider ${provider.id}: invoiceChannel requires billHistory`);
  return provider;
}
export function assertCapabilityPolicy(policy: CapabilityPolicy) {
  const classified = [...policy.required, ...policy.degradable, ...policy.optional];
  if (
    new Set(classified).size !== classified.length ||
    booleanCapabilities.some((capability) => !classified.includes(capability))
  )
    throw new Error("Capability policy must classify every boolean capability exactly once");
}
export const sourceId = (provider: AccountingProvider, port: ProviderPort) =>
  provider.sources?.[port] ?? provider.id;
