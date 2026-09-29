/**
 * CJK 感知的分段 token 估算回归（issue #1170）。
 *
 * 只钉 `src/dsh-adapter/channel/usage.ts` 的 `estimateTokens` 纯函数本身
 * （它如何被投影消费由 scripts/verify-compact.mjs 的中文场景钉住）：
 *
 *   1. 纯 ASCII 与旧口径 `ceil(length / 4)` 逐字节相同——英文会话零变化；
 *   2. 中文/全角按 ~1.4 字符/token 计，不再按 4 低估（旧口径约 2.9x 的低估
 *      就是本 issue 的缺陷本体）；
 *   3. 中英混排落在两段的量级之间，拼接不超两段之和（ceil 次可加）；
 *   4. 单调不减、非负、整数、空串为 0、非空至少 1；
 *   5. 代理对（emoji、CJK 扩展 B）按码点计一次，ZWJ 序列的连接符各算一次；
 *   6. ANSI 转义按 ASCII 计（刻意不剥除：provider 分词的是消息里的字面字节，
 *      不是渲染后的显示格）。
 *
 * 区间依据（系数来源见 usage.ts 顶部注释）：
 *   - ASCII 4 字符/token 是 BPE 英文经验值，也是 pi-nano-context 的既有口径；
 *   - CJK/全角实测 1–1.5 字符/token（一个汉字普遍 1–2 token），取中值 1.4；
 *   - 其它脚本取 2 字符/token 的保守中值（泰文、天城体等更密的脚本仍偏低）。
 *   下面区间断言的容差带（ASCII 3.3–5、CJK 1.1–1.7、other 1.4–2.5 字符/token）
 *   是围绕这些中值给的余量，不是对某个具体 tokenizer 的承诺：这个估算只决定
 *   分段条的构成，占用总量以 provider / `contextPressure` 投影为准。
 *
 * Run: node --import tsx/esm scripts/verify-cjk-token-estimate.ts
 */
import assert from 'node:assert/strict'
import { estimateTokens } from '../src/dsh-adapter/channel/usage.js'

/** 每类字符「每 token 多少个字符」的容差带（下界越密 token 越多）。 */
const ASCII_BAND = { min: 3.3, max: 5 } as const
const CJK_BAND = { min: 1.1, max: 1.7 } as const
const OTHER_BAND = { min: 1.4, max: 2.5 } as const

/**
 * 断言估算落在「字符数 ÷ 每 token 字符数」推出的区间里：估算 ∈
 * [⌈units / max⌉, ⌈units / min⌉]（ceil 单调，所以区间端点可直接换算）。
 * @param units - 参与计数的字符数（BMP 用 length，星平面用码点数）。
 * @param band - 每 token 字符数的容差带。
 * @param value - 实际估算值。
 * @param label - 断言失败时指出是哪个样本。
 */
function assertBand(
  units: number,
  band: { min: number; max: number },
  value: number,
  label: string,
): void {
  const lower = Math.ceil(units / band.max)
  const upper = Math.ceil(units / band.min)
  assert.ok(
    value >= lower && value <= upper,
    `${label}: 估算 ${value} 应落在 [${lower}, ${upper}]（${units} 字符 × ${band.min}–${band.max} 字符/token）`,
  )
}

// ── 样本 ───────────────────────────────────────────────────────────────
const ASCII_TEXT = 'hello world'
const ASCII_HEAD = 'SYSTEM-PROMPT-ABCDEFGH'
const ASCII_LONG = 'x'.repeat(400)
const ASCII_WHITESPACE = ' \n\t'
const CJK_PARAGRAPH = '这是一段中文正文，用来验证分段估算按中文口径计费，而不是英文的四字符一枚。'
const CJK_WORD = '你好世界'
const FULLWIDTH = 'ＡＢＣ１２３'
const KANA = 'ひらがなカタカナ'
const HANGUL = '안녕하세요'
const CJK_EXT_B = '\u{20BB7}'.repeat(10)
const MIXED = '中英混排 mixed text'
const EMOJI = '😀😀😀😀'
const EMOJI_FAMILY = '👨‍👩‍👧‍👦'
const ANSI = '\x1b[38;2;255;0;0mred\x1b[39m'
const ANSI_CJK = `\x1b[1m${CJK_PARAGRAPH}\x1b[22m`
const ALL_SAMPLES = [
  ASCII_TEXT, ASCII_HEAD, ASCII_LONG, ASCII_WHITESPACE, CJK_PARAGRAPH, CJK_WORD,
  FULLWIDTH, KANA, HANGUL, CJK_EXT_B, MIXED, EMOJI, EMOJI_FAMILY, ANSI, ANSI_CJK,
]

