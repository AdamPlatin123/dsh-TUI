/**
 * Regression: when an absolute OverlayAbove becomes shorter, rows covered by
 * its previous larger rect must be recomposited from the normal-flow content
 * underneath. Clearing the old rect without repainting the underlay leaves a
 * blank band (visible when slash suggestions are filtered or a long panel is
 * replaced by a short one).
 */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, Box, Text },
  { OverlayAbove },
] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/components/OverlayAbove.js'),
  ])

const COLS = 80
const ROWS = 20
const term = new XTerm({
  cols: COLS,
  rows: ROWS,
  scrollback: 200,
  allowProposedApi: true,
})

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    term.write(String(chunk), callback)
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() {
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(
    _chunk: unknown,
    _encoding: BufferEncoding,
    callback: () => void,
  ) {
    callback()
  }
}

type Mode = 'tall' | 'short' | 'removed'

function Fixture({ mode }: { mode: Mode }): React.ReactNode {
  const overlayRows =
    mode === 'tall'
      ? Array.from({ length: 6 }, (_, index) => `OVERLAY-TALL-${index}`)
      : ['OVERLAY-SHORT-0', 'OVERLAY-SHORT-1']
  return (
    <Box flexDirection="column" width={COLS}>
      <Box flexDirection="column">
        {Array.from({ length: 12 }, (_, index) => (
          <Text key={index}>{`UNDERLAY-${String(index).padStart(2, '0')}`}</Text>
        ))}
      </Box>
      <Box height={3} width="100%">
        {mode === 'removed' ? null : (
          <OverlayAbove>
            <Box flexDirection="column">
              {overlayRows.map(row => (
                <Text key={row}>{row}</Text>
              ))}
            </Box>
          </OverlayAbove>
        )}
        <Text>ANCHOR</Text>
      </Box>
      <Text>FOOTER</Text>
    </Box>
  )
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const stdout = new FakeStdout()
const app = await render(<Fixture mode="tall" />, {
  stdout: stdout as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
  exitOnCtrlC: false,
  patchConsole: false,
})

function visibleText(): string {
  const buffer = term.buffer.active
  return Array.from({ length: ROWS }, (_, offset) =>
    buffer.getLine(buffer.baseY + offset)?.translateToString(true) ?? '',
  ).join('\n')
}

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` (${detail})`}`,
  )
  if (!ok) failures += 1
}

await sleep(400)
const initialBufferLength = term.buffer.active.length
let text = visibleText()
check(
  'tall overlay is visible',
  text.includes('OVERLAY-TALL-0') && text.includes('OVERLAY-TALL-5'),
)
check(
  'tall overlay covers its underlay rows',
  !text.includes('UNDERLAY-06') && !text.includes('UNDERLAY-11'),
)

app.rerender(<Fixture mode="short" />)
await sleep(300)
text = visibleText()
check(
  'short overlay is visible',
  text.includes('OVERLAY-SHORT-0') && text.includes('OVERLAY-SHORT-1'),
)
for (let index = 6; index <= 9; index += 1) {
  const marker = `UNDERLAY-${String(index).padStart(2, '0')}`
  check(`vacated row restores ${marker}`, text.includes(marker))
}
check(
  'shrink does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.rerender(<Fixture mode="tall" />)
await sleep(300)
text = visibleText()
check(
  'regrown overlay has no stale short content',
  text.includes('OVERLAY-TALL-0') && !text.includes('OVERLAY-SHORT-0'),
)
check(
  'grow does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.rerender(<Fixture mode="removed" />)
await sleep(300)
text = visibleText()
for (let index = 6; index <= 11; index += 1) {
  const marker = `UNDERLAY-${String(index).padStart(2, '0')}`
  check(`removed overlay restores ${marker}`, text.includes(marker))
}
check(
  'remove does not grow terminal buffer',
  term.buffer.active.length === initialBufferLength,
  `${initialBufferLength} -> ${term.buffer.active.length}`,
)

app.unmount()
process.exit(failures === 0 ? 0 : 1)
