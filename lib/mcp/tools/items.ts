/*
 * The item tools. Names of people, groups, projects and contexts are accepted
 * wherever an id is, and resolved the way quick-add resolves them; an
 * ambiguous name is refused with its candidates rather than guessed at.
 */

import { z } from 'zod'
import { ValidationError } from '@/lib/core/types'
import { inferContext, resolveParty, resolveProject, resolveSeries } from '../../directory/resolve'
import {
  addNote,
  answerItem,
  completeItem,
  convertItem,
  createItem,
  dropItem,
  getItem,
  getThread,
  listItems,
  parkItem,
  recordDecision,
  reopenItem,
  setItemParties,
  setItemTarget,
  supersedeDecision,
  unparkItem,
  updateItem,
  type ItemTarget,
  type PartyRef,
} from '../../items/items'
import { itemTodoist, linkItem, sendItem, skipItem } from '../../connect/todoist/match'
import { getMeeting } from '../../meetings/meetings'
import { idempotencyKey, itemOut, partiesFrom, write } from './shared'
import { defineTool } from './types'

const kind = z.enum(['topic', 'question', 'action', 'decision'])

const KIND_RULE =
  'Kinds: topic (something to raise, discuss or report), question (an answer or a choice is ' +
  'owed; closes when it comes back), action (a named party owes a deliverable; closes when it ' +
  'is done), decision (something settled; a record, never open). What closes it decides between ' +
  'question and action.'

/* Where an item is to be raised. Undefined when neither field names anything. */
async function targetFrom(
  tx: Parameters<typeof resolveParty>[0],
  contextId: string,
  input: { target_meeting?: string | null; target_series?: string | null; target_project?: string | null },
): Promise<ItemTarget | undefined> {
  if ([input.target_meeting, input.target_series, input.target_project].filter(Boolean).length > 1) {
    throw new ValidationError('An item is aimed at one meeting, one series or one project, not more.')
  }
  // The item layer refuses a meeting that is in another context.
  if (input.target_meeting) return { meetingId: input.target_meeting }
  if (input.target_series) {
    return { seriesId: (await resolveSeries(tx, contextId, input.target_series)).id }
  }
  if (input.target_project) {
    return { projectId: (await resolveProject(tx, contextId, input.target_project)).id }
  }
  return undefined
}

async function refOf(
  tx: Parameters<typeof resolveParty>[0],
  contextId: string,
  ref: string,
): Promise<PartyRef> {
  const party = await resolveParty(tx, contextId, ref)
  return party.type === 'person' ? { personId: party.id } : { groupId: party.id }
}

