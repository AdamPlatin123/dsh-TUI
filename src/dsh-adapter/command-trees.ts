/** Provider-neutral subcommand completion registry for terminal front doors. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { CommandCompletionNode, LocalizedDescriptions } from '../commands.js'
import { bindCallerEffect, concreteService } from './host-access.js'

export interface TuiCommandTreeProvider {
  /** Root command name without `/`. Must match the command registry entry. */
  root: string
  /** Optional provider-owned translations for the root command row. */
  descriptions?: LocalizedDescriptions
  /** Children for the full canonical path, including `root` at index zero. */
  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiCommandTrees: TuiCommandTreeRuntime
  }
}

export const name = 'dsh-tui-command-trees'

/** Small host-only registry; command execution remains owned by dsh-commands. */
export class TuiCommandTreeRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiCommandTrees')
    commandTreeStates.set(this, { providers: new Map() })
  }

  register(provider: TuiCommandTreeProvider): () => void {
    const state = commandTreeStateFor(this)
    const root = provider.root.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(root)) throw new TypeError(`invalid TUI command-tree root: ${provider.root}`)
    if (state.providers.has(root)) throw new Error(`TUI command-tree root "${root}" is already registered`)
    const normalized = { ...provider, root }
    state.providers.set(root, normalized)
    const dispose = () => {
      if (state.providers.get(root) === normalized) state.providers.delete(root)
    }
    bindCallerEffect(this.ctx, dispose)
    return dispose
  }

  children(canonicalPath: readonly string[]): readonly CommandCompletionNode[] {
    const state = commandTreeStateFor(this)
    const root = canonicalPath[0]?.toLowerCase()
    if (root === undefined) return []
    const provider = state.providers.get(root)
    if (provider === undefined) return []
    try {
      return provider.children(canonicalPath)
    } catch {
      // Completion is optional UI metadata and must never block execution.
      return []
    }
  }

  descriptions(root: string): LocalizedDescriptions | undefined {
    return commandTreeStateFor(this).providers.get(root.trim().toLowerCase())?.descriptions
  }
}

interface CommandTreeState {
  readonly providers: Map<string, TuiCommandTreeProvider>
}

const commandTreeStates = new WeakMap<TuiCommandTreeRuntime, CommandTreeState>()

function commandTreeStateFor(runtime: TuiCommandTreeRuntime): CommandTreeState {
  const state = commandTreeStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiCommandTrees host state is unavailable')
  return state
}

export default TuiCommandTreeRuntime
