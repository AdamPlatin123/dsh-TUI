import React from 'react'
import { Box, Text, NoSelect, type ScrollBoxHandle } from '../ui.js'
import { stringWidth } from '../ink/stringWidth.js'
import {
  RAIL_WIDTH,
  railEligible,
  computeRailGeometry,
  wrapPreviewLines,
  type TimelineTurn,
} from '../ink/timeline-rail.js'

/** ▴ / ▾ (U+25B4 / U+25BE — the small triangles; CP437-safe on ConHost too). */
const CHEVRON_UP = ' ▴'
const CHEVRON_DOWN = ' ▾'
/** Tick glyphs, right-aligned across the 2-col rail (Grok Build spec):
 *  active = heavy stroke, hover = wide light stroke, idle = short dim
 *  stroke in the rightmost cell. */
const TICK_ACTIVE = '━━'
const TICK_HOVER = '──'
const TICK_IDLE = ' ─'

/** What the pointer is over. One state so tick/chevron hovers can never
 *  overlap (the rail is 2 cols wide — a row is one target or the other). */
type Hover =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'tick'; index: number }
  | null

/**
 * Timeline rail: the fullscreen transcript's turn navigator — a 2-column
 * gutter REPLACING the classic scrollbar (Grok Build's timeline sidebar,
 * ported to the dsh Ink tree).
 *
 *  - one tick per user turn; tick position encodes conversation order,
 *    not scroll proportion (a long answer must not skew the timeline);
 *  - the tick of the turn owning the viewport top row (the turn being
 *    read — same anchor the sticky prompt header pins) renders as `━━`;
 *    hovering a tick widens it to `──` and pops a preview card left of
 *    the rail; idle ticks are a short dim ` ─`;
 *  - ▲ / ▾ step between turns by STRICT geometry (nearest prompt above /
 *    below the viewport top — never `active ± 1`, which can name a turn
 *    no scroll reaches), so a dim chevron is always a guaranteed no-op;
 *  - clicking a tick (or chevron) jumps by content coordinate — the
 *    prompt's measured top — no element seek, no force-mount race;
 *  - more turns than rows: the window slides around the active tick, and
 *    pins to the tail while at the bottom (never excluding active);
 *  - hidden below 60 terminal columns, under 2 turns, under 3 viewport
 *    rows, or when the content fits (inline mode keeps the terminal's
 *    native scrollback).
 *
 * The whole 2-column width is the hit target; the rail is fenced with
 * NoSelect so click-drag text selection never picks up its glyphs, and
 * the wheel scrolls the transcript (the rail has no scroll of its own).
 */
