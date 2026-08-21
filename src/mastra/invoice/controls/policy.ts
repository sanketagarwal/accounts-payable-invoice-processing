import type { InvoiceRuntime } from "../../accounting/providers.ts";
import { FinalAssessmentSchema, type AssessmentState, type FinalAssessment } from "../schema.ts";

export function makePolicyRouting(runtime: InvoiceRuntime) {
  return async (state: AssessmentState): Promise<FinalAssessment> => {
    const policy = await runtime.policy.getPolicy(),
      outcomes = new Set(state.decisions.map((decision) => decision.outcome));
    const disposition = outcomes.has("blocked")
      ? "blocked"
      : outcomes.has("unknown_retry")
        ? "retry"
        : outcomes.has("verify_extraction")
          ? "verify_extraction"
          : outcomes.has("review")
            ? "review"
            : state.invoice.totalMinor > policy.approvalThresholdMinor
              ? "approval_required"
              : "auto_post";
    const decisions =
      disposition === "approval_required"
        ? [
            ...state.decisions,
            {
              step: "policy",
              outcome: "pass" as const,
              reviewType: null,
              reasons: [
                {
                  code: "APPROVAL_THRESHOLD_EXCEEDED",
                  message: "Invoice total exceeds the configured approval threshold",
                  evidence: {
                    totalMinor: state.invoice.totalMinor,
                    approvalThresholdMinor: policy.approvalThresholdMinor,
                  },
                },
              ],
              signals: [],
              adaptations: [],
              sources: {},
            },
          ]
        : state.decisions;
    return FinalAssessmentSchema.parse({
      ...state,
      decisions,
      disposition,
      policy,
    });
  };
}
