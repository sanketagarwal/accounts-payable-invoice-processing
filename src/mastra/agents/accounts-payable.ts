import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  invoiceWorkflow,
  signInvoiceSubmission,
  summarizeDecisions,
} from "../workflows/invoice.ts";
import {
  DecisionReasonSchema,
  InvoiceDraftSchema,
  InvoiceResultSchema,
  type DocumentRef,
  type ReviewerContext,
} from "../invoice/schema.ts";
import { validateExtraction } from "../invoice/validation.ts";

const toolResult = z.object({
  status: z.enum(["processed", "needs_extraction_review", "failed"]),
  runId: z.string().nullable(),
  executionStatus: z.string().nullable(),
  disposition: z.string().nullable().default(null),
  approvalPending: z.boolean(),
  reasons: z.array(z.string()),
  reasonDetails: z.array(DecisionReasonSchema).default([]),
  reviewTypes: z.array(z.string()),
  signals: z.array(z.string()),
  adaptations: z.array(z.string()),
  error: z.string().nullable(),
});
type ToolResult = z.infer<typeof toolResult>;
type WorkflowResult = {
  status: string;
  result?: unknown;
  suspendPayload?: unknown;
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const response = (
  status: ToolResult["status"],
  values: Partial<Omit<ToolResult, "status">> = {},
): ToolResult => ({
  status,
  runId: null,
  executionStatus: null,
  disposition: null,
  approvalPending: false,
  reasons: [],
  reasonDetails: [],
  reviewTypes: [],
  signals: [],
  adaptations: [],
  error: null,
  ...values,
});

const buildExtractionReviewResult = (issues: string[]) =>
  response("needs_extraction_review", {
    runId: null,
    disposition: "verify_extraction",
    reasons: ["EXTRACTION_VALIDATION_FAILED"],
    reasonDetails: issues.map((message) => ({ code: "EXTRACTION_VALIDATION_FAILED", message })),
    reviewTypes: ["verify_extraction"],
  });

const buildSuspendedApprovalResult = (result: WorkflowResult, runId: string): ToolResult => {
  const payload = (isRecord(result.suspendPayload) ? Object.values(result.suspendPayload) : [])
    .map((value) => ApprovalRequestSchema.safeParse(value))
    .find((candidate) => candidate.success)?.data;
  if (!payload) throw new Error("Approval workflow suspended without a valid approval request");
  return response("processed", {
    runId,
    executionStatus: "approval_required",
    disposition: "approval_required",
    approvalPending: true,
    reasons: payload.reasons,
    reasonDetails: payload.reasonDetails,
    reviewTypes: payload.reviewTypes,
    signals: payload.signals,
    adaptations: payload.adaptations,
  });
};

const summarize = (result: WorkflowResult, runId: string) => {
  if (result.status === "suspended") {
    return buildSuspendedApprovalResult(result, runId);
  }
  if (result.status !== "success") {
    return response("failed", {
      runId,
      error: `Workflow ended ${result.status}`,
    });
  }
  const workflowResult = InvoiceResultSchema.parse(result.result);
  return response("processed", {
    runId,
    executionStatus: workflowResult.executionStatus,
    disposition: workflowResult.disposition,
    ...summarizeDecisions(workflowResult),
    error: workflowResult.postingError,
  });
};

const submitInvoice = createTool({
  id: "submit-invoice-for-processing",
  description:
    "Submit fields extracted from one attached invoice into the deterministic AP workflow. Never invent unreadable values.",
  inputSchema: z.object({
    documentId: z.string().trim().min(1).default("chat-upload"),
    source: z.enum(["PDF", "image"]).default("PDF"),
    draft: InvoiceDraftSchema,
  }),
  outputSchema: toolResult,
  execute: async ({ documentId, source, draft }, context) => {
    const requestContext = context?.requestContext as RequestContext<ReviewerContext> | undefined;
    const checked = validateExtraction({ ...draft, source });
    if (!checked.extracted) {
      return buildExtractionReviewResult(checked.issues);
    }
    const document: DocumentRef = {
      id: documentId,
      mimeType: source === "PDF" ? "application/pdf" : "image/jpeg",
      source,
    };
    const unsignedWorkflowInput = {
      rawDocumentRef: document,
      extractedResult: checked.extracted,
    };
    const workflowInput = {
      ...unsignedWorkflowInput,
      submissionSignature: signInvoiceSubmission(unsignedWorkflowInput),
    };
    const run = await invoiceWorkflow.createRun();
    const result = await run.start({ inputData: workflowInput, requestContext });
    return summarize(result, run.runId);
  },
});

const resumeApproval = createTool({
  id: "resolve-invoice-approval",
  description:
    "Approve or reject a previously suspended invoice-processing run after reviewing its result.",
  inputSchema: z.object({
    runId: z.string().trim().min(1),
    approved: z.boolean(),
    comment: z.string().trim().max(1000).optional(),
  }),
  outputSchema: toolResult,
  execute: async ({ runId, approved, comment }, context) => {
    const requestContext = context?.requestContext as RequestContext<ReviewerContext> | undefined;
    const run = await invoiceWorkflow.createRun({ runId });
    const result = await run.resume({
      step: "approve-invoice",
      resumeData: { approved, comment },
      requestContext,
    });
    return summarize(result, runId);
  },
});

export const accountsPayableAgent = new Agent({
  id: "accounts-payable-agent",
  name: "Accounts Payable Agent",
  model: process.env.INVOICE_READER_MODEL ?? "openai/gpt-5.6-sol",
  instructions: `You process one invoice attachment at a time.

For a PDF, PNG, or JPEG:
- Read only values visible in the document. Leave unreadable optional fields empty.
- Include honest overall and field-level confidence. Use indexed line fields such as lines[0].qty.
- Judge confidence from the rendered document, not whether a PDF has a text layer.
- Call submit-invoice-for-processing once, then report its decision and evidence.

Never invent invoice values or accounting IDs.

For approval or rejection, require the run ID in the user's message. Call resolve-invoice-approval once with that run ID and decision. Never infer approval from conversation memory.`,
  memory: new Memory({ options: { lastMessages: 20 } }),
  tools: { submitInvoice, resumeApproval },
});
