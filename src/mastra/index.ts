import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { Mastra } from '@mastra/core'
import { LibSQLStore } from '@mastra/libsql'
import { invoiceExtractionAgent } from './agents/invoice-extraction.ts'
import { extractionFidelityScorer } from './scorers/extraction-fidelity.ts'
import { invoiceReaderWorkflow } from './workflows/invoice-reader.ts'
import { apDecisionWorkflow } from './phase2/workflow.ts'
import { apInvoiceWorkflow } from './workflows/ap-invoice.ts'

mkdirSync('data', { recursive: true })
export const mastra = new Mastra({
  agents: { invoiceExtractionAgent }, workflows: { apInvoiceWorkflow, invoiceReaderWorkflow, apDecisionWorkflow }, scorers: { extractionFidelityScorer },
  storage: new LibSQLStore({ id: 'ap-invoice-storage', url: process.env.MASTRA_DB_URL ?? 'file:./data/mastra.db' }),
})
