import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { activeInvoiceRuntime } from "../accounting/providers.ts";
import { ReviewerContextSchema } from "../invoice/schema.ts";
import { normalizeInvoice } from "../invoice/money.ts";
import {
  AssessmentStateSchema,
  DecisionReasonSchema,
  FinalAssessmentSchema,
  InvoiceWorkflowInputSchema,
  NormalizedInvoiceSchema,
  InvoiceResultSchema,
  PostingRequestSchema,
  UnsignedInvoiceWorkflowInputSchema,
  type ApprovalEvidence,
  type FinalAssessment,
  type InvoiceResult,
  type UnsignedInvoiceWorkflowInput,
} from "../invoice/schema.ts";
import { makeDuplicateDetection } from "../invoice/controls/duplicates.ts";
import { makeInvoiceMatch } from "../invoice/controls/matching.ts";
import { makePolicyRouting } from "../invoice/controls/policy.ts";
import { makeVendorValidation } from "../invoice/controls/vendor.ts";

const runtime = activeInvoiceRuntime;
const submissionSecret = randomBytes(32);

const submissionPayload = (input: UnsignedInvoiceWorkflowInput) =>
  JSON.stringify(UnsignedInvoiceWorkflowInputSchema.parse(input));

export const signInvoiceSubmission = (input: UnsignedInvoiceWorkflowInput) =>
  createHmac("sha256", submissionSecret).update(submissionPayload(input)).digest("hex");

const isTrustedSubmission = (input: z.infer<typeof InvoiceWorkflowInputSchema>) => {
  const expected = Buffer.from(signInvoiceSubmission(input), "hex");
  const received = Buffer.from(input.submissionSignature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
};

const normalizeStep = createStep({
  id: "normalize-invoice",
  inputSchema: InvoiceWorkflowInputSchema,
  outputSchema: NormalizedInvoiceSchema,
  execute: async ({ inputData }) => {
    if (!isTrustedSubmission(inputData)) {
      throw new Error("Invoice processing requires a server-validated document submission");
    }
    return normalizeInvoice(inputData);
  },
});

const validateVendor = makeVendorValidation(runtime);
const matchPurchaseOrder = makeInvoiceMatch(runtime);
const detectDuplicates = makeDuplicateDetection(runtime);
const applyPolicy = makePolicyRouting(runtime);

const vendorStep = createStep({
  id: "validate-vendor",
  inputSchema: NormalizedInvoiceSchema,
  outputSchema: AssessmentStateSchema,
  execute: async ({ inputData }) => validateVendor(inputData),
});

const matchingStep = createStep({
  id: "match-purchase-order",
  inputSchema: AssessmentStateSchema,
  outputSchema: AssessmentStateSchema,
  execute: async ({ inputData }) => matchPurchaseOrder(inputData),
});

const duplicateStep = createStep({
  id: "detect-duplicates",
  inputSchema: AssessmentStateSchema,
  outputSchema: AssessmentStateSchema,
  execute: async ({ inputData }) => detectDuplicates(inputData),
});

const policyStep = createStep({
  id: "apply-policy",
  inputSchema: AssessmentStateSchema,
  outputSchema: FinalAssessmentSchema,
  execute: async ({ inputData }) => applyPolicy(inputData),
});

const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  comment: z.string().trim().max(1000).optional(),
});

export const ApprovalRequestSchema = z.object({
  invoiceNumber: z.string(),
  vendorName: z.string(),
  currency: z.string(),
  totalMinor: z.number().int().safe(),
  disposition: z.literal("approval_required"),
  reasons: z.array(z.string()),
  reasonDetails: z.array(DecisionReasonSchema),
  reviewTypes: z.array(z.string()),
  signals: z.array(z.string()),
  adaptations: z.array(z.string()),
  invoiceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const invoiceDigest = (assessment: FinalAssessment) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        invoice: assessment.invoice,
        decisions: assessment.decisions,
        disposition: assessment.disposition,
        policy: assessment.policy,
      }),
    )
    .digest("hex");

const approvalEvidence = (
  assessment: FinalAssessment,
  values: Partial<ApprovalEvidence>,
): ApprovalEvidence => ({
  status: "not_requested",
  reviewerId: null,
  decidedAt: null,
  invoiceDigest: invoiceDigest(assessment),
  comment: null,
  ...values,
});