export const captureItemTool = defineTool({
  name: 'capture_item',
  title: 'Capture an item',
  description:
    'Capture a topic, question, action or decision. Only text is required; with nothing else ' +
    `it lands in the Inbox as a topic. ${KIND_RULE} ` +
    'owners owe the action or answer; with is who to raise it with (on an item I own, who it ' +
    'is owed to). On a question, owners are who it is asked of and with is who asked; on a ' +
    'decision, owners are who decides. Several owners of an action are doing it together. "me" names the account holder. target_meeting, target_series or target_project aims it at ' +
    'one meeting, or at the next occurrence of a series, where prep places it on the agenda. ' +
    'from_meeting records the meeting it came out of: it is listed there and in its recap. ' +
    'The context is inferred from the project, the meetings, the target or a group when there is more than one. ' +
    'A name that matches nothing is refused by name: make it with create_person, create_group, ' +
    'create_project or create_series, then capture again.',
  scope: 'meetings:write',
  input: z.object({
    text: z.string().min(1).describe('One line, in the wording to keep.'),
    kind: kind.optional().describe('Defaults to topic.'),
    detail: z.string().optional(),
    context: z.string().optional().describe('Context name or id.'),
    project: z.string().optional().describe('Project name or id.'),
    owners: z.array(z.string()).optional().describe('People or groups, by name or id.'),
    with: z.array(z.string()).optional().describe('People or groups, by name or id.'),
    due_on: z.string().optional().describe('A deadline, YYYY-MM-DD.'),
    parent_item_id: z.uuid().optional().describe('The item this one came out of.'),
    from_meeting: z.uuid().optional().describe('Meeting id this came out of.'),
    target_meeting: z.uuid().optional().describe('Meeting id to raise this at.'),
    target_series: z
      .string()
      .min(1)
      .optional()
      .describe('Series name or id: raised at its next occurrence.'),
    target_project: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Project name or id: raised at the next meeting that carries it (or a project within it), ' +
          'waiting until there is one, until it is discussed.',
      ),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'capture_item', input, async (tx) => {
      const parent = input.parent_item_id ? await getItem(tx, input.parent_item_id) : null
      const meetingId = input.from_meeting ?? input.target_meeting
      const aimedAt =
        !parent && !input.context && meetingId ? await getMeeting(tx, meetingId) : null
      const contextId =
        parent?.contextId ??
        aimedAt?.contextId ??
        (
          await inferContext(tx, {
            context: input.context,
            project: input.project,
            series: input.target_series,
            parties: [...(input.owners ?? []), ...(input.with ?? [])],
          })
        ).id

      const project = input.project ? await resolveProject(tx, contextId, input.project) : null
      const target = await targetFrom(tx, contextId, input)

      const item = await createItem(tx, context.actor, {
        contextId,
        kind: input.kind,
        text: input.text,
        detail: input.detail,
        projectId: project?.id ?? null,
        dueOn: input.due_on,
        parties: await partiesFrom(tx, contextId, input),
        parentItemId: parent?.id ?? null,
        // The item layer refuses a meeting that is in another context.
        originMeetingId: input.from_meeting ?? null,
        target,
      })
      return { item: itemOut(item) }
    }),
})

