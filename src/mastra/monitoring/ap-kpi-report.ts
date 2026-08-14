import type { ApKpiEvent } from './ap-kpis.ts'

export function buildApKpiReport(rows: ApKpiEvent[]) {
  const grouped = new Map<string, ApKpiEvent[]>()
  for (const row of rows) {
    const key = row.runId ?? `unidentified:${row.recordedAt}`
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }
  const lifecycle = [...grouped.values()]
  const ordered = lifecycle.map(events => [...events].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)))
  const latest = ordered.map(events => events.at(-1)!)
  const completed = latest.filter(row => !row.approvalPending)
  const isPosted = (row: ApKpiEvent) => row.postingStatus === 'posted' || row.postingStatus === 'already_posted'
  const posted = completed.filter(isPosted)
  const straightThrough = completed.filter(row => row.disposition === 'auto_post' && isPosted(row))
  const approvalTimes = ordered.flatMap(events => {
    const pending = events.find(row => row.approvalPending)
    const resolved = pending && events.find(row => !row.approvalPending && Date.parse(row.recordedAt) >= Date.parse(pending.recordedAt))
    return pending && resolved ? [Date.parse(resolved.recordedAt) - Date.parse(pending.recordedAt)] : []
  })
  const passReasons = new Set(['VENDOR_VALID', 'TWO_WAY_MATCH', 'THREE_WAY_MATCH', 'NO_DUPLICATE'])
  const exceptionCategories = latest.flatMap(row => row.reasons).filter(reason => !passReasons.has(reason)).reduce<Record<string, number>>((out, reason) => {
    out[reason] = (out[reason] ?? 0) + 1
    return out
  }, {})
  return {
    runs: latest.length,
    straightThroughProcessingRate: completed.length ? straightThrough.length / completed.length : null,
    posted: posted.length,
    exceptionCategories,
    pendingApprovals: latest.filter(row => row.approvalPending).length,
    approvalTimeMs: approvalTimes.length ? { count: approvalTimes.length, average: approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length } : null,
    integrationFailures: latest.filter(row => row.integrationFailure).length,
    processingCost: 'See Mastra Studio Observability for correlated model token/cost metrics',
  }
}
