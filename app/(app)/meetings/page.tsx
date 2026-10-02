import { FormModal } from '@/components/forms'
import { EventCard } from '@/components/meetings/EventCard'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { MeetingFields } from '@/components/meetings/MeetingFields'
import { LogMeeting } from '@/components/processing/LogMeeting'
import { CardGrid, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { formatMoment, formatTime, formatWeekday, todayIn } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { getMeeting, listMeetings } from '@/lib/meetings/meetings'
import { listUpcoming, type UpcomingEntry } from '@/lib/meetings/prep'
import { listSeries } from '@/lib/meetings/series'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createMeetingAction } from './actions'

export default async function MeetingsPage() {
  const context = await requireContext()
  const { user, today } = await viewer()
  const timeZone = user.timeZone

  const [{ entries, stubs }, ahead, past, people, groups, projects, series, pending] = await Promise.all([
    listUpcoming(db, context.id),
    listMeetings(db, { contextId: context.id, when: 'upcoming', topLevelOnly: true }),
    listMeetings(db, { contextId: context.id, when: 'past', topLevelOnly: true, limit: 20 }),
    listPeople(db),
    listGroups(db, context.id),
    listProjects(db, context.id),
    listSeries(db, context.id),
    pendingByMeeting(db, context.id),
  ])
  /* Whatever has proposals waiting, sessions and long-past meetings included:
     read one by one, because no list below is sure to hold them. */
  const toReview = (await Promise.all([...pending.keys()].map((id) => getMeeting(db, id)))).sort(
    (a, b) => (b.startsAt?.getTime() ?? 0) - (a.startsAt?.getTime() ?? 0),
  )
  const others = people.filter((person) => !person.isSelf)
  const live = projects.filter((project) => project.status !== 'done')

  // Upcoming by day, in the user's zone.
  const days = new Map<string, UpcomingEntry[]>()
  for (const entry of entries) {
    const day = todayIn(timeZone, entry.startsAt)
    days.set(day, [...(days.get(day) ?? []), entry])
  }
  // Made by hand for a date beyond the calendar window.
  const listed = new Set(entries.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])))
  const later = ahead.filter((meeting) => !listed.has(meeting.id))

  return (
    <>
      <PageHeader
        title="Meetings"
        actions={
          <>
            <LogMeeting people={others} groups={groups} projects={live} timeZone={timeZone} />
            <FormModal action={createMeetingAction} title="New meeting" label="New" submit="Create">
              <MeetingFields
                choices={{ people: others, groups, projects: live, series }}
                timeZone={timeZone}
              />
            </FormModal>
          </>
        }
      />

      {toReview.length > 0 ? (
        <Section title="Review" count={toReview.length}>
          <CardGrid>
            {toReview.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                when={meeting.startsAt ? formatMoment(meeting.startsAt, timeZone) : null}
                pending={pending.get(meeting.id)}
                to="review"
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}

      <Section title="Upcoming" count={entries.length}>
        {entries.length === 0 ? (
          <EmptyState icon="meeting" />
        ) : (
          <div className="flex flex-col gap-5">
            {[...days].map(([day, dayEntries]) => (
              <div key={day}>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
                  {formatWeekday(day, today)}
                  {day === today ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-600 dark:bg-blue-400" aria-label="Today" />
                  ) : null}
                </h3>
                <CardGrid>
                  {dayEntries.map((entry) => {
                    const time = formatTime(entry.startsAt, timeZone)
                    return entry.meeting ? (
                      <MeetingCard
                        key={entry.meeting.id}
                        meeting={{ ...entry.meeting, series: entry.series }}
                        when={time}
                        pending={pending.get(entry.meeting.id)}
                      />
                    ) : (
                      <EventCard key={entry.event!.eventId} entry={entry} time={time} />
                    )
                  })}
                </CardGrid>
              </div>
            ))}
          </div>
        )}
      </Section>

      {later.length > 0 ? (
        <Section title="Later" count={later.length}>
          <CardGrid>
            {later.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                when={formatMoment(meeting.startsAt!, timeZone)}
                pending={pending.get(meeting.id)}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}

      {stubs.length > 0 ? (
        <Section title="Undated" count={stubs.length}>
          <CardGrid>
            {stubs.map((stub) => (
              <MeetingCard key={stub.id} meeting={stub} when={null} pending={pending.get(stub.id)} />
            ))}
          </CardGrid>
        </Section>
      ) : null}

      {past.length > 0 ? (
        <Section title="Past" count={past.length}>
          <CardGrid>
            {past.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                when={formatMoment(meeting.startsAt!, timeZone)}
                pending={pending.get(meeting.id)}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}
    </>
  )
}
