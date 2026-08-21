import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { ProviderUnavailableError } from "../../accounting/types.ts";
import type { AssessmentState, NormalizedInvoice, StepDecision } from "../schema.ts";
import { confidenceProblems } from "../validation.ts";
import { decide } from "./decision.ts";

const emptyAssessment = (invoice: NormalizedInvoice): AssessmentState => ({
  invoice,
  vendor: null,
  purchaseOrder: null,
  receipts: [],
  decisions: [],
  matchMode: null,
  duplicateIds: [],
});

const canonicalId = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();

export function makeVendorValidation(runtime: InvoiceRuntime) {
  const provider = runtime.provider;

  return async (invoice: NormalizedInvoice) => {
    const state = emptyAssessment(invoice);
    const { uncertainFields, missingConfidence } = confidenceProblems(
      invoice,
      runtime.policy.lowConfidenceThreshold,
    );
    if (
      invoice.overallConfidence < runtime.policy.lowConfidenceThreshold ||
      uncertainFields.length ||
      missingConfidence.length
    ) {
      return decide(state, {
        step: "extraction",
        outcome: "verify_extraction",
        reviewType: "verify_extraction",
        reasons: [
          {
            code: "LOW_EXTRACTION_CONFIDENCE",
            message: "Verify the extracted fields before financial controls run",
            evidence: {
              overallConfidence: invoice.overallConfidence,
              uncertainFields,
              missingConfidence,
            },
          },
        ],
        signals: ["low_extraction_confidence"],
      });
    }

    const adaptations: StepDecision["adaptations"] = [];
    const signals: string[] = [];
    if (provider.vendorData === "basic") {
      adaptations.push(
        { code: "VENDOR_BANK_DETAILS_UNAVAILABLE", providerId: provider.id },
        { code: "VENDOR_STATUS_BINARY", providerId: provider.id },
      );
      signals.push("payment_details_unverifiable");
    }
    if (runtime.sanctionsSource !== provider.id)
      adaptations.push({
        code: "SANCTIONS_SOURCE_FALLBACK",
        providerId: runtime.sanctionsSource,
      });

    const sources = { vendors: provider.id, sanctions: runtime.sanctionsSource };
    try {
      const vendors = await provider.findVendors({
        name: invoice.vendorName,
        taxId: invoice.vendorTaxId,
      });
      if (vendors.length !== 1) {
        const ambiguous = vendors.length > 1;
        return decide(state, {
          step: "vendor",
          outcome: "review",
          reviewType: ambiguous ? "ambiguous_vendor" : "unknown_vendor",
          reasons: [
            {
              code: ambiguous ? "VENDOR_AMBIGUOUS" : "VENDOR_NOT_FOUND",
              message: ambiguous
                ? "Multiple vendors match the printed identity"
                : "No vendor matches the printed identity",
            },
          ],
          signals,
          adaptations,
          sources: { vendors: provider.id },
        });
      }

      const vendor = vendors[0]!;
      state.vendor = vendor;
      const taxIdMismatch = Boolean(
        invoice.vendorTaxId &&
        vendor.taxId &&
        canonicalId(invoice.vendorTaxId) !== canonicalId(vendor.taxId),
      );
      const mismatchReason: StepDecision["reasons"][number] | null = taxIdMismatch
        ? {
            code: "VENDOR_TAX_ID_MISMATCH",
            message: "Printed and canonical vendor tax IDs conflict",
            evidence: { printed: invoice.vendorTaxId, canonical: vendor.taxId },
          }
        : null;
      if (invoice.vendorTaxId && !vendor.taxId) signals.push("vendor_tax_id_unverifiable");

      if (vendor.status !== "approved")
        return decide(state, {
          step: "vendor",
          outcome: "blocked",
          reasons: [
            {
              code: "VENDOR_NOT_APPROVED",
              message: `Vendor status is ${vendor.status}`,
              evidence: { status: vendor.status },
            },
            ...(mismatchReason ? [mismatchReason] : []),
          ],
          signals,
          adaptations,
          sources: { vendors: provider.id },
        });

      const sanctions = await runtime.screenVendor(vendor);
      if (sanctions.matched)
        return decide(state, {
          step: "vendor",
          outcome: "blocked",
          reasons: [
            {
              code: "SANCTIONS_MATCH",
              message: "Vendor matched a sanctions list",
              evidence: sanctions,
            },
            ...(mismatchReason ? [mismatchReason] : []),
          ],
          signals,
          adaptations,
          sources,
        });

      if (mismatchReason) {
        const uncertain = invoice.confidence.some(
          ({ field, confidence }) =>
            field === "vendorTaxId" && confidence < runtime.policy.lowConfidenceThreshold,
        );
        return decide(state, {
          step: "vendor",
          outcome: uncertain ? "verify_extraction" : "review",
          reviewType: uncertain ? "verify_extraction" : "vendor_identity_mismatch",
          reasons: [mismatchReason],
          signals,
          adaptations,
          sources,
        });
      }

      return decide(state, {
        step: "vendor",
        outcome: "pass",
        reasons: [
          {
            code: "VENDOR_VALID",
            message: "Vendor identity and status are valid",
            evidence: { vendorId: vendor.id },
          },
        ],
        signals,
        adaptations,
        sources,
      });
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      return decide(state, {
        step: "vendor",
        outcome: "unknown_retry",
        reasons: [{ code: "VENDOR_LOOKUP_UNAVAILABLE", message: error.message }],
        sources: { vendors: provider.id },
      });
    }
  };
}
