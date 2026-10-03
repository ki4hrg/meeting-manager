import { ItemGrid } from '@/components/items/ItemCard'
import { ReviewSection } from '@/components/meetings/ReviewSection'
import { UnfiledCard } from '@/components/meetings/UnfiledCard'
import { QuickAdd } from '@/components/QuickAdd'
import { CardGrid, Section } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { listUnfiledNotes, previewFiling } from '@/lib/connect/granola/unfiled'
import { db } from '@/lib/db'
import { listItems } from '@/lib/items/items'
import { getMeeting, meetingsNear } from '@/lib/meetings/meetings'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { allContexts, requireContext, viewer } from '@/lib/web/context'

/*
 * What is waiting on John: the meetings and sessions with proposals to review,
 * this context's items with no party, project or target, and the meetings
 * Granola recorded that no folder filed. Those belong to no context, so they
 * are here whichever one is selected.
 */
export default async function InboxPage() {
  const context = await requireContext()
  const { user, today } = await viewer()
  const [items, notes, contexts, pending] = await Promise.all([
    listItems(db, { contextId: context.id, inbox: true }),
    listUnfiledNotes(db),
    allContexts(),
    pendingByMeeting(db, context.id),
  ])
  /* Where each note would go in the selected context, and what it could be
     linked to there instead: the meetings nearest when it was recorded. */
  const filing = await Promise.all(
    notes.map(async (note) => {
      const match = await previewFiling(db, note.id, context.id)
      return {
        match: match ? await getMeeting(db, match.meetingId) : null,
        choices: await meetingsNear(db, context.id, note.startsAt ?? note.receivedAt),
      }
    }),
  )

  return (
    <>
      <PageHeader title="Inbox" count={items.length + notes.length + pending.size} actions={<QuickAdd />} />
      <ReviewSection pending={pending} timeZone={user.timeZone} />
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
              />
            ))}
          </CardGrid>
        </Section>
      ) : null}
      {notes.length > 0 || pending.size > 0 ? (
        <Section title="Items" count={items.length}>
          <ItemGrid items={items} today={today} empty="inbox" />
        </Section>
      ) : (
        <ItemGrid items={items} today={today} empty="inbox" />
      )}
    </>
  )
}
