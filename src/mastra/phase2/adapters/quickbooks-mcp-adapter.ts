import { z } from 'zod'
import { ProviderUnavailableError, type PurchaseOrderRepository, type VendorLookup, type VendorRepository } from '../ports.ts'
import { mapQboBill, mapQboPurchaseOrder, mapQboVendor, type QboBill, type QboPurchaseOrder, type QboVendor } from './quickbooks-adapter.ts'
import type { McpToolClient } from './mcp-tool-client.ts'

const requiredTools = ['search_vendors', 'search_purchase_orders', 'search_bills'] as const
const ToolResultSchema = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough()
const records = (result: unknown) => {
  const parsed = ToolResultSchema.parse(result), texts = parsed.content.flatMap(item => item.type === 'text' && item.text ? [item.text] : [])
  if (parsed.isError || texts.some(text => text.startsWith('Error '))) throw new Error(texts.join('\n') || 'MCP tool returned an error')
  return texts.flatMap(text => { try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value : [value] } catch { return [] } }).filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value))
}

export class QuickBooksMcpAdapter implements VendorRepository, PurchaseOrderRepository {
  private verification?: Promise<void>
  constructor(private readonly client: McpToolClient, private readonly poLimit = 1000) { if (!Number.isInteger(poLimit) || poLimit < 1 || poLimit > 1000) throw new Error('QuickBooks MCP PO limit must be an integer from 1 to 1000') }
  async verifyTools() {
    const tools = await this.client.listToolNames(), missing = requiredTools.filter(tool => !tools.has(tool))
    if (missing.length) throw new Error(`QuickBooks MCP is missing required tools: ${missing.join(', ')}`)
  }
  private async call(tool: typeof requiredTools[number], params: unknown) {
    try { await (this.verification ??= this.verifyTools()); return records(await this.client.call(tool, { params })) }
    catch (error) { if (error instanceof ProviderUnavailableError) throw error; throw new ProviderUnavailableError('quickbooks-mcp', tool, { cause: error }) }
  }
  async find(input: VendorLookup) {
    const rows = await this.call('search_vendors', { criteria: [{ field: 'DisplayName', value: input.name, operator: '=' }], fetchAll: true })
    return rows.map(row => mapQboVendor(row as QboVendor))
  }
  async findByNumber(poNumber: string) {
    const rows = await this.call('search_purchase_orders', { limit: this.poLimit }), matches = rows.filter(row => row.DocNumber === poNumber)
    if (!matches.length && rows.length === this.poLimit) throw new ProviderUnavailableError('quickbooks-mcp', 'search_purchase_orders result window exhausted')
    return matches.map(row => mapQboPurchaseOrder(row as QboPurchaseOrder))
  }
  async billHistorySeed() { return (await this.call('search_bills', { fetchAll: true })).map(row => mapQboBill(row as QboBill)) }
  disconnect() { return this.client.disconnect() }
}
