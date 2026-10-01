'use client'

import { useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Select } from '@/components/ui/Field'
import type { ActionResult } from '@/lib/web/action'

/**
 * A select that is its own form: choosing submits. A refusal surfaces as a
 * toast and the choice goes back to what it was.
 *
 * Give it a `key` of its `value` where something else on the page can change
 * what is selected, so it starts again from the new value.
 */
export function ActionSelect({
  action,
  fields,
  name,
  value,
  label,
  className = '',
  children,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  fields: Record<string, string>
  /** The field the chosen option is sent as. */
  name: string
  value: string
  /** The accessible name: there is no visible label. */
  label: string
  className?: string
  children: React.ReactNode
}) {
  const toast = useToast()
  const [chosen, setChosen] = useState(value)
  const [pending, startTransition] = useTransition()

  return (
    <Select
      aria-label={label}
      value={chosen}
      disabled={pending}
      className={`!mt-0 ${className}`}
      onChange={(event) => {
        const next = event.target.value
        setChosen(next)
        const data = new FormData()
        for (const [field, fieldValue] of Object.entries(fields)) data.set(field, fieldValue)
        data.set(name, next)
        startTransition(async () => {
          const result = await action(data)
          if (result?.error) {
            toast.error(result.error)
            setChosen(value)
          }
        })
      }}
    >
      {children}
    </Select>
  )
}
