/**
 * Upstream compatibility contract.
 *
 * The TUI is validated against the 0.1.0-rc.6 and 0.1.0-rc.7 release lines.
 * rc.6 is a first-class supported line (backward compatibility): every
 * symbol the adapter imports exists in rc.6, and the only rc.6→rc.7 code
 * delta in the consumed packages is dsh-llm's replay-metadata typing, which
 * the TUI never reads. The peer range (`^0.1.0-rc.6`) admits both lines so
 * an rc.6 core profile installs without peer conflicts.
 * Every official package this adapter touches is blessed here; anything
 * else must go through upstream channels or the adapter, never the UI.
 *
 * `upstreamDrift()` powers both the boot-time warning (dev visibility) and
 * the CI gate (scripts/verify-upstream-contract.ts) so a mismatched
 * install fails in CI before it fails on a user's machine.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Primary validated release line (what the current build was typechecked against). */
export const UPSTREAM_VALIDATED_VERSION = '0.1.0-rc.7'

/**
 * Every validated release line. Both rc.6 and rc.7 are first-class; a
 * profile running either line must not see drift. Anything outside this
 * list is unvalidated and keeps warning.
 */
export const UPSTREAM_VALIDATED_VERSIONS: readonly string[] = [
  '0.1.0-rc.6',
  '0.1.0-rc.7',
]

/**
 * Framework packages version on their own lines; the contract validates
 * their MAJOR (breaking surface), not the harness rc number.
 */
export const UPSTREAM_FRAMEWORK_MAJORS: Record<string, number> = {
  '@deepseek-ai/cordis': 4,
  '@deepseek-ai/schemastery': 3,
}

/** Official packages the adapter consumes at runtime or as types. */
export const UPSTREAM_BLESSED_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
] as const

export interface UpstreamDriftEntry {
  package: string
  installed: string | undefined
  validated: string
}

function resolvePackageJson(packageName: string): string | undefined {
  try {
    const path = import.meta.resolve(`${packageName}/package.json`)
    return path.startsWith('file:') ? fileURLToPath(path) : path
  } catch {
    return undefined
  }
}

export function installedUpstreamVersions(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const packageName of UPSTREAM_BLESSED_PACKAGES) {
    let version: string | undefined
    const path = resolvePackageJson(packageName)
    if (path !== undefined) {
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: string }
        version = manifest.version
      } catch {
        version = undefined
      }
    }
    result[packageName] = version
  }
  return result
}

function rcNumber(version: string | undefined): number | undefined {
  const match = /0\.1\.0-rc\.(\d+)/u.exec(version ?? '')
  return match === null ? undefined : Number(match[1])
}

/**
 * Report every blessed package whose installed version is NOT on a validated
 * release line. Empty array = the running install matches the contract.
 */
export function upstreamDrift(): UpstreamDriftEntry[] {
  const drift: UpstreamDriftEntry[] = []
  for (const [packageName, installed] of Object.entries(installedUpstreamVersions())) {
    const expected = UPSTREAM_BLESSED_PACKAGES.includes(packageName as never)
    if (!expected) continue
    let matches: boolean
    const frameworkMajor = UPSTREAM_FRAMEWORK_MAJORS[packageName]
    if (frameworkMajor !== undefined) {
      const installedMajor = Number((installed ?? '').split('.')[0])
      matches = installedMajor === frameworkMajor
    } else {
      matches = UPSTREAM_VALIDATED_VERSIONS.some(line => rcNumber(installed) === rcNumber(line))
    }
    if (!matches) {
      drift.push({
        package: packageName,
        installed,
        validated: frameworkMajor !== undefined ? `major ${frameworkMajor}` : UPSTREAM_VALIDATED_VERSIONS.join(' / '),
      })
    }
  }
  return drift
}

/**
 * RC numbers of the release lines observed among the installed blessed
 * packages (frameworks excluded). More than one line in one profile means a
 * half-upgraded install — the boot warning calls it out separately.
 */
export function upstreamLineNumbers(): number[] {
  const lines = new Set<number>()
  for (const [packageName, installed] of Object.entries(installedUpstreamVersions())) {
    if (!UPSTREAM_BLESSED_PACKAGES.includes(packageName as never)) continue
    if (UPSTREAM_FRAMEWORK_MAJORS[packageName] !== undefined) continue
    const rc = rcNumber(installed)
    if (rc !== undefined) lines.add(rc)
  }
  return [...lines].sort((a, b) => a - b)
}
