/**
 * PromptInput 折行光标回归（perf/prompt-input-wrap）：wrapToWidth 记忆化后
 * caretVisualLine / caretCharCol / caretVisualCol 全部从 memo 化的 prefixRows
 * 派生。本脚本在窄终端（20 列，内容宽 17）让输入真实折行，断言硬件光标
 * 始终停在反色 caret 格上（useDeclaredCursor 的承诺），且窗口滚动把 caret
 * 行留在屏内：
 *   1. 8 个 CJK（16 列）单行：caret 在行 0，光标 == 反色 caret 格
 *   2. 第 9 个 CJK（18 列 > 17）触发折行：反性格下移一行，光标仍重合
 *   3. 折行后继续输入 ASCII：行中混合宽度，光标重合
 *   4. Home：caret 回行 0，反性格回到首行，光标重合
 *   5. 51 个 CJK（7 视觉行 > MAX_VISIBLE_LINES=5）：窗口下滚，caret 行仍在
 *      屏内且光标重合；Home 后窗口回滚，反性格上移回首行区域
 * 运行：node --import tsx/esm scripts/verify-prompt-wrap-caret.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { PromptInput }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeHarness(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  // 交叉类型：既满足 render() 的 tty 流类型，又保留测试写入/光标访问。
  const stdout = new FakeStdout() as FakeStdout & NodeJS.WriteStream
  const stdin = new FakeStdin() as FakeStdin & NodeJS.ReadStream
  /** 硬件光标落点（useDeclaredCursor 的声明目标）。 */
  const cursor = () => ({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY })
  /** 屏幕上第一个反色格（聚焦 caret 的渲染形态）。 */
  const findInverseCell = (): { x: number; y: number } | undefined => {
    const buf = term.buffer.active
    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(y)
      if (!line) continue
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (cell && cell.isInverse()) return { x, y }
      }
    }
    return undefined
  }
  return { stdout, stdin, cursor, findInverseCell }
}

// channel mock 与 verify-word-jump.mjs 同款：PromptInput 只消费这些面。
const submitted: string[] = []
const channel = {
  mode: { id: 'default', plan: false },
  modeIndex: 0,
  cycleMode() {},
  commandList: [],
  commandCompletions: () => [],
  notifications: [],
  pending: [],
  working: false,
  notify() {},
  submit(text: string) { submitted.push(text) },
  steer() {},
  interruptAndDeliver() {},
  removePending() {},
  stageImage() {},
  listFiles: async () => [],
}

let failures = 0
const report = (name: string, ok: boolean, detail: string) => {
  if (ok) console.log(`PASS  ${name}`)
  else { failures++; console.log(`FAIL  ${name} — ${detail}`) }
}

/** 核心断言式：硬件光标与反色 caret 格重合，返回该格坐标。 */
const expectAnchored = (label: string, inv: { x: number; y: number } | undefined, cur: { x: number; y: number }) => {
  report(label, Boolean(inv) && cur.x === inv!.x && cur.y === inv!.y,
    `inverse=${JSON.stringify(inv)} cursor=${JSON.stringify(cur)}`)
  return inv
}

// ── 场景 1-5：单实例顺序驱动（20 列终端，inputWidth = 17）─────────────────
{
  const { stdout, stdin, cursor, findInverseCell } = makeHarness(20, 24)
  const app = await render(
    React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand: () => false,
      selectionActive: false,
    }),
    { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)

  const feed = async (seq: string) => { stdin.write(seq); await sleep(400) }

  // 场景 1：8 个 CJK = 16 列 ≤ 17，单行，caret 行 0。
  await feed('一二三四五六七八')
  let inv = expectAnchored('single CJK row: cursor anchored on inverse caret cell', findInverseCell(), cursor())

  // 场景 2：第 9 个 CJK（18 列 > 17）触发折行 —— caret 移到视觉行 1。
  await feed('九')
  const invBeforeWrap = inv
  inv = findInverseCell()
  report('wrap boundary: inverse caret cell moved down one row', Boolean(inv) && Boolean(invBeforeWrap) && inv!.y === invBeforeWrap!.y + 1,
    `before=${JSON.stringify(invBeforeWrap)} after=${JSON.stringify(inv)}`)
  expectAnchored('after wrap: cursor anchored on inverse caret cell', inv, cursor())

  // 场景 3：折行后行中混合宽度（'九ab'），caret 在 b 之后。
  await feed('ab')
  expectAnchored('mid-row mixed CJK+ASCII: cursor anchored', findInverseCell(), cursor())

  // 场景 4：Home —— caret 回行 0 之首，反性格回到首行。
  await feed('\x1b[H')
  const invHome = findInverseCell()
  report('Home: inverse caret cell back on first row', Boolean(invHome) && Boolean(inv) && invHome!.y === inv!.y - 1,
    `home=${JSON.stringify(invHome)} prev=${JSON.stringify(inv)}`)
  expectAnchored('Home: cursor anchored on inverse caret cell', invHome, cursor())

  // 场景 5：51 个 CJK = 102 列 → 7 视觉行 > MAX_VISIBLE_LINES(5)，窗口下滚；
  // caret 行必须仍在屏内（反性格存在），随后 Home 令窗口回滚上移。
  await feed('永'.repeat(51))
  const invLong = findInverseCell()
  report('long wrap (7 rows > 5): caret row still on screen', Boolean(invLong), JSON.stringify(invLong))
  expectAnchored('long wrap: cursor anchored on inverse caret cell', invLong, cursor())
  await feed('\x1b[H')
  const invLongHome = findInverseCell()
  report('long wrap + Home: window scrolled back up', Boolean(invLongHome) && Boolean(invLong) && invLongHome!.y < invLong!.y,
    `home=${JSON.stringify(invLongHome)} prev=${JSON.stringify(invLong)}`)
  expectAnchored('long wrap + Home: cursor anchored', invLongHome, cursor())

  app.unmount()
  await sleep(100)
}

if (failures > 0) {
  console.error(`verify-prompt-wrap-caret: ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('verify-prompt-wrap-caret OK')
