import { ItemGrid } from '@/components/items/ItemCard'
import { EventCard } from '@/components/meetings/EventCard'
import { MeetingCard } from '@/components/meetings/MeetingCard'
import { CardGrid, CollapsedSection, LinkCard, Section, Tile } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { DateJump } from '@/components/meetings/DateJump'
import { agendaCounts } from '@/lib/agenda/lines'
import { countUnfiledNotes } from '@/lib/connect/granola/unfiled'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { formatMoment } from '@/lib/core/dates'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { splitLater } from '@/lib/items/horizon'
import { listItems, openCounts } from '@/lib/items/items'
import { listUpcoming } from '@/lib/meetings/prep'
import { listProjects } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'

export default async function HomePage() {
  const context = await requireContext()
  const { user, self, today } = await viewer()

  const counts = await openCounts(db, context.id)
  const unfiled = await countUnfiledNotes(db)
  const toReview = (await pendingByMeeting(db, context.id)).size
  const projects = await listProjects(db, context.id)
  const groups = await listGroups(db, context.id)
  // Three fill the row; the rest scroll, then More opens the whole list.
  const next = (await listUpcoming(db, context.id)).entries.slice(0, 12)
  const agendas = await agendaCounts(
    db,
    next.flatMap((entry) => (entry.meeting ? [entry.meeting.id] : [])),
  )

  const owed = await listItems(db, {
    contextId: context.id,
    open: true,
    party: { personId: self.id, role: 'owner' },
  })
  // Owed by someone, and not by me: what I am waiting on.
  const awaited = (
    await listItems(db, { contextId: context.id, open: true, kinds: ['question', 'action'] })
  ).filter(
    (item) =>
      item.parties.some((party) => party.role === 'owner') &&
      !item.parties.some((party) => party.role === 'owner' && party.isSelf),
  )

  // What is due soon; everything else waits in Later, each list's apart.
  const mine = splitLater(owed, today)
  const waiting = splitLater(awaited, today)
  const later = mine.later.length + waiting.later.length

  return (
    <>
      <div className="mb-8">
        <CardGrid>
          <Tile href="/meetings" icon="meeting" title="Meetings" tone="teal" />
          <Tile href="/inbox" icon="inbox" title="Inbox" tone="blue" count={counts.inbox + unfiled + toReview} />
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
                  />
                ) : (
                  <EventCard entry={entry} time={when} />
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

      <Section title="I owe" count={mine.now.length}>
        <ItemGrid items={mine.now} today={today} empty="action" />
      </Section>

      <Section title="Waiting on" count={waiting.now.length}>
        <ItemGrid items={waiting.now} today={today} empty="clock" />
      </Section>

      {later > 0 ? (
        <CollapsedSection title="Later" icon="later" count={later}>
          <div className="flex flex-col gap-5">
            {[
              { title: 'I owe', items: mine.later },
              { title: 'Waiting on', items: waiting.later },
            ].map((part) =>
              part.items.length > 0 ? (
                <div key={part.title}>
                  <h3 className="mb-2 flex items-baseline gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-300">
                    {part.title}
                    <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">
                      {part.items.length}
                    </span>
                  </h3>
                  <ItemGrid items={part.items} today={today} empty="later" />
                </div>
              ) : null,
            )}
          </div>
        </CollapsedSection>
      ) : null}
    </>
  )
}
