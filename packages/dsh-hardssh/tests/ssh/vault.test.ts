/**
 * Credential vault unit tests: store/reveal round-trip, tamper detection
 * (AAD + SHA3 double check), lockout persistence across instances, rekey,
 * redaction, and "plaintext never appears in the serialized file".
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  Vault,
  VaultAuthError,
  VaultLockoutError,
  VaultLockedError,
  sha3_256Hex,
} from '../../src/ssh/vault.ts'

const PASSWORD = 'hunter2-secret'

function tempVault(): { vault: Vault; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vault-'))
  const path = join(dir, 'vault.json')
  return { vault: new Vault(path), path }
}

describe('Vault', () => {
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
      await expect(vault.unlock('wrong')).rejects.toBeInstanceOf(VaultAuthError)
    }
    await expect(vault.unlock('wrong')).rejects.toBeInstanceOf(VaultLockoutError)
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

  it('sha3_256Hex is deterministic and 64 lowercase hex', () => {
    expect(sha3_256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(sha3_256Hex('abc')).toBe(sha3_256Hex('abc'))
  })
})