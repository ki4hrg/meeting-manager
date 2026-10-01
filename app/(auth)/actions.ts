'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ValidationError } from '@/lib/core/types'
import { verifyPassword } from '@/lib/auth/password'
import { safeNext } from '@/lib/auth/redirects'
import {
  SESSION_COOKIE,
  cookieOptions,
  createSession,
  revokeSession,
} from '@/lib/auth/sessions'
import { createFirstUser, findUserByEmail, needsSetup } from '@/lib/auth/users'

/* React resets a form after its action runs, so what was typed comes back in
   the state; otherwise one wrong password also clears the email. */
export type FormState = { error?: string; email?: string; displayName?: string }

async function startSession(userId: string) {
  const h = await headers()
  const session = await createSession(userId, {
    userAgent: h.get('user-agent'),
    // Behind the proxy that terminates TLS, the socket address is the proxy's.
    ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  })
  const jar = await cookies()
  jar.set(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt })
}

export async function setupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
  const displayName = String(formData.get('displayName') ?? '')

  try {
    const user = await createFirstUser({
      email,
      displayName,
      password: String(formData.get('password') ?? ''),
    })
    await startSession(user.id)
  } catch (err) {
    if (err instanceof ValidationError) return { error: err.message, email, displayName }
    throw err
  }

  // Outside the try: redirect() signals by throwing.
  redirect('/')
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '')
  const password = String(formData.get('password') ?? '')
  /* The one string a visitor supplies that decides where a browser goes
     afterwards; see lib/auth/redirects.ts. */
  const next = safeNext(formData.get('next')?.toString())

  if (await needsSetup()) redirect('/setup')

  const user = await findUserByEmail(email)

  /* Verify even when the address is unknown, against a hash that cannot match,
     so "no such user" is not measurably faster than "wrong password". */
  const storedHash =
    user?.passwordHash ??
    '$argon2id$v=19$m=19456,t=2,p=1$bW0tZHVtbXktc2FsdC0wMA$0000000000000000000000000000000000000000000'
  const ok = await verifyPassword(storedHash, password)

  // One message for both failures, for the same reason.
  if (!user || !ok) return { error: 'Email and password do not match.', email }

  await startSession(user.id)
  redirect(next)
}

export async function logoutAction() {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) await revokeSession(token)
  jar.delete(SESSION_COOKIE)
  redirect('/login')
}
