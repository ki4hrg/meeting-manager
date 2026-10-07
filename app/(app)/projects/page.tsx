import { ArchivedSection } from '@/components/archive/Archive'
import { FormModal } from '@/components/forms'
import { ProjectTree, type ProjectTreeNode } from '@/components/projects/ProjectTree'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { PageHeader } from '@/components/ui/PageHeader'
import { formatDay } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { openCounts } from '@/lib/items/items'
import {
  indented,
  listProjects,
  nextMilestones,
  projectTree,
  treeOrder,
  type Project,
  type ProjectNode,
} from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createProjectAction } from '../actions'

export default async function ProjectsPage() {
  const context = await requireContext()
  const { today } = await viewer()
  const all = await listProjects(db, context.id)
  const archived = await listProjects(db, context.id, 'archived')
  const projects = treeOrder(all)
  // One block per top-level project; an archived parent stays, muted, above its live sub-projects.
  const roots = projectTree(all, archived)
  const counts = await openCounts(db, context.id)
  const milestones = await nextMilestones(db, context.id, today)

  const view = (node: ProjectNode<Project>): ProjectTreeNode => {
    const children = node.children.map(view)
    const open = counts.byProject.get(node.id) ?? 0
    const next = milestones.get(node.id)
    return {
      id: node.id,
      name: node.name,
      status: node.status,
      archived: node.archived,
      open,
      subtree: children.reduce((sum, child) => sum + child.subtree, open),
      next: next?.dueOn ? { title: next.title, label: formatDay(next.dueOn, today), dueOn: next.dueOn } : null,
      children,
    }
  }

  return (
    <>
      <PageHeader
        title="Projects"
        count={projects.length}
        actions={
          <FormModal action={createProjectAction} title="New project" label="New project" icon="plus">
            <Field label="Name" required>
              <Input name="name" required />
            </Field>
            {projects.length > 0 ? (
              <Field label="Within">
                <Select name="parentId" defaultValue="">
                  <option value="">—</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {indented(project)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Description">
              <Textarea name="description" rows={3} />
            </Field>
          </FormModal>
        }
      />

      {projects.length === 0 ? (
        <EmptyState icon="project" />
      ) : (
        <ProjectTree roots={roots.map(view)} today={today} remember />
      )}
      <ArchivedSection
        icon="project"
        rows={archived.map((project) => ({ id: project.id, name: project.name, href: `/projects/${project.id}` }))}
      />
    </>
  )
}
