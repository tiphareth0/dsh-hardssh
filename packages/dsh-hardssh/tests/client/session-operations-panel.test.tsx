// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshApi } from '../../src/client/ssh/api.ts'
import type { SessionSshTarget, SessionSshTargetSource } from '../../src/client/ssh/session-target.ts'

vi.mock('../../src/client/ssh/panel/TerminalTab.tsx', () => ({
  TerminalTab: ({ alias }: { alias: string }) => <div data-test="terminal" data-alias={alias} />,
}))
vi.mock('../../src/client/ssh/panel/TransferTab.tsx', () => ({
  TransferTab: ({ alias, remoteRoot }: { alias: string; remoteRoot: string }) => <div data-test="transfer" data-alias={alias} data-root={remoteRoot} />,
}))
vi.mock('../../src/client/ssh/panel/TunnelsTab.tsx', () => ({
  TunnelsTab: ({ alias }: { alias: string }) => <div data-test="tunnels" data-alias={alias} />,
}))
vi.mock('../../src/client/ssh/panel/ClusterTab.tsx', () => ({
  ClusterTab: ({ alias }: { alias: string }) => <div data-test="cluster" data-alias={alias} />,
}))

import { SshPanel } from '../../src/client/ssh/panel/SshPanel.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function targetSource(initial: SessionSshTarget | null) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const source: SessionSshTargetSource = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    source,
    publish(next: SessionSshTarget | null) {
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

const roots: Array<ReturnType<typeof createRoot>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  document.body.innerHTML = ''
})

async function renderPanel(source: SessionSshTargetSource): Promise<HTMLDivElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => { root.render(<SshPanel api={{} as SshApi} target={source} />) })
  return host
}

describe('SshPanel session target', () => {
  it('mounts no operation body and shows the local-session mask', async () => {
    const target = targetSource(null)
    const host = await renderPanel(target.source)
    expect(host.querySelector('[data-session-mode="local"]')).not.toBeNull()
    expect(host.textContent).toContain('当前会话位于本地工作区')
    expect(host.querySelector('[data-test="terminal"]')).toBeNull()
  })

  it('follows the Session target and passes its fixed alias to every tab', async () => {
    const target = targetSource(null)
    const host = await renderPanel(target.source)
    await act(async () => {
      target.publish({ sessionId: 's1', workspaceId: 'w1', alias: 'prod', remoteRoot: '/srv/app' })
    })

    expect(host.querySelector('[data-session-alias="prod"]')).not.toBeNull()
    expect(host.querySelector('[data-test="terminal"]')?.getAttribute('data-alias')).toBe('prod')
    expect(host.textContent).toContain('prod · /srv/app')

    const transfer = [...host.querySelectorAll('button[role="tab"]')].find(button => button.textContent === '传输')
    expect(transfer).toBeDefined()
    await act(async () => { (transfer as HTMLButtonElement).click() })
    expect(host.querySelector('[data-test="transfer"]')?.getAttribute('data-alias')).toBe('prod')
    expect(host.querySelector('[data-test="transfer"]')?.getAttribute('data-root')).toBe('/srv/app')

    await act(async () => {
      target.publish({ sessionId: 's2', workspaceId: 'w2', alias: 'lab', remoteRoot: '/lab' })
    })
    expect(host.querySelector('[data-session-alias="lab"]')).not.toBeNull()
    expect(host.querySelector('[data-test="transfer"]')?.getAttribute('data-alias')).toBe('lab')
  })
})
