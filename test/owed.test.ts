/*
 * Who owes what (docs/SPEC.md, "Who owes what", issue #47) and where an item
 * stands between John and someone (prep's suggestions, issue #53). Pure.
 */

import { describe, expect, it } from 'vitest'
import { iOwe, isOwed, isWaitingOn, owersOf, owes } from '../lib/items/horizon'
import type { ItemKind, ItemParty, ItemView } from '../lib/items/items'
import { byStance, stanceOf } from '../lib/items/roles'

const person = (id: string, role: ItemParty['role'], isSelf = false): ItemParty => ({
  type: 'person',
  id,
  name: id,
  role,
  isSelf,
})
const me = (role: ItemParty['role']) => person('john', role, true)
const adlene = (role: ItemParty['role']) => person('adlene', role)
const faith = (role: ItemParty['role']) => person('faith', role)

const item = (kind: ItemKind, parties: ItemParty[], extra: Partial<ItemView> = {}) =>
  ({
    id: `${kind}-${parties.map((p) => `${p.id}:${p.role}`).join(',')}`,
    kind,
    status: kind === 'question' ? 'needs_answer' : 'open',
    ongoing: false,
    parties,
    ...extra,
  }) as ItemView

describe('who owes what', () => {
  it('a topic someone else raises is owed by them alone, never by a collaborator', () => {
    const topic = item('topic', [adlene('owner'), faith('owner'), me('with')])
    expect(isOwed(topic)).toBe(true)
    expect(owersOf(topic).map((p) => p.id)).toEqual(['adlene'])
    expect(owes(topic, 'faith')).toBe(false)
    expect(isWaitingOn(topic)).toBe(true)
  })

  it('a topic John raises is owed by nobody, his collaborator included', () => {
    // Me, together with Adlene, raising it with Faith.
    const topic = item('topic', [me('owner'), adlene('owner'), faith('with')])
    expect(isOwed(topic)).toBe(false)
    expect(owersOf(topic)).toEqual([])
    expect(owes(topic, 'adlene')).toBe(false)
    expect(iOwe(topic)).toBe(false)
    expect(isWaitingOn(topic)).toBe(false)
  })

  it('a topic nobody raises is owed by nobody', () => {
    expect(isOwed(item('topic', [adlene('with')]))).toBe(false)
    expect(isOwed(item('topic', []))).toBe(false)
  })

  it('an action is owed by every owner, a collaborator too; a question by its owners unless ongoing', () => {
    const action = item('action', [adlene('owner'), me('owner'), faith('with')])
    expect(owersOf(action).map((p) => p.id)).toEqual(['adlene', 'john'])
    expect(iOwe(action)).toBe(true)
    expect(isWaitingOn(action)).toBe(false)

    const question = item('question', [adlene('owner')])
    expect(owes(question, 'adlene')).toBe(true)
    expect(isWaitingOn(question)).toBe(true)
    const ongoing = item('question', [adlene('owner')], { ongoing: true })
    expect(isOwed(ongoing)).toBe(false)
    expect(owersOf(ongoing)).toEqual([])
  })

  it('an action nobody is named on yet is owed, by no one in particular', () => {
    const action = item('action', [])
    expect(isOwed(action)).toBe(true)
    expect(owersOf(action)).toEqual([])
  })
})

describe('where an item stands between John and someone', () => {
  it('reads each kind from both sides', () => {
    // Hers to bring me.
    expect(stanceOf(item('action', [adlene('owner'), me('with')]), 'adlene')).toBe('theirs')
    expect(stanceOf(item('action', [adlene('owner')]), 'adlene')).toBe('theirs')
    expect(stanceOf(item('question', [adlene('owner')]), 'adlene')).toBe('theirs')
    expect(stanceOf(item('topic', [adlene('owner'), me('with')]), 'adlene')).toBe('theirs')
    // Mine to bring her.
    expect(stanceOf(item('action', [me('owner'), adlene('with')]), 'adlene')).toBe('mine')
    expect(stanceOf(item('question', [me('owner'), adlene('with')]), 'adlene')).toBe('mine')
    expect(stanceOf(item('topic', [me('owner'), adlene('with')]), 'adlene')).toBe('mine')
    expect(stanceOf(item('topic', [adlene('with')]), 'adlene')).toBe('mine')
    // Hers for someone else: she reports back.
    expect(stanceOf(item('topic', [adlene('owner'), faith('with')]), 'adlene')).toBe('elsewhere')
    expect(stanceOf(item('action', [adlene('owner'), faith('with')]), 'adlene')).toBe('elsewhere')
    expect(stanceOf(item('question', [adlene('owner'), faith('with')]), 'adlene')).toBe('elsewhere')
    // Together, or to talk over.
    expect(stanceOf(item('topic', [me('owner'), adlene('owner'), faith('with')]), 'adlene')).toBe('together')
    expect(stanceOf(item('topic', [adlene('owner'), me('owner'), faith('with')]), 'adlene')).toBe('together')
    expect(stanceOf(item('topic', [faith('owner'), adlene('owner'), me('with')]), 'adlene')).toBe('together')
    expect(stanceOf(item('action', [faith('owner'), adlene('with')]), 'adlene')).toBe('together')
  })

  it('a group is read the same as a person', () => {
    const staff: ItemParty = { type: 'group', id: 'staff', name: 'Staff', role: 'owner', isSelf: false }
    expect(stanceOf(item('action', [staff]), 'staff')).toBe('theirs')
    expect(stanceOf(item('action', [me('owner'), { ...staff, role: 'with' }]), 'staff')).toBe('mine')
  })

  it('groups a list in stance order, keeping each run in the order it came, and leaves out empty runs', () => {
    const together = item('topic', [me('owner'), adlene('owner'), faith('with')])
    const mine1 = item('action', [me('owner'), adlene('with')])
    const theirs = item('action', [adlene('owner')])
    const mine2 = item('topic', [adlene('with')])
    const bands = byStance([together, mine1, theirs, mine2], 'adlene')
    expect(bands.map((band) => [band.stance, band.items.map((one) => one.id)])).toEqual([
      ['theirs', [theirs.id]],
      ['mine', [mine1.id, mine2.id]],
      ['together', [together.id]],
    ])
  })
})
