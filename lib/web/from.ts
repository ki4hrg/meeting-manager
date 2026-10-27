/*
 * Breadcrumbs that follow the way you came (issue #49).
 *
 * A link from a card carries `?from=<the page it was on>`. The page it opens
 * builds its crumbs from that (the section, then that page's name) and falls
 * back to where it lives when there is none: opened from Today, a pasted link,
 * a refresh of a page reached directly.
 *
 * `from` is only ever one of the app's own pages, matched whole against the
 * patterns below; anything else is ignored, so it can never send the browser
 * somewhere else. Pure, so links on the client can use it; the lookup of the
 * crumbs' names is `crumbsFrom` in `crumbs.ts`.
 */

export type Crumb = { href: string; label: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/* The lists a page can be opened from, and the section each reads as. */
const SECTIONS: Record<string, string> = {
  '/inbox': 'Inbox',
  '/items': 'Items',
  '/meetings': 'Meetings',
  '/meetings/past': 'Meetings',
  '/projects': 'Projects',
  '/people': 'People',
  '/groups': 'Groups',
  '/series': 'Series',
}

const HUB = new RegExp(`^/(items|meetings|people|groups|projects|series)/(${UUID})$`, 'i')
const MEETING_PAGE = new RegExp(`^/meetings/(${UUID})/(recap|review)$`, 'i')

export type HubKind = 'items' | 'meetings' | 'people' | 'groups' | 'projects' | 'series'

export type From =
  | { type: 'section'; path: string; label: string }
  | { type: 'hub'; path: string; kind: HubKind; id: string }
  | { type: 'meetingPage'; path: string; id: string; page: 'recap' | 'review' }

/** A known page of the app, or null for anything else (home included, which needs no way back). */
export function parseFrom(raw: string | string[] | null | undefined): From | null {
  if (typeof raw !== 'string' || raw.length > 200) return null
  const label = SECTIONS[raw]
  if (label) return { type: 'section', path: raw, label }
  const hub = HUB.exec(raw)
  if (hub) return { type: 'hub', path: raw, kind: hub[1]!.toLowerCase() as HubKind, id: hub[2]!.toLowerCase() }
  const page = MEETING_PAGE.exec(raw)
  if (page) {
    return { type: 'meetingPage', path: raw, id: page[1]!.toLowerCase(), page: page[2]!.toLowerCase() as 'recap' | 'review' }
  }
  return null
}

/** Whether a link to `href` opens a page that builds its crumbs from `from`. */
function takesFrom(path: string): boolean {
  return HUB.test(path) || MEETING_PAGE.test(path)
}

/**
 * `href` with the page it is followed from: on a link to a page that takes
 * `from`, when the current page is one `from` can name and is not the
 * destination itself. A link through `/api/open` carries it on its `to`.
 * Anything else comes back as it was.
 */
export function withFrom(href: string, current: string | null | undefined): string {
  if (!current || !parseFrom(current)) return href
  // A fragment (`#review`) stays at the end, after the query.
  const hashAt = href.indexOf('#')
  if (hashAt !== -1) return withFrom(href.slice(0, hashAt), current) + href.slice(hashAt)
  const [path, query = ''] = href.split('?', 2) as [string, string?]
  if (path === '/api/open') {
    const params = new URLSearchParams(query)
    const to = params.get('to')
    if (!to) return href
    params.set('to', withFrom(to, current))
    return `${path}?${params}`
  }
  if (path === current || !takesFrom(path)) return href
  const params = new URLSearchParams(query)
  params.set('from', current)
  return `${path}?${params}`
}
