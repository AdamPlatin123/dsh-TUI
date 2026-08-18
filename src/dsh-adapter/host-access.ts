import { Context } from '@deepseek-ai/cordis'

/**
 * Recover the concrete Cordis service for host-only adapters.
 *
 * `ctx.get()` returns a traceable proxy even to the root context. Public
 * services deliberately do not expose their host controls on that proxy, so
 * the host accessor functions keep their state in WeakMaps keyed by the
 * concrete service instance and unwrap only here.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const compositionRoots = new WeakMap<object, Context>()
const trackedRoots = new WeakSet<object>()
const trustedFibers = new WeakSet<object>()
const rootFibers = new WeakMap<object, object>()
const fiberRoots = new WeakMap<object, Context>()
const fiberEffects = new WeakMap<object, (execute: () => unknown) => unknown>()
const contextFibers = new WeakMap<object, object>()
const restartingFibers = new WeakSet<object>()
const restartPendingFibers = new WeakSet<object>()
const executingFibers = new WeakSet<object>()
const wrappedRunners = new WeakSet<object>()
const wrappedRestarts = new WeakSet<object>()

/**
 * Cordis contexts are prototype-scoped objects. A plugin can therefore make
 * `ctx.extend({ fiber: fake })`, which passes a shape-only check while making
 * cleanup land on an attacker-controlled effect object. Track the fibers
 * Cordis actually publishes from the composition root and require callers to
 * use one of those identities. The root listener is global so child context
 * filters cannot hide lifecycle notifications from this guard.
 */
function rememberFiber(value: unknown, root?: Context): object | undefined {
  if (typeof value !== 'object' || value === null) return
  try {
    const fiber = value as { ctx?: unknown }
    const owner = fiber.ctx
    if (!Context.is(owner)) return
    // The internal/plugin event carries Cordis's wrapper Fiber, while the
    // context exposes the underlying instance. Normalize both to that stable
    // instance before recording trust and lifecycle state.
    const actual = owner.fiber
    if (typeof actual !== 'object' || actual === null || actual.ctx !== owner) return
    trustedFibers.add(actual)
    if (root !== undefined) fiberRoots.set(actual, root)
    if (!fiberEffects.has(actual)) {
      const effect = (actual as { effect?: unknown }).effect
      if (typeof effect === 'function') {
        fiberEffects.set(actual, (execute) => Reflect.apply(effect, actual, [execute]))
      }
    }
    // Cordis reuses the same activation context across a restart and emits
    // LOADING before its private runner executes the new callback. Keep the
    // old activation rejected through that window, but allow synchronous
    // registrations made by the callback currently being executed.
    const runner = (actual as unknown as {
      _runner?: { execute?: (...args: unknown[]) => unknown }
    })._runner
    if (runner !== undefined && typeof runner.execute === 'function' && !wrappedRunners.has(runner)) {
      const execute = runner.execute
      wrappedRunners.add(runner)
      runner.execute = function (this: unknown, ...args: unknown[]): unknown {
        executingFibers.add(actual)
        try {
          return Reflect.apply(execute, this, args)
        } finally {
          executingFibers.delete(actual)
        }
      }
    }
    const restart = (actual as unknown as { restart?: (...args: unknown[]) => unknown }).restart
    if (typeof restart === 'function' && !wrappedRestarts.has(actual)) {
      wrappedRestarts.add(actual)
      ;(actual as unknown as { restart: (...args: unknown[]) => unknown }).restart = function (this: unknown, ...args: unknown[]): unknown {
        restartPendingFibers.add(actual)
        restartingFibers.add(actual)
        const clear = (): void => {
          restartPendingFibers.delete(actual)
          restartingFibers.delete(actual)
        }
        try {
          const result = Reflect.apply(restart, this, args)
          if (result !== null && typeof result === 'object' && 'then' in result) {
            return Promise.resolve(result).finally(clear)
          }
          clear()
          return result
        } catch (error) {
          clear()
          throw error
        }
      }
    }
    return actual
  } catch {
    // Untrusted values are simply not admitted to the identity set.
  }
}

function trackCompositionRoot(root: Context): void {
  let rootFiber: object | undefined
  try {
    const value = root.fiber
    if (typeof value === 'object' && value !== null) {
      rootFiber = value
      rootFibers.set(root as object, value)
      fiberRoots.set(value, root)
    }
  } catch {
    // Fall through to the event-listener attempt below.
  }
  rememberFiber(rootFiber, root)
  if (trackedRoots.has(root as object)) return
  trackedRoots.add(root as object)
  try {
    root.on('internal/plugin', (fiber) => rememberFiber(fiber, root), { global: true })
    root.on('internal/status', (fiber) => {
      const actual = rememberFiber(fiber, root)
      if (actual === undefined) return
      const state = (fiber as { state?: number }).state
      // Cordis uses 5 for UNLOADING. The wrapper returned by ctx.plugin()
      // reports this transition while the underlying context fiber may still
      // expose ACTIVE, so track the transition explicitly. Keep the marker
      // through LOADING: Cordis awaits a microtask before invoking the new
      // callback, leaving a stale-context window otherwise. The runner wrapper
      // above temporarily admits synchronous calls from that new callback.
      if (state === 5 || state === 3 || state === 4) restartingFibers.add(actual)
      else if (state === 2 && !restartPendingFibers.has(actual)) restartingFibers.delete(actual)
    }, { global: true })
  } catch {
    // Minimal embedders may expose Context without an event helper. The
    // shape/lifecycle checks below remain as a conservative fallback.
  }
}

