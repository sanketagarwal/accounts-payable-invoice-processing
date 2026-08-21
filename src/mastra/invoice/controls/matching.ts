import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { ProviderUnavailableError } from "../../accounting/types.ts";
import type { AssessmentState, PurchaseOrder, StepDecision } from "../schema.ts";
import { hasLowConfidence } from "../validation.ts";
import { decide } from "./decision.ts";

const reviewType = (mismatches: string[]) => {
  const has = (suffix: string) => mismatches.some((value) => value.endsWith(suffix));
  if (has(".unitPrice")) return "review_price_variance";
  if (has(".qty")) return "review_quantity_variance";
  if (has(".missing") || has(".lineTotal") || mismatches.includes("lines.uninvoicedPoLines"))
    return "review_line_item_variance";
  return mismatches.includes("currency") ? "review_currency_mismatch" : "po_mismatch";
};

const varianceReasons = (mismatches: string[]): StepDecision["reasons"] => {
  const details = [
    [
      "PRICE_VARIANCE",
      "Invoice unit prices exceed the PO tolerance",
      (value: string) => value.endsWith(".unitPrice"),
    ],
    [
      "QUANTITY_VARIANCE",
      "Invoice quantities differ from the PO",
      (value: string) => value.endsWith(".qty"),
    ],
    [
      "LINE_ITEM_VARIANCE",
      "Invoice and PO line items differ",
      (value: string) =>
        value.endsWith(".missing") ||
        value.endsWith(".lineTotal") ||
        value === "lines.uninvoicedPoLines",
    ],
    [
      "TOTAL_VARIANCE",
      "Invoice total differs from the PO beyond tolerance",
      (value: string) => value === "total",
    ],
    [
      "CURRENCY_MISMATCH",
      "Invoice and PO currencies differ",
      (value: string) => value === "currency",
    ],
    [
      "PO_VENDOR_MISMATCH",
      "Purchase order belongs to a different vendor",
      (value: string) => value === "vendor",
    ],
  ] as const;

  return [
    {
      code: "PO_MISMATCH",
      message: "Invoice does not match the purchase order",
      evidence: { mismatches },
    },
    ...details.flatMap(([code, message, matches]) => {
      const evidence = mismatches.filter(matches);
      return evidence.length ? [{ code, message, evidence: { mismatches: evidence } }] : [];
    }),
  ];
};

const compareLines = (state: AssessmentState, order: PurchaseOrder, tolerance: number) => {
  const unusedOrderLines = new Set(order.lines.map((_, index) => index));
  const mismatches: string[] = [];

  state.invoice.lines.forEach((line, invoiceIndex) => {
    const orderIndex = line.sku
      ? order.lines.findIndex(
          (candidate, index) => unusedOrderLines.has(index) && candidate.sku === line.sku,
        )
      : unusedOrderLines.has(invoiceIndex)
        ? invoiceIndex
        : -1;
    if (orderIndex < 0) return void mismatches.push(`lines.${invoiceIndex}.missing`);

    unusedOrderLines.delete(orderIndex);
    const expected = order.lines[orderIndex]!;
    if (line.qty !== expected.qty) mismatches.push(`lines.${invoiceIndex}.qty`);
    if (Math.abs(line.unitPriceMinor - expected.unitPriceMinor) > tolerance)
      mismatches.push(`lines.${invoiceIndex}.unitPrice`);
    if (
      line.lineTotalMinor !== null &&
      Math.abs(line.lineTotalMinor - expected.lineTotalMinor) > tolerance
    )
      mismatches.push(`lines.${invoiceIndex}.lineTotal`);
  });

  if (unusedOrderLines.size) mismatches.push("lines.uninvoicedPoLines");
  return mismatches;
};

