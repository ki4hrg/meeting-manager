import Link from 'next/link'
import { Chip } from '@/components/ui/Chip'
import { Icon } from '@/components/ui/icons'
import { ATTENDANCE, iconClass } from '@/components/ui/StatusBadge'

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

type Mark = 'here' | 'out' | undefined

/** One of a group's people, as a cluster lists them: lighter than a chip. */
export function MemberLink({ person, mark }: { person: Person; mark?: Mark }) {
  const said = mark ? ATTENDANCE[mark] : null
  return (
    <Link
      href={`/people/${person.id}`}
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-xs hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700 dark:hover:text-gray-100 ${
        mark === 'out' ? 'text-gray-400 line-through dark:text-gray-500' : 'text-gray-600 dark:text-gray-300'
      }`}
    >
      <Icon
        name={said?.icon ?? 'person'}
        label={said?.label}
        className={`h-3 w-3 shrink-0 ${mark === 'here' ? iconClass('green') : 'text-gray-400 dark:text-gray-500'}`}
      />
      <span className="truncate">{person.name}</span>
    </Link>
  )
}

/** Someone on a meeting by name: a chip, green once said to be here, struck through once out. */
function PersonChip({ person, mark }: { person: Person; mark?: Mark }) {
  if (!mark) {
    return (
      <Chip href={`/people/${person.id}`} icon="person">
        {person.name}
      </Chip>
    )
  }
  const said = ATTENDANCE[mark]
  return (
    <Link
      href={`/people/${person.id}`}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${said.pill}`}
    >
      <Icon name={said.icon} label={said.label} className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{person.name}</span>
    </Link>
  )
}

/**
 * Who is at a meeting: Me, those on it by name, then each group with the
 * people it brings, each marked once John has said whether they were there.
 * Someone whose group has since left the meeting is shown on their own.
 */
export function Roster({
  selfId,
  groups,
  attendees,
  absent = [],
}: {
  selfId?: string
  groups: Person[]
  attendees: (Person & { groupId: string | null; here?: boolean })[]
  /** Who was marked out, shown struck through where they would be. */
  absent?: (Person & { groupId: string | null })[]
}) {
  const everyone = [
    ...attendees.map((person) => ({ ...person, mark: (person.here ? 'here' : undefined) as Mark })),
    ...absent.map((person) => ({ ...person, mark: 'out' as Mark })),
  ].sort((a, b) => a.name.localeCompare(b.name))
  const shown = new Set(groups.map((group) => group.id))
  const alone = everyone.filter((person) => !person.groupId || !shown.has(person.groupId))
  return (
    <>
      <MeChip href={selfId ? `/people/${selfId}` : undefined} />
      {alone.map((person) => (
        <PersonChip key={person.id} person={person} mark={person.mark} />
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
          {everyone
            .filter((person) => person.groupId === group.id)
            .map((person) => (
              <MemberLink key={person.id} person={person} mark={person.mark} />
            ))}
        </GroupCluster>
      ))}
    </>
  )
}
