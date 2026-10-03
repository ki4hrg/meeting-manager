import { markdownToHtml } from '@/lib/core/markdown'

/**
 * Long text written in Markdown, rendered. The colour and size come from the
 * caller's classes; `.md` in globals.css only spaces and marks the blocks.
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  return (
    <div
      className={`md min-w-0 break-words ${className}`}
      // Safe by construction: lib/core/markdown.ts escapes raw HTML and unsafe links.
      dangerouslySetInnerHTML={{ __html: markdownToHtml(source) }}
    />
  )
}
