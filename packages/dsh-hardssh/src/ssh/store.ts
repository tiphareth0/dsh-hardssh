/**
 * Host config store: one JSON file (`~/.dsh/dsh-ssh.json`) holding every
 * SSH host entry, written atomically (tmp + rename). Also parses the user's
 * standard `~/.ssh/config` for one-shot import. Secrets (passwords,
 * passphrases) live in this user-owned file in plaintext — same trust model
 * as ssh-skill's annotated ssh-config comments; document it, never log it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { HostPayload, ImportResult, SshAuthKind, SshHostEntry, SshHostSummary } from './protocol.ts'

/** File format version. */
const FORMAT_VERSION = 1

/** Store file location: <home>/.dsh/dsh-ssh.json. */
export function storePath(): string {
  return join(homedir(), '.dsh', 'dsh-ssh.json')
}

/** The user's standard OpenSSH config path. */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

interface StoreFile {
  version: number
  hosts: SshHostEntry[]
}

/** Payload shape the validator enforces: full create vs partial patch. */
export type HostPayloadValidationMode = 'create' | 'patch'

/** Validate one auth block; returns a message or undefined.
 *  With `allowSecretless`, a password-kind block may omit the password (and
 *  key-kind may omit the keyPath, meaning "use the ssh-agent") — both shapes
 *  are produced by SecureHostStore when secrets live elsewhere (vault ref)
 *  or are never persisted ('none' mode, VSCode Remote-SSH style). */
function validateAuth(auth: unknown, allowSecretless: boolean): string | undefined {
  if (typeof auth !== 'object' || auth === null) return 'auth must be an object'
  const a = auth as Record<string, unknown>
  if (a.kind !== 'key' && a.kind !== 'password') return 'auth.kind must be key or password'
  if (a.kind === 'key' && (typeof a.keyPath !== 'string' || a.keyPath.trim() === '') && !allowSecretless) {
    return 'auth.keyPath is required for key auth'
  }
  if (a.kind === 'password' && typeof a.password !== 'undefined' && typeof a.password !== 'string') {
    return 'auth.password must be a string'
  }
  if (!allowSecretless && a.kind === 'password' && (typeof a.password !== 'string' || a.password === '')) {
    return 'auth.password is required for password auth'
  }
  if (a.secretRef !== undefined && (typeof a.secretRef !== 'string' || a.secretRef === '')) {
    return 'auth.secretRef must be a non-empty string'
  }
  return undefined
}

/** Validate the wire shape of a host payload; returns a message or undefined.
 *  `mode` picks the required fields: 'create' demands host/user/auth,
 *  'patch' only validates the fields that are present (same rules).
 *  `allowSecretless` relaxes the password requirement so SecureHostStore can
 *  persist stripped entries (secrets in vault / never persisted). */
export function validateHostPayload(
  payload: unknown,
  mode: HostPayloadValidationMode = 'create',
  allowSecretless = false,
): string | undefined {
  if (typeof payload !== 'object' || payload === null) return 'body must be a JSON object'
  const p = payload as Record<string, unknown>
  if (mode === 'create') {
    if (typeof p.host !== 'string' || p.host.trim() === '') return 'host is required'
    if (typeof p.user !== 'string' || p.user.trim() === '') return 'user is required'
  } else {
    if (p.host !== undefined && (typeof p.host !== 'string' || p.host.trim() === '')) return 'host is required'
    if (p.user !== undefined && (typeof p.user !== 'string' || p.user.trim() === '')) return 'user is required'
  }
  if (p.auth !== undefined) {
    const authError = validateAuth(p.auth, allowSecretless)
    if (authError !== undefined) return authError
  } else if (mode === 'create') {
    return 'auth is required'
  }
  if (p.port !== undefined && (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) {
    return 'port must be an integer in 1..65535'
  }
  if (p.proxyJump !== undefined && (!Array.isArray(p.proxyJump) || p.proxyJump.some(x => typeof x !== 'string' || x === ''))) {
    return 'proxyJump must be an array of alias strings'
  }
  if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some(x => typeof x !== 'string'))) {
    return 'tags must be an array of strings'
  }
  return undefined
}

/**
 * Detect a proxyJump cycle reachable from `startAlias` across the full host
 * list (a hop's own chain is followed transitively). Returns a readable
 * path like 'a -> b -> a', or undefined. Dangling hops (alias with no
 * entry) are terminal edges, not cycles.
 */
