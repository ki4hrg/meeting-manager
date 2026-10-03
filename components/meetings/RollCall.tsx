'use client'

import { useState } from 'react'
import { ActionForm } from '@/components/forms'
import { PartyPicker, type PartyOption } from '@/components/processing/PartyPicker'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'
import { GroupCluster, MeChip } from './Roster'
import type { ActionResult } from '@/lib/web/action'

type Entry = { id: string; name: string; present: boolean; groupId?: string | null }

/**
 * Who is here: everyone expected, Me first and fixed, then those on it by
 * name, then each group around the people it brings. A tap marks someone out
 * or back; anyone else who came is added below. Confirm settles it.
 */
export function RollCall({
  action,
  meetingId,
  entries,
  groups = [],
  people,
}: {
  action: (formData: FormData) => Promise<ActionResult>
  meetingId: string
  entries: Entry[]
  /** The meeting's groups, each drawn around its people. */
  groups?: { id: string; name: string }[]
  /** Who can be added: the directory, less who is already listed. */
  people: PartyOption[]
}) {
  const [present, setPresent] = useState(() => new Set(entries.filter((entry) => entry.present).map((entry) => entry.id)))
  const toggle = (id: string) =>
    setPresent((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const listed = new Set(entries.map((entry) => entry.id))
  const shown = new Set(groups.map((group) => group.id))
  const alone = entries.filter((entry) => !entry.groupId || !shown.has(entry.groupId))

  const toggleChip = (entry: Entry) => {
    const here = present.has(entry.id)
    return (
      <button
        key={entry.id}
        type="button"
        aria-pressed={here}
        onClick={() => toggle(entry.id)}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          here
            ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-200 dark:hover:bg-green-900/60'
            : 'bg-gray-100 text-gray-400 line-through hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-500 dark:hover:bg-gray-600'
        }`}
      >
        <Icon name={here ? 'check' : 'close'} className="h-3.5 w-3.5 shrink-0" label={here ? 'Here' : 'Out'} />
        <span className="truncate">{entry.name}</span>
      </button>
    )
  }

  return (
    <ActionForm action={action} className="flex flex-col gap-3">
      <input type="hidden" name="meetingId" value={meetingId} />
      {[...present].map((id) => (
        <input key={id} type="hidden" name="present" value={id} />
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
