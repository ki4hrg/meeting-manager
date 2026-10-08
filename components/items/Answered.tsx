import { addAnsweredAction } from '@/app/(app)/actions'
import { FormModal } from '@/components/forms'
import { Section } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Field'
import type { ItemView } from '@/lib/items/items'
import { ItemGrid } from './ItemCard'

/**
 * A hub's answered questions, with Add for one settled somewhere this app did
 * not see. `on` is the project, group or series it is recorded on.
 */
export function Answered({
  items,
  today,
  on,
  showProject,
}: {
  items: ItemView[]
  today: string
  on: { projectId: string } | { groupId: string } | { seriesId: string }
  showProject?: boolean
}) {
  const [[name, value]] = Object.entries(on) as [[string, string]]
  return (
    <Section
      title="Answered" icon="question" tone="amber"
      count={items.length}
      action={
        <FormModal action={addAnsweredAction} title="Answered question" label="Add" icon="plus" variant="secondary" size="sm" submit="Add">
          <input type="hidden" name={name} value={value} />
          <Field label="Question" required>
            <Input name="text" required />
          </Field>
          <Field label="Answer" required>
            <Textarea name="answer" rows={3} required />
          </Field>
        </FormModal>
      }
    >
      <ItemGrid items={items} today={today} empty="question" showProject={showProject} />
    </Section>
  )
}
