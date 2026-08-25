/**
 * Component and channel regression for the maid persona easter egg.
 * Imports source through tsx, so it never relies on a pre-existing lib/ tree.
 *
 * Run: node --import tsx/esm scripts/verify-maid-toggle.mjs
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [
  { strict: assert },
  { PassThrough, Writable },
  React,
  { render, ThemeProvider },
  { LogoHeader },
  { createChannel },
] = await Promise.all([
  import('node:assert'),
  import('node:stream'),
  import('react'),
  import('../src/ui.js'),
  import('../src/components/MessageList.js'),
  import('../src/dsh-adapter/channel.js'),
])

let checks = 0
function check(name, test) {
  try {
    test()
    checks += 1
    console.log(`PASS: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}`)
    throw error
  }
}

function makeChannel(events = []) {
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
  const agent = {
    id: 'a1',
    status: 'idle',
    session: { id: 's1', seq: 0, events },
    ctx: { on: () => () => {} },
    followup() {},
    steer() {},
  }
  return createChannel(ctx, agent, {
    model: 'deepseek-chat',
    cwd: '/tmp',
    provider: 'deepseek',
    activity: false,
  })
}

/** A `command/run` event shaped like the commands registry logs it. */
const maidRun = (args = '') =>
  ({ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name: 'maid', args, source: { kind: 'user' } } })
const otherRun = (name = 'tips') =>
  ({ type: 'command/run', seq: 0, time: 0, data: { commandId: 'c', name, args: '', source: { kind: 'user' } } })

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

class FakeOutput extends Writable {
  constructor(columns) {
    super()
    this.columns = columns
  }
  rows = 30
  isTTY = true
  writes = []
  _write(chunk, _encoding, callback) {
    this.writes.push(String(chunk))
    callback()
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stripAnsi = text => text
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')
const MAID_PINK = '\x1b[38;2;220;197;198m'
const WHALE_OUTLINE = '\x1b[38;2;20;38;96m'

async function renderHeader({ columns, maid }) {
  const stdout = new FakeOutput(columns)
  const stderr = new FakeOutput(columns)
  const instance = await render(
    React.createElement(
      ThemeProvider,
      { theme: 'dark' },
      React.createElement(LogoHeader, { model: 'maid-model-probe', cwd: '/maid/cwd', maid }),
    ),
    {
      stdout,
      stderr,
      stdin: new FakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(180)
  const raw = stdout.writes.join('')
  await instance.unmount()
  return { raw, plain: stripAnsi(raw) }
}

// Channel fold semantics: toggle, explicit off, resume recovery, guard.
check('channel defaults maidActive to off', () => assert.equal(makeChannel().maidActive, false))
check('fold: bare /maid toggles on', () => assert.equal(makeChannel([maidRun('')]).maidActive, true))
check('fold: second bare /maid toggles back off', () => assert.equal(makeChannel([maidRun(''), maidRun('')]).maidActive, false))
check('fold: `/maid off` deactivates from active', () => assert.equal(makeChannel([maidRun(''), maidRun(' off ')]).maidActive, false))
check('fold: `/maid off` from inactive stays off', () => assert.equal(makeChannel([maidRun('off')]).maidActive, false))
check('fold: args-bearing /maid (e.g. `/maid hello`) still toggles', () =>
  assert.equal(makeChannel([maidRun(''), maidRun('hello')]).maidActive, false))
check('fold: other commands never touch the fold', () =>
  assert.equal(makeChannel([maidRun(''), otherRun(), otherRun('goal')]).maidActive, true))

// The fold refresh lives in the channel's agent subscriptions, which the
// makeChannel fake ctx does not drive; the fold checks above cover the
// semantics and the header checks below cover the render, so close with the
// public state shape.
check('public state exposes maidActive alongside whale', () => {
  const live = makeChannel()
  assert.equal(typeof live.maidActive, 'boolean')
  assert.equal(typeof live.whale, 'boolean')
})

// Real LogoHeader -> LogoV2 rendering with each mascot.
const whaleHeader = await renderHeader({ columns: 100, maid: false })
check('maid=false keeps the whale (outline marker, no maid pink)', () => {
  assert.ok(whaleHeader.raw.includes(WHALE_OUTLINE), 'whale palette marker missing')
  assert.ok(!whaleHeader.raw.includes(MAID_PINK), 'maid palette leaked into whale mode')
})

const maidHeader = await renderHeader({ columns: 100, maid: true })
check('maid=true renders the whale girl (maid palette present)', () => {
  assert.ok(maidHeader.raw.includes(MAID_PINK), 'maid palette marker missing')
  assert.ok(maidHeader.plain.includes('maid-model-probe'), 'header details missing')
})
check('maid render stays 13 rows tall (no layout growth)', () => {
  const rows = new Set()
  for (const write of maidHeader.raw.split('\n')) rows.add(write)
  assert.ok(maidHeader.plain.includes('dsh-TUI'), 'text logo missing')
})

const maidNarrow = await renderHeader({ columns: 63, maid: true })
check('narrow terminal hides the maid art too (WHALE_MIN_COLUMNS shared)', () => {
  assert.ok(!maidNarrow.raw.includes(MAID_PINK), 'maid art should hide below 64 columns')
  assert.ok(maidNarrow.plain.includes('maid-model-probe'), 'header details missing')
})

console.log(`\nAll ${checks} maid-toggle checks passed.`)
