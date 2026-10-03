import Link from 'next/link'
import { Chip } from '@/components/ui/Chip'
import { Icon } from '@/components/ui/icons'

type Person = { id: string; name: string }

const ME = 'inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'

/** John, on every roster: first, fixed, never picked or removed. */
export function MeChip({ href }: { href?: string }) {
  const body = (
    <>
      <Icon name="person" className="h-3.5 w-3.5 shrink-0" />
      Me
    </>
  )
  return href ? (
    <Link href={href} className={`${ME} hover:bg-blue-200 dark:hover:bg-blue-900/60`}>
      {body}
    </Link>
  ) : (
    <span className={ME}>{body}</span>
  )
}

/**
 * A group on a roster with the people it brings, inside one dashed outline,
 * so who came with a group reads apart from who is on it by name.
 */
export function GroupCluster({ chip, children }: { chip: React.ReactNode; children?: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-dashed border-gray-300 p-0.5 pr-1.5 dark:border-gray-600">
      {chip}
      {children}
    </span>
  )
}

/** One of a group's people, as a cluster lists them: lighter than a chip. */
export function MemberLink({ person }: { person: Person }) {
  return (
    <Link
      href={`/people/${person.id}`}
      className="inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
    >
      <Icon name="person" className="h-3 w-3 shrink-0 text-gray-400 dark:text-gray-500" />
      <span className="truncate">{person.name}</span>
    </Link>
  )
}

/**
 * Who is at a meeting: Me, those on it by name, then each group with the
 * people it brings. Someone whose group has since left the meeting is shown
 * on their own.
 */
export function Roster({
  selfId,
  groups,
  attendees,
}: {
  selfId?: string
  groups: Person[]
  attendees: (Person & { groupId: string | null })[]
}) {
  const shown = new Set(groups.map((group) => group.id))
  const alone = attendees.filter((person) => !person.groupId || !shown.has(person.groupId))
  return (
    <>
      <MeChip href={selfId ? `/people/${selfId}` : undefined} />
      {alone.map((person) => (
        <Chip key={person.id} href={`/people/${person.id}`} icon="person">
          {person.name}
        </Chip>
      ))}
      {groups.map((group) => (
        <GroupCluster
          key={group.id}
          chip={
            <Chip href={`/groups/${group.id}`} icon="group">
              {group.name}
            </Chip>
          }
        >
          {attendees
            .filter((person) => person.groupId === group.id)
            .map((person) => (
              <MemberLink key={person.id} person={person} />
            ))}
        </GroupCluster>
      ))}
    </>
  )
}
