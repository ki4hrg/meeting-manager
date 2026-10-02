/*
 * In-memory state that has to survive the bundler, not just the process.
 *
 * Next compiles server code in layers (a Server Action is one, a Route Handler
 * another, `instrumentation` a third), and the same source file compiled into
 * two layers is two modules, each with its own copy of everything at module
 * scope. A module-level Map written by the job loop in `instrumentation` would
 * never be seen by a server action asking whether that job is running. Both
 * halves typecheck and both pass their tests; at runtime one writes to a Map
 * the other never reads.
 *
 * `globalThis` is the one namespace the layers share, so state two entry
 * points both need goes through here, keyed by name.
 *
 * It is one process and it is lost on restart. Anything that must survive a
 * restart belongs in Postgres.
 */

type Registry = Map<string, unknown>

const holder = globalThis as unknown as { __mm_process_state?: Registry }

/**
 * The process-wide Map registered under `name`, created on first ask. Call it
 * at module scope and use the result like a local Map; every copy of the
 * calling module gets the same one.
 */
export function processMap<V>(name: string): Map<string, V> {
  const registry = (holder.__mm_process_state ??= new Map())

  const existing = registry.get(name)
  if (existing) return existing as Map<string, V>

  const created = new Map<string, V>()
  registry.set(name, created)
  return created
}
