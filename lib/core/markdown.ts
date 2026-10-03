/*
 * Markdown in long text: item detail and resolution, project descriptions,
 * agenda line descriptions and private notes, documents. One renderer for the
 * screens and for the HTML the brief, agenda and recap are copied out as.
 *
 * What it will not do is as important: raw HTML is shown as the text it is,
 * images are dropped to their alt text, and a link goes only to http(s) or
 * mailto. Notes arrive from Granola and the model as well as from John, so
 * nothing in them may run in the page.
 */

import { Marked, type Tokens } from 'marked'

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const SAFE_HREF = /^(https?:|mailto:)/i

const marked = new Marked({ gfm: true, breaks: true, async: false })
marked.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escape(token.text)
    },
    image(token: Tokens.Image) {
      return escape(token.text)
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens)
      if (!SAFE_HREF.test(token.href.trim())) return text
      const title = token.title ? ` title="${escape(token.title)}"` : ''
      return `<a href="${escape(token.href.trim())}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

/** Block Markdown (paragraphs, lists, headings) as safe HTML. */
export function markdownToHtml(source: string): string {
  return marked.parse(source) as string
}

/** One line of Markdown (bold, italic, code, links) as safe HTML, with no paragraph around it. */
export function inlineMarkdownToHtml(source: string): string {
  return marked.parseInline(source) as string
}
