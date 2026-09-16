// @vitest-environment jsdom
/**
 * connectHost (probe-and-prompt gate):
 *  - emits `connecting` → `settled` so the sidebar badge can show a spinner;
 *  - when a credential was already entered and the server rejects it (wrong
 *    password / auth denied), RE-OPENS the password dialog with the concrete
 *    SSH reason — never a bare non-interactive failure dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectHost, subscribeConnectState } from '../../src/client/connect-host.ts'
import type { SshApi } from '../../src/client/ssh/api.ts'
import type { TestResult } from '../../src/ssh/protocol.ts'

// `vi.hoisted` so the mock factory (hoisted above the imports) sees the SAME
// array instances the test body reads.
const { secretReasons, failureDetails } = vi.hoisted(() => ({
  secretReasons: [] as Array<string | undefined>,
  failureDetails: [] as string[],
}))

// Mock the dialog components (inert, `null` renders like the debug harness
// that proved the flow), recording what reason each prompt received — the
// `reason` prop is what proves the re-prompt carried the SSH message.
// SessionSecretDialog auto-"submits" on mount (the real dialog would call
// `onProvided` after the credential reaches the host), so one mount = one
// prompt round.
vi.mock('../../src/client/ssh/panel/SessionSecretDialog.tsx', () => ({
  SessionSecretDialog: (props: { reason?: string; onProvided: () => void }) => {
    secretReasons.push(props.reason)
    setTimeout(() => {
      try { props.onProvided() } catch { /* unmount timing in jsdom */ }
    }, 0)
    return null
  },
}))
vi.mock('../../src/client/ssh/panel/ConnectionErrorDialog.tsx', () => ({
  ConnectionErrorDialog: (props: { detail: string }) => {
    failureDetails.push(props.detail)
    return null
  },
}))
vi.mock('../../src/client/ssh/panel/HostFingerprintDialog.tsx', () => ({
  HostFingerprintDialog: () => null,
}))

function testResult(partial: Partial<TestResult>): TestResult {
  return { ok: false, ...partial }
}

/** Minimal SshApi fake for the probe/prompt flow. */
function fakeApi(overrides: Partial<Record<'testHost' | 'setSessionSecret' | 'listHosts', unknown>> = {}): SshApi {
  return {
    testHost: (overrides.testHost ?? (async () => testResult({ ok: true }))) as SshApi['testHost'],
    setSessionSecret: (overrides.setSessionSecret ?? (async () => undefined)) as SshApi['setSessionSecret'],
    listHosts: (overrides.listHosts ?? (async () => [{ alias: 'h', user: 'u' }])) as SshApi['listHosts'],
  } as unknown as SshApi
}

beforeEach(() => {
  secretReasons.length = 0
  failureDetails.length = 0
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('connectHost lifecycle events', () => {
  it('emits connecting then settled for a successful probe', async () => {
    const events: string[] = []
    const api = fakeApi()
    const unsub = subscribeConnectState((alias, state) => events.push(`${alias}:${state}`))
    await expect(connectHost(api, 'ok-host')).resolves.toBe(true)
    unsub()
    expect(events).toEqual(['ok-host:connecting', 'ok-host:settled'])
  })
})

describe('connectHost wrong-password re-prompt', () => {
  it('re-opens the password dialog with the SSH reason instead of the failure dialog', async () => {
    // Round 1: server needs a password (no prior reason). After the user
    // submits it, round 2 fails with an auth rejection; the gate must re-open
    // the password dialog WITH that reason, not show the failure dialog.
    const api = fakeApi({
      testHost: vi.fn()
        .mockResolvedValueOnce(testResult({ code: 'NEEDS_PASSWORD', secret: 'password' }))
        .mockResolvedValueOnce(testResult({ error: 'Authentication failure.' }))
        .mockResolvedValueOnce(testResult({ ok: true })),
      setSessionSecret: vi.fn(async () => undefined),
    })

    const unsub = subscribeConnectState(() => {})
    const promise = connectHost(api, 'auth-host')
    await promise
    unsub()

    // Connected, and the failure dialog was never used: the wrong password was
    // handled by re-prompting with the concrete SSH reason.
    await expect(promise).resolves.toBe(true)
    expect(failureDetails).toEqual([])
    expect(secretReasons.filter(reason => reason !== undefined)).toContain('Authentication failure.')
  }, 10_000)
})