export function TimelineRail({
  handle,
  turns,
  activeId,
  upId,
  downId,
  terminalWidth,
  hoverEnabled,
}: {
  handle: ScrollBoxHandle | null
  /** Turns in conversation order (MessageList's measured snapshot). */
  turns: ReadonlyArray<TimelineTurn>
  /** Turn owning the viewport top row (rail highlight target). */
  activeId: number | null
  /** ▲ target: nearest turn strictly above the viewport top. */
  upId: number | null
  /** ▼ target: nearest turn below the viewport top that a scroll can
   *  still bring to the top row. */
  downId: number | null
  terminalWidth: number
  /** False while a modal overlay owns the screen — suppress the hover
   *  card (the rail itself stays, but stops narrating). */
  hoverEnabled: boolean
}): React.ReactNode {
  const [, setTick] = React.useState(0)
  React.useEffect(() => {
    if (!handle) return
    return handle.subscribe(() => setTick(t => t + 1))
  }, [handle])
  const [hover, setHover] = React.useState<Hover>(null)

  if (!handle) return null
  const viewport = handle.getViewportHeight()
  const content = handle.getScrollHeight()
  const maxScroll = Math.max(0, content - viewport)
  if (!railEligible({
    turnCount: turns.length,
    terminalWidth,
    viewportRows: viewport,
    scrollable: content > viewport,
  })) return null

  const activeIndex = turns.findIndex(t => t.id === activeId)
  // Tail-pin the tick window while the viewport sits at the bottom
  // (sticky flag OR positional) — newest ticks stay on screen.
  const atBottom = handle.isSticky() || handle.getScrollTop() >= maxScroll
  const geo = computeRailGeometry(
    turns.length,
    viewport,
    activeIndex === -1 ? null : activeIndex,
    atBottom,
  )
  if (!geo) return null

  // Jump by CONTENT COORDINATE, not by element: the target row is usually
  // unmounted (virtualization), and the element-based seek's force-mount
  // path races React's synchronous re-render (the renderer's deferred
  // Yoga read can see a detached anchor and silently no-op). The turn's
  // reported top is the measured text position — scrollTo() lands the
  // prompt exactly at the viewport top; the renderer clamps unreachable
  // tail tops to maxScroll (their turns stay on screen, just short of
  // owning the top row — and ▼ never names them, see timeline-rail.ts).
  const jumpToIndex = (index: number) => {
    const turn = turns[index]
    if (turn) handle.scrollTo(turn.top)
  }
  const jumpToId = (id: number | null) => {
    if (id === null) return
    const index = turns.findIndex(t => t.id === id)
    if (index !== -1) jumpToIndex(index)
  }

  const shown = geo.windowEnd - geo.windowStart
  const chevron = (kind: 'up' | 'down') => {
    const enabled = (kind === 'up' ? upId : downId) !== null
    const hovered = hover?.kind === kind
    const glyph = kind === 'up' ? CHEVRON_UP : CHEVRON_DOWN
    const color = !enabled ? 'subtle' : hovered ? 'text' : 'inactive'
    return (
      <Box
        key={kind}
        height={1}
        flexShrink={0}
        onClick={() => jumpToId(kind === 'up' ? upId : downId)}
        onMouseEnter={() => setHover({ kind })}
        onMouseLeave={() => setHover(null)}
      >
        <Text color={color}>{glyph}</Text>
      </Box>
    )
  }

  const tickRows: React.ReactNode[] = []
  for (let k = 0; k < shown; k++) {
    const index = geo.windowStart + k
    const turn = turns[index]!
    const isActive = index === activeIndex
    const isHovered = hover?.kind === 'tick' && hover.index === index
    const glyph = isActive ? TICK_ACTIVE : isHovered ? TICK_HOVER : TICK_IDLE
    const color = isActive || isHovered ? 'text' : 'subtle'
    tickRows.push(
      <Box
        key={turn.id}
        height={1}
        flexShrink={0}
        onClick={() => jumpToIndex(index)}
        onMouseEnter={() => setHover({ kind: 'tick', index })}
        onMouseLeave={() => setHover(null)}
      >
        <Text color={color}>{glyph}</Text>
      </Box>,
    )
  }

  // Hover preview card, anchored left of the rail and vertically centered
  // on the hovered tick (shrink-to-fit, rounded chrome). Suppressed while
  // an overlay owns the screen — the rail stops narrating over dialogs.
  let card: React.ReactNode = null
  if (hoverEnabled && hover?.kind === 'tick') {
    const turn = turns[hover.index]
    if (turn && turn.preview.length > 0) {
      const tickRow = geo.tickTop + hover.index - geo.windowStart
      if (tickRow >= geo.tickTop && tickRow < geo.downRow) {
        const budget = Math.min(32, Math.max(16, Math.floor((terminalWidth - RAIL_WIDTH) / 2)))
        const lines = wrapPreviewLines(turn.preview, budget)
        if (lines.length > 0 && lines.some(l => l.length > 0)) {
          const widest = Math.max(...lines.map(l => stringWidth(l)))
          const cardW = widest + 4 // rounded border ×2 + padding ×2
          const cardH = lines.length + 2
          if (cardH <= viewport) {
            const top = Math.max(0, Math.min(tickRow - Math.floor(cardH / 2), viewport - cardH))
            card = (
              <Box
                position="absolute"
                top={top}
                right={RAIL_WIDTH + 1}
                width={cardW}
                height={cardH}
                flexDirection="column"
                flexShrink={0}
                borderStyle="round"
                borderColor="inactive"
                backgroundColor="toolCardBackgroundDim"
                paddingX={1}
              >
                {lines.map((line, i) => (
                  <Text key={i} color="text" wrap="truncate-end">{line}</Text>
                ))}
              </Box>
            )
          }
        }
      }
    }
  }

  return (
    <NoSelect fromLeftEdge>
      {/* Raw ink-box (not the themed Box): onWheel is a host-level prop
          (same as ScrollBox's viewport) — wheel over the rail scrolls the
          transcript, the rail has no scroll of its own. */}
      <ink-box
        onWheel={e => {
          if (e.deltaY !== 0) handle.scrollBy(e.deltaY)
        }}
        style={{ flexDirection: 'column', flexShrink: 0, width: RAIL_WIDTH }}
      >
        <Box height={geo.upRow} flexShrink={0} />
        {chevron('up')}
        {tickRows}
        {chevron('down')}
        {card}
      </ink-box>
    </NoSelect>
  )
}
