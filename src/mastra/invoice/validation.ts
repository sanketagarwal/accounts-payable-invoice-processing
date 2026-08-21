import Decimal from "decimal.js";
import { ExtractedInvoiceSchema, type ExtractedInvoice, type InvoiceDraft } from "./schema.ts";

const isDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const blank = (value: string) => value.trim().length === 0;
const currencies = new Set([...Intl.supportedValuesOf("currency"), "XAD"]);
const currencyDigits = (currency: string) =>
  currencies.has(currency)
    ? (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2)
    : null;
const hasMinorUnitPrecision = (value: number, digits: number) =>
  new Decimal(value).decimalPlaces() <= digits;
// Unit prices may be sub-minor-unit rates; posted extended amounts must obey the currency scale.
const reconciles = (parts: Array<number | Decimal>, total: number, digits: number) => {
  const sum = parts.reduce<Decimal>((value, part) => value.plus(part), new Decimal(0)),
    expected = new Decimal(total);
  return sum
    .toDecimalPlaces(digits, Decimal.ROUND_HALF_UP)
    .equals(expected.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP));
};

export function validateExtraction(draft: InvoiceDraft): {
  extracted: ExtractedInvoice | null;
  issues: string[];
} {
  const parsed = ExtractedInvoiceSchema.safeParse({
    ...draft,
    vendorTaxId: draft.vendorTaxId ?? null,
  });
  if (!parsed.success)
    return {
      extracted: null,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "invoice"}: ${issue.message}`,
      ),
    };
  const invoice = parsed.data;
  const issues: string[] = [];
  for (const field of ["invoiceNumber", "vendorName", "invoiceDate", "currency"] as const)
    if (blank(invoice[field])) issues.push(`${field} is required`);
  if (!isDate(invoice.invoiceDate)) issues.push("invoiceDate must be yyyy-mm-dd");
  invoice.lines.forEach((line, index) => {
    if (blank(line.description)) issues.push(`lines.${index}.description is required`);
  });

  const digits = currencyDigits(invoice.currency);
  if (digits === null) {
    issues.push("currency must be a canonical uppercase ISO 4217 code");
    return { extracted: null, issues };
  }

  const lineAmounts: Array<number | Decimal> = invoice.lines.map(
    (line) => line.lineTotal ?? new Decimal(line.qty).mul(line.unitPrice),
  );
  const subtotalBasis =
    invoice.subtotal ??
    (lineAmounts.length
      ? lineAmounts.reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0))
      : null);

  for (const [field, value] of [
    ["subtotal", invoice.subtotal],
    ["tax", invoice.tax],
    ["total", invoice.total],
  ] as const)
    if (value !== null && !hasMinorUnitPrecision(value, digits))
      issues.push(`${field} exceeds ${invoice.currency} minor-unit precision`);

  if (subtotalBasis === null) issues.push("total cannot be reconciled from printed amounts");
  else if (!reconciles([subtotalBasis, invoice.tax ?? 0], invoice.total, digits))
    issues.push("subtotal + tax does not equal total");

  invoice.lines.forEach((line, index) => {
    if (line.lineTotal === null) return;
    if (!hasMinorUnitPrecision(line.lineTotal, digits))
      issues.push(`lines.${index}.lineTotal exceeds ${invoice.currency} minor-unit precision`);
    if (!reconciles([new Decimal(line.qty).mul(line.unitPrice)], line.lineTotal, digits))
      issues.push(`lines.${index} does not reconcile`);
  });
  if (
    invoice.subtotal !== null &&
    lineAmounts.length &&
    !reconciles(lineAmounts, invoice.subtotal, digits)
  )
    issues.push("line totals do not equal subtotal");

  return { extracted: issues.length ? null : invoice, issues };
}
