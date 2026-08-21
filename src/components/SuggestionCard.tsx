import React from 'react'
import { Box, Text } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'

/**
 * `/` 命令菜单与 `@` 文件菜单共用的圆角卡片外壳（与输入框 EffortInputBorder
 * 同款 ╭╮╰╯ 视觉语言）：
 *
 *   ╭─ 标题 ─────────────────────╮
 *   │ ❯ 行内容 …                 │
 *   │   行内容 …                 │
 *   │ ↑2 · ↓3                    │  ← 仅当列表被裁剪
 *   ╰────────────────────────────╯
 *
 * 底边 ╰╯ 直接坐在输入框顶边 ╭╮ 的上一行（PromptInput 的浮层包装去掉了
 * 底部留白），卡片与输入框连成一体，读作"挂在输入框上的下拉"。边框色
 * 跟随输入框 idle 色（plan 模式下整套面板一起变 sage 绿）。
 *
 * 每一行的左右 │ 由本组件包在行外——侧边框若是内容列旁的单行 Text，只
 * 会画在自己那一行（行高的首行），多行列表的中段行会裸奔无边框。
 * 卡片左右各占 2 列（│ + 1 空格），行内容的可用宽度由
 * {@link cardContentWidth} 统一计算，CJK 截断契约（verify-cjk-truncate）
 * 按该宽度钉住。
 */
export function SuggestionCard({
  title,
  columns,
  accent,
  footer,
  rows,
}: {
  /** 嵌在顶边框里的标题（已本地化、含计数）。 */
  title: string
  columns: number
  /** 边框色（主题 token）；缺省 promptBorder。 */
  accent?: 'promptBorder' | 'planMode'
  /** 底部 dim 提示行（滚动指示）；null/undefined 时不渲染。 */
  footer?: string | null
  /** 已渲染的行内容（每行一个节点），本组件为各行补上左右边框。 */
  rows: readonly React.ReactNode[]
}): React.ReactNode {
  const inner = Math.max(0, columns - 2)
  const lead = `─ ${title} `
  // 标题放不下（极窄终端）时退化为素边框，不做半截标题。
  const titleFits = stringWidth(lead) + 1 <= inner
  const top = titleFits
    ? `╭${lead}${'─'.repeat(inner - stringWidth(lead))}╮`
    : `╭${'─'.repeat(inner)}╮`
  const borderColor = accent ?? 'promptBorder'
  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Text color={borderColor} wrap="truncate-end">{top}</Text>
      {rows.map((row, index) => (
        <Box key={index} flexDirection="row" width="100%">
          <Text color={borderColor}>│</Text>
          {/* flexGrow 钉住右侧 │ 在最后一列；行内容自行按 cardContentWidth 截断。 */}
          <Box flexDirection="column" flexGrow={1} minWidth={0}>
            {row}
          </Box>
          <Text color={borderColor}>│</Text>
        </Box>
      ))}
      {footer ? (
        <Box flexDirection="row" width="100%">
          <Text color={borderColor}>│</Text>
          <Box flexGrow={1} minWidth={0}>
            <Text dimColor wrap="truncate-end"> {footer}</Text>
          </Box>
          <Text color={borderColor}>│</Text>
        </Box>
      ) : null}
      <Text color={borderColor} wrap="truncate-end">{`╰${'─'.repeat(inner)}╯`}</Text>
    </Box>
  )
}

/**
 * 卡片内一行内容的可用显示宽度：总宽减去两侧 │ + 各 1 空格的内边距。
 * CommandSuggestions / FileSuggestions 的截断数学共用这一口径。
 */
export function cardContentWidth(columns: number): number {
  return Math.max(0, columns - 4)
}

/**
 * 把补全名按「命中的查询前缀」拆成三段（用于前缀高亮）。两级尝试，
 * 均大小写不敏感，与 completeCommands / 文件候选的过滤语义对齐：
 *   1. 整名前缀（文件查询是路径前缀，`src/re` 命中 `src/render`，
 *      跨分隔符；命令 `/plan of` 命中完整路径 `plan off`）；
 *   2. 最后一段 token 的前缀（命令按空格、文件按 `/` 分段）。
 * 查询为空、或都不命中（别名命中、过期候选）返回 null——渲染方整体 dim。
 */
export function splitQueryMatch(
  name: string,
  query: string,
): { before: string; match: string; after: string } | null {
  if (query === '') return null
  const lower = query.toLowerCase()
  if (name.toLowerCase().startsWith(lower)) {
    const matched = name.slice(0, Math.min(query.length, name.length))
    return { before: '', match: matched, after: name.slice(matched.length) }
  }
  const tokenStart = Math.max(name.lastIndexOf(' '), name.lastIndexOf('/')) + 1
  const segment = name.slice(tokenStart)
  if (segment.toLowerCase().startsWith(lower)) {
    const matched = segment.slice(0, Math.min(query.length, segment.length))
    return {
      before: name.slice(0, tokenStart),
      match: matched,
      after: segment.slice(matched.length),
    }
  }
  return null
}
