/*
 * GET /api/connect/todoist/callback — where Todoist sends John back.
 *
 * Exchanges the code, stores the connection, reads every task, and sets aside
 * the items already open for matching. Every outcome is a redirect to
 * /settings: `?connected=todoist`, or `?error=` with something he can read.
 */

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth/guards'
import { AppError } from '@/lib/core/types'
import { stateMatches } from '@/lib/connect/google/oauth'
import { TodoistApiError, exchangeCode } from '@/lib/connect/todoist/client'
import { CALLBACK_PATH, STATE_COOKIE, todoistApp } from '@/lib/connect/todoist/connection'
import { connectTodoist } from '@/lib/connect/todoist/sync'
import { db } from '@/lib/db'
import { kick, TODOIST_SYNC } from '@/lib/jobs'
import { absoluteUrl } from '@/lib/oauth/config'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/* The state is single-use: whatever happened, the cookie goes. */
function back(params: Record<string, string>): Response {
  const response = NextResponse.redirect(`${absoluteUrl('/settings')}?${new URLSearchParams(params)}`)
  response.cookies.delete(STATE_COOKIE)
  return response
}

const refused = (message: string) => back({ error: message.slice(0, 200) })

export async function GET(request: Request): Promise<Response> {
  if (!(await getCurrentUser())) return NextResponse.redirect(absoluteUrl('/login'))

  const url = new URL(request.url)
  const stored = (await cookies()).get(STATE_COOKIE)?.value
  const error = url.searchParams.get('error')

  /* Checked before anything else in the request is believed, the error
     included: a callback this browser did not start is not Todoist answering. */
  if (!stateMatches(url.searchParams.get('state'), stored)) {
    return refused('That sign-in was not started here, or it expired. Try again.')
  }
  if (error) {
    return refused(error === 'access_denied' ? 'Todoist access was not granted.' : error)
  }
  const code = url.searchParams.get('code')
  if (!code) return refused('Todoist sent no authorization code.')

  const app = todoistApp()
  if (!app) return refused('Todoist is not configured.')

  try {
    const tokens = await exchangeCode(app, code, absoluteUrl(CALLBACK_PATH))
    await connectTodoist(db, tokens)
  } catch (err) {
    if (err instanceof AppError || err instanceof TodoistApiError) return refused(err.message)
    throw err
  }

  void kick(TODOIST_SYNC)
  return back({ connected: 'todoist' })
}
