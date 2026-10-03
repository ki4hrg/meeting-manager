import { FormModal } from '@/components/forms'
import { CardGrid, CardHeader, LinkCard } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { DueBadge, ProjectStatusBadge } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { openCounts } from '@/lib/items/items'
import { listProjects, nextMilestones } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createProjectAction } from '../actions'

export default async function ProjectsPage() {
  const context = await requireContext()
  const { today } = await viewer()
  const projects = await listProjects(db, context.id)
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
    </>
  )
}
