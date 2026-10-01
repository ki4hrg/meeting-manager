import Link from 'next/link'
import {
  markDiscussedAction,
  nudgeLineAction,
  removeLineAction,
  updateLineAction,
} from '@/app/(app)/meetings/actions'
import { FormModal, IconAction } from '@/components/forms'
import { PartyLine } from '@/components/items/ItemCard'
import { Card } from '@/components/ui/Card'
import { Field, Input, Textarea } from '@/components/ui/Field'
import { Icon } from '@/components/ui/icons'
import { Badge, DueBadge, KindIcon, StatusBadge } from '@/components/ui/StatusBadge'
import type { Agenda, AgendaLine, AgendaSection } from '@/lib/agenda/lines'
import { formatClock, formatDay } from '@/lib/core/dates'
import { isOpen } from '@/lib/items/items'
import { AddLine } from './AddLine'

/* The left gutter: when the row starts. A pinned start is a pill; one that
   what comes before it runs past is the danger tone. */
function Start({ row }: { row: { start: string | null; pinnedStart: string | null; overrunMinutes?: number } }) {
  if (!row.start) return <span className="w-[4.5rem] shrink-0" />
  const time = formatClock(row.start)
  return (
    <span className="w-[4.5rem] shrink-0 pt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">
      {row.overrunMinutes ? (
        <span title={`+${row.overrunMinutes} min`}>
          <Badge tone="red">{time}</Badge>
        </span>
      ) : row.pinnedStart ? (
        <Badge tone="blue">{time}</Badge>
      ) : (
        time
      )}
    </span>
  )
}

function Minutes({ minutes }: { minutes: number | null }) {
  if (!minutes) return null
  return (
    <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">{minutes} min</span>
  )
}

function Moves({ id, name, up, down }: { id: string; name: string; up: boolean; down: boolean }) {
  return (
    <>
      <IconAction
        action={nudgeLineAction}
        fields={{ id, direction: 'up' }}
        icon="chevronUp"
        label={`Move ${name} up`}
        disabled={!up}
      />
      <IconAction
        action={nudgeLineAction}
        fields={{ id, direction: 'down' }}
        icon="chevronDown"
        label={`Move ${name} down`}
        disabled={!down}
      />
    </>
  )
}

/* The fields shared by a line's form and a section's: a pinned start and minutes. */
function TimingFields({ row, minutes }: { row: { pinnedStart: string | null; minutes: number | null }; minutes: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Starts at">
        <Input name="pinnedStart" type="time" defaultValue={row.pinnedStart ?? ''} />
      </Field>
      {minutes ? (
        <Field label="Minutes">
          <Input name="minutes" type="number" min={0} inputMode="numeric" defaultValue={row.minutes ?? ''} />
        </Field>
      ) : null}
    </div>
  )
}

function LineRow({
  line,
  meetingId,
  timed,
  today,
  up,
  down,
}: {
  line: AgendaLine
  meetingId: string
  timed: boolean
  today: string
  up: boolean
  down: boolean
}) {
  const item = line.item
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2">
      {timed ? <Start row={line} /> : null}
      {item ? (
        <KindIcon kind={item.kind} className="mt-0.5 h-4 w-4" />
      ) : (
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
        </span>
      )}

      <div className="min-w-0 flex-1 basis-40">
        {item ? (
          <Link
            href={`/items/${item.id}`}
            className={`text-sm font-medium hover:underline ${
              isOpen(item)
                ? 'text-gray-900 dark:text-gray-100'
                : 'text-gray-500 line-through dark:text-gray-400'
            }`}
          >
            {line.text}
          </Link>
        ) : (
          <p className="text-sm text-gray-900 dark:text-gray-100">{line.text}</p>
        )}

        {item && (item.parties.length > 0 || item.dueOn || item.project || !isOpen(item)) ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <PartyLine parties={item.parties} />
            {item.project ? <Badge>{item.project.name}</Badge> : null}
            {item.dueOn ? (
              <DueBadge
                label={formatDay(item.dueOn, today)}
                dueOn={item.dueOn}
                today={today}
                open={isOpen(item)}
              />
            ) : null}
            {isOpen(item) ? null : <StatusBadge status={item.status} />}
          </div>
        ) : null}

        {line.privateNote ? (
          <p className="mt-1 flex items-start gap-1.5 whitespace-pre-wrap text-xs italic text-gray-500 dark:text-gray-400">
            <Icon name="lock" className="mt-0.5 h-3 w-3 shrink-0" label="Private note" />
            {line.privateNote}
          </p>
        ) : null}
      </div>

      {/* Minutes and actions wrap together, so on a phone they share the row under the text. */}
      <div className="ml-auto flex shrink-0 items-center">
        <span className="mr-3">
          <Minutes minutes={line.minutes} />
        </span>
        {item && isOpen(item) && item.kind !== 'decision' ? (
          <IconAction
            action={markDiscussedAction}
            fields={{ itemId: item.id, meetingId }}
            icon="check"
            label={line.discussed ? 'Discussed' : 'Mark discussed'}
            tone={line.discussed ? 'on' : 'gray'}
            aria-pressed={Boolean(line.discussed)}
            disabled={line.discussed}
            className="disabled:!opacity-100"
          />
        ) : (
          // Keeps the minutes and the other actions in one column down the card.
          <span className="w-7 shrink-0" />
        )}
        <Moves id={line.id} name={line.text} up={up} down={down} />
        <FormModal action={updateLineAction} title="Edit line" icon="pencil" compact>
          <input type="hidden" name="id" value={line.id} />
          <Field label="Text" required={!item}>
            <Input name="text" defaultValue={line.text} required={!item} />
          </Field>
          <Field label="Private note">
            <Textarea name="privateNote" rows={3} defaultValue={line.privateNote ?? ''} />
          </Field>
          <TimingFields row={line} minutes />
        </FormModal>
        <IconAction
          action={removeLineAction}
          fields={{ id: line.id }}
          icon="close"
          label={`Remove ${line.text}`}
        />
      </div>
    </li>
  )
}

