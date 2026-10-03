/* Contexts, people, groups and projects: enough to capture against by name. */

import { z } from 'zod'
import { archive, unarchive } from '../../archive/archive'
import { ValidationError, type Executor } from '@/lib/core/types'
import { isUuid, matchName } from '../../core/match'
import { createContext, listContexts } from '../../directory/contexts'
import {
  addGroupEmail,
  addMember,
  createGroup,
  getGroup,
  listGroupEmails,
  listGroups,
  listMembers,
  renameGroup,
  setGroupEmails,
} from '../../directory/groups'
import { createPerson, listPeople, setPersonEmails, updatePerson } from '../../directory/people'
import { inferContext, resolveGroup, resolvePerson, resolveProject } from '../../directory/resolve'
import { openCounts } from '../../items/items'
import {
  addMilestone,
  createProject,
  listMilestones,
  listProjects,
  updateProject,
} from '../../projects/projects'
import { idempotencyKey, write } from './shared'
import { defineTool } from './types'

const contextArg = z
  .string()
  .optional()
  .describe('Context name or id. Needed when there are several.')

export const listContextsTool = defineTool({
  name: 'list_contexts',
  title: 'List contexts',
  description:
    'The separate working contexts. Projects, groups and items each belong to exactly one.',
  scope: 'meetings:read',
  input: z.object({}),
  annotations: { readOnlyHint: true },
  handler: async (_input, { exec }) => ({
    contexts: (await listContexts(exec)).map((c) => ({ id: c.id, name: c.name })),
  }),
})

export const createContextTool = defineTool({
  name: 'create_context',
  title: 'Create a context',
  description: 'Add a working context.',
  scope: 'meetings:write',
  input: z.object({ name: z.string().min(1), idempotency_key: idempotencyKey }),
  handler: async (input, context) =>
    write(context, 'create_context', input, async (tx) => {
      const created = await createContext(tx, { name: input.name })
      return { context: { id: created.id, name: created.name } }
    }),
})

export const listPeopleTool = defineTool({
  name: 'list_people',
  title: 'List people',
  description: 'Everyone in the directory. People are shared by all contexts.',
  scope: 'meetings:read',
  input: z.object({ search: z.string().optional() }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const all = await listPeople(exec)
    const found = input.search ? matchName(all, input.search) : all
    return {
      people: found.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        emails: p.emails,
        ...(p.isSelf ? { is_me: true } : {}),
      })),
    }
  },
})

