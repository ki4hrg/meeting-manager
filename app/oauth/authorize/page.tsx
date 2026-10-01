/*
 * The consent screen.
 *
 * Deliberately outside app/(app)/: this is not a page in the app, it is a
 * decision about access, and wrapping it in the app's navigation invites reading
 * it as one more screen to click through. It authenticates itself rather than by
 * placement, and it is the only page in the app that does — everything under
 * app/(app)/ is guarded by its layout, and everything under app/api/ returns
 * 401s. This one has a third answer: go and log in, then come back *here*, to
 * this request, with its parameters intact.
 */

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/guards'
import {
  AuthorizeFatal,
  AuthorizeRedirect,
  SCOPE_DESCRIPTIONS,
  type RawAuthorizeParams,
  resolveTarget,
  validateRequest,
} from '@/lib/oauth/authorize'
import { formatScope } from '@/lib/oauth/config'
import { db } from '@/lib/db'
import { approveAction, denyAction } from './actions'
import { SubmitButton } from '@/components/ui/Field'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Authorize a connector' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

/** Repeated parameters are a malformed request, not a list. Take the first. */
function single(raw: Record<string, string | string[] | undefined>): RawAuthorizeParams {
  const out: RawAuthorizeParams = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key] = Array.isArray(value) ? value[0] : value
  }
  return out
}

export default async function AuthorizePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = single(await searchParams)

  let target
  try {
    target = await resolveTarget(db, raw)
  } catch (err) {
    if (err instanceof AuthorizeFatal) return <Refusal title={err.title} detail={err.detail} />
    throw err
  }

  const user = await getCurrentUser()
  if (!user) {
    /* Back to this exact request afterwards. Dropping the parameters here would
       land them on a bare /oauth/authorize with nothing to approve, and the
       connector would sit waiting for a window that never returns. */
    const next = `/oauth/authorize?${new URLSearchParams(
      Object.entries(raw).filter((e): e is [string, string] => e[1] !== undefined),
    ).toString()}`
    redirect(`/login?next=${encodeURIComponent(next)}`)
  }

  let request
  try {
    request = validateRequest(target, raw)
  } catch (err) {
    // The redirect URI is proven by now, so the client is told in its own terms.
    if (err instanceof AuthorizeRedirect) redirect(err.location())
    throw err
  }

  return (
    <Frame>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Connect {request.client.clientName}?
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{user.email}</p>

      <ul className="mt-5 flex flex-col gap-4 border-y border-gray-200 py-5 dark:border-gray-700">
        {request.scopes.map((scope) => (
          <li key={scope}>
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {SCOPE_DESCRIPTIONS[scope].label}
            </p>
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {SCOPE_DESCRIPTIONS[scope].detail}
            </p>
          </li>
        ))}
      </ul>

      <form className="mt-6 flex flex-col gap-3">
        <input type="hidden" name="client_id" value={request.client.id} />
        <input type="hidden" name="redirect_uri" value={request.redirectUri} />
        <input type="hidden" name="response_type" value="code" />
        {/* Re-derived server-side regardless; this carries the request, not authority. */}
        <input type="hidden" name="scope" value={formatScope(request.scopes)} />
        <input type="hidden" name="code_challenge" value={request.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        {request.state ? <input type="hidden" name="state" value={request.state} /> : null}
        {request.resource ? <input type="hidden" name="resource" value={request.resource} /> : null}

        <SubmitButton formAction={approveAction}>Approve</SubmitButton>
        <SubmitButton formAction={denyAction} variant="secondary">
          Cancel
        </SubmitButton>
      </form>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-900">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow dark:bg-gray-800">
        <h1 className="mb-6 text-xl font-semibold text-gray-900 dark:text-gray-100">Meetings</h1>
        {children}
      </div>
    </main>
  )
}

/** A request that cannot be answered anywhere but here. */
function Refusal({ title, detail }: { title: string; detail: string }) {
  return (
    <Frame>
      <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">{title}</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{detail}</p>
    </Frame>
  )
}
