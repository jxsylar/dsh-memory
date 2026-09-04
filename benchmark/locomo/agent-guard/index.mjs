/** Evaluation-only Agent scope: minimal prompt, bounded steps, and memory-only reads. */

import { resolve, sep } from 'node:path'

export const name = 'locomo-agent-guard'
export const inject = ['systemPrompt', 'tools']

const MODES = {
  baseline: {
    tools: [],
    maxSteps: 1,
    prompt: `Answer the direct user question without conversation history or long-term memory.

No memory or filesystem evidence is available in this baseline condition. Do not use tools. Give only the concise best answer; do not discuss the evaluation.`,
  },
  ingest: {
    tools: ['read', 'memory_update'],
    maxSteps: 6,
    prompt: `You process one supplied historical conversation for long-term memory.

Use only the conversation in the direct user message and the provided Memory Context. Read only detailed memory files explicitly linked by the current Workspace index. Save only stable facts that may help in future conversations. Submit at most one atomic Workspace batch and, only when necessary, one complete Global replacement. Do not inspect source code, benchmark data, Session files, configuration, or other filesystem content. When the necessary memory work is complete, reply only with "Done".`,
  },
  qa: {
    tools: ['read'],
    maxSteps: 6,
    prompt: `Answer the direct user question using only the question and the provided Memory Context.

Read only detailed memory files explicitly linked by the current Workspace index. Do not inspect source code, benchmark data, Session files, configuration, or other filesystem content. Give only the concise answer; do not discuss the evaluation.`,
  },
}

export function apply(ctx) {
  const modeName = process.env.DSH_LOCOMO_AGENT_MODE
  if (!Object.hasOwn(MODES, modeName)) {
    throw new Error('DSH_LOCOMO_AGENT_MODE must be baseline, ingest, or qa')
  }
  const mode = MODES[modeName]
  const dshHome = process.env.DSH_HOME
  if (dshHome === undefined || dshHome.trim() === '') {
    throw new Error('DSH_HOME is required by the LoCoMo Agent guard')
  }
  const memoryRoot = resolve(dshHome, 'memory')

  ctx.on('agent/session-start', ({ agent }) => {
    const allowed = new Set(mode.tools)
    agent.ctx.tools.guard((execution) => {
      if (!allowed.has(execution.name)) return `LoCoMo ${modeName} Agent cannot use ${execution.name}.`
      if (execution.name !== 'read') return undefined
      const input = execution.arguments
      const filePath = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input.file_path
        : undefined
      if (typeof filePath !== 'string') return 'LoCoMo read requires file_path.'
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = resolve(cwd, filePath)
      if (target !== memoryRoot && !target.startsWith(`${memoryRoot}${sep}`)) {
        return 'LoCoMo Agents may read only files under the isolated memory root.'
      }
      return undefined
    })
    agent.ctx.systemPrompt.section({
      name: 'locomo:complete-agent-role',
      order: 0,
      complete: true,
      text: mode.prompt,
    })
    agent.ctx.on('agent/pre-step', ({ step }, next) => (
      step > mode.maxSteps ? Promise.resolve({ kind: 'reject' }) : next()
    ))
    // Keep this last: the execution guard, complete role, and step cap remain
    // active even if a future DSH version rejects schema restriction setup.
    agent.ctx.tools.restrict({ allow: mode.tools })
  })
}
