/**
 * Synthesize DSH session events from a normalized foreign conversation.
 *
 * Emits the minimal durable event skeleton the transcript projection needs to
 * replay a conversation: one `session` header (carrying `origin:
 * "migrated:<agent>"` so /resume can show provenance), the boot policy trio,
 * then per user/assistant pair a `turn/start` → `user/message` →
 * `assistant/message` → `turn/end` run, and a `session/title` anchored to the
 * first user turn. Tool traffic is intentionally NOT synthesized — the
 * sources' tool calls cannot be replayed faithfully, and the migration
 * contract is "read the conversation again", not "resume mid-task".
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/synthesize
 */
import type { MigrationSession } from './types.js'

/** One durable session event line (structural superset of what we emit). */
export interface SynthEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
  readonly [key: string]: unknown
}

/** Policy trio emitted right after the header, mirroring a real boot. */
const BOOT_POLICY: readonly { type: string, data: unknown }[] = [
  { type: 'permission/preset', data: { preset: 'workspace-write' } },
  { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
]

/**
 * Build the full event stream for one migrated conversation.
 * @param session - The normalized foreign conversation.
 * @param agentId - Adapter id, stamped into the header's origin.
 * @param sessionId - Deterministic DSH session id.
 * @returns Event lines in seq order, ready to serialize as JSONL.
 */
export function synthesizeSessionEvents(session: MigrationSession, agentId: string, sessionId: string): SynthEvent[] {
  const events: SynthEvent[] = []
  let seq = 0
  let time = session.startedAt
  const stamp = (t: number): number => {
    time = Math.max(time + 1, Math.max(t, 0))
    return time
  }
  const push = (type: string, data?: unknown): SynthEvent => {
    if (type === 'session') {
      const event: SynthEvent = { type, version: 0, id: sessionId, createdAt: time, cwd: session.cwd, delegationDepth: 0, agentPreset: 'standard', origin: `migrated:${agentId}` }
      events.push(event)
      return event
    }
    const event: SynthEvent = { type, seq, time, data }
    seq += 1
    events.push(event)
    return event
  }

  push('session')
  for (const policy of BOOT_POLICY) push(policy.type, policy.data)

  let turn = 0
  let firstUserSeq: number | undefined
  for (const item of session.turns) {
    if (item.role === 'user') {
      turn += 1
      push('turn/start', { turn })
      push('user/message', {
        content: [{ type: 'text', text: item.text }],
        source: { kind: 'user' },
        role: 'user',
        id: `${sessionId}-${turn}`,
        surfaceOp: 'append',
      })
      firstUserSeq ??= seq
    } else if (turn > 0) {
      const content: { type: string, text: string }[] = []
      if (item.reasoning !== undefined && item.reasoning !== '') content.push({ type: 'reasoning', text: item.reasoning })
      if (item.text !== '') content.push({ type: 'text', text: item.text })
      if (content.length > 0) {
        push('assistant/message', {
          turn,
          step: 1,
          message: { role: 'assistant', content },
        })
      }
      push('turn/end', { turn, reason: { kind: 'stop' } })
    }
  }
  if (turn === 0) return [] // no user turn → nothing replayable; caller skips

  const title = session.title !== undefined && session.title !== ''
    ? session.title
    : session.turns.find(item => item.role === 'user')?.text.slice(0, 80)
  if (title !== undefined && title !== '') {
    push('session/title', { title, messageSeqs: [firstUserSeq], source: { kind: 'fallback' } })
  }
  return events
}
