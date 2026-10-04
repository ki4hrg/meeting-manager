import Link from 'next/link'
import { iconButtonClasses } from '@/components/ui/IconButton'
import { ButtonLink } from '@/components/ui/Button'
import { FormModal } from '@/components/forms'
import { DateJump } from '@/components/meetings/DateJump'
import { DayList } from '@/components/meetings/DayList'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { MeetingFields } from '@/components/meetings/MeetingFields'
import { ReviewSection } from '@/components/meetings/ReviewSection'
import { LogMeeting } from '@/components/processing/LogMeeting'
import { CardGrid, Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { agendaCounts } from '@/lib/agenda/lines'
import { formatMoment, fromLocalInput } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listMeetings } from '@/lib/meetings/meetings'
import { listUpcoming } from '@/lib/meetings/prep'
import { listSeries } from '@/lib/meetings/series'
import { pendingByMeeting, pendingOnCards } from '@/lib/processing/proposals'
import { listProjectChoices } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'
import { createMeetingAction } from './actions'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const STEP = 14
const FARTHEST = 180

type Search = Promise<Record<string, string | string[] | undefined>>

/* Upcoming: the calendar and the meetings made by hand, a window at a time.
   `from` jumps the window to a day; "More" reaches it further. */
export default async function MeetingsPage({ searchParams }: { searchParams: Search }) {
  const context = await requireContext()
  const { user, today } = await viewer()
  const timeZone = user.timeZone

  const query = await searchParams
  const fromDay = typeof query.from === 'string' && DAY.test(query.from) && query.from > today ? query.from : null
  const asked = Number(query.days)
  const days = Number.isInteger(asked) && asked > 0 ? Math.min(asked, FARTHEST) : STEP
  const from = fromDay ? fromLocalInput(`${fromDay}T00:00`, timeZone) : undefined

  const [{ entries, stubs }, ahead, people, groups, projects, series, pending, onCards] = await Promise.all([
    listUpcoming(db, context.id, { from, days }),
    listMeetings(db, { contextId: context.id, when: 'upcoming', topLevelOnly: true }),
    listPeople(db),
    listGroups(db, context.id),
    listProjectChoices(db, context.id),
    listSeries(db, context.id),
    pendingByMeeting(db, context.id),
    pendingOnCards(db, context.id),
  ])
  const agendas = await agendaCounts(
    db,
    entries.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])),
  )
  const others = people.filter((person) => !person.isSelf)
  const live = projects.filter((project) => project.status !== 'done')

  // Made by hand for a date beyond the window.
  const listed = new Set(entries.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])))
  const windowEnd = (from ?? new Date()).getTime() + days * 86_400_000
  const later = ahead.filter(
    (meeting) => !listed.has(meeting.id) && meeting.startsAt && meeting.startsAt.getTime() >= windowEnd,
  )
  const more = new URLSearchParams({ ...(fromDay ? { from: fromDay } : {}), days: String(days + STEP) })

  return (
    <>
      <PageHeader
        title="Meetings"
        actions={
          <>
            <LogMeeting people={others} groups={groups} projects={live} timeZone={timeZone} />
            <FormModal action={createMeetingAction} title="New meeting" label="New meeting" icon="plus" submit="Create">
              <MeetingFields
                choices={{ people: others, groups, projects: live, series }}
                timeZone={timeZone}
                offerEvents
              />
            </FormModal>
          </>
        }
      />

      <Tabs
        tabs={[
          { href: '/meetings', label: 'Upcoming', active: true },
          { href: '/meetings/past', label: 'Past', active: false },
        ]}
      />

      <ReviewSection pending={pending} timeZone={timeZone} />

      <Section
        title="Upcoming"
        count={entries.length}
        action={
          <div className="flex items-center gap-2">
            {fromDay ? (
              <Link
                href="/meetings"
                aria-label="Today"
                title="Today"
                className={iconButtonClasses()}
              >
                <Icon name="close" className="h-4 w-4" />
              </Link>
            ) : null}
            <DateJump href="/meetings" param="from" value={fromDay ?? undefined} />
          </div>
        }
      >
        {entries.length === 0 ? (
          <EmptyState icon="meeting" />
        ) : (
          <DayList entries={entries} today={today} timeZone={timeZone} pending={onCards} agendas={agendas} />
        )}
        {days < FARTHEST ? (
          <div className="mt-4 flex justify-center">
            <ButtonLink
              href={`/meetings?${more}`}
              scroll={false}
              variant="ghost"
            >
              <Icon name="chevronDown" className="h-4 w-4" />
              More
            </ButtonLink>
          </div>
        ) : null}
      </Section>

      {later.length > 0 ? (
        <Section title="Later" count={later.length}>
          <CardGrid>
            {later.map((meeting) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                when={formatMoment(meeting.startsAt!, timeZone)}
                pending={onCards.get(meeting.id)}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}

      {stubs.length > 0 ? (
        <Section title="Undated" count={stubs.length}>
          <CardGrid>
            {stubs.map((stub) => (
              <MeetingCard key={stub.id} meeting={stub} when={null} pending={onCards.get(stub.id)} />
            ))}
          </CardGrid>
        </Section>
      ) : null}
    </>
  )
}