// ── 1. 通用不变量：非负、整数、非空至少 1 ──────────────────────────────
assert.equal(estimateTokens(''), 0, '空串估算为 0')
assert.equal(estimateTokens(ASCII_WHITESPACE), 1, '纯空白按 ASCII 计（3 字符 → 1 token）')
for (const sample of ALL_SAMPLES) {
  const value = estimateTokens(sample)
  const label = `样本 ${JSON.stringify(sample.slice(0, 24))}`
  assert.ok(Number.isInteger(value), `${label}: 估算必须是整数，得到 ${value}`)
  assert.ok(value >= 0, `${label}: 估算不得为负，得到 ${value}`)
  assert.ok(value >= 1, `${label}: 非空文本至少 1 token，得到 ${value}`)
}

// ── 2. 纯 ASCII：与旧口径逐字节相同 + 落在英文容差带 ────────────────────
for (const sample of [ASCII_TEXT, ASCII_HEAD, ASCII_LONG, ANSI]) {
  assert.equal(
    estimateTokens(sample),
    Math.ceil(sample.length / 4),
    `纯 ASCII 必须与旧 chars/4 一致：${JSON.stringify(sample.slice(0, 24))}`,
  )
  assertBand(sample.length, ASCII_BAND, estimateTokens(sample), 'ASCII')
}
assert.equal(estimateTokens(ASCII_LONG), 100, '已知样本：400 个 ASCII 字符 = 100 token（4 字符/token）')
assert.equal(estimateTokens(ASCII_HEAD), 6, '已知样本：22 个 ASCII 字符 = 6 token（⌈22/4⌉）')

// ── 3. 中文/全角：⌈字符数 / 1.4⌉，且明显高于旧口径 ─────────────────────
assert.equal(estimateTokens(CJK_WORD), 3, '已知样本：4 个汉字 = 3 token（⌈4/1.4⌉，约 1.33 字符/token）')
assert.equal(
  estimateTokens(CJK_PARAGRAPH),
  Math.ceil(CJK_PARAGRAPH.length / 1.4),
  '纯中文样本 = ⌈字符数 / 1.4⌉',
)
assert.equal(estimateTokens(CJK_PARAGRAPH), 27, '已知样本：37 个中文/全角字符 = 27 token（旧口径 10）')
assertBand(CJK_PARAGRAPH.length, CJK_BAND, estimateTokens(CJK_PARAGRAPH), '中文正文')
assert.ok(
  estimateTokens(CJK_PARAGRAPH) >= 2.5 * Math.ceil(CJK_PARAGRAPH.length / 4),
  `同一段中文应比旧 chars/4 高 ≥2.5x（实得 ${estimateTokens(CJK_PARAGRAPH)} vs ${Math.ceil(CJK_PARAGRAPH.length / 4)}）`,
)
// 全角、假名、谚文走同一档：分类器不是「只认汉字」。
assert.equal(estimateTokens(FULLWIDTH), 5, '全角字母与数字（6 字）按 CJK 档 = 5 token')
assert.equal(estimateTokens(KANA), 6, '假名（8 字）按 CJK 档 = 6 token')
assert.equal(estimateTokens(HANGUL), 4, '谚文音节（5 字）按 CJK 档 = 4 token')
for (const [sample, units] of [[FULLWIDTH, 6], [KANA, 8], [HANGUL, 5]] as const) {
  assertBand(units, CJK_BAND, estimateTokens(sample), `CJK 档 ${JSON.stringify(sample)}`)
}
// 星平面汉字：按码点算一次（20 个 UTF-16 单元 = 10 个码点 → ⌈10/1.4⌉ = 8）。
// 若误按 UTF-16 单元计会得到 15（dense）或 10（other），两者都与 8 不同。
assert.equal(Array.from(CJK_EXT_B).length, 10, '样本前提：扩展 B 汉字 10 个码点')
assert.equal(estimateTokens(CJK_EXT_B), 8, 'CJK 扩展 B 按码点计且归入 CJK 档（⌈10/1.4⌉）')

