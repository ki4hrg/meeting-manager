import { describe, expect, it } from 'vitest'
import { matchName, tokenFor } from '../lib/core/match'
import { inferContext, resolveGroup, resolvePerson, resolveProject, resolveSeries } from '../lib/directory/resolve'
import { captureLine, parseLine, type NewMention } from '../lib/items/capture'
import { createMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

describe('parseLine', () => {
  it('reads the prefix, mentions and project', () => {
    const parsed = parseLine('q: what is the menu @sarah @Tom-Baker #retreat')
    expect(parsed.kind).toBe('question')
    expect(parsed.mentions).toEqual(['sarah', 'Tom-Baker'])
    expect(parsed.projects).toEqual(['retreat'])
  })

  it('reads a >series only for quick-add', () => {
    expect(parseLine('ask about it >Adlene-John', { series: true }).series).toEqual(['Adlene-John'])
    // In a note's verbatim lines a > is part of what was written.
    const verbatim = parseLine('ask about it >Adlene-John')
    expect(verbatim.series).toEqual([])
    expect(verbatim.words.at(-1)).toEqual({ type: 'text', value: '>Adlene-John' })
  })

  it('leaves an email address and a bare line alone', () => {
    const parsed = parseLine('write to sarah@example.test about #1')
    expect(parsed.kind).toBeNull()
    expect(parsed.mentions).toEqual([])
    expect(parsed.projects).toEqual(['1'])
  })
})

describe('matchName', () => {
  const names = [{ name: 'Sarah Jones' }, { name: 'Sara Smith' }, { name: 'Staff' }]

  it('prefers an exact name, then any word prefix', () => {
    expect(matchName(names, 'sarah')).toEqual([{ name: 'Sarah Jones' }])
    expect(matchName(names, 'sar')).toHaveLength(2)
    expect(matchName(names, 'jones')).toEqual([{ name: 'Sarah Jones' }])
    expect(matchName(names, tokenFor('Sarah Jones'))).toEqual([{ name: 'Sarah Jones' }])
    // From a later word on, across words: what a series is called by.
    expect(matchName([{ name: 'Adlene/John Check-In' }], 'check-in')).toEqual([{ name: 'Adlene/John Check-In' }])
    expect(matchName([{ name: 'Adlene/John Check-In' }], 'johncheck')).toHaveLength(1)
  })
})

describe('captureLine', () => {
  it('captures a bare line as an inbox topic', async () => {
    const { parish } = await makeWorld()
    const item = await captureLine(db, actor, { contextId: parish.id, line: 'Look at the roof' })
    expect(item).toMatchObject({ kind: 'topic', text: 'Look at the roof', parties: [], project: null })
  })

  it('raises a topic with the person named, keeping the name in the sentence', async () => {
    const { parish, bishop } = await makeWorld()
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'ask @bishop about the hall',
    })
    expect(item.text).toBe('ask Bishop Wright about the hall')
    expect(item.parties).toMatchObject([{ id: bishop.id, role: 'with' }])
  })

  it('makes those named the owners of a question, and drops trailing tags', async () => {
    const { parish, sarah, tom, retreat } = await makeWorld()
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'Q: What is the lunch menu? @sarah @tom #retreat',
    })
    expect(item).toMatchObject({ kind: 'question', text: 'What is the lunch menu?' })
    expect(item.project?.id).toBe(retreat.id)
    expect(item.parties.map((p) => [p.id, p.role])).toEqual([
      [sarah.id, 'owner'],
      [tom.id, 'owner'],
    ])
  })

  it('makes John the owner and the other party who it is owed to', async () => {
    const { parish, john, staff } = await makeWorld()
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'A: send the revised budget @me @staff',
    })
    expect(item.parties.map((p) => [p.id, p.role])).toEqual([
      [john.id, 'owner'],
      [staff.id, 'with'],
    ])
  })

  it('records a decision as decided', async () => {
    const { parish } = await makeWorld()
    const item = await captureLine(db, actor, { contextId: parish.id, line: 'D: The retreat moves to May' })
    expect(item).toMatchObject({ kind: 'decision', status: 'decided' })
  })

  it('refuses an unknown or ambiguous name, and a group from another context', async () => {
    const { parish } = await makeWorld()
    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'hello @nobody' }),
    ).rejects.toThrow('No person, group, project or series matches nobody')
    // Tom Baker and Bishop Wright both have a word starting with "b".
    await expect(captureLine(db, actor, { contextId: parish.id, line: 'hello @b' })).rejects.toThrow(
      'could be',
    )
    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'hello @council' }),
    ).rejects.toThrow('No person, group, project or series matches council')
    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'hello #synod' }),
    ).rejects.toThrow('No project matches synod')
  })

  it('raises an item at a series with >, and only there', async () => {
    const { parish, sarah } = await makeWorld()
    const checkIn = await createSeries(db, { contextId: parish.id, name: 'Sarah/John Check-In', personIds: [sarah.id] })
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'accountability process @sarah >check-in',
    })
    expect(item).toMatchObject({ text: 'accountability process', targetSeriesId: checkIn.id, targetMeetingId: null })
    expect(item.parties).toMatchObject([{ id: sarah.id, role: 'with' }])

    // Over the meeting a line was captured on, too.
    const meeting = await createMeeting(db, actor, { contextId: parish.id, title: 'Staff' })
    const there = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'later >check-in',
      presets: { targetMeetingId: meeting.id },
    })
    expect(there).toMatchObject({ targetSeriesId: checkIn.id, targetMeetingId: null })

    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'D: settled >check-in' }),
    ).rejects.toThrow('not something to raise')
    await expect(captureLine(db, actor, { contextId: parish.id, line: 'x >nothing' })).rejects.toThrow(
      'No series matches',
    )
  })

  it('records an outcome as coming out of its meeting, not raised there', async () => {
    const { parish, diocese, sarah } = await makeWorld()
    const meeting = await createMeeting(db, actor, { contextId: parish.id, title: 'Staff' })
    const action = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'send the minutes @sarah',
      presets: { kind: 'action', originMeetingId: meeting.id },
    })
    expect(action).toMatchObject({ kind: 'action', originMeetingId: meeting.id, targetMeetingId: null })
    expect(action.parties).toMatchObject([{ id: sarah.id, role: 'owner' }])

    const decision = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'D: lunch is at noon',
      presets: { kind: 'action', originMeetingId: meeting.id },
    })
    expect(decision).toMatchObject({ kind: 'decision', originMeetingId: meeting.id })

    // Still raised at a series when one is named.
    const checkIn = await createSeries(db, { contextId: parish.id, name: 'Sarah/John Check-In', personIds: [sarah.id] })
    const later = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'Q: who books the hall? >check-in',
      presets: { originMeetingId: meeting.id },
    })
    expect(later).toMatchObject({ originMeetingId: meeting.id, targetSeriesId: checkIn.id })

    // A meeting in another context is refused.
    const elsewhere = await createMeeting(db, actor, { contextId: diocese.id, title: 'Council' })
    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'x', presets: { originMeetingId: elsewhere.id } }),
    ).rejects.toThrow('another context')
  })

  it('takes one @ for a person, a project or a series, people first', async () => {
    const { parish, sarah, retreat } = await makeWorld()
    const checkIn = await createSeries(db, { contextId: parish.id, name: 'Sarah/John Check-In', personIds: [sarah.id] })
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'budget for @retreat lunch @sarah @check-in',
    })
    expect(item).toMatchObject({ text: 'budget for Retreat lunch', targetSeriesId: checkIn.id })
    expect(item.project?.id).toBe(retreat.id)
    expect(item.parties).toMatchObject([{ id: sarah.id, role: 'with' }])

    // "sarah" starts the series' name too, but a person comes first.
    const plain = await captureLine(db, actor, { contextId: parish.id, line: 'lunch @sarah' })
    expect(plain).toMatchObject({ targetSeriesId: null })
    expect(plain.parties).toMatchObject([{ id: sarah.id }])

    await expect(
      captureLine(db, actor, { contextId: parish.id, line: 'x @retreat @campaign' }),
    ).rejects.toThrow('one project')
  })

  it('makes a person or a group picked as new, in the same go as the item', async () => {
    const { parish } = await makeWorld()
    const question = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'Q: budget timing @Pat-Smith',
      create: [{ token: '@Pat-Smith', type: 'person', name: 'Pat Smith' }],
    })
    const pat = await resolvePerson(db, 'Pat Smith')
    expect(question).toMatchObject({ kind: 'question', text: 'budget timing' })
    expect(question.parties).toMatchObject([{ id: pat.id, name: 'Pat Smith', role: 'owner' }])

    const topic = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'ask @Choir-Parents about robes',
      create: [{ token: '@Choir-Parents', type: 'group', name: 'Choir parents' }],
    })
    const choir = await resolveGroup(db, parish.id, 'Choir parents')
    expect(topic).toMatchObject({ text: 'ask Choir parents about robes' })
    expect(topic.parties).toMatchObject([{ id: choir.id, role: 'with' }])
  })

  it('makes a project or a series picked as new, in the selected context', async () => {
    const { parish, diocese } = await makeWorld()
    const onProject = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'order chairs #Hall-Refit',
      create: [{ token: '#Hall-Refit', type: 'project', name: 'Hall refit' }],
    })
    const hall = await resolveProject(db, parish.id, 'Hall refit')
    expect(onProject.project?.id).toBe(hall.id)
    await expect(resolveProject(db, diocese.id, 'Hall refit')).rejects.toThrow('No project matches')

    const raised = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'review the rota >Wardens',
      create: [{ token: '>Wardens', type: 'series', name: 'Wardens' }],
    })
    const wardens = await resolveSeries(db, parish.id, 'Wardens')
    expect(raised).toMatchObject({ targetSeriesId: wardens.id, targetMeetingId: null })
  })

  it('makes nothing when the line is refused, or the new name is taken', async () => {
    const { parish } = await makeWorld()
    // Refused for something else: Pat Smith is not made either.
    await expect(
      captureLine(db, actor, {
        contextId: parish.id,
        line: 'x @Pat-Smith @nobody',
        create: [{ token: '@Pat-Smith', type: 'person', name: 'Pat Smith' }],
      }),
    ).rejects.toThrow('matches nobody')
    await expect(resolvePerson(db, 'Pat Smith')).rejects.toThrow('No person matches')

    // Typed in full and not picked: refused as unknown, as before.
    await expect(captureLine(db, actor, { contextId: parish.id, line: 'x @Pat-Smith' })).rejects.toThrow(
      'matches Pat-Smith',
    )

    const taken: Array<[NewMention, string]> = [
      [{ token: '@Sarah', type: 'person', name: 'sarah jones' }, 'already a person called sarah jones'],
      [{ token: '@Staffing', type: 'group', name: 'Staff' }, 'already a group called Staff'],
      [{ token: '#Retreats', type: 'project', name: 'retreat' }, 'already a project called retreat'],
    ]
    for (const [one, message] of taken) {
      // Pat Smith is made first, and goes with the line.
      const pat: NewMention = { token: '@Pat-Smith', type: 'person', name: 'Pat Smith' }
      await expect(
        captureLine(db, actor, { contextId: parish.id, line: `x @Pat-Smith ${one.token}`, create: [pat, one] }),
      ).rejects.toThrow(message)
    }
    await createSeries(db, { contextId: parish.id, name: 'Wardens' })
    await expect(
      captureLine(db, actor, {
        contextId: parish.id,
        line: 'x >Warden',
        create: [{ token: '>Warden', type: 'series', name: 'wardens' }],
      }),
    ).rejects.toThrow('already a series called wardens')
    await expect(resolvePerson(db, 'Pat Smith')).rejects.toThrow('No person matches')

    // A token can only be new as what its sigil names.
    await expect(
      captureLine(db, actor, {
        contextId: parish.id,
        line: 'x #Thing',
        create: [{ token: '#Thing', type: 'person', name: 'Thing' }],
      }),
    ).rejects.toThrow('cannot be a new person')
  })

  it('applies presets, and lets the line override the kind', async () => {
    const { parish, john, sarah, retreat } = await makeWorld()
    const item = await captureLine(db, actor, {
      contextId: parish.id,
      line: 'q: when is the deposit due',
      presets: {
        kind: 'action',
        projectId: retreat.id,
        parties: [
          { personId: john.id, role: 'owner' },
          { personId: sarah.id, role: 'with' },
        ],
      },
    })
    expect(item.kind).toBe('question')
    expect(item.project?.id).toBe(retreat.id)
    expect(item.parties.map((p) => p.role)).toEqual(['owner', 'with'])
  })
})

