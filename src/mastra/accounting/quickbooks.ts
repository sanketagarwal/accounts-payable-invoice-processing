import { z } from "zod";
import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createObservabilityContext } from "@mastra/core/observability";
import { RequestContext } from "@mastra/core/request-context";
import { noopObserve } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import {
  assertProvider,
  PostingConflictError,
  ProviderUnavailableError,
  type AccountingProvider,
  type PostingAdapter,
  type PurchaseOrderRepository,
  type VendorLookup,
  type VendorRepository,
} from "./types.ts";
import {
  PostingReceiptSchema,
  PostingRequestSchema,
  PriorInvoiceSchema,
  PurchaseOrderSchema,
  VendorRecordSchema,
  type PostingRequest,
} from "../invoice/schema.ts";
import { toMajorUnits, toMinorUnits } from "../invoice/money.ts";
export interface McpToolClient {
  listToolNames(): Promise<Set<string>>;
  call(toolName: string, input: unknown): Promise<unknown>;
  disconnect(): Promise<void>;
}

export class MastraMcpToolClient implements McpToolClient {
  constructor(
    private readonly client: MCPClient,
    private readonly serverName: string,
    private readonly allowedTools: ReadonlySet<string>,
  ) {}
  private getTools() {
    return this.client.listTools();
  }
  async listToolNames() {
    const prefix = `${this.serverName}_`;
    return new Set(
      Object.keys(await this.getTools()).map((name) =>
        name.startsWith(prefix) ? name.slice(prefix.length) : name,
      ),
    );
  }
  async call(toolName: string, input: unknown) {
    if (!this.allowedTools.has(toolName)) throw new Error(`MCP tool not allowed: ${toolName}`);
    const tool = (await this.getTools())[`${this.serverName}_${toolName}`];
    if (!tool?.execute) throw new Error(`MCP tool unavailable: ${toolName}`);
    return tool.execute(input, {
      ...createObservabilityContext(),
      observe: noopObserve,
      requestContext: new RequestContext(),
    });
  }
  disconnect() {
    return this.client.disconnect();
  }
}

const requiredPath = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value || !isAbsolute(value) || !existsSync(value) || !statSync(value).isFile())
    throw new Error(`${name} must be an existing absolute file path`);
  return value;
};

export function createQuickBooksMcpToolClient(
  options: { enablePosting?: boolean } = {},
): McpToolClient {
  const serverPath = requiredPath("QBO_MCP_SERVER_PATH"),
    tokenStorePath = requiredPath("QBO_MCP_TOKEN_STORE_PATH");
  const allowedTools = new Set([
    "search_vendors",
    "search_purchase_orders",
    "search_bills",
    ...(options.enablePosting ? ["create-bill"] : []),
  ]);
  const client = new MCPClient({
    id: "quickbooks-accounting",
    timeout: 30_000,
    servers: {
      quickbooks: {
        command: process.execPath,
        args: [serverPath],
        env: {
          QUICKBOOKS_TOKEN_STORE_PATH: tokenStorePath,
          QUICKBOOKS_DISABLE_WRITE: options.enablePosting ? "false" : "true",
          QUICKBOOKS_DISABLE_UPDATE: "true",
          QUICKBOOKS_DISABLE_DELETE: "true",
        },
      },
    },
  });
  return new MastraMcpToolClient(client, "quickbooks", allowedTools);
}

type QuickBooksReference = { value?: string; name?: string };
type QuickBooksLine = {
  Amount?: number;
  Description?: string;
  ItemBasedExpenseLineDetail?: {
    ItemRef?: QuickBooksReference;
    Qty?: number;
    UnitPrice?: number;
  };
};
type QuickBooksVendor = {
  Id?: string;
  DisplayName?: string;
  Active?: boolean;
  TaxIdentifier?: string;
};
type QuickBooksPurchaseOrder = {
  Id?: string;
  DocNumber?: string;
  VendorRef?: QuickBooksReference;
  CurrencyRef?: QuickBooksReference;
  TotalAmt?: number;
  Line?: QuickBooksLine[];
};
type QuickBooksBill = {
  Id?: string;
  DocNumber?: string;
  VendorRef?: QuickBooksReference;
  CurrencyRef?: QuickBooksReference;
  TotalAmt?: number;
  TxnDate?: string;
};

const required = (value: string | undefined, field: string) => {
  if (!value) throw new Error(`QuickBooks ${field} missing`);
  return value;
};

const mapVendor = (vendor: QuickBooksVendor) =>
  VendorRecordSchema.parse({
    id: required(vendor.Id, "Vendor.Id"),
    name: required(vendor.DisplayName, "Vendor.DisplayName"),
    taxId: vendor.TaxIdentifier ?? null,
    status: vendor.Active === false ? "inactive" : "approved",
    bankDetailsFingerprint: null,
  });

