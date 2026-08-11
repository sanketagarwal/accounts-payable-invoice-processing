import assert from 'node:assert/strict'
import { runProviderConformance } from '../mastra/phase2/conformance.ts'
import { fixtureConformanceCases } from '../mastra/phase2/conformance-fixtures.ts'
import { createPhase2Runtime } from '../mastra/phase2/composition.ts'
import { toMinorUnits, normalizePhase1Output } from '../mastra/phase2/money.ts'
import { FixturePolicyProvider, FixtureSanctionsScreener, InMemoryInvoiceHistoryRepository } from '../mastra/phase2/adapters/fixture.ts'
import type { QboClient } from '../mastra/phase2/adapters/quickbooks-adapter.ts'
import { makeCompositeProvider } from '../mastra/phase2/providers/composite-provider.ts'
import { NotImplementedError } from '../mastra/phase2/providers/connector-provider.ts'
import { fixtureProvider } from '../mastra/phase2/providers/fixture-provider.ts'
import { makeQuickBooksProvider } from '../mastra/phase2/providers/quickbooks-provider.ts'
import { providerRegistry } from '../mastra/phase2/providers/registry.ts'
import { assertProvider } from '../mastra/phase2/providers/types.ts'
import { makeInvoiceMatch } from '../mastra/phase2/steps/match.ts'
import { makeDuplicateDetection } from '../mastra/phase2/steps/dedup.ts'
import { makePolicyRouting } from '../mastra/phase2/steps/policy.ts'
import { makeVendorValidation } from '../mastra/phase2/steps/vendor.ts'
import { ProviderUnavailableError } from '../mastra/phase2/ports.ts'
import type { FinalAssessment } from '../mastra/phase2/schemas.ts'
import { extractionFidelityScorer } from '../mastra/scorers/extraction-fidelity.ts'
import { mastra } from '../mastra/index.ts'
import { invoiceFixtures, runFixture } from './support.ts'

for (const fixture of invoiceFixtures) {
  const run = await runFixture(fixture)
  assert.equal(run.suspended, fixture.requiresReview)
  assert.deepEqual(run.result.extractedResult, fixture.groundTruth)
  const score = await extractionFidelityScorer.run({ input: fixture.groundTruth, output: run.result.extractedResult })
  assert.equal(score.score, 1)
}

assert.equal(toMinorUnits(10.5, 'USD'), 1050)
assert.equal(toMinorUnits(10.5, 'JPY'), 11)
assert.equal(toMinorUnits(10.5, 'BHD'), 10_500)
const clean = invoiceFixtures[0]!, normalized = normalizePhase1Output({ rawDocumentRef: clean.document, extractedResult: clean.groundTruth, vendorId: 'vendor_acme', poId: 'po_1001' })
assert.deepEqual(normalized.fixtureHints, { vendorId: 'vendor_acme', poId: 'po_1001' })
assert.equal(normalized.totalMinor, 10_800)

await runProviderConformance(fixtureProvider, fixtureConformanceCases)
assert.throws(() => providerRegistry.create('connector'), NotImplementedError)

const qboRows: Record<string, unknown[]> = {
  Vendor: [{ Id: 'qbo_vendor_acme', DisplayName: 'Acme Supplies', Active: true, TaxIdentifier: 'US-12-3456789' }],
  PurchaseOrder: [{ Id: 'qbo_po_1001', DocNumber: 'PO-1001', VendorRef: { value: 'qbo_vendor_acme' }, CurrencyRef: { value: 'USD' }, TotalAmt: 108, Line: [{ Amount: 100, Description: 'Blue pens', ItemBasedExpenseLineDetail: { ItemRef: { value: 'PEN-01' }, Qty: 10, UnitPrice: 10 } }] }],
  Bill: [{ Id: 'qbo_prior', DocNumber: 'ACME-0999', VendorRef: { value: 'qbo_vendor_acme' }, CurrencyRef: { value: 'USD' }, TotalAmt: 108, TxnDate: '2026-07-01' }],
}
const qboClient: QboClient = { query: async <T>(entity: string) => (qboRows[entity] ?? []) as T[] }
const quickbooks = makeQuickBooksProvider(qboClient)
assert.throws(() => createPhase2Runtime({ provider: quickbooks }), /sanctions/)
const qboRuntime = createPhase2Runtime({ provider: quickbooks, history: new InMemoryInvoiceHistoryRepository(), policy: new FixturePolicyProvider(), sanctionsFallback: new FixtureSanctionsScreener() })
let qboState = await makeVendorValidation(qboRuntime)(normalized)
assert.ok(qboState.decisions[0]!.signals.includes('payment_details_unverifiable'))
qboState = await makeInvoiceMatch(qboRuntime)(qboState)
assert.equal(qboState.matchMode, 'two_way')
assert.ok(qboState.decisions.at(-1)!.adaptations.some(a => a.code === 'GOODS_RECEIPTS_UNAVAILABLE'))

