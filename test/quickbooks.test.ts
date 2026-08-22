import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeQuickBooksProvider,
  parseQuickBooksRecords,
  type McpToolClient,
} from "../src/mastra/accounting/quickbooks.ts";

const originalEnvironment = {
  QBO_MCP_ENABLE_POSTING: process.env.QBO_MCP_ENABLE_POSTING,
  QBO_MCP_EXPENSE_ACCOUNT_ID: process.env.QBO_MCP_EXPENSE_ACCOUNT_ID,
  QBO_MCP_POSTING_LOCK_DIR: process.env.QBO_MCP_POSTING_LOCK_DIR,
  QBO_MCP_SINGLE_WRITER: process.env.QBO_MCP_SINGLE_WRITER,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const response = (...texts: string[]) => ({
  content: texts.map((text) => ({ type: "text", text })),
});

describe("parseQuickBooksRecords", () => {
  it("accepts the summary labels emitted by Intuit search tools", () => {
    assert.deepEqual(
      parseQuickBooksRecords(
        response(
          "Found 1 purchase order(s):",
          JSON.stringify([{ Id: "42", DocNumber: "PO-1001" }]),
        ),
      ),
      [{ Id: "42", DocNumber: "PO-1001" }],
    );
    assert.deepEqual(
      parseQuickBooksRecords(
        response("Found 1 vendors:", JSON.stringify({ Id: "7", DisplayName: "Acme" })),
      ),
      [{ Id: "7", DisplayName: "Acme" }],
    );
  });

  it("rejects unexpected non-JSON output", () => {
    assert.throws(
      () => parseQuickBooksRecords(response("QuickBooks returned something unexpected")),
      /non-JSON output/,
    );
  });
});

describe("QuickBooks provider", () => {
  it("maps the official MCP search response shapes", async () => {
    process.env.QBO_MCP_ENABLE_POSTING = "false";
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const client: McpToolClient = {
      async listToolNames() {
        return new Set(["search_vendors", "search_purchase_orders", "search_bills"]);
      },
      async call(toolName, input) {
        calls.push({ toolName, input });
        if (toolName === "search_vendors")
          return response(
            "Found 1 vendors:",
            JSON.stringify({
              Id: "vendor-1",
              DisplayName: "Acme Supplies",
              Active: true,
            }),
          );
        if (toolName === "search_purchase_orders")
          return response(
            "Found 1 purchase order(s):",
            JSON.stringify([
              {
                Id: "po-1",
                DocNumber: "PO-1001",
                VendorRef: { value: "vendor-1" },
                CurrencyRef: { value: "USD" },
                TotalAmt: 108,
                Line: [
                  {
                    Amount: 100,
                    ItemBasedExpenseLineDetail: {
                      ItemRef: { value: "item-1", name: "PEN-01" },
                      Qty: 10,
                      UnitPrice: 10,
                    },
                  },
                ],
              },
            ]),
          );
        return response(
          "Found 1 bills:",
          JSON.stringify({
            Id: "bill-1",
            DocNumber: "ACME-0999",
            VendorRef: { value: "vendor-1" },
            CurrencyRef: { value: "USD" },
            TotalAmt: 108,
            TxnDate: "2026-07-01",
          }),
        );
      },
    };
    const provider = makeQuickBooksProvider(client);

    assert.deepEqual(await provider.findVendors({ name: "Acme Supplies" }), [
      {
        id: "vendor-1",
        name: "Acme Supplies",
        taxId: null,
        status: "approved",
      },
    ]);
    assert.equal((await provider.findPurchaseOrders("PO-1001"))[0]?.totalMinor, 10_800);
    assert.equal((await provider.listBills?.())?.[0]?.invoiceNumber, "ACME-0999");
    assert.deepEqual(calls[0], {
      toolName: "search_vendors",
      input: {
        params: {
          criteria: [{ field: "DisplayName", value: "Acme Supplies", operator: "=" }],
          fetchAll: true,
        },
      },
    });
  });

  it("posts an approved, reconciled bill", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "qbo-posting-test-"));
    process.env.QBO_MCP_ENABLE_POSTING = "true";
    process.env.QBO_MCP_EXPENSE_ACCOUNT_ID = "expense-1";
    process.env.QBO_MCP_POSTING_LOCK_DIR = lockDirectory;
    process.env.QBO_MCP_SINGLE_WRITER = "true";
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const client: McpToolClient = {
      async listToolNames() {
        return new Set(["search_vendors", "search_purchase_orders", "search_bills", "create-bill"]);
      },
      async call(toolName, input) {
        calls.push({ toolName, input });
        return toolName === "create-bill" ? response(JSON.stringify({ Id: "bill-2" })) : response("Count: 0");
      },
    };
    const digest = "1".repeat(64);
    const provider = makeQuickBooksProvider(client);
    try {
      const receipt = await provider.postBill?.({
        idempotencyKey: `ap-${digest}`,
        invoice: {
          document: { id: "invoice", mimeType: "image/jpeg", source: "image" },
          invoiceNumber: "ACME-1001",
          vendorName: "Acme Supplies",
          vendorTaxId: null,
          poNumber: null,
          invoiceDate: "2026-08-01",
          currency: "USD",
          subtotalMinor: 10_000,
          taxMinor: 0,
          totalMinor: 10_000,
          lines: [{ sku: null, description: "Pens", qty: 10, unitPriceMinor: 1_000, lineTotalMinor: 10_000 }],
          confidence: [],
          overallConfidence: 1,
        },
        vendor: { id: "vendor-1", name: "Acme Supplies", taxId: null, status: "approved" },
        purchaseOrder: null,
        approval: {
          status: "not_required",
          reviewerId: null,
          decidedAt: new Date().toISOString(),
          invoiceDigest: digest,
          comment: null,
        },
      });
      assert.equal(receipt?.externalBillId, "bill-2");
      assert.deepEqual(calls.map(({ toolName }) => toolName), ["search_bills", "create-bill"]);
      assert.equal(
        (calls[1]?.input as { params: { bill: { TotalAmt: number } } }).params.bill.TotalAmt,
        100,
      );
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });
});
