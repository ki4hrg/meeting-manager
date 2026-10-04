/*
 * GET /api/open?context=<id>&to=<path> — select a context, then go to a page
 * in it.
 *
 * Home lists what needs attention in every context; a row from another one is
 * opened through here, so the page arrives with its own context selected.
 * Reached by plain links (never prefetched), so every refusal is a redirect.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guards'
import { safeNext } from '@/lib/auth/redirects'
import { db } from '@/lib/db'
import { listContexts } from '@/lib/directory/contexts'
import { absoluteUrl } from '@/lib/oauth/config'
import { CONTEXT_COOKIE, contextCookieOptions } from '@/lib/web/context'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: NextRequest): Promise<Response> {
  if (!(await getCurrentUser())) {
    const back = `${request.nextUrl.pathname}${request.nextUrl.search}`
    return NextResponse.redirect(absoluteUrl(`/login?next=${encodeURIComponent(back)}`))
  }

  const params = request.nextUrl.searchParams
  // A path on this site only, never somewhere else.
  const to = safeNext(params.get('to'))
  const response = NextResponse.redirect(absoluteUrl(to))
  // Only a live context can be selected; anything else just goes to the page.
  const contextId = params.get('context')
  if (contextId && (await listContexts(db)).some((context) => context.id === contextId)) {
    response.cookies.set(CONTEXT_COOKIE, contextId, contextCookieOptions)
  }
  return response
}
