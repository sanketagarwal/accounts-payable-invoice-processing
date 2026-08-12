import 'dotenv/config'
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { invoiceExtractionAgent } from './agents/invoice-extraction.ts'
import { extractionFidelityScorer } from './scorers/extraction-fidelity.ts'
import { invoiceReaderWorkflow } from './workflows/invoice-reader.ts'
import { apInvoiceWorkflow } from './workflows/ap-invoice.ts'

export const defaultStoragePath = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'data/mastra.db')
const configuredStorageUrl = process.env.MASTRA_DB_URL?.trim() || undefined
if (!configuredStorageUrl) {
  mkdirSync(dirname(defaultStoragePath), { recursive: true, mode: 0o700 })
  chmodSync(dirname(defaultStoragePath), 0o700)
  closeSync(openSync(defaultStoragePath, 'a', 0o600))
  chmodSync(defaultStoragePath, 0o600)
}
export const mastra = new Mastra({
  agents: { invoiceExtractionAgent }, workflows: { apInvoiceWorkflow, invoiceReaderWorkflow }, scorers: { extractionFidelityScorer },
  storage: new LibSQLStore({ id: 'ap-invoice-storage', url: configuredStorageUrl ?? `file:${defaultStoragePath}` }),
})
