/**
 * Credential vault: secrets (SSH passwords, key passphrases) encrypted at
 * rest with AES-256-GCM under a master key derived from a password via
 * scrypt (Node built-in). Each entry uses an independent random nonce and
 * binds its credential reference as GCM AAD; every ciphertext additionally
 * carries a SHA3-256 digest for integrity self-checks. Brute-force lockout
 * persists across restarts.
 *
 * The vault is deliberately dependency-free (node:crypto + fs only) and has
 * no cordis coupling, matching the HostStore style. KDF parameters are stored
 * in the file header so a later KDF upgrade never invalidates existing
 * vaults (algorithm is a stable switch point).
 *
 * @module dsh-hardssh/vault
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** File format version. */
const FORMAT_VERSION = 1
/** Master key length (AES-256). */
const KEY_BYTES = 32
/** AES-GCM nonce length. */
const NONCE_BYTES = 12
/** AES-GCM auth tag length. */
const TAG_BYTES = 16
/** Password salt length (scrypt). */
const SALT_BYTES = 16
/** scrypt parameters (OWASP-ish baseline; stored per file). */
const SCRYPT_N = 131_072
const SCRYPT_R = 8
const SCRYPT_P = 1
/** Failed-unlock budget before lockout (persisted). */
const LOCKOUT_THRESHOLD = 5
/** Lockout backoff floor (ms). */
const LOCKOUT_FLOOR_MS = 30_000
/** Lockout backoff cap (ms). */
const LOCKOUT_CAP_MS = 3_600_000
/** Fixed plaintext used to verify the unlock password. */
const VERIFIER_TEXT = 'dsh-hardssh:vault:verify:v1'

/** Types of secrets the vault stores. */
export type VaultPurpose = 'host.password' | 'host.passphrase'

/** KDF parameters persisted in the file header. */
export interface VaultKdfParams {
  algorithm: 'scrypt'
  N: number
  r: number
  p: number
  saltB64: string
}

/** Vault status (no secrets exposed). */
export interface VaultStatus {
  locked: boolean
  mode: 'env' | 'password'
  entries: number
}

/** One encrypted secret entry. */
interface VaultEntry {
  ref: string
  purpose: VaultPurpose
  alias: string
  nonceB64: string
  ciphertextB64: string
  tagB64: string
  /** GCM AAD (rebinds the entry to alias/purpose). */
  aad: string
  /** SHA3-256 of the ciphertext blob (integrity self-check). */
  sha3: string
}

interface VaultDocument {
  version: number
  kdf: VaultKdfParams
  verifier: { nonceB64: string; ciphertextB64: string; tagB64: string; aad: string }
  meta: { attempts: number; lockedUntil: number }
  secrets: VaultEntry[]
}

/** Default vault file location: <home>/.dsh/dsh-ssh-vault.json. */
export function vaultPath(): string {
  return join(homedir(), '.dsh', 'dsh-ssh-vault.json')
}

/** AAD for one entry. */
function entryAad(purpose: VaultPurpose, alias: string): string {
  return `dsh-hardssh:v1:${purpose}:${alias}`
}

/** SHA3-256 hex of a UTF-8 string. */
export function sha3_256Hex(text: string): string {
  return createHash('sha3-256').update(text, 'utf8').digest('hex')
}

/** Errors raised by the vault. */
export class VaultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

/** Unlocked-password or wrong-password errors. */
export class VaultLockedError extends VaultError {
  constructor(message = 'vault is locked — unlock it before accessing secrets') {
    super('VAULT_LOCKED', message)
    this.name = 'VaultLockedError'
  }
}

/** Wrong unlock password (with remaining attempts). */
export class VaultAuthError extends VaultError {
  constructor(message: string, readonly remaining: number) {
    super('VAULT_AUTH', message)
    this.name = 'VaultAuthError'
  }
}

/** Locked out due to repeated failures. */
export class VaultLockoutError extends VaultError {
  constructor(message: string, readonly retryAfterMs: number) {
    super('VAULT_LOCKOUT', message)
    this.name = 'VaultLockoutError'
  }
}

/** One revealed secret value, registered for output redaction. */
export interface RevealedSecret {
  ref: string
  value: string
}

