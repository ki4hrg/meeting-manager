import { ItemGrid } from '@/components/items/ItemCard'
import { ReviewSection } from '@/components/meetings/ReviewSection'
import { UnfiledCard } from '@/components/meetings/UnfiledCard'
import { QuickAdd } from '@/components/QuickAdd'
import { CardGrid, Section } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { eventsNearNotes, listUnfiledNotes, previewFiling } from '@/lib/connect/granola/unfiled'
import { db } from '@/lib/db'
import { getMeeting, meetingsNear } from '@/lib/meetings/meetings'
import { inboxEverywhere, reviewEverywhere } from '@/lib/today'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import { openHref } from '@/lib/web/open'

/*
 * What is waiting on John, in every live context: the meetings and sessions
 * with proposals to review, the items with no party, project or target, and
 * the meetings Granola recorded that no folder filed (which belong to no
 * context). Like home, it only reads: each row is marked with its context and
 * opens there. Filing a note previews against the selected context.
 */
export default async function InboxPage() {
  const context = await requireContext()
  const { user, today } = await viewer()
  const contexts = await allContexts()
  const [items, notes, review] = await Promise.all([
    inboxEverywhere(db, contexts),
    listUnfiledNotes(db),
    reviewEverywhere(db, contexts),
  ])
  const several = contexts.length > 1
  const nameOf = new Map(contexts.map((one) => [one.id, one.name]))
  const label = (contextId: string) => (several ? nameOf.get(contextId) : undefined)
  const pending = new Map([...review].map(([id, { count }]) => [id, count]))
  const contextOf = (meetingId: string) => review.get(meetingId)!.contextId
  /* Where each note would go in the selected context, and what it could be
     linked to there instead: the meetings nearest when it was recorded, and
     the calendar events then that have no meeting yet. */
  const events = await eventsNearNotes(db, context.id, notes).catch(
    // The calendar could not be read: Link still offers the meetings.
    () => new Map<string, never[]>(),
  )
  const filing = await Promise.all(
    notes.map(async (note) => {
      const match = await previewFiling(db, note.id, context.id)
      return {
        match: match ? await getMeeting(db, match.meetingId) : null,
        choices: await meetingsNear(db, context.id, note.startsAt ?? note.receivedAt),
      }
    }),
  )

  const itemGrid = (
    <ItemGrid
      items={items}
      today={today}
      empty="inbox"
      href={(item) => openHref(`/items/${item.id}`, item.contextId, context.id)}
      context={(item) => label(item.contextId)}
    />
  )

  return (
    <>
      <PageHeader title="Inbox" count={items.length + notes.length + pending.size} actions={<QuickAdd primary />} />
      <ReviewSection
        pending={pending}
        timeZone={user.timeZone}
        href={(id) => openHref(`/meetings/${id}#review`, contextOf(id), context.id)}
        context={(id) => label(contextOf(id))}
      />
      {notes.length > 0 ? (
        <Section title="Meetings" count={notes.length}>
          <CardGrid>
            {notes.map((note, index) => (
              <UnfiledCard
                key={note.id}
                note={note}
                contexts={contexts}
                current={context.id}
                timeZone={user.timeZone}
                match={filing[index]!.match}
                choices={filing[index]!.choices}
                events={events.get(note.id) ?? []}
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}
      {notes.length > 0 || pending.size > 0 ? (
        <Section title="Items" count={items.length}>
          {itemGrid}
        </Section>
      ) : (
        itemGrid
      )}
    </>
  )
}
