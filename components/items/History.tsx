import Link from 'next/link'
import { addNoteAction } from '@/app/(app)/actions'
import { FormModal } from '@/components/forms'
import { Card, Section } from '@/components/ui/Card'
import { Field, Textarea } from '@/components/ui/Field'
import { Icon, type IconName } from '@/components/ui/icons'
import { KindIcon, SOURCE, SourceMark, type EventSource, type ItemKind } from '@/components/ui/StatusBadge'
import type { ItemComment } from '@/lib/connect/todoist/comments'
import { formatDay, formatMoment } from '@/lib/core/dates'
import type { ItemEvent } from '@/lib/items/items'
import { COLLABORATOR, hasCollaborators, roleLabel } from '@/lib/items/roles'
import type { AcceptedFrom } from '@/lib/processing/proposals'

const EVENT: Record<ItemEvent['type'], { icon: IconName; label: string }> = {
  created: { icon: 'plus', label: 'Created' },
  edited: { icon: 'pencil', label: 'Edited' },
  parties: { icon: 'group', label: 'People' },
  role: { icon: 'refresh', label: 'Role' },
  note: { icon: 'topic', label: 'Note' },
  converted: { icon: 'refresh', label: 'Converted' },
  answered: { icon: 'check', label: 'Answered' },
  completed: { icon: 'check', label: 'Done' },
  dropped: { icon: 'close', label: 'Dropped' },
  reopened: { icon: 'refresh', label: 'Reopened' },
  spawned: { icon: 'arrowRight', label: 'Follow-up' },
  superseded: { icon: 'refresh', label: 'Superseded' },
  targeted: { icon: 'meeting', label: 'Agenda' },
  discussed: { icon: 'meeting', label: 'Discussed' },
  parked: { icon: 'later', label: 'Later' },
  unparked: { icon: 'undo', label: 'Back' },
  needs_answer: { icon: 'question', label: 'Needs answer' },
  ongoing: { icon: 'refresh', label: 'Ongoing' },
  linked: { icon: 'link', label: 'Linked' },
  unlinked: { icon: 'close', label: 'Unlinked' },
}

function eventDetail(event: ItemEvent, kind: ItemKind): React.ReactNode {
  const data = event.data as Record<string, string | string[] | undefined>
  switch (event.type) {
    case 'note':
      return data.text
    case 'ongoing':
      return (event.data as { ongoing?: boolean }).ongoing === false ? 'Off' : null
    case 'spawned':
    case 'linked':
    case 'unlinked':
      return data.text
    case 'parked':
      return typeof data.until === 'string' ? formatDay(data.until, data.until) : null
    case 'unparked':
      // Brought back by the item it waited on closing.
      return data.text
    case 'completed':
    case 'answered':
    case 'dropped': {
      const said = event.type === 'completed' ? data.resolution : event.type === 'answered' ? data.answer : null
      const released = (event.data.released as { text: string }[] | undefined)?.map((one) => one.text) ?? []
      if (released.length === 0) return said
      return (
        <>
          {said}
          <span className="mt-1 flex items-start gap-1">
            <Icon name="link" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" label="Released" />
            {released.join(', ')}
          </span>
        </>
      )
    }
    case 'converted':
      return (
        <span className="inline-flex items-center gap-1 align-middle">
          <KindIcon kind={data.from as ItemKind} className="h-4 w-4" />
          <Icon name="arrowRight" className="h-3 w-3" />
          <KindIcon kind={data.to as ItemKind} className="h-4 w-4" />
        </span>
      )
    case 'edited':
      return ((data.fields as string[]) ?? [])
        .map((name) => ({ projectId: 'project', dueOn: 'due' })[name] ?? name)
        .join(', ')
    case 'parties':
      return [...((data.owners as string[]) ?? []), ...((data.with as string[]) ?? [])].join(', ')
    case 'role': {
      const role = event.data as {
        name: string
        role: 'owner' | 'with'
        collaborator?: boolean
      }
      return (
        <span className="inline-flex items-center gap-1 align-middle">
          {role.name}
          <Icon name="arrowRight" className="h-3 w-3" />
          {role.collaborator && hasCollaborators(kind) ? COLLABORATOR : roleLabel(kind, role.role)}
        </span>
      )
    }
    default:
      return null
  }
}

