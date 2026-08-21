import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { ProviderUnavailableError } from "../../accounting/types.ts";
import type { AssessmentState, NormalizedInvoice, StepDecision } from "../schema.ts";
import { confidenceProblems } from "../validation.ts";
import { decide } from "./decision.ts";

const emptyAssessment = (invoice: NormalizedInvoice): AssessmentState => ({
  invoice,
  vendor: null,
  purchaseOrder: null,
  decisions: [],
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
      });
    }
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
          reasons: [
            {
              code: ambiguous ? "VENDOR_AMBIGUOUS" : "VENDOR_NOT_FOUND",
              message: ambiguous
                ? "Multiple vendors match the printed identity"
                : "No vendor matches the printed identity",
            },
          ],
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
        });

      if (mismatchReason) {
        const uncertain = invoice.confidence.some(
          ({ field, confidence }) =>
            field === "vendorTaxId" && confidence < runtime.policy.lowConfidenceThreshold,
        );
        return decide(state, {
          step: "vendor",
          outcome: uncertain ? "verify_extraction" : "review",
          reasons: [mismatchReason],
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
      });
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      return decide(state, {
        step: "vendor",
        outcome: "unknown_retry",
        reasons: [{ code: "VENDOR_LOOKUP_UNAVAILABLE", message: error.message }],
      });
    }
  };
}
