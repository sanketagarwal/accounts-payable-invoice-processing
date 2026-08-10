import { createScorer } from '@mastra/core/evals'
import type { ExtractedInvoice } from '../schemas/invoice.ts'

type FidelityReport = { fields: Record<string, number>; overall: number }
const same = (left: unknown, right: unknown) => Number(left) === Number(right) || String(left).trim().toLowerCase() === String(right).trim().toLowerCase()
export function scoreExtraction(actual: ExtractedInvoice, expected: ExtractedInvoice): FidelityReport {
  const fields: Record<string, number> = {}
  for (const field of ['invoiceNumber', 'vendorName', 'vendorTaxId', 'poNumber', 'invoiceDate', 'currency', 'subtotal', 'tax', 'total', 'source'] as const) fields[field] = same(actual[field], expected[field]) ? 1 : 0
  const lineFields = ['sku', 'description', 'qty', 'unitPrice', 'lineTotal'] as const
  fields.lines = actual.lines.length === expected.lines.length && actual.lines.every((line, index) => lineFields.every(field => same(line[field], expected.lines[index]?.[field]))) ? 1 : 0
  return { fields, overall: Object.values(fields).reduce((sum, score) => sum + score, 0) / Object.keys(fields).length }
}
export const extractionFidelityScorer = createScorer<ExtractedInvoice, ExtractedInvoice>({ id: 'extraction-fidelity', description: 'Deterministically scores invoice extraction fidelity.' })
  .analyze(({ run }) => run.output && run.input ? scoreExtraction(run.output, run.input) : { fields: { output: 0 }, overall: 0 })
  .generateScore(({ results }) => results.analyzeStepResult.overall)
  .generateReason(({ results, score }) => `score=${score}; failed=${Object.entries(results.analyzeStepResult.fields).filter(([, value]) => value === 0).map(([field]) => field).join(',') || 'none'}`)
