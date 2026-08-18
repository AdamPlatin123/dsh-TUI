/** Provider-neutral full-screen scene registry for terminal front doors. */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Channel } from './channel.js'
import { bindCallerEffect, concreteService } from './host-access.js'
import { componentIdentityOf } from './component-identity.js'

/**
 * Props every plugin scene receives. Both element creation and hooks must go
 * through the HOST's React, never the plugin's own copy:
 *
 * - Hooks: a component rendered by this TUI's reconciler but calling hooks
 *   imported from a second React copy (the plugin's own node_modules) dies
 *   with an invalid-hook-call on first render. Use the injected `React`.
 * - Elements: this app's reconciler (React 19) accepts only
 *   `Symbol.for('react.transitional.element')` elements. JSX compiled
 *   against a plugin-bundled older React emits `Symbol.for('react.element')`
 *   and throws on first render. Create elements with the injected `React`
 *   (`React.createElement`/`React.Fragment`), or compile JSX against the
 *   host runtime via tsconfig
 *   `"jsxImportSource": "@deepseek-harness-tui/dsh-tui"` (its `./jsx-runtime`
 *   subpath re-exports this app's own react/jsx-runtime). A plugin-owned
 *   React copy works ONLY if it is the same React 19 line — and its hooks
 *   remain off-limits regardless.
 */
export interface TuiSceneProps {
  /** The TUI's React instance — use THIS for every hook and element. */
  React: typeof React
  /** The TUI's ui kit (Box/Text/useInput/useTerminalSize/…). */
  ui: typeof import('../ui.js')
  /** Live session channel: rows, status, trace events, notifications. */
  channel: Channel
  /** Leave the scene and return to whatever screen was up before. */
  close(): void
}

export interface TuiSceneDescriptor {
  /** Unique scene id (kebab-case); the plugin's own commands open it by id. */
  id: string
  /** Optional human label for logs/debugging; the scene renders its own header. */
  title?: string
  component: React.ComponentType<TuiSceneProps>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tuiScenes: TuiSceneRuntime
  }
}

export const name = 'dsh-tui-scenes'

/**
 * Small host-only registry; command execution remains owned by dsh-commands.
 *
 * A plugin registers a scene once (`ctx.tuiScenes.register(...)`, keep the
 * dispose) and opens it from anywhere host-side — typically its own
 * dsh-commands handler: `ctx.tuiScenes.open('my-scene')` plus a silent
 * `success` result, so the conversation stays untouched while the scene
 * takes the whole terminal the way the trajectory scene does.
 */
export class TuiSceneRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tuiScenes')
    sceneStates.set(this, { scenes: new Map(), owners: new Map(), listeners: new Set(), current: undefined })
  }

  /**
   * Register a full-screen scene; returns the dispose function (caller
   * scopes it with `ctx.effect`). The optional trailing `identity` (the
   * plugin's own ctx) only feeds the effect ledger's pluginId — omitting it
   * records `undeclared` (C-060).
   */
  register(descriptor: TuiSceneDescriptor, identity?: Context): () => void {
    const state = sceneStateFor(this)
    const callerIdentity = componentIdentityOf(this.ctx)
    const suppliedIdentity = identity === undefined ? callerIdentity : componentIdentityOf(identity)
    if (identity !== undefined && callerIdentity !== undefined && suppliedIdentity !== callerIdentity) {
      throw new Error('dsh-tui: tuiScenes.register identity belongs to another activation')
    }
    const owner = suppliedIdentity === undefined
      ? 'host'
      : `${suppliedIdentity.componentId}\0${suppliedIdentity.activationId}`
    const id = descriptor.id.trim().toLowerCase()
    if (!/^[a-z][a-z0-9_-]*$/u.test(id)) throw new TypeError(`invalid TUI scene id: ${descriptor.id}`)
    if (state.scenes.has(id)) {
      this.ctx.get('tuiEffectLedger')?.record(
        {
          operation: 'create',
          resource: { kind: 'scene', id },
          result: 'failed',
          errorCode: 'DUPLICATE_CONTRIBUTION_ID',
        },
        identity,
      )
      throw new Error(`TUI scene "${id}" is already registered`)
    }
    const normalized = Object.freeze({ ...descriptor, id })
    state.scenes.set(id, normalized)
    state.owners.set(id, owner)
    this.ctx.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id }, result: 'applied' },
      identity,
    )
    const dispose = () => {
      if (state.scenes.get(id) !== normalized) return
      state.scenes.delete(id)
      state.owners.delete(id)
      this.ctx.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id }, result: 'applied' },
        identity,
      )
      // Disposing the open scene must not strand the user on a dead screen.
      if (state.current === normalized) {
        state.current = undefined
        this.notify()
      }
    }
    bindCallerEffect(this.ctx, dispose)
    return dispose
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in
   * the log, not silently do nothing in the UI.
   */
  open(id: string): boolean {
    const state = sceneStateFor(this)
    const scene = state.scenes.get(id.trim().toLowerCase())
    if (scene === undefined) {
      this.ctx.logger.warn(`dsh-tui: no TUI scene registered as "${id}"`)
      return false
    }
    const callerIdentity = componentIdentityOf(this.ctx)
    if (callerIdentity !== undefined) {
      const owner = `${callerIdentity.componentId}\0${callerIdentity.activationId}`
      if (state.owners.get(scene.id) !== owner) {
        this.ctx.logger.warn(`dsh-tui: scene "${scene.id}" belongs to another activation`)
        return false
      }
    }
    if (scene === state.current) return true
    state.current = scene
    this.notify()
    return true
  }

  close(): void {
    const state = sceneStateFor(this)
    if (state.current === undefined) return
    const callerIdentity = componentIdentityOf(this.ctx)
    if (callerIdentity !== undefined) {
      const owner = `${callerIdentity.componentId}\0${callerIdentity.activationId}`
      if (state.owners.get(state.current.id) !== owner) {
        this.ctx.logger.warn(`dsh-tui: scene "${state.current.id}" belongs to another activation`)
        return
      }
    }
    state.current = undefined
    this.notify()
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    return sceneStateFor(this).current
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    const state = sceneStateFor(this)
    state.listeners.add(listener)
    const dispose = () => {
      state.listeners.delete(listener)
    }
    bindCallerEffect(this.ctx, dispose)
    return dispose
  }

  private notify(): void {
    const state = sceneStateFor(this)
    for (const listener of state.listeners) listener()
  }
}

interface SceneState {
  readonly scenes: Map<string, TuiSceneDescriptor>
  readonly owners: Map<string, string>
  readonly listeners: Set<() => void>
  current: TuiSceneDescriptor | undefined
}

const sceneStates = new WeakMap<TuiSceneRuntime, SceneState>()

function sceneStateFor(runtime: TuiSceneRuntime): SceneState {
  const state = sceneStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiScenes host state is unavailable')
  return state
}

export default TuiSceneRuntime
