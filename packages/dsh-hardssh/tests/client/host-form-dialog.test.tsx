// @vitest-environment jsdom
/**
 * Host form dialog — commandPolicy fields:
 *  - edit pre-fills the deny lines and hint from the summary;
 *  - save parses each non-blank line into `deny` (a `#`-line is preserved and
 *    skipped by the engine at match time);
 *  - an emptied form saves `{ deny: [] }` → clears the host's guard (the
 *    confirmed "form is truth" semantics).
 */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostPayload, SshHostSummary } from '../../src/ssh/protocol.ts'
import { HostFormDialog } from '../../src/client/ssh/panel/HostFormDialog.tsx'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const host = (overrides: Partial<SshHostSummary> = {}): SshHostSummary => ({
  alias: 'web-01',
  host: '192.168.1.10',
  port: 22,
  user: 'root',
  auth: 'password',
  keyReady: false,
  proxyJump: [],
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

function render(
  editing: SshHostSummary | null,
  api: { updateHost: ReturnType<typeof vi.fn>; createHost: ReturnType<typeof vi.fn> },
): { onSaved: ReturnType<typeof vi.fn> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onSaved = vi.fn()
  act(() => {
    root.render(<HostFormDialog api={api as never} editing={editing} onClose={vi.fn()} onSaved={onSaved} />)
  })
  return { onSaved }
}

const denyTextarea = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('[data-test="host-command-policy"]')!
const hintInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-test="host-policy-hint"]')!

/** Drive a React controlled input/textarea with the native value setter. */
function setControl(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickSave = (): void => {
  act(() => { document.querySelector<HTMLButtonElement>('[data-test="host-form-save"]')!.click() })
}

/** Let the async save() settle (the updateHost promise + setState flush). */
const flush = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}

afterEach(() => { document.body.innerHTML = '' })

describe('HostFormDialog commandPolicy', () => {
  it('pre-fills deny lines and hint when editing a host that has a policy', () => {
    render(host({ commandPolicy: { deny: ['a', 'b', '# keep'], hint: 'use srun' } }), { updateHost: vi.fn(), createHost: vi.fn() })
    expect(denyTextarea().value).toBe('a\nb\n# keep')
    expect(hintInput().value).toBe('use srun')
  })

  it('saves every non-blank line into deny and keeps the hint', async () => {
    const updateHost = vi.fn(() => Promise.resolve(host()))
    render(host({ commandPolicy: { deny: ['a'], hint: 'old' } }), { updateHost, createHost: vi.fn() })
    setControl(denyTextarea(), '  a  \n\n b \n# c\nd')
    setControl(hintInput(), 'use srun')
    clickSave()
    await flush()
    const patch = updateHost.mock.calls[0]![1] as HostPayload
    expect(patch.commandPolicy).toEqual({ deny: ['a', 'b', '# c', 'd'], hint: 'use srun' })
  })

  it('clears the guard when the form is emptied (deny: [])', async () => {
    const updateHost = vi.fn(() => Promise.resolve(host()))
    render(host({ commandPolicy: { deny: ['python'], hint: 'use srun' } }), { updateHost, createHost: vi.fn() })
    setControl(denyTextarea(), '   ')
    setControl(hintInput(), '')
    clickSave()
    await flush()
    const patch = updateHost.mock.calls[0]![1] as HostPayload
    expect(patch.commandPolicy).toEqual({ deny: [] })
  })

  it('round-trips denyCommands/allowCommands name lists', async () => {
    const updateHost = vi.fn(() => Promise.resolve(host()))
    render(host({ commandPolicy: { deny: [], denyCommands: ['python', 'R'], allowCommands: ['sbatch'], hint: '' } }), { updateHost, createHost: vi.fn() })
    expect(document.querySelector<HTMLTextAreaElement>('[data-test="host-deny-commands"]')!.value).toBe('python\nR')
    expect(document.querySelector<HTMLTextAreaElement>('[data-test="host-allow-commands"]')!.value).toBe('sbatch')
    setControl(document.querySelector<HTMLTextAreaElement>('[data-test="host-deny-commands"]')!, 'python\n\nRscript')
    setControl(document.querySelector<HTMLTextAreaElement>('[data-test="host-allow-commands"]')!, 'sbatch\nsrun')
    clickSave()
    await flush()
    const patch = updateHost.mock.calls[0]![1] as HostPayload
    expect(patch.commandPolicy).toEqual({
      deny: [],
      denyCommands: ['python', 'Rscript'],
      allowCommands: ['sbatch', 'srun'],
    })
  })
})
