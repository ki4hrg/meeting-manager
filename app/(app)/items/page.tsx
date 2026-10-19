import { ItemGrid } from '@/components/items/ItemCard'
import { QuickAdd } from '@/components/QuickAdd'
import { Section } from '@/components/ui/Card'
import { FilterChip } from '@/components/ui/Chip'
import { Input, Select } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Icon } from '@/components/ui/icons'
import { PageHeader } from '@/components/ui/PageHeader'
import { KIND, KindIcon } from '@/components/ui/StatusBadge'
import { isUuid } from '@/lib/core/match'
import { db } from '@/lib/db'
import { listGroups } from '@/lib/directory/groups'
import { listPeople } from '@/lib/directory/people'
import { isLater, isWaitingOn } from '@/lib/items/horizon'
import { isOpen, listItems, type ItemKind, type ItemView } from '@/lib/items/items'
import { listProjectChoices } from '@/lib/projects/projects'
import { requireContext, viewer } from '@/lib/web/context'

type Search = Promise<Record<string, string | string[] | undefined>>

const KINDS: ItemKind[] = ['action', 'question', 'topic', 'decision']
const PLURAL: Record<ItemKind, string> = {
  action: 'Actions',
  question: 'Questions',
  topic: 'Topics',
  decision: 'Decisions',
}
const STATUSES = [
  { value: 'open', label: 'Open', icon: null },
  { value: 'later', label: 'Later', icon: 'later' },
  { value: 'closed', label: 'Closed', icon: 'check' },
] as const
const ROLES = [
  { value: 'owe', label: 'I owe' },
  { value: 'waiting', label: 'Waiting on' },
  { value: 'raised', label: 'I raised' },
  { value: 'ongoing', label: 'Ongoing' },
] as const
const DATES = [
  { value: 'none', label: 'No date', icon: 'clock' },
  { value: 'overdue', label: 'Overdue', icon: 'flag' },
] as const

type Filters = {
  kind?: ItemKind
  status: (typeof STATUSES)[number]['value']
  role?: (typeof ROLES)[number]['value']
  date?: (typeof DATES)[number]['value']
  /** `p:<id>` or `g:<id>`. */
  who?: string
  project?: string
  q?: string
}

function read(query: Awaited<Search>): Filters {
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined)
  const pick = <T extends string>(key: string, values: readonly T[]) =>
    values.find((value) => value === one(key))
  const who = one('who')
  const project = one('project')
  return {
    kind: pick('kind', KINDS),
    status: pick('status', STATUSES.map((s) => s.value)) ?? 'open',
    role: pick('role', ROLES.map((r) => r.value)),
    date: pick('date', DATES.map((d) => d.value)),
    who: who && /^[pg]:/.test(who) && isUuid(who.slice(2)) ? who : undefined,
    project: project && isUuid(project) ? project : undefined,
    q: one('q')?.trim() || undefined,
  }
}

/* The page's address with one filter set, or cleared when it is already that. */
function hrefWith(filters: Filters, key: keyof Filters, value: string | undefined): string {
  const next = { ...filters, [key]: filters[key] === value && key !== 'status' ? undefined : value }
  const params = new URLSearchParams()
  for (const [name, set] of Object.entries(next)) {
    if (set && !(name === 'status' && set === 'open')) params.set(name, set)
  }
  const query = params.toString()
  return query ? `/items?${query}` : '/items'
}

/*
 * Every item in the selected context, open ones by kind, so none is lost to
 * the hub it hangs off. Filters are links; the search, a person or group and
 * a project are one small form.
 */
