import Decimal from 'decimal.js'
import { ExtractedInvoiceSchema, type ExtractedInvoice, type InvoiceDraft } from '../schemas/invoice.ts'

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const currencies = new Set(Intl.supportedValuesOf('currency'))
const blank = (value: string) => value.trim().length === 0
const tolerance = (currency: string) => new Decimal(10).pow(-(new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2))
const reconciles = (parts: Array<number | Decimal>, total: number, currency: string) => parts.reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0)).minus(total.toString()).abs().lte(tolerance(currency))

export function validateExtraction(draft: InvoiceDraft): { extracted: ExtractedInvoice | null; issues: string[] } {
  const parsed = ExtractedInvoiceSchema.safeParse(draft)
  if (!parsed.success) return { extracted: null, issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'invoice'}: ${issue.message}`) }
  const invoice = parsed.data, validCurrency = currencies.has(invoice.currency)
  const issues = [
    ...(['invoiceNumber', 'vendorName', 'invoiceDate', 'currency'] as const).filter(field => blank(invoice[field])).map(field => `${field} is required`),
    ...(isDate(invoice.invoiceDate) ? [] : ['invoiceDate must be yyyy-mm-dd']),
    ...(validCurrency ? [] : ['currency must be an ISO 4217 code']),
    ...(validCurrency && invoice.subtotal !== null && invoice.tax !== null && !reconciles([invoice.subtotal, invoice.tax], invoice.total, invoice.currency) ? ['subtotal + tax does not equal total'] : []),
    ...invoice.lines.flatMap((line, index) => [
      ...(blank(line.description) ? [`lines.${index}.description is required`] : []),
      ...(validCurrency && line.lineTotal !== null && !reconciles([new Decimal(line.qty.toString()).mul(line.unitPrice.toString())], line.lineTotal, invoice.currency) ? [`lines.${index} does not reconcile`] : []),
    ]),
    ...(validCurrency && invoice.subtotal !== null && invoice.lines.length && invoice.lines.every(line => line.lineTotal !== null) && !reconciles(invoice.lines.map(line => line.lineTotal!), invoice.subtotal, invoice.currency) ? ['line totals do not equal subtotal'] : []),
  ]
  return { extracted: issues.length ? null : invoice, issues }
}