describe('inferContext', () => {
  it('finds the context from a project or group name, or asks', async () => {
    const { diocese, parish } = await makeWorld()
    expect((await inferContext(db, { project: 'synod' })).id).toBe(diocese.id)
    expect((await inferContext(db, { parties: ['sarah', 'staff'] })).id).toBe(parish.id)
    expect((await inferContext(db, { context: 'par' })).id).toBe(parish.id)
    await expect(inferContext(db, { parties: ['sarah'] })).rejects.toThrow('Parish, Diocese')
  })
})

describe('capture on a hub or a meeting', () => {
  it("raises what is added on a series' page at its next occurrence, but not a decision", async () => {
    const w = await makeWorld()
    const staff = await createSeries(db, { contextId: w.parish.id, name: 'Staff' })
    const item = await captureLine(db, actor, { contextId: w.parish.id, line: 'Q: who opens up', presets: { targetSeriesId: staff.id } })
    expect(item).toMatchObject({ kind: 'question', targetSeriesId: staff.id })
    await expect(
      captureLine(db, actor, { contextId: w.parish.id, line: 'D: we open at nine', presets: { targetSeriesId: staff.id } }),
    ).rejects.toThrow('not something to raise')
  })

  it('puts what is added on a meeting about one project on that project, unless the line names another', async () => {
    const w = await makeWorld()
    const one = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Retreat planning', projectIds: [w.retreat.id] })
    const session = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Breakout', parentMeetingId: one.id })
    const two = await createMeeting(db, actor, { contextId: w.parish.id, title: 'Both', projectIds: [w.retreat.id, w.campaign.id] })

    const add = (line: string, presets: object) => captureLine(db, actor, { contextId: w.parish.id, line, presets })
    expect((await add('Q: where do we stay', { targetMeetingId: one.id })).project?.id).toBe(w.retreat.id)
    expect((await add('A: book the house', { originMeetingId: one.id })).project?.id).toBe(w.retreat.id)
    expect((await add('Q: who leads it', { targetMeetingId: session.id })).project?.id).toBe(w.retreat.id)
    expect((await add('Q: the pledge cards #Capital-campaign', { targetMeetingId: one.id })).project?.id).toBe(w.campaign.id)
    expect((await add('Q: which comes first', { targetMeetingId: two.id })).project).toBeNull()
  })
})