function findJumpCycle(startAlias: string, entries: Array<{ alias: string; proxyJump: string[] }>): string | undefined {
  const byAlias = new Map(entries.map(entry => [entry.alias, entry]))
  const walked = new Set<string>()
  const walk = (alias: string, path: string[]): string | undefined => {
    const at = path.indexOf(alias)
    if (at >= 0) return [...path.slice(at), alias].join(' -> ')
    if (walked.has(alias)) return undefined
    walked.add(alias)
    const entry = byAlias.get(alias)
    if (entry === undefined) return undefined
    for (const hop of entry.proxyJump) {
      const cycle = walk(hop, [...path, alias])
      if (cycle !== undefined) return cycle
    }
    return undefined
  }
  return walk(startAlias, [])
}

/** The alias grammar (same as the scaffold rule: lowercase, digits, single hyphens). */
const ALIAS_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Validate an alias for creation. */
export function validateAlias(alias: string): string | undefined {
  if (!ALIAS_RE.test(alias)) return 'alias must be lowercase letters, digits and single hyphens'
  return undefined
}

/**
 * The host store. Pure file I/O — no cordis dependency, unit-testable.
 */
export class HostStore {
  /** The JSON file path. */
  readonly path: string
  /** Optional override of the ~/.ssh/config path (tests). */
  private readonly sshConfigOverride: string | undefined

  /**
   * @param path - store file path (defaults to the standard location).
   * @param sshConfigOverride - ssh config path override (tests only).
   */
  constructor(path?: string, sshConfigOverride?: string) {
    this.path = resolve(path ?? storePath())
    this.sshConfigOverride = sshConfigOverride
  }

  /** Load all entries (empty store when the file is absent). */
  list(): SshHostEntry[] {
    const file = this.load()
    return file.hosts
  }

  /** Find one entry by alias. */
  find(alias: string): SshHostEntry | undefined {
    return this.list().find(entry => entry.alias === alias)
  }

  /** Secret-free projection for the browser and agent surfaces. */
  summarize(entry: SshHostEntry): SshHostSummary {
    let keyReady = true
    if (entry.auth.kind === 'key' && entry.auth.keyPath) {
      keyReady = existsSync(expandHome(entry.auth.keyPath))
    }
    return {
      alias: entry.alias,
      host: entry.host,
      port: entry.port,
      user: entry.user,
      auth: entry.auth.kind,
      keyReady,
      proxyJump: [...entry.proxyJump],
      // Optional fields are spread conditionally: the tool bridge rejects
      // undefined-valued properties as non-lossless JSON.
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.environment !== undefined ? { environment: entry.environment } : {}),
      tags: [...entry.tags],
      ...(entry.location !== undefined ? { location: entry.location } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }
  }

  /** Create one entry. Throws on alias collision or invalid payload. */
  create(payload: HostPayload, allowSecretless = false): SshHostEntry {
    const alias = payload.alias?.trim()
    if (!alias) throw new Error('alias is required')
    const aliasError = validateAlias(alias)
    if (aliasError !== undefined) throw new Error(aliasError)
    const bodyError = validateHostPayload(payload, 'create', allowSecretless)
    if (bodyError !== undefined) throw new Error(bodyError)
    const file = this.load()
    if (file.hosts.some(entry => entry.alias === alias)) throw new Error(`alias '${alias}' already exists`)
    const now = Date.now()
    // validateHostPayload (create mode) above guarantees auth presence; this
    // explicit check narrows the type for the entry construction below.
    const auth = payload.auth
    if (auth === undefined) throw new Error('auth is required')
    const entry: SshHostEntry = {
      alias,
      host: payload.host.trim(),
      port: payload.port ?? 22,
      user: payload.user.trim(),
      auth: {
        kind: auth.kind,
        keyPath: auth.kind === 'key' ? (auth.keyPath?.trim() !== '' ? expandHome(auth.keyPath?.trim() ?? '') : undefined) : undefined,
        passphrase: auth.kind === 'key' ? auth.passphrase ?? undefined : undefined,
        password: auth.kind === 'password' ? auth.password : undefined,
        secretRef: auth.secretRef,
      },
      proxyJump: [...(payload.proxyJump ?? [])],
      description: payload.description?.trim() || undefined,
      environment: payload.environment?.trim() || undefined,
      tags: [...(payload.tags ?? [])].map(tag => tag.trim()).filter(tag => tag !== ''),
      location: payload.location?.trim() || undefined,
      createdAt: now,
      updatedAt: now,
    }
    // ProxyJump cycle guard: the new entry may complete a loop through
    // existing hosts (A -> B, B -> A) — reject before persisting.
    const cycle = findJumpCycle(alias, [...file.hosts, entry])
    if (cycle !== undefined) {
      throw new Error(`proxyJump cycle detected: ${cycle}`)
    }
    file.hosts.push(entry)
    this.save(file)
    return entry
  }

