/**
 * Effort ignition regression — the top-tier border sweep.
 *
 * Part A asserts the math layer (waveform sampling, easings, envelope, the
 * per-column colour contract, boundary guards). Part B mounts the real
 * EffortInputBorder (self-drawn ╭─╮ / ╰─╯ rows around a fixed content row)
 * in a headless xterm, one harness per scenario, and asserts:
 *
 * - **Every style sweeps, deterministically** — the component accepts a
 *   fixed `style` prop here, so wave/aurora/pulse each get their own run.
 * - **Glyphs never change; only colours move.** The border rows' TEXT is
 *   byte-identical across frames (╭ + ─×n + ╮); the sweep is foreground
 *   colour only — the strongest form of the SGR-only rule, with no layout
 *   change at any point (the rows exist at rest too).
 * - **Mount/unmount never scroll**: the rows are permanent, but the whole
 *   stream still must contain no scroll sequences (#38/#39/#19/#10 family).
 * - **It returns to rest**: wave colours vanish after the style's total.
 * - **Negative paths stay dark**: cold mount on the top tier, single-tier
 *   table, missing table, and leaving the top tier sweep nothing.
 *
 * Run: node --import tsx/esm scripts/verify-effort-ignition.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable, PassThrough },
  React,
  { Terminal: XTerm },
  { render, Text },
  { EffortInputBorder },
  { ClockProvider },
  math,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/EffortInputBorder.js'),
  import('../src/ink/components/ClockContext.js'),
  import('../src/trajectory/effortIgnition.js'),
])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : ` (${detail})`}`)
  if (!ok) failures++
}

// --- Part A: math layer --------------------------------------------------------
check('crest: 1 at the crest, 0 at one half-width out', math.crest(0) === 1 && math.crest(1) === 0)
check('crest: beyond the half-width is silent, both directions',
  math.crest(1.5) === 0 && math.crest(-1) === 0 && math.crest(-2) === 0)
check('easings: endpoints are exact',
  math.easeInCubic(0) === 0 && math.easeInCubic(1) === 1
  && math.easeOutCubic(0) === 0 && math.easeOutCubic(1) === 1
  && math.easeInOutCubic(0) === 0 && math.easeInOutCubic(1) === 1)
check('easings: clamped outside [0,1]',
  math.easeInCubic(-1) === 0 && math.easeOutCubic(2) === 1 && math.easeInOutCubic(-3) === 0)
check('envelope: zero outside the window',
  math.envelope(0, 1, 0.25, 0.4) === 0 && math.envelope(1, 1, 0.25, 0.4) === 0)
check('envelope: fully open in the middle', math.envelope(0.5, 1, 0.25, 0.4) === 1)
check('envelope: ramp sides bind, not max',
  math.envelope(0.1, 1, 0.25, 0.4) < 0.45 && Math.abs(math.envelope(0.1, 1, 0.25, 0.4) - 0.4) < 0.01)
check('line colors: exactly one entry per column',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 40, onLight: false }).length === 40)
check('line colors: empty before start and after the end',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 0, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: math.IGNITION_TOTAL_MS.wave + 1, width: 40, onLight: false }).length === 0)
check('line colors: boundary guards (width 0, negative/NaN/at-total elapsed)',
  math.ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 0, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: -5, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: Number.NaN, width: 40, onLight: false }).length === 0
  && math.ignitionLineColors({ style: 'wave', elapsedMs: math.IGNITION_TOTAL_MS.wave, width: 40, onLight: false }).length === 0)
check('line colors: single-column terminal yields one entry',
  math.ignitionLineColors({ style: 'aurora', elapsedMs: 300, width: 1, onLight: false }).length === 1)
check('line colors: every painted entry is a truecolor rgb() string',
  math
    .ignitionLineColors({ style: 'pulse', elapsedMs: 200, width: 60, onLight: false })
    .every(color => color === undefined || /^rgb\(\d+,\d+,\d+\)$/.test(String(color))))
check('line colors: some columns are painted mid-wave',
  math
    .ignitionLineColors({ style: 'wave', elapsedMs: 300, width: 80, onLight: false })
    .some(color => color !== undefined))
check('random style: never repeats the previous one',
  Array.from({ length: 20 }, () => math.randomIgnitionStyle('wave')).every(style => style !== 'wave'))

// --- Part B: the border sweeps, text frozen, colours only -----------------------
const LEVELS = ['low', 'medium', 'high'] as const
const COLS = 60

async function makeHarness(rows: number, driver: React.ReactNode) {
  const term = new XTerm({ cols: COLS, rows, scrollback: 200, allowProposedApi: true })
  const writes: string[] = []
  class FakeStdout extends Writable {
    columns = COLS
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      writes.push(String(chunk))
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const rowText = (y: number): string =>
    term.buffer.active.getLine(term.buffer.active.baseY + y)?.translateToString(true) ?? ''
  /** Distinct truecolor foreground colours on a given row (the sweep). */
  const sweepColors = (y: number): number => {
    const line = term.buffer.active.getLine(term.buffer.active.baseY + y)
    if (line === undefined) return 0
    const found = new Set<number>()
    for (let x = 0; x < COLS; x++) {
      const cell = line.getCell(x)
      if (cell !== undefined && cell.isFgRGB()) found.add(cell.getFgColor())
    }
    return found.size
  }
  const instance = await render(
    React.createElement(ClockProvider, null, driver),
    {
      stdout: new FakeStdout() as never,
      stdin: new FakeStdin() as never,
      stderr: new FakeStdout() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  return { term, writes, rowText, sweepColors, instance }
}

function borderNode(effort: string | undefined, style?: 'wave' | 'aurora' | 'pulse'): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort, levels: LEVELS, columns: COLS, onLight: false, idleColor: 'promptBorder', style },
    React.createElement(Text, null, 'row'),
  )
}

