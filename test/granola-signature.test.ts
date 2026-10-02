/* The signature check on its own: it is the only thing guarding a public endpoint. */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  signDelivery,
  signatureHeaders,
  verifyDelivery,
} from '../lib/connect/granola/signature'

const KEY = Buffer.from('a-signing-secret-32-bytes-long!!')
const SECRET = `whsec_${KEY.toString('base64')}`
const now = new Date('2026-10-01T15:00:00Z')
const body = '{"type":"note.generated","data":{"id":"not_1d3tmYTlCICgjy"}}'

function signed(at: Date = now, secret = SECRET) {
  return {
    id: 'msg_1',
    timestamp: String(Math.floor(at.getTime() / 1000)),
    signature: signDelivery('msg_1', at, body, secret),
  }
}

describe('verifyDelivery', () => {
  it('accepts what the scheme produces, computed independently here', () => {
    /* Once, by hand, so the signer and the verifier are not only agreeing
       with each other. */
    const timestamp = String(Math.floor(now.getTime() / 1000))
    const mac = createHmac('sha256', KEY).update(`msg_1.${timestamp}.${body}`).digest('base64')

    const result = verifyDelivery({ id: 'msg_1', timestamp, signature: `v1,${mac}` }, body, SECRET, now)
    expect(result).toMatchObject({ ok: true, id: 'msg_1' })
    expect(signDelivery('msg_1', now, body, SECRET)).toBe(`v1,${mac}`)
  })

  it('refuses a body that changed by one byte', () => {
    const result = verifyDelivery(signed(), body.replace('generated', 'generatee'), SECRET, now)
    expect(result).toMatchObject({ ok: false, reason: 'mismatch' })
  })

  it('refuses a signature made with another secret', () => {
    const other = `whsec_${Buffer.from('some-other-secret-entirely-here!').toString('base64')}`
    expect(verifyDelivery(signed(now, other), body, SECRET, now)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('refuses a signature for another delivery id or timestamp', () => {
    expect(verifyDelivery({ ...signed(), id: 'msg_2' }, body, SECRET, now)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    })
    const later = String(Math.floor(now.getTime() / 1000) + 1)
    expect(verifyDelivery({ ...signed(), timestamp: later }, body, SECRET, now)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('refuses when any header is missing, rather than passing', () => {
    for (const missing of ['id', 'timestamp', 'signature'] as const) {
      const result = verifyDelivery({ ...signed(), [missing]: null }, body, SECRET, now)
      expect(result).toMatchObject({ ok: false, reason: 'unsigned' })
    }
  })

  it('refuses a timestamp more than five minutes away, either way', () => {
    const old = new Date(now.getTime() - 6 * 60_000)
    const ahead = new Date(now.getTime() + 6 * 60_000)
    expect(verifyDelivery(signed(old), body, SECRET, now)).toMatchObject({ ok: false, reason: 'stale' })
    expect(verifyDelivery(signed(ahead), body, SECRET, now)).toMatchObject({ ok: false, reason: 'stale' })
    // Inside the window, a correctly signed one still passes.
    expect(verifyDelivery(signed(new Date(now.getTime() - 4 * 60_000)), body, SECRET, now).ok).toBe(true)
  })

  it('refuses a timestamp that is not a number', () => {
    expect(verifyDelivery({ ...signed(), timestamp: 'yesterday' }, body, SECRET, now)).toMatchObject({
      ok: false,
      reason: 'malformed',
    })
  })

  it('refuses a truncated or unversioned signature without throwing', () => {
    const good = signed()
    for (const signature of [good.signature.slice(0, -6), good.signature.replace('v1,', 'v2,'), 'v1,', 'nonsense']) {
      expect(verifyDelivery({ ...good, signature }, body, SECRET, now)).toMatchObject({
        ok: false,
        reason: 'mismatch',
      })
    }
  })

  it('accepts any one of several signatures, as during a rotation', () => {
    const good = signed()
    const result = verifyDelivery({ ...good, signature: `v1,AAAA ${good.signature}` }, body, SECRET, now)
    expect(result.ok).toBe(true)
  })

  it('refuses an empty secret', () => {
    expect(verifyDelivery(signed(), body, '  ', now)).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('signatureHeaders', () => {
  it('reads the standard names and the svix ones', () => {
    const standard = new Headers({ 'webhook-id': 'a', 'webhook-timestamp': '1', 'webhook-signature': 's' })
    const svix = new Headers({ 'svix-id': 'a', 'svix-timestamp': '1', 'svix-signature': 's' })
    expect(signatureHeaders(standard)).toEqual({ id: 'a', timestamp: '1', signature: 's' })
    expect(signatureHeaders(svix)).toEqual({ id: 'a', timestamp: '1', signature: 's' })
    expect(signatureHeaders(new Headers())).toEqual({ id: null, timestamp: null, signature: null })
  })
})
