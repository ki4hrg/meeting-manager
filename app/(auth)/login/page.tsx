import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/guards'
import { signInOptions } from '@/lib/auth/oidc'
import { oidcErrorMessage } from '@/lib/auth/oidc-errors'
import { safeNext } from '@/lib/auth/redirects'
import { needsSetup } from '@/lib/auth/users'
import { LoginForm } from './login-form'

const first = (raw: string | string[] | undefined) => (Array.isArray(raw) ? raw[0] : raw)

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[]; error?: string | string[] }>
}) {
  if (await needsSetup()) redirect('/setup')

  const params = await searchParams
  /* Sanitized here as well as in the action, so a hostile URL is never
     reflected into the form's markup. */
  const next = safeNext(first(params.next))

  // Already signed in and sent here by a connector: carry on to the request.
  if (await getCurrentUser()) redirect(next)

  const options = await signInOptions()

  return (
    <LoginForm
      next={next}
      sso={options.sso}
      password={options.password}
      error={oidcErrorMessage(first(params.error), options.providerName)}
    />
  )
}
