import Decimal from "decimal.js";
import type { ExtractedInvoice } from "./schema.ts";
import {
  NormalizedInvoiceSchema,
  type InvoiceWorkflowInput,
  type NormalizedInvoice,
} from "./schema.ts";

const exponent = (currency: string) =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
export function toMinorUnits(value: number, currency: string): number {
  const result = new Decimal(value.toString())
    .mul(new Decimal(10).pow(exponent(currency)))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(result))
    throw new Error(`Unsafe ${currency} minor-unit value: ${value}`);
  return result;
}
export function toMajorUnits(value: number, currency: string): number {
  if (!Number.isSafeInteger(value))
    throw new Error(`Unsafe ${currency} minor-unit value: ${value}`);
  return new Decimal(value).div(new Decimal(10).pow(exponent(currency))).toNumber();
}
export function normalizeInvoice(output: InvoiceWorkflowInput): NormalizedInvoice {
  const invoice: ExtractedInvoice = output.extractedResult;
  const money = (value: number | null) =>
    value === null ? null : toMinorUnits(value, invoice.currency);
  return NormalizedInvoiceSchema.parse({
    document: output.rawDocumentRef,
    invoiceNumber: invoice.invoiceNumber,
    vendorName: invoice.vendorName,
    vendorTaxId: invoice.vendorTaxId,
    poNumber: invoice.poNumber,
    invoiceDate: invoice.invoiceDate,
    currency: invoice.currency,
    subtotalMinor: money(invoice.subtotal),
    taxMinor: money(invoice.tax),
    totalMinor: toMinorUnits(invoice.total, invoice.currency),
    lines: invoice.lines.map((line) => ({
      sku: line.sku,
      description: line.description,
      qty: line.qty,
      unitPriceMinor: toMinorUnits(line.unitPrice, invoice.currency),
      lineTotalMinor: money(line.lineTotal),
    })),
    confidence: invoice.confidence,
    overallConfidence: invoice.overallConfidence,
  });
}
