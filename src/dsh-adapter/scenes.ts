/** Provider-neutral full-screen scene registry for terminal front doors. */

import type React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Channel } from './channel.js'
import { bindCallerEffect, concreteService, requirePluginCaller } from './host-access.js'
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

/** Host-only scene controls used by the channel; omitted from the plugin export. */
export interface TuiSceneHost {
  readonly active: TuiSceneDescriptor | undefined
  open(id: string): boolean
  close(): void
  subscribe(listener: () => void): () => void
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
    const runtime = this
    const state: SceneState = {
      scenes: new Map(),
      owners: new Map(),
      listeners: new Set(),
      current: undefined,
      host: undefined,
      logger: ctx.logger,
    }
    state.host = Object.freeze({
      get active() {
        return sceneStateFor(runtime).current
      },
      open(id: string) {
        return openScene(runtime, id)
      },
      close() {
        closeScene(runtime)
      },
      subscribe(listener: () => void) {
        return subscribeScenes(runtime, listener)
      },
    })
    sceneStates.set(this, state)
  }

  /**
   * Register a full-screen scene; returns the dispose function (caller
   * scopes it with `ctx.effect`). The optional trailing `identity` (the
   * plugin's own ctx) only feeds the effect ledger's pluginId — omitting it
   * records `undeclared` (C-060).
   */
  register(descriptor: TuiSceneDescriptor, identity?: Context): () => void {
    const state = sceneStateFor(this)
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.register')
    const callerIdentity = componentIdentityOf(caller)
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
      caller.get('tuiEffectLedger')?.record(
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
    caller.get('tuiEffectLedger')?.record(
      { operation: 'create', resource: { kind: 'scene', id }, result: 'applied' },
      identity,
    )
    const dispose = () => {
      if (state.scenes.get(id) !== normalized) return
      state.scenes.delete(id)
      state.owners.delete(id)
      caller.get('tuiEffectLedger')?.record(
        { operation: 'release', resource: { kind: 'scene', id }, result: 'applied' },
        identity,
      )
      // Disposing the open scene must not strand the user on a dead screen.
      if (state.current === normalized) {
        state.current = undefined
        notifyScenes(state)
      }
    }
    bindCallerEffect(caller, dispose)
    return dispose
  }

  /**
   * Swap the conversation for the named scene. Returns false (and warns)
   * when no plugin registered that id — a mistyped id must fail visibly in
   * the log, not silently do nothing in the UI.
   */
  open(id: string): boolean {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.open')
    return openScene(this, id, caller)
  }

  close(): void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.close')
    closeScene(this, caller)
  }

  /** The scene currently replacing the conversation, if any. */
  get active(): TuiSceneDescriptor | undefined {
    return sceneStateFor(this).current
  }

  /** UI-side change feed: fired after every open/close/dispose transition. */
  subscribe(listener: () => void): () => void {
    const caller = requirePluginCaller(this.ctx, 'tuiScenes.subscribe')
    const dispose = subscribeScenes(this, listener)
    bindCallerEffect(caller, dispose)
    return dispose
  }

}

interface SceneState {
  readonly scenes: Map<string, TuiSceneDescriptor>
  readonly owners: Map<string, string>
  readonly listeners: Set<() => void>
  current: TuiSceneDescriptor | undefined
  host: TuiSceneHost | undefined
  readonly logger: Context['logger']
}

const sceneStates = new WeakMap<TuiSceneRuntime, SceneState>()

function sceneStateFor(runtime: TuiSceneRuntime): SceneState {
  const state = sceneStates.get(concreteService(runtime))
  if (state === undefined) throw new Error('tuiScenes host state is unavailable')
  return state
}

function openScene(runtime: TuiSceneRuntime, id: string, caller?: Context): boolean {
  const state = sceneStateFor(runtime)
  const scene = state.scenes.get(id.trim().toLowerCase())
  if (scene === undefined) {
    ;(caller?.logger ?? state.logger).warn(`dsh-tui: no TUI scene registered as "${id}"`)
    return false
  }
  if (caller !== undefined) {
    const callerIdentity = componentIdentityOf(caller)
    if (callerIdentity !== undefined) {
      const owner = `${callerIdentity.componentId}\0${callerIdentity.activationId}`
      if (state.owners.get(scene.id) !== owner) {
        caller.logger.warn(`dsh-tui: scene "${scene.id}" belongs to another activation`)
        return false
      }
    }
  }
  if (scene === state.current) return true
  state.current = scene
  notifyScenes(state)
  return true
}

function closeScene(runtime: TuiSceneRuntime, caller?: Context): void {
  const state = sceneStateFor(runtime)
  if (state.current === undefined) return
  if (caller !== undefined) {
    const callerIdentity = componentIdentityOf(caller)
    if (callerIdentity !== undefined) {
      const owner = `${callerIdentity.componentId}\0${callerIdentity.activationId}`
      if (state.owners.get(state.current.id) !== owner) {
        caller.logger.warn(`dsh-tui: scene "${state.current.id}" belongs to another activation`)
        return
      }
    }
  }
  state.current = undefined
  notifyScenes(state)
}

function subscribeScenes(runtime: TuiSceneRuntime, listener: () => void): () => void {
  const state = sceneStateFor(runtime)
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

function notifyScenes(state: SceneState): void {
  for (const listener of state.listeners) listener()
}

export function getHostSceneRuntime(runtime: TuiSceneRuntime | undefined): TuiSceneHost | undefined {
  if (runtime === undefined) return undefined
  try {
    return sceneStateFor(runtime).host ?? undefined
  } catch {
    return undefined
  }
}

export default TuiSceneRuntime
