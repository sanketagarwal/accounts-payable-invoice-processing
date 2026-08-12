import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { invoiceExtractionAgent } from '../agents/invoice-extraction.ts'
import { InvoiceDraftSchema, type DocumentRef, type InvoiceDraft } from '../schemas/invoice.ts'
import { invoiceFixtures } from '../fixtures/invoices.ts'

export interface InvoiceReader { read(document: DocumentRef): Promise<InvoiceDraft> }
const allowedMediaTypes = new Set(['application/pdf', 'image/png', 'image/jpeg'])
async function readLocalDocument(document: DocumentRef) {
  if (!document.localPath) throw new Error('Vision reader requires document.localPath')
  const root = await realpath(resolve(process.env.INVOICE_ROOT ?? '.')), localPath = await realpath(resolve(document.localPath)), pathFromRoot = relative(root, localPath)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) throw new Error(`Invoice file must be inside INVOICE_ROOT: ${root}`)
  const data = await readFile(localPath), limit = Number(process.env.INVOICE_MAX_BYTES ?? 20_000_000)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('INVOICE_MAX_BYTES must be a positive integer')
  if (data.byteLength > limit) throw new Error(`Invoice exceeds INVOICE_MAX_BYTES (${limit})`)
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (document.sha256 && document.sha256 !== sha256) throw new Error(`Invoice checksum mismatch for ${document.id}`)
  return { data, localPath, sha256 }
}
export async function prepareDocument(document: DocumentRef): Promise<DocumentRef> {
  const expectedSource = document.mimeType === 'application/pdf' ? 'PDF' : document.mimeType.startsWith('image/') ? 'image' : undefined
  if (expectedSource && document.source !== expectedSource) throw new Error(`Document source ${document.source} conflicts with ${document.mimeType}`)
  if (!document.localPath) return document
  const { localPath, sha256 } = await readLocalDocument(document)
  return { ...document, localPath, sha256 }
}

class FixtureInvoiceReader implements InvoiceReader {
  async read(document: DocumentRef) {
    const fixture = invoiceFixtures.find(({ document: candidate }) => candidate.id === document.id)
    if (!fixture) throw new Error(`No fixture extraction for ${document.id}`)
    return structuredClone(fixture.draft)
  }
}
class VisionInvoiceReader implements InvoiceReader {
  async read(document: DocumentRef) {
    if (!allowedMediaTypes.has(document.mimeType)) throw new Error(`Unsupported invoice media type: ${document.mimeType}`)
    const { data, localPath } = await readLocalDocument(document)
    const response = await invoiceExtractionAgent.generate([{ role: 'user', content: [
      { type: 'file', data, mediaType: document.mimeType, filename: basename(localPath) },
      { type: 'text', text: 'Read this invoice and return the requested structured extraction.' },
    ] }], { structuredOutput: { schema: InvoiceDraftSchema, jsonPromptInjection: 'auto' }, modelSettings: { temperature: 0 } })
    if (!response.object) throw new Error('Vision model returned no structured extraction')
    return InvoiceDraftSchema.parse(response.object)
  }
}
const readerType = process.env.INVOICE_READER ?? 'fixture'
if (readerType !== 'fixture' && readerType !== 'vision') throw new Error(`Unknown INVOICE_READER: ${readerType}`)
export const invoiceReader: InvoiceReader = readerType === 'vision' ? new VisionInvoiceReader() : new FixtureInvoiceReader()
