import Link from 'next/link'
import {
  acceptProposalAction,
  acceptWithAction,
  editProposalAction,
  rejectProposalAction,
  makeProjectFromProposalAction,
  undoProposalAction,
} from '@/app/(app)/meetings/processing-actions'
import { askItemAction } from '@/app/(app)/actions'
import { FormModal, IconAction } from '@/components/forms'
import { PartyLine, targetMark } from '@/components/items/ItemCard'
import { MakeProjectFields } from '@/components/projects/MakeProjectFields'
import { Card } from '@/components/ui/Card'
import { Markdown } from '@/components/ui/Markdown'
import { Icon, type IconName } from '@/components/ui/icons'
import { Badge, DueBadge, KindIcon, StatusBadge, type Tone } from '@/components/ui/StatusBadge'
import { formatDay } from '@/lib/core/dates'
import type { ItemKind, ItemParty } from '@/lib/items/items'
import { roleLabel, roleOrder } from '@/lib/items/roles'
import type { ProposalView } from '@/lib/processing/proposals'
import { missingDetails } from '@/lib/processing/missing'
import { AcceptFields, CHANGES, ProposalFields, type ProposalChoices } from './ProposalFields'
import { ResolveParty } from './ResolveParty'

const CHANGE: Record<keyof typeof CHANGES, { tone: Tone; icon: IconName }> = {
  complete: { tone: 'green', icon: 'check' },
  answer: { tone: 'green', icon: 'check' },
  drop: { tone: 'gray', icon: 'close' },
  note: { tone: 'gray', icon: 'topic' },
  discussed: { tone: 'blue', icon: 'meeting' },
}

const LINK = 'hover:underline focus:outline-none focus-visible:underline'

function askable(proposal: ProposalView): boolean {
  const item = proposal.made?.item
  return (
    proposal.status === 'accepted' &&
    item !== null &&
    item !== undefined &&
    item.kind === 'question' &&
    item.status === 'open' &&
    item.laterUntilItemId === null &&
    item.parties.some((party) => party.role === 'owner' && !party.isSelf)
  )
}

/* A topic that could be a project of its own: proposed and not settled in the
   meeting, or accepted and still open. Returns what the form starts from. */
function projectable(proposal: ProposalView): { name: string; parentId: string | null } | null {
  const { payload } = proposal
  if (proposal.status === 'pending') {
    return payload.type === 'item' && payload.kind === 'topic' && !payload.resolution
      ? { name: payload.text, parentId: payload.projectId ?? null }
      : null
  }
  const item = proposal.status === 'accepted' ? proposal.made?.item : null
  return item && item.kind === 'topic' && item.status === 'open'
    ? { name: item.text, parentId: item.project?.id ?? null }
    : null
}

/* The mark on the left: an item's kind, or what else the proposal would make. */
function Mark({ proposal }: { proposal: ProposalView }) {
  const { payload } = proposal
  if (payload.type === 'item') return <KindIcon kind={payload.kind} ongoing={payload.ongoing} />
  if (payload.type === 'update' && proposal.item) {
    return <KindIcon kind={proposal.item.kind} ongoing={proposal.item.ongoing} />
  }
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
          : made?.document
            ? proposal.project
              ? `/projects/${proposal.project.id}`
              : `/meetings/${proposal.meetingId}#documents`
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
  meetingTitle,
}: {
  proposal: ProposalView
  choices: ProposalChoices
  today: string
  /** The meeting it came from: where a document is kept, with its project if it has one. */
  meetingTitle?: string
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
  const missing = pending ? missingDetails(payload, choices.projects.length > 0) : []
  /* A meeting to prep reads like an action: who it is with is where it points. */
  const kind: ItemKind = payload.type === 'item' ? payload.kind : 'action'
  const body = payload.type === 'item' ? payload.detail : payload.type === 'update' ? payload.text : null
  const asProject = projectable(proposal)
  const makeProject = asProject ? (
    <FormModal
      action={makeProjectFromProposalAction}
      title="Make project"
      icon="project"
      compact
      submit="Create"
      disabled={pending && unknown.length > 0}
    >
      <input type="hidden" name="id" value={proposal.id} />
      <MakeProjectFields name={asProject.name} parentId={asProject.parentId} projects={choices.projects} />
    </FormModal>
  ) : null

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
          proposal.series ||
          (payload.type === 'document' && meetingTitle) ||
          (payload.type === 'item' && payload.dueOn) ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                {/* Who leads, then who the arrow points at, each followed by its names still to be settled. */}
                {roleOrder(kind).map((role) => {
                  const settled = known.filter((party) => party.role === role)
                  const open = unknown.filter((party) => party.role === role)
                  if (settled.length + open.length === 0) return null
                  return (
                    <span key={role} className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {settled.length > 0 ? (
                        <PartyLine
                          parties={settled}
                          kind={kind}
                          ownerGuessed={pending && role === 'owner' && proposal.ownerGuessed}
                        />
                      ) : role === roleOrder(kind)[1] ? (
                        <Icon
                          name={targetMark(kind)}
                          className="h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400"
                          label={roleLabel(kind, role)}
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
                            takesGroups={payload.type === 'item'}
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
              <span className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                {payload.type === 'document' && meetingTitle ? (
                  <Badge>
                    <Icon name="meeting" className="h-3 w-3" label="Kept on" />
                    <span className="truncate">{meetingTitle}</span>
                  </Badge>
                ) : null}
                {proposal.project ? (
                  <Badge>
                    {payload.type === 'document' ? <Icon name="project" className="h-3 w-3" /> : null}
                    <span className="truncate" title={proposal.project.name}>
                      {proposal.project.name}
                    </span>
                  </Badge>
                ) : null}
                {proposal.series ? (
                  <Badge>
                    <Icon name="refresh" className="h-3 w-3" label="Raise at" />
                    <span className="truncate" title={proposal.series.name}>
                      {proposal.series.name}
                    </span>
                  </Badge>
                ) : null}
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
              <FormModal
                action={editProposalAction}
                title="Edit"
                icon="pencil"
                compact
                wide
              >
                <input type="hidden" name="id" value={proposal.id} />
                <ProposalFields proposal={proposal} choices={choices} />
              </FormModal>
              {/* Accepts it on the way, as a topic on the project made from it. */}
              {makeProject}
              {/* What it leaves unsaid is asked for on the way in; blank is fine. */}
              {missing.length > 0 ? (
                <FormModal
                  action={acceptWithAction}
                  title="Accept"
                  icon="check"
                  tone="blue"
                  compact
                  submit="Accept"
                  disabled={unknown.length > 0}
                >
                  <AcceptFields proposal={proposal} missing={missing} choices={choices} />
                </FormModal>
              ) : (
                <IconAction
                  action={acceptProposalAction}
                  fields={{ id: proposal.id }}
                  icon="check"
                  tone="blue"
                  label="Accept"
                  disabled={unknown.length > 0}
                />
              )}
            </>
          ) : (
            <>
              {/* A question it made for someone else to answer, not yet put to them. */}
              {askable(proposal) ? (
                <IconAction action={askItemAction} fields={{ id: proposal.made!.item!.id }} icon="mail" label="Ask" />
              ) : null}
              {makeProject}
              <IconAction action={undoProposalAction} fields={{ id: proposal.id }} icon="undo" label="Undo" />
            </>
          )}
        </span>
      </div>
    </Card>
  )
}
