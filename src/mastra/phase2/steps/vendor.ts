import type { Phase2Runtime } from '../composition.ts'
import { runtimeSources } from '../composition.ts'
import { ProviderUnavailableError } from '../ports.ts'
import { AssessmentStateSchema, type AssessmentState, type Phase2Invoice, type StepDecision } from '../schemas.ts'

const initial = (invoice: Phase2Invoice): AssessmentState => ({ invoice, vendor: null, purchaseOrder: null, receipts: [], decisions: [], matchMode: null, duplicateIds: [] })
const unavailable = (error: ProviderUnavailableError, sources: Record<string, string>): StepDecision => ({ step: 'vendor', outcome: 'unknown_retry', reviewType: null, reasons: [{ code: 'VENDOR_LOOKUP_UNAVAILABLE', message: error.message }], signals: [], adaptations: [], sources })
export function makeVendorValidation(runtime: Phase2Runtime) {
  const provider = runtime.provider, sources = runtimeSources(runtime)
  return async (invoice: Phase2Invoice) => {
    const state = initial(invoice), adaptations: StepDecision['adaptations'] = [], signals: string[] = []
    if (!provider.capabilities.vendorBankDetails) { adaptations.push({ code: 'VENDOR_BANK_DETAILS_UNAVAILABLE', providerId: sources.vendors }); signals.push('payment_details_unverifiable') }
    if (provider.capabilities.vendorStatusRichness === 'binary') adaptations.push({ code: 'VENDOR_STATUS_BINARY', providerId: sources.vendors })
    if (runtime.sanctionsIsFallback) adaptations.push({ code: 'SANCTIONS_SOURCE_FALLBACK', providerId: sources.sanctions })
    try {
      const vendors = await provider.vendors!.find({ name: invoice.vendorName, taxId: invoice.vendorTaxId })
      if (vendors.length !== 1) {
        state.decisions.push({ step: 'vendor', outcome: 'review', reviewType: vendors.length ? 'ambiguous_vendor' : 'unknown_vendor', reasons: [{ code: vendors.length ? 'VENDOR_AMBIGUOUS' : 'VENDOR_NOT_FOUND', message: vendors.length ? 'Multiple vendors match the printed identity' : 'No vendor matches the printed identity' }], signals, adaptations, sources: { vendors: sources.vendors } })
        return AssessmentStateSchema.parse(state)
      }
      const vendor = vendors[0]!, restriction = provider.capabilities.vendorStatusRichness === 'binary' ? await runtime.statusRestrictions?.getRestriction({ providerId: sources.vendors, vendorId: vendor.id }) : null
      state.vendor = restriction ? { ...vendor, status: restriction } : vendor
      if (state.vendor.status !== 'approved') {
        state.decisions.push({ step: 'vendor', outcome: 'blocked', reviewType: null, reasons: [{ code: 'VENDOR_NOT_APPROVED', message: `Vendor status is ${state.vendor.status}`, evidence: { status: state.vendor.status } }], signals, adaptations, sources: { vendors: sources.vendors } })
        return AssessmentStateSchema.parse(state)
      }
      const sanctions = await runtime.sanctions.screen(state.vendor)
      state.decisions.push({
        step: 'vendor', outcome: sanctions.matched ? 'blocked' : 'pass', reviewType: null,
        reasons: [{ code: sanctions.matched ? 'SANCTIONS_MATCH' : 'VENDOR_VALID', message: sanctions.matched ? 'Vendor matched a sanctions list' : 'Vendor identity and status are valid', evidence: sanctions.matched ? sanctions : { vendorId: state.vendor.id } }],
        signals, adaptations, sources: { vendors: sources.vendors, sanctions: sources.sanctions },
      })
      return AssessmentStateSchema.parse(state)
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error
      state.decisions.push(unavailable(error, { vendors: sources.vendors })); return AssessmentStateSchema.parse(state)
    }
  }
}
