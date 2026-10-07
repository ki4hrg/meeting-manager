import Link from 'next/link'
import { toggleBlockAction } from '@/app/(app)/meetings/actions'
import { IconAction } from '@/components/forms'
import { Card, CardHeader, Section } from '@/components/ui/Card'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, DueBadge, KindIcon } from '@/components/ui/StatusBadge'
import type { GeneratedBlocks } from '@/lib/agenda/types'
import { formatDay, formatMoment } from '@/lib/core/dates'
import type { BlockSettings } from '@/lib/db/schema'

const BLOCKS: Array<{ name: keyof BlockSettings; label: string; icon: IconName }> = [
  { name: 'followUps', label: 'Follow-ups due', icon: 'clock' },
  { name: 'sinceLast', label: 'Since last time', icon: 'undo' },
  { name: 'lookahead', label: 'Lookahead', icon: 'flag' },
]

const ROW = 'flex items-start gap-2 py-1.5'
const TEXT = 'min-w-0 flex-1 text-sm text-gray-900 hover:underline dark:text-gray-100'
const LABEL = 'mb-1 flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300'

/**
 * The generated blocks of a meeting, computed as the page is drawn: a toggle
 * for each, and a card for each that is on and has something in it.
 */
export function Blocks({
  meetingId,
  settings,
  blocks,
  today,
  timeZone,
}: {
  meetingId: string
  settings: BlockSettings
  blocks: GeneratedBlocks
  today: string
  timeZone: string | null
}) {
  const { followUps, sinceLast, lookahead } = blocks

  return (
    <Section
      title="Blocks"
      action={
        <div className="flex items-center gap-1">
          {BLOCKS.map((block) => (
            <IconAction
              key={block.name}
              action={toggleBlockAction}
              fields={{ id: meetingId, block: block.name }}
              icon={block.icon}
              label={block.label}
              tone={settings[block.name] ? 'on' : 'gray'}
              aria-pressed={settings[block.name]}
            />
          ))}
        </div>
      }
    >
      {followUps || sinceLast || lookahead ? (
        <div className="card-grid grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          {followUps ? (
            <Card>
              <CardHeader title="Follow-ups due" />
              <div className="flex flex-col gap-3">
                {followUps.map(({ party, items }) => (
                  <div key={`${party.type}:${party.id}`}>
                    <p className={LABEL}>
                      <Icon name={party.type} className="h-3.5 w-3.5" />
                      {party.name}
                    </p>
                    <ul>
                      {items.map((item) => (
                        <li key={item.itemId} className={ROW}>
                          <KindIcon kind={item.kind} className="mt-0.5 h-4 w-4" />
                          <Link href={`/items/${item.itemId}`} className={TEXT}>
                            {item.text}
                          </Link>
                          {item.dueOn ? (
                            <DueBadge label={formatDay(item.dueOn, today)} dueOn={item.dueOn} today={today} />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {sinceLast ? (
            <Card>
              <CardHeader
                title="Since last time"
                aside={
                  <Link
                    href={`/meetings/${sinceLast.meeting.id}`}
                    className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {sinceLast.meeting.startsAt
                      ? formatMoment(sinceLast.meeting.startsAt, timeZone)
                      : sinceLast.meeting.title}
                  </Link>
                }
              />
              <ul>
                {sinceLast.decisions.map((decision) => (
                  <li key={decision.itemId} className={ROW}>
                    <KindIcon kind="decision" className="mt-0.5 h-4 w-4" />
                    <Link href={`/items/${decision.itemId}`} className={TEXT}>
                      {decision.text}
                    </Link>
                  </li>
                ))}
                {sinceLast.closed.map((item) => (
                  <li key={item.itemId} className={ROW}>
                    <span className="mt-0.5 shrink-0 text-green-600 dark:text-green-400">
                      <Icon name="check" className="h-4 w-4" label="Closed" />
                    </span>
                    <Link href={`/items/${item.itemId}`} className={TEXT}>
                      <span className="text-gray-500 line-through dark:text-gray-400">{item.text}</span>
                      {item.resolution ? <span className="block">{item.resolution}</span> : null}
                    </Link>
                  </li>
                ))}
                {sinceLast.stillOpen.map((item) => (
                  <li key={item.itemId} className={ROW}>
                    <KindIcon kind={item.kind} className="mt-0.5 h-4 w-4" />
                    <Link href={`/items/${item.itemId}`} className={TEXT}>
                      {item.text}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {lookahead ? (
            <Card>
              <CardHeader title="Lookahead" />
              <ul>
                {lookahead.milestones.map((milestone) => (
                  <li key={milestone.id} className={ROW}>
                    <Icon
                      name="flag"
                      className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                      label="Milestone"
                    />
                    <span className="min-w-0 flex-1 text-sm text-gray-900 dark:text-gray-100">
                      {milestone.title}
                    </span>
                    <Badge>{milestone.projectName}</Badge>
                    <DueBadge label={formatDay(milestone.dueOn, today)} dueOn={milestone.dueOn} today={today} />
                  </li>
                ))}
                {lookahead.deadlines.map((deadline) => (
                  <li key={deadline.itemId} className={ROW}>
                    <KindIcon kind={deadline.kind} className="mt-0.5 h-4 w-4" />
                    <Link href={`/items/${deadline.itemId}`} className={TEXT}>
                      {deadline.text}
                    </Link>
                    <DueBadge label={formatDay(deadline.dueOn, today)} dueOn={deadline.dueOn} today={today} />
                  </li>
                ))}
                {lookahead.meetings.map((meeting) => (
                  <li key={meeting.id} className={ROW}>
                    <Icon
                      name="meeting"
                      className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
                      label="Meeting"
                    />
                    <Link href={`/meetings/${meeting.id}`} className={TEXT}>
                      {meeting.title}
                    </Link>
                    <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                      {formatMoment(meeting.startsAt, timeZone)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}
