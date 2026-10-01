'use client'

import { useActionState } from 'react'
import { Field, FormError, Input, SubmitButton } from '@/components/ui/Field'
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy'
import { setupAction, type FormState } from '../actions'

export function SetupForm() {
  const [state, action] = useActionState<FormState, FormData>(setupAction, {})

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field label="Name">
        <Input
          name="displayName"
          autoComplete="name"
          defaultValue={state.displayName}
          required
          autoFocus
        />
      </Field>
      <Field label="Email">
        <Input
          name="email"
          type="email"
          autoComplete="username"
          defaultValue={state.email}
          required
        />
      </Field>
      <Field label="Password">
        <Input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={MIN_PASSWORD_LENGTH}
          required
        />
      </Field>

      <FormError>{state.error}</FormError>
      <SubmitButton>Create account</SubmitButton>
    </form>
  )
}
