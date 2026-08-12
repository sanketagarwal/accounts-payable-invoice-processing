import Decimal from 'decimal.js'
import { code as currencyCode } from 'currency-codes'
import { ExtractedInvoiceSchema, type ExtractedInvoice, type InvoiceDraft } from '../schemas/invoice.ts'

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const blank = (value: string) => value.trim().length === 0
const noMinorUnit = new Set(['XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XDR', 'XPD', 'XPT', 'XSU', 'XTS', 'XUA', 'XXX'])
const hasMinorUnitPrecision = (value: number, digits: number) => new Decimal(value).decimalPlaces() <= digits
// Unit prices may be sub-minor-unit rates; posted extended amounts must obey the currency scale.
const reconciles = (parts: Array<number | Decimal>, total: number, digits: number | null) => {
  const sum = parts.reduce<Decimal>((value, part) => value.plus(part), new Decimal(0)), expected = new Decimal(total)
  return digits === null ? sum.equals(expected) : sum.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).equals(expected.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP))
}

export function validateExtraction(draft: InvoiceDraft): { extracted: ExtractedInvoice | null; issues: string[] } {
  const parsed = ExtractedInvoiceSchema.safeParse(draft)
  if (!parsed.success) return { extracted: null, issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'invoice'}: ${issue.message}`) }
  const invoice = parsed.data, currency = currencyCode(invoice.currency), validCurrency = currency?.code === invoice.currency
  const currencyDigits = validCurrency && !noMinorUnit.has(invoice.currency) ? currency.digits : null
  const lineAmounts: Array<number | Decimal> = invoice.lines.map(line => line.lineTotal ?? new Decimal(line.qty).mul(line.unitPrice))
  const subtotalBasis = invoice.subtotal ?? (lineAmounts.length ? lineAmounts.reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0)) : null)
  const issues = [
    ...(['invoiceNumber', 'vendorName', 'invoiceDate', 'currency'] as const).filter(field => blank(invoice[field])).map(field => `${field} is required`),
    ...(isDate(invoice.invoiceDate) ? [] : ['invoiceDate must be yyyy-mm-dd']),
    ...(validCurrency ? [] : ['currency must be a canonical uppercase ISO 4217 code']),
    ...(currencyDigits !== null ? ([['subtotal', invoice.subtotal], ['tax', invoice.tax], ['total', invoice.total]] as const).flatMap(([field, value]) => value !== null && !hasMinorUnitPrecision(value, currencyDigits) ? [`${field} exceeds ${invoice.currency} minor-unit precision`] : []) : []),
    ...(validCurrency && subtotalBasis === null ? ['total cannot be reconciled from printed amounts'] : []),
    ...(validCurrency && subtotalBasis !== null && !reconciles([subtotalBasis, invoice.tax ?? 0], invoice.total, currencyDigits) ? ['subtotal + tax does not equal total'] : []),
    ...invoice.lines.flatMap((line, index) => [
      ...(blank(line.description) ? [`lines.${index}.description is required`] : []),
      ...(currencyDigits !== null && line.lineTotal !== null && !hasMinorUnitPrecision(line.lineTotal, currencyDigits) ? [`lines.${index}.lineTotal exceeds ${invoice.currency} minor-unit precision`] : []),
      ...(validCurrency && line.lineTotal !== null && !reconciles([new Decimal(line.qty).mul(line.unitPrice)], line.lineTotal, currencyDigits) ? [`lines.${index} does not reconcile`] : []),
    ]),
    ...(validCurrency && invoice.subtotal !== null && lineAmounts.length && !reconciles(lineAmounts, invoice.subtotal, currencyDigits) ? ['line totals do not equal subtotal'] : []),
  ]
  return { extracted: issues.length ? null : invoice, issues }
}
