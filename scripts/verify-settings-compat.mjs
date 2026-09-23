/**
 * Legacy scopes and 0.1.7 Config-backed settings. Uses source via tsx so the
 * same assertions can run with TSX_TSCONFIG_PATH pointing at upstream sources.
 * Run: node --import tsx/esm scripts/verify-settings-compat.mjs
 */
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import { Config } from '../src/dsh-adapter/index.ts'
import { configValues, createSettingsScope } from '../src/dsh-adapter/compat/settings.ts'
import { createSettingsHosts } from '../src/dsh-adapter/channel/settings-host.ts'

const modernSchema = typeof Schema.boolean().volatile === 'function'
const parsed = Config({ fullscreen: false, whale: false, effortDefault: 'high', statusBar: { model: false } })
const plain = configValues(parsed)
assert.equal(plain.fullscreen, false)
assert.equal(plain.whale, false)
assert.equal(plain.effortDefault, 'high')
assert.equal(plain.statusBar.model, false)
assert.equal(Config.dict.fullscreen.meta.volatile === true, modernSchema)
for (const field of ['sessionId', 'model', 'provider', 'cwd', 'preset']) {
  assert.notEqual(Config.dict[field].meta.volatile, true, `${field} cannot change without agent lifecycle handling`)
}

let update
const ctx = { on(event, handler) {
  assert.equal(event, 'loader/volatile-update')
  update = handler
  return () => { update = undefined }
} }
let current = { fullscreen: false, diffLayout: 'split' }
const scope = createSettingsScope(ctx, {}, 'dsh-tui', Schema.object({}), () => current)
assert.equal(scope.legacy, false)
assert.equal(scope.get().fullscreen, false, 'modern profile inline choice is not a legacy migration')
let observed
const dispose = scope.watch(value => { observed = value })
current = { fullscreen: true, diffLayout: 'unified' }
update()
assert.equal(observed, current, 'watch reads the committed config snapshot')
dispose()
assert.equal(update, undefined, 'watch has an owned disposer')

let registered = 0
let legacyWatch
const legacy = {
  register(ns, schema) {
    assert.equal(this, legacy)
    assert.equal(ns, 'dsh-tui')
    assert.ok(schema)
    registered++
    return { get: () => ({ fullscreen: false }), watch: callback => { legacyWatch = callback; return () => { legacyWatch = undefined } } }
  },
}
const oldScope = createSettingsScope(ctx, legacy, 'dsh-tui', Schema.object({}), () => { throw new Error('legacy host must read its user scope') })
assert.equal(oldScope.legacy, true)
assert.equal(registered, 1)
assert.equal(oldScope.get().fullscreen, false)
const stopOld = oldScope.watch(value => { observed = value })
legacyWatch({ fullscreen: true })
assert.equal(observed.fullscreen, true)
stopOld()
assert.equal(legacyWatch, undefined)

for (const api of ['legacy', 'forms']) {
  const value = { providers: { test: { baseURL: 'https://example.invalid', apiKeyEnv: 'TEST_CREDENTIAL' } } }
  const mutations = []
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, applies: 'live', value }],
    mutate(...args) { mutations.push(args); return Promise.resolve() },
    ...(api === 'legacy' ? { get: () => value } : {}),
  }
  const services = {
    settings,
    credentials: { resolve: async () => undefined, set: async () => {}, unset: async () => {} },
    llm: { listConfigurableProviders: () => [{ settingsNs: 'llm-pi-ai', provider: 'test', displayName: 'Test' }] },
  }
  const hosts = createSettingsHosts({ get: name => services[name] })
  const provider = hosts.providerSetup()
  assert.ok(provider, `${api}: provider wizard is available`)
  assert.equal(provider.routeExists('test'), true)
  assert.equal(provider.routeExists('missing'), false)
  assert.equal(provider.listRefUsers('TEST_CREDENTIAL').length, 1)
  assert.equal(provider.listConfiguredProviders().length, 1)
  const host = hosts.settingsHost()
  assert.equal(host.listNamespaces()[0].revision, 7)
  const ops = [{ op: 'set', path: ['providers', 'test', 'baseURL'], value: 'https://new.invalid' }]
  await host.write('llm-pi-ai', ops, 7)
  assert.deepEqual(mutations, [['llm-pi-ai', ops, 7]], 'writes retain revision fencing and path operations')
}
console.log(`PASS: settings scopes, config snapshots and provider reads (${modernSchema ? 'volatile' : 'legacy'} schema)`)
