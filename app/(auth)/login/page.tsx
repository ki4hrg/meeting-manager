import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth/guards'
import { safeNext } from '@/lib/auth/redirects'
import { needsSetup } from '@/lib/auth/users'
import { LoginForm } from './login-form'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  if (await needsSetup()) redirect('/setup')

  const raw = (await searchParams).next
  /* Sanitized here as well as in the action, so a hostile URL is never
     reflected into the form's markup. */
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw)

  // Already signed in and sent here by a connector: carry on to the request.
  if (await getCurrentUser()) redirect(next)

  return <LoginForm next={next} />
}