export function concreteService<T extends object>(service: T): T {
  let current: object = service
  const seen = new WeakSet<object>()
  while (!seen.has(current)) {
    seen.add(current)
    let original: unknown
    try {
      original = Reflect.get(current, CORDIS_ORIGINAL)
    } catch {
      break
    }
    if (original === null || typeof original !== 'object' || original === current) break
    current = original
  }
  return current as T
}

/** Bind a host-side disposer to the caller's authenticated Cordis activation.
 * A failed registration immediately rolls back the owned contribution. */
export function bindCallerEffect(
  ctx: Context,
  disposer: () => unknown,
  onRegistered?: (cleanup: () => unknown) => void,
): boolean {
  let effect: ((execute: () => unknown) => unknown) | undefined
  try {
    const fiber = assertLiveContext(ctx, 'effect')
    effect = fiberEffects.get(fiber)
  } catch {
    // An untrusted or inactive caller cannot use a compatibility fallback to
    // attach cleanup to a writable context shadow.
    disposer()
    return false
  }
  if (effect === undefined) {
    disposer()
    return false
  }
  try {
    const cleanup = effect(() => disposer)
    if (typeof cleanup === 'function') {
      onRegistered?.(cleanup as () => unknown)
    }
    return true
  } catch {
    // Registration and the mutation it owns must be atomic. If the fiber has
    // entered teardown, immediately undo the caller's contribution.
    disposer()
    return false
  }
}

/** Return the stable, authenticated Fiber identity for an activation. */
export function activationFiber(ctx: Context): object | undefined {
  try {
    return assertLiveContext(ctx, 'activation')
  } catch {
    return undefined
  }
}

/** Return Cordis's canonical activation context, never a writable context
 * shadow. Explicit owner arguments use this before resolving host services. */
export function activationContext(ctx: Context): Context | undefined {
  const fiber = activationFiber(ctx)
  if (fiber === undefined) return undefined
  try {
    const owner = (fiber as { ctx?: unknown }).ctx
    return Context.is(owner) ? owner : undefined
  } catch {
    return undefined
  }
}

/** Resolve a service's composition root once.  Service methods are invoked
 * through caller-bound Cordis proxies; keeping this root in host state avoids
 * resolving sibling services through an attacker-provided caller shadow. */
export function compositionRoot(ctx: Context): Context {
  try {
    const knownFiber = contextFibers.get(ctx as object)
    const trustedRoot = knownFiber === undefined ? undefined : fiberRoots.get(knownFiber)
    if (trustedRoot !== undefined) {
      compositionRoots.set(ctx as object, trustedRoot)
      return trustedRoot
    }
    const directFiber = ctx.fiber
    const directRoot = typeof directFiber === 'object' && directFiber !== null
      ? fiberRoots.get(directFiber)
      : undefined
    if (directRoot !== undefined) {
      contextFibers.set(ctx as object, directFiber as object)
      compositionRoots.set(ctx as object, directRoot)
      return directRoot
    }
    const cached = compositionRoots.get(ctx as object)
    if (cached !== undefined) {
      trackCompositionRoot(cached)
      return cached
    }
  } catch {
    // Fall through to the fiber walk for degraded contexts.
  }
  try {
    let current = ctx
    const seen = new Set<object>()
    for (let depth = 0; depth < 64; depth += 1) {
      const currentFiber = current.fiber
      if (typeof currentFiber !== 'object' || currentFiber === null || seen.has(currentFiber)) break
      seen.add(currentFiber)
      const cached = compositionRoots.get(current as object)
      if (cached !== undefined) {
        compositionRoots.set(ctx as object, cached)
        trackCompositionRoot(cached)
        return cached
      }
      if (currentFiber.runtime === null) {
        const root = Context.is(currentFiber.ctx) ? currentFiber.ctx : current
        compositionRoots.set(current as object, root)
        compositionRoots.set(ctx as object, root)
        compositionRoots.set(root as object, root)
        trackCompositionRoot(root)
        return root
      }
      const parent = currentFiber.parent
      if (!Context.is(parent)) break
      current = parent
    }
  } catch {
    // Fall through to the conservative self-root fallback below.
  }
  compositionRoots.set(ctx as object, ctx)
  trackCompositionRoot(ctx)
  return ctx
}

