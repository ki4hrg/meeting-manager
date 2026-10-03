'use client'

import { ActionButton, FormModal } from '@/components/forms'
import { useToast } from '@/components/Toast'
import { Field, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import type { ActionResult } from '@/lib/web/action'

type Action = (formData: FormData) => Promise<ActionResult>
/* A move that went through may still have something to say: what stayed behind. */
type MoveAction = (formData: FormData) => Promise<ActionResult & { notice?: string }>
type Option = { id: string; name: string }

/**
 * Move a meeting or a series to another context. `contexts` is the others;
 * with none there is nowhere to move to and nothing is drawn.
 */
export function MoveTo({
  action,
  id,
  contexts,
}: {
  action: MoveAction
  id: string
  contexts: Option[]
}) {
  const toast = useToast()
  if (contexts.length === 0) return null

  async function move(formData: FormData) {
    const result = await action(formData)
    if (result?.notice) toast.info(result.notice)
    return result
  }

  return (
    <FormModal action={move} title="Move" icon="arrowRight" compact iconSize="md" submit="Move">
      <input type="hidden" name="id" value={id} />
      <Field label="Context" required>
        <Select name="contextId" required defaultValue={contexts.length === 1 ? contexts[0]!.id : ''}>
          {contexts.length > 1 ? <option value="">—</option> : null}
          {contexts.map((context) => (
            <option key={context.id} value={context.id}>
              {context.name}
            </option>
          ))}
        </Select>
      </Field>
    </FormModal>
  )
}

/**
 * What a meeting's or a series' page shows while another context is selected:
 * its name, and one button that switches to the context it lives in.
 */
export function LivesIn({
  title,
  context,
  action,
  id,
}: {
  title: string
  context: Option
  action: Action
  id: string
}) {
  return (
    <PageHeader
      title={title}
      actions={
        <ActionButton action={action} fields={{ id }} variant="secondary">
          <Icon name="context" className="h-4 w-4" />
          {context.name}
        </ActionButton>
      }
    />
  )
}