  /** Update the fields present in `patch`; unknown aliases throw. */
  update(alias: string, patch: Partial<HostPayload>, allowSecretless = false): SshHostEntry {
    const file = this.load()
    const entry = file.hosts.find(candidate => candidate.alias === alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found`)
    // Partial-patch validation: only the present fields are checked (a
    // caller may update just tags without resending host/user), but every
    // present field follows the same rules as create.
    const patchError = validateHostPayload(patch, 'patch', allowSecretless)
    if (patchError !== undefined) throw new Error(patchError)
    if (patch.host !== undefined) entry.host = patch.host.trim()
    if (patch.port !== undefined) entry.port = patch.port
    if (patch.user !== undefined) entry.user = patch.user.trim()
    if (patch.auth !== undefined) {
      const auth = patch.auth
      // A changed key path with no passphrase means the new key has none;
      // only keep the old passphrase when the key path is unchanged.
      const keyChanged = auth.kind === 'key'
        && auth.keyPath !== undefined
        && expandHome(auth.keyPath.trim()) !== entry.auth.keyPath
      entry.auth = {
        kind: auth.kind,
        keyPath: auth.kind === 'key' ? (auth.keyPath?.trim() !== '' ? expandHome(auth.keyPath?.trim() ?? '') : undefined) : undefined,
        passphrase: auth.kind === 'key'
          ? (auth.passphrase !== undefined ? auth.passphrase : (keyChanged ? undefined : entry.auth.passphrase))
          : undefined,
        password: auth.kind === 'password' ? auth.password : undefined,
        // Keep the existing vault ref unless the patch supplies a new one
        // or the key changed (a plain auth edit shouldn't silently lose
        // credential linkage, but a new key must not reuse the old secret).
        secretRef: auth.secretRef !== undefined ? auth.secretRef : (keyChanged ? undefined : entry.auth.secretRef),
      }
    }
    if (patch.proxyJump !== undefined) {
      entry.proxyJump = [...patch.proxyJump]
      // Guard the full graph with the patched entry in place; a loop through
      // other hosts must reject before the file is written.
      const cycle = findJumpCycle(alias, file.hosts)
      if (cycle !== undefined) {
        throw new Error(`proxyJump cycle detected: ${cycle}`)
      }
    }
    if (patch.description !== undefined) entry.description = patch.description.trim() || undefined
    if (patch.environment !== undefined) entry.environment = patch.environment.trim() || undefined
    if (patch.tags !== undefined) entry.tags = [...patch.tags].map(tag => tag.trim()).filter(tag => tag !== '')
    if (patch.location !== undefined) entry.location = patch.location.trim() || undefined
    entry.updatedAt = Date.now()
    this.save(file)
    return entry
  }

  /** Remove one entry. */
  delete(alias: string): void {
    const file = this.load()
    const index = file.hosts.findIndex(candidate => candidate.alias === alias)
    if (index < 0) throw new Error(`alias '${alias}' not found`)
    file.hosts.splice(index, 1)
    this.save(file)
  }

  /**
   * Import hosts from `~/.ssh/config`: Host blocks with a single non-wildcard
   * pattern and a HostName become entries (key auth via IdentityFile, jump
   * hosts via ProxyJump). Existing aliases are skipped.
   * @returns import statistics.
   */
  importFromSshConfig(): ImportResult {
    // Per-run statistics: a later import must not report earlier runs' skips.
    this.skippedNames = new Set<string>()
    const configPath = this.sshConfigOverride ?? sshConfigPath()
    if (!existsSync(configPath)) return { parsed: 0, added: 0, skipped: 0, skippedNames: [] }
    const lines = readFileSync(configPath, 'utf8').split(/\r?\n/)
    const blocks: { pattern: string; props: Record<string, string> }[] = []
    let current: { pattern: string; props: Record<string, string> } | undefined
    const skip = (name: string, seen: Set<string>): void => {
      if (name !== '' && !seen.has(name)) {
        seen.add(name)
        this.skippedNames.add(name)
      }
    }
    for (const raw of lines) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const match = /^([A-Za-z0-9_\-]+)\s+(.+)$/.exec(line)
      if (match === null) continue
      const key = match[1].toLowerCase()
      const value = match[2].trim()
      if (key === 'host') {
        current = { pattern: value, props: {} }
        blocks.push(current)
      } else if (current !== undefined) {
        current.props[key] = value
      }
    }
    let added = 0
    for (const block of blocks) {
      const pattern = block.pattern.split(/\s+/)[0]
      if (pattern.includes('*') || pattern.includes('?')) {
        skip(pattern, this.skippedNames)
        continue
      }
      const hostName = block.props.hostname
      if (hostName === undefined || hostName === '') {
        skip(pattern, this.skippedNames)
        continue
      }
      const existing = this.list().some(entry => entry.alias === pattern)
      if (existing) {
        skip(pattern, this.skippedNames)
        continue
      }
      const payload: HostPayload = {
        alias: pattern,
        host: hostName,
        port: block.props.port !== undefined ? Number.parseInt(block.props.port, 10) : 22,
        user: block.props.user ?? process.env.USER ?? 'root',
        auth: {
          kind: block.props.identityfile !== undefined ? 'key' : 'password',
          keyPath: block.props.identityfile,
          password: block.props.password,
        },
        proxyJump: block.props.proxyjump !== undefined
          ? block.props.proxyjump.split(',').map(hop => hop.trim()).filter(hop => hop !== '')
          : [],
        description: block.props.description,
        environment: block.props.environment,
        tags: (block.props.tags ?? '').split(',').map(tag => tag.trim()).filter(tag => tag !== ''),
        location: block.props.location,
      }
      try {
        this.create(payload)
        added += 1
      } catch {
        // Unusable entry (bad alias grammar etc.) — count as skipped.
        skip(pattern, this.skippedNames)
      }
    }
    return { parsed: blocks.length, added, skipped: this.skippedNames.size, skippedNames: [...this.skippedNames] }
  }

  private skippedNames = new Set<string>()

  private load(): StoreFile {
    if (!existsSync(this.path)) return { version: FORMAT_VERSION, hosts: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile
      if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.hosts)) {
        throw new Error('store file shape invalid')
      }
      return parsed
    } catch {
      // A corrupt store must not brick the plugin — and must not be silently
      // overwritten by the next save: rename it aside for manual recovery
      // (the plugin then starts from an empty list).
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`)
      } catch { /* best effort */ }
      return { version: FORMAT_VERSION, hosts: [] }
    }
  }

  private save(file: StoreFile): void {
    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = this.path + '.tmp'
    // Secrets live in this file: keep it readable by the owner only. The
    // tmp file carries the 0600 mode through the rename.
    writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.path)
  }
}