const receiving = assertProvider({
  id: 'receiving', displayName: 'Receiving system', capabilities: { vendors: false, vendorBankDetails: false, vendorStatusRichness: 'none', purchaseOrders: false, goodsReceipts: true, billHistory: false, sanctions: false, invoiceChannel: false, posting: false },
  goodsReceipts: { findByPurchaseOrderId: async id => id === 'receiving_po_1001' ? [{ id: 'receipt_1001', purchaseOrderId: id, receivedAt: '2026-07-30', lines: [{ sku: 'PEN-01', qty: 10 }] }] : [] },
  identityNamespaces: { goodsReceipts: 'receiving' },
})
assert.throws(() => makeCompositeProvider({ id: 'unsafe', displayName: 'Unsafe composition', purchaseOrders: quickbooks, goodsReceipts: receiving }), /crosswalk/)
const composite = makeCompositeProvider({
  id: 'qbo-receiving', displayName: 'QuickBooks + receiving', vendors: quickbooks, purchaseOrders: quickbooks, goodsReceipts: receiving, sanctions: fixtureProvider, billHistory: quickbooks,
  identity: { crosswalk: { mapPurchaseOrderId: async ({ id }) => id === 'qbo_po_1001' ? 'receiving_po_1001' : null } },
})
const compositeRuntime = createPhase2Runtime({ provider: composite, history: new InMemoryInvoiceHistoryRepository(), policy: new FixturePolicyProvider() })
let compositeState = await makeVendorValidation(compositeRuntime)(normalized)
compositeState = await makeInvoiceMatch(compositeRuntime)(compositeState)
assert.equal(compositeState.matchMode, 'three_way')
assert.equal(compositeState.decisions.at(-1)!.sources.goodsReceipts, 'receiving')

const fixtureRuntime = createPhase2Runtime({ provider: fixtureProvider, history: new InMemoryInvoiceHistoryRepository(), policy: new FixturePolicyProvider() })
let duplicateState = await makeVendorValidation(fixtureRuntime)({ ...normalized, invoiceNumber: 'ACME-0999' })
duplicateState = await makeInvoiceMatch(fixtureRuntime)(duplicateState)
duplicateState = await makeDuplicateDetection(fixtureRuntime)(duplicateState)
assert.equal(duplicateState.decisions.at(-1)!.reviewType, 'possible_duplicate')
assert.equal((await makePolicyRouting(fixtureRuntime)(duplicateState)).disposition, 'review')
const approved = await makePolicyRouting(fixtureRuntime)({ ...compositeState, invoice: { ...compositeState.invoice, totalMinor: 100_001 } })
assert.equal(approved.disposition, 'approval_required')

const unavailableProvider = assertProvider({ ...fixtureProvider, id: 'unavailable', vendors: { find: async () => { throw new ProviderUnavailableError('unavailable', 'find vendor') } } })
const unavailableState = await makeVendorValidation(createPhase2Runtime({ provider: unavailableProvider }))(normalized)
assert.equal(unavailableState.decisions[0]!.outcome, 'unknown_retry')

const workflow = mastra.getWorkflow('apInvoiceWorkflow'), run = await workflow.createRun(), result = await run.start({ inputData: clean.document })
assert.equal(result.status, 'success')
assert.equal((result as { result: FinalAssessment }).result.disposition, 'auto_post')
console.log('reader, provider, and Phase 2 workflow tests passed')
