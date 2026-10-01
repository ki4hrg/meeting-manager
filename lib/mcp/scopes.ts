/*
 * Authorization at the call, which is the one that counts.
 *
 * Filtering `tools/list` by scope keeps a model from planning around a tool it
 * cannot call, but a tool list is client-side and can be stale. So the list is
 * the first layer and this check, made on every call, is the one that holds.
 */

import type { Scope } from '../oauth/config'
import type { BearerIdentity } from '../oauth/grants'

export function granted(identity: BearerIdentity, scope: Scope): boolean {
  return identity.scopes.includes(scope)
}

/** Names the scope and says reconnecting can grant it, so a model can act on it. */
export function refusalFor(scope: Scope): string {
  return (
    `This connection was not granted ${scope}. Reconnect the Meeting Manager connector and ` +
    `approve ${scope} to use this tool.`
  )
}
