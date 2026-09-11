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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
/** Minimum non-whitespace master-password length. */
export const MIN_MASTER_PASSWORD_LENGTH = 8

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

/**
 * Directory holding the credential vault: `<home>/.dsh/ssh-secrets`.
 *
 * It IS inside `~/.dsh` (which the fs seam declares a local-infrastructure root
 * so skills and plugin config stay readable), so its protection does NOT come
 * from location — it comes from `SwitchFileSystem.deniedRoots` (fs.ts), which
 * refuses this directory on every dispatch path, resolve to write, before any
 * backend sees it.
 *
 * Residual risk, stated plainly: a command that runs on THIS machine as the
 * same user (e.g. the client-side `pwsh` tool) can still read the file. What
 * keeps the credential safe is that the file is encrypted (AES-256-GCM +
 * scrypt) AND that environment auto-unlock is off by default — so a stolen
 * ciphertext is only an offline scrypt target, not a usable credential.
 */
export function vaultDirectory(): string {
  return join(homedir(), '.dsh', 'ssh-secrets')
}

/** Vault file location: <home>/.dsh/ssh-secrets/dsh-ssh-vault.json. */
export function vaultPath(): string {
  return join(vaultDirectory(), 'dsh-ssh-vault.json')
}

/** Pre-relocation vault location (<home>/.dsh/dsh-ssh-vault.json). */
export function legacyVaultPath(): string {
  return join(homedir(), '.dsh', 'dsh-ssh-vault.json')
}

/**
 * Move a pre-relocation vault into {@link vaultDirectory} on first use.
 *
 * Never destructive: the new location wins when both exist, and a failed move
 * falls back to copying so the source file is left in place.
 *
 * @param target - destination path (defaults to {@link vaultPath}).
 * @param legacy - source path (defaults to {@link legacyVaultPath}).
 * @returns true when a move/copy happened.
 */
