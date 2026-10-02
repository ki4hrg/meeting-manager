'use client'

import { useToast } from '@/components/Toast'
import { buttonClasses } from '@/components/ui/Button'
import { Icon } from '@/components/ui/icons'

/**
 * Opens the mail program with the recipients and subject filled in. A
 * `mailto:` cannot carry rich text, so the body goes to the clipboard on the
 * same click, ready to paste into the message.
 */
export function MailButton({ href, text, html }: { href: string; text: string; html: string }) {
  const toast = useToast()

  /* Not awaited and not prevented: the link opens as any link does, and the
     copy rides on the same gesture. */
  function copy() {
    if (!navigator.clipboard) return
    const done =
      typeof ClipboardItem !== 'undefined'
        ? navigator.clipboard.write([
            new ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob([html], { type: 'text/html' }),
            }),
          ])
        : navigator.clipboard.writeText(text)
    done.then(
      () => toast.success('Copied'),
      () => {},
    )
  }

  return (
    <a href={href} onClick={copy} className={buttonClasses('secondary', 'md')}>
      <Icon name="arrowRight" className="h-4 w-4" />
      Email
    </a>
  )
}
