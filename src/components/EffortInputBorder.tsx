/**
 * EffortInputBorder — 输入框层上的三幕点焰叠加（对齐 Codex 的完整
 * 语义：光扫过、档位字样浮现、整体渐隐）。
 *
 * 输入框只有顶/底两条横边框（round、无左右）——本组件自绘这两行，
 * **同步**承载动画；档位字样短暂显示在输入框**内容区**（居中一行，
 * 随图层一起浮现与消失）。切到最高思考强度档时：
 *
 *   1. 扫光 [0, 800ms)——一段蓝色光带沿顶/底边框同步自左向右扫过
 *      （wave 波形逐列变色），期间输入框完全正常可用；
 *   2. 档位字样 [400ms, ~1000ms)——光带行至中段时，输入框内容区居
 *      中浮现 `M A X`（当前档名大写）按字母 stagger 由暗渐亮加粗；
 *   3. 渐隐 [1100, 1600ms)——字样连同光色一起向主题色淡出，末帧字
 *      样行让位消失、边框归零：静止时顶/底边框就是原主题色，输入
 *      框内容区无任何附加物。
 *
 * glyph 变化仅限字样行的出现/让位（一次性）；其余帧间变化全部是既
 * 有 `─` 的前景色。触发判定在渲染期做（props-变化-调整模式）；从
 * 「已有档位」切到档位表末位最高档才触发，冷启动恢复偏好/单档表/
 * 无档位表/无共享时钟均不触发。时钟复用 Ink core 共享时钟，仅动画
 * 窗口订阅（keepAlive），播完回到零开销静止边框。
 */
import React, { useContext, useEffect, useReducer, useRef, useState } from 'react'
import { Box, Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { rgbString } from '../trajectory/motion.js'
import type { Color } from '../ink/styles.js'
import type { Theme } from '../theme.js'
import type { RGBColor } from './Spinner/spinnerUtils.js'
import { ignitionHues, ignitionLineColors } from '../trajectory/effortIgnition.js'

/** 三幕时间轴（ms）：扫光全长、字样启动（波至中段）、字母 stagger 步长、渐隐起止。 */
const SWEEP_MS = 800
const LABEL_START_MS = 400
const LABEL_STEP_MS = 140
const LABEL_BRIGHTEN_MS = 160
const FADE_START_MS = 1100
const FADE_END_MS = 1600

type Overlay = { label: string; startedAtMs: number }

/** 混色（t=0 → a，t=1 → b）。 */
function mixRGB(a: RGBColor, b: RGBColor, t: number): RGBColor {
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * Math.min(1, Math.max(0, t)))
  return { r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b) }
}

/** 边框行（顶/底共用同一色段序列——同步变色）。 */
function BorderRow({
  left,
  right,
  runs,
  idleColor,
}: {
  left: string
  right: string
  runs: ReadonlyArray<{ glyph: string; color: keyof Theme | Color }>
  idleColor: keyof Theme | Color
}): React.ReactNode {
  return (
    <Text>
      <Text color={idleColor}>{left}</Text>
      {runs.map((run, i) => (
        <Text key={i} color={run.color}>
          {run.glyph}
        </Text>
      ))}
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
  children: React.ReactNode
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
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
      setOverlay({ label: effort.toUpperCase(), startedAtMs: clock.now() })
    }
  }

  // 仅动画窗口订阅共享时钟；静止边框零定时器零重渲染。
  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= FADE_END_MS) setOverlay(null)
  }, [overlay, elapsedMs])

  const midWidth = Math.max(0, columns - 2)
  const sweepColors =
    overlay !== null && elapsedMs < SWEEP_MS && midWidth > 0
      ? ignitionLineColors({ style: 'wave', elapsedMs, width: midWidth, onLight })
      : []
  // 顶/底共用的色段序列（同步）：扫光列取波形色，其余列回主题色。
  const runs: Array<{ glyph: string; color: keyof Theme | Color }> = []
  for (let index = 0; index < midWidth; index++) {
    const color: keyof Theme | Color = sweepColors[index] ?? idleColor
    const last = runs[runs.length - 1]
    if (last !== undefined && last.color === color) last.glyph += '─'
    else runs.push({ glyph: '─', color })
  }

  // 字样行（输入框内容区，居中）：字母 stagger 浮现→渐亮→整体渐隐。
  const band: RGBColor = onLight ? { r: 240, g: 240, b: 242 } : { r: 27, g: 30, b: 40 }
  const hue = ignitionHues(onLight)[0]
  const letters = overlay === null ? [] : overlay.label.split('')
  const letterAlpha = (letterIndex: number): number => {
    if (overlay === null) return 0
    const appearAt = LABEL_START_MS + letterIndex * LABEL_STEP_MS
    if (elapsedMs < appearAt) return 0
    const brighten = Math.min(1, (elapsedMs - appearAt) / LABEL_BRIGHTEN_MS)
    const fade =
      elapsedMs < FADE_START_MS
        ? 1
        : Math.max(0, 1 - (elapsedMs - FADE_START_MS) / (FADE_END_MS - FADE_START_MS))
    return brighten * fade
  }
  const labelVisible = letters.some((_, i) => letterAlpha(i) > 0)

  return (
    <Box
      flexDirection="column"
      alignItems="flex-start"
      justifyContent="flex-start"
      width="100%"
      flexShrink={0}
    >
      <BorderRow left="╭" right="╮" runs={runs} idleColor={idleColor} />
      {children}
      {labelVisible ? (
        <Box width="100%" justifyContent="center" height={1}>
          <Text>
            {letters.map((letter, i) => {
              const alpha = letterAlpha(i)
              const dim = mixRGB(band, hue, 0.35 * alpha)
              return (
                <Text key={i} bold color={rgbString(mixRGB(dim, hue, alpha))}>
                  {letter}
                  {i < letters.length - 1 ? ' ' : ''}
                </Text>
              )
            })}
          </Text>
        </Box>
      ) : null}
      <BorderRow left="╰" right="╯" runs={runs} idleColor={idleColor} />
    </Box>
  )
}
