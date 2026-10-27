/*
 * Breadcrumbs that follow the way you came: `from` on a link, checked against
 * the app's own pages, and the crumbs a page builds from it.
 */

import { describe, expect, it } from 'vitest'
import { createItem } from '../lib/items/items'
import { createMeeting } from '../lib/meetings/meetings'
import { createSeries } from '../lib/meetings/series'
import { crumbsFrom } from '../lib/web/crumbs'
import { parseFrom, withFrom } from '../lib/web/from'
import { db, resetBetweenTests } from './helpers/db'
import { actor, makeWorld } from './helpers/fixtures'

resetBetweenTests()

const ID = '0b6f4c1e-8a6b-4d7e-9f1a-2c3d4e5f6a7b'

describe('parseFrom', () => {
  it('takes the app’s own list and hub pages', () => {
    expect(parseFrom('/inbox')).toEqual({ type: 'section', path: '/inbox', label: 'Inbox' })
    expect(parseFrom('/meetings/past')).toEqual({ type: 'section', path: '/meetings/past', label: 'Meetings' })
    expect(parseFrom(`/people/${ID}`)).toEqual({ type: 'hub', path: `/people/${ID}`, kind: 'people', id: ID })
    expect(parseFrom(`/meetings/${ID}/recap`)).toEqual({
      type: 'meetingPage',
      path: `/meetings/${ID}/recap`,
      id: ID,
      page: 'recap',
    })
  })

  it('refuses anything else, so it can never lead off the site', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '/',
      ['/inbox', '/items'],
      'https://evil.example/people',
      '//evil.example',
      '/\\evil.example',
      '/inbox?x=1',
      '/inbox/',
      `/people/${ID}/extra`,
      '/people/not-an-id',
      `/settings`,
      `/api/open?to=/inbox`,
      `javascript:alert(1)`,
      `/people/${ID}\n`,
    ]) {
      expect(parseFrom(raw as string)).toBeNull()
    }
  })
})

describe('withFrom', () => {
  it('adds the current page to a link to a page that takes it', () => {
    expect(withFrom(`/items/${ID}`, `/people/${ID.replace('0b', '1c')}`)).toBe(
      `/items/${ID}?from=${encodeURIComponent(`/people/${ID.replace('0b', '1c')}`)}`,
    )
    expect(withFrom(`/meetings/${ID}#review`, '/inbox')).toBe(`/meetings/${ID}?from=%2Finbox#review`)
    // Keeps what the link already asks.
    expect(withFrom(`/projects/${ID}?all=1`, '/projects')).toBe(`/projects/${ID}?all=1&from=%2Fprojects`)
  })

  it('carries it through /api/open, on the page it goes to', () => {
    const href = `/api/open?${new URLSearchParams({ context: 'c', to: `/items/${ID}` })}`
    const out = new URL(withFrom(href, '/inbox'), 'https://x.test')
    expect(out.pathname).toBe('/api/open')
    expect(out.searchParams.get('context')).toBe('c')
    expect(out.searchParams.get('to')).toBe(`/items/${ID}?from=%2Finbox`)
  })

  it('leaves alone a link from home or an unknown page, to a list, or to the page itself', () => {
    expect(withFrom(`/items/${ID}`, '/')).toBe(`/items/${ID}`)
    expect(withFrom(`/items/${ID}`, '/settings')).toBe(`/items/${ID}`)
    expect(withFrom(`/items/${ID}`, null)).toBe(`/items/${ID}`)
    expect(withFrom('/inbox', `/people/${ID}`)).toBe('/inbox')
    expect(withFrom(`/people/${ID}`, `/people/${ID}`)).toBe(`/people/${ID}`)
  })
})

describe('crumbsFrom', () => {
  it('names the page it came from, looked up in the context of the page showing them', async () => {
    const { parish, diocese, sarah, staff, retreat, synod } = await makeWorld()
    const series = await createSeries(db, { contextId: parish.id, name: 'Staff meeting' })
    const meeting = await createMeeting(db, actor, { contextId: parish.id, title: 'Planning' })
    const session = await createMeeting(db, actor, {
      contextId: parish.id,
      parentMeetingId: meeting.id,
      title: 'Day one',
    })
    const item = await createItem(db, actor, { contextId: parish.id, kind: 'topic', text: 'Hall booking' })

    expect(await crumbsFrom(db, '/inbox', parish.id)).toEqual([{ href: '/inbox', label: 'Inbox' }])
    expect(await crumbsFrom(db, `/people/${sarah.id}`, parish.id)).toEqual([
      { href: '/people', label: 'People' },
      { href: `/people/${sarah.id}`, label: sarah.name },
    ])
    expect(await crumbsFrom(db, `/groups/${staff.id}`, parish.id)).toEqual([
      { href: '/groups', label: 'Groups' },
      { href: `/groups/${staff.id}`, label: 'Staff' },
    ])
    expect(await crumbsFrom(db, `/projects/${retreat.id}`, parish.id)).toEqual([
      { href: '/projects', label: 'Projects' },
      { href: `/projects/${retreat.id}`, label: 'Retreat' },
    ])
    expect(await crumbsFrom(db, `/series/${series.id}`, parish.id)).toEqual([
      { href: '/series', label: 'Series' },
      { href: `/series/${series.id}`, label: 'Staff meeting' },
    ])
    expect(await crumbsFrom(db, `/items/${item.id}`, parish.id)).toEqual([
      { href: '/items', label: 'Items' },
      { href: `/items/${item.id}`, label: 'Hall booking' },
    ])
    expect(await crumbsFrom(db, `/meetings/${session.id}/recap`, parish.id)).toEqual([
      { href: '/meetings', label: 'Meetings' },
      { href: `/meetings/${meeting.id}`, label: 'Planning' },
      { href: `/meetings/${session.id}`, label: 'Day one' },
      { href: `/meetings/${session.id}/recap`, label: 'Recap' },
    ])

    // Another context's page, one that is gone, or none at all: the page falls back to where it lives.
    expect(await crumbsFrom(db, `/projects/${synod.id}`, parish.id)).toBeNull()
    expect(await crumbsFrom(db, `/meetings/${meeting.id}`, diocese.id)).toBeNull()
    expect(await crumbsFrom(db, `/people/${ID}`, parish.id)).toBeNull()
    expect(await crumbsFrom(db, undefined, parish.id)).toBeNull()
    expect(await crumbsFrom(db, 'https://evil.example', parish.id)).toBeNull()
  })
})