export const listItemsTool = defineTool({
  name: 'list_items',
  title: 'List items',
  description:
    'Items in one context, open ones by default. Filter by kind, project, or a person or ' +
    'group (in either role, or one). inbox lists what has no party and no project yet.',
  scope: 'meetings:read',
  input: z.object({
    context: z.string().optional().describe('Context name or id. Needed when there are several.'),
    state: z.enum(['open', 'closed', 'all']).optional().describe('Defaults to open.'),
    kinds: z.array(kind).optional(),
    project: z.string().optional(),
    party: z.string().optional().describe('A person or group, by name or id. "me" is allowed.'),
    role: z.enum(['owner', 'with']).optional().describe('Only with party.'),
    inbox: z.boolean().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const context = await inferContext(exec, {
      context: input.context,
      project: input.project,
      parties: input.party ? [input.party] : [],
    })
    const project = input.project ? await resolveProject(exec, context.id, input.project) : null
    const party = input.party ? await refOf(exec, context.id, input.party) : null
    const state = input.state ?? 'open'

    const found = await listItems(exec, {
      contextId: context.id,
      open: state === 'all' ? undefined : state === 'open',
      kinds: input.kinds,
      projectId: project?.id,
      party: party ? { ...party, role: input.role } : undefined,
      inbox: input.inbox,
      search: input.search,
      limit: input.limit ?? 100,
    })
    return { context: { id: context.id, name: context.name }, items: found.map(itemOut) }
  },
})

export const getItemTool = defineTool({
  name: 'get_item',
  title: 'Get an item',
  description:
    'One item with the whole thread it belongs to (what it came from and what came out of it) ' +
    'and its history, what it waits on in Later (waits_on) and what waits on it (holds_up). ' +
    'todoist says where it stands with Todoist: its task (task_url), or that it has none yet.',
  scope: 'meetings:read',
  input: z.object({ id: z.uuid() }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const item = await getItem(exec, input.id)
    const thread = await getThread(exec, input.id)
    const waitsOn = item.laterUntilItemId ? await getItem(exec, item.laterUntilItemId) : null
    const holdsUp = await listItems(exec, { contextId: item.contextId, open: true, waitingOn: item.id })
    const brief = (one: typeof item) => ({ id: one.id, kind: one.kind, status: one.status, text: one.text })
    const todoist = await itemTodoist(exec, item.id)
    return {
      item: itemOut(item),
      ...(todoist
        ? {
            todoist:
              todoist.state === 'linked'
                ? { state: 'linked', task_url: todoist.url, ...(todoist.error ? { error: todoist.error } : {}) }
                : { state: todoist.state },
          }
        : {}),
      ...(waitsOn ? { waits_on: brief(waitsOn) } : {}),
      ...(holdsUp.length > 0 ? { holds_up: holdsUp.map(brief) } : {}),
      thread: thread.entries.map((entry) => ({ depth: entry.depth, ...itemOut(entry.item) })),
      history: thread.events.map((event) => ({
        item_id: event.itemId,
        type: event.type,
        at: event.createdAt.toISOString(),
        ...event.data,
      })),
    }
  },
})

export const updateItemTool = defineTool({
  name: 'update_item',
  title: 'Update an item',
  description:
    'Change an item: its wording, detail, project, deadline or parties; add a note; or close ' +
    'it. status done finishes a topic or action; a question closes by giving answer instead. ' +
    'status dropped abandons it and open reopens it. report_to raises the answer with another ' +
    'person or group as a new topic. owners and with each replace the whole list for that role ' +
    'when given. target_meeting, target_series or target_project aims it at a meeting or at the next occurrence ' +
    'of a series. later true parks it off "I owe" and "Waiting on" until later_on (or until ' +
    'brought back with later false); a deadline within two weeks brings it back regardless. ' +
    'later_until_item parks it until that open item in the same context closes (done, answered ' +
    'or dropped), or with later_on until whichever comes first; null stops it waiting on one. ' +
    'Pass null to clear project, due_on, detail or the target. todoist links an open action or ' +
    'question John owns to a Todoist task he already has (its id or link), "new" sends it as a ' +
    'new task, and "skip" keeps it out of Todoist.',
  scope: 'meetings:write',
  input: z.object({
    id: z.uuid(),
    text: z.string().min(1).optional(),
    detail: z.string().nullable().optional(),
    project: z.string().nullable().optional(),
    due_on: z.string().nullable().optional(),
    owners: z.array(z.string()).optional(),
    with: z.array(z.string()).optional(),
    note: z.string().optional().describe('Added to the item history.'),
    status: z.enum(['open', 'done', 'dropped']).optional(),
    answer: z.string().optional().describe('Closes a question with this answer.'),
    resolution: z.string().optional().describe('How a topic or action ended, with status done.'),
    report_to: z.string().optional().describe('Person or group to report the answer to.'),
    target_meeting: z.uuid().nullable().optional().describe('Meeting id to raise this at.'),
    target_series: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Series name or id: raised at its next occurrence.'),
    target_project: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Project name or id: raised at the next meeting that carries it.'),
    later: z.boolean().optional().describe('true parks it for later; false brings it back.'),
    later_on: z.string().optional().describe('YYYY-MM-DD it comes back on its own; implies later.'),
    later_until_item: z
      .uuid()
      .nullable()
      .optional()
      .describe('Item id it waits on: back when that item closes; implies later.'),
    todoist: z
      .string()
      .min(1)
      .optional()
      .describe('A Todoist task id or link to link it to, "new" or "skip".'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_item', input, async (tx) => {
      const { actor } = context
      const before = await getItem(tx, input.id)
      const contextId = before.contextId

      const project =
        input.project === undefined
          ? undefined
          : input.project === null
            ? null
            : (await resolveProject(tx, contextId, input.project)).id
      await updateItem(tx, actor, input.id, {
        text: input.text,
        detail: input.detail,
        projectId: project,
        dueOn: input.due_on,
      })

      if (input.owners !== undefined || input.with !== undefined) {
        const keep = (role: 'owner' | 'with') =>
          before.parties.filter((p) => p.role === role).map((p) => p.id)
        await setItemParties(
          tx,
          actor,
          input.id,
          await partiesFrom(tx, contextId, {
            owners: input.owners ?? keep('owner'),
            with: input.with ?? keep('with'),
          }),
        )
      }

      // An item has one target, so null on either field clears it.
      if (
        input.target_meeting !== undefined ||
        input.target_series !== undefined ||
        input.target_project !== undefined
      ) {
        const target = await targetFrom(tx, contextId, input)
        await setItemTarget(tx, actor, input.id, target ?? null)
      }

      if (input.note) await addNote(tx, actor, input.id, input.note)

      if (input.later === false) {
        if (input.later_on || input.later_until_item) {
          throw new ValidationError('later_on and later_until_item go with later true.')
        }
        await unparkItem(tx, actor, input.id)
      } else if (input.later || input.later_on || input.later_until_item) {
        await parkItem(tx, actor, input.id, { until: input.later_on, untilItem: input.later_until_item })
      } else if (input.later_until_item === null && before.parkedAt) {
        // Stops waiting on an item, and keeps its day.
        await parkItem(tx, actor, input.id, { until: before.laterOn, untilItem: null })
      }

      let report = null
      if (input.answer !== undefined) {
        const reportTo = input.report_to ? await refOf(tx, contextId, input.report_to) : null
        report = (await answerItem(tx, actor, input.id, { answer: input.answer, reportTo })).report
      } else if (input.report_to) {
        throw new ValidationError('report_to goes with answer.')
      } else if (input.status === 'done') {
        await completeItem(tx, actor, input.id, { resolution: input.resolution })
      } else if (input.status === 'dropped') {
        await dropItem(tx, actor, input.id)
      } else if (input.status === 'open') {
        await reopenItem(tx, actor, input.id)
      }

      if (input.todoist === 'new') await sendItem(tx, input.id)
      else if (input.todoist === 'skip') await skipItem(tx, input.id)
      else if (input.todoist) await linkItem(tx, { itemId: input.id, task: input.todoist })

      return {
        item: itemOut(await getItem(tx, input.id)),
        ...(report ? { report: itemOut(report) } : {}),
      }
    }),
})

export const convertItemTool = defineTool({
  name: 'convert_item',
  title: 'Convert an item',
  description:
    'Change what an item is. Between topic, question and action it converts in place and keeps ' +
    'its history. To decision it records a new, linked decision in its own wording (text is ' +
    'required) and leaves the original as it was; on a decision, it supersedes it with the new ' +
    `wording. ${KIND_RULE}`,
  scope: 'meetings:write',
  input: z.object({
    id: z.uuid(),
    to: kind,
    text: z.string().min(1).optional().describe('The decision, in its own wording.'),
    detail: z.string().optional(),
    report_to: z.string().optional().describe('Person or group to report the decision to.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'convert_item', input, async (tx) => {
      const { actor } = context
      if (input.to !== 'decision') {
        return { item: itemOut(await convertItem(tx, actor, input.id, input.to)) }
      }

      if (!input.text) {
        throw new ValidationError('A decision needs its own wording. Pass it as text.')
      }
      const source = await getItem(tx, input.id)

      if (source.kind === 'decision') {
        const replacement = await supersedeDecision(tx, actor, input.id, {
          text: input.text,
          detail: input.detail,
        })
        return { item: itemOut(replacement), superseded: itemOut(await getItem(tx, input.id)) }
      }

      const reportTo = input.report_to ? await refOf(tx, source.contextId, input.report_to) : null
      const { item, report } = await recordDecision(tx, actor, {
        fromItemId: input.id,
        text: input.text,
        detail: input.detail,
        reportTo,
      })
      return {
        item: itemOut(item),
        from: itemOut(await getItem(tx, input.id)),
        ...(report ? { report: itemOut(report) } : {}),
      }
    }),
})

export const itemTools = [
  captureItemTool,
  listItemsTool,
  getItemTool,
  updateItemTool,
  convertItemTool,
]
