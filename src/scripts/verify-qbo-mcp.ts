import { createQuickBooksMcpToolClient } from '../mastra/phase2/adapters/mcp-tool-client.ts'
import { QuickBooksMcpAdapter } from '../mastra/phase2/adapters/quickbooks-mcp-adapter.ts'

const client = createQuickBooksMcpToolClient(), adapter = new QuickBooksMcpAdapter(client)
try { await adapter.verifyTools(); console.log('QuickBooks MCP required tools verified') }
finally { await adapter.disconnect() }