/** Expand a leading `~` in a filesystem path. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Resolved authentication for one connect (vault-aware). */
export interface ResolvedAuth {
  kind: SshAuthKind
  keyPath?: string
  password?: string
  passphrase?: string
}

/**
 * Secure host store: composes the plaintext HostStore (host/port/user/… +
 * key paths — non-secrets) with the credential handling chosen by
 * `secretStorage`:
 *
 * - **'vault'**: passwords/passphrases are stored encrypted in the
 *   credential vault (AES-256-GCM); the hosts file keeps only a `secretRef`,
 *   and resolveAuth reveals on demand. For headless agents running password
 *   hosts unattended.
 *
 * - **'none' (default, VSCode Remote-SSH style)**: secrets are NEVER
 *   persisted. create/update strip the password/passphrase from the entry
 *   (kind + keyPath stay); the engine prompts once per session and holds the
 *   credential in-memory (session password table). The plaintext HostStore
 *   remains untouched, so existing v1 tests and dual-format reads keep
 *   working.
 */
export class SecureHostStore {
  private readonly inner: HostStore

  constructor(
    private readonly vault: import('./vault.ts').Vault | undefined,
    path?: string,
    sshConfigOverride?: string,
    private readonly mode: 'none' | 'vault' = 'none',
  ) {
    this.inner = new HostStore(path, sshConfigOverride)
  }

  list(): SshHostEntry[] { return this.inner.list() }
  find(alias: string): SshHostEntry | undefined { return this.inner.find(alias) }
  summarize(entry: SshHostEntry): SshHostSummary { return this.inner.summarize(entry) }
  get path(): string { return this.inner.path }
  /** Legacy ssh-config import (delegates; passwords imported stay inline —
   *  a follow-up may route them through the vault). */
  importFromSshConfig(): ImportResult { return this.inner.importFromSshConfig() }

