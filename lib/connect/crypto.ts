/*
 * Encrypt and decrypt credentials at rest.
 *
 * AES-256-GCM, so a tampered or wrongly keyed ciphertext fails to decrypt
 * rather than yielding garbage that is then sent to Google as a token. The key
 * is derived from the configured secret with scrypt and a salt stored beside
 * each ciphertext. (Meeter's version uses one fixed salt; this one does not, so
 * the two formats are not interchangeable.)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export interface EncryptedData {
  ciphertext: string
  iv: string
  salt: string
}

/*
 * scrypt takes tens of milliseconds and blocks while it runs, and the calendar
 * feed decrypts a token for every bound calendar on every page that shows
 * events. Derived keys are kept, so that cost is paid once per stored
 * credential rather than once per read.
 */
const derived = new Map<string, Buffer>()
const DERIVED_MAX = 64

function deriveKey(password: string, salt: Buffer): Buffer {
  const id = `${salt.toString('hex')}:${password}`
  const known = derived.get(id)
  if (known) return known
  const key = scryptSync(password, salt, 32)
  if (derived.size >= DERIVED_MAX) derived.clear()
  derived.set(id, key)
  return key
}

/**
 * Derive a 256-bit key from a password using scrypt, and encrypt data
 * with AES-256-GCM, returning all three components (iv, salt, ciphertext)
 * so decryption can recover them.
 */
export function encrypt(plaintext: string, password: string): EncryptedData {
  const salt = randomBytes(16)
  const key = deriveKey(password, salt)

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('hex'),
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
  }
}

/**
 * Decrypt by deriving the same key from the password and salt, then
 * decrypting the ciphertext+auth tag with the iv.
 */
export function decrypt(data: EncryptedData, password: string): string {
  const salt = Buffer.from(data.salt, 'hex')
  const key = deriveKey(password, salt)

  const iv = Buffer.from(data.iv, 'hex')
  const ciphertextWithTag = Buffer.from(data.ciphertext, 'hex')
  const ciphertext = ciphertextWithTag.subarray(0, -16)
  const authTag = ciphertextWithTag.subarray(-16)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}
