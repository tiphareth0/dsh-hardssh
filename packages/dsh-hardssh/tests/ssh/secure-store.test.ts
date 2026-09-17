/**
 * SecureHostStore tests: secretStorage='none' (VSCode Remote-SSH style —
 * passwords NEVER persisted; kind + keyPath kept, secrets dropped) and
 * secretStorage='vault' (encrypted at rest via secretRef). No network.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecureHostStore } from '../../src/ssh/store.ts'
import { Vault } from '../../src/ssh/vault.ts'
import type { HostPayload } from '../../src/ssh/protocol.ts'

const dirs: string[] = []

function makeStore(mode: 'none' | 'vault'): { store: SecureHostStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-secure-'))
  dirs.push(dir)
  const path = join(dir, 'hosts.json')
  const vault = mode === 'vault' ? new Vault(join(dir, 'vault.json')) : undefined
  const store = new SecureHostStore(vault, path, undefined, mode)
  return { store, path }
}

/** Vault-mode store with the unlocked vault exposed for transaction assertions. */
async function makeVaultStore(): Promise<{ store: SecureHostStore; vault: Vault; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-secure-tx-'))
  dirs.push(dir)
  const path = join(dir, 'hosts.json')
  const vault = new Vault(join(dir, 'vault.json'))
  await vault.unlock('test-master')
  return { store: new SecureHostStore(vault, path, undefined, 'vault'), vault, path }
}

const passwordPayload: HostPayload = {
  alias: 'web-01',
  host: '192.168.1.10',
  port: 22,
  user: 'root',
  auth: { kind: 'password', password: 's3cret!' },
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SecureHostStore (none mode — VSCode Remote-SSH style)', () => {
  it('creates an entry WITHOUT persisting the password', async () => {
    const { store, path } = makeStore('none')
    const entry = await store.create(passwordPayload)
    // The in-memory entry may carry the password before stripping; the
    // PERSISTED file must never contain it.
    expect(entry.auth.kind).toBe('password')
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('s3cret!')
  })

  it('resolveAuth in none mode falls back to inline (legacy v1) or empty', async () => {
    const { store } = makeStore('none')
    const entry = await store.create(passwordPayload)
    // After create, the persisted entry has no password (none mode strips it).
    const resolved = await store.resolveAuth(entry)
    expect(resolved.kind).toBe('password')
    expect(resolved.password).toBeUndefined()
  })

  it('update in none mode also strips secrets from disk', async () => {
    const { store, path } = makeStore('none')
    await store.create(passwordPayload)
    await store.update('web-01', { auth: { kind: 'password', password: 'new-secret' } })
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('new-secret')
    expect(raw).not.toContain('s3cret!')
  })

  it('key auth keeps keyPath but never persists a passphrase', async () => {
    const { store, path } = makeStore('none')
    await store.create({
      alias: 'keyhost',
      host: 'h',
      port: 22,
      user: 'u',
      auth: { kind: 'key', keyPath: '/home/u/keys/project-key', passphrase: 'pp-secret' },
    })
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('project-key')     // keyPath is a non-secret, kept
    expect(raw).not.toContain('pp-secret')   // passphrase never persisted
  })

  it('agent-only key host (empty keyPath) is accepted in none mode and stored without a keyPath', async () => {
    const { store, path } = makeStore('none')
    const entry = await store.create({
      alias: 'agent-host',
      host: 'h',
      port: 22,
      user: 'u',
      auth: { kind: 'key', keyPath: '', passphrase: '' },
    })
    expect(entry.auth.kind).toBe('key')
    expect(entry.auth.keyPath).toBeUndefined()   // normalized: "use the ssh-agent"
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('agent-host')
    expect(raw).not.toContain('keyPath')
  })

  it('imports ssh-config passwords through the secure create path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-import-none-'))
    dirs.push(dir)
    const path = join(dir, 'hosts.json')
    const configPath = join(dir, 'ssh-config')
    writeFileSync(configPath, [
      'Host imported-none',
      '  HostName 192.0.2.10',
      '  User deploy',
      '  Password import-secret-none',
      '',
    ].join('\n'), 'utf8')
    const store = new SecureHostStore(undefined, path, configPath, 'none')

    await expect(store.importFromSshConfig()).resolves.toEqual({
      parsed: 1,
      added: 1,
      skipped: 0,
      skippedNames: [],
    })
    expect(store.find('imported-none')?.auth.password).toBeUndefined()
    expect(readFileSync(path, 'utf8')).not.toContain('import-secret-none')
  })
})

