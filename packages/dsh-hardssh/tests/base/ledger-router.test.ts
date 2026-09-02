/**
 * LedgerWorkspaceRouter tests: generic routing over the ledger + registry,
 * proving the switch facades can be driven purely through the base without
 * any SSH branch. Uses the LOCAL provider as the concrete backing — a
 * non-SSH provider routed through the same machinery the SSH provider uses.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceProviderRegistry } from '../../src/base/registry.ts'
import { WorkspaceLedger } from '../../src/base/ledger.ts'
import { LedgerWorkspaceRouter } from '../../src/base/ledger-router.ts'
import { createLocalWorkspaceProvider } from '../../src/providers/local/provider.ts'
import type { WorkspaceRecord } from '../../src/base/model.ts'

function recordIn(dir: string, id: string): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id,
    title: `ws ${id}`,
    provider: { id: 'local' },
    location: { kind: 'native', root: dir },
    anchor: { path: join(dir, 'anchor'), mode: 'managed' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('LedgerWorkspaceRouter', () => {
  it('routes a namespaced key to the owning connection (wfs format)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-'))
    const ledger = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
    const providers = new WorkspaceProviderRegistry()
    providers.register(createLocalWorkspaceProvider())
    await ledger.create(recordIn(dir, 'ws-1'))

    const router = new LedgerWorkspaceRouter(ledger, {
      listWorkspaces: () => ledger.list(),
      subscribe: (listener) => ledger.subscribe(change => listener(change.record)),
      register: (provider) => providers.register(provider),
      provider: (id) => providers.get(id),
      providers: () => providers.list(),
    }, {
      open: async (record) => {
        const provider = providers.get(record.provider.id)
        return provider === undefined ? undefined : provider.open(record)
      },
    })

    // Pre-open so the cwd anchor resolves (router's fromAnchor path).
    await router.ensureOpen(recordIn(dir, 'ws-1'))

    // Explicit wfs:// namespace resolves.
    const resolution = router.fromNamespace('wfs://ws-1/src/index.ts')
    expect(resolution).toBeDefined()
    expect(resolution?.connection.workspaceId).toBe('ws-1')
    expect(resolution?.rawKey).toBe('/src/index.ts')

    // Legacy ssh: form resolves through the same codec (compat window).
    const legacy = router.fromNamespace('ssh:ws-1:/old/path')
    expect(legacy).toBeDefined()
    expect(legacy?.connection.workspaceId).toBe('ws-1')

    // Unknown workspace fails closed.
    expect(router.fromNamespace('wfs://ghost/x')).toBeUndefined()
  })

  it('routes a session cwd inside an anchor to the owning connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'router-'))
    const ledger = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
    const providers = new WorkspaceProviderRegistry()
    providers.register(createLocalWorkspaceProvider())
    const record = recordIn(dir, 'ws-2')
    await ledger.create(record)
    await ledger.load()

    const router = new LedgerWorkspaceRouter(ledger, {
      listWorkspaces: () => ledger.list(),
      subscribe: (listener) => ledger.subscribe(change => listener(change.record)),
      register: (provider) => providers.register(provider),
      provider: (id) => providers.get(id),
      providers: () => providers.list(),
    }, {
      open: async (record) => {
        const provider = providers.get(record.provider.id)
        return provider === undefined ? undefined : provider.open(record)
      },
    })
    await router.ensureOpen(record)

    const connection = router.fromAnchor(record.anchor!.path)
    expect(connection?.workspaceId).toBe('ws-2')
    // Unbound cwd resolves to nothing (local fallback handled by the facade).
    expect(router.fromAnchor('/somewhere/else')).toBeUndefined()
  })
})