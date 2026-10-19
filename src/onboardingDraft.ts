/**
 * In-process progress for the first-run guide, at module scope.
 *
 * Not a persisted preference and deliberately not part of `onboardingPrefs`
 * (that file owns the one-shot accounting, and a process that dies mid-guide
 * must not burn the installation's only first run). This store exists for one
 * mechanical reason:
 *
 *   The question and approval panels share the interrupt lane with every
 *   full-screen surface — while a panel is pending the screen is UNMOUNTED
 *   and remounted once the answer lands (`Chat.tsx`, the `interruptPanel &&
 *   screenOpen` branch; `screenOpen` includes `onboardingOpen`). An access
 *   step that opens a panel (API-key entry, an OAuth device code or authorize
 *   URL) therefore loses all of its React state at exactly the moment the
 *   flow has something to report back.
 *
 * So the guide keeps the mechanical facts here: which step and row the user
 * was on, the catalog snapshot taken BEFORE the action (the diff baseline for
 * `onboardingProviderPlan`), the action that is in flight, and the one-line
 * notice to restore. Everything else stays in component state.
 *
 * Lifecycle: written on change, read on mount, cleared when the guide closes
 * either way (finish or skip) — a stale draft must never steer the next
 * `/setup`. Best effort and total: a corrupt entry is simply dropped, and the
 * guide starts at step 0 exactly as it did before this module existed.
 *
 * @module @deepseek-harness-tui/dsh-tui/onboardingDraft
 */
import type { ProviderModelRef } from './components/onboardingProviderPlan.js'

/** The access action whose result the guide is waiting for. */
export interface OnboardingPendingAction {
  readonly kind: 'sign-in' | 'add-provider'
  /** Provider id for `sign-in`; absent for the add-provider wizard. */
  readonly provider?: string | undefined
}

/** Mechanical guide progress (see the module doc for why it exists). */
export interface OnboardingDraft {
  /** Zero-based step index, already clamped by the caller. */
  readonly step: number
  /** Focus row inside the current step/layer. */
  readonly focus: number
  /**
   * Catalog snapshot taken before the in-flight action; the diff baseline.
   * Empty when no action has run, which makes the first diff "everything is
   * new" — only reachable if a caller reads the plan without an action, and
   * the callers never do.
   */
  readonly baseline: readonly ProviderModelRef[]
  /** The action in flight, while its panel owns the terminal. */
  readonly pending: OnboardingPendingAction | undefined
  /** Notice line to restore after a remount. */
  readonly notice: string | undefined
}

/** What `readOnboardingDraft` answers when nothing is in flight. */
export const EMPTY_ONBOARDING_DRAFT: OnboardingDraft = {
  step: 0,
  focus: 0,
  baseline: [],
  pending: undefined,
  notice: undefined,
}

let current: OnboardingDraft | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Validate the pending action; anything unrecognized reads as "none". */
function parsePending(value: unknown): OnboardingPendingAction | undefined {
  if (!isRecord(value)) return undefined
  const kind = value.kind
  if (kind !== 'sign-in' && kind !== 'add-provider') return undefined
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : undefined
  return { kind, ...(provider === undefined ? {} : { provider }) }
}

/** Validate the baseline rows; a malformed row drops the whole baseline. */
function parseBaseline(value: unknown): readonly ProviderModelRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: ProviderModelRef[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    const { provider, id, name } = entry
    if (typeof provider !== 'string' || typeof id !== 'string' || typeof name !== 'string') return undefined
    rows.push({ provider, id, name })
  }
  return rows
}

/**
 * Parse a draft (exported for the regression: the shape rules are worth
 * pinning without touching the module's single slot).
 *
 * @param value - Raw stored value.
 * @returns The normalized draft; `undefined` when nothing usable is stored.
 */
export function parseOnboardingDraft(value: unknown): OnboardingDraft | undefined {
  if (!isRecord(value)) return undefined
  const baseline = parseBaseline(value.baseline)
  if (baseline === undefined) return undefined
  return {
    step: count(value.step, 0),
    focus: count(value.focus, 0),
    baseline,
    pending: parsePending(value.pending),
    notice: typeof value.notice === 'string' && value.notice !== '' ? value.notice : undefined,
  }
}

/**
 * Read the draft in flight.
 *
 * @returns The stored draft, or `undefined` when the guide has no progress to
 *   restore (first mount, or after {@link clearOnboardingDraft}).
 */
export function readOnboardingDraft(): OnboardingDraft | undefined {
  return current
}

/**
 * Merge a patch into the draft, creating it on first write.
 *
 * @param patch - Fields to replace.
 * @returns The stored draft after the write.
 */
export function writeOnboardingDraft(patch: Partial<OnboardingDraft>): OnboardingDraft {
  current = { ...(current ?? EMPTY_ONBOARDING_DRAFT), ...patch }
  return current
}

/** Drop the draft; called on both guide exits (finish and skip). */
export function clearOnboardingDraft(): void {
  current = undefined
}
