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

/** Bind a host-side disposer to the caller's Cordis activation. Minimal test
 * contexts may not implement `effect`; those contexts retain the explicit
 * disposer-only compatibility path. */
export function bindCallerEffect(ctx: Context, disposer: () => unknown): void {
  try {
    ctx.effect(() => disposer)
  } catch {
    // Degraded embedders can still call the returned disposer explicitly.
  }
}

/** Resolve a service's composition root once.  Service methods are invoked
 * through caller-bound Cordis proxies; keeping this root in host state avoids
 * resolving sibling services through an attacker-provided caller shadow. */
export function compositionRoot(ctx: Context): Context {
  try {
    const cached = compositionRoots.get(ctx as object)
    if (cached !== undefined) return cached
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
        return cached
      }
      if (currentFiber.runtime === null) {
        const root = Context.is(currentFiber.ctx) ? currentFiber.ctx : current
        compositionRoots.set(current as object, root)
        compositionRoots.set(ctx as object, root)
        compositionRoots.set(root as object, root)
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
  return ctx
}

function assertLiveContext(ctx: Context, capability: string): void {
  try {
    if (ctx.fiber.uid !== null) return
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
  assertLiveContext(caller, capability)
  assertLiveContext(target, capability)
  const ownerRoot = service === undefined ? undefined : serviceCompositionRoot(service)
  if (ownerRoot !== undefined
    && (compositionRoot(caller) !== ownerRoot || compositionRoot(target) !== ownerRoot)) {
    throw new Error(`dsh-tui: ${capability} context belongs to a different composition`)
  }
  if (caller === target) return
  try {
    if (caller.fiber === target.fiber) return
  } catch {
    // Fall through to the conservative context mismatch below.
  }
  const root = compositionRoot(caller)
  try {
    if (caller === root || caller.fiber === root.fiber) return
  } catch {
    if (caller === root) return
  }
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
    assertLiveContext(caller, capability)
    const root = compositionRoot(caller)
    if (caller === root || caller.fiber === root.fiber) {
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
