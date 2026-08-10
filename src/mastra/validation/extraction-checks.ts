import { ExtractedInvoiceSchema, type ExtractedInvoice, type InvoiceDraft } from '../schemas/invoice.ts'

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const currencies = new Set(Intl.supportedValuesOf('currency'))
export function validateExtraction(draft: InvoiceDraft): { extracted: ExtractedInvoice | null; issues: string[] } {
  const parsed = ExtractedInvoiceSchema.safeParse(draft)
  if (!parsed.success) return { extracted: null, issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'invoice'}: ${issue.message}`) }
  const invoice = parsed.data
  const issues = [
    ...['invoiceNumber', 'vendorName', 'invoiceDate', 'currency'].filter(field => !invoice[field as keyof ExtractedInvoice]).map(field => `${field} is required`),
    ...(isDate(invoice.invoiceDate) ? [] : ['invoiceDate must be yyyy-mm-dd']),
    ...(currencies.has(invoice.currency) ? [] : ['currency must be an ISO 4217 code']),
    ...(invoice.subtotal !== null && invoice.tax !== null && Math.abs(invoice.subtotal + invoice.tax - invoice.total) > 0.01 ? ['subtotal + tax does not equal total'] : []),
    ...invoice.lines.flatMap((line, index) => line.lineTotal !== null && Math.abs(line.qty * line.unitPrice - line.lineTotal) > 0.01 ? [`lines.${index} does not reconcile`] : []),
  ]
  return { extracted: issues.length ? null : invoice, issues }
}
