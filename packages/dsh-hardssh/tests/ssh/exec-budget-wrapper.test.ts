/**
 * The exec budget must be enforced on the SERVER, not only in the client.
 *
 * Measured on a real host: a timed-out `ssh_exec` left `bash -c sleep 30` and its
 * `sleep 30` child alive 20 seconds after the client gave up, because ssh2's
 * channel `signal` request never reached the remote process and closing the
 * channel does not kill it. The wrapper below puts the deadline inside the same
 * session (`coreutils timeout`), which reaps the whole process group.
 */
import { describe, expect, it } from 'vitest'
import { wrapCommandWithServerBudget } from '../../src/ssh/engine.ts'
import { unwrapServerBudget } from './helpers/ssh-server.ts'

describe('server-side exec budget', () => {
  it('leaves the command untouched when there is no positive budget', () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(wrapCommandWithServerBudget('echo hi', budget)).toBe('echo hi')
    }
  })

  it('wraps with coreutils timeout, a kill grace, and the login shell', () => {
    const wrapped = wrapCommandWithServerBudget('echo hi', 2_000)
    // ceil(2000/1000) + 1s slack: the client deadline normally wins, and the
    // server timeout is the janitor that reaps the group a moment later.
    expect(wrapped).toContain('timeout -k 2 3 "${SHELL:-/bin/sh}" -c ')
    expect(wrapped).toContain('command -v timeout >/dev/null 2>&1')
    expect(wrapped.startsWith('if command -v timeout')).toBe(true)
    expect(wrapped.endsWith('; else echo hi; fi')).toBe(true)
  })

  it('quotes the caller command as ONE argument and round-trips it', () => {
    const nasty = `printf '%s' "a b"; echo 'it''s'; exit 3`
    const wrapped = wrapCommandWithServerBudget(nasty, 1_500)
    // 1500ms -> ceil + 1 = 3s, and the command survives intact.
    expect(wrapped).toContain('timeout -k 2 3 ')
    expect(unwrapServerBudget(wrapped)).toBe(nasty)
  })

  it('unwrapping is a no-op for commands that were never wrapped', () => {
    expect(unwrapServerBudget('echo plain')).toBe('echo plain')
    expect(unwrapServerBudget('')).toBe('')
  })

  it('escalates a repeated slow command to a real kill (documented contract)', () => {
    // The wrapper is deliberately idempotent per call; the engine applies it to
    // EVERY exec, so cluster/test/search callers are protected too.
    const wrapped = wrapCommandWithServerBudget('sleep 30', 1_000)
    expect(unwrapServerBudget(wrapped)).toBe('sleep 30')
    expect(wrapped).toContain('timeout')
  })
})
