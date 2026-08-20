# Accounts Payable Invoice Processing

Drop an invoice into Mastra Studio and let the agent handle the AP work: extract the fields, validate the vendor, match the purchase order and receipt, detect duplicates, apply policy, request approval when needed, and post the bill.

The default demo uses local accounting fixtures, so you can experience the complete workflow without connecting an ERP. QuickBooks is an optional integration when you are ready to work with a sandbox or real accounting data.

## Why we built this

Invoice extraction benefits from a multimodal model, but financial decisions should not depend on model judgment alone. This template combines a conversational Studio agent with deterministic workflow steps, durable approval pauses, provider adapters, and observability.

## Demo

This demo runs in Mastra Studio, but you can connect the agent to your own application using the [Mastra Client SDK](https://mastra.ai/docs/server/mastra-client) or an agentic UI library.

Give the agent one job:

> Process the attached invoice.

Behind the scenes it:

1. Reads the invoice and validates its printed totals.
2. Checks the vendor, PO, goods receipt, sanctions result, and prior invoices.
3. Auto-posts clean invoices or pauses for an explicit approval when policy requires one.
4. Records the decision evidence, posting result, and trace in Studio.

## Features

- PDF, PNG, and JPEG invoice intake in Studio
- Deterministic vendor, PO, receipt, duplicate, and policy controls
- Human approval with persisted suspend-and-resume state
- Safe local fixture provider that requires no accounting credentials
- Optional QuickBooks and Intuit QuickBooks MCP adapters
- Extraction scoring, provider conformance tests, KPI reporting, and Studio observability

## Prerequisites

- Node.js 22.13 or newer
- An [OpenAI API key](https://platform.openai.com/api-keys)

## Quickstart 🚀

1. Create the project:

   ```bash
   npx create-mastra@latest --template accounts-payable-invoice-processing
   cd accounts-payable-invoice-processing
   ```

2. Configure the model:

   ```bash
   cp .env.example .env
   ```

   Add your `OPENAI_API_KEY` to `.env`. The fixture accounting provider is already selected.

3. Start Studio:

   ```bash
   npm run dev
   ```

4. Open [localhost:4111](http://localhost:4111), sign in with any email and the local password `local-development-token`, then select **Accounts Payable Agent**. Attach [`assets/sample-invoice.png`](./assets/sample-invoice.png) and say:

   ```text
   Process the attached invoice.
   ```

The sample matches the included vendor, PO, and goods-receipt fixtures and completes without QuickBooks. If a run requires approval, reply with the run ID in the same message:

```text
Approve invoice run <RUN_ID>. Comment: Reviewed in Studio.
```

## Optional QuickBooks integration

The default fixture provider is the recommended way to explore the template. To connect a QuickBooks sandbox later, see [the advanced guide](./docs/advanced.md#quickbooks-sandbox) and [the live-testing checklist](./docs/quickbooks-testing.md).

Posting remains disabled until you explicitly configure the provider, credentials, account IDs, and single-writer safeguards.

## Making it yours

- Replace the fixture repositories in `src/mastra/phase2/providers` with your accounting and receiving systems.
- Adjust the approval threshold and matching policy in `src/mastra/phase2/adapters/fixture.ts`.
- Change `INVOICE_READER_MODEL` to another document-capable OpenAI model.
- Use the workflow directly when invoices arrive through an API, inbox, or document store instead of Studio chat.

Architecture, security, provider capabilities, testing commands, and deployment notes live in the [advanced guide](./docs/advanced.md).

## About Mastra templates

[Mastra templates](https://mastra.ai/templates) are ready-to-use projects that show off what you can build. They live in the [Mastra monorepo](https://github.com/mastra-ai/mastra) and are automatically synced to standalone repositories.

Want to contribute? See [CONTRIBUTING.md](./CONTRIBUTING.md).
