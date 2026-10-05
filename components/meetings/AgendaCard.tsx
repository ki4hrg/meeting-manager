import Link from 'next/link'
import {
  markDiscussedAction,
  nudgeLineAction,
  removeLineAction,
  restoreLineAction,
  updateLineAction,
} from '@/app/(app)/meetings/actions'
import { FormModal, IconAction } from '@/components/forms'
import { PartyLine } from '@/components/items/ItemCard'
import { Card } from '@/components/ui/Card'
import { Field, Input, Select, Textarea } from '@/components/ui/Field'
import { Markdown } from '@/components/ui/Markdown'
import { Icon } from '@/components/ui/icons'
import { Badge, DueBadge, KindIcon, StatusBadge } from '@/components/ui/StatusBadge'
import type { Agenda, AgendaLine, AgendaSection } from '@/lib/agenda/lines'
import { formatClock, formatDay } from '@/lib/core/dates'
import { isOpen } from '@/lib/items/items'
import { AddLine } from './AddLine'

/* The left gutter: when the row starts. A pinned start is a pill; one that
   what comes before it runs past is the danger tone. */
function Start({ row }: { row: { start: string | null; pinnedStart: string | null; overrunMinutes?: number } }) {
  if (!row.start) return <span className="w-[5.5rem] shrink-0" />
  const time = formatClock(row.start)
  return (
    <span className="w-[5.5rem] shrink-0 pt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">
      {row.overrunMinutes ? (
        <span title={`+${row.overrunMinutes} min`}>
          <Badge tone="red">{time}</Badge>
        </span>
      ) : row.pinnedStart ? (
        <Badge tone="blue">
          <Icon name="pin" className="h-3 w-3" label="Pinned" />
          {time}
        </Badge>
      ) : (
        time
      )}
    </span>
  )
}

/* A row's length. A share of a timebox is computed, so it reads lighter. */
function Minutes({ minutes, share }: { minutes: number | null; share?: number }) {
  if (minutes) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">{minutes} min</span>
    )
  }
  if (share === undefined) return null
  return (
    <span className="shrink-0 text-xs italic tabular-nums text-gray-400 dark:text-gray-500">{share} min</span>
  )
}

