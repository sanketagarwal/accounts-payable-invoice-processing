import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { runtimeSources } from "../../accounting/providers.ts";
import { ProviderUnavailableError } from "../../accounting/types.ts";
import { AssessmentStateSchema, type AssessmentState, type StepDecision } from "../schema.ts";

const withinDuplicateWindow = (left: string, right: string) => {
  const elapsed = Math.abs(Date.parse(left) - Date.parse(right));
  return !Number.isFinite(elapsed) || elapsed / 86_400_000 <= 7;
};
export function makeDuplicateDetection(runtime: InvoiceRuntime) {
  const sources = runtimeSources(runtime);
  return async (state: AssessmentState) => {
    if (!state.vendor || state.decisions.some((decision) => decision.outcome !== "pass"))
      return state;
    const adaptations: StepDecision["adaptations"] = [];
    if (!runtime.provider.billHistorySeed)
      adaptations.push({ code: "BILL_HISTORY_SEED_UNAVAILABLE", providerId: runtime.provider.id });
    if (!runtime.provider.capabilities.invoiceChannel)
      adaptations.push({ code: "INVOICE_CHANNEL_UNAVAILABLE", providerId: runtime.provider.id });
    try {
      await runtime.seedHistory();
      const candidates = await runtime.history.findPotentialDuplicates({
        vendorId: state.vendor.id,
        invoiceNumber: state.invoice.invoiceNumber,
        currency: state.invoice.currency,
        totalMinor: state.invoice.totalMinor,
      });
      const duplicates = candidates.filter(
        (candidate) =>
          candidate.invoiceNumber?.trim().toLowerCase() ===
            state.invoice.invoiceNumber.trim().toLowerCase() ||
          (candidate.currency === state.invoice.currency &&
            candidate.totalMinor === state.invoice.totalMinor &&
            withinDuplicateWindow(candidate.invoiceDate, state.invoice.invoiceDate)),
      );
      state.duplicateIds = duplicates.map((invoice) => invoice.id);
      state.decisions.push({
        step: "dedup",
        outcome: duplicates.length ? "review" : "pass",
        reviewType: duplicates.length ? "possible_duplicate" : null,
        reasons: [
          {
            code: duplicates.length ? "POSSIBLE_DUPLICATE" : "NO_DUPLICATE",
            message: duplicates.length
              ? "Potential prior invoice found"
              : "No duplicate invoice found",
            evidence: { invoiceIds: state.duplicateIds },
          },
        ],
        signals: duplicates.length ? ["possible_duplicate"] : [],
        adaptations,
        sources: { billHistory: sources.billHistory },
      });
      return AssessmentStateSchema.parse(state);
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      state.decisions.push({
        step: "dedup",
        outcome: "unknown_retry",
        reviewType: null,
        reasons: [{ code: "HISTORY_UNAVAILABLE", message: error.message }],
        signals: [],
        adaptations,
        sources: { billHistory: sources.billHistory },
      });
      return AssessmentStateSchema.parse(state);
    }
  };
}
