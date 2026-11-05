/**
 * Connection budgets: a first connection to a far host routinely exceeds the
 * old 15s handshake / 10s probe, which users saw as a spurious "timed out".
 * The resolver must also refuse values that would disable the timeout (0/NaN)
 * or pin a dead host for hours.
 */
import { describe, expect, it } from 'vitest'
import { resolveConnectionTimeouts } from '../src/index.ts'
import { DEFAULTS } from '../src/ssh/connection/manager.ts'

describe('resolveConnectionTimeouts', () => {
  it('defaults to a longer first-connect budget than the old 15s/10s', () => {
    expect(resolveConnectionTimeouts()).toEqual({ connectTimeoutMs: 30_000, probeTimeoutMs: 20_000 })
    expect(resolveConnectionTimeouts({})).toEqual({ connectTimeoutMs: 30_000, probeTimeoutMs: 20_000 })
    // The engine defaults agree with the plugin defaults.
    expect(DEFAULTS.connectTimeoutMs).toBe(30_000)
    expect(DEFAULTS.probeTimeoutMs).toBe(20_000)
  })

  it('honours configured values', () => {
    expect(resolveConnectionTimeouts({ connectTimeoutMs: 45_000, probeTimeoutMs: 25_000 }))
      .toEqual({ connectTimeoutMs: 45_000, probeTimeoutMs: 25_000 })
  })

  it('clamps unsafe values instead of disabling the timeout', () => {
    expect(resolveConnectionTimeouts({ connectTimeoutMs: 0, probeTimeoutMs: 0 }))
      .toEqual({ connectTimeoutMs: 5_000, probeTimeoutMs: 5_000 })
    expect(resolveConnectionTimeouts({ connectTimeoutMs: -1, probeTimeoutMs: Number.NaN }))
      .toEqual({ connectTimeoutMs: 5_000, probeTimeoutMs: 20_000 })
    expect(resolveConnectionTimeouts({ connectTimeoutMs: 60 * 60_000, probeTimeoutMs: Number.POSITIVE_INFINITY }))
      .toEqual({ connectTimeoutMs: 10 * 60_000, probeTimeoutMs: 20_000 })
    expect(resolveConnectionTimeouts({ connectTimeoutMs: '30000', probeTimeoutMs: undefined }))
      .toEqual({ connectTimeoutMs: 30_000, probeTimeoutMs: 20_000 })
  })
})
