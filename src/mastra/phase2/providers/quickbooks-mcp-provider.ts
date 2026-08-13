import { createQuickBooksMcpToolClient, type McpToolClient } from '../adapters/mcp-tool-client.ts'
import { QuickBooksMcpAdapter } from '../adapters/quickbooks-mcp-adapter.ts'
import { assertProvider, type AccountingProvider } from './types.ts'

export function makeQuickBooksMcpProvider(client: McpToolClient = createQuickBooksMcpToolClient()): AccountingProvider {
  const adapter = new QuickBooksMcpAdapter(client)
  return assertProvider({
    id: 'quickbooks-mcp', displayName: 'QuickBooks Online MCP',
    capabilities: { vendors: true, vendorBankDetails: false, vendorStatusRichness: 'binary', purchaseOrders: true, goodsReceipts: false, billHistory: true, sanctions: false, invoiceChannel: false, posting: false },
    vendors: adapter, purchaseOrders: adapter, billHistorySeed: () => adapter.billHistorySeed(),
    identityNamespaces: { vendors: 'quickbooks', purchaseOrders: 'quickbooks', purchaseOrderVendorIds: 'quickbooks', billHistoryVendorIds: 'quickbooks' },
  })
}
