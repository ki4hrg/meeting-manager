/*
 * Password rules, deliberately separate from the hashing.
 *
 * The signup form is a client component and needs the minimum length to render
 * its hint and its `minLength` attribute. Importing it from password.ts would
 * drag @node-rs/argon2 — a native binary with no browser build — into the client
 * bundle, and the build fails with a module-not-found that points at
 * node-rs/argon2/browser.js rather than at the import that caused it.
 *
 * Nothing here touches a hash, so it is safe on both sides.
 */

export const MIN_PASSWORD_LENGTH = 12

/** Returns the problem to show the user, or null when the password is fine. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return null
}
