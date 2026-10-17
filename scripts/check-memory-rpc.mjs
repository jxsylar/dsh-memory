/** Check the Bundle against a DSH checkout or macOS Desktop app, without user profiles or model calls.
 * Usage: node scripts/check-memory-rpc.mjs /absolute/path/to/deepseek-harness
 *        node scripts/check-memory-rpc.mjs '/Applications/DeepSeek Harness.app'
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
if (process.argv[2] !== '--child') {
  assert(process.argv[2], 'Pass the DSH source checkout or macOS Desktop app path')
  const target = resolve(process.argv[2])
  const desktop = target.endsWith('.app')
  const result = spawnSync(desktop ? join(target, 'Contents/MacOS/DeepSeek Harness') : process.execPath,
    desktop ? [script, '--child', join(target, 'Contents/Resources/app.asar/dsh')]
      : ['--import', 'tsx/esm', script, '--child'], {
      cwd: desktop ? undefined : target,
      env: desktop ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      stdio: 'inherit', timeout: 30_000,
    })
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

const desktopRoot = process.argv[3]
if (desktopRoot) {
  // Match the Host's shared package resolution instead of loading a second Cordis tree.
  const parentURL = pathToFileURL(join(desktopRoot, 'package.json')).href
  registerHooks({ resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier.startsWith('@deepseek-ai/')
      ? { ...context, parentURL } : context)
  } })
}
const fromDsh = (source, packaged = source) => import(pathToFileURL(
  desktopRoot ? join(desktopRoot, packaged) : resolve(source),
).href)
const { Context, Inject } = await fromDsh('vendor/cordis/src/index.ts', 'node_modules/@deepseek-ai/cordis/lib/index.js')
const { applyEntryPatches, entryListSchema } = await fromDsh('vendor/include/src/index.ts', 'node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js')
const { HostConnectionService } = await fromDsh('packages/client/connection/src/rpc-host.ts', 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
const { inject: connectionInject } = await fromDsh('packages/client/connection/src/index.ts', 'node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
const { default: yaml } = await fromDsh('node_modules/js-yaml/index.js')
const memory = await import('../lib/index.mjs')
const patches = yaml.load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { schema: entryListSchema })
let warnings = []
const warn = (...args) => warnings.push(args)
const webPatch = desktopRoot ? join(desktopRoot, 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml')
  : resolve('packages/bundle/web-app/cordis.patch.yml')
const webEntries = applyEntryPatches([], yaml.load(readFileSync(webPatch, 'utf8'), { schema: entryListSchema }), () => {})
const original = webEntries.find(entry => entry.id === 'connection')
assert(original, 'Standard Web Connection row must exist')
const patched = applyEntryPatches([original], patches, warn)
assert.equal(warnings.length, 0)
assert.deepEqual(patched[0].config, original.config, 'Preserve authentication and runtime config')
assert.deepEqual(patched[0].inject, ['webStartup', 'webServer'])
for (const dependency of Object.keys(Inject.resolve(original.inject))) {
  assert(dependency in Inject.resolve(patched[0].inject), `Preserve config dependency: ${dependency}`)
}

warnings = []
const headless = applyEntryPatches([], patches, warn)
assert.deepEqual(headless.map(entry => entry.id), ['dsh-memory'])
assert.equal(warnings.length, 1, 'Missing Connection is a skipped-patch warning, not a new Web entry')
warnings = []
const other = { id: 'connection', name: 'another-plugin', inject: ['custom'] }
assert.deepEqual(applyEntryPatches([other], patches, warn)[0], other, 'Do not patch an unrelated id collision')
assert.equal(warnings.length, 1)

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-rpc-check-'))
process.env.DSH_HOME = root
try {
  for (const [label, entry] of [['unpatched', original], ['patched', patched[0]], ['headless', undefined]]) {
    const ctx = new Context()
    const routes = new Map()
    try {
      if (entry) {
        await ctx.plugin({ apply(provider) {
          provider.provide('credentials', {})
          provider.provide('webStartup', { trustedHosts: [] })
          provider.provide('webServer', { register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          } })
        } })
        const inject = Inject.resolve(connectionInject)
        Inject.resolve(entry.inject, inject)
        assert('credentials' in inject)
        await ctx.plugin({ inject, apply(provider) {
          // Authentication is not invoked: this check exercises registration ownership, not HTTP.
          new HostConnectionService(provider, [], {})
        } })
      }
      const fiber = ctx.plugin(memory)
      await fiber.await()
      const failures = []
      // The root may be active while an optional child failed; inspect every child explicitly.
      for (const runtime of ctx.registry.values()) for (const child of runtime.fibers) {
        if (child.state === 3) try { await child.await() } catch (error) { failures.push(error.message) }
      }
      const expectsRoute = entry !== undefined && (
        'webServer' in Inject.resolve(connectionInject) || 'webServer' in Inject.resolve(entry.inject)
      )
      if (entry && !expectsRoute) {
        assert(failures.some(message => message.includes('webServer')))
        assert.equal(routes.has('/memory'), false)
      } else {
        assert.deepEqual(failures, [])
        assert.equal(routes.has('/memory'), expectsRoute)
      }
      assert(ctx.get('memoryStore'), 'MemoryStore must load even without Web')
      await fiber.dispose()
      assert.equal(routes.has('/memory'), false, 'RPC route must be disposed with the plugin')
      console.log(`${label}: passed`)
    } finally {
      await ctx.fiber.dispose()
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