export function makeInvoiceMatch(runtime: InvoiceRuntime) {
  const provider = runtime.provider;
  const purchaseOrderSource = { purchaseOrders: provider.id };

  return async (state: AssessmentState) => {
    if (!state.vendor || state.decisions.some(({ outcome }) => outcome !== "pass")) return state;
    const adaptations: StepDecision["adaptations"] = [];

    try {
      if (!state.invoice.poNumber)
        return decide(state, {
          step: "match",
          outcome: "review",
          reviewType: "missing_po",
          reasons: [{ code: "PO_NUMBER_MISSING", message: "Invoice has no printed PO number" }],
        });

      const orders = await provider.findPurchaseOrders(state.invoice.poNumber);
      if (orders.length !== 1) {
        const ambiguous = orders.length > 1;
        return decide(state, {
          step: "match",
          outcome: "review",
          reviewType: ambiguous ? "ambiguous_po" : "po_not_found",
          reasons: [
            {
              code: ambiguous ? "PO_AMBIGUOUS" : "PO_NOT_FOUND",
              message: ambiguous
                ? "Multiple purchase orders match"
                : "Purchase order was not found",
            },
          ],
          sources: purchaseOrderSource,
        });
      }

      const order = orders[0]!;
      state.purchaseOrder = order;
      const mismatches = [
        ...(order.vendorId === state.vendor.id ? [] : ["vendor"]),
        ...(order.currency === state.invoice.currency ? [] : ["currency"]),
        ...(Math.abs(order.totalMinor - state.invoice.totalMinor) <=
        runtime.policy.amountToleranceMinor
          ? []
          : ["total"]),
        ...compareLines(state, order, runtime.policy.amountToleranceMinor),
      ];
      if (mismatches.length) {
        const verify = hasLowConfidence(
          state.invoice,
          ["vendorName", "poNumber", "currency", "total", "lines"],
          runtime.policy.lowConfidenceThreshold,
        );
        return decide(state, {
          step: "match",
          outcome: verify ? "verify_extraction" : "review",
          reviewType: verify ? null : reviewType(mismatches),
          reasons: varianceReasons(mismatches),
          sources: purchaseOrderSource,
        });
      }

      if (!provider.findReceipts) {
        state.matchMode = "two_way";
        adaptations.push({ code: "GOODS_RECEIPTS_UNAVAILABLE", providerId: provider.id });
        return decide(state, {
          step: "match",
          outcome: "pass",
          reasons: [
            {
              code: "TWO_WAY_MATCH",
              message: "Invoice and purchase order match; receipts are unavailable",
              evidence: { matchMode: "two_way" },
            },
          ],
          adaptations,
          sources: purchaseOrderSource,
        });
      }

      state.matchMode = "three_way";
      state.receipts = await provider.findReceipts(order.id);
      const invoiceLinesWithoutSku = state.invoice.lines.filter(({ sku }) => !sku).length;
      const receiptLinesWithoutSku = state.receipts
        .flatMap(({ lines }) => lines)
        .filter(({ sku }) => !sku).length;
      const sources = { ...purchaseOrderSource, goodsReceipts: provider.id };
      if (invoiceLinesWithoutSku > 1 || receiptLinesWithoutSku > 1)
        return decide(state, {
          step: "match",
          outcome: "review",
          reviewType: "receipt_mismatch",
          reasons: [
            {
              code: "RECEIPT_LINE_IDENTITY_AMBIGUOUS",
              message: "Multiple lines without SKUs cannot be matched safely by position",
              evidence: { invoiceLinesWithoutSku, receiptLinesWithoutSku },
            },
          ],
          sources,
        });

      const received = new Map<string, number>();
      for (const receipt of state.receipts)
        receipt.lines.forEach((line, index) => {
          const key = line.sku ?? `line:${index}`;
          received.set(key, (received.get(key) ?? 0) + line.qty);
        });
      const receiptMismatch =
        !state.receipts.length ||
        state.invoice.lines.some(
          (line, index) => (received.get(line.sku ?? `line:${index}`) ?? 0) < line.qty,
        );
      const verify =
        receiptMismatch &&
        hasLowConfidence(state.invoice, ["lines", "qty"], runtime.policy.lowConfidenceThreshold);
      return decide(state, {
        step: "match",
        outcome: receiptMismatch ? (verify ? "verify_extraction" : "review") : "pass",
        reviewType: receiptMismatch && !verify ? "receipt_mismatch" : null,
        reasons: [
          {
            code: receiptMismatch ? "RECEIPT_MISMATCH" : "THREE_WAY_MATCH",
            message: receiptMismatch
              ? "Received quantities do not cover invoiced quantities"
              : "Invoice, purchase order, and receipts match",
            evidence: { receiptIds: state.receipts.map(({ id }) => id) },
          },
        ],
        sources,
      });
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      return decide(state, {
        step: "match",
        outcome: "unknown_retry",
        reasons: [{ code: "MATCH_LOOKUP_UNAVAILABLE", message: error.message }],
        adaptations,
        sources: { purchaseOrders: provider.id, goodsReceipts: provider.id },
      });
    }
  };
}