const mapPurchaseOrder = (order: QuickBooksPurchaseOrder) => {
  const currency = order.CurrencyRef?.value ?? "USD";

  return PurchaseOrderSchema.parse({
    id: required(order.Id, "PurchaseOrder.Id"),
    poNumber: required(order.DocNumber, "PurchaseOrder.DocNumber"),
    vendorId: required(order.VendorRef?.value, "PurchaseOrder.VendorRef"),
    currency,
    totalMinor: toMinorUnits(order.TotalAmt ?? 0, currency),
    lines: (order.Line ?? [])
      .filter((line) => line.ItemBasedExpenseLineDetail)
      .map((line) => {
        const detail = line.ItemBasedExpenseLineDetail!;
        const quantity = detail.Qty ?? 0;
        const amount = line.Amount ?? 0;

        return {
          // Match the human-readable item name printed on an invoice. QBO's
          // internal ItemRef ID is still available to the connector when posting.
          sku: detail.ItemRef?.name ?? detail.ItemRef?.value ?? null,
          description: line.Description ?? detail.ItemRef?.name ?? "",
          qty: quantity,
          unitPriceMinor: toMinorUnits(
            detail.UnitPrice ?? (quantity ? amount / quantity : 0),
            currency,
          ),
          lineTotalMinor: toMinorUnits(amount, currency),
        };
      }),
  });
};

const mapBill = (bill: QuickBooksBill) => {
  const currency = bill.CurrencyRef?.value ?? "USD";

  return PriorInvoiceSchema.parse({
    id: required(bill.Id, "Bill.Id"),
    vendorId: required(bill.VendorRef?.value, "Bill.VendorRef"),
    invoiceNumber: bill.DocNumber?.trim() || null,
    invoiceDate: required(bill.TxnDate, "Bill.TxnDate"),
    currency,
    totalMinor: toMinorUnits(bill.TotalAmt ?? 0, currency),
    channel: null,
  });
};

const requiredTools = ["search_vendors", "search_purchase_orders", "search_bills"] as const;
const postingTool = "create-bill" as const;
const ToolResultSchema = z
  .object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  })
  .passthrough();
const records = (result: unknown) => {
  const parsed = ToolResultSchema.parse(result),
    texts = parsed.content.flatMap((item) =>
      item.type === "text" && item.text ? [item.text] : [],
    );
  if (parsed.isError) throw new Error(texts.join("\n") || "MCP tool returned an error");
  return texts
    .flatMap((text) => {
      try {
        const value: unknown = JSON.parse(text);
        return Array.isArray(value) ? value : [value];
      } catch {
        if (/^Found \d+ records?:$/i.test(text.trim())) return [];
        throw new Error(`MCP tool returned non-JSON output: ${text}`);
      }
    })
    .filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
};

export interface QuickBooksMcpPostingConfig {
  expenseAccountId: string;
  taxAccountId?: string;
  apAccountId?: string;
  lockDirectory?: string;
}

