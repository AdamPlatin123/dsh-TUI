/**
 * EffortIgnitionRow — 输入框正下方的一行橙色波图层：整行恒铺 `▁`，
 * 无波处是与带底色融合的暗端（终端上近乎隐形），切到最高思考强度档
 * 时一段亮橙波自左向右跑过（wave 行波，约 1 秒），播完整行恢复暗端。
 *
 * 波只动颜色：glyph 集恒为 `▁`×width、行数恒为一（播完保留暗端行，
 * 无挂载/卸载布局变化）——SGR-only 的最强形式。触发判定在渲染期做
 * （props-变化-调整模式）；从「已有档位」切到档位表末位最高档才触发，
 * 冷启动恢复偏好/单档表/无档位表/无共享时钟均不触发。时钟复用 Ink
 * core 共享时钟，仅播放窗口订阅（keepAlive），播完回到零开销暗端。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import type { RGBColor } from './Spinner/spinnerUtils.js'
import { rgbString } from '../trajectory/motion.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import {
  IGNITION_TOTAL_MS,
  ignitionHues,
  ignitionLineColors,
  randomIgnitionStyle,
  type IgnitionStyle,
} from '../trajectory/effortIgnition.js'

/** 无波处的暗端：accent 向带底色深混——整行仍铺 `▁`，但近乎隐形。 */
const REST_ALPHA = 0.1

function mixRest(onLight: boolean): Color {
  const band = onLight ? { r: 240, g: 240, b: 242 } : { r: 27, g: 30, b: 40 }
  const hue = ignitionHues(onLight)[0]
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * REST_ALPHA)
  const tinted: RGBColor = { r: mix(band.r, hue.r), g: mix(band.g, hue.g), b: mix(band.b, hue.b) }
  return rgbString(tinted)
}

export function EffortIgnitionRow({
  effort,
  levels,
  columns,
  onLight,
  style,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  columns: number
  onLight: boolean
  /** 固定风格（验证脚本回归用）；缺省随机且不与上次重复。 */
  style?: IgnitionStyle
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

  // 仅播放窗口订阅共享时钟；暗端零定时器零重渲染。
  const totalMs = ignition === null ? 0 : IGNITION_TOTAL_MS[ignition.style]
  const elapsedMs =
    ignition === null
      ? Infinity
      : Math.max(0, (clock?.now() ?? Date.now()) - ignition.startedAtMs)
  useEffect(() => {
    if (ignition === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [ignition, clock])

  const restColor = mixRest(onLight)
  if (columns <= 0) return null
  const colors =
    ignition !== null && elapsedMs < totalMs
      ? ignitionLineColors({ style: ignition.style, elapsedMs, width: columns, onLight })
      : []
  // 整行恒铺 ▁：无波列用暗端色（图层始终存在，波只是让它亮起来跑过）。
  const runs: Array<{ color: keyof Theme | Color; len: number }> = []
  const pushRun = (color: keyof Theme | Color, len: number): void => {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.len += len
    else runs.push({ color, len })
  }
  let index = 0
  while (index < columns) {
    const color = colors[index]
    if (color === undefined) {
      let span = 1
      while (index + span < columns && colors[index + span] === undefined) span++
      pushRun(restColor, span)
      index += span
    } else {
      let span = 1
      while (index + span < columns && colors[index + span] === color) span++
      pushRun(color, span)
      index += span
    }
  }
  return (
    <Box height={1} width="100%" flexShrink={0}>
      <Text>
        {runs.map((run, i) => (
          <Text key={i} color={run.color}>
            {'▁'.repeat(run.len)}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
