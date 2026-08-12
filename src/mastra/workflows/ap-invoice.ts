import { createWorkflow } from '@mastra/core/workflows'
import { FinalAssessmentSchema } from '../phase2/schemas.ts'
import { apDecisionWorkflow } from '../phase2/workflow.ts'
import { DocumentRefSchema } from '../schemas/invoice.ts'
import { invoiceReaderWorkflow } from './invoice-reader.ts'

export const apInvoiceWorkflow = createWorkflow({
  id: 'ap-invoice-workflow', inputSchema: DocumentRefSchema, outputSchema: FinalAssessmentSchema,
  options: { shouldPersistSnapshot: () => true },
}).then(invoiceReaderWorkflow).then(apDecisionWorkflow).commit()
