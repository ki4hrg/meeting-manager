'use client'

import { useState } from 'react'
import { ActionForm } from '@/components/forms'
import { PartyPicker, type PartyOption } from '@/components/processing/PartyPicker'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'
import { ATTENDANCE, type Attendance } from '@/components/ui/StatusBadge'
import { GroupCluster, MeChip } from './Roster'
import type { ActionResult } from '@/lib/web/action'

type Entry = { id: string; name: string; mark: 'here' | 'out' | null; groupId?: string | null }

type Props = {
  action: (formData: FormData) => Promise<ActionResult>
  meetingId: string
  entries: Entry[]
  /** The meeting's groups, each drawn around its people. */
  groups?: { id: string; name: string }[]
  /** Who can be added: the directory, less who is already listed. */
  people: PartyOption[]
}

/* A tap moves someone on: not yet said, here, out, and round again. */
const NEXT: Record<Attendance, Attendance> = { unsure: 'here', here: 'out', out: 'unsure' }

/**
 * Who was there: everyone on the list, Me first and fixed, then those on it by
 * name, then each group around the people it brings. Each is here, out, or not
 * yet said, and a tap moves them on; anyone else who came is added below, as
 * here. Confirm saves it, and it can be taken again at any time.
 *
 * Once saved, the page comes back with the list as it now stands: the form
 * starts again from that, and the picker is empty again.
 */
export function RollCall(props: Props) {
  const saved = props.entries.map((entry) => `${entry.id}:${entry.mark ?? '-'}`).join(',')
  return <RollCallForm key={saved} {...props} />
}

function RollCallForm({ action, meetingId, entries, groups = [], people }: Props) {
  const [marks, setMarks] = useState(
    () => new Map(entries.map((entry) => [entry.id, (entry.mark ?? 'unsure') as Attendance])),
  )
  const move = (id: string) =>
    setMarks((current) => new Map(current).set(id, NEXT[current.get(id) ?? 'unsure']))
  const listed = new Set(entries.map((entry) => entry.id))
  const shown = new Set(groups.map((group) => group.id))
  const alone = entries.filter((entry) => !entry.groupId || !shown.has(entry.groupId))

  const toggleChip = (entry: Entry) => {
    const mark = marks.get(entry.id) ?? 'unsure'
    const look = ATTENDANCE[mark]
    return (
      <button
        key={entry.id}
        type="button"
        aria-pressed={mark === 'here'}
        onClick={() => move(entry.id)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${look.pill}`}
      >
        <Icon name={look.icon} className="h-3.5 w-3.5 shrink-0" label={look.label} />
        <span className="truncate">{entry.name}</span>
      </button>
    )
  }

  return (
    <ActionForm action={action} className="flex flex-col gap-3">
      <input type="hidden" name="meetingId" value={meetingId} />
      {[...marks].map(([id, mark]) => (
        <input key={id} type="hidden" name={mark} value={id} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <MeChip />
        {alone.map(toggleChip)}
        {groups.map((group) => (
          <GroupCluster
            key={group.id}
            chip={
              <span className="inline-flex items-center gap-1.5 px-1.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300">
                <Icon name="group" className="h-3.5 w-3.5 shrink-0" />
                {group.name}
              </span>
            }
          >
            {entries.filter((entry) => entry.groupId === group.id).map(toggleChip)}
          </GroupCluster>
        ))}
      </div>
      <PartyPicker
        label="Also here"
        name="personIds"
        options={people.filter((option) => !listed.has(option.value))}
        allowNew
      />
      <div className="flex justify-end">
        <Button type="submit" size="sm">
          <Icon name="check" className="h-4 w-4" />
          Confirm
        </Button>
      </div>
    </ActionForm>
  )
}
