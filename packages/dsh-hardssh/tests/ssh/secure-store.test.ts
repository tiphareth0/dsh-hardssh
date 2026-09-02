/**
 * SecureHostStore tests: secretStorage='none' (VSCode Remote-SSH style —
 * passwords NEVER persisted; kind + keyPath kept, secrets dropped) and
 * secretStorage='vault' (encrypted at rest via secretRef). No network.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
      auth: { kind: 'key', keyPath: '/home/u/.ssh/id_ed25519', passphrase: 'pp-secret' },
    })
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('id_ed25519')      // keyPath is a non-secret, kept
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
})