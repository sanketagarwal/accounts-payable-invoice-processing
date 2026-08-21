import { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { z } from "zod";
import {
  ApprovalRequestSchema,
  invoiceWorkflow,
  signInvoiceSubmission,
} from "../workflows/invoice.ts";
import {
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
  reasonDetails: z
    .array(
      z.object({
        code: z.string(),
        message: z.string(),
        evidence: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
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

export const buildExtractionReviewResult = (issues: string[]): ToolResult =>
  toolResult.parse({
    status: "needs_extraction_review",
    runId: null,
    executionStatus: null,
    disposition: "verify_extraction",
    approvalPending: false,
    reasons: ["EXTRACTION_VALIDATION_FAILED"],
    reasonDetails: issues.map((message) => ({ code: "EXTRACTION_VALIDATION_FAILED", message })),
    reviewTypes: ["verify_extraction"],
    signals: [],
    adaptations: [],
    error: null,
  });

export const buildSuspendedApprovalResult = (result: WorkflowResult, runId: string): ToolResult => {
  const payload = (isRecord(result.suspendPayload) ? Object.values(result.suspendPayload) : [])
    .map((value) => ApprovalRequestSchema.safeParse(value))
    .find((candidate) => candidate.success)?.data;
  if (!payload) throw new Error("Approval workflow suspended without a valid approval request");
  return toolResult.parse({
    status: "processed",
    runId,
    executionStatus: "approval_required",
    disposition: "approval_required",
    approvalPending: true,
    reasons: payload.reasons,
    reasonDetails: payload.reasonDetails,
    reviewTypes: payload.reviewTypes,
    signals: payload.signals,
    adaptations: payload.adaptations,
    error: null,
  });
};

const summarize = async (result: WorkflowResult, runId: string, approvalAttempt = false) => {
  if (result.status === "suspended") {
    return buildSuspendedApprovalResult(result, runId);
  }
  if (result.status !== "success") {
    return toolResult.parse({
      status: "failed",
      runId,
      executionStatus: null,
      approvalPending: approvalAttempt,
      reasons: [],
      reviewTypes: [],
      signals: [],
      adaptations: [],
      error: `Workflow ended ${result.status}`,
    });
  }
  const workflowResult = InvoiceResultSchema.parse(result.result);
  const reasonDetails = workflowResult.decisions.flatMap((decision) => decision.reasons);
  const output = toolResult.parse({
    status: "processed",
    runId,
    executionStatus: workflowResult.executionStatus,
    disposition: workflowResult.disposition,
    approvalPending: false,
    reasons: reasonDetails.map((reason) => reason.code),
    reasonDetails,
    reviewTypes: workflowResult.decisions.flatMap((decision) =>
      decision.reviewType ? [decision.reviewType] : [],
    ),
    signals: workflowResult.decisions.flatMap((decision) => decision.signals),
    adaptations: workflowResult.decisions.flatMap((decision) =>
      decision.adaptations.map((adaptation) => adaptation.code),
    ),
    error: workflowResult.postingError,
  });
  return output;
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
    const candidate = { ...draft, source };
    const checked = validateExtraction(candidate);
    if (!checked.extracted) {
      return buildExtractionReviewResult(checked.issues);
    }
    const document: DocumentRef = {
      id: documentId,
      mimeType: source === "PDF" ? "application/pdf" : "image/jpeg",
      source,
      sha256: undefined,
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
    return await summarize(result, run.runId);
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
    return await summarize(result, runId, true);
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
