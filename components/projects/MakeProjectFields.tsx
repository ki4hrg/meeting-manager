import { Checkbox, Field, Input, Select } from '@/components/ui/Field'
import { PROJECT_STATUS, type ProjectStatus } from '@/components/ui/StatusBadge'

/* What a project made from a topic can start as: proposed unless already agreed to. */
const STATUSES: ProjectStatus[] = ['proposed', 'pending', 'active']

/**
 * Make project's form, on an item page and on a review card: the name (the
 * topic's text), the project it sits within (the topic's), its status
 * (proposed), and whether the topic closes.
 */
export function MakeProjectFields({
  name,
  parentId,
  projects,
}: {
  name: string
  parentId: string | null
  /** The projects it can sit within, already in the order and wording to show. */
  projects: { id: string; name: string }[]
}) {
  return (
    <>
      <Field label="Name" required>
        <Input name="name" required defaultValue={name} />
      </Field>
      <Field label="Within">
        <Select name="parentId" defaultValue={parentId ?? ''}>
          <option value="">—</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Status">
        <Select name="status" defaultValue="proposed">
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {PROJECT_STATUS[status].label}
            </option>
          ))}
        </Select>
      </Field>
      <Checkbox name="closeTopic" label="Close the topic" />
    </>
  )
}
