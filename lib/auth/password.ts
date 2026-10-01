/*
 * Argon2id.
 *
 * @node-rs/argon2 ships prebuilt binaries, which keeps a native toolchain out of
 * the Docker build. The alpine runtime picks up the musl variant
 * because dependencies are installed inside the image.
 */

import { hash, verify } from '@node-rs/argon2'

// Re-exported for server callers; the client imports the policy module directly.
export { MIN_PASSWORD_LENGTH, passwordProblem } from './password-policy'

/*
 * OWASP's Argon2id baseline: 19 MiB, 2 iterations, 1 degree of parallelism.
 * These are recorded in the encoded hash, so raising them later re-hashes on
 * next login rather than invalidating existing passwords.
 */
const OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

/**
 * Verify, returning false rather than throwing on a malformed stored hash — a
 * corrupted row should fail the login, not 500 the request.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, OPTIONS)
  } catch {
    return false
  }
}
