// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshApi } from '../../src/client/ssh/api.ts'
import { connectHost } from '../../src/client/connect-host.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('connectHost failure feedback', () => {
  it('shows a user-visible dialog for a non-interactive connection failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const api = {
      testHost: vi.fn(async () => ({ ok: false, error: 'connect ECONNREFUSED 10.0.0.8:22' })),
    } as unknown as SshApi

    let connected = true
    await act(async () => {
      connected = await connectHost(api, 'offline-feedback')
    })

    expect(connected).toBe(false)
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('无法连接服务器 offline-feedback')
    expect(dialog?.textContent).toContain('ECONNREFUSED')

    const close = dialog?.querySelector('button')
    expect(close).not.toBeNull()
    await act(async () => { (close as HTMLButtonElement).click() })
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