// ── 4. 中英混排：落在两档之间 + 拼接次可加 ─────────────────────────────
const cjkPart = '中英混排'
assert.equal(Array.from(cjkPart).length, 4, '样本前提：混排样本含 4 个汉字')
assert.equal(
  estimateTokens(MIXED),
  Math.ceil(
    Array.from(cjkPart).length / 1.4 + (MIXED.length - Array.from(cjkPart).length) / 4,
  ),
  '混排 = 汉字按 1.4 + 其余按 4 的加权和',
)
const sameLengthAscii = 'a'.repeat(MIXED.length)
const sameLengthCjk = '中'.repeat(MIXED.length)
assert.ok(
  estimateTokens(sameLengthAscii) < estimateTokens(MIXED)
  && estimateTokens(MIXED) < estimateTokens(sameLengthCjk),
  `等长混排必须严格落在纯 ASCII 与纯中文之间（${estimateTokens(sameLengthAscii)} < ${estimateTokens(MIXED)} < ${estimateTokens(sameLengthCjk)}）`,
)
for (const [left, right] of [
  [ASCII_TEXT, CJK_WORD],
  [cjkPart, ' mixed'],
  [CJK_PARAGRAPH, EMOJI],
  ['', CJK_WORD],
  [ANSI, MIXED],
] as const) {
  const joined = estimateTokens(left + right)
  assert.ok(
    joined >= Math.max(estimateTokens(left), estimateTokens(right)),
    `拼接不得小于任一段：${JSON.stringify((left + right).slice(0, 20))}`,
  )
  assert.ok(
    joined <= estimateTokens(left) + estimateTokens(right),
    `拼接不得超过两段之和（ceil 次可加）：${JSON.stringify((left + right).slice(0, 20))}`,
  )
}

// ── 5. emoji：星平面按码点计一次，ZWJ 连接符各算一次 ────────────────────
assert.equal(Array.from(EMOJI).length, 4, '样本前提：4 个 emoji 码点')
assert.equal(estimateTokens(EMOJI), 2, '4 个 emoji（8 个 UTF-16 单元）= 2 token（码点 × other 档）')
assertBand(4, OTHER_BAND, estimateTokens(EMOJI), 'emoji')
assert.equal(
  estimateTokens(EMOJI_FAMILY),
  Math.ceil(Array.from(EMOJI_FAMILY).length / 2),
  'ZWJ 家族 emoji：7 个码点各计一次（⌈7/2⌉ = 4）',
)
assert.ok(
  estimateTokens(EMOJI_FAMILY) > Math.ceil(EMOJI_FAMILY.length / 4),
  'ZWJ 序列不再被旧 chars/4（11 单元 → 3）低估',
)

// ── 6. ANSI 转义：按 ASCII 计，不剥除也不误判成宽字符 ──────────────────
assert.equal(ANSI.length, 23, '样本前提：15 字节 SGR + red + 5 字节复位 = 23 字符')
assert.equal(estimateTokens(ANSI), 6, '已知样本：23 个 ASCII 转义字符 = 6 token（⌈23/4⌉）')
assert.equal(
  estimateTokens(ANSI_CJK),
  Math.ceil(CJK_PARAGRAPH.length / 1.4 + (ANSI_CJK.length - CJK_PARAGRAPH.length) / 4),
  '包在转义里的中文正文分类不变，只有转义序列按 ASCII 计入',
)

// ── 7. 单调性：逐前缀增长（更长输入不小于更短） ─────────────────────────
for (const [label, text] of [
  ['ASCII', ASCII_LONG],
  ['中文', CJK_PARAGRAPH],
  ['混排', MIXED],
  ['emoji', EMOJI_FAMILY],
  ['ANSI', ANSI_CJK],
] as const) {
  let previous = estimateTokens('')
  for (let end = 1; end <= text.length; end += 1) {
    const current = estimateTokens(text.slice(0, end))
    assert.ok(
      current >= previous,
      `${label} 单调性：前缀 ${end} 的估算 ${current} 不得小于前缀 ${end - 1} 的 ${previous}`,
    )
    previous = current
  }
  assert.equal(previous, estimateTokens(text), `${label}：走到全长后与整串估算一致`)
}

console.log(
  'verify-cjk-token-estimate OK (ASCII == chars/4, CJK ≈1.4 chars/token, mixed weighted, '
  + 'emoji code points, ANSI as ASCII, monotonicity + non-negativity)',
)
