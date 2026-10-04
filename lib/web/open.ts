/*
 * A link to a page in a context that may not be the selected one. Within the
 * selected context it is the page itself; from another, it goes through
 * /api/open, which selects that context on the way (and so must be a plain
 * link, never prefetched).
 */

export function openHref(path: string, contextId: string, selectedId: string): string {
  if (contextId === selectedId) return path
  return `/api/open?${new URLSearchParams({ context: contextId, to: path })}`
}

/** Whether a link made by `openHref` switches context: such links must not be prefetched. */
export function switches(href: string): boolean {
  return href.startsWith('/api/open?')
}