describe('SecureHostStore (vault mode — encrypted at rest)', () => {
  it('persists a secretRef and stores the secret encrypted, not plaintext', async () => {
    const { store, path } = makeStore('vault')
    // Vault mode requires an unlocked vault before storing.
    // Access the vault instance through a store where we pre-unlocked:
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-vaultm-'))
    dirs.push(dir)
    const vpath = join(dir, 'hosts.json')
    const vault = new Vault(join(dir, 'vault.json'))
    await vault.unlock('test-master')
    const vstore = new SecureHostStore(vault, vpath, undefined, 'vault')
    const entry = await vstore.create(passwordPayload)
    expect(entry.auth.kind).toBe('password')
    expect(entry.auth.secretRef).toBeDefined()
    const raw = readFileSync(vpath, 'utf8')
    expect(raw).not.toContain('s3cret!')
    // Decrypted value round-trips via resolveAuth.
    const resolved = await vstore.resolveAuth(entry)
    expect(resolved.password).toBe('s3cret!')
  })

  it('rolls back the staged secret when host create fails (no orphan refs)', async () => {
    const { store, vault } = await makeVaultStore()
    await store.create(passwordPayload)
    const before = vault.status().entries
    // Duplicate alias: the stash happens first, the host write rejects.
    await expect(store.create(passwordPayload)).rejects.toThrow(/already exists/)
    expect(vault.status().entries).toBe(before)
  })

  it('rolls back the staged secret when host update fails and keeps the old credential', async () => {
    const { store, vault } = await makeVaultStore()
    const entry = await store.create(passwordPayload)
    const before = vault.status().entries
    // A self-referential proxyJump fails validation inside HostStore.update,
    // i.e. AFTER the new secret was staged.
    await expect(store.update('web-01', {
      auth: { kind: 'password', password: 'new-secret' },
      proxyJump: ['web-01'],
    })).rejects.toThrow(/cycle/i)
    expect(vault.status().entries).toBe(before)
    expect((await store.resolveAuth(store.find('web-01')!)).password).toBe('s3cret!')
    expect(store.find('web-01')!.auth.secretRef).toBe(entry.auth.secretRef)
  })

  it('removes the superseded secret after a successful credential replacement', async () => {
    const { store, vault } = await makeVaultStore()
    const entry = await store.create(passwordPayload)
    const oldRef = entry.auth.secretRef!
    await store.update('web-01', { auth: { kind: 'password', password: 'new-secret' } })
    expect(vault.status().entries).toBe(1)
    await expect(vault.reveal(oldRef)).rejects.toMatchObject({ code: 'VAULT_MISSING' })
    expect((await store.resolveAuth(store.find('web-01')!)).password).toBe('new-secret')
  })

  it('never reinterprets an old password secret as a key passphrase', async () => {
    const { store, vault } = await makeVaultStore()
    const entry = await store.create(passwordPayload)
    await store.update('web-01', { auth: { kind: 'key', keyPath: '/home/u/keys/project-key' } })
    expect(store.find('web-01')!.auth.secretRef).toBeUndefined()
    expect(vault.status().entries).toBe(0)
    await expect(vault.reveal(entry.auth.secretRef!)).rejects.toMatchObject({ code: 'VAULT_MISSING' })
  })

  it('deletes the host before cleaning the secret and defers a failed cleanup', async () => {
    const { store, vault } = await makeVaultStore()
    const entry = await store.create(passwordPayload)
    const ref = entry.auth.secretRef!
    // A locked vault cannot delete: the host deletion must still commit, and
    // the failure is deferred instead of leaving a live host with no secret.
    vault.lock()
    await expect(store.delete('web-01')).resolves.toBeUndefined()
    expect(store.find('web-01')).toBeUndefined()
    expect(store.pendingSecretCleanupRefs()).toEqual([ref])

    await vault.unlock('test-master')
    await store.create({ ...passwordPayload, alias: 'web-02' })
    expect(store.pendingSecretCleanupRefs()).toEqual([])
    await expect(vault.reveal(ref)).rejects.toMatchObject({ code: 'VAULT_MISSING' })
  })

  it('imports ssh-config passwords into the vault, never the hosts file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-import-vault-'))
    dirs.push(dir)
    const path = join(dir, 'hosts.json')
    const configPath = join(dir, 'ssh-config')
    writeFileSync(configPath, [
      'Host imported-vault',
      '  HostName 192.0.2.11',
      '  User deploy',
      '  Password import-secret-vault',
      '',
    ].join('\n'), 'utf8')
    const vault = new Vault(join(dir, 'vault.json'))
    await vault.unlock('test-master')
    const store = new SecureHostStore(vault, path, configPath, 'vault')

    const result = await store.importFromSshConfig()
    expect(result).toEqual({ parsed: 1, added: 1, skipped: 0, skippedNames: [] })
    const entry = store.find('imported-vault')!
    expect(entry.auth.secretRef).toBeDefined()
    expect(readFileSync(path, 'utf8')).not.toContain('import-secret-vault')
    await expect(store.resolveAuth(entry)).resolves.toMatchObject({ password: 'import-secret-vault' })
  })
})