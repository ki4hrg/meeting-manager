import Link from 'next/link'
import {
  acceptProposalAction,
  editProposalAction,
  rejectProposalAction,
  undoProposalAction,
} from '@/app/(app)/meetings/processing-actions'
import { FormModal, IconAction } from '@/components/forms'
import { PartyLine } from '@/components/items/ItemCard'
import { Card } from '@/components/ui/Card'
import { Markdown } from '@/components/ui/Markdown'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, DueBadge, KindIcon, StatusBadge, type Tone } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import type { ItemParty } from '@/lib/items/items'
import type { ProposalView } from '@/lib/processing/proposals'
import { CHANGES, ProposalFields, type ProposalChoices } from './ProposalFields'
import { ResolveParty } from './ResolveParty'

const CHANGE: Record<keyof typeof CHANGES, { tone: Tone; icon: IconName }> = {
  complete: { tone: 'green', icon: 'check' },
  answer: { tone: 'green', icon: 'check' },
  drop: { tone: 'gray', icon: 'close' },
  note: { tone: 'gray', icon: 'topic' },
  discussed: { tone: 'blue', icon: 'meeting' },
}

const LINK = 'hover:underline focus:outline-none focus-visible:underline'

/* The mark on the left: an item's kind, or what else the proposal would make. */
function Mark({ proposal }: { proposal: ProposalView }) {
  const { payload } = proposal
  if (payload.type === 'item') return <KindIcon kind={payload.kind} />
  if (payload.type === 'update' && proposal.item) return <KindIcon kind={proposal.item.kind} />
  const [icon, label] =
    payload.type === 'document'
      ? (['document', 'Document'] as const)
      : payload.type === 'stub'
        ? (['meeting', 'Meeting'] as const)
        : (['refresh', 'Update'] as const)
  return (
    <span className="inline-flex shrink-0 text-gray-400 dark:text-gray-500">
      <Icon name={icon} label={label} />
    </span>
  )
}

/* What it is called, and once accepted, the way to what it made. */
function Title({ proposal }: { proposal: ProposalView }) {
  const { payload, made } = proposal
  const text =
    payload.type === 'item'
      ? payload.text
      : payload.type === 'update'
        ? (proposal.item?.text ?? '—')
        : payload.title
  const href =
    payload.type === 'update' && proposal.item
      ? `/items/${proposal.item.id}`
      : made?.item
        ? `/items/${made.item.id}`
        : made?.meeting
          ? `/meetings/${made.meeting.id}`
          : made?.document && proposal.project
            ? `/projects/${proposal.project.id}`
            : null

  const tone =
    proposal.status === 'rejected'
      ? 'text-gray-500 line-through dark:text-gray-400'
      : 'text-gray-900 dark:text-gray-100'
  return (
    <p className={`text-sm font-medium ${tone}`}>
      {href ? (
        <Link href={href} className={LINK}>
          {text}
        </Link>
      ) : (
        text
      )}
    </p>
  )
}

/**
 * One thing processing suggests, as a card: what it is, who it involves, and
 * the marks that say how far to trust it. Pending, it can be accepted, edited
 * or turned away; handled, it can be put back.
 */
