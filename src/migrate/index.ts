/**
 * Migration registry and import engine.
 *
 * Import writes one DSH session log per foreign conversation:
 * `$DSH_HOME/sessions/--<munged cwd>--/<uuid>/session.jsonl.zstd` (Node's
 * built-in zstd via node:zlib). The session id is UUIDv5 over
 * `<agent>:<sourceId>`, so re-importing the same conversation overwrites its
 * own copy — idempotent by construction, no duplicate stacking. Sources are
 * only ever read.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { zstdCompress } from 'node:zlib'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { synthesizeSessionEvents } from './synthesize.js'
import type { MigrationAdapter, MigrationSession } from './types.js'
import { migrationUuid } from './uuid.js'
import { claudeCodeAdapter } from './adapters/claude-code.js'
import { codexAdapter } from './adapters/codex.js'
import { ompAdapter } from './adapters/omp.js'

/** Adapters shipped in this build; pi / opencode pending real-world samples. */
export const MIGRATION_ADAPTERS: readonly MigrationAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  ompAdapter,
]

/** cwd → the `--dash-munged--` workspace segment DSH sessions use. */
export function mungeCwd(cwd: string): string {
  const body = cwd.replace(/^\/+/u, '').replace(/\/+$/u, '').replace(/[/\\]+/gu, '-')
  return `--${body}--`
}

/** What importing one conversation produced. */
export interface ImportOutcome {
  readonly session: MigrationSession
  readonly target: string
  readonly turns: number
}

const compressZstd = promisify(zstdCompress)

/**
 * Import one conversation into the DSH sessions tree.
 * @param agent - The adapter that produced the session.
 * @param session - The discovered conversation.
 * @param dshHome - Target DSH home (defaults to `$DSH_HOME ?? ~/.dsh`).
 * @returns The outcome, or undefined when the conversation had no user turn.
 */
export async function importSession(
  agent: MigrationAdapter,
  session: MigrationSession,
  dshHome: string = process.env.DSH_HOME ?? join(homedir(), '.dsh'),
): Promise<ImportOutcome | undefined> {
  const sessionId = migrationUuid(`${agent.id}:${session.sourceId}`)
  const events = synthesizeSessionEvents(session, agent.id, sessionId)
  if (events.length === 0) return undefined
  const dir = join(dshHome, 'sessions', mungeCwd(session.cwd), sessionId)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'session.jsonl.zstd')
  const payload = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  const compressed = await compressZstd(payload)
  writeFileSync(target, compressed)
  return { session, target, turns: session.turns.filter(turn => turn.role === 'user').length }
}

export { synthesizeSessionEvents } from './synthesize.js'
export { migrationUuid } from './uuid.js'
export type { MigrationAdapter, MigrationDiscovery, MigrationSession, MigrationTurn } from './types.js'
export type { SynthEvent } from './synthesize.js'