function assertLiveContext(ctx: Context, capability: string): object {
  try {
    const known = contextFibers.get(ctx as object)
    const fiber = (known ?? ctx.fiber) as typeof ctx.fiber & { state?: number }
    if (fiber.uid === null) throw new Error('disposed')
    // @deepseek-ai/cordis exposes FiberState as a const enum, so it is not a
    // runtime export. LOADING=1 and ACTIVE=2 are the only states in which a
    // caller can still be executing/owning effects; all other states reject.
    if (fiber.state !== 1 && fiber.state !== 2) {
      throw new Error('inactive')
    }
    // `Fiber.restart()` invalidates the runner epoch before Cordis updates
    // the public state. Read the runtime-private marker as well so a retained
    // context cannot register an effect during that unload/reload window.
    const runner = (fiber as unknown as { _runner?: { epoch?: unknown } })._runner
    if (runner?.epoch === '__INACTIVE__') {
      throw new Error('inactive')
    }
    if (!trustedFibers.has(fiber as object)) throw new Error('unregistered')
    const owner = (fiber as unknown as { ctx?: unknown }).ctx
    if (!Context.is(owner)) throw new Error('unowned')
    let current: object | null = ctx as object
    let matched = false
    for (let depth = 0; depth < 64 && current !== null; depth += 1) {
      if (current === owner) {
        matched = true
        break
      }
      current = Object.getPrototypeOf(current) as object | null
    }
    if (!matched || (restartingFibers.has(fiber as object) && !executingFibers.has(fiber as object))) throw new Error('inactive')
    contextFibers.set(ctx as object, fiber as object)
    return fiber as object
  } catch {
    // Fall through to the stable public error below.
  }
  throw new Error(`dsh-tui: ${capability} requires a live Cordis activation context`)
}

/** Recover the composition root that owns a traceable service. Cordis stores
 * the provider context on the concrete Service instance; callers may reach
 * that instance through a proxy from another composition, so this must be
 * resolved from the unwrapped service rather than from the call context. */
export function serviceCompositionRoot(service: object): Context | undefined {
  try {
    const owner = (concreteService(service) as { ctx?: unknown }).ctx
    return Context.is(owner) ? compositionRoot(owner) : undefined
  } catch {
    return undefined
  }
}

/** Explicit context arguments on mediated APIs may be supplied by host code
 * running from the composition root, or may be the activation making the
 * service call.  A non-root plugin cannot nominate a different activation's
 * context and thereby borrow its verified identity/lifecycle. */
export function assertCallerContext(caller: Context, target: Context, capability: string, service?: object): void {
  if (!Context.is(caller) || !Context.is(target)) {
    throw new Error(`dsh-tui: ${capability} requires a Cordis activation context`)
  }
  const callerFiber = assertLiveContext(caller, capability)
  const targetFiber = assertLiveContext(target, capability)
  const ownerRoot = service === undefined ? undefined : serviceCompositionRoot(service)
  if (ownerRoot !== undefined
    && (compositionRoot(caller) !== ownerRoot || compositionRoot(target) !== ownerRoot)) {
    throw new Error(`dsh-tui: ${capability} context belongs to a different composition`)
  }
  if (caller === target || callerFiber === targetFiber) return
  const root = compositionRoot(caller)
  if (caller === root || callerFiber === rootFibers.get(root as object)) return
  throw new Error(`dsh-tui: ${capability} context must be the calling activation`)
}

/**
 * Resolve the caller for a plugin-owned effect. A plugin can read
 * `ctx.root`, but using its root-bound service proxy would attach cleanup to
 * the host fiber and leave the effect alive after the plugin unloads. Host
 * code must use the module-local host accessor for controls it owns; the
 * public service surface only accepts a live non-root activation.
 */
export function requirePluginCaller(caller: Context, capability: string, service?: object): Context {
  if (!Context.is(caller)) {
    throw new Error(`dsh-tui: ${capability} requires a Cordis activation context`)
  }
  try {
    const callerFiber = assertLiveContext(caller, capability)
    const root = compositionRoot(caller)
    if (caller === root || callerFiber === rootFibers.get(root as object)) {
      throw new Error(`dsh-tui: ${capability} requires a non-root calling activation`)
    }
    const ownerRoot = service === undefined ? undefined : serviceCompositionRoot(service)
    if (ownerRoot !== undefined && compositionRoot(caller) !== ownerRoot) {
      throw new Error(`dsh-tui: ${capability} context belongs to a different composition`)
    }
    return caller
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('dsh-tui:')) throw error
    throw new Error(`dsh-tui: ${capability} requires a live non-root calling activation`)
  }
}
