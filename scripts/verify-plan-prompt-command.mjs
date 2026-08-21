/**
 * Channel-level verification of the `/planPrompt` command: the camelCase
 * local command parses, `setPlanPrompt`/`planPromptEnabled` fold the durable
 * `plan-prompt/mode` event, the switch keeps real `plan/mode` state
 * consistent (on enters plan mode, off leaves it), and it never tears down a
 * plan mode the user entered through plain `/plan`.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-plan-prompt-command.mjs
 */
import assert from 'node:assert/strict'
import { createChannel } from '../lib/types/dsh-adapter/channel.js'
import { parseCommandName } from '../lib/types/commands.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- parser ---------------------------------------------------------------
check(
  'parseCommandName accepts the camelCase local command',
  parseCommandName('/planPrompt')?.name === 'planPrompt' &&
  parseCommandName('/planPrompt')?.rawInput === '',
)
const off = parseCommandName('/planPrompt off')
check('parseCommandName preserves /planPrompt off raw input', off?.name === 'planPrompt' && off?.rawInput === ' off')
check('parseCommandName leaves /plan untouched', parseCommandName('/plan')?.name === 'plan')

// ---- channel --------------------------------------------------------------
function makeAgent(handlers, id) {
  const events = []
  const appended = []
  const session = {
    id,
    seq: 0,
    events,
    append(type, data) {
      appended.push({ type, data })
      const event = { type, seq: events.length + 1, time: Date.now(), data }
      events.push(event)
      handlers.get('session/event')?.(session, event)
    },
  }
  return {
    agent: { id: `agent-${id}`, status: 'idle', session, ctx: { on: () => () => {} } },
    events,
    appended,
  }
}

function makeEnv(agentPreset) {
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const { agent, events, appended } = makeAgent(handlers, 's1')
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset,
  })
  return { channel, events, appended, session: agent.session }
}

{
  const { channel, appended } = makeEnv('liangshen')
  check('fresh Liangshen session starts with injection off', channel.planPromptEnabled() === false)
  check('/planPrompt is listed only for Liangshen', channel.commandList.some(command => command.name === 'planPrompt'))

  check('setPlanPrompt(true) returns true', channel.setPlanPrompt(true) === true)
  check('injection enabled after setPlanPrompt(true)', channel.planPromptEnabled() === true)
  check(
    'enabling appends prompt switch on + real plan mode on',
    appended.length === 2 &&
    appended[0].type === 'plan-prompt/mode' && appended[0].data.active === true &&
    appended[1].type === 'plan/mode' && appended[1].data.active === true,
    JSON.stringify(appended),
  )

  check('setPlanPrompt(false) returns false', channel.setPlanPrompt(false) === false)
  check('injection disabled after setPlanPrompt(false)', channel.planPromptEnabled() === false)
  check(
    'disabling appends prompt switch off + real plan mode off',
    appended.length === 4 &&
    appended[2].type === 'plan-prompt/mode' && appended[2].data.active === false &&
    appended[3].type === 'plan/mode' && appended[3].data.active === false,
    JSON.stringify(appended),
  )
}

{
  // Build the plan-only case with an explicit pre-existing plan/mode event:
  // fresh env, pre-append plan mode on, then /planPrompt off must be a no-op
  // for both the prompt switch and plan state.
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const { agent, appended } = makeAgent(handlers, 's2')
  const session = agent.session
  session.append('plan/mode', { active: true })
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset: 'liangshen',
  })
  const before = appended.length
  check('plan-only session starts with prompt switch off', channel.planPromptEnabled() === false)
  check('setPlanPrompt(false) on a plan-only session returns false', channel.setPlanPrompt(false) === false)
  check(
    '/planPrompt off leaves plain /plan mode untouched',
    appended.length === before,
    JSON.stringify(appended.slice(before)),
  )
  check(
    'plain plan/mode event is still the last plan event',
    appended[before - 1].type === 'plan/mode' && appended[before - 1].data.active === true,
    JSON.stringify(appended),
  )
}

{
  // A plan-mode exit that did not come from /planPrompt (exit_plan_mode
  // approval or /plan off) must clear the stale prompt switch.
  const { channel, session, appended } = makeEnv('liangshen')
  channel.setPlanPrompt(true)
  appended.length = 0
  session.append('plan/mode', { active: false })
  check(
    'external plan-mode exit clears the /planPrompt switch',
    channel.planPromptEnabled() === false &&
    appended.some(entry => entry.type === 'plan-prompt/mode' && entry.data.active === false),
    JSON.stringify(appended),
  )
}

{
  // A resumed log from before this fix can contain prompt-on after plan-off.
  // Binding the channel must normalize the stale switch back to off.
  const handlers = new Map()
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    get() {
      return undefined
    },
    logger: { warn() {} },
  }
  const { agent, appended } = makeAgent(handlers, 's3')
  agent.session.append('plan/mode', { active: false })
  agent.session.append('plan-prompt/mode', { active: true })
  const channel = createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
    agentPreset: 'liangshen',
  })
  check('stale resume switch is normalized to off', channel.planPromptEnabled() === false)
  check(
    'stale normalization appends one clearing event',
    appended.slice(2).some(entry => entry.type === 'plan-prompt/mode' && entry.data.active === false),
    JSON.stringify(appended.slice(2)),
  )
}

{
  const { channel, appended } = makeEnv('standard')
  check('setPlanPrompt is undefined outside Liangshen', channel.setPlanPrompt(true) === undefined)
  check('/planPrompt is not listed outside Liangshen', !channel.commandList.some(command => command.name === 'planPrompt'))
  check('non-Liangshen switch appends nothing', appended.length === 0, JSON.stringify(appended))
}

if (failed > 0) process.exit(failed)
console.log('planPrompt command channel verified (camelCase parse, prompt+plan consistency, /plan untouched)')
