import { describe, expect, it } from 'vitest'
import { granolaNoteUrl, splitGranolaLinks } from '../lib/connect/granola/links'

const ID = '66c70ad5-1b2c-4d3e-8f90-123456789abc'

describe('Granola note links', () => {
  it('builds the note URL from its id', () => {
    expect(granolaNoteUrl(ID)).toBe(`https://notes.granola.ai/d/${ID}`)
  })

  it('takes a labelled link out of the detail', () => {
    expect(
      splitGranolaLinks(`From the Oct 13 Adlene/John check-in. Granola: https://notes.granola.ai/d/${ID}`),
    ).toEqual({ text: 'From the Oct 13 Adlene/John check-in.', ids: [ID] })
  })

  it('takes out Markdown links and autolinks, once per note', () => {
    const { text, ids } = splitGranolaLinks(
      `See [the note](https://notes.granola.ai/d/${ID}) for more.\n\n<https://notes.granola.ai/d/abc123>\n\nhttps://notes.granola.ai/d/${ID}`,
    )
    expect(ids).toEqual([ID, 'abc123'])
    expect(text).toBe('See for more.')
  })

  it('leaves text without one alone', () => {
    const text = 'Granola is where the notes are; see https://example.com/d/1 too.'
    expect(splitGranolaLinks(text)).toEqual({ text, ids: [] })
  })
})
