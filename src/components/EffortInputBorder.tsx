/**
 * EffortInputBorder — 思考强度切到最高档时，输入框边框上的点焰推进
 * （对齐 Codex 的 composer-band 语义：波在输入区本身上流动，而不是
 * 旁边另起一行）。
 *
 * dsh-tui 的输入框只有顶/底两条横边框（round、无左右）——本组件自绘
 * 这两条行（`╭─…─╮` / `╰─…─╯`），静止时整行主题色；点焰期间 `─` 列
 * 按波形逐列变色、自左向右推进（wave 行波 / aurora 双带游走 / pulse
 * 扩散环），角 glyph 恒为主题色。
 *
 * SGR-only 纯度高于插行方案：两条边框行**恒存在**（无挂载/卸载布局
 * 变化），帧间变化全部是既有 glyph 的前景色。触发判定在渲染期做
 * （props-变化-调整模式，消除首帧旧态闪现）；从「已有档位」切到档位
 * 表末位最高档才触发，冷启动恢复偏好/单档表/无档位表/无共享时钟均不
 * 触发。时钟复用 Ink core 共享时钟，仅播放窗口订阅（keepAlive——独立
 * 场景没有其他组件维持时钟），播完自动回到静止边框。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import { Box, Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import {
  IGNITION_TOTAL_MS,
  ignitionLineColors,
  randomIgnitionStyle,
  type IgnitionStyle,
} from '../trajectory/effortIgnition.js'

/** 一段同色的边框 `─` 列。 */
type Run = { color: keyof Theme | Color | undefined; len: number }

/** 把逐列色压缩成段（undefined = 无波，落回静止主题色）。 */
function toRuns(colors: ReadonlyArray<Color | undefined>): Run[] {
  const runs: Run[] = []
  for (const color of colors) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.len++
    else runs.push({ color, len: 1 })
  }
  return runs
}

/** 一条边框行：角 glyph 主题色 + 中段按逐列色推进（无波列回主题色）。 */
function BorderRow({
  left,
  right,
  runs,
  idleColor,
}: {
  left: string
  right: string
  runs: readonly Run[]
  idleColor: keyof Theme | Color
}): React.ReactNode {
  return (
    <Text>
      <Text color={idleColor}>{left}</Text>
      {runs.map((run, index) =>
        run.color === undefined ? (
          <Text key={index} color={idleColor}>
            {'─'.repeat(run.len)}
          </Text>
        ) : (
          <Text key={index} color={run.color}>
            {'─'.repeat(run.len)}
          </Text>
        ),
      )}
      <Text color={idleColor}>{right}</Text>
    </Text>
  )
}

export function EffortInputBorder({
  effort,
  levels,
  columns,
  onLight,
  idleColor,
  style,
  children,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  onLight: boolean
  /** 静止边框色（主题 token 名，如 'promptBorder' / 'planMode'）。 */
  idleColor: keyof Theme | Color
  /** 固定风格（验证脚本逐风格回归用）；缺省随机且不与上次重复。 */
  style?: IgnitionStyle
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [ignition, setIgnition] = useState<{ style: IgnitionStyle; startedAtMs: number } | null>(
    null,
  )
  const [prevEffort, setPrevEffort] = useState(effort)
  const prevStyle = useRef<IgnitionStyle | undefined>(undefined)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发：effort 变化的首帧就以新状态渲染（effect 会晚一帧）。
  if (effort !== prevEffort) {
    setPrevEffort(effort)
    if (
      clock !== null &&
      effort !== undefined &&
      levels !== undefined &&
      levels.length > 1 &&
      effort === levels[levels.length - 1]
    ) {
      const nextStyle = style ?? randomIgnitionStyle(prevStyle.current)
      prevStyle.current = nextStyle
      setIgnition({ style: nextStyle, startedAtMs: clock.now() })
    }
  }

  // 仅播放窗口订阅共享时钟；静止边框零定时器零重渲染。
  const totalMs = ignition === null ? 0 : IGNITION_TOTAL_MS[ignition.style]
  const elapsedMs =
    ignition === null
      ? Infinity
      : Math.max(0, (clock?.now() ?? Date.now()) - ignition.startedAtMs)
  useEffect(() => {
    if (ignition === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [ignition, clock])
  useEffect(() => {
    if (ignition !== null && elapsedMs >= totalMs) setIgnition(null)
  }, [ignition, elapsedMs, totalMs])

  // 中段宽：行总宽（columns，两条边框行即输入框全宽）去掉两个角 glyph。
  const midWidth = Math.max(0, columns - 2)
  const colors =
    ignition !== null && elapsedMs < totalMs && midWidth > 0
      ? ignitionLineColors({ style: ignition.style, elapsedMs, width: midWidth, onLight })
      : []
  // 静止（或越界）时 colors 为空——中段必须仍渲染整行 idle 色，否则
  // 边框只剩两个角 glyph。
  const runs = toRuns(colors)
  const rowRuns = runs.length === 0 ? [{ color: undefined, len: midWidth } satisfies Run] : runs
  return (
    <Box
      flexDirection="column"
      alignItems="flex-start"
      justifyContent="flex-start"
      width="100%"
      flexShrink={0}
    >
      <BorderRow left="╭" right="╮" runs={rowRuns} idleColor={idleColor} />
      {children}
      <BorderRow left="╰" right="╯" runs={rowRuns} idleColor={idleColor} />
    </Box>
  )
}
