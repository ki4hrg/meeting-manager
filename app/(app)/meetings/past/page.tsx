import Link from 'next/link'
import { DateJump } from '@/components/meetings/DateJump'
import { DayList } from '@/components/meetings/DayList'
import { ReviewSection } from '@/components/meetings/ReviewSection'
import { LogMeeting } from '@/components/processing/LogMeeting'
import { Section } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { fromLocalInput, todayIn } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { listPast } from '@/lib/meetings/prep'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'

const DAY = /^\d{4}-\d{2}-\d{2}$/
const STEP = 14

type Search = Promise<Record<string, string | string[] | undefined>>

/* Past: what was held, and the calendar events nobody prepped, two weeks at a
   time going back. `before` is the day the window ends on (exclusive). */
export default async function PastMeetingsPage({ searchParams }: { searchParams: Search }) {
  const context = await requireContext()
  const { user, today } = await viewer()
  const timeZone = user.timeZone

  const query = await searchParams
  const beforeDay = typeof query.before === 'string' && DAY.test(query.before) && query.before <= today ? query.before : null
  const before = beforeDay ? fromLocalInput(`${beforeDay}T00:00`, timeZone) : undefined

  const [{ entries, from }, pending, people, groups, projects] = await Promise.all([
    listPast(db, context.id, { before, days: STEP }),
    pendingByMeeting(db, context.id),
    listPeople(db),
    listGroups(db, context.id),
    listProjects(db, context.id),
  ])
  const earlier = todayIn(timeZone, from)

  return (
    <>
      <PageHeader
        title="Meetings"
        actions={
          <LogMeeting
            people={people.filter((person) => !person.isSelf)}
            groups={groups}
            projects={projects.filter((project) => project.status !== 'done')}
            timeZone={timeZone}
          />
        }
      />

      <Tabs
        tabs={[
          { href: '/meetings', label: 'Upcoming', active: false },
          { href: '/meetings/past', label: 'Past', active: true },
        ]}
      />

      <ReviewSection pending={pending} timeZone={timeZone} />

      <Section
        title="Past"
        count={entries.length}
        action={
          <div className="flex items-center gap-2">
            {beforeDay ? (
              <Link
                href="/meetings/past"
                aria-label="Today"
                title="Today"
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <Icon name="close" className="h-4 w-4" />
              </Link>
            ) : null}
            <DateJump href="/meetings/past" param="before" value={beforeDay ?? undefined} />
          </div>
        }
      >
        {entries.length === 0 ? (
          <EmptyState icon="meeting" />
        ) : (
          <DayList entries={entries} today={today} timeZone={timeZone} pending={pending} />
        )}
        <div className="mt-4 flex justify-center">
          <Link
            href={`/meetings/past?before=${earlier}`}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30"
          >
            <Icon name="chevronDown" className="h-4 w-4" />
            Earlier
          </Link>
        </div>
      </Section>
    </>
  )
}
