/** Focused provider registry event and disposer ownership tests. */

import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceProvider } from '../../src/base/model.ts'
import { ProviderRegistrationError, WorkspaceProviderRegistry } from '../../src/base/registry.ts'

/** Minimal provider fixture: the registry never opens or validates records. */
function memoryProvider(version = '1'): WorkspaceProvider {
  return {
    manifest: { id: 'memory', version, apiVersion: 2, displayName: 'memory', capabilities: [] },
    // WorkspaceLedger validation cannot check provider-owned refs, so this registry-only fixture accepts records.
    validate: () => undefined,
    // WorkspaceProviderRegistry.register() does not open workspaces, so this unreachable fixture method documents that boundary.
    open: async () => { throw new Error('not opened') },
  }
}

describe('WorkspaceProviderRegistry', () => {
  it('emits registration/unregistration and keeps duplicate disposer ownership isolated', () => {
    const registry = new WorkspaceProviderRegistry()
    const events: string[] = []
    const unsubscribe = registry.subscribe(change => events.push(`${change.type}:${change.provider.manifest.id}`))
    const provider: WorkspaceProvider = {
      manifest: { id: 'memory', version: '1', apiVersion: 2, displayName: 'memory', capabilities: [] },
      // WorkspaceLedger validation cannot check provider-owned refs, so this registry-only fixture accepts records.
      validate: () => undefined,
      // WorkspaceProviderRegistry.register() does not open workspaces, so this unreachable fixture method documents that boundary.
      open: async () => { throw new Error('not opened') },
    }
    const ownerDispose = registry.register(provider)
    const duplicateDispose = registry.register({ ...provider })
    duplicateDispose()
    expect(registry.get('memory')).toBe(provider)
    ownerDispose()
    expect(registry.get('memory')).toBeUndefined()
    expect(events).toEqual(['registered:memory', 'unregistered:memory'])
    unsubscribe()
    registry.register(provider)
    expect(events).toHaveLength(2)
  })

  it('isolates listener failures from lifecycle changes', () => {
    const registry = new WorkspaceProviderRegistry()
    registry.subscribe(() => { throw new Error('listener') })
    const provider: WorkspaceProvider = {
      manifest: { id: 'memory', version: '1', apiVersion: 2, displayName: 'memory', capabilities: [] },
      // WorkspaceLedger validation cannot check provider-owned refs, so this registry-only fixture accepts records.
      validate: () => undefined,
      // WorkspaceProviderRegistry.register() does not open workspaces, so this unreachable fixture method documents that boundary.
      open: vi.fn(async () => { throw new Error('not opened') }),
    }
    expect(() => registry.register(provider)).not.toThrow()
    expect(() => registry.unregister('memory')).not.toThrow()
  })

  it('makes every registration disposer own exactly the insertion it performed', () => {
    const registry = new WorkspaceProviderRegistry()
    const events: string[] = []
    registry.subscribe(change => events.push(`${change.type}:${change.provider.manifest.id}`))
    const provider = memoryProvider()

    const ownerDispose = registry.register(provider)
    const duplicateDispose = registry.register(provider)
    // A same-version duplicate inserts nothing, so releasing it must leave the
    // provider owned by the first registration in place (idempotently).
    duplicateDispose()
    duplicateDispose()
    expect(registry.get('memory')).toBe(provider)

    // The owner's disposer removes exactly once and is itself idempotent.
    ownerDispose()
    ownerDispose()
    expect(registry.get('memory')).toBeUndefined()
    expect(events).toEqual(['registered:memory', 'unregistered:memory'])

    // A stale disposer from an earlier registration must never remove a later
    // one: teardown of an old owner cannot steal the current owner's provider.
    const staleDispose = registry.register(provider)
    staleDispose()
    const freshDispose = registry.register(provider)
    staleDispose()
    expect(registry.get('memory')).toBe(provider)
    freshDispose()
    expect(registry.get('memory')).toBeUndefined()
  })

  it('refuses an incompatible duplicate without disturbing the registered provider', () => {
    const registry = new WorkspaceProviderRegistry()
    const provider = memoryProvider('1')
    registry.register(provider)
    expect(() => registry.register(memoryProvider('2'))).toThrow(ProviderRegistrationError)
    expect(registry.get('memory')).toBe(provider)
  })
})
