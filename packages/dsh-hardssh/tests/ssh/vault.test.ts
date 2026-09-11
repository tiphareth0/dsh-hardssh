/**
 * Credential vault unit tests: store/reveal round-trip, tamper detection
 * (AAD + SHA3 double check), lockout persistence across instances, rekey,
 * redaction, and "plaintext never appears in the serialized file".
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  Vault,
  VaultAuthError,
  VaultLockoutError,
  VaultLockedError,
  legacyVaultPath,
  migrateLegacyVault,
  sha3_256Hex,
  vaultPath,
  type VaultKdfParams,
} from '../../src/ssh/vault.ts'

const PASSWORD = 'hunter2-secret'

function tempVault(): { vault: Vault; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'))
  const path = join(dir, 'vault.json')
  return { vault: new Vault(path), path }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// scrypt (N=131072) is deliberately expensive and the lockout cases run up to
// five KDF derivations; under full-suite parallelism that exceeds the 5s default.
describe('Vault', { timeout: 60_000 }, () => {
  it('store/reveal round-trips and never writes plaintext to the file', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    const ref = await vault.store('host.password', 'web-01', 's3cret!')
    const revealed = await vault.reveal(ref)
    expect(revealed).toBe('s3cret!')
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('s3cret!')
    expect(raw).toContain('ciphertextB64')
    expect(JSON.parse(raw).meta.attempts).toBe(0)
  })

  it('rejects reveal while locked', async () => {
    const { vault } = tempVault()
    await expect(vault.reveal('vlt_x')).rejects.toBeInstanceOf(VaultLockedError)
  })

  it('detects ciphertext tampering (SHA3 integrity + GCM auth)', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    const ref = await vault.store('host.password', 'web-01', 'target')
    // Flip one character in the stored ciphertext.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { secrets: Array<{ ciphertextB64: string; sha3: string }> }
    const entry = raw.secrets.find((e: { ciphertextB64: string }) => e.ciphertextB64 !== '')
    expect(entry).toBeDefined()
    entry!.sha3 = entry!.sha3.startsWith('a') ? 'b' + entry!.sha3.slice(1) : 'a' + entry!.sha3.slice(1)
    writeFileSync(path, JSON.stringify(raw, null, 2))
    // The in-memory vault cached the old document; force reload via a new instance.
    const vault2 = new Vault(path)
    await vault2.unlock(PASSWORD)
    await expect(vault2.reveal(ref)).rejects.toThrow(/integrity|corrupt/i)
  })

  it('locks out after repeated failures and persists across instances', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    await vault.store('host.password', 'web-01', 'x')
    vault.lock()
    // The first 4 wrong passwords report VaultAuthError with remaining count;
    // the 5th wrong password reaches the threshold and locks out.
    for (let i = 0; i < 4; i += 1) {
      await expect(vault.unlock('wrong-password')).rejects.toBeInstanceOf(VaultAuthError)
    }
    await expect(vault.unlock('wrong-password')).rejects.toBeInstanceOf(VaultLockoutError)
    // A fresh instance still sees the lockout (persistent).
    const second = new Vault(path)
    await expect(second.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultLockoutError)
  })

  it('rekey invalidates the old password and preserves secrets', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    const ref = await vault.store('host.password', 'web-01', 'keepme')
    await vault.rekey('new-password-42')
    const after = new Vault(path)
    await after.unlock('new-password-42')
    expect(await after.reveal(ref)).toBe('keepme')
    // Old password no longer works.
    const third = new Vault(path)
    await expect(third.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultAuthError)
  })

  it('serializes unlock derivation and recovers the queue after a rejected mutation', async () => {
    const { vault, path } = tempVault()
    const internals = vault as unknown as {
      deriveKey: (password: string, kdf: VaultKdfParams) => Promise<Buffer>
    }
    const deriveKey = internals.deriveKey.bind(vault)
    const gate = deferred()
    let derivations = 0
    internals.deriveKey = async (password, kdf) => {
      derivations += 1
      if (derivations === 1) await gate.promise
      return deriveKey(password, kdf)
    }

    const first = vault.unlock(PASSWORD)
    await Promise.resolve()
    const second = vault.unlock('another-password')
    await Promise.resolve()
    expect(derivations).toBe(1)
    gate.resolve()
    await Promise.all([first, second])

    // The first invocation initialized the file; the queued second invocation
    // observed the already-unlocked state instead of racing a second verifier.
    vault.lock()
    const reopened = new Vault(path)
    await reopened.unlock(PASSWORD)

    // A failed mutation must not poison the queue tail.
    reopened.lock()
    const rejected = reopened.unlock('wrong-password')
    const accepted = reopened.unlock(PASSWORD)
    await expect(rejected).rejects.toBeInstanceOf(VaultAuthError)
    await expect(accepted).resolves.toBeUndefined()
  })

  it('queues store and remove behind an in-flight rekey without losing updates', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    const oldRef = await vault.store('host.password', 'old', 'remove-me')
    const internals = vault as unknown as {
      deriveKey: (password: string, kdf: VaultKdfParams) => Promise<Buffer>
    }
    const deriveKey = internals.deriveKey.bind(vault)
    const gate = deferred()
    let rekeyStarted = false
    internals.deriveKey = async (password, kdf) => {
      rekeyStarted = true
      await gate.promise
      return deriveKey(password, kdf)
    }

    const rekey = vault.rekey('new-password-42')
    await Promise.resolve()
    expect(rekeyStarted).toBe(true)
    const store = vault.store('host.password', 'new', 'keep-me')
    const remove = vault.remove(oldRef)
    let storeSettled = false
    void store.then(() => { storeSettled = true })
    await Promise.resolve()
    expect(storeSettled).toBe(false)

    gate.resolve()
    const [, newRef] = await Promise.all([rekey, store, remove])
    const reopened = new Vault(path)
    await reopened.unlock('new-password-42')
    expect(await reopened.reveal(newRef)).toBe('keep-me')
    await expect(reopened.reveal(oldRef)).rejects.toMatchObject({ code: 'VAULT_MISSING' })
  })

  it('redact masks leaked secrets and leaves others intact', async () => {
    const { vault } = tempVault()
    await vault.unlock(PASSWORD)
    const ref = await vault.store('host.password', 'web-01', 'topsecret')
    await vault.reveal(ref)
    const out = vault.redact('the topsecret is here and topsecret again')
    expect(out).not.toContain('topsecret')
    expect(out).toContain('[REDACTED]')
    expect(vault.redact('innocent text')).toBe('innocent text')
  })

  it('rejects a weak master password without consuming the lockout budget', async () => {
    const { vault, path } = tempVault()
    await expect(vault.unlock('short')).rejects.toMatchObject({ code: 'VAULT_PASSWORD_WEAK' })
    await expect(vault.unlock('   ')).rejects.toMatchObject({ code: 'VAULT_PASSWORD_WEAK' })
    // No verifier was written and no attempt was counted.
    expect(existsSync(path)).toBe(false)
    // The full lockout budget is still available for real wrong passwords.
    await vault.unlock(PASSWORD)
    vault.lock()
    for (let i = 0; i < 4; i += 1) await expect(vault.unlock('wrong-password')).rejects.toBeInstanceOf(VaultAuthError)
    await expect(vault.unlock('wrong-password')).rejects.toBeInstanceOf(VaultLockoutError)
  })

  it('rejects a weak rekey and keeps the old password and secrets usable', async () => {
    const { vault, path } = tempVault()
    await vault.unlock(PASSWORD)
    const ref = await vault.store('host.password', 'web-01', 'keepme')
    await expect(vault.rekey('short')).rejects.toMatchObject({ code: 'VAULT_PASSWORD_WEAK' })
    expect(await vault.reveal(ref)).toBe('keepme')
    const reopened = new Vault(path)
    await reopened.unlock(PASSWORD)
    expect(await reopened.reveal(ref)).toBe('keepme')
    const withNew = new Vault(path)
    await expect(withNew.unlock('new-password-42')).rejects.toBeInstanceOf(VaultAuthError)
  })

  it('idle-locks on inactivity and resets the deadline on activity', async () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'vault-idle-'))
      const path = join(dir, 'vault.json')
      const vault = new Vault(path, { idleLockMs: 1000 })
      await vault.unlock(PASSWORD)
      const ref = await vault.store('host.password', 'web-01', 's3cret!')

      // Activity shortly before the deadline extends the window.
      await vi.advanceTimersByTimeAsync(900)
      await vault.reveal(ref)
      await vi.advanceTimersByTimeAsync(900)
      expect(await vault.reveal(ref)).toBe('s3cret!')

      // Then inactivity really locks (and drops the redaction material).
      await vi.advanceTimersByTimeAsync(1000)
      await expect(vault.reveal(ref)).rejects.toBeInstanceOf(VaultLockedError)
      expect(vault.redact('s3cret!')).toBe('s3cret!')
    } finally {
      vi.useRealTimers()
    }
  })

  it('idleLockMs 0 disables auto-lock and lock/dispose cancel the timer', async () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'vault-noidle-'))
      const vault = new Vault(join(dir, 'vault.json'), { idleLockMs: 0 })
      await vault.unlock(PASSWORD)
      const ref = await vault.store('host.password', 'web-01', 's3cret!')
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
      expect(await vault.reveal(ref)).toBe('s3cret!')
      vault.lock()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
    expect(() => new Vault(join(mkdtempSync(join(tmpdir(), 'vault-bad-')), 'v.json'), { idleLockMs: -1 })).toThrow(/idleLockMs/)
  })

  it('sha3_256Hex is deterministic and 64 lowercase hex', () => {
    expect(sha3_256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(sha3_256Hex('abc')).toBe(sha3_256Hex('abc'))
  })
})

/**
 * P1-3: the vault ciphertext must not be reachable as an ordinary local file,
 * and env-based auto-unlock is an explicit opt-in rather than a default.
 */