export const createPersonTool = defineTool({
  name: 'create_person',
  title: 'Add a person',
  description: 'Add someone to the directory. Check list_people first to avoid a duplicate.',
  scope: 'meetings:write',
  input: z.object({
    name: z.string().min(1),
    email: z.string().optional(),
    emails: z.array(z.string()).optional().describe('Every address they use; the first is primary.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'create_person', input, async (tx) => {
      const person = await createPerson(tx, { name: input.name, email: input.email, emails: input.emails })
      return { person: { id: person.id, name: person.name, email: person.email, emails: person.emails } }
    }),
})

export const updatePersonTool = defineTool({
  name: 'update_person',
  title: 'Update a person',
  description:
    'Rename someone, or set their email addresses (the whole list, primary first). An address ' +
    'already on someone else is refused with their name.',
  scope: 'meetings:write',
  input: z.object({
    person: z.string().min(1).describe('Person name or id.'),
    name: z.string().min(1).optional(),
    emails: z.array(z.string()).optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_person', input, async (tx) => {
      const { id } = await resolvePerson(tx, input.person)
      if (input.emails) await setPersonEmails(tx, id, input.emails)
      const person = await updatePerson(tx, id, { name: input.name })
      return { person: { id: person.id, name: person.name, email: person.email, emails: person.emails } }
    }),
})

export const listGroupsTool = defineTool({
  name: 'list_groups',
  title: 'List groups',
  description: 'The groups in a context, with their members.',
  scope: 'meetings:read',
  input: z.object({ context: contextArg }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const context = await inferContext(exec, { context: input.context })
    const found = await listGroups(exec, context.id)
    return {
      context: { id: context.id, name: context.name },
      groups: await Promise.all(
        found.map(async (g) => ({
          id: g.id,
          name: g.name,
          members: (await listMembers(exec, g.id)).map((m) => ({ id: m.id, name: m.name })),
          emails: await listGroupEmails(exec, g.id),
        })),
      ),
    }
  },
})

export const createGroupTool = defineTool({
  name: 'create_group',
  title: 'Create a group',
  description:
    'Add a group to a context, optionally with members (people by name or id) and the ' +
    'addresses of its distribution list: an invitee at one brings the group to the meeting.',
  scope: 'meetings:write',
  input: z.object({
    name: z.string().min(1),
    context: contextArg,
    members: z.array(z.string()).optional(),
    emails: z.array(z.string().min(3)).optional().describe("The group's list addresses."),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'create_group', input, async (tx) => {
      const target = await inferContext(tx, { context: input.context })
      const group = await createGroup(tx, { contextId: target.id, name: input.name })

      const everyone = await listPeople(tx)
      for (const ref of input.members ?? []) {
        const matches = isUuid(ref) ? everyone.filter((p) => p.id === ref) : matchName(everyone, ref)
        if (matches.length !== 1) {
          throw new ValidationError(
            matches.length === 0
              ? `No person matches ${ref}.`
              : `${ref} could be ${matches.map((p) => p.name).join(', ')}. Be more specific.`,
          )
        }
        await addMember(tx, group.id, matches[0]!.id)
      }
      for (const email of input.emails ?? []) await addGroupEmail(tx, group.id, email)

      return { group: await groupOut(tx, group.id) }
    }),
})

async function groupOut(exec: Executor, id: string) {
  const group = await getGroup(exec, id)
  return {
    id: group.id,
    name: group.name,
    members: (await listMembers(exec, id)).map((m) => ({ id: m.id, name: m.name })),
    emails: await listGroupEmails(exec, id),
  }
}

export const updateGroupTool = defineTool({
  name: 'update_group',
  title: 'Update a group',
  description:
    'Rename a group, or set its list addresses (emails replaces them all). Members are ' +
    'changed on screen.',
  scope: 'meetings:write',
  input: z.object({
    group: z.string().min(1).describe('Group name or id.'),
    context: contextArg,
    name: z.string().min(1).optional(),
    emails: z.array(z.string().min(3)).optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_group', input, async (tx) => {
      const target = await inferContext(tx, { context: input.context, parties: [input.group] })
      const { id } = await resolveGroup(tx, target.id, input.group)
      if (input.name) await renameGroup(tx, id, input.name)
      if (input.emails) await setGroupEmails(tx, id, input.emails)
      return { group: await groupOut(tx, id) }
    }),
})

export const listProjectsTool = defineTool({
  name: 'list_projects',
  title: 'List projects',
  description: 'The projects in a context, with their status, milestones and open item count.',
  scope: 'meetings:read',
  input: z.object({ context: contextArg }),
  annotations: { readOnlyHint: true },
  handler: async (input, { exec }) => {
    const context = await inferContext(exec, { context: input.context })
    const counts = await openCounts(exec, context.id)
    const found = await listProjects(exec, context.id)
    return {
      context: { id: context.id, name: context.name },
      projects: await Promise.all(
        found.map(async (p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          description: p.description,
          parent_id: p.parentId,
          open_items: counts.byProject.get(p.id) ?? 0,
          milestones: (await listMilestones(exec, p.id)).map((m) => ({
            id: m.id,
            title: m.title,
            due_on: m.dueOn,
          })),
        })),
      ),
    }
  },
})

export const createProjectTool = defineTool({
  name: 'create_project',
  title: 'Create a project',
  description: 'Add a project to a context, optionally within another project there.',
  scope: 'meetings:write',
  input: z.object({
    name: z.string().min(1),
    context: contextArg,
    description: z.string().optional(),
    parent: z.string().optional().describe('The project it sits within: name, path ("AC2027/Worship") or id.'),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'create_project', input, async (tx) => {
      const target = await inferContext(tx, { context: input.context })
      const parent = input.parent ? await resolveProject(tx, target.id, input.parent) : null
      const project = await createProject(tx, {
        contextId: target.id,
        name: input.name,
        description: input.description,
        parentId: parent?.id ?? null,
      })
      return { project: { id: project.id, name: project.name, status: project.status, parent_id: project.parentId } }
    }),
})

export const updateProjectTool = defineTool({
  name: 'update_project',
  title: 'Update a project',
  description:
    'Rename a project, change its description or status, move it within another project ' +
    '(parent; null takes it to the top), or add a milestone to it.',
  scope: 'meetings:write',
  input: z.object({
    project: z.string().describe('Project name or id.'),
    context: contextArg,
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: z.enum(['active', 'paused', 'done']).optional(),
    parent: z.string().nullable().optional().describe('The project it sits within, or null for none.'),
    add_milestone: z
      .object({ title: z.string().min(1), due_on: z.string().optional() })
      .optional(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'update_project', input, async (tx) => {
      const target = await inferContext(tx, { context: input.context, project: input.project })
      const { id } = await resolveProject(tx, target.id, input.project)

      const parentId =
        input.parent === undefined
          ? undefined
          : input.parent === null
            ? null
            : (await resolveProject(tx, target.id, input.parent)).id
      const project = await updateProject(tx, id, {
        name: input.name,
        description: input.description,
        status: input.status,
        parentId,
      })
      if (input.add_milestone) {
        await addMilestone(tx, {
          projectId: id,
          title: input.add_milestone.title,
          dueOn: input.add_milestone.due_on,
        })
      }

      return {
        project: {
          id: project.id,
          name: project.name,
          status: project.status,
          description: project.description,
          milestones: (await listMilestones(tx, id)).map((m) => ({
            id: m.id,
            title: m.title,
            due_on: m.dueOn,
          })),
        },
      }
    }),
})

export const setArchivedTool = defineTool({
  name: 'set_archived',
  title: 'Archive or restore',
  description:
    'Archive a context, person, group, project, series or meeting, or bring one back. Archived, ' +
    'it leaves every list and name lookup, but what points at it still reads it. Deleting is ' +
    'done on screen only. An item is put away by closing it instead.',
  scope: 'meetings:write',
  input: z.object({
    kind: z.enum(['context', 'person', 'group', 'project', 'series', 'meeting']),
    id: z.uuid(),
    archived: z.boolean(),
    idempotency_key: idempotencyKey,
  }),
  handler: async (input, context) =>
    write(context, 'set_archived', input, async (tx) => {
      if (input.archived) await archive(tx, input.kind, input.id)
      else await unarchive(tx, input.kind, input.id)
      return { kind: input.kind, id: input.id, archived: input.archived }
    }),
})

export const directoryTools = [
  listContextsTool,
  createContextTool,
  listPeopleTool,
  createPersonTool,
  updatePersonTool,
  listGroupsTool,
  createGroupTool,
  updateGroupTool,
  listProjectsTool,
  createProjectTool,
  updateProjectTool,
  setArchivedTool,
]