/**
 * The credential vault. Plain file I/O + node:crypto; no cordis dependency.
 * Construction never requires a password (status/describe work locked); the
 * master key is derived on unlock and cached in memory for the session.
 */
export class Vault {
  private readonly path: string
  private readonly passwordProvider: (() => Promise<string | undefined>) | undefined
  private document: VaultDocument = emptyDocument()
  private unlockedKey: Buffer | undefined
  private lockTimer: ReturnType<typeof setTimeout> | undefined
  private readonly leaked = new Set<string>()

  constructor(
    filePath?: string,
    options?: {
      /** Session password source (loopback unlock route passes a password). */
      passwordProvider?: () => Promise<string | undefined>
      /** Vault idle auto-lock (ms); 0 disables (default 30 min). */
      idleLockMs?: number
    },
  ) {
    this.path = filePath ?? vaultPath()
    this.passwordProvider = options?.passwordProvider
    this.load()
    // Auto-unlock from the DSH_CREDENTIAL_PASSWORD environment variable when
    // present (headless / agent-friendly deterministic channel).
    const env = process.env.DSH_CREDENTIAL_PASSWORD
    if (env !== undefined && env !== '') {
      void this.tryEnvUnlock(env)
    }
    const idle = options?.idleLockMs ?? 30 * 60_000
    if (idle > 0) {
      this.lockTimer = setInterval(() => { this.lock() }, idle)
      this.lockTimer.unref?.()
    }
  }

  // ------------------------------------------------------------- internals

