import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { invoiceExtractionAgent } from '../agents/invoice-extraction.ts'
import { InvoiceDraftSchema, type DocumentRef, type InvoiceDraft } from '../schemas/invoice.ts'
import { invoiceFixtures } from '../fixtures/invoices.ts'

export interface InvoiceReader { read(document: DocumentRef): Promise<InvoiceDraft> }

class FixtureInvoiceReader implements InvoiceReader {
  async read(document: DocumentRef) {
    const fixture = invoiceFixtures.find(({ document: candidate }) => candidate.id === document.id)
    if (!fixture) throw new Error(`No fixture extraction for ${document.id}`)
    return structuredClone(fixture.draft)
  }
}
class VisionInvoiceReader implements InvoiceReader {
  async read(document: DocumentRef) {
    if (!document.localPath) throw new Error('Vision reader requires document.localPath')
    const data = await readFile(document.localPath)
    const response = await invoiceExtractionAgent.generate([{ role: 'user', content: [
      { type: 'file', data, mediaType: document.mimeType, filename: basename(document.localPath) },
      { type: 'text', text: 'Read this invoice and return the requested structured extraction.' },
    ] }], { structuredOutput: { schema: InvoiceDraftSchema, jsonPromptInjection: 'auto' }, modelSettings: { temperature: 0 } })
    if (!response.object) throw new Error('Vision model returned no structured extraction')
    return InvoiceDraftSchema.parse(response.object)
  }
}
export const invoiceReader: InvoiceReader = process.env.INVOICE_READER === 'vision' ? new VisionInvoiceReader() : new FixtureInvoiceReader()
