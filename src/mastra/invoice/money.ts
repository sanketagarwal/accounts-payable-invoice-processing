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
  const x: ExtractedInvoice = output.extractedResult,
    money = (value: number | null) => (value === null ? null : toMinorUnits(value, x.currency));
  return NormalizedInvoiceSchema.parse({
    document: output.rawDocumentRef,
    invoiceNumber: x.invoiceNumber,
    vendorName: x.vendorName,
    vendorTaxId: x.vendorTaxId,
    poNumber: x.poNumber,
    invoiceDate: x.invoiceDate,
    currency: x.currency,
    subtotalMinor: money(x.subtotal),
    taxMinor: money(x.tax),
    totalMinor: toMinorUnits(x.total, x.currency),
    lines: x.lines.map((line) => ({
      sku: line.sku,
      description: line.description,
      qty: line.qty,
      unitPriceMinor: toMinorUnits(line.unitPrice, x.currency),
      lineTotalMinor: money(line.lineTotal),
    })),
    confidence: x.confidence,
    overallConfidence: x.overallConfidence,
  });
}