describe('Vault credential surface (P1-3)', () => {
  it('lives outside the fs seam local roots and migrates a pre-relocation file', () => {
    // `~/.dsh/ssh-secrets/dsh-ssh-vault.json` — NOT `~/.dsh/dsh-ssh-vault.json`,
    // and the directory is passed to SwitchFileSystem.deniedRoots by fs.ts.
    expect(vaultPath()).toContain(join('.dsh', 'ssh-secrets'))
    expect(vaultPath()).not.toBe(legacyVaultPath())

    const dir = mkdtempSync(join(tmpdir(), 'vault-migrate-'))
    const legacy = join(dir, 'dsh-ssh-vault.json')
    const target = join(dir, 'ssh-secrets', 'dsh-ssh-vault.json')
    writeFileSync(legacy, '{"version":1}', { mode: 0o600 })

    expect(migrateLegacyVault(target, legacy)).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('{"version":1}')
    // Idempotent, and never clobbers an existing destination.
    expect(migrateLegacyVault(target, legacy)).toBe(false)
  })

  it('does not auto-unlock from DSH_CREDENTIAL_PASSWORD unless explicitly allowed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-env-'))
    const path = join(dir, 'vault.json')
    const created = new Vault(path)
    await created.unlock(PASSWORD)
    await created.store('host.password', 'web-01', 's3cret!')
    created.dispose()

    const previous = process.env.DSH_CREDENTIAL_PASSWORD
    process.env.DSH_CREDENTIAL_PASSWORD = PASSWORD
    try {
      const locked = new Vault(path)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(locked.status().locked).toBe(true)
      expect(locked.status().mode).toBe('password')
      locked.dispose()

      const opted = new Vault(path, { allowEnvUnlock: true })
      await vi.waitFor(() => { expect(opted.status().locked).toBe(false) })
      expect(opted.status().mode).toBe('env')
      opted.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_CREDENTIAL_PASSWORD
      else process.env.DSH_CREDENTIAL_PASSWORD = previous
    }
  })
})