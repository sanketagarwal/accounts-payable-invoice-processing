import Decimal from 'decimal.js'
import { code as currencyCode } from 'currency-codes'
import { ExtractedInvoiceSchema, type ExtractedInvoice, type InvoiceDraft } from '../schemas/invoice.ts'

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const blank = (value: string) => value.trim().length === 0
const reconciles = (parts: Array<number | Decimal>, total: number, digits: number) => parts.reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0)).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).equals(new Decimal(total).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP))

export function validateExtraction(draft: InvoiceDraft): { extracted: ExtractedInvoice | null; issues: string[] } {
  const parsed = ExtractedInvoiceSchema.safeParse(draft)
  if (!parsed.success) return { extracted: null, issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'invoice'}: ${issue.message}`) }
  const invoice = parsed.data, currency = currencyCode(invoice.currency), validCurrency = Boolean(currency)
  const lineAmounts: Array<number | Decimal> = invoice.lines.map(line => line.lineTotal ?? new Decimal(line.qty).mul(line.unitPrice))
  const subtotalBasis = invoice.subtotal ?? (lineAmounts.length ? lineAmounts.reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0)) : null)
  const issues = [
    ...(['invoiceNumber', 'vendorName', 'invoiceDate', 'currency'] as const).filter(field => blank(invoice[field])).map(field => `${field} is required`),
    ...(isDate(invoice.invoiceDate) ? [] : ['invoiceDate must be yyyy-mm-dd']),
    ...(validCurrency ? [] : ['currency must be an ISO 4217 code']),
    ...(validCurrency && subtotalBasis === null ? ['total cannot be reconciled from printed amounts'] : []),
    ...(validCurrency && subtotalBasis !== null && !reconciles([subtotalBasis, invoice.tax ?? 0], invoice.total, currency!.digits) ? ['subtotal + tax does not equal total'] : []),
    ...invoice.lines.flatMap((line, index) => [
      ...(blank(line.description) ? [`lines.${index}.description is required`] : []),
      ...(validCurrency && line.lineTotal !== null && !reconciles([new Decimal(line.qty).mul(line.unitPrice)], line.lineTotal, currency!.digits) ? [`lines.${index} does not reconcile`] : []),
    ]),
    ...(validCurrency && invoice.subtotal !== null && lineAmounts.length && !reconciles(lineAmounts, invoice.subtotal, currency!.digits) ? ['line totals do not equal subtotal'] : []),
  ]
  return { extracted: issues.length ? null : invoice, issues }
}
