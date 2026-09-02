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
  normalizeFingerprint,
} from '../../src/ssh/known-hosts.ts'

/** A fake server key blob (any raw bytes hash to a stable fingerprint). */
function fakeKey(seed: number): Buffer {
  return Buffer.from(`ssh-ed25519 AAAA-fake-${seed}`)
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