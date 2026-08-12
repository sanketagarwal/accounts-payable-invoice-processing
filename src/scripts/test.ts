import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RequestContext } from '@mastra/core/request-context'
import { defaultStoragePath, mastra } from '../mastra/index.ts'
import { detectMediaType, invoiceReader, prepareDocument } from '../mastra/readers/invoice-reader.ts'
import { extractionFidelityScorer, scoreExtraction } from '../mastra/scorers/extraction-fidelity.ts'
import type { ExtractedInvoice } from '../mastra/schemas/invoice.ts'
import { resolveReferences } from '../mastra/tools/resolve-references.ts'
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
assert.ok(validateExtraction({ ...clean, subtotal: null, tax: null, lines: [] }).issues.includes('total cannot be reconciled from printed amounts'))
assert.equal(validateExtraction({ ...clean, total: Number.POSITIVE_INFINITY }).extracted, null)
assert.equal(validateExtraction({ ...clean, currency: 'XAU' }).extracted?.currency, 'XAU')
assert.equal(validateExtraction({ ...clean, currency: 'usd' }).extracted, null)
assert.ok(validateExtraction({ ...clean, total: 108.004 }).issues.includes('total exceeds USD minor-unit precision'))
assert.ok(validateExtraction({ ...clean, lines: [{ ...clean.lines[0]!, lineTotal: 100.001 }] }).issues.includes('lines.0.lineTotal exceeds USD minor-unit precision'))
assert.ok(validateExtraction({ ...clean, lines: [{ ...clean.lines[0]!, unitPrice: 10.0001 }] }).extracted)
assert.ok(validateExtraction({ ...clean, total: 108.01 }).issues.includes('subtotal + tax does not equal total'))
const bhd: ExtractedInvoice = { ...clean, currency: 'BHD', subtotal: 10, tax: 0.001, total: 10.003, lines: [{ ...clean.lines[0]!, qty: 1, unitPrice: 10, lineTotal: 10 }] }
assert.ok(validateExtraction(bhd).issues.includes('subtotal + tax does not equal total'))

const nullable = invoiceFixtures[1]!.groundTruth
assert.equal(scoreExtraction({ ...nullable, vendorTaxId: '0' }, nullable).fields.vendorTaxId, 0)
assert.equal(scoreExtraction({ ...clean, invoiceNumber: '001' }, { ...clean, invoiceNumber: '1' }).fields.invoiceNumber, 0)
assert.equal(scoreExtraction({ ...clean, lines: [{ ...clean.lines[0]!, qty: 9 }] }, clean).fields['lines.qty'], 0)
assert.ok(scoreExtraction(invoiceFixtures[1]!.draft, invoiceFixtures[1]!.groundTruth).overall < 1)
assert.equal(resolveReferences({ ...clean, poNumber: 'po-1001' }).poId, 'po_1001')

assert.equal(detectMediaType(Buffer.from('%PDF-1.7')), 'application/pdf')
assert.equal(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), 'image/jpeg')
assert.equal(detectMediaType(Buffer.from('not a pdf')), null)
const tempDir = await mkdtemp(join(dirname(defaultStoragePath), 'phase1-test-')), pdfPath = join(tempDir, 'invoice.pdf'), fakePath = join(tempDir, 'fake.pdf')
try {
  await writeFile(pdfPath, '%PDF-1.7\n%%EOF\n')
  await writeFile(fakePath, 'not a pdf')
  const prepared = await prepareDocument({ id: 'invoice', localPath: pdfPath, mimeType: 'application/pdf', source: 'PDF' })
  assert.ok(prepared.sha256)
  await assert.rejects(prepareDocument({ ...prepared, sha256: 'wrong' }), /checksum mismatch/)
  await assert.rejects(prepareDocument({ id: 'fake', localPath: fakePath, mimeType: 'application/pdf', source: 'PDF' }), /bytes do not match/)
  await assert.rejects(prepareDocument({ id: 'outside-root', localPath: process.execPath, mimeType: 'application/pdf', source: 'PDF' }), /INVOICE_ROOT/)
  await assert.rejects(prepareDocument({ id: 'source-mismatch', mimeType: 'image/png', source: 'PDF' }), /conflicts/)
  const previousLimit = process.env.INVOICE_MAX_BYTES
  try {
    process.env.INVOICE_MAX_BYTES = '4'
    await assert.rejects(prepareDocument({ id: 'large', localPath: pdfPath, mimeType: 'application/pdf', source: 'PDF' }), /exceeds/)
  } finally {
    if (previousLimit === undefined) delete process.env.INVOICE_MAX_BYTES
    else process.env.INVOICE_MAX_BYTES = previousLimit
  }
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
await assert.rejects(invoiceReader.read({ ...invoiceFixtures[0]!.document, sha256: 'spoofed' }), /does not match fixture/)
assert.equal((await stat(defaultStoragePath)).mode & 0o777, 0o600)
assert.equal((await stat(dirname(defaultStoragePath))).mode & 0o777, 0o700)

const workflow = mastra.getWorkflow('invoiceReaderWorkflow')
const originalSource = invoiceFixtures[0]!.draft.source
invoiceFixtures[0]!.draft.source = 'image'
const sourceRun = await workflow.createRun(), sourceResult = await sourceRun.start({ inputData: invoiceFixtures[0]!.document })
invoiceFixtures[0]!.draft.source = originalSource
assert.equal(sourceResult.status, 'success')
if (sourceResult.status === 'success') assert.equal(sourceResult.result.extractedResult.source, 'PDF')

const reviewRun = await workflow.createRun(), firstReview = await reviewRun.start({ inputData: invoiceFixtures[1]!.document })
assert.equal(firstReview.status, 'suspended')
const requestContext = new RequestContext<{ reviewerId?: string }>([['reviewerId', 'reviewer']])
const badCorrection = { ...invoiceFixtures[1]!.groundTruth, total: 61, source: 'PDF' as const }
const secondReview = await reviewRun.resume({ step: 'verify-invoice', resumeData: { extracted: badCorrection }, requestContext })
assert.equal(secondReview.status, 'suspended')
if (secondReview.status === 'suspended') assert.equal(secondReview.suspendPayload['verify-invoice'].draft.total, 61)
const completedReview = await reviewRun.resume({ step: 'verify-invoice', resumeData: { extracted: { ...invoiceFixtures[1]!.groundTruth, source: 'PDF' } }, requestContext })
assert.equal(completedReview.status, 'success')
if (completedReview.status === 'success') {
  assert.equal(completedReview.result.extractedResult.source, 'image')
  assert.equal(completedReview.result.reviewerId, 'reviewer')
}

const unauthorizedRun = await workflow.createRun(), unauthorizedStart = await unauthorizedRun.start({ inputData: invoiceFixtures[1]!.document })
assert.equal(unauthorizedStart.status, 'suspended')
const originalConsoleError = console.error
console.error = () => undefined
const unauthorizedResume = await unauthorizedRun.resume({ step: 'verify-invoice', resumeData: { extracted: invoiceFixtures[1]!.groundTruth } }).finally(() => { console.error = originalConsoleError })
assert.equal(unauthorizedResume.status, 'failed')
console.log('reader workflow and control tests passed')
