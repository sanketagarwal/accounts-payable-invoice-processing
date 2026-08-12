import assert from 'node:assert/strict'
import { mastra } from '../mastra/index.ts'
import { prepareDocument } from '../mastra/readers/invoice-reader.ts'
import { extractionFidelityScorer, scoreExtraction } from '../mastra/scorers/extraction-fidelity.ts'
import type { ExtractedInvoice } from '../mastra/schemas/invoice.ts'
import { validateExtraction } from '../mastra/validation/extraction-checks.ts'
import { invoiceFixtures, runFixture } from './support.ts'

for (const fixture of invoiceFixtures) {
  const run = await runFixture(fixture)
  assert.equal(run.suspended, fixture.requiresReview)
  assert.deepEqual(run.result.extractedResult, fixture.groundTruth)
  const score = await extractionFidelityScorer.run({ input: fixture.groundTruth, output: run.result.extractedResult })
  assert.equal(score.score, 1)
}

const clean = invoiceFixtures[0]!.groundTruth
assert.equal(validateExtraction({ ...clean, vendorName: '   ' }).extracted, null)
assert.ok(validateExtraction({ ...clean, invoiceDate: '2026-02-30' }).issues.includes('invoiceDate must be yyyy-mm-dd'))
assert.ok(validateExtraction({ ...clean, subtotal: 99 }).issues.includes('line totals do not equal subtotal'))
const bhd: ExtractedInvoice = { ...clean, currency: 'BHD', subtotal: 10, tax: 0.001, total: 10.003, lines: [{ ...clean.lines[0]!, qty: 1, unitPrice: 10, lineTotal: 10 }] }
assert.ok(validateExtraction(bhd).issues.includes('subtotal + tax does not equal total'))

const nullable = invoiceFixtures[1]!.groundTruth
assert.equal(scoreExtraction({ ...nullable, vendorTaxId: '0' }, nullable).fields.vendorTaxId, 0)
assert.equal(scoreExtraction({ ...clean, invoiceNumber: '001' }, { ...clean, invoiceNumber: '1' }).fields.invoiceNumber, 0)
assert.equal(scoreExtraction({ ...clean, lines: [{ ...clean.lines[0]!, qty: 9 }] }, clean).fields['lines.qty'], 0)

const prepared = await prepareDocument({ id: 'package', localPath: 'package.json', mimeType: 'application/pdf', source: 'PDF' })
assert.ok(prepared.sha256)
await assert.rejects(prepareDocument({ ...prepared, sha256: 'wrong' }), /checksum mismatch/)
await assert.rejects(prepareDocument({ id: 'outside-root', localPath: process.execPath, mimeType: 'application/pdf', source: 'PDF' }), /INVOICE_ROOT/)
await assert.rejects(prepareDocument({ id: 'source-mismatch', mimeType: 'image/png', source: 'PDF' }), /conflicts/)

const workflow = mastra.getWorkflow('invoiceReaderWorkflow')
const originalSource = invoiceFixtures[0]!.draft.source
invoiceFixtures[0]!.draft.source = 'image'
const sourceRun = await workflow.createRun(), sourceResult = await sourceRun.start({ inputData: invoiceFixtures[0]!.document })
invoiceFixtures[0]!.draft.source = originalSource
assert.equal(sourceResult.status, 'success')
if (sourceResult.status === 'success') assert.equal(sourceResult.result.extractedResult.source, 'PDF')

const reviewRun = await workflow.createRun(), firstReview = await reviewRun.start({ inputData: invoiceFixtures[1]!.document })
assert.equal(firstReview.status, 'suspended')
const badCorrection = { ...invoiceFixtures[1]!.groundTruth, total: 61 }
const secondReview = await reviewRun.resume({ step: 'verify-invoice', resumeData: { reviewerId: 'reviewer', extracted: badCorrection } })
assert.equal(secondReview.status, 'suspended')
if (secondReview.status === 'suspended') assert.equal(secondReview.suspendPayload['verify-invoice'].draft.total, 61)
const completedReview = await reviewRun.resume({ step: 'verify-invoice', resumeData: { reviewerId: 'reviewer', extracted: invoiceFixtures[1]!.groundTruth } })
assert.equal(completedReview.status, 'success')
console.log('reader workflow and control tests passed')
