import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { invoiceExtractionAgent } from './readers/invoice-reader.ts'
import { extractionFidelityScorer } from './scorers/extraction-fidelity.ts'
import { invoiceReaderWorkflow } from './workflows/invoice-reader.ts'

mkdirSync('data', { recursive: true })
export const mastra = new Mastra({
  agents: { invoiceExtractionAgent }, workflows: { invoiceReaderWorkflow }, scorers: { extractionFidelityScorer },
  storage: new LibSQLStore({ id: 'ap-invoice-storage', url: process.env.MASTRA_DB_URL ?? 'file:./data/mastra.db' }),
})