/* One line of history: an item's own step, or a comment on its Todoist task. */
type Line = {
  key: string
  at: Date
  icon: IconName
  label: string
  source: string
  detail: React.ReactNode
  from: AcceptedFrom | null
}

function lineOf(event: ItemEvent, kind: ItemKind, accepted: Accepted): Line {
  return {
    key: event.id,
    at: event.createdAt,
    icon: EVENT[event.type]?.icon ?? 'clock',
    label: EVENT[event.type]?.label ?? event.type,
    source: event.source,
    detail: eventDetail(event, kind),
    from: (event.type === 'created' ? accepted.created : accepted.events.get(event.id)) ?? null,
  }
}

type Accepted = { created: AcceptedFrom | null; events: Map<string, AcceptedFrom> }

/* Where a line came from: its source, and the review it was accepted from. */
function Origin({ line }: { line: Line }) {
  if (!SOURCE[line.source as EventSource] && !line.from) return null
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <SourceMark source={line.source} />
      {line.from ? (
        <Link
          href={`/meetings/${line.from.meetingId}#review`}
          title={line.from.title}
          aria-label={line.from.title}
          className="inline-flex text-gray-400 hover:text-blue-600 dark:text-gray-500 dark:hover:text-blue-400"
        >
          <Icon name="log" className="h-3.5 w-3.5" />
        </Link>
      ) : null}
    </span>
  )
}

function When({ at, timeZone }: { at: Date; timeZone: string | null }) {
  return (
    <time dateTime={at.toISOString()} className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
      {formatMoment(at, timeZone)}
    </time>
  )
}

/**
 * What has been learned or said about an item, in its own words: its notes
 * and the comments on its Todoist task, interleaved by time.
 */
export function Notes({
  item,
  events,
  comments,
  accepted,
  timeZone,
}: {
  item: { id: string; kind: ItemKind }
  events: ItemEvent[]
  comments: ItemComment[]
  accepted: Accepted
  timeZone: string | null
}) {
  const lines: Line[] = [
    ...events.filter((event) => event.type === 'note').map((event) => lineOf(event, item.kind, accepted)),
    ...comments.map((comment) => ({
      key: `comment-${comment.id}`,
      at: comment.postedAt,
      icon: 'topic' as const,
      label: 'Comment',
      source: 'todoist',
      detail: comment.content,
      from: null,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime())

  return (
    <Section
      title="Notes"
      count={lines.length}
      action={
        <FormModal action={addNoteAction} title="Note" label="Add" icon="plus" variant="secondary" size="sm">
          <input type="hidden" name="id" value={item.id} />
          <Field label="Note" required>
            <Textarea name="text" rows={4} required />
          </Field>
        </FormModal>
      }
    >
      <Card>
        <ul className="flex flex-col gap-4">
          {lines.map((line) => (
            <li key={line.key} className="flex flex-col gap-1 text-sm">
              <div className="whitespace-pre-wrap text-gray-900 dark:text-gray-100">{line.detail}</div>
              <div className="flex items-center gap-1.5">
                <When at={line.at} timeZone={timeZone} />
                <Origin line={line} />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  )
}

/**
 * An item's history: every step taken on it but its notes. Each line marks
 * where it came from; a step accepted from a meeting's notes links to that
 * meeting's review.
 */
export function History({
  item,
  events,
  accepted,
  timeZone,
}: {
  item: { id: string; kind: ItemKind }
  events: ItemEvent[]
  accepted: Accepted
  timeZone: string | null
}) {
  const lines = events
    .filter((event) => event.type !== 'note')
    .map((event) => lineOf(event, item.kind, accepted))
    .sort((a, b) => a.at.getTime() - b.at.getTime())

  return (
    <Section title="History">
      <Card>
        <ul className="flex flex-col gap-3">
          {lines.map((line) => (
            <li key={line.key} className="flex items-start gap-3 text-sm">
              <Icon name={line.icon} className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500" />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-gray-900 dark:text-gray-100">{line.label}</span>
                <span className="ml-1.5">
                  <Origin line={line} />
                </span>
                {line.detail ? (
                  <span className="ml-2 whitespace-pre-wrap text-gray-600 dark:text-gray-300">{line.detail}</span>
                ) : null}
              </div>
              <When at={line.at} timeZone={timeZone} />
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  )
}