export class QuickBooksMcpAdapter
  implements VendorRepository, PurchaseOrderRepository, PostingAdapter
{
  private verification?: Promise<void>;
  private readonly posting = new Map<
    string,
    Promise<ReturnType<typeof PostingReceiptSchema.parse>>
  >();
  constructor(
    private readonly client: McpToolClient,
    private readonly poLimit = 1000,
    private readonly postingConfig?: QuickBooksMcpPostingConfig,
  ) {
    if (!Number.isInteger(poLimit) || poLimit < 1 || poLimit > 1000)
      throw new Error("QuickBooks MCP PO limit must be an integer from 1 to 1000");
  }
  async verifyTools() {
    const tools = await this.client.listToolNames(),
      expected = [...requiredTools, ...(this.postingConfig ? [postingTool] : [])],
      missing = expected.filter((tool) => !tools.has(tool));
    const mutations = [...tools].filter((tool) =>
      this.postingConfig
        ? /^(update|delete)[_-]/.test(tool)
        : /^(create|update|delete)[_-]/.test(tool),
    );
    if (missing.length)
      throw new Error(`QuickBooks MCP is missing required tools: ${missing.join(", ")}`);
    if (mutations.length)
      throw new Error(
        `QuickBooks MCP provider refuses unsupported mutation tools: ${mutations.join(", ")}`,
      );
  }
  private async ensureVerified() {
    const verification = (this.verification ??= this.verifyTools());
    try {
      await verification;
    } catch (error) {
      if (this.verification === verification) this.verification = undefined;
      throw error;
    }
  }
  private async call(tool: (typeof requiredTools)[number] | typeof postingTool, params: unknown) {
    try {
      await this.ensureVerified();
      return records(await this.client.call(tool, { params }));
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError("quickbooks-mcp", tool, { cause: error });
    }
  }
  async find(input: VendorLookup) {
    const rows = await this.call("search_vendors", {
      criteria: [{ field: "DisplayName", value: input.name, operator: "=" }],
      fetchAll: true,
    });
    return rows.map((row) => mapVendor(row as QuickBooksVendor));
  }
  async findByNumber(poNumber: string) {
    const rows = await this.call("search_purchase_orders", { limit: this.poLimit }),
      matches = rows.filter((row) => row.DocNumber === poNumber);
    if (!matches.length && rows.length === this.poLimit)
      throw new ProviderUnavailableError(
        "quickbooks-mcp",
        "search_purchase_orders result window exhausted",
        {
          retryable: false,
        },
      );
    return matches.map((row) => mapPurchaseOrder(row as QuickBooksPurchaseOrder));
  }
  async billHistorySeed() {
    return (await this.call("search_bills", { fetchAll: true })).map((row) =>
      mapBill(row as QuickBooksBill),
    );
  }
  async postBill(input: PostingRequest) {
    if (!this.postingConfig) throw new Error("QuickBooks MCP posting is disabled");
    input = PostingRequestSchema.parse(input);
    const pending = this.posting.get(input.idempotencyKey) ?? this.withPostingLock(input);
    this.posting.set(input.idempotencyKey, pending);
    try {
      return await pending;
    } finally {
      if (this.posting.get(input.idempotencyKey) === pending)
        this.posting.delete(input.idempotencyKey);
    }
  }
  private async withPostingLock(input: PostingRequest) {
    const root = this.postingConfig?.lockDirectory ?? resolve("data/qbo-posting-locks");
    const conflictIdentity = input.invoice.invoiceNumber.trim().toLowerCase();
    const lock = resolve(root, createHash("sha256").update(conflictIdentity).digest("hex"));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 15_000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new ProviderUnavailableError(
            "quickbooks-mcp",
            "posting idempotency lock is held; reconcile the invoice before retrying",
          );
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
    try {
      return await this.post(input);
    } finally {
      await rmdir(lock).catch(() => undefined);
    }
  }
  private async post(input: PostingRequest) {
    const config = this.postingConfig;
    if (!config) throw new Error("QuickBooks MCP posting is disabled");
    if (input.invoice.invoiceNumber.length > 21)
      throw new PostingConflictError("QuickBooks bill DocNumber cannot exceed 21 characters");
    const marker = `AP workflow idempotency: ${input.idempotencyKey}`;
    const prior = await this.call("search_bills", {
      criteria: [{ field: "DocNumber", value: input.invoice.invoiceNumber, operator: "=" }],
      fetchAll: true,
    });
    const sameVendor = prior.filter(
      (row) => row.VendorRef && (row.VendorRef as { value?: string }).value === input.vendor.id,
    );
    if (sameVendor.length) {
      const exact = sameVendor.find(
        (row) =>
          row.PrivateNote === marker &&
          row.TxnDate === input.invoice.invoiceDate &&
          row.TotalAmt === toMajorUnits(input.invoice.totalMinor, input.invoice.currency) &&
          ((row.CurrencyRef as { value?: string } | undefined)?.value ?? input.invoice.currency) ===
            input.invoice.currency,
      );
      if (!exact?.Id)
        throw new PostingConflictError(
          `QuickBooks already has a conflicting bill numbered ${input.invoice.invoiceNumber}`,
        );
      return PostingReceiptSchema.parse({
        status: "already_posted",
        providerId: "quickbooks-mcp",
        externalBillId: exact.Id,
        postedAt: new Date().toISOString(),
        idempotencyKey: input.idempotencyKey,
      });
    }
    const tax = input.invoice.taxMinor ?? 0;
    if (tax && !config.taxAccountId)
      throw new PostingConflictError(
        "QBO_MCP_TAX_ACCOUNT_ID is required to post an invoice with tax",
      );
    if (
      input.invoice.subtotalMinor !== null &&
      input.invoice.subtotalMinor + tax !== input.invoice.totalMinor
    )
      throw new PostingConflictError(
        "Invoice subtotal and tax do not reconcile to the approved total",
      );
    const amounts = input.invoice.lines.map(
      (line) =>
        line.lineTotalMinor ??
        new Decimal(line.unitPriceMinor)
          .mul(line.qty)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toNumber(),
    );
    const expectedSubtotal = input.invoice.subtotalMinor ?? input.invoice.totalMinor - tax;
    if (amounts.reduce((sum, amount) => sum + amount, 0) !== expectedSubtotal)
      throw new PostingConflictError("Invoice lines do not reconcile to the posting subtotal");
    const line = input.invoice.lines.map((item, index) => ({
      Amount: toMajorUnits(amounts[index]!, input.invoice.currency),
      DetailType: "AccountBasedExpenseLineDetail",
      Description: item.description,
      AccountBasedExpenseLineDetail: { AccountRef: { value: config.expenseAccountId } },
    }));
    if (tax)
      line.push({
        Amount: toMajorUnits(tax, input.invoice.currency),
        DetailType: "AccountBasedExpenseLineDetail",
        Description: "Invoice tax",
        AccountBasedExpenseLineDetail: { AccountRef: { value: config.taxAccountId! } },
      });
    const bill = {
      VendorRef: { value: input.vendor.id },
      DocNumber: input.invoice.invoiceNumber,
      TxnDate: input.invoice.invoiceDate,
      CurrencyRef: { value: input.invoice.currency },
      TotalAmt: toMajorUnits(input.invoice.totalMinor, input.invoice.currency),
      Line: line,
      PrivateNote: marker,
      ...(config.apAccountId && { APAccountRef: { value: config.apAccountId } }),
      ...(input.purchaseOrder && {
        LinkedTxn: [{ TxnId: input.purchaseOrder.id, TxnType: "PurchaseOrder" }],
      }),
    };
    const created = (await this.call(postingTool, { bill }))[0];
    if (!created?.Id)
      throw new ProviderUnavailableError("quickbooks-mcp", "create-bill returned no Bill.Id", {
        retryable: false,
      });
    return PostingReceiptSchema.parse({
      status: "posted",
      providerId: "quickbooks-mcp",
      externalBillId: created.Id,
      postedAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    });
  }
  disconnect() {
    return this.client.disconnect();
  }
}