export function migrateLegacyVault(target: string = vaultPath(), legacy: string = legacyVaultPath()): boolean {
  if (target === legacy) return false
  if (existsSync(target) || !existsSync(legacy)) return false
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try {
      renameSync(legacy, target)
    } catch {
      // Cross-device or locked source: copy the bytes and keep the original.
      const contents = readFileSync(legacy)
      writeFileSync(target, contents, { mode: 0o600 })
    }
    return true
  } catch {
    // Best-effort: an unmigratable legacy file still loads from its old path.
    return false
  }
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
  private document: VaultDocument = emptyDocument()
  private unlockedKey: Buffer | undefined
  private lockTimer: ReturnType<typeof setTimeout> | undefined
  private readonly idleLockMs: number
  private readonly leaked = new Set<string>()
  /** Whether `DSH_CREDENTIAL_PASSWORD` may unlock this instance at load. */
  private readonly allowEnvUnlock: boolean
  /** Single-instance mutation queue. Every operation that can change the
   *  in-memory document or persist it runs in invocation order. The tail is
   *  always recovered so one rejected mutation never poisons later work. */
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    filePath?: string,
    options?: {
      /** Vault idle auto-lock (ms); 0 disables (default 30 min). */
      idleLockMs?: number
      /**
       * Allow unlocking from `DSH_CREDENTIAL_PASSWORD` at construction.
       * OFF by default: that variable is visible to anything running as the
       * same user — including an agent session — so auto-unlock is an explicit
       * opt-in (`vaultAutoUnlock: 'env'` in the plugin config), not a default.
       */
      allowEnvUnlock?: boolean
    },
  ) {
    if (filePath === undefined) migrateLegacyVault()
    this.path = filePath ?? vaultPath()
    this.allowEnvUnlock = options?.allowEnvUnlock === true
    this.load()
    // Opt-in auto-unlock from DSH_CREDENTIAL_PASSWORD (headless / unattended
    // agents that deliberately enable it).
    const env = this.allowEnvUnlock ? process.env.DSH_CREDENTIAL_PASSWORD : undefined
    if (env !== undefined && env !== '') {
      void this.tryEnvUnlock(env)
    }
    const idle = options?.idleLockMs ?? 30 * 60_000
    if (!Number.isSafeInteger(idle) || idle < 0) throw new VaultError('VAULT_CONFIG', 'idleLockMs must be a non-negative safe integer')
    this.idleLockMs = idle
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

  private save(): void { this.saveDocument(this.document) }

  private saveDocument(document: VaultDocument): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
    try {
      writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, this.path)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* preserve the persistence error */ }
      throw error
    }
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
    const previousMeta = { ...doc.meta }
    const persistFailure = (): void => {
      try { this.save() } catch (error) { doc.meta = previousMeta; throw error }
    }
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
        persistFailure()
        throw new VaultLockoutError(`vault locked after ${doc.meta.attempts} failed attempts — retry after ${Math.ceil(backoff / 1000)}s`, backoff)
      }
      persistFailure()
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

  private validateMasterPassword(password: string): void {
    if (password.trim().length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new VaultError('VAULT_PASSWORD_WEAK', `vault password must contain at least ${MIN_MASTER_PASSWORD_LENGTH} non-whitespace characters`)
    }
  }

  /** Successful credential activity extends the idle lock deadline. */
  private touch(): void {
    if (this.lockTimer !== undefined) clearTimeout(this.lockTimer)
    this.lockTimer = undefined
    if (this.unlockedKey === undefined || this.idleLockMs === 0) return
    this.lockTimer = setTimeout(() => { this.lock() }, this.idleLockMs)
    this.lockTimer.unref?.()
  }

  private enqueueMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(mutation)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
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
      mode: this.allowEnvUnlock && process.env.DSH_CREDENTIAL_PASSWORD !== undefined ? 'env' : 'password',
      entries: this.document.secrets.length,
    }
  }

  /** Unlock with a password (loopback route / env). Persists lockout on failure. */
  async unlock(password: string): Promise<void> {
    return this.enqueueMutation(async () => {
      this.validateMasterPassword(password)
      if (this.unlockedKey !== undefined) { this.touch(); return }
      this.checkLockout()
      const doc = this.document
      if (doc.verifier.ciphertextB64 === '') {
        // First unlock: create the verifier with this password.
        const salt = randomBytes(SALT_BYTES)
        const kdf: VaultKdfParams = { algorithm: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, saltB64: salt.toString('base64') }
        const key = await this.deriveKey(password, kdf)
        const box = this.encryptEntryBuffer(key, entryAad('host.password', 'vault-verify'), Buffer.from(VERIFIER_TEXT, 'utf8'))
        const next: VaultDocument = {
          ...doc,
          kdf,
          verifier: { ...box, aad: entryAad('host.password', 'vault-verify') },
        }
        try {
          this.saveDocument(next)
        } catch (error) {
          key.fill(0)
          throw error
        }
        this.document = next
        this.unlockedKey = key
        this.touch()
        return
      }
      const key = await this.deriveKey(password, doc.kdf)
      try {
        await this.verifyPassword(key, password)
      } catch (error) {
        key.fill(0)
        throw error
      }
      this.unlockedKey = key
      this.touch()
    })
  }

  /** Lock: drop the in-memory key. JS strings cannot be zeroized; the Buffer
   *  key is wiped. */
  lock(): void {
    if (this.lockTimer !== undefined) clearTimeout(this.lockTimer)
    this.lockTimer = undefined
    if (this.unlockedKey !== undefined) {
      this.unlockedKey.fill(0)
      this.unlockedKey = undefined
    }
    // JS strings cannot be zeroized, but dropping every reference bounds the
    // leak-guard plaintext lifetime to one unlocked activity session.
    this.leaked.clear()
  }

  /** Store one secret, returning a random ref. Requires unlock. */
  async store(purpose: VaultPurpose, alias: string, secret: string): Promise<string> {
    return this.enqueueMutation(() => {
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
      try {
        this.save()
      } catch (error) {
        this.document.secrets.pop()
        throw error
      }
      this.touch()
      return ref
    })
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
    this.touch()
    return text
  }

  /** Delete one secret (host delete / cleanup). */
  async remove(ref: string): Promise<void> {
    return this.enqueueMutation(() => {
      this.requireKey()
      const before = this.document.secrets
      const next = before.filter(entry => entry.ref !== ref)
      if (next.length !== before.length) {
        this.document.secrets = next
        try { this.save() } catch (error) { this.document.secrets = before; throw error }
      }
      this.touch()
    })
  }

  /** Rekey with a new password: decrypt all, re-encrypt under a fresh KDF. */
  async rekey(newPassword: string): Promise<void> {
    return this.enqueueMutation(async () => {
      this.validateMasterPassword(newPassword)
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
      try {
        const box = this.encryptEntryBuffer(newKey, entryAad('host.password', 'vault-verify'), Buffer.from(VERIFIER_TEXT, 'utf8'))
        const secrets = plaintexts.map(({ purpose, alias, value }, index) => {
          const aad = entryAad(purpose, alias)
          const b = this.encryptEntryBuffer(newKey, aad, Buffer.from(value, 'utf8'))
          const data = `${b.nonceB64}${b.ciphertextB64}${b.tagB64}`
          return {
            ref: rekeyOriginalRef(doc.secrets[index]),
            purpose,
            alias,
            ...b,
            aad,
            sha3: sha3_256Hex(data),
          } satisfies VaultEntry
        })
        const next: VaultDocument = {
          ...doc,
          kdf,
          verifier: { ...box, aad: entryAad('host.password', 'vault-verify') },
          meta: { attempts: 0, lockedUntil: 0 },
          secrets,
        }
        this.saveDocument(next)
        key.fill(0)
        this.document = next
        this.unlockedKey = newKey
        this.touch()
      } catch (error) {
        newKey.fill(0)
        throw error
      } finally {
        for (const item of plaintexts) item.value = ''
      }
    })
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
    if (this.lockTimer !== undefined) clearTimeout(this.lockTimer)
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