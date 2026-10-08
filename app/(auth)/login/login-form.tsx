'use client'

import { useActionState } from 'react'
import { buttonClasses } from '@/components/ui/Button'
import { Field, FormError, Input, SubmitButton } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { loginAction, type FormState } from '../actions'

export function LoginForm({
  next,
  sso,
  password,
  error,
}: {
  next?: string
  /** The single sign-on button, or null when SSO is off or unreachable. */
  sso: { displayName: string } | null
  password: boolean
  /** Why the last single sign-on came back here. */
  error?: string
}) {
  const [state, action] = useActionState<FormState, FormData>(loginAction, {})

  /* A plain link, not next/link: the start route answers with a redirect off
     this origin, which a client-side navigation cannot follow. */
  const ssoHref = `/api/auth/oidc/start${next && next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`

  return (
    <div className="flex flex-col gap-4">
      {sso ? (
        <a href={ssoHref} className={buttonClasses('primary')}>
          <Icon name="key" className="h-4 w-4" />
          Sign in with {sso.displayName}
        </a>
      ) : null}
      {state.error ? null : <FormError>{error}</FormError>}

      {sso && password ? <hr className="border-gray-200 dark:border-gray-700" /> : null}

      {password ? (
        <form action={action} className="flex flex-col gap-4">
          {/* Re-validated in the action; this field only carries it across. */}
          {next ? <input type="hidden" name="next" value={next} /> : null}

          <Field label="Email">
            <Input
              name="email"
              type="email"
              autoComplete="username"
              defaultValue={state.email}
              required
              autoFocus={!sso}
            />
          </Field>
          <Field label="Password">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>

          <FormError>{state.error}</FormError>
          <SubmitButton variant={sso ? 'secondary' : 'primary'}>Sign in</SubmitButton>
        </form>
      ) : null}
    </div>
  )
}
