import { createQuickBooksMcpToolClient } from '../mastra/phase2/adapters/mcp-tool-client.ts'
import { QuickBooksMcpAdapter, type QuickBooksMcpPostingConfig } from '../mastra/phase2/adapters/quickbooks-mcp-adapter.ts'

const posting = process.env.QBO_MCP_ENABLE_POSTING?.trim().toLowerCase() === 'true'
const expenseAccountId = process.env.QBO_MCP_EXPENSE_ACCOUNT_ID?.trim()
const realmId = process.env.QBO_MCP_REALM_ID?.trim()
if (posting && !expenseAccountId) throw new Error('QBO_MCP_EXPENSE_ACCOUNT_ID is required when posting is enabled')
if (posting && !realmId) throw new Error('QBO_MCP_REALM_ID is required when posting is enabled')
const config: QuickBooksMcpPostingConfig | undefined = posting ? { realmId: realmId!, expenseAccountId: expenseAccountId!, taxAccountId: process.env.QBO_MCP_TAX_ACCOUNT_ID?.trim(), apAccountId: process.env.QBO_MCP_AP_ACCOUNT_ID?.trim() } : undefined
const client = createQuickBooksMcpToolClient({ enablePosting: posting }), adapter = new QuickBooksMcpAdapter(client, 1000, config)
try { await adapter.verifyTools(); console.log(`QuickBooks MCP ${posting ? 'read and posting' : 'read'} tools verified`) }
finally { await adapter.disconnect() }
