# Accounts Payable invoice reader

Part 1 of the AP workflow: read an invoice, deterministically validate extraction integrity, pause for correction when necessary, resolve mocked references, and persist the workflow snapshot. It intentionally does not validate vendors, match POs/receipts, detect duplicates, route exceptions, or post accounting entries.

## Run locally

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run fixtures:run
npm run fixtures:score
npm run dev
```

`INVOICE_READER` is required explicitly. The supplied `.env.example` selects `fixture`, which runs two canned local cases: one straight-through result and one suspended run that resumes with a fixture review. It needs no model API key. `fixtures:score` scores the raw canned extraction before any human correction, then reports field-level fidelity, a mean, and failing case IDs.

The workflow snapshot is persisted through Mastra's configured LibSQL storage at `MASTRA_DB_URL`. Without that variable, the template uses `<project>/data/mastra.db` regardless of the launch directory and creates the directory/database with owner-only permissions. The final workflow output includes `snapshot.rawDocumentRef` and `snapshot.extractedResult`; full workflow state is retained by Mastra for both completed and suspended runs.

## Vision reader

Set a provider key and switch readers:

```bash
INVOICE_READER=vision
INVOICE_READER_MODEL=openai/gpt-5.6-sol
OPENAI_API_KEY=...
INVOICE_ROOT=/absolute/path/to/invoices
npm run invoice:run -- path/to/invoice.pdf
```

The vision reader accepts PDF, PNG, and JPEG files inside `INVOICE_ROOT`, checks file size before reading, verifies magic bytes and checksum, then sends those exact bytes as a multimodal file part. Use a provider/model that supports the document MIME type. The reader never returns ERP IDs, and document source metadata comes from the trusted input rather than the model.

## Review and resume

The workflow only suspends when deterministic reader-integrity checks fail: canonical date, ISO-4217 currency, required values, currency-aware printed-amount arithmetic, or subtotal/line reconciliation. Model confidence remains in the result for monitoring but never controls the gate.

Resume `verify-invoice` with corrected data, and supply the reviewer identity through Mastra `RequestContext`:

```ts
await run.resume({
  step: 'verify-invoice',
  resumeData: { extracted: correctedInvoice },
  requestContext, // reviewerId is populated here by trusted auth middleware
})
```

For local Studio testing, put `{ "reviewerId": "local-reviewer" }` in the request-context editor. In production, authentication middleware must overwrite this value from the verified principal; never trust a reviewer ID supplied in the correction payload.

Reference resolution happens after review, so corrected vendor names and PO numbers map to fresh `vendorId` and `poId` values. The resolver is deliberately mocked and does not make a vendor-validity decision.

## Layout

- `src/mastra/schemas/`: canonical output, draft, document, and review schemas.
- `src/mastra/agents/`: registered LLM invoice-extraction agent.
- `src/mastra/readers/`: swappable fixture and vision readers.
- `src/mastra/workflows/`: deterministic reader workflow.
- `src/mastra/scorers/`: deterministic `createScorer` fidelity evaluation.
- `src/scripts/`: fixture, scoring, one-file, and test runners.

Mastra API shapes are verified through the Mastra Docs MCP before implementation; local package documentation takes precedence when versions differ.
