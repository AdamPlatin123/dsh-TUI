/**
 * EffortTierBadge — 输入行尾的档位字样徽标：三幕点焰的第二幕载体
 * （与 EffortInputBorder 的双框扫光同一时间轴、同一触发），切到最高
 * 思考强度档时光带行至中段，输入行居中浮现 `MAX`（当前档名大写，
 * 明亮蓝加粗，由暗渐亮），随后随图层整体渐隐让位——行数恒定，静
 * 止时完全不渲染；输入行有文字时不显示（绝不遮挡内容）。
 *
 * 触发判定在渲染期做（props-变化-调整模式，与边框/充能组件同模
 * 式）；冷启动恢复偏好/单档表/无档位表/无共享时钟均不触发。时钟
 * 复用 Ink core 共享时钟，仅动画窗口订阅（keepAlive），播完归零。
 */
import React, { useContext, useEffect, useReducer, useState } from 'react'
import { Text } from '../ui.js'
import { ClockContext } from '../ink/components/ClockContext.js'
import { rgbString } from '../trajectory/motion.js'
import type { RGBColor } from './Spinner/spinnerUtils.js'
import { IGNITION_TIMELINE, ignitionHues } from '../trajectory/effortIgnition.js'

type Overlay = { label: string; startedAtMs: number }

export function EffortTierBadge({
  effort,
  levels,
  onLight,
  columns,
}: {
  /** 当前思考强度档 id；`undefined` 表示路线未声明。 */
  effort: string | undefined
  /** 当前路线的档位表（低→高，末位为最高档）；未知时传 `undefined`。 */
  levels: readonly string[] | undefined
  onLight: boolean
  /** 终端列数——居中偏移按它计算（纯文本流，不引入嵌套 Box）。 */
  columns: number
}): React.ReactNode {
  const clock = useContext(ClockContext)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [prevEffort, setPrevEffort] = useState(effort)
  const [, forceRender] = useReducer((tick: number) => tick + 1, 0)

  // 渲染期触发（与边框/充能同模式）：effort 变化的首帧就以新状态渲染。
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

  const elapsedMs =
    overlay === null ? Infinity : Math.max(0, (clock?.now() ?? Date.now()) - overlay.startedAtMs)
  useEffect(() => {
    if (overlay === null || clock === null) return
    return clock.subscribe(() => forceRender(), /* keepAlive */ true)
  }, [overlay, clock])
  useEffect(() => {
    if (overlay !== null && elapsedMs >= IGNITION_TIMELINE.fadeEndMs) setOverlay(null)
  }, [overlay, elapsedMs])

  if (overlay === null || elapsedMs < IGNITION_TIMELINE.labelStartMs) return null
  const brighten = Math.min(1, (elapsedMs - IGNITION_TIMELINE.labelStartMs) / IGNITION_TIMELINE.labelBrightenMs)
  const fade =
    elapsedMs < IGNITION_TIMELINE.fadeStartMs
      ? 1
      : Math.max(0, 1 - (elapsedMs - IGNITION_TIMELINE.fadeStartMs) / (IGNITION_TIMELINE.fadeEndMs - IGNITION_TIMELINE.fadeStartMs))
  const alpha = brighten * fade
  if (alpha <= 0) return null
  const band: RGBColor = onLight ? { r: 240, g: 240, b: 242 } : { r: 27, g: 30, b: 40 }
  // 明亮蓝：accent 混白 35% 提亮（用户拍板的高亮观感）。
  const hue = ignitionHues(onLight)[0]
  const whiten = (x: number): number => Math.round(x + (255 - x) * 0.35)
  const bright: RGBColor = { r: whiten(hue.r), g: whiten(hue.g), b: whiten(hue.b) }
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * alpha)
  const color = rgbString({ r: mix(band.r, bright.r), g: mix(band.g, bright.g), b: mix(band.b, bright.b) })
  // 居中偏移：❯ 占 2 列、块光标占 1 列，其余可用宽度对半减去字样宽。
  const offset = Math.max(0, Math.floor((columns - 3 - overlay.label.length) / 2) - 1)
  return (
    <Text bold color={color}>
      {' '.repeat(offset)}
      {overlay.label}
    </Text>
  )
}