const workflowResult = (
  assessment: FinalAssessment,
  approval: ApprovalEvidence,
  executionStatus: InvoiceResult["executionStatus"],
): InvoiceResult => ({
  ...assessment,
  executionStatus,
  approval,
  posting: null,
  postingError: null,
});

const approvalStep = createStep({
  id: "approve-invoice",
  inputSchema: FinalAssessmentSchema,
  outputSchema: InvoiceResultSchema,
  suspendSchema: ApprovalRequestSchema,
  resumeSchema: approvalDecisionSchema,
  requestContextSchema: ReviewerContextSchema,
  execute: async ({ inputData, resumeData, requestContext, suspend }) => {
    if (inputData.disposition === "auto_post") {
      return workflowResult(
        inputData,
        approvalEvidence(inputData, {
          status: "not_required",
          decidedAt: new Date().toISOString(),
        }),
        "ready_to_post",
      );
    }

    if (inputData.disposition !== "approval_required") {
      return workflowResult(inputData, approvalEvidence(inputData, {}), "not_postable");
    }

    if (!resumeData) {
      return await suspend({
        invoiceNumber: inputData.invoice.invoiceNumber,
        vendorName: inputData.invoice.vendorName,
        currency: inputData.invoice.currency,
        totalMinor: inputData.invoice.totalMinor,
        disposition: "approval_required",
        reasons: inputData.decisions.flatMap((decision) =>
          decision.reasons.map((reason) => reason.code),
        ),
        reasonDetails: inputData.decisions.flatMap((decision) => decision.reasons),
        reviewTypes: inputData.decisions.flatMap((decision) =>
          decision.reviewType ? [decision.reviewType] : [],
        ),
        signals: inputData.decisions.flatMap((decision) => decision.signals),
        adaptations: inputData.decisions.flatMap((decision) =>
          decision.adaptations.map((adaptation) => adaptation.code),
        ),
        invoiceDigest: invoiceDigest(inputData),
      });
    }

    const reviewerId = requestContext.get("reviewerId");
    if (!reviewerId) throw new Error("An authenticated reviewer is required");

    const approval = approvalEvidence(inputData, {
      status: resumeData.approved ? "approved" : "rejected",
      reviewerId,
      decidedAt: new Date().toISOString(),
      comment: resumeData.comment ?? null,
    });

    return workflowResult(inputData, approval, resumeData.approved ? "ready_to_post" : "rejected");
  },
});

const postingStep = createStep({
  id: "post-invoice",
  inputSchema: InvoiceResultSchema,
  outputSchema: InvoiceResultSchema,
  execute: async ({ inputData }) => {
    if (inputData.executionStatus !== "ready_to_post") return inputData;

    const posting = runtime.provider.posting;
    if (!posting) {
      return {
        ...inputData,
        executionStatus: "posting_unavailable" as const,
        postingError: `${runtime.provider.displayName} is connected read-only`,
      };
    }

    if (!inputData.vendor) {
      return {
        ...inputData,
        executionStatus: "posting_failed" as const,
        postingError: "Validated vendor is missing",
      };
    }

    try {
      const request = PostingRequestSchema.parse({
        idempotencyKey: `ap-${inputData.approval.invoiceDigest}`,
        invoice: inputData.invoice,
        vendor: inputData.vendor,
        purchaseOrder: inputData.purchaseOrder,
        approval: inputData.approval,
      });
      const receipt = await posting.postBill(request);

      await runtime.history.save({
        id: receipt.externalBillId,
        vendorId: inputData.vendor.id,
        invoiceNumber: inputData.invoice.invoiceNumber,
        invoiceDate: inputData.invoice.invoiceDate,
        currency: inputData.invoice.currency,
        totalMinor: inputData.invoice.totalMinor,
        channel: null,
      });

      return {
        ...inputData,
        executionStatus: "posted" as const,
        posting: receipt,
        postingError: null,
      };
    } catch (error) {
      return {
        ...inputData,
        executionStatus: "posting_failed" as const,
        postingError: error instanceof Error ? error.message : "Unknown posting failure",
      };
    }
  },
});

export const invoiceWorkflow = createWorkflow({
  id: "process-invoice",
  inputSchema: InvoiceWorkflowInputSchema,
  outputSchema: InvoiceResultSchema,
  requestContextSchema: ReviewerContextSchema,
  options: { shouldPersistSnapshot: () => true },
})
  .then(normalizeStep)
  .then(vendorStep)
  .then(matchingStep)
  .then(duplicateStep)
  .then(policyStep)
  .then(approvalStep)
  .then(postingStep)
  .commit();
