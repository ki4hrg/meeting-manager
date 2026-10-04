import { ItemGrid } from '@/components/items/ItemCard'
import { DateJump } from '@/components/meetings/DateJump'
import { EventCard } from '@/components/meetings/EventCard'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { CardGrid, CollapsedSection, LinkCard, Section, Tile } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { Badge } from '@/components/ui/StatusBadge'
import { agendaCounts } from '@/lib/agenda/lines'
import { countUnfiledNotes } from '@/lib/connect/granola/unfiled'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import type { ItemView } from '@/lib/items/items'
import { openCounts } from '@/lib/items/items'
import { getMeeting } from '@/lib/meetings/meetings'
import { listProjects } from '@/lib/projects/projects'
import { owedEverywhere, reviewEverywhere, upcomingEverywhere } from '@/lib/today'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import { openHref } from '@/lib/web/open'

/* Home is Today: what needs attention in every context, each row marked with
   its context and opened there. The tiles and quick-add stay with the
   selected context. */
export default async function HomePage() {
  const context = await requireContext()
  const { user, self, today } = await viewer()
  const contexts = await allContexts()
  const several = contexts.length > 1
  const nameOf = new Map(contexts.map((one) => [one.id, one.name]))
  const label = (contextId: string) => (several ? nameOf.get(contextId) : undefined)
  const open = (path: string, contextId: string) => openHref(path, contextId, context.id)

  const counts = await openCounts(db, context.id)
  const unfiled = await countUnfiledNotes(db)
  const projects = await listProjects(db, context.id)
  const groups = await listGroups(db, context.id)

  const pending = await reviewEverywhere(db, contexts)
  const toReview = await Promise.all(
    [...pending].map(async ([id, { contextId, count }]) => {
      const meeting = await getMeeting(db, id)
      // A session reads as its meeting's: "Annual Conference · Day one".
      const title = meeting.parentMeetingId
        ? `${(await getMeeting(db, meeting.parentMeetingId)).title} · ${meeting.title}`
        : meeting.title
      return { meeting: { ...meeting, title }, contextId, count }
    }),
  )
  toReview.sort((a, b) => (b.meeting.startsAt?.getTime() ?? 0) - (a.meeting.startsAt?.getTime() ?? 0))
  const inSelected = toReview.filter((one) => one.contextId === context.id).length

  // Three fill the row; the rest scroll, then More opens the whole list.
  const next = await upcomingEverywhere(db, contexts, { limit: 12 })
  const agendas = await agendaCounts(
    db,
    next.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])),
  )

  const owed = await owedEverywhere(db, contexts, self.id, today)
  const later = owed.later.mine.length + owed.later.waiting.length

  const items = (list: ItemView[], empty: Parameters<typeof ItemGrid>[0]['empty']) => (
    <ItemGrid
      items={list}
      today={today}
      empty={empty}
      href={(item) => open(`/items/${item.id}`, item.contextId)}
      context={(item) => label(item.contextId)}
    />
  )

  return (
    <>
      <div className="mb-8">
        <CardGrid>
          <Tile href="/meetings" icon="meeting" title="Meetings" tone="teal" />
          <Tile href="/inbox" icon="inbox" title="Inbox" tone="blue" count={counts.inbox + unfiled + inSelected} />
          <Tile
            href="/projects"
            icon="project"
            title="Projects"
            tone="purple"
            count={projects.filter((project) => project.status === 'active').length}
          />
          <Tile href="/people" icon="person" title="People" tone="green" />
          <Tile href="/groups" icon="group" title="Groups" tone="amber" count={groups.length} />
        </CardGrid>
      </div>

      {toReview.length > 0 || unfiled > 0 ? (
        <Section title="Review" count={toReview.length + unfiled}>
          <CardGrid>
            {toReview.map(({ meeting, contextId, count }) => (
              <MeetingCard
                key={meeting.id}
                meeting={meeting}
                when={meeting.startsAt ? formatMoment(meeting.startsAt, user.timeZone) : null}
                pending={count}
                href={open(`/meetings/${meeting.id}/review`, contextId)}
                context={label(contextId)}
              />
            ))}
            {unfiled > 0 ? (
              <LinkCard href="/inbox">
                <div className="flex items-center gap-3">
                  <Icon name="document" className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Notes to file
                  </span>
                  <Badge tone="amber">
                    <span className="tabular-nums">{unfiled}</span>
                  </Badge>
                </div>
              </LinkCard>
            ) : null}
          </CardGrid>
        </Section>
      ) : null}

      <Section title="Next up" action={<DateJump href="/meetings" param="from" />}>
        <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:scroll-px-0 sm:px-0">
          {next.map((entry) => {
            const when = formatMoment(entry.startsAt, user.timeZone)
            return (
              <div
                key={entry.meeting?.id ?? entry.event!.eventId}
                className="w-[85%] shrink-0 snap-start sm:w-[calc(50%-0.5rem)] lg:w-[calc((100%-2rem)/3)]"
              >
                {entry.meeting ? (
                  <MeetingCard
                    meeting={{ ...entry.meeting, series: entry.series }}
                    when={when}
                    agenda={agendas.get(entry.meeting.id) ?? 0}
                    href={open(`/meetings/${entry.meeting.id}`, entry.contextId)}
                    context={label(entry.contextId)}
                  />
                ) : (
                  <EventCard
                    entry={entry}
                    time={when}
                    context={several ? { id: entry.contextId, name: nameOf.get(entry.contextId) ?? '' } : undefined}
                  />
                )}
              </div>
            )
          })}
          <LinkCard
            href="/meetings"
            className="flex w-32 shrink-0 snap-start flex-col items-center justify-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400"
          >
            <Icon name="arrowRight" className="h-5 w-5" />
            More
          </LinkCard>
        </div>
      </Section>

      {owed.due.length > 0 ? (
        <Section title="Due" count={owed.due.length}>
          {items(owed.due, 'flag')}
        </Section>
      ) : null}

      <Section title="I owe" count={owed.mine.length}>
        {items(owed.mine, 'action')}
      </Section>

      <Section title="Waiting on" count={owed.waiting.length}>
        {items(owed.waiting, 'clock')}
      </Section>

      {later > 0 ? (
        <CollapsedSection title="Later" icon="later" count={later}>
          <div className="flex flex-col gap-5">
            {[
              { title: 'I owe', list: owed.later.mine },
              { title: 'Waiting on', list: owed.later.waiting },
            ].map((part) =>
              part.list.length > 0 ? (
                <div key={part.title}>
                  <h3 className="mb-2 flex items-baseline gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                    {part.title}
                    <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">
                      {part.list.length}
                    </span>
                  </h3>
                  {items(part.list, 'later')}
                </div>
              ) : null,
            )}
          </div>
        </CollapsedSection>
      ) : null}
    </>
  )
}
