import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { ProviderUnavailableError } from "../../accounting/types.ts";
import type { AssessmentState, StepDecision } from "../schema.ts";
import { decide } from "./decision.ts";

const withinSevenDays = (left: string, right: string) => {
  const days = Math.abs(Date.parse(left) - Date.parse(right)) / 86_400_000;
  return !Number.isFinite(days) || days <= 7;
};

export function makeDuplicateDetection(runtime: InvoiceRuntime) {
  const provider = runtime.provider;
  return async (state: AssessmentState) => {
    if (!state.vendor || state.decisions.some(({ outcome }) => outcome !== "pass")) return state;

    const adaptations: StepDecision["adaptations"] = [];
    if (!provider.listBills)
      adaptations.push({ code: "BILL_HISTORY_SEED_UNAVAILABLE", providerId: provider.id });
    if (!provider.invoiceChannelAvailable)
      adaptations.push({ code: "INVOICE_CHANNEL_UNAVAILABLE", providerId: provider.id });

    try {
      await runtime.seedHistory();
      const candidates = await runtime.history.findPotentialDuplicates({
        vendorId: state.vendor.id,
        invoiceNumber: state.invoice.invoiceNumber,
        currency: state.invoice.currency,
        totalMinor: state.invoice.totalMinor,
      });
      state.duplicateIds = candidates
        .filter(
          (invoice) =>
            invoice.invoiceNumber?.trim().toLowerCase() ===
              state.invoice.invoiceNumber.trim().toLowerCase() ||
            (invoice.currency === state.invoice.currency &&
              invoice.totalMinor === state.invoice.totalMinor &&
              withinSevenDays(invoice.invoiceDate, state.invoice.invoiceDate)),
        )
        .map(({ id }) => id);

      const duplicate = state.duplicateIds.length > 0;
      return decide(state, {
        step: "dedup",
        outcome: duplicate ? "review" : "pass",
        reviewType: duplicate ? "possible_duplicate" : null,
        reasons: [
          {
            code: duplicate ? "POSSIBLE_DUPLICATE" : "NO_DUPLICATE",
            message: duplicate ? "Potential prior invoice found" : "No duplicate invoice found",
            evidence: { invoiceIds: state.duplicateIds },
          },
        ],
        signals: duplicate ? ["possible_duplicate"] : [],
        adaptations,
        sources: { billHistory: provider.listBills ? provider.id : "workflow-history" },
      });
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      return decide(state, {
        step: "dedup",
        outcome: "unknown_retry",
        reasons: [{ code: "HISTORY_UNAVAILABLE", message: error.message }],
        adaptations,
        sources: { billHistory: provider.id },
      });
    }
  };
}
