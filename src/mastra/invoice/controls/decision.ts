import type { AssessmentState, StepDecision } from "../schema.ts";

type DecisionInput = Pick<StepDecision, "step" | "outcome" | "reasons"> &
  Partial<Omit<StepDecision, "step" | "outcome" | "reasons">>;

export function decide(state: AssessmentState, input: DecisionInput) {
  state.decisions.push({
    reviewType: null,
    signals: [],
    adaptations: [],
    sources: {},
    ...input,
  });
  return state;
}