export function resolveQuickBooksMcpConfiguration(): {
  postingEnabled: boolean;
  postingConfig?: QuickBooksMcpPostingConfig;
} {
  const postingValue = process.env.QBO_MCP_ENABLE_POSTING?.trim().toLowerCase();
  if (postingValue && !["true", "false"].includes(postingValue))
    throw new Error("QBO_MCP_ENABLE_POSTING must be true or false");
  const postingEnabled = postingValue === "true",
    expenseAccountId = process.env.QBO_MCP_EXPENSE_ACCOUNT_ID?.trim();
  if (postingEnabled && !expenseAccountId)
    throw new Error(
      "QBO_MCP_EXPENSE_ACCOUNT_ID is required when QuickBooks MCP posting is enabled",
    );
  if (postingEnabled && process.env.QBO_MCP_SINGLE_WRITER?.trim().toLowerCase() !== "true")
    throw new Error(
      "QBO_MCP_SINGLE_WRITER=true is required when QuickBooks MCP posting is enabled",
    );
  return {
    postingEnabled,
    postingConfig: postingEnabled
      ? {
          expenseAccountId: expenseAccountId!,
          taxAccountId: process.env.QBO_MCP_TAX_ACCOUNT_ID?.trim(),
          apAccountId: process.env.QBO_MCP_AP_ACCOUNT_ID?.trim(),
          lockDirectory: process.env.QBO_MCP_POSTING_LOCK_DIR?.trim(),
        }
      : undefined,
  };
}

export function makeQuickBooksMcpProvider(client?: McpToolClient): AccountingProvider {
  const { postingEnabled, postingConfig } = resolveQuickBooksMcpConfiguration();
  const resolvedClient = client ?? createQuickBooksMcpToolClient({ enablePosting: postingEnabled });
  const adapter = new QuickBooksMcpAdapter(resolvedClient, 1000, postingConfig);
  return assertProvider({
    id: "quickbooks-mcp",
    displayName: "QuickBooks Online MCP",
    capabilities: {
      vendors: true,
      vendorBankDetails: false,
      vendorStatusRichness: "binary",
      purchaseOrders: true,
      goodsReceipts: false,
      billHistory: true,
      sanctions: false,
      invoiceChannel: false,
      posting: postingEnabled,
    },
    vendors: adapter,
    purchaseOrders: adapter,
    billHistorySeed: () => adapter.billHistorySeed(),
    posting: postingEnabled ? adapter : undefined,
    identityNamespaces: {
      vendors: "quickbooks",
      purchaseOrders: "quickbooks",
      purchaseOrderVendorIds: "quickbooks",
      billHistoryVendorIds: "quickbooks",
      postingVendorIds: "quickbooks",
      postingPurchaseOrders: "quickbooks",
    },
  });
}
