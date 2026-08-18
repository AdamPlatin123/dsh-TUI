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
    const root = ctx.root
    return Context.is(root) ? root : ctx
  } catch {
    return ctx
  }
}

/** Explicit context arguments on mediated APIs may be supplied by host code
 * running from the composition root, or may be the activation making the
 * service call.  A non-root plugin cannot nominate a different activation's
 * context and thereby borrow its verified identity/lifecycle. */
export function assertCallerContext(caller: Context, target: Context, capability: string): void {
  if (!Context.is(caller) || !Context.is(target)) {
    throw new Error(`dsh-tui: ${capability} requires a Cordis activation context`)
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
