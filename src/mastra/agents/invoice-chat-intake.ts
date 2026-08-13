import { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { apDecisionWorkflow } from '../phase2/workflow.ts'
import { apExecutionWorkflow } from '../phase3/workflow.ts'
import { InvoiceDraftSchema, type ReviewerContext } from '../schemas/invoice.ts'
import { validateExtraction } from '../validation/extraction-checks.ts'

const toolResult = z.object({
  status: z.enum(['processed', 'needs_extraction_review', 'failed']), runId: z.string().nullable(), executionStatus: z.string().nullable(),
  approvalPending: z.boolean(), reasons: z.array(z.string()), error: z.string().nullable(),
})

const summarize = (result: any, runId: string) => {
  if (result.status === 'suspended') return toolResult.parse({ status: 'processed', runId, executionStatus: 'approval_required', approvalPending: true, reasons: Object.values(result.suspendPayload ?? {}).flatMap((value: any) => value.reasons ?? []), error: null })
  if (result.status !== 'success') return toolResult.parse({ status: 'failed', runId, executionStatus: null, approvalPending: false, reasons: [], error: `Workflow ended ${result.status}` })
  return toolResult.parse({ status: 'processed', runId, executionStatus: result.result.executionStatus, approvalPending: false, reasons: result.result.decisions.flatMap((decision: { reasons: Array<{ code: string }> }) => decision.reasons.map(reason => reason.code)), error: result.result.postingError })
}

const submitInvoice = createTool({
  id: 'submit-invoice-for-processing',
  description: 'Submit fields extracted from one attached invoice into the deterministic AP workflow. Never invent unreadable values.',
  inputSchema: z.object({ documentId: z.string().trim().min(1).default('chat-upload'), source: z.enum(['PDF', 'image']).default('PDF'), draft: InvoiceDraftSchema }), outputSchema: toolResult,
  execute: async ({ documentId, source, draft }, context) => {
    const requestContext = context?.requestContext as RequestContext<ReviewerContext> | undefined
    const candidate = { ...draft, source }
    const checked = validateExtraction(candidate)
    if (!checked.extracted) return toolResult.parse({ status: 'needs_extraction_review', runId: null, executionStatus: null, approvalPending: false, reasons: checked.issues, error: null })
    const document = { id: documentId, mimeType: source === 'PDF' ? 'application/pdf' : 'image/jpeg', source, sha256: undefined }
    const phase1 = { rawDocumentRef: document, extractedResult: checked.extracted, checks: { passed: true, issues: [] }, reviewerId: null, vendorId: null, poId: null, snapshot: { rawDocumentRef: document, extractedResult: checked.extracted } }
    const decisionRun = await apDecisionWorkflow.createRun()
    const decision = await decisionRun.start({ inputData: phase1 })
    if (decision.status !== 'success') return toolResult.parse({ status: 'failed', runId: decisionRun.runId, executionStatus: null, approvalPending: false, reasons: [], error: `Decision workflow ended ${decision.status}` })
    const executionRun = await apExecutionWorkflow.createRun()
    const execution = await executionRun.start({ inputData: decision.result, requestContext })
    return summarize(execution, executionRun.runId)
  },
})

const resumeApproval = createTool({
  id: 'resolve-invoice-approval', description: 'Approve or reject a previously suspended invoice-processing run after reviewing its result.',
  inputSchema: z.object({ runId: z.string().trim().min(1), approved: z.boolean(), comment: z.string().trim().max(1000).optional() }), outputSchema: toolResult,
  execute: async ({ runId, approved, comment }, context) => {
    const requestContext = context?.requestContext as RequestContext<ReviewerContext> | undefined
    const run = await apExecutionWorkflow.createRun({ runId })
    const result = await run.resume({ step: 'approve-invoice', resumeData: { approved, comment }, requestContext })
    return summarize(result, runId)
  },
})

export const invoiceChatIntakeAgent = new Agent({
  id: 'invoice-chat-intake-agent', name: 'Invoice chat intake agent', model: process.env.INVOICE_READER_MODEL ?? 'openai/gpt-5.6-sol',
  instructions: `Process one invoice attachment at a time. Read only values visibly printed on the attached PDF, PNG, or JPEG; use null or omit fields that are unreadable. Then call submit-invoice-for-processing exactly once with the extracted draft. Never invent vendor IDs, PO IDs, accounting IDs, or values. Report the returned disposition plainly. If it reports approvalPending, present the runId and wait for an authenticated reviewer to explicitly approve or reject it; only then call resolve-invoice-approval.`,
  tools: { submitInvoice, resumeApproval },
})
