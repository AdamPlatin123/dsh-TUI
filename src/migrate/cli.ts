/**
 * CLI surface for migration, reached via `dsh-tui migrate ...` (the bin
 * launcher delegates here exactly like it delegates `update`).
 *
 * Usage:
 *   dsh-tui migrate                     # list agents and discoverable counts
 *   dsh-tui migrate <agent>             # import every conversation found
 *   dsh-tui migrate <agent> --dry-run   # show what would land, write nothing
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/cli
 */
import { MIGRATION_ADAPTERS, importSession, mungeCwd } from './index.js'

/** Exit code for "nothing to do / unknown agent". */
export const MIGRATE_CLI_USAGE_EXIT = 2

/**
 * Run one migration CLI invocation.
 * @param argv - Arguments after the `migrate` word.
 * @returns Process exit code.
 */
export async function cliMigrate(argv: readonly string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run')
  const words = argv.filter(word => word !== '--dry-run')
  if (words.length > 1) {
    process.stderr.write('usage: dsh-tui migrate [<agent>] [--dry-run]\n')
    return MIGRATE_CLI_USAGE_EXIT
  }
  const wanted = words[0]
  const agents = MIGRATION_ADAPTERS.filter(adapter => wanted === undefined || adapter.id === wanted)
  if (agents.length === 0) {
    process.stderr.write(`dsh-tui migrate: unknown agent "${wanted}"; known: ${MIGRATION_ADAPTERS.map(adapter => adapter.id).join(', ')}\n`)
    return MIGRATE_CLI_USAGE_EXIT
  }
  for (const adapter of agents) {
    const found = adapter.discover()
    if (found.roots.length === 0 || found.sessions.length === 0) {
      console.log(`[${adapter.id}] no conversations found`)
      continue
    }
    if (dryRun) {
      console.log(`[${adapter.id}] ${found.sessions.length} conversation(s) would be imported (dry run)`)
      for (const session of found.sessions.slice(0, 5)) {
        console.log(`  · ${session.sourceId}  (${session.turns.length} turns → sessions/${mungeCwd(session.cwd)}/…)`)
      }
      if (found.sessions.length > 5) console.log(`  … and ${found.sessions.length - 5} more`)
      continue
    }
    let imported = 0
    let skipped = 0
    for (const session of found.sessions) {
      const outcome = await importSession(adapter, session)
      if (outcome === undefined) skipped += 1
      else imported += 1
    }
    console.log(`[${adapter.id}] imported ${imported} conversation(s)` + (skipped > 0 ? `, skipped ${skipped} (no user turns)` : ''))
  }
  if (!dryRun) console.log('done — /resume lists the migrated conversations under their original directories')
  return 0
}