export function ProposalCard({
  proposal,
  choices,
  today,
  selfId,
}: {
  proposal: ProposalView
  choices: ProposalChoices
  today: string
  /** John's person row: a party that is him reads "Me". */
  selfId: string
}) {
  const { payload } = proposal
  const pending = proposal.status === 'pending'

  const known: ItemParty[] = proposal.parties.flatMap((party) =>
    party.type && party.id
      ? [{ type: party.type, id: party.id, name: party.name, role: party.role, isSelf: party.id === selfId }]
      : [],
  )
  const unknown = proposal.parties.filter((party) => party.unresolved)
  /* A follow-up named after the one person it is with says who twice. */
  const named =
    payload.type === 'stub' && payload.title === proposal.parties.map((party) => party.name).join(', ')
  const body = payload.type === 'item' ? payload.detail : payload.type === 'update' ? payload.text : null

  return (
    <Card className={`flex flex-col ${pending ? '' : 'opacity-80'}`}>
      <div className="mb-3 flex items-start gap-3">
        <Mark proposal={proposal} />
        <div className="min-w-0 flex-1">
          <Title proposal={proposal} />

          {payload.type === 'update' ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {/* Once accepted the item's own status is the change: said once. */}
              {pending && proposal.item && proposal.item.status !== 'open' ? (
                <StatusBadge status={proposal.item.status} />
              ) : null}
              {pending ? (
                <Icon name="arrowRight" className="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" label="Becomes" />
              ) : null}
              <Badge tone={CHANGE[payload.change].tone}>
                <Icon name={CHANGE[payload.change].icon} className="h-3 w-3" />
                {CHANGES[payload.change]}
              </Badge>
            </div>
          ) : null}

          {body ? (
            <p className="mt-1 whitespace-pre-line text-sm text-gray-600 dark:text-gray-300">{body}</p>
          ) : null}
          {payload.type === 'item' && payload.resolution ? (
            <div className="mt-1 flex items-start gap-1.5 text-sm text-gray-700 dark:text-gray-300">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" label="Resolution" />
              <Markdown source={payload.resolution} />
            </div>
          ) : null}

          {payload.type === 'document' ? (
            <details className="group mt-1 text-sm text-gray-600 dark:text-gray-300">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-2 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [&::-webkit-details-marker]:hidden">
                <span className="line-clamp-2 min-w-0 whitespace-pre-line group-open:invisible group-open:h-0">
                  {payload.body}
                </span>
                <Icon
                  name="chevronDown"
                  className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-180 dark:text-gray-500"
                  label="All of it"
                />
              </summary>
              <Markdown source={payload.body} className="mt-1" />
            </details>
          ) : null}

          {proposal.parent ? (
            <p className="mt-1.5 flex min-w-0 items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <Icon name="undo" className="h-3.5 w-3.5 shrink-0" label="Follows from" />
              <Link href={`/items/${proposal.parent.id}`} className={`truncate ${LINK}`}>
                {proposal.parent.text}
              </Link>
            </p>
          ) : null}

          {(known.length + unknown.length > 0 && !named) ||
          proposal.project ||
          (payload.type === 'item' && payload.dueOn) ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {/* Owners, then who it is with, each followed by its names still to be settled. */}
                {(['owner', 'with'] as const).map((role) => {
                  const settled = known.filter((party) => party.role === role)
                  const open = unknown.filter((party) => party.role === role)
                  if (settled.length + open.length === 0) return null
                  return (
                    <span key={role} className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {settled.length > 0 ? (
                        <PartyLine parties={settled} />
                      ) : role === 'with' ? (
                        <Icon
                          name="arrowRight"
                          className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400"
                          label="With"
                        />
                      ) : null}
                      {open.map((party) =>
                        pending ? (
                          <ResolveParty
                            key={party.name}
                            proposalId={proposal.id}
                            name={party.name}
                            people={choices.people}
                            groups={payload.type === 'item' ? choices.groups : []}
                          />
                        ) : (
                          <Badge key={party.name} tone="amber">
                            <Icon name="alert" className="h-3 w-3" />
                            {party.name}
                          </Badge>
                        ),
                      )}
                    </span>
                  )
                })}
              </span>
              <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {proposal.project ? <Badge>{proposal.project.name}</Badge> : null}
                {payload.type === 'item' && payload.dueOn ? (
                  <DueBadge label={formatDay(payload.dueOn, today)} dueOn={payload.dueOn} today={today} />
                ) : null}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-gray-100 pt-2 dark:border-gray-700">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          {proposal.lowConfidence ? (
            <Badge tone="amber">
              <Icon name="alert" className="h-3 w-3" />
              Unsure
            </Badge>
          ) : null}
          {proposal.verbatim ? (
            <span title="Verbatim">
              <Badge>
                <span aria-hidden>“ ”</span>
                <span className="sr-only">Verbatim</span>
              </Badge>
            </span>
          ) : null}
          {proposal.agendaLine ? (
            <>
              <Icon name="section" className="h-3.5 w-3.5 shrink-0" label="Agenda line" />
              <span className="truncate">{proposal.agendaLine.text}</span>
            </>
          ) : null}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          {pending ? (
            <>
              <IconAction
                action={rejectProposalAction}
                fields={{ id: proposal.id }}
                icon="close"
                label="Reject"
              />
              <FormModal action={editProposalAction} title="Edit" icon="pencil" compact wide>
                <input type="hidden" name="id" value={proposal.id} />
                <ProposalFields proposal={proposal} choices={choices} />
              </FormModal>
              <IconAction
                action={acceptProposalAction}
                fields={{ id: proposal.id }}
                icon="check"
                tone="blue"
                label="Accept"
                disabled={unknown.length > 0}
              />
            </>
          ) : (
            <IconAction action={undoProposalAction} fields={{ id: proposal.id }} icon="undo" label="Undo" />
          )}
        </span>
      </div>
    </Card>
  )
}
