// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceManager } from '../../src/client/state.ts'
import type { SshApi } from '../../src/client/ssh/api.ts'
import { WorkspaceManagerPanel } from '../../src/client/workspace-panel.tsx'
import { setLanguage } from '../../src/client/text.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('WorkspaceManagerPanel connection badges', () => {
  it('lists every configured server and reads pool state without connecting', async () => {
    setLanguage(true)
    const manager = {
      getSnapshot: () => ({ workspaces: [], error: null }),
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as WorkspaceManager
    const listHosts = vi.fn(async () => [
      { alias: 'prod', host: 'prod.example', port: 22, user: 'root' },
      { alias: 'lab', host: 'lab.example', port: 2222, user: 'dev' },
    ])
    const connectedAliases = vi.fn(async () => ['prod'])
    const testHost = vi.fn()
    const api = { listHosts, connectedAliases, testHost } as unknown as SshApi
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(<WorkspaceManagerPanel manager={manager} sshApi={api} />)
      await Promise.resolve()
    })

    expect(host.textContent).toContain('prod')
    expect(host.textContent).toContain('lab')
    expect(host.querySelector('[data-state="connected"]')?.textContent).toContain('已连接')
    expect(host.querySelector('[data-state="disconnected"]')?.textContent).toContain('未连接')
    expect(listHosts).toHaveBeenCalledTimes(1)
    expect(connectedAliases).toHaveBeenCalledTimes(1)
    expect(testHost).not.toHaveBeenCalled()
  })

  it('surfaces a connection-state read failure instead of silently showing "unknown"', async () => {
    setLanguage(true)
    const manager = {
      getSnapshot: () => ({ workspaces: [], error: null }),
      refresh: vi.fn(async () => undefined),
      subscribe: vi.fn(() => () => undefined),
    } as unknown as WorkspaceManager
    const api = {
      listHosts: vi.fn(async () => [{ alias: 'prod', host: 'prod.example', port: 22, user: 'root' }]),
      connectedAliases: vi.fn(async () => { throw new Error('connection-state route unavailable') }),
    } as unknown as SshApi
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)

    await act(async () => {
      root.render(<WorkspaceManagerPanel manager={manager} sshApi={api} />)
      await Promise.resolve()
    })

    const banner = host.querySelector('[data-test="connection-state-error"]')
    expect(banner).not.toBeNull()
    expect(banner?.textContent).toContain('connection-state route unavailable')
    // The badge still degrades to "unknown", but now the reason is visible.
    expect(host.querySelector('[data-state="unknown"]')).not.toBeNull()
  })
})
