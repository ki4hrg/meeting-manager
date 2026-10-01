'use client'

import { useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Button, type ButtonProps } from '@/components/ui/Button'
import { FormError } from '@/components/ui/Field'
import { Icon, type IconName } from '@/components/ui/icons'
import { Modal } from '@/components/ui/Modal'
import type { ActionResult } from '@/lib/web/action'

type Action = (formData: FormData) => Promise<ActionResult>

/**
 * A form bound to a server action.
 *
 * Submitted by hand rather than through `action=`, because React resets a form
 * after its action runs, and a refusal should leave what was typed in place.
 */
export function ActionForm({
  action,
  onDone,
  className = 'flex flex-col gap-4',
  children,
}: {
  action: Action
  onDone?: () => void
  className?: string
  children: React.ReactNode
}) {
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    // The submitter is included so two buttons can submit one form differently.
    const data = new FormData(form, (event.nativeEvent as SubmitEvent).submitter)

    startTransition(async () => {
      const result = await action(data)
      if (result?.error) {
        setError(result.error)
        return
      }
      setError(undefined)
      form.reset()
      onDone?.()
    })
  }

  return (
    <form onSubmit={onSubmit}>
      <fieldset disabled={pending} className={`min-w-0 ${className}`}>
        {children}
        <FormError>{error}</FormError>
      </fieldset>
    </form>
  )
}

/** A button that opens a modal holding one form. The fields are its children. */
export function FormModal({
  action,
  title,
  label,
  icon,
  submit = 'Save',
  also,
  variant = 'primary',
  size = 'md',
  children,
}: {
  action: Action
  title: string
  /** Shown on the button; with only an icon, the title is its accessible name. */
  label?: string
  icon?: IconName
  submit?: string
  /** A second way to submit the same form, sent as a named value. */
  also?: { label: string; name: string; value: string }
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  children: React.ReactNode
}) {
  /* Counts opens, and keys the form on it: each opening starts from the
     current values rather than whatever was left in the fields last time. */
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <>
      <Button
        variant={variant}
        size={size}
        aria-label={label ? undefined : title}
        onClick={() => {
          setOpened((count) => count + 1)
          setOpen(true)
        }}
      >
        {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
        {label}
      </Button>

      <Modal open={open} onClose={close} title={title}>
        <ActionForm key={opened} action={action} onDone={close}>
          {children}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            {also ? (
              <Button type="submit" name={also.name} value={also.value} variant="accent">
                {also.label}
              </Button>
            ) : null}
            <Button type="submit">{submit}</Button>
          </div>
        </ActionForm>
      </Modal>
    </>
  )
}

/** One click, one action. A refusal surfaces as a toast. */
export function ActionButton({
  action,
  fields,
  children,
  ...props
}: Omit<ButtonProps, 'onClick' | 'type'> & {
  action: Action
  fields: Record<string, string>
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      onClick={() => {
        const data = new FormData()
        for (const [name, value] of Object.entries(fields)) data.set(name, value)
        startTransition(async () => {
          const result = await action(data)
          if (result?.error) toast.error(result.error)
        })
      }}
    >
      {children}
    </Button>
  )
}
