/**
 * Remote environment cache tests (P1-12): TTL, concurrent-request merging,
 * per-alias/per-engine isolation, scrubbing, invalidation, and no-cache-on-
 * failure — verified against a fake engine that counts `env` round-trips.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshEngine } from '../src/ssh/engine.ts'
import {
  invalidateRemoteEnvironment,
  readScrubbedRemoteEnvironment,
  serializeEnvironment,
} from '../src/remote/environment.ts'

class FakeEngine {
  calls = 0
  fail = false
  respond = { stdout: 'PATH=/usr/bin\0HOME=/root\0DSH_SECRET=hidden\0' }

  async exec() {
    this.calls += 1
    if (this.fail) return { success: false, exitCode: 1, stdout: '', stderr: 'boom' }
    return { success: true, exitCode: 0, stdout: this.respond.stdout, stderr: '' }
  }
}

const engine = (fake: FakeEngine): SshEngine => fake as unknown as SshEngine

afterEach(() => {
  vi.useRealTimers()
})

describe('readScrubbedRemoteEnvironment (P1-12)', () => {
  it('caches per alias within the TTL (one exec)', async () => {
    const fake = new FakeEngine()
    const first = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    const second = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(fake.calls).toBe(1)
    expect(first.get('PATH')).toBe('/usr/bin')
    expect(second).toBe(first)
  })

  it('keeps separate caches per alias', async () => {
    const fake = new FakeEngine()
    await readScrubbedRemoteEnvironment(engine(fake), 'a')
    await readScrubbedRemoteEnvironment(engine(fake), 'b')
    expect(fake.calls).toBe(2)
  })

  it('merges concurrent requests into one fetch', async () => {
    const fake = new FakeEngine()
    const [x, y] = await Promise.all([
      readScrubbedRemoteEnvironment(engine(fake), 'a'),
      readScrubbedRemoteEnvironment(engine(fake), 'a'),
    ])
    expect(fake.calls).toBe(1)
    expect(x).toBe(y)
  })

  it('isolates caches across different engines', async () => {
    const fakeA = new FakeEngine()
    const fakeB = new FakeEngine()
    await readScrubbedRemoteEnvironment(engine(fakeA), 'a')
    await readScrubbedRemoteEnvironment(engine(fakeB), 'a')
    expect(fakeA.calls).toBe(1)
    expect(fakeB.calls).toBe(1)
  })

  it('re-reads after the TTL expires', async () => {
    vi.useFakeTimers()
    const fake = new FakeEngine()
    await readScrubbedRemoteEnvironment(engine(fake), 'a')
    vi.advanceTimersByTime(30_001)
    await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(fake.calls).toBe(2)
  })

  it('scrubs DSH_* and sensitive names', async () => {
    const fake = new FakeEngine()
    const env = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(env.has('DSH_SECRET')).toBe(false)
    expect(env.has('PATH')).toBe(true)
  })

  it('does not cache failures — the next call retries', async () => {
    const fake = new FakeEngine()
    fake.fail = true
    await expect(readScrubbedRemoteEnvironment(engine(fake), 'a')).rejects.toThrow(/boom/)
    fake.fail = false
    const env = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(fake.calls).toBe(2)
    expect(env.get('PATH')).toBe('/usr/bin')
  })

  it('invalidates a host immediately after a config change', async () => {
    const fake = new FakeEngine()
    await readScrubbedRemoteEnvironment(engine(fake), 'a')
    invalidateRemoteEnvironment(engine(fake), 'a')
    await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(fake.calls).toBe(2)
  })

  it('parses env -0 records with multiple = and newline-bearing values', async () => {
    const fake = new FakeEngine()
    fake.respond = { stdout: 'A=b=c\0B=line1\nline2\0' }
    const env = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    expect(env.get('A')).toBe('b=c')
    expect(env.get('B')).toBe('line1\nline2')
  })

  it('serializeEnvironment overlays and deletes explicit entries', async () => {
    const fake = new FakeEngine()
    const env = await readScrubbedRemoteEnvironment(engine(fake), 'a')
    const serialized = serializeEnvironment(env, { PATH: '/custom', HOME: undefined })
    expect(serialized).toContain('PATH=/custom')
    expect(serialized).not.toContain('HOME=/root')
  })
})
