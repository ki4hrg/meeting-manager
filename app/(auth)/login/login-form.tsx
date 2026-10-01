'use client'

import { useActionState } from 'react'
import { Field, FormError, Input, SubmitButton } from '@/components/ui/Field'
import { loginAction, type FormState } from '../actions'

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState<FormState, FormData>(loginAction, {})

  return (
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
          autoFocus
        />
      </Field>
      <Field label="Password">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>

      <FormError>{state.error}</FormError>
      <SubmitButton>Sign in</SubmitButton>
    </form>
  )
}
