/** Diagnostic, not a passing safety test: force two processes to read the same generation.
 * Run with Node 24: node --experimental-transform-types scripts/check-memory-concurrency.mjs
 * Uses only a temporary memory root; no DSH profile or model calls.
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { MarkdownMemoryStore } from '../src/memory-store.ts'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const scopeCwd = '/work/concurrency-diagnostic'
const record = name => ({ name, description: name, type: 'project', content: name })

if (process.argv[2] === 'writer') {
  const [, , , root, mode, writer, revision] = process.argv
  const store = new MarkdownMemoryStore(new Context(), root)
  const target = mode === 'global' ? join(root, 'GLOBAL.md')
    : join(store.scopeForCwd(scopeCwd).directory, 'seed-note.md')
  const originalRead = fs.readFileSync
  let gated = false
  fs.readFileSync = function (path, ...args) {
    const result = originalRead.call(this, path, ...args)
    if (!gated && path === target) {
      gated = true
      fs.writeFileSync(join(root, `ready-${writer}`), '')
      const deadline = Date.now() + 10_000
      while (!fs.existsSync(join(root, `release-${writer}`))) {
        if (Date.now() > deadline) throw new Error('Diagnostic barrier timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    return result
  }
  syncBuiltinESMExports()
  try {
    if (mode === 'global') await store.commitGlobal({ expectedRevision: revision, content: writer })
    else await store.commitWorkspace({ scope: store.scopeForCwd(scopeCwd), expectedRevision: revision,
      changes: [{ action: 'put', record: record(writer) }],
    })
    console.log(JSON.stringify({ writer, status: 'committed' }))
  } catch (error) {
    console.log(JSON.stringify({ writer, status: 'rejected', error: error.message }))
  }
} else {
  for (const mode of ['global', 'workspace']) {
    const root = fs.mkdtempSync(join(tmpdir(), 'dsh-memory-concurrency-'))
    const children = []
    try {
      const store = new MarkdownMemoryStore(new Context(), root)
      store.initialize()
      const scope = store.scopeForCwd(scopeCwd)
      await store.commitWorkspace({ scope, expectedRevision: (await store.readWorkspace(scope)).revision,
        changes: [{ action: 'put', record: record('seed-note') }],
      })
      const revision = mode === 'global' ? (await store.readGlobal()).revision : (await store.readWorkspace(scope)).revision
      for (const writer of ['writer-a', 'writer-b']) {
        const child = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(import.meta.url),
          'writer', root, mode, writer, revision], { stdio: ['ignore', 'pipe', 'pipe'] })
        let output = '', errors = ''
        child.stdout.on('data', chunk => { output += chunk })
        child.stderr.on('data', chunk => { errors += chunk })
        const done = new Promise(resolve => {
          child.on('error', error => resolve({ code: -1, output, errors: error.message }))
          child.on('close', code => resolve({ code, output, errors }))
        })
        children.push({ child, done, writer })
      }
      const deadline = Date.now() + 10_000
      while (!children.every(({ writer }) => fs.existsSync(join(root, `ready-${writer}`)))) {
        if (Date.now() > deadline) throw new Error('Writers did not reach the read barrier')
        await pause(10)
      }
      const outcomes = []
      for (const { writer, done } of children) {
        fs.writeFileSync(join(root, `release-${writer}`), '')
        const result = await done
        if (result.code !== 0) throw new Error(result.errors)
        outcomes.push(JSON.parse(result.output))
      }
      const final = mode === 'global' ? (await store.readGlobal()).content.trim()
        : (await store.readWorkspace(scope)).records.map(item => item.name)
      const lostUpdate = outcomes.every(item => item.status === 'committed')
        && (mode === 'global' ? final === 'writer-b' : !final.includes('writer-a'))
      console.log(JSON.stringify({ mode, outcomes, final, lostUpdate }, null, 2))
    } finally {
      for (const { child } of children) if (child.exitCode === null) child.kill()
      await Promise.all(children.map(({ done }) => done))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
