import { ArchivedSection } from '@/components/archive/Archive'
import { FormModal } from '@/components/forms'
import { CardGrid, CardHeader, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { DueBadge, ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { openCounts } from '@/lib/items/items'
import { indented, listProjects, nextMilestones, treeOrder } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createProjectAction } from '../actions'

export default async function ProjectsPage() {
  const context = await requireContext()
  const { today } = await viewer()
  // In tree order: a project's sub-projects follow it, each naming what it sits within.
  const all = await listProjects(db, context.id)
  const archived = await listProjects(db, context.id, 'archived')
  const projects = treeOrder(all)
  const nameOf = new Map(all.map((project) => [project.id, project.name]))
  const counts = await openCounts(db, context.id)
  const milestones = await nextMilestones(db, context.id, today)

  return (
    <>
      <PageHeader
        title="Projects"
        count={projects.length}
        actions={
          <FormModal action={createProjectAction} title="New project" label="New project">
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
        <CardGrid>
          {projects.map((project) => {
            const next = milestones.get(project.id)
            return (
              <LinkCard key={project.id} href={`/projects/${project.id}`}>
                {project.parentId && nameOf.has(project.parentId) ? (
                  <p className="-mt-1 mb-1 flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <Icon name="project" className="h-3 w-3 shrink-0" />
                    <span className="truncate">{nameOf.get(project.parentId)}</span>
                  </p>
                ) : null}
                <CardHeader
                  title={project.name}
                  aside={<ProjectStatusBadge status={project.status} />}
                />
                <div className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-1">
                    <Icon name="action" className="h-3.5 w-3.5" label="Open" />
                    {counts.byProject.get(project.id) ?? 0}
                  </span>
                  {next ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Icon name="flag" className="h-3.5 w-3.5 shrink-0" label="Next milestone" />
                      <span className="truncate">{next.title}</span>
                      <DueBadge
                        label={formatDay(next.dueOn!, today)}
                        dueOn={next.dueOn!}
                        today={today}
                      />
                    </span>
                  ) : null}
                </div>
              </LinkCard>
            )
          })}
        </CardGrid>
      )}
      <ArchivedSection
        icon="project"
        rows={archived.map((project) => ({ id: project.id, name: project.name, href: `/projects/${project.id}` }))}
      />
    </>
  )
}