  private load(): void {
    if (!existsSync(this.path)) {
      this.document = emptyDocument()
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as VaultDocument
      if (!isDocument(parsed)) throw new Error('vault shape invalid')
      this.document = parsed
    } catch {
      // Corrupt vault: rename aside, start empty (never silently overwrite).
      try { renameSync(this.path, `${this.path}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      this.document = emptyDocument()
    }
  }

  private save(): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.document, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private deriveKey(password: string, kdf: VaultKdfParams): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scrypt(
        password,
        Buffer.from(kdf.saltB64, 'base64'),
        KEY_BYTES,
        { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 },
        (error, key) => {
          if (error !== null) reject(error)
          else resolve(key)
        },
      )
    })
  }

  private lockoutRetryAfter(): number {
    const doc = this.document
    if (doc.meta.lockedUntil === 0) return 0
    const remaining = doc.meta.lockedUntil - Date.now()
    return remaining > 0 ? remaining : 0
  }

  private checkLockout(): void {
    const doc = this.document
    if (doc.meta.lockedUntil !== 0) {
      const remaining = this.lockoutRetryAfter()
      if (remaining > 0) {
        throw new VaultLockoutError(`vault locked: too many failed attempts — retry after ${Math.ceil(remaining / 1000)}s`, remaining)
      }
      // Lockout expired: reset.
      doc.meta.attempts = 0
      doc.meta.lockedUntil = 0
    }
  }

  private async verifyPassword(key: Buffer, password: string): Promise<void> {
    const doc = this.document
    const verifier = doc.verifier
    try {
      const plain = this.decryptEntryBuffer(key, verifier.aad, verifier.nonceB64, verifier.ciphertextB64, verifier.tagB64)
      if (plain.toString('utf8') !== VERIFIER_TEXT) throw new Error('verifier mismatch')
      plain.fill(0)
    } catch {
      doc.meta.attempts += 1
      if (doc.meta.attempts >= LOCKOUT_THRESHOLD) {
        const backoff = backoffFor(doc.meta.attempts)
        doc.meta.lockedUntil = Date.now() + backoff
        this.save()
        throw new VaultLockoutError(`vault locked after ${doc.meta.attempts} failed attempts — retry after ${Math.ceil(backoff / 1000)}s`, backoff)
      }
      this.save()
      throw new VaultAuthError(`wrong vault password (${doc.meta.attempts}/${LOCKOUT_THRESHOLD} attempts used)`, LOCKOUT_THRESHOLD - doc.meta.attempts)
    }
  }

  private encryptEntryBuffer(key: Buffer, aad: string, plaintext: Buffer): { nonceB64: string; ciphertextB64: string; tagB64: string } {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      nonceB64: nonce.toString('base64'),
      ciphertextB64: ciphertext.toString('base64'),
      tagB64: tag.toString('base64'),
    }
  }

  private decryptEntryBuffer(key: Buffer, aad: string, nonceB64: string, ciphertextB64: string, tagB64: string): Buffer {
    const nonce = Buffer.from(nonceB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const ciphertext = Buffer.from(ciphertextB64, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  }

  private requireKey(): Buffer {
    if (this.unlockedKey === undefined) throw new VaultLockedError()
    return this.unlockedKey
  }

  private async tryEnvUnlock(password: string): Promise<void> {
    try {
      await this.unlock(password)
    } catch {
      // Env password wrong: stay locked; the loopback route can still unlock.
    }
  }

  // ---------------------------------------------------------------- public

  /** Current status (locked / mode / entry count) — safe for UIs. */
  status(): VaultStatus {
    const hasEntries = this.document.secrets.length > 0
    return {
      locked: this.unlockedKey === undefined || hasEntries === false && this.document.verifier.ciphertextB64 === '',
      mode: process.env.DSH_CREDENTIAL_PASSWORD !== undefined ? 'env' : 'password',
      entries: this.document.secrets.length,
    }
  }

  /** Unlock with a password (loopback route / env). Persists lockout on failure. */
  async unlock(password: string): Promise<void> {
    if (this.unlockedKey !== undefined) return
    this.checkLockout()
    const doc = this.document
    if (doc.verifier.ciphertextB64 === '') {
      // First unlock: create the verifier with this password.
      const salt = randomBytes(SALT_BYTES)
      const kdf: VaultKdfParams = { algorithm: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, saltB64: salt.toString('base64') }
      const key = await this.deriveKey(password, kdf)
      doc.kdf = kdf
      const box = this.encryptEntryBuffer(key, entryAad('host.password', 'vault-verify'), Buffer.from(VERIFIER_TEXT, 'utf8'))
      doc.verifier = { ...box, aad: entryAad('host.password', 'vault-verify') }
      this.unlockedKey = key
      this.save()
      return
    }
    const key = await this.deriveKey(password, doc.kdf)
    await this.verifyPassword(key, password)
    this.unlockedKey = key
  }

  /** Lock: drop the in-memory key. JS strings cannot be zeroized; the Buffer
   *  key is wiped. */
  lock(): void {
    if (this.unlockedKey !== undefined) {
      this.unlockedKey.fill(0)
      this.unlockedKey = undefined
    }
  }

  /** Store one secret, returning a random ref. Requires unlock. */
  async store(purpose: VaultPurpose, alias: string, secret: string): Promise<string> {
    const key = this.requireKey()
    const ref = 'vlt_' + randomBytes(16).toString('hex')
    const aad = entryAad(purpose, alias)
    const box = this.encryptEntryBuffer(key, aad, Buffer.from(secret, 'utf8'))
    const data = `${box.nonceB64}${box.ciphertextB64}${box.tagB64}`
    const entry: VaultEntry = {
      ref,
      purpose,
      alias,
      ...box,
      aad,
      sha3: sha3_256Hex(data),
    }
    this.document.secrets.push(entry)
    this.save()
    return ref
  }

  /** Reveal one secret (unlock required); registers it for redaction. */
  async reveal(ref: string): Promise<string> {
    const key = this.requireKey()
    const entry = this.document.secrets.find(candidate => candidate.ref === ref)
    if (entry === undefined) throw new VaultError('VAULT_MISSING', `no secret for ref '${ref}'`)
    // Integrity self-check: SHA3 of the ciphertext must match.
    const data = `${entry.nonceB64}${entry.ciphertextB64}${entry.tagB64}`
    if (sha3_256Hex(data) !== entry.sha3) {
      throw new VaultError('VAULT_CORRUPTED', `entry '${ref}' failed its SHA3-256 integrity check`)
    }
    const plain = this.decryptEntryBuffer(key, entry.aad, entry.nonceB64, entry.ciphertextB64, entry.tagB64)
    const text = plain.toString('utf8')
    plain.fill(0)
    this.leaked.add(text)
    return text
  }

  /** Delete one secret (host delete / cleanup). */
  async remove(ref: string): Promise<void> {
    const before = this.document.secrets.length
    this.document.secrets = this.document.secrets.filter(entry => entry.ref !== ref)
    if (this.document.secrets.length !== before) this.save()
  }

  /** Rekey with a new password: decrypt all, re-encrypt under a fresh KDF. */
  async rekey(newPassword: string): Promise<void> {
    const key = this.requireKey()
    const doc = this.document
    // Decrypt everything with the current key.
    const plaintexts: Array<{ purpose: VaultPurpose; alias: string; value: string }> = []
    for (const entry of doc.secrets) {
      const plain = this.decryptEntryBuffer(key, entry.aad, entry.nonceB64, entry.ciphertextB64, entry.tagB64)
      plaintexts.push({ purpose: entry.purpose, alias: entry.alias, value: plain.toString('utf8') })
      plain.fill(0)
    }
    // Fresh KDF + verifier under the new password.
    const salt = randomBytes(SALT_BYTES)
    const kdf: VaultKdfParams = { algorithm: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, saltB64: salt.toString('base64') }
    const newKey = await this.deriveKey(newPassword, kdf)
    doc.kdf = kdf
    const box = this.encryptEntryBuffer(newKey, entryAad('host.password', 'vault-verify'), Buffer.from(VERIFIER_TEXT, 'utf8'))
    doc.verifier = { ...box, aad: entryAad('host.password', 'vault-verify') }
    doc.secrets = plaintexts.map(({ purpose, alias, value }, index) => {
      const aad = entryAad(purpose, alias)
      const b = this.encryptEntryBuffer(newKey, aad, Buffer.from(value, 'utf8'))
      const data = `${b.nonceB64}${b.ciphertextB64}${b.tagB64}`
      return {
        // Preserve the original ref: SshHostEntry.auth.secretRef persists it.
        ref: rekeyOriginalRef(this.document.secrets[index]),
        purpose,
        alias,
        ...b,
        aad,
        sha3: sha3_256Hex(data),
      } satisfies VaultEntry
    })
    this.unlockedKey?.fill(0)
    this.unlockedKey = newKey
    doc.meta.attempts = 0
    doc.meta.lockedUntil = 0
    this.save()
  }

  /** Redact every leaked secret value in `text` (Leak Guard light). */
  redact(text: string): string {
    if (this.leaked.size === 0) return text
    let out = text
    for (const value of this.leaked) {
      if (value.length > 0) out = out.split(value).join('[REDACTED]')
    }
    return out
  }

  /** Dispose: wipe the key and stop the idle timer. */
  dispose(): void {
    if (this.lockTimer !== undefined) clearInterval(this.lockTimer)
    this.lock()
  }
}

/** Empty vault document. */
function emptyDocument(): VaultDocument {
  return {
    version: FORMAT_VERSION,
    kdf: { algorithm: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, saltB64: '' },
    verifier: { nonceB64: '', ciphertextB64: '', tagB64: '', aad: '' },
    meta: { attempts: 0, lockedUntil: 0 },
    secrets: [],
  }
}

/** Lockout backoff: exponential, floored, capped. */
function backoffFor(attempts: number): number {
  const exponent = Math.min(attempts - LOCKOUT_THRESHOLD, 6)
  const backoff = LOCKOUT_FLOOR_MS * Math.pow(2, exponent)
  return Math.min(backoff, LOCKOUT_CAP_MS)
}

/** Guard: a parsed JSON value is a valid vault document. */
function isDocument(value: unknown): value is VaultDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return typeof doc.version === 'number'
    && typeof doc.kdf === 'object' && doc.kdf !== null
    && typeof (doc.kdf as Record<string, unknown>).algorithm === 'string'
    && typeof doc.verifier === 'object' && doc.verifier !== null
    && typeof doc.meta === 'object' && doc.meta !== null
    && Array.isArray(doc.secrets)
}

/** Constant-time helper (kept for completeness; GCM auth is the real gate). */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** The ref to reuse for the index-th entry during rekey (preserves identity). */
function rekeyOriginalRef(entry: VaultEntry | undefined): string {
  return entry?.ref ?? 'vlt_' + randomBytes(16).toString('hex')
}