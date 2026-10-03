import { ArchivedSection } from '@/components/archive/Archive'
import { FormModal } from '@/components/forms'
import { CardGrid, CardHeader, LinkCard } from '@/components/ui/Card'
import { PartyPicker } from '@/components/processing/PartyPicker'
import { CheckList } from '@/components/ui/CheckList'
import { EmptyState } from '@/components/ui/EmptyState'
import { Field, Input, Select } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/StatusBadge'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listMeetings } from '@/lib/meetings/meetings'
import { listSeries } from '@/lib/meetings/series'
import { listProjectChoices } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createSeriesAction } from './actions'

export default async function SeriesListPage() {
  const context = await requireContext()
  const { user } = await viewer()
  const series = await listSeries(db, context.id)
  const archived = await listSeries(db, context.id, 'archived')
  const people = (await listPeople(db)).filter((person) => !person.isSelf)
  const groups = await listGroups(db, context.id)
  const projects = await listProjectChoices(db, context.id)

  // Soonest first, so the first meeting seen for a series is its next.
  const next = new Map<string, Date>()
  for (const meeting of await listMeetings(db, { contextId: context.id, when: 'upcoming' })) {
    if (meeting.series && meeting.startsAt && !next.has(meeting.series.id)) {
      next.set(meeting.series.id, meeting.startsAt)
    }
  }

  return (
    <>
      <PageHeader
        title="Series"
        count={series.length}
        actions={
          <FormModal action={createSeriesAction} title="New series" label="New">
            <Field label="Name" required>
              <Input name="name" required />
            </Field>
            <PartyPicker
              label="People"
              name="personIds"
              options={people.map((person) => ({ value: person.id, name: person.name, icon: 'person' }))}
              allowNew
            />
            {groups.length > 0 ? (
              <Field label="Group">
                <Select name="groupId" defaultValue="">
                  <option value="">—</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <CheckList label="Projects" name="projectIds" options={projects} />
          </FormModal>
        }
      />

      {series.length === 0 ? (
        <EmptyState icon="refresh" />
      ) : (
        <CardGrid>
          {series.map((one) => {
            const at = next.get(one.id)
            return (
              <LinkCard key={one.id} href={`/series/${one.id}`}>
                <CardHeader
                  title={one.name}
                  aside={
                    at ? (
                      <Badge tone="teal">
                        <Icon name="meeting" className="h-3 w-3" label="Next" />
                        {formatMoment(at, user.timeZone)}
                      </Badge>
                    ) : null
                  }
                />
                <div className="flex min-w-0 items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                  {one.group ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Icon name="group" className="h-3.5 w-3.5" label="Group" />
                      {one.group.name}
                    </span>
                  ) : null}
                  {one.people.length > 0 ? (
                    <span className="flex min-w-0 items-center gap-1">
                      <Icon name="person" className="h-3.5 w-3.5 shrink-0" label="Roster" />
                      <span className="truncate">
                        {one.people.map((person) => person.name).join(', ')}
                      </span>
                    </span>
                  ) : null}
                </div>
              </LinkCard>
            )
          })}
        </CardGrid>
      )}
      <ArchivedSection
        icon="refresh"
        rows={archived.map((one) => ({ id: one.id, name: one.name, href: `/series/${one.id}` }))}
      />
    </>
  )
}
