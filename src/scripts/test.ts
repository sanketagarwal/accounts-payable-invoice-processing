import assert from 'node:assert/strict'
import { runProviderConformance } from '../mastra/phase2/conformance.ts'
import { fixtureConformanceCases } from '../mastra/phase2/conformance-fixtures.ts'
import { createPhase2Runtime } from '../mastra/phase2/composition.ts'
import { toMinorUnits, normalizePhase1Output } from '../mastra/phase2/money.ts'
import { FixturePolicyProvider, FixtureSanctionsScreener, InMemoryInvoiceHistoryRepository } from '../mastra/phase2/adapters/fixture.ts'
import { QuickBooksAdapter, type QboClient } from '../mastra/phase2/adapters/quickbooks-adapter.ts'
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
const billPages: Record<number, unknown[]> = {
  1: [{ Id: 'bill_1', DocNumber: 'B-1', VendorRef: { value: 'qbo_vendor_acme' }, TotalAmt: 1, TxnDate: '2026-01-01' }, { Id: 'bill_2', DocNumber: 'B-2', VendorRef: { value: 'qbo_vendor_acme' }, TotalAmt: 2, TxnDate: '2026-01-02' }],
  3: [{ Id: 'bill_3', DocNumber: 'B-3', VendorRef: { value: 'qbo_vendor_acme' }, TotalAmt: 3, TxnDate: '2026-01-03' }],
}
const pageStarts: number[] = [], pagingClient: QboClient = { query: async <T>(_entity: string, query: string) => { const start = Number(query.match(/startposition (\d+)/i)?.[1]); pageStarts.push(start); return (billPages[start] ?? []) as T[] } }
assert.equal((await new QuickBooksAdapter(pagingClient, 2).billHistorySeed()).length, 3)
assert.deepEqual(pageStarts, [1, 3])
assert.throws(() => createPhase2Runtime({ provider: quickbooks }), /sanctions/)
const qboRuntime = createPhase2Runtime({ provider: quickbooks, history: new InMemoryInvoiceHistoryRepository(), policy: new FixturePolicyProvider(), sanctionsFallback: new FixtureSanctionsScreener() })
let qboState = await makeVendorValidation(qboRuntime)(normalized)
assert.ok(qboState.decisions[0]!.signals.includes('payment_details_unverifiable'))
qboState = await makeInvoiceMatch(qboRuntime)(qboState)
assert.equal(qboState.matchMode, 'two_way')
assert.ok(qboState.decisions.at(-1)!.adaptations.some(a => a.code === 'GOODS_RECEIPTS_UNAVAILABLE'))

assert.throws(() => makeCompositeProvider({ id: 'unsafe-vendor-po', displayName: 'Unsafe vendor/PO', vendors: fixtureProvider, purchaseOrders: quickbooks }), /vendor ID crosswalk/)
assert.throws(() => makeCompositeProvider({ id: 'unsafe-vendor-history', displayName: 'Unsafe vendor/history', vendors: fixtureProvider, billHistory: quickbooks }), /vendor ID crosswalk/)
const splitProvider = makeCompositeProvider({
  id: 'fixture-qbo', displayName: 'Fixture vendors + QuickBooks POs', vendors: fixtureProvider, purchaseOrders: quickbooks, sanctions: fixtureProvider, billHistory: quickbooks,
  identity: { crosswalk: { mapVendorId: async ({ id }) => id === 'qbo_vendor_acme' ? 'vendor_acme' : null } },
})
assert.equal((await splitProvider.billHistorySeed!())[0]!.vendorId, 'vendor_acme')
const splitRuntime = createPhase2Runtime({ provider: splitProvider, history: new InMemoryInvoiceHistoryRepository(), policy: new FixturePolicyProvider() })
let splitState = await makeVendorValidation(splitRuntime)(normalized)
splitState = await makeInvoiceMatch(splitRuntime)(splitState)
assert.equal(splitState.decisions.at(-1)!.outcome, 'pass')

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
let lineMismatchState = await makeVendorValidation(fixtureRuntime)({ ...normalized, lines: [{ ...normalized.lines[0]!, qty: 5, unitPriceMinor: 2000 }] })
lineMismatchState = await makeInvoiceMatch(fixtureRuntime)(lineMismatchState)
assert.equal(lineMismatchState.decisions.at(-1)!.reviewType, 'po_mismatch')
assert.ok((lineMismatchState.decisions.at(-1)!.reasons[0]!.evidence?.mismatches as string[]).some(value => value.endsWith('.qty')))
assert.equal((await makePolicyRouting(fixtureRuntime)(lineMismatchState)).disposition, 'review')