  /** Create: secrets are stashed per mode; entry only keeps kind (+ keyPath). */
  async create(payload: HostPayload): Promise<SshHostEntry> {
    // Validate the raw wire input first. In 'none' mode a password-kind host
    // may omit the password (typed at connect time, VSCode-style); 'vault'
    // mode keeps the strict rule so every credential gets stashed.
    const rawError = validateHostPayload(payload, 'create', this.mode === 'none')
    if (rawError !== undefined) throw new Error(rawError)
    const ref = await this.stashSecrets(payload.alias ?? '', payload.auth)
    const entry = this.inner.create(stripSecrets(payload, ref, this.mode), true)
    return entry
  }

  /** Update: auth present -> re-stash (or strip in none mode); absent → keep. */
  async update(alias: string, patch: Partial<HostPayload>): Promise<SshHostEntry> {
    const existing = this.inner.find(alias)
    if (patch.auth === undefined || existing === undefined) {
      return this.inner.update(alias, patch)
    }
    const rawError = validateHostPayload(patch, 'patch', this.mode === 'none')
    if (rawError !== undefined) {
      // 'vault' mode: a password-kind patch without a password is acceptable
      // when the existing entry already holds a secretRef — the user edited
      // other fields without retyping the credential.
      const keepOldRef = this.mode === 'vault'
        && patch.auth.kind === 'password'
        && (patch.auth.password === undefined || patch.auth.password === '')
        && existing.auth.secretRef !== undefined
      if (!keepOldRef) throw new Error(rawError)
    }
    const ref = await this.stashSecrets(alias, patch.auth)
    const effectiveRef = ref ?? (this.mode === 'vault' ? existing.auth.secretRef : undefined)
    return this.inner.update(alias, stripSecrets(patch, effectiveRef, this.mode), true)
  }

  /** Delete: drop the host (and its vault secrets in vault mode, best-effort). */
  async delete(alias: string): Promise<void> {
    const entry = this.inner.find(alias)
    if (entry !== undefined && entry.auth.secretRef !== undefined && this.vault !== undefined) {
      await this.vault.remove(entry.auth.secretRef).catch(() => undefined)
    }
    this.inner.delete(alias)
  }

  /** Resolve the authentication for one entry (vault reveal when needed). */
  async resolveAuth(entry: SshHostEntry): Promise<ResolvedAuth> {
    if (this.mode === 'vault' && entry.auth.secretRef !== undefined && this.vault !== undefined) {
      const secret = await this.vault.reveal(entry.auth.secretRef)
      if (entry.auth.kind === 'password') return { kind: 'password', password: secret }
      return { kind: 'key', keyPath: entry.auth.keyPath, passphrase: secret !== '' ? secret : undefined }
    }
    // Plaintext fallback (v1 store / tests) — reachable in none mode only
    // when an entry still carries inline secrets (legacy v1 file).
    return { kind: entry.auth.kind, keyPath: entry.auth.keyPath, password: entry.auth.password, passphrase: entry.auth.passphrase }
  }

  private async stashSecrets(alias: string, auth: HostPayload['auth']): Promise<string | undefined> {
    if (this.mode !== 'vault' || this.vault === undefined) return undefined
    if (auth === undefined) return undefined
    if (auth.kind === 'key') {
      if (auth.passphrase !== undefined && auth.passphrase !== '') {
        return this.vault.store('host.passphrase', alias, auth.passphrase)
      }
      return undefined // key without passphrase needs no stash
    }
    if (auth.password !== undefined && auth.password !== '') {
      return this.vault.store('host.password', alias, auth.password)
    }
    return undefined
  }
}

/** Strip secrets from a payload according to mode + stored ref.
 *  - vault mode with ref: carry the ref, drop plaintext.
 *  - none mode: drop the plaintext (never persist), keep kind + keyPath. */
function stripSecrets<T extends HostPayload | Partial<HostPayload>>(payload: T, ref: string | undefined, mode: 'none' | 'vault'): T {
  if (payload.auth === undefined) return payload
  const auth = payload.auth
  if (mode === 'vault' && ref !== undefined) {
    return {
      ...payload,
      auth: auth.kind === 'key'
        ? { kind: 'key' as const, keyPath: auth.keyPath, secretRef: ref }
        : { kind: 'password' as const, secretRef: ref },
    } as T
  }
  // none mode (or no ref available): keep kind + keyPath, drop password/passphrase.
  if (auth.kind === 'key') {
    return { ...payload, auth: { kind: 'key' as const, keyPath: auth.keyPath } } as T
  }
  return { ...payload, auth: { kind: 'password' as const } } as T
}
