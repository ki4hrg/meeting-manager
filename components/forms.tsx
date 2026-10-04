'use client'

import { useState, useTransition } from 'react'
import { useToast } from '@/components/Toast'
import { Button, type ButtonProps } from '@/components/ui/Button'
import { FormError } from '@/components/ui/Field'
import { IconButton, type IconButtonProps } from '@/components/ui/IconButton'
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
  compact = false,
  tone,
  iconSize,
  disabled = false,
  danger = false,
  wide = false,
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
  /** The trigger is a small icon button, as on a row. Needs `icon`. */
  compact?: boolean
  /** The compact trigger's tone and size, as an `IconButton`'s: `md` in a page header. */
  tone?: IconButtonProps['tone']
  iconSize?: IconButtonProps['size']
  disabled?: boolean
  /** The form destroys something: its submit button says so in red. */
  danger?: boolean
  /** A wider modal, for a form with a long text field. */
  wide?: boolean
  children?: React.ReactNode
}) {
  /* Counts opens, and keys the form on it: each opening starts from the
     current values rather than whatever was left in the fields last time. */
  const [opened, setOpened] = useState(0)
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const show = () => {
    setOpened((count) => count + 1)
    setOpen(true)
  }

  return (
    <>
      {compact && icon ? (
        <IconButton icon={icon} label={title} tone={tone} size={iconSize} disabled={disabled} onClick={show} />
      ) : (
        <Button
          variant={variant}
          size={size}
          aria-label={label ? undefined : title}
          disabled={disabled}
          onClick={show}
        >
          {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
          {label}
        </Button>
      )}

      <Modal open={open} onClose={close} title={title} size={wide ? 'lg' : 'md'}>
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
            <Button type="submit" variant={danger ? 'destructive' : 'primary'}>
              {submit}
            </Button>
          </div>
        </ActionForm>
      </Modal>
    </>
  )
}

/** An action that takes another back, offered on the toast that says it was done. */
export type Undo = { action: Action; fields: Record<string, string> }

function formOf(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, value)
  return data
}

/* Runs an action with fixed fields. A refusal surfaces as a toast. */
function useAction(action: Action, fields: Record<string, string>, done?: string, undo?: Undo) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  function run() {
    startTransition(async () => {
      const result = await action(formOf(fields))
      if (result?.error) toast.error(result.error)
      else if (done && undo) {
        toast.success(done, {
          label: 'Undo',
          run: () =>
            startTransition(async () => {
              const back = await undo.action(formOf(undo.fields))
              if (back?.error) toast.error(back.error)
            }),
        })
      } else if (done) toast.success(done)
    })
  }
  return { pending, run }
}

/** One click, one action, as a small icon on a row. */
export function IconAction({
  action,
  fields,
  done,
  undo,
  ...props
}: Omit<IconButtonProps, 'onClick' | 'type'> & {
  action: Action
  fields: Record<string, string>
  /** Said in a toast when there is nothing on screen to show it worked. */
  done?: string
  /** Offered as Undo on that toast. Needs `done`. */
  undo?: Undo
}) {
  const { pending, run } = useAction(action, fields, done, undo)
  return <IconButton {...props} disabled={pending || props.disabled} onClick={run} />
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
  const { pending, run } = useAction(action, fields)
  return (
    <Button {...props} disabled={pending || props.disabled} onClick={run}>
      {children}
    </Button>
  )
}
