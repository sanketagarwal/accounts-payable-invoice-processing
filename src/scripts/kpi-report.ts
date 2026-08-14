import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ApKpiEvent } from '../mastra/monitoring/ap-kpis.ts'

const path = process.env.AP_KPI_LOG_PATH?.trim() || resolve('data/ap-kpis.ndjson')
const rows: ApKpiEvent[] = (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const completed = rows.filter(row => !row.approvalPending)
const posted = completed.filter(row => row.postingStatus === 'posted' || row.postingStatus === 'already_posted')
const passReasons = new Set(['VENDOR_VALID', 'TWO_WAY_MATCH', 'THREE_WAY_MATCH', 'NO_DUPLICATE'])
const exceptions = Object.entries(rows.flatMap(row => row.reasons).filter(reason => !passReasons.has(reason)).reduce<Record<string, number>>((out, reason) => ({ ...out, [reason]: (out[reason] ?? 0) + 1 }), {}))
console.log(JSON.stringify({ runs: rows.length, straightThroughProcessingRate: completed.length ? posted.length / completed.length : null, posted: posted.length, exceptionCategories: Object.fromEntries(exceptions), pendingApprovals: rows.filter(row => row.approvalPending).length, approvalTime: 'No completed approval decision in the observed backfill', integrationFailures: rows.filter(row => row.integrationFailure).length, processingCost: 'See Mastra Studio Observability for correlated model token/cost metrics', note: 'The initial 10 rows are an observed live-test backfill; new rows are recorded automatically.' }, null, 2))
