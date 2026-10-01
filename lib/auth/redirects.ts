/*
 * Where a login is allowed to send you afterwards.
 *
 * `?next=` exists for one reason: the OAuth consent screen. A connector sends
 * the browser to /oauth/authorize with the request in its query string, and if
 * that hits a signed-out session the only answer that does not lose the
 * connection attempt is to log in and come back to the same URL.
 *
 * Which makes this the one place in the app where a user-supplied string decides
 * where a browser goes, and that is exactly the shape of an open redirect. So it
 * is an allowlist by construction: a path on this origin, or nothing.
 */

export const DEFAULT_AFTER_LOGIN = '/'

export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_AFTER_LOGIN

  /* Must be a path on this origin. Rejecting anything that does not start with
     a single slash covers the whole family at once: absolute URLs
     (https://evil.example), protocol-relative ones (//evil.example, which a
     browser resolves against the current scheme), and backslash variants that
     some browsers normalize into slashes. */
  if (!raw.startsWith('/')) return DEFAULT_AFTER_LOGIN
  if (raw.startsWith('//') || raw.startsWith('/\\')) return DEFAULT_AFTER_LOGIN

  /* A control character or newline in a Location header is a response-splitting
     attempt, not a path. Checked by code point rather than by a regex literal,
     because a regex written with raw control characters in the source is
     invisible to review. */
  for (const char of raw) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) return DEFAULT_AFTER_LOGIN
  }

  return raw
}
