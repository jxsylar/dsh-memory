/** Evaluation-only one-shot app for Consolidator Session metrics and termination. */

import { readFile } from 'node:fs/promises'

export const name = 'locomo-session-recorder'
export const inject = ['loader', 'sessionPersistence']

export function apply(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('locomo recorder must run through the dsh launcher')
  void run(ctx).then(() => exit(0), error => {
    process.stderr.write(`dsh-locomo recorder: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}

async function run(ctx) {
  await ctx.get('loader')?.await()
  await inspectSessions(ctx, requiredEnv('DSH_LOCOMO_INSPECTION_FILE'))
}

async function inspectSessions(ctx, inputPath) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('sessionPersistence is unavailable')
  const input = JSON.parse(await readFile(inputPath, 'utf8'))
  if (!Array.isArray(input.sessionIds) || input.sessionIds.some(id => typeof id !== 'string')) {
    throw new TypeError('inspection input must contain a string sessionIds array')
  }
  const metrics = []
  for (const sessionId of input.sessionIds) {
    const inspected = await persistence.inspect(sessionId)
    metrics.push(collectSessionMetrics(sessionId, inspected.events))
  }
  process.stdout.write(`${JSON.stringify(metrics)}\n`)
}

export function collectSessionMetrics(sessionId, events) {
  const usages = []
  const turnStarts = []
  const turnEnds = []
  let finishReason = null
  for (const event of events) {
    if (event.type === 'turn/start' && Number.isFinite(event.time)) turnStarts.push(event.time)
    if (event.type === 'turn/end') {
      if (Number.isFinite(event.time)) turnEnds.push(event.time)
      const kind = event.data?.reason?.kind
      finishReason = typeof kind === 'string' ? kind : null
    }
    if (event.type !== 'assistant/chunk') continue
    const chunk = event.data?.chunk
    if (chunk?.type === 'usage' && isRecord(chunk.usage)) usages.push(structuredClone(chunk.usage))
  }
  const startedAt = turnStarts.length === 0 ? null : Math.min(...turnStarts)
  const completedAt = turnEnds.length === 0 ? null : Math.max(...turnEnds)
  return {
    sessionId,
    modelCalls: usages.length,
    usage: usages,
    finishReason,
    workerElapsedMs: startedAt === null || completedAt === null
      ? null
      : Math.max(0, completedAt - startedAt),
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required`)
  return value
}