export default async function ItemsPage({ searchParams }: { searchParams: Search }) {
  const context = await requireContext()
  const { today } = await viewer()
  const filters = read(await searchParams)

  const [all, people, groups, projects] = await Promise.all([
    listItems(db, {
      contextId: context.id,
      kinds: filters.kind ? [filters.kind] : undefined,
      projectId: filters.project,
      party: filters.who
        ? filters.who.startsWith('p:')
          ? { personId: filters.who.slice(2) }
          : { groupId: filters.who.slice(2) }
        : undefined,
      search: filters.q,
    }),
    listPeople(db),
    listGroups(db, context.id),
    listProjectChoices(db, context.id),
  ])

  const byStatus = (item: ItemView) =>
    filters.status === 'closed'
      ? !isOpen(item)
      : isOpen(item) && (filters.status === 'later') === isLater(item, today)
  const byRole = (item: ItemView) =>
    filters.role === 'owe'
      ? !item.ongoing && item.parties.some((party) => party.role === 'owner' && party.isSelf)
      : filters.role === 'waiting'
        ? isWaitingOn(item)
        : filters.role === 'raised'
          ? item.parties.some((party) => party.role === 'with' && party.isSelf)
          : filters.role === 'ongoing'
            ? item.ongoing
            : true
  const byDate = (item: ItemView) =>
    filters.date === 'none'
      ? item.dueOn === null
      : filters.date === 'overdue'
        ? item.dueOn !== null && item.dueOn < today && isOpen(item)
        : true
  const shown = all.filter((item) => byStatus(item) && byRole(item) && byDate(item))

  const grid = (list: ItemView[]) => <ItemGrid items={list} today={today} empty="inbox" />
  const kept = (names: Array<keyof Filters>) =>
    names.flatMap((name) =>
      filters[name] && !(name === 'status' && filters[name] === 'open')
        ? [<input key={name} type="hidden" name={name} value={filters[name]} />]
        : [],
    )

  return (
    <>
      <PageHeader title="Items" count={shown.length} actions={<QuickAdd primary />} />

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {KINDS.map((kind) => (
            <FilterChip
              key={kind}
              href={hrefWith(filters, 'kind', kind)}
              on={filters.kind === kind}
              label={KIND[kind].label}
              icon={<KindIcon kind={kind} className="h-4 w-4" />}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-600" aria-hidden />
          {STATUSES.map((status) => (
            <FilterChip
              key={status.value}
              href={hrefWith(filters, 'status', status.value)}
              on={filters.status === status.value}
              icon={status.icon ? <Icon name={status.icon} className="h-3.5 w-3.5 shrink-0" /> : null}
            >
              {status.label}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ROLES.map((role) => (
            <FilterChip key={role.value} href={hrefWith(filters, 'role', role.value)} on={filters.role === role.value}>
              {role.label}
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-gray-300 dark:bg-gray-600" aria-hidden />
          {DATES.map((date) => (
            <FilterChip
              key={date.value}
              href={hrefWith(filters, 'date', date.value)}
              on={filters.date === date.value}
              icon={<Icon name={date.icon} className="h-3.5 w-3.5 shrink-0" />}
            >
              {date.label}
            </FilterChip>
          ))}
        </div>
        <form action="/items" className="flex flex-wrap items-center gap-2">
          {kept(['kind', 'status', 'role', 'date'])}
          <Input
            type="search"
            name="q"
            defaultValue={filters.q}
            aria-label="Search"
            className="min-w-0 flex-1 basis-full sm:basis-48"
          />
          <Select
            name="who"
            defaultValue={filters.who ?? ''}
            aria-label="Person or group"
            className="!w-auto min-w-0 max-w-full flex-1 sm:flex-none"
          >
            <option value="">Anyone</option>
            <optgroup label="People">
              {people.map((person) => (
                <option key={person.id} value={`p:${person.id}`}>
                  {person.isSelf ? 'Me' : person.name}
                </option>
              ))}
            </optgroup>
            {groups.length > 0 ? (
              <optgroup label="Groups">
                {groups.map((group) => (
                  <option key={group.id} value={`g:${group.id}`}>
                    {group.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
          <Select
            name="project"
            defaultValue={filters.project ?? ''}
            aria-label="Project"
            className="!w-auto min-w-0 max-w-full flex-1 sm:flex-none"
          >
            <option value="">Any project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <IconButton type="submit" icon="search" label="Search" size="md" />
        </form>
      </div>

      {filters.kind || shown.length === 0
        ? grid(shown)
        : KINDS.map((kind) => {
            const list = shown.filter((item) => item.kind === kind)
            return list.length > 0 ? (
              <Section key={kind} title={PLURAL[kind]} count={list.length}>
                {grid(list)}
              </Section>
            ) : null
          })}
    </>
  )
}
