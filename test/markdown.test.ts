import { describe, expect, it } from 'vitest'
import { inlineMarkdownToHtml, markdownToHtml } from '../lib/core/markdown'
import { toHtml, toMarkdown, markdownLeaf } from '../lib/agenda/brief'

describe('markdown', () => {
  it('renders lists, emphasis and links', () => {
    expect(markdownToHtml('Bring:\n- **chairs**\n- [map](https://example.test)')).toBe(
      '<p>Bring:</p>\n<ul>\n<li><strong>chairs</strong></li>\n<li><a href="https://example.test" target="_blank" rel="noopener noreferrer">map</a></li>\n</ul>\n',
    )
    expect(markdownToHtml('one\ntwo')).toBe('<p>one<br>two</p>\n')
  })

  it('never lets markup or script through', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) ![a](https://x.test/i.png)')
    expect(html).not.toMatch(/<script|<img|javascript:|onerror="/)
    expect(html).toContain('&lt;script&gt;')
    expect(inlineMarkdownToHtml('[x](javascript:alert(1))')).toBe('x')
  })

  it('goes out rendered in an HTML copy and as written in the text copy', () => {
    const parts = [{ type: 'list' as const, entries: [{ text: 'Budget', sub: [markdownLeaf('see **page 3**')] }] }]
    expect(toHtml(parts)).toBe('<ul><li>Budget<ul><li>see <strong>page 3</strong></li></ul></li></ul>')
    expect(toMarkdown(parts)).toBe('- Budget\n  - see **page 3**')
  })
})
