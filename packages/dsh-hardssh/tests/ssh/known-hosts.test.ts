/**
 * Host-key TOFU store + policy unit tests: fingerprint normalization,
 * constant-time comparison, pending→trusted→mismatch→forget state machine,
 * persistence (atomic 0600 write), and the typed errors.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fingerprintOf,
  fingerprintsEqual,
  HostKeyMismatchError,
  HostKeyPolicy,
  HostKeyUnknownError,
  KnownHostsStore,
  keyTypeOf,
  normalizeFingerprint,
} from '../../src/ssh/known-hosts.ts'

/** A real SSH wire public-key blob: `string algorithm, byte[] key`. */
function fakeKey(seed: number, algorithm = 'ssh-ed25519'): Buffer {
  const name = Buffer.from(algorithm, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  const payload = Buffer.from(`AAAA-fake-${seed}`, 'latin1')
  const payloadLength = Buffer.alloc(4)
  payloadLength.writeUInt32BE(payload.length, 0)
  return Buffer.concat([length, name, payloadLength, payload])
}

describe('fingerprint helpers', () => {
  it('normalizes to canonical SHA256:<b64> (strips prefix / padding / case)', () => {
    expect(normalizeFingerprint('SHA256:abc===')).toBe('SHA256:abc')
    expect(normalizeFingerprint('sha256:xyz=')).toBe('SHA256:xyz')
    expect(normalizeFingerprint('  abc=  ')).toBe('SHA256:abc')
  })

  it('comparison is constant-time and length-safe', () => {
    expect(fingerprintsEqual('SHA256:abc', 'SHA256:abc')).toBe(true)
    expect(fingerprintsEqual('SHA256:abc=', 'SHA256:abc')).toBe(true) // padding-insensitive
    expect(fingerprintsEqual('SHA256:abc', 'SHA256:abd')).toBe(false)
    expect(fingerprintsEqual('SHA256:a', 'SHA256:abc')).toBe(false) // different length, no throw
  })

  it('computes the OpenSSH-style fingerprint of a key blob', () => {
    const fp = fingerprintOf(Buffer.from('ssh-rsa AAAA-test'))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/_-]+$/)
    expect(fp).not.toContain('=')
  })
})

describe('KnownHostsStore', () => {
  it('records a pending entry on first observe, keeps status on re-observe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'))
    const store = new KnownHostsStore(join(dir, 'known.json'))
    store.observe('web-01', { host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' })
    expect(store.lookup('web-01')?.status).toBe('pending')
    store.observe('web-01', { host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' })
    expect(store.lookup('web-01')?.status).toBe('pending') // still pending
  })

  it('trusts → trusted, forget → gone (state machine)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'))
    const store = new KnownHostsStore(join(dir, 'known.json'))
    store.observe('web-01', { host: 'h', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' })
    store.trust('web-01')
    expect(store.lookup('web-01')?.status).toBe('trusted')
    expect(store.lookup('web-01')?.confirmedAt).not.toBeNull()
    store.forget('web-01')
    expect(store.lookup('web-01')).toBeUndefined()
  })

  it('persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'))
    const path = join(dir, 'known.json')
    const first = new KnownHostsStore(path)
    first.observe('web-01', { host: 'h', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:abc' })
    first.trust('web-01')
    const second = new KnownHostsStore(path)
    expect(second.lookup('web-01')?.status).toBe('trusted')
  })
})

describe('keyTypeOf (real SSH wire blobs)', () => {
  it('reads the algorithm string from the wire length prefix, not the text form', () => {
    expect(keyTypeOf(fakeKey(1))).toBe('ssh-ed25519')
    expect(keyTypeOf(fakeKey(2, 'ssh-rsa'))).toBe('ssh-rsa')
    expect(keyTypeOf(fakeKey(3, 'ecdsa-sha2-nistp256'))).toBe('ecdsa-sha2-nistp256')
    // The authorized_keys text form is NOT a wire blob.
    expect(keyTypeOf(Buffer.from('ssh-ed25519 AAAA-fake-1'))).toBe('ssh-unknown')
    expect(keyTypeOf(Buffer.alloc(0))).toBe('ssh-unknown')
    expect(keyTypeOf(Buffer.from([0, 0, 0, 9, 1, 2]))).toBe('ssh-unknown')
  })
})

describe('HostKeyPolicy', () => {
  it('unknown on first encounter (records pending), trusted after trust, mismatch on change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'))
    const store = new KnownHostsStore(join(dir, 'known.json'))
    const policy = new HostKeyPolicy(store)

    const first = policy.check('web-01', fakeKey(1))
    expect(first.kind).toBe('unknown')
    expect(first.kind === 'unknown' ? first.fingerprintSha256 : '').toMatch(/^SHA256:/)

    store.trust('web-01')
    expect(policy.check('web-01', fakeKey(1)).kind).toBe('trusted')

    const changed = policy.check('web-01', fakeKey(2))
    expect(changed.kind).toBe('mismatch')
  })

  it('records the real host/port/keyType on first encounter and backfills a legacy record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'known-hosts-'))
    const store = new KnownHostsStore(join(dir, 'known.json'))
    const policy = new HostKeyPolicy(store)

    policy.check('web-01', fakeKey(1), { host: '10.0.0.5', port: 2222 })
    const record = store.lookup('web-01')
    expect(record).toMatchObject({ host: '10.0.0.5', port: 2222, keyType: 'ssh-ed25519' })

    // A record observed before the target was known gets completed on the next
    // check without changing its pending status.
    store.forget('web-01')
    store.observe('web-01', { host: '', port: 0, keyType: 'ssh-unknown', fingerprintSha256: fingerprintOf(fakeKey(1)) })
    policy.check('web-01', fakeKey(1), { host: 'web-01.internal', port: 22 })
    expect(store.lookup('web-01')).toMatchObject({ host: 'web-01.internal', port: 22, keyType: 'ssh-ed25519', status: 'pending' })

    store.trust('web-01', { host: 'ignored', port: 9999 })
    expect(store.lookup('web-01')).toMatchObject({ host: 'web-01.internal', port: 22, status: 'trusted' })
  })
})

describe('typed host-key errors', () => {
  it('carry the fingerprint / expected-actual for the GUI', () => {
    const unknown = new HostKeyUnknownError('web-01', 'SHA256:abc')
    expect(unknown.fingerprintSha256).toBe('SHA256:abc')
    expect(unknown.message).toContain('SHA256:abc')

    const mismatch = new HostKeyMismatchError('web-01', 'SHA256:old', 'SHA256:new')
    expect(mismatch.expected).toBe('SHA256:old')
    expect(mismatch.actual).toBe('SHA256:new')
  })
})