import type { Phase2Runtime } from '../composition.ts'
import { FinalAssessmentSchema, type AssessmentState, type FinalAssessment } from '../schemas.ts'

export function makePolicyRouting(runtime: Phase2Runtime) {
  return async (state: AssessmentState): Promise<FinalAssessment> => {
    const policy = await runtime.policy.getPolicy(), outcomes = new Set(state.decisions.map(decision => decision.outcome))
    const disposition = outcomes.has('blocked') ? 'blocked' : outcomes.has('unknown_retry') ? 'retry' : outcomes.has('verify_extraction') ? 'verify_extraction' : outcomes.has('review') ? 'review' : state.invoice.totalMinor > policy.approvalThresholdMinor ? 'approval_required' : 'auto_post'
    return FinalAssessmentSchema.parse({ ...state, disposition, policy })
  }
}