/* A timebox's header: what its lines use of it, red once they ask for more. */
function Budget({ section }: { section: AgendaSection }) {
  if (section.usedMinutes === undefined) return <Minutes minutes={section.minutes} />
  const text = `${section.usedMinutes} / ${section.minutes} min`
  return section.overBudgetMinutes ? (
    <Badge tone="red">{text}</Badge>
  ) : (
    <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">{text}</span>
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

/* The timing shared by a line's form and a section's: its minutes, and for
   the rare fixed slot, a pin that reveals the time it starts at. */
function TimingFields({ row }: { row: { pinnedStart: string | null; minutes: number | null } }) {
  return (
    <div className="grid grid-cols-2 items-end gap-3">
      <Field label="Minutes">
        <Input name="minutes" type="number" min={0} inputMode="numeric" defaultValue={row.minutes ?? ''} />
      </Field>
      <div className="flex items-center gap-3">
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-2 text-sm font-medium text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            name="pinned"
            defaultChecked={row.pinnedStart !== null}
            className="peer h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
          />
          <Icon name="pin" className="h-4 w-4" label="Pin" />
        </label>
        <div className="hidden min-w-0 flex-1 [label:has(:checked)+&]:block">
          <Input name="pinnedStart" type="time" aria-label="Starts at" defaultValue={row.pinnedStart ?? ''} />
        </div>
      </div>
    </div>
  )
}

/** Who can lead a line: anyone in the directory, John first as "Me". */
export type LeaderChoice = { id: string; name: string; isSelf: boolean }

function LineRow({
  line,
  meetingId,
  timed,
  today,
  people,
  sessions,
  up,
  down,
}: {
  line: AgendaLine
  meetingId: string
  timed: boolean
  today: string
  people: LeaderChoice[]
  sessions?: SessionChoice[]
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

        {line.leader ? (
          <p className="mt-1 flex items-center gap-1 text-xs font-medium text-gray-600 dark:text-gray-300">
            <Icon name="person" className="h-3 w-3 shrink-0 text-gray-400 dark:text-gray-500" label="Leads" />
            {line.leader.isSelf ? 'Me' : line.leader.name}
          </p>
        ) : null}

        {line.description ? (
          <Markdown source={line.description} className="mt-1 text-sm text-gray-600 dark:text-gray-300" />
        ) : null}

        {item && (item.parties.length > 0 || item.dueOn || item.project || !isOpen(item)) ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <PartyLine parties={item.parties} kind={item.kind} />
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
          <div className="mt-1 flex items-start gap-1.5 text-xs italic text-gray-500 dark:text-gray-400">
            <Icon name="lock" className="mt-0.5 h-3 w-3 shrink-0" label="Private note" />
            <Markdown source={line.privateNote} />
          </div>
        ) : null}
      </div>

      {/* Minutes and actions wrap together, so on a phone they share the row under the text. */}
      <div className="ml-auto flex shrink-0 items-center">
        <span className="mr-3">
          <Minutes minutes={line.minutes} share={line.shareMinutes} />
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
          <Field label="Leader">
            <Select name="leaderPersonId" defaultValue={line.leader?.id ?? ''}>
              <option value="">—</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.isSelf ? 'Me' : person.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Description">
            <Textarea name="description" rows={3} defaultValue={line.description ?? ''} />
          </Field>
          <Field label="Private note">
            <Textarea name="privateNote" rows={3} defaultValue={line.privateNote ?? ''} />
          </Field>
          <TimingFields row={line} />
          <SessionField sessions={sessions} meetingId={meetingId} />
        </FormModal>
        <IconAction
          action={removeLineAction}
          done="Removed"
          undo={{ action: restoreLineAction, fields: {} }}
          fields={{ id: line.id }}
          icon="close"
          label={`Remove ${line.text}`}
        />
      </div>
    </li>
  )
}

export type SessionChoice = { id: string; title: string }

/* On a session: which session the row runs in. Picking another moves it there. */
function SessionField({ sessions, meetingId }: { sessions?: SessionChoice[]; meetingId: string }) {
  if (!sessions || sessions.length < 2) return null
  return (
    <Field label="Session">
      <Select name="sessionId" defaultValue={meetingId}>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.title}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function SectionBlock({
  section,
  meetingId,
  timed,
  today,
  people,
  sessions,
  up,
  down,
}: {
  section: AgendaSection
  meetingId: string
  timed: boolean
  today: string
  people: LeaderChoice[]
  sessions?: SessionChoice[]
  up: boolean
  down: boolean
}) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        {timed ? <Start row={section} /> : null}
        <h3 className="min-w-0 flex-1 basis-40 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {section.title}
        </h3>
        <div className="ml-auto flex shrink-0 items-center">
          <span className="mr-3">
            <Budget section={section} />
          </span>
          <span className="w-7 shrink-0" />
          <Moves id={section.id} name={section.title} up={up} down={down} />
          <FormModal action={updateLineAction} title="Edit section" icon="pencil" compact>
            <input type="hidden" name="id" value={section.id} />
            <Field label="Title" required>
              <Input name="text" defaultValue={section.title} required />
            </Field>
            <TimingFields row={{ pinnedStart: section.pinnedStart, minutes: section.ownMinutes }} />
            <SessionField sessions={sessions} meetingId={meetingId} />
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
            <LineRow
              key={line.id}
              line={line}
              meetingId={meetingId}
              timed={timed}
              today={today}
              people={people}
              sessions={sessions}
              up
              down
            />
          ))}
        </ul>
        <AddLine meetingId={meetingId} sectionId={section.id} />
      </div>
    </li>
  )
}

/** The agenda as it will run: sections and lines in order, each with when it starts and how long it has. */
export function AgendaCard({
  agenda,
  today,
  people,
  sessions,
}: {
  agenda: Agenda
  today: string
  people: LeaderChoice[]
  /** On a session: every session of its meeting, so a row can be bumped to another. */
  sessions?: SessionChoice[]
}) {
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
              people={people}
              sessions={sessions}
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
              people={people}
              sessions={sessions}
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