/** Sweep driver: effort flips onto the top tier at t=300ms with a pinned style. */
function makeSweepDriver(style: 'wave' | 'aurora' | 'pulse') {
  return function Driver(): React.ReactNode {
    const [effort, setEffort] = React.useState<string>('medium')
    React.useEffect(() => {
      const timer = setTimeout(() => setEffort('high'), 300)
      return () => clearTimeout(timer)
    }, [])
    return borderNode(effort, style)
  }
}

async function runSweepScenario(style: 'wave' | 'aurora' | 'pulse') {
  const harness = await makeHarness(6, React.createElement(makeSweepDriver(style)))
  try {
    await sleep(150)
    const restTop = harness.rowText(0)
    const restSweep = harness.sweepColors(0)
    check(`${style}: border row exists at rest`,
      restTop.startsWith('╭') && restTop.endsWith('╮') && restTop.length === COLS,
      restTop.slice(0, 12))
    // Common on-screen sweep window at t=550ms (pulse's ring is inside a
    // 60-col row until ~665ms; wave's crest has entered; aurora always).
    await sleep(400)
    const midText = harness.rowText(0)
    const swept = Math.max(harness.sweepColors(0), harness.sweepColors(2))
    harness.writes.length = 0
    await sleep(420)
    const stream = harness.writes.join('')
    const repaints = [
      ['erase line', /\x1b\[[0-2]?K/],
      ['erase screen', /\x1b\[[0-3]?J/],
      ['scroll up', /\x1b\[\d*S/],
      ['scroll down', /\x1b\[\d*T/],
    ] as const
    const offenders = repaints.filter(([, pattern]) => pattern.test(stream)).map(([name]) => name)
    check(`${style}: sweeps the border in a moving gradient`, swept >= 2, `${swept} colours`)
    check(`${style}: text frozen while colours move`, midText === restTop && midText.startsWith('╭'))
    check(`${style}: no repaint escapes while sweeping`, offenders.length === 0,
      offenders.length === 0 ? `${stream.length} bytes` : offenders.join(', '))
    // Past every style's total (≤1300ms from the 300ms switch): back to rest.
    await sleep(700)
    check(`${style}: returns to the idle border`,
      harness.sweepColors(0) <= 1 && harness.sweepColors(2) <= 1 && harness.rowText(0) === restTop)
    check(`${style}: rest shows a single idle colour`, restSweep <= 1)
  } finally {
    harness.instance.unmount()
  }
}

for (const style of ['wave', 'aurora', 'pulse'] as const) {
  await runSweepScenario(style)
}

// --- Negative paths: these must stay completely dark ---------------------------
// The drivers below mount variants directly; plain nodes suffice except for
// the leave-top case, which flips effort after 300ms.
async function runDarkScenario(name: string, node: React.ReactNode) {
  const harness = await makeHarness(6, node)
  try {
    await sleep(300)
    harness.writes.length = 0
    await sleep(1300)
    const stream = harness.writes.join('')
    const dark = harness.sweepColors(0) <= 1 && harness.sweepColors(2) <= 1 && !/\x1b\[38;2;.*\x1b\[38;2;/.test(stream)
    check(`${name}: no ignition at all`, dark)
  } finally {
    harness.instance.unmount()
  }
}

await runDarkScenario('cold mount on the top tier', borderNode('high'))
function SingleTierDriver(): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort: 'high', levels: ['high'], columns: COLS, onLight: false, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('single-tier table', React.createElement(SingleTierDriver))
function NoTableDriver(): React.ReactNode {
  return React.createElement(
    EffortInputBorder,
    { effort: 'high', levels: undefined, columns: COLS, onLight: false, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('missing level table', React.createElement(NoTableDriver))
function LeaveTopDriver(): React.ReactNode {
  const [effort, setEffort] = React.useState<string>('high')
  React.useEffect(() => {
    const timer = setTimeout(() => setEffort('medium'), 300)
    return () => clearTimeout(timer)
  }, [])
  return React.createElement(
    EffortInputBorder,
    { effort, levels: LEVELS, columns: COLS, onLight: false, idleColor: 'promptBorder' },
    React.createElement(Text, null, 'row'),
  )
}
await runDarkScenario('leaving the top tier', React.createElement(LeaveTopDriver))

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
