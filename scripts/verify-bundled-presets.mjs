/** Registry bridge regression; uses shipped upstream YAML without mounting a host. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { settled } from './lib/term-test.mjs'
import { registerBundledPresets } from '../lib/types/dsh-adapter/bundled-presets.js'

function harness(declared = []) {
  const registrations = []
  const effects = []
  const disposed = []
  const makeContext = baseUrl => ({
    baseUrl,
    get(name) {
      if (name === 'loader') return { entries: () => declared }
      if (name === 'agentPresets') return {
        async register(definition) {
          registrations.push({ definition, baseUrl })
          return async () => { disposed.push(definition.id) }
        },
      }
    },
    extend({ baseUrl: next }) { return makeContext(next) },
    effect(effect) { effects.push(effect()) },
  })
  return { ctx: makeContext(new URL('../cordis.patch.yml', import.meta.url).href), registrations, effects, disposed }
}

assert.equal(await registerBundledPresets({ get: () => ({ list() {} }) }), false,
  'legacy directory discovery remains on its existing path')
const fresh = harness()
assert.equal(await registerBundledPresets(fresh.ctx), true)
assert.deepEqual(fresh.registrations.map(row => row.definition.id), ['standard', 'ptc', 'minimal', 'cordis', 'liangshen'])
const standard = fresh.registrations[0]
assert.match(standard.baseUrl, /standard\.patch\.yml$/u)
assert.equal(typeof standard.definition.plugins.find(row => row.id === 'tool-bash').disabled.__jsExpr, 'string',
  'platform expressions must remain unevaluated for the upstream Loader')
const liangshen = fresh.registrations.at(-1).definition
assert.match(liangshen.plugins[0].config.path, /presets[/\\]liangshen[/\\]agent\.cordis\.yml$/u)
for (const dispose of fresh.effects) await dispose()
assert.deepEqual(fresh.disposed, ['standard', 'ptc', 'minimal', 'cordis', 'liangshen'])

const mixed = harness(['standard', 'ptc', 'minimal', 'cordis', 'liangshen'].map(id => ({
  disabled: false, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id } },
})))
assert.equal(await registerBundledPresets(mixed.ctx), true)
assert.deepEqual(mixed.registrations, [], 'profile declarations own their seats before activation completes')
const disabled = harness([{ disabled: true, options: { name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard' } } }])
await registerBundledPresets(disabled.ctx)
assert.equal(disabled.registrations.length, 5)
// A real Cordis dependency appears after the TUI's registration attempt.
const delayed = new Context()
const delayedRegistrations = []
const delayedDisposals = []
try {
  delayed.baseUrl = new URL('../cordis.patch.yml', import.meta.url).href
  await registerBundledPresets(delayed)
  assert.equal(delayedRegistrations.length, 0)
  await delayed.plugin(ctx => {
    ctx.provide('agentPresets', {
      async register(definition) {
        delayedRegistrations.push(definition.id)
        return async () => { delayedDisposals.push(definition.id) }
      },
    })
  })
  assert.ok(await settled(() => delayedRegistrations.length === 5), 'late registry must receive all bundled presets')
} finally {
  await delayed.fiber.dispose()
}
assert.deepEqual(delayedDisposals.sort(), ['cordis', 'liangshen', 'minimal', 'ptc', 'standard'])
console.log('bundled presets OK (official definitions, deferred expressions, profile ownership, legacy, disposal)')
