import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CopyButton } from '@/components/CopyButton'
import { LivesIn } from '@/components/meetings/Move'
import { MailButton } from '@/components/processing/MailButton'
import { PendingBadge } from '@/components/processing/PendingBadge'
import { ButtonLink } from '@/components/ui/Button'
import { Card, CardGrid, CardHeader, Section } from '@/components/ui/Card'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import {
  getRecap,
  recapMailto,
  renderPersonSnippet,
  renderRecap,
  renderRecapHtml,
  type RecapParty,
} from '@/lib/agenda/recap'
import { isUuid } from '@/lib/core/match'
import { NotFoundError } from '@/lib/core/types'
import { db } from '@/lib/db'
import { getMeeting } from '@/lib/meetings/meetings'
import { pendingByMeeting } from '@/lib/processing/proposals'
import { allContexts, requireContext, viewer } from '@/lib/web/context'
import { openMeetingAction } from '../../actions'

/* The recap as it will paste, drawn with the page's own type: the renderer
   escapes every piece of text it is given, and emits only headings,
   paragraphs and lists. */
const RENDERED =
  'text-sm text-gray-700 dark:text-gray-300 ' +
  '[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-gray-900 dark:[&_h1]:text-gray-100 ' +
  '[&_h2]:mt-5 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-gray-900 dark:[&_h2]:text-gray-100 ' +
  '[&_p]:mt-2 [&_ul]:mt-1 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:mt-0.5 ' +
  '[&_strong]:font-semibold [&_strong]:text-gray-900 dark:[&_strong]:text-gray-100'

/* A snippet is Markdown for pasting; on the card its labels are bold and its
   items a list, so it reads as it will once pasted. */
function Snippet({ text }: { text: string }) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return (
    <div className="flex flex-col gap-1 break-words text-sm text-gray-700 dark:text-gray-300">
      {lines.map((line, index) => {
        const label = /^\*\*(.+)\*\*$/.exec(line)
        if (label) {
          return (
            <p key={index} className="mt-1 font-semibold text-gray-900 dark:text-gray-100">
              {label[1]}
            </p>
          )
        }
        if (line.startsWith('- ')) {
          return (
            <p key={index} className="flex gap-2">
              <span aria-hidden className="text-gray-400 dark:text-gray-500">
                •
              </span>
              {line.slice(2)}
            </p>
          )
        }
        return (
          <p key={index} className="text-xs text-gray-500 dark:text-gray-400">
            {line}
          </p>
        )
      })}
    </div>
  )
}

export default async function RecapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const context = await requireContext()
  const { user, self, today } = await viewer()

  const meeting = await getMeeting(db, id).catch((err) => {
    if (err instanceof NotFoundError) notFound()
    throw err
  })
  if (meeting.contextId !== context.id) {
    const home = (await allContexts()).find((one) => one.id === meeting.contextId)
    if (!home) notFound()
    return <LivesIn title={meeting.title} context={home} action={openMeetingAction} id={meeting.id} />
  }

  const [recap, pending] = await Promise.all([
    getRecap(db, id, { today, timeZone: user.timeZone, selfId: self.id }),
    pendingByMeeting(db, context.id),
  ])
  const text = renderRecap(recap)
  const html = renderRecapHtml(recap)

  /* Everyone the recap names who is not John: who was there, then anyone else
     who owes something. Only those with something to be told get a snippet. */
  const parties = new Map<string, Pick<RecapParty, 'type' | 'id' | 'name'>>()
  for (const person of recap.meeting.people) {
    parties.set(`person:${person.id}`, { type: 'person', ...person })
  }
  for (const { party, items } of recap.owed) {
    for (const one of [party, ...items.flatMap((item) => item.with)]) {
      if (one && !one.isSelf) parties.set(`${one.type}:${one.id}`, one)
    }
  }
  const snippets = [...parties.values()]
    .map((party) => ({ party, text: renderPersonSnippet(recap, party) }))
    .filter((snippet) => snippet.text !== '')

  return (
    <>
      <Link
        href={`/meetings/${meeting.id}`}
        className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        <Icon name="chevronDown" className="h-4 w-4 rotate-90" />
        {meeting.title}
      </Link>

      <PageHeader
        title="Recap"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton label="Copy" variant="primary" text={text} html={html} />
            <MailButton href={recapMailto(recap)} text={text} html={html} />
            <ButtonLink href={`/meetings/${meeting.id}/review`} variant="secondary">
              Review
              <PendingBadge count={pending.get(meeting.id)} />
            </ButtonLink>
          </div>
        }
      />

      <Card padding="md" className="mb-8">
        <div className={RENDERED} dangerouslySetInnerHTML={{ __html: html }} />
      </Card>

      {snippets.length > 0 ? (
        <Section title="By person" count={snippets.length}>
          <CardGrid>
            {snippets.map(({ party, text: snippet }) => (
              <Card key={`${party.type}:${party.id}`}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-1.5">
                      <Icon name={party.type} className="h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
                      <span className="truncate">{party.name}</span>
                    </span>
                  }
                  aside={<CopyButton label="Copy" size="sm" text={snippet} />}
                />
                <Snippet text={snippet} />
              </Card>
            ))}
          </CardGrid>
        </Section>
      ) : null}
    </>
  )
}