let identityMismatchState = await makeVendorValidation(fixtureRuntime)({ ...normalized, vendorTaxId: 'US-99-9999999' })
identityMismatchState = await makeInvoiceMatch(fixtureRuntime)(identityMismatchState)
identityMismatchState = await makeDuplicateDetection(fixtureRuntime)(identityMismatchState)
assert.equal((await makePolicyRouting(fixtureRuntime)(identityMismatchState)).disposition, 'review')
assert.equal(identityMismatchState.decisions[0]!.reasons[0]!.code, 'VENDOR_TAX_ID_MISMATCH')

let duplicateState = await makeVendorValidation(fixtureRuntime)({ ...normalized, invoiceNumber: 'ACME-0999' })
duplicateState = await makeInvoiceMatch(fixtureRuntime)(duplicateState)
duplicateState = await makeDuplicateDetection(fixtureRuntime)(duplicateState)
assert.equal(duplicateState.decisions.at(-1)!.reviewType, 'possible_duplicate')
assert.equal((await makePolicyRouting(fixtureRuntime)(duplicateState)).disposition, 'review')
const currencyHistory = new InMemoryInvoiceHistoryRepository()
await currencyHistory.seed([{ id: 'eur_same_amount', vendorId: 'vendor_acme', invoiceNumber: 'EUR-OTHER', invoiceDate: normalized.invoiceDate, currency: 'EUR', totalMinor: normalized.totalMinor, channel: null }])
const currencyRuntime = createPhase2Runtime({ provider: fixtureProvider, history: currencyHistory, policy: new FixturePolicyProvider() })
let currencyState = await makeVendorValidation(currencyRuntime)({ ...normalized, invoiceNumber: 'ACME-NEW' })
currencyState = await makeInvoiceMatch(currencyRuntime)(currencyState)
currencyState = await makeDuplicateDetection(currencyRuntime)(currencyState)
assert.ok(!currencyState.duplicateIds.includes('eur_same_amount'))
assert.equal(currencyState.decisions.at(-1)!.outcome, 'pass')

let refreshCalls = 0, providerHistory = [{ id: 'refresh_1', vendorId: 'vendor_acme', invoiceNumber: 'R-1', invoiceDate: '2026-01-01', currency: 'USD', totalMinor: 100, channel: null }]
const refreshProvider = assertProvider({ ...fixtureProvider, id: 'refreshing', billHistorySeed: async () => { if (++refreshCalls === 1) throw new ProviderUnavailableError('refreshing', 'bill history'); return providerHistory } })
const refreshHistory = new InMemoryInvoiceHistoryRepository(), refreshRuntime = createPhase2Runtime({ provider: refreshProvider, history: refreshHistory })
await assert.rejects(refreshRuntime.seedHistory(), ProviderUnavailableError)
await refreshRuntime.seedHistory()
providerHistory = [...providerHistory, { id: 'refresh_2', vendorId: 'vendor_acme', invoiceNumber: 'R-2', invoiceDate: '2026-01-02', currency: 'USD', totalMinor: 200, channel: null }]
await refreshRuntime.seedHistory()
assert.equal(refreshCalls, 3)
assert.equal((await refreshHistory.findPotentialDuplicates({ vendorId: 'vendor_acme', invoiceNumber: 'R-2', currency: 'USD', totalMinor: 200 })).length, 1)

const approved = await makePolicyRouting(fixtureRuntime)({ ...compositeState, invoice: { ...compositeState.invoice, totalMinor: 100_001 } })
assert.equal(approved.disposition, 'approval_required')

const unavailableProvider = assertProvider({ ...fixtureProvider, id: 'unavailable', vendors: { find: async () => { throw new ProviderUnavailableError('unavailable', 'find vendor') } } })
const unavailableState = await makeVendorValidation(createPhase2Runtime({ provider: unavailableProvider }))(normalized)
assert.equal(unavailableState.decisions[0]!.outcome, 'unknown_retry')

const workflow = mastra.getWorkflow('apInvoiceWorkflow'), run = await workflow.createRun(), result = await run.start({ inputData: clean.document })
assert.equal(result.status, 'success')
assert.equal((result as { result: FinalAssessment }).result.disposition, 'auto_post')
console.log('reader, provider, and Phase 2 workflow tests passed')
