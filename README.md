# Accounts Payable Invoice Processing

Turn an invoice into a verified AP decision from one Mastra Studio message. The agent reads the document, checks it against accounting data, and either posts the bill or asks for approval.

## Why we built this

Real invoices are inconsistent, and production AP work spans several systems. We built this template to show an agent that coordinates multiple tools, handles that mess, and keeps vendor validation, matching, duplicate detection, approvals, and posting deterministic.

## Features

- Processes PDF, PNG, and JPEG invoices in Studio
- Validates vendors and performs two- or three-way PO matching
- Detects duplicates and routes exceptions for review
- Pauses high-value invoices for explicit approval
- Includes local demo data, conversation memory, and an optional QuickBooks connector

## Quickstart

```bash
npx create-mastra@latest --template accounts-payable-invoice-processing
cd accounts-payable-invoice-processing
cp .env.example .env
# Add OPENAI_API_KEY to .env
npm run dev
```

Open [localhost:4111](http://localhost:4111), select **Accounts Payable Agent**, attach `assets/sample-invoice.png`, and say:

> Process the attached invoice.

The sample invoice matches the included vendor, PO, receipt, and history fixtures, so it runs without an ERP. To approve a suspended invoice, reply with its run ID:

```text
Approve invoice run <RUN_ID>. Comment: Reviewed in Studio.
```

## Connect your accounting data

QuickBooks support is included but optional. Set `ACCOUNTING_PROVIDER=quickbooks-mcp` and the `QBO_MCP_*` variables in `.env`, or implement `AccountingProvider` for another system.

For a QuickBooks sandbox demo, authenticate Intuit's [QuickBooks Online MCP server](https://github.com/intuit/quickbooks-online-mcp-server), then provide its built entry point, token store, and QuickBooks account IDs. Use a unique invoice number that matches an active sandbox vendor and PO. Posted bills appear under **Expenses & bills → Bills**.

## Make it yours

Adjust the fixtures and approval threshold in `src/mastra/accounting/fixture.ts`, or replace the provider in `src/mastra/accounting/providers.ts`.