function SectionBlock({
  section,
  meetingId,
  timed,
  today,
  up,
  down,
}: {
  section: AgendaSection
  meetingId: string
  timed: boolean
  today: string
  up: boolean
  down: boolean
}) {
  // A section's own minutes count only while its lines carry none.
  const ownMinutes = section.lines.every((line) => !line.minutes)
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {timed ? <Start row={section} /> : null}
        <h3 className="min-w-0 flex-1 basis-40 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {section.title}
        </h3>
        <div className="ml-auto flex shrink-0 items-center">
          <span className="mr-3">
            <Minutes minutes={section.minutes} />
          </span>
          <span className="w-7 shrink-0" />
          <Moves id={section.id} name={section.title} up={up} down={down} />
          <FormModal action={updateLineAction} title="Edit section" icon="pencil" compact>
            <input type="hidden" name="id" value={section.id} />
            <Field label="Title" required>
              <Input name="text" defaultValue={section.title} required />
            </Field>
            <TimingFields row={section} minutes={ownMinutes} />
          </FormModal>
          <FormModal
            action={removeLineAction}
            title="Remove section"
            icon="close"
            submit="Remove"
            compact
            danger
          >
            <input type="hidden" name="id" value={section.id} />
          </FormModal>
        </div>
      </div>

      <div className="ml-1 mt-1 border-l-2 border-gray-100 pl-3 dark:border-gray-700">
        <ul>
          {section.lines.map((line) => (
            // Inside a section a line can always step: past the edge is out of it.
            <LineRow key={line.id} line={line} meetingId={meetingId} timed={timed} today={today} up down />
          ))}
        </ul>
        <AddLine meetingId={meetingId} sectionId={section.id} />
      </div>
    </li>
  )
}

/** The agenda as it will run: sections and lines in order, each with when it starts and how long it has. */
export function AgendaCard({ agenda, today }: { agenda: Agenda; today: string }) {
  const { meetingId, nodes } = agenda
  const timed = nodes.some(
    (node) => node.start !== null || (node.type === 'section' && node.lines.some((line) => line.start !== null)),
  )

  return (
    <Card>
      {agenda.totalMinutes > 0 || agenda.overflowMinutes > 0 ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-gray-100 pb-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          <span className="flex items-center gap-1.5 tabular-nums">
            <Icon name="clock" className="h-4 w-4 text-gray-400 dark:text-gray-500" label="Planned" />
            {agenda.totalMinutes} min
          </span>
          {timed && agenda.end ? (
            <span className="flex items-center gap-1.5 tabular-nums">
              <Icon name="arrowRight" className="h-4 w-4 text-gray-400 dark:text-gray-500" label="Ends" />
              {formatClock(agenda.end)}
            </span>
          ) : null}
          {agenda.overflowMinutes > 0 ? <Badge tone="red">+{agenda.overflowMinutes} min</Badge> : null}
        </div>
      ) : null}

      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {nodes.map((node, index) =>
          node.type === 'section' ? (
            <SectionBlock
              key={node.id}
              section={node}
              meetingId={meetingId}
              timed={timed}
              today={today}
              up={index > 0}
              down={index < nodes.length - 1}
            />
          ) : (
            <LineRow
              key={node.id}
              line={node}
              meetingId={meetingId}
              timed={timed}
              today={today}
              up={index > 0}
              down={index < nodes.length - 1}
            />
          ),
        )}
      </ul>

      <div className={nodes.length > 0 ? 'mt-2 border-t border-gray-100 pt-2 dark:border-gray-700' : ''}>
        <AddLine meetingId={meetingId} />
      </div>
    </Card>
  )
}
