# Accounts Payable invoice processing

A Mastra template that keeps document reading probabilistic and financial decisions deterministic.

The complete workflow is:

`read invoice → normalize money/references → validate vendor → match PO/receipts → detect duplicates → apply policy`

It stops at a Phase 2 disposition (`auto_post`, `approval_required`, `review`, `blocked`, `retry`, or `verify_extraction`). Human approval suspension and accounting posting belong to Phase 3 and are intentionally not implemented here.

## Run the template

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
npm run phase2:run
npm run dev
```

`INVOICE_READER` is required explicitly. The supplied `.env.example` selects `fixture`, which runs two canned local cases: one straight-through result and one suspended run that resumes with a fixture review. It needs no model API key. `fixtures:score` scores the raw canned extraction before any human correction, then reports field-level fidelity, a mean, and failing case IDs.

The workflow snapshot is persisted through Mastra's configured LibSQL storage at `MASTRA_DB_URL`. Without that variable, the template uses `<project>/data/mastra.db` regardless of the launch directory and creates the directory/database with owner-only permissions. The final workflow output includes `snapshot.rawDocumentRef` and `snapshot.extractedResult`; full workflow state is retained by Mastra for both completed and suspended runs.

Open the URL printed by `mastra dev`, select `apInvoiceWorkflow`, and start it with:

```json
{
  "id": "clean-invoice",
  "mimeType": "application/pdf",
  "source": "PDF",
  "sha256": "fixture-clean"
}
```

The workflow uses local fixtures by default, so this path needs no model or accounting-system credentials. Select `invoiceReaderWorkflow` to inspect Phase 1 alone or `apDecisionWorkflow` to send an existing Phase 1 result directly into Phase 2.

## Phase 1: trusted reader

`INVOICE_READER=fixture` returns canned extractions for deterministic local and CI tests. `INVOICE_READER=vision` sends a real PDF/image to the configured multimodal model:

```bash
INVOICE_READER=vision
INVOICE_READER_MODEL=openai/gpt-5.6-sol
OPENAI_API_KEY=...
INVOICE_ROOT=/absolute/path/to/invoices
npm run invoice:run -- path/to/invoice.pdf
```

The vision reader accepts PDF, PNG, and JPEG files inside `INVOICE_ROOT`, checks file size before reading, verifies magic bytes and checksum, then sends those exact bytes as a multimodal file part. Use a provider/model that supports the document MIME type. The reader never returns ERP IDs, and document source metadata comes from the trusted input rather than the model.

Phase 1 checks dates, currencies, required fields, and printed-amount arithmetic. Model confidence is retained for monitoring and extraction-error routing, but never decides whether financial data is valid.
The workflow only suspends when deterministic reader-integrity checks fail: canonical date, ISO-4217 currency, required values, currency-aware printed-amount arithmetic, or subtotal/line reconciliation. Extended line totals and invoice totals must use the currency's minor-unit precision; unit prices may retain legitimate sub-minor precision and are checked through rounded line reconciliation. Model confidence remains in the result for monitoring but never controls the gate.

### Review and resume

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

## Phase 2: deterministic controls

The Phase 1/2 boundary converts every amount to currency-aware integer minor units (`USD 10.50 → 1050`, `JPY 10 → 10`, `BHD 10.500 → 10500`). Printed `vendorName` and `poNumber` are preserved. Phase 1's fixture `vendorId`/`poId` values become non-authoritative hints and are never sent to QuickBooks or another real provider.

Every step emits stable reason codes, explicit capability adaptations, and per-port source provenance. Provider outages become `unknown_retry`; genuine misses become review outcomes. Low-confidence fields only cause `verify_extraction` when a deterministic mismatch exists.

## Accounting providers

Select one globally at Mastra startup:

```bash
ACCOUNTING_PROVIDER=fixture
```

| Provider | Vendors | POs | Receipts | Bill seed | Bank details | Status | Sanctions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `fixture` | yes | yes | yes | yes | yes | full | yes |
| `quickbooks` | yes | yes | no | yes | no | binary | no |
| `connector` | stub | stub | stub | stub | stub | stub | stub |

Invalid providers and missing required capabilities fail during startup. A disabled capability means its port is absent—it never silently returns an empty result.

### QuickBooks sandbox

```bash
ACCOUNTING_PROVIDER=quickbooks
QBO_REALM_ID=your-sandbox-company-id
QBO_ACCESS_TOKEN=your-oauth-access-token
QBO_BASE_URL=https://sandbox-quickbooks.api.intuit.com
SANCTIONS_SCREENING=fixture
npm run dev
```

`SANCTIONS_SCREENING=fixture` is an explicit demo-only fallback. Replace it with a real standalone `SanctionsScreener` in production. Without a provider sanctions port or an explicitly configured fallback, startup fails.

QuickBooks has no goods-receipt port here, so matching visibly degrades to two-way and emits `GOODS_RECEIPTS_UNAVAILABLE`. It also emits `VENDOR_BANK_DETAILS_UNAVAILABLE`, `VENDOR_STATUS_BINARY`, and the `payment_details_unverifiable` signal where applicable.

### Compose multiple systems

`makeCompositeProvider` assigns each port independently. For example, QuickBooks can supply vendors, POs, and bill history while a receiving system supplies goods receipts. When embedded vendor IDs or PO IDs differ between systems, construction requires the corresponding executable `ReferenceCrosswalk`; otherwise it refuses to start. Decisions record both source IDs.

```ts
const provider = makeCompositeProvider({
  id: 'qbo-receiving',
  displayName: 'QuickBooks + receiving',
  vendors: quickbooksProvider,
  purchaseOrders: quickbooksProvider,
  goodsReceipts: receivingProvider,
  sanctions: sanctionsProvider,
  billHistory: quickbooksProvider,
  identity: { crosswalk },
})
```

### MCP and connector-based accounting software

The registered `connector` provider is deliberately a guarded stub. It defines the seam for accounting products exposed through MCP servers or standard connectors, but selecting it currently fails with `connector provider not yet implemented`.

Later, `makeConnectorProvider` can discover connector tools and map their results behind the same canonical repository ports. The MCP/connector remains a data-access adapter; the deterministic Mastra workflow continues to own validation, matching, retry behavior, evidence, and policy decisions.

## Provider conformance

```bash
npm run providers:conformance
```

The reusable kit verifies canonical Zod outputs, declared-port invariants, genuine not-found behavior, and the distinction between an empty result and a retryable `ProviderUnavailableError`. CI runs it against fixtures. Supply sandbox-specific known/missing cases and a faulting test transport to run it against a live adapter.

To add an accounting system:

1. Implement only the repository ports it can genuinely support.
2. Map raw records to the canonical schemas in the adapter.
3. Declare exact capabilities and identity namespaces.
4. Register a lazy factory.
5. Pass the conformance kit before selecting it.

Pipeline steps never consume raw accounting-system objects or read environment variables.

## Results and storage

Mastra persists workflow state and snapshots through `LibSQLStore` at `MASTRA_DB_URL`. Without that variable it uses the owner-only `<project>/data/mastra.db`. Final output contains the normalized invoice, resolved canonical records, decisions, adaptations, sources, policy, and disposition. The fixture invoice-history repository is intentionally in-memory; a production deployment should bind the pipeline-owned history port to its durable database.

Useful commands:

```bash
npm run fixtures:run
npm run fixtures:score
npm run providers:conformance
npm run phase2:run
npm test
```

Mastra API shapes are verified against the official Mastra Docs MCP before implementation; the pinned package version and lockfile determine the build.
