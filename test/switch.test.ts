import { describe, expect, it } from 'vitest'
import { switchTarget } from '../lib/web/switch'

const ID = '0b9f4a52-5d6e-4c1a-9f3e-2a7b8c9d0e1f'

describe('switching context', () => {
  it('stays on a page that reads the selected context', () => {
    for (const path of ['/', '/projects', '/groups', '/series', '/meetings', '/meetings/past', '/inbox', '/settings', `/people/${ID}`]) {
      expect(switchTarget(path)).toBe(path)
    }
    expect(switchTarget('/projects/?x=1')).toBe('/projects')
  })

  it("leaves a record of the old context for the list it sits in", () => {
    expect(switchTarget(`/projects/${ID}`)).toBe('/projects')
    expect(switchTarget(`/groups/${ID}`)).toBe('/groups')
    expect(switchTarget(`/series/${ID}`)).toBe('/series')
    expect(switchTarget(`/meetings/${ID}/review`)).toBe('/meetings')
    expect(switchTarget(`/items/${ID}`)).toBe('/')
  })

  it('goes nowhere but the app', () => {
    expect(switchTarget('//example.com')).toBe('/')
    expect(switchTarget('https://example.com/projects')).toBe('/')
  })
})
