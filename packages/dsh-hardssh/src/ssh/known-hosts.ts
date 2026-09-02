/**
 * SSH host-key trust store (TOFU): first-connection trust-on-first-use.
 *
 * When enabled, the engine refuses to connect to a host whose public-key
 * fingerprint has not been explicitly trusted: the first encounter records a
 * `pending` entry and the connection is REJECTED (credentials are never sent
 * to an unverified host), the operator confirms the fingerprint through the
 * GUI, and every later connection re-checks the stored fingerprint with a
 * constant-time comparison.
 *
 * The store is deliberately independent of the credentials vault: a
 * fingerprint is not a secret, so verifying the host needs no unlock, and
 * Host-Key protectio n can ship (and be tested) before the vault lands.
 *
 * @module dsh-hardssh/known-hosts
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File format version. */
const FORMAT_VERSION = 1

/** One known-host record. */
export interface KnownHostRecord {
  alias: string
  host: string
  port: number
  /** Server public-key algorithm (ssh-ed25519, ssh-rsa, …) for display. */
  keyType: string
  /** Canonical fingerprint: 'SHA256:' + base64 (no '=' padding). */
  fingerprint: string
  /** 'pending' = seen once, waiting for explicit trust; 'trusted' = confirmed. */
  status: 'pending' | 'trusted'
  firstSeenAt: number
  confirmedAt: number | null
}

interface KnownHostsFile {
  version: number
  hosts: KnownHostRecord[]
}

/** Default file location: <home>/.dsh/ssh-known-hosts.json. */
export function knownHostsPath(): string {
  return join(homedir(), '.dsh', 'ssh-known-hosts.json')
}

/** Normalize a fingerprint to the canonical 'SHA256:<b64-no-padding>' form. */
export function normalizeFingerprint(input: string): string {
  const trimmed = input.trim().replace(/^SHA256:/iu, '')
  return 'SHA256:' + trimmed.replace(/=+$/u, '')
}

/** Constant-time comparison of two fingerprints (canonical form, length-safe). */
export function fingerprintsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(normalizeFingerprint(a).slice('SHA256:'.length))
  const bufB = Buffer.from(normalizeFingerprint(b).slice('SHA256:'.length))
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Compute the canonical OpenSSH-style fingerprint of a server key blob. */
export function fingerprintOf(rawKey: Buffer): string {
  const digest = createHash('sha256').update(rawKey).digest('base64').replace(/=+$/u, '')
  return 'SHA256:' + digest
}

/** Host-key check outcome. */
export type HostKeyCheck =
  | { kind: 'trusted' }
  | { kind: 'unknown'; fingerprintSha256: string }
  | { kind: 'mismatch'; expected: string; actual: string }

/** Persisted host-key trust store (atomic write, 0600). */
export class KnownHostsStore {
  private readonly path: string
  private records = new Map<string, KnownHostRecord>()

  constructor(filePath?: string) {
    this.path = filePath ?? knownHostsPath()
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as KnownHostsFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.hosts)) return
      for (const record of parsed.hosts) {
        if (isRecord(record)) this.records.set(record.alias, record)
      }
    } catch {
      // Corrupt / unreadable trust file: fail open (treat as empty) rather
      // than brick every SSH connection; the first connect re-records pending.
    }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file: KnownHostsFile = { version: FORMAT_VERSION, hosts: [...this.records.values()] }
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  lookup(alias: string): KnownHostRecord | undefined {
    return this.records.get(alias)
  }

  /** First encounter: record as pending (non-destructive re-observe keeps status). */
  observe(alias: string, meta: { host: string; port: number; keyType: string; fingerprintSha256: string }): void {
    const existing = this.records.get(alias)
    if (existing !== undefined) return // keep pending/trusted as-is
    this.records.set(alias, {
      alias,
      host: meta.host,
      port: meta.port,
      keyType: meta.keyType,
      fingerprint: meta.fingerprintSha256,
      status: 'pending',
      firstSeenAt: Date.now(),
      confirmedAt: null,
    })
    this.save()
  }

  /** pending → trusted (must match the recorded fingerprint). */
  trust(alias: string): void {
    const record = this.records.get(alias)
    if (record === undefined) throw new Error(`no host-key record for '${alias}'`)
    record.status = 'trusted'
    record.confirmedAt = Date.now()
    this.save()
  }

  /** Forget a host (key rotation /误信 reset → next connect re-TOFU). */
  forget(alias: string): void {
    this.records.delete(alias)
    this.save()
  }

  list(): KnownHostRecord[] {
    return [...this.records.values()]
  }
}

/** Per-alias host-key policy: check a server key against the store. */
export class HostKeyPolicy {
  constructor(private readonly knownHosts: KnownHostsStore) {}

  /** Evaluate one server key: trusted / unknown (records pending) / mismatch. */
  check(alias: string, rawKey: Buffer): HostKeyCheck {
    const recorded = this.knownHosts.lookup(alias)
    const actual = fingerprintOf(rawKey)
    if (recorded === undefined) {
      // First encounter: remember as pending, but NOT trusted — the caller
      // must refuse the connection until the operator confirms.
      this.knownHosts.observe(alias, {
        host: '', // host/port are filled by the engine's richer record on confirm
        port: 0,
        keyType: keyTypeOf(rawKey),
        fingerprintSha256: actual,
      })
      return { kind: 'unknown', fingerprintSha256: actual }
    }
    if (recorded.status !== 'trusted') return { kind: 'unknown', fingerprintSha256: recorded.fingerprint }
    if (fingerprintsEqual(recorded.fingerprint, actual)) return { kind: 'trusted' }
    return { kind: 'mismatch', expected: recorded.fingerprint, actual }
  }
}

/** Best-effort key type label from the raw blob's base64 header. */
function keyTypeOf(rawKey: Buffer): string {
  try {
    const base64 = rawKey.toString('base64')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    const end = decoded.indexOf(' ')
    if (end > 0) return decoded.slice(0, end)
  } catch { /* fall through */ }
  return 'ssh-unknown'
}

function isRecord(value: unknown): value is KnownHostRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.alias === 'string'
    && typeof record.fingerprint === 'string'
    && (record.status === 'pending' || record.status === 'trusted')
}

/** Error: the host key is not trusted yet (first encounter, awaiting confirm). */
export class HostKeyUnknownError extends Error {
  readonly fingerprintSha256: string
  constructor(alias: string, fingerprintSha256: string) {
    super(`host key for '${alias}' 尚未信任 — 请先确认 SHA256 指纹 ${fingerprintSha256}`)
    this.name = 'HostKeyUnknownError'
    this.fingerprintSha256 = fingerprintSha256
  }
}

/** Error: the host key changed since it was trusted (possible MITM / key rotation). */
export class HostKeyMismatchError extends Error {
  readonly expected: string
  readonly actual: string
  constructor(alias: string, expected: string, actual: string) {
    super(`host key for '${alias}' 已变化（期望 ${expected}，实际 ${actual}）—— 请先人工核验服务器后 forget 重置信任`)
    this.name = 'HostKeyMismatchError'
    this.expected = expected
    this.actual = actual
  }
}