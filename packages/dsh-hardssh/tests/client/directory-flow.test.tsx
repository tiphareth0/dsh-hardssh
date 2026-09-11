// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryFlow, type DirectoryFlowInjected } from '../../src/client/directory-flow.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const host = (alias: string) => ({ alias, host: `${alias}.example`, port: 22, user: 'root' })

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DirectoryFlow request sequencing', () => {
  it('ignores stale host/directory results and disables path-changing controls while browsing', async () => {
    const firstHosts = deferred<ReturnType<typeof host>[]>()
    const secondHosts = deferred<ReturnType<typeof host>[]>()
    const pendingDirectory = deferred<{ path: string; entries: [] }>()
    const listHosts = vi.fn()
      .mockReturnValueOnce(firstHosts.promise)
      .mockReturnValueOnce(secondHosts.promise)
      .mockResolvedValue([host('newest')])
    const listRemoteDir = vi.fn(() => pendingDirectory.promise)
    const injected: DirectoryFlowInjected = {
      pickDirectory: vi.fn(async () => null),
      createSshWorkspace: vi.fn(),
      listHosts,
      createHost: vi.fn(),
      listRemoteDir,
      ensureConnected: vi.fn(async () => true),
    }
    const callbacks = {
      busy: false,
      onPicked: vi.fn(),
      onCancel: vi.fn(),
      onError: vi.fn(),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { secondHosts.resolve([host('newest')]) })
    await act(async () => { firstHosts.resolve([host('stale')]) })

    let menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    let select = menu.querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(option => option.value)).toContain('newest')
    expect([...select.options].map(option => option.value)).not.toContain('stale')

    await act(async () => {
      select.value = 'newest'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    const sshButtons = menu.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => { sshButtons[1].click() })

    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    select = menu.querySelector<HTMLSelectElement>('select')!
    const pathInput = menu.querySelectorAll<HTMLInputElement>('input')[0]
    expect(select.disabled).toBe(true)
    expect(pathInput.disabled).toBe(true)
    for (const button of menu.querySelectorAll<HTMLButtonElement>('button')) expect(button.disabled).toBe(true)

    // Closing invalidates the outstanding directory request. Its late result
    // must not leak into the next opening.
    await act(async () => { root.render(<DirectoryFlow open={false} {...callbacks} {...injected} />) })
    await act(async () => { root.render(<DirectoryFlow open {...callbacks} {...injected} />) })
    await act(async () => { pendingDirectory.resolve({ path: '/stale/path', entries: [] }) })
    menu = document.querySelector<HTMLElement>('[data-ssh-workspace-flow-menu]')!
    await act(async () => { menu.querySelectorAll<HTMLButtonElement>('button')[1].click() })
    expect(menu.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(callbacks.onError).not.toHaveBeenCalled()

    await act(async () => { root.unmount() })
  })
})
