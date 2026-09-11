/**
 * C-04: `secretStorage` must have ONE source of truth. The mode is decided
 * once from the plugin config — that is what constructs the Vault and the
 * SecureHostStore — while the `dsh-ssh` settings namespace still exposes the
 * key for the settings UI. A disagreement must be reported (reload required +
 * the mode actually running), never silently accepted.
 *
 * NOTE: the namespace schema itself lives in src/ssh/plugin.ts, which this
 * suite must not change; the last test pins the fact that it still exposes the
 * key, i.e. why the runtime drift report is required.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, resolveSecretStorageMode, secretStorageDriftMessage, watchSecretStorageDrift } from '../src/index.ts'
import { SSH_SETTINGS_NAMESPACE, SshConfig } from '../src/ssh/plugin.ts'

describe('resolveSecretStorageMode (single source)', () => {
  it('defaults to none and accepts only the explicit vault value', () => {
    expect(resolveSecretStorageMode(undefined)).toBe('none')
    expect(resolveSecretStorageMode({})).toBe('none')
    expect(resolveSecretStorageMode({ secretStorage: 'none' })).toBe('none')
    expect(resolveSecretStorageMode({ secretStorage: 'vault' })).toBe('vault')
    expect(resolveSecretStorageMode({ secretStorage: 'VAULT' })).toBe('none')
    expect(resolveSecretStorageMode({ secretStorage: 42 })).toBe('none')
  })

  it('is the value the plugin Config schema resolves', () => {
    expect(Config({}).secretStorage).toBe('none')
    expect(Config({ secretStorage: 'vault' }).secretStorage).toBe('vault')
  })
})

describe('secretStorageDriftMessage', () => {
  it('stays silent when the runtime namespace agrees', () => {
    expect(secretStorageDriftMessage('none', { secretStorage: 'none' })).toBeUndefined()
    expect(secretStorageDriftMessage('vault', { secretStorage: 'vault' })).toBeUndefined()
  })

  it('stays silent when the section carries no usable value', () => {
    expect(secretStorageDriftMessage('none', undefined)).toBeUndefined()
    expect(secretStorageDriftMessage('none', {})).toBeUndefined()
    expect(secretStorageDriftMessage('none', { secretStorage: 'nope' })).toBeUndefined()
    expect(secretStorageDriftMessage('none', 'vault')).toBeUndefined()
  })

  it('reports the request, the reload requirement and the RUNNING mode', () => {
    const message = secretStorageDriftMessage('none', { secretStorage: 'vault' })
    expect(message).toBeDefined()
    expect(message).toContain("resolves to 'vault'")
    expect(message).toContain("running 'none'")
    expect(message).toContain('is ignored')
    expect(message).toContain('reload the plugin')
    expect(message).toContain("set secretStorage: 'vault'")
  })

  it('reports the opposite direction too (UI off, process on)', () => {
    const message = secretStorageDriftMessage('vault', { secretStorage: 'none' })
    expect(message).toContain("resolves to 'none'")
    expect(message).toContain("running 'vault'")
  })
})

describe('watchSecretStorageDrift (apply wiring)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Plugin-like ctx: a child of the root with a settings service provided. */
  function harness(running: 'none' | 'vault', resolved: unknown): { ctx: Context; emitFrom: (section: unknown) => void; warn: ReturnType<typeof vi.spyOn> } {
    const root = new Context()
    const ctx = root.extend()
    ctx.provide('settings', { get: (ns: string) => (ns === SSH_SETTINGS_NAMESPACE ? resolved : undefined) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    watchSecretStorageDrift(ctx, running)
    // The settings service is a sibling context: emit the way it does.
    const settingsCtx = root.extend()
    return { ctx, emitFrom: (section) => settingsCtx.emit('settings/updated', SSH_SETTINGS_NAMESPACE, section, {}, 'provider'), warn }
  }

  it('warns at mount when the namespace disagrees with the running mode', () => {
    const { warn } = harness('none', { secretStorage: 'vault' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("running 'none'")
  })

  it('stays silent when they agree', () => {
    const { warn } = harness('vault', { secretStorage: 'vault' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('re-checks on every committed settings change from a sibling context', () => {
    const { emitFrom, warn } = harness('none', { secretStorage: 'none' })
    expect(warn).not.toHaveBeenCalled()
    emitFrom({ secretStorage: 'vault' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("resolves to 'vault'")
  })

  it('deduplicates a repeated identical drift', () => {
    const { emitFrom, warn } = harness('none', { secretStorage: 'vault' })
    expect(warn).toHaveBeenCalledTimes(1)
    emitFrom({ secretStorage: 'vault' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('ignores other namespaces', () => {
    const root = new Context()
    const ctx = root.extend()
    ctx.provide('settings', { get: () => ({ secretStorage: 'none' }) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    watchSecretStorageDrift(ctx, 'none')
    root.emit('settings/updated', 'other-namespace', { secretStorage: 'vault' }, {}, 'provider')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('the settings namespace does NOT expose secretStorage (single source)', () => {
  it('keeps the key out of the dsh-ssh namespace schema', () => {
    expect(SSH_SETTINGS_NAMESPACE).toBe('dsh-ssh')
    // The mode is decided at plugin load from the top-level plugin config, so
    // offering it here would be a placebo; a hand-set namespace value is
    // reported as drift instead of being applied.
    // The schema no longer DECLARES the key (no default, no UI field)...
    expect(SshConfig({}).secretStorage).toBeUndefined()
    // ...and schemastery passes a hand-set value through untouched, which is
    // exactly the input the runtime drift reporter consumes.
    expect((SshConfig({ secretStorage: 'vault' } as never) as { secretStorage?: string }).secretStorage).toBe('vault')
    expect(secretStorageDriftMessage('none', { secretStorage: 'vault' })).toContain('is ignored')
  })
})
