/**
 * TransferProgressTracker unit tests (P1-19): initial frame, throttling,
 * guaranteed final frame, 100% on done, failure keeping last progress, and
 * empty-file completion.
 */

import { describe, expect, it, vi } from 'vitest'
import type { TransferProgress } from '../src/ssh/protocol.ts'
import { createTransferProgressTracker } from '../src/ssh/transfer/progress.ts'

function collect(initialTotal: number, now?: () => number): { frames: TransferProgress[]; tracker: ReturnType<typeof createTransferProgressTracker> } {
  const frames: TransferProgress[] = []
  const tracker = createTransferProgressTracker('/srv/app/f.bin', initialTotal, (progress) => { frames.push(progress) }, now)
  return { frames, tracker }
}

describe('createTransferProgressTracker (P1-19)', () => {
  it('emits an initial 0% frame on creation', () => {
    const { frames } = collect(100)
    expect(frames[0]).toMatchObject({ phase: 'transferring', file: '/srv/app/f.bin', transferred: 0, total: 100, percent: 0 })
  })

  it('throttles intermediate frames but always emits the final step', () => {
    vi.useFakeTimers()
    let time = 0
    const now = (): number => time
    const { frames, tracker } = collect(100, now)
    tracker.step(10, 100)
    expect(frames).toHaveLength(2)
    time += 50 // below the 100ms throttle
    tracker.step(20, 100)
    expect(frames).toHaveLength(2)
    time += 100
    tracker.step(50, 100)
    expect(frames).toHaveLength(3)
    tracker.step(100, 100) // final step, never throttled
    expect(frames).toHaveLength(4)
    expect(frames.at(-1)).toMatchObject({ phase: 'transferring', transferred: 100, percent: 100 })
  })

  it('reports 100% on done even for empty files', () => {
    const { frames, tracker } = collect(0)
    tracker.done()
    expect(frames.at(-1)).toMatchObject({ phase: 'done', transferred: 0, percent: 100 })
  })

  it('keeps the last known progress on failure instead of zeroing it', () => {
    const { frames, tracker } = collect(100)
    tracker.step(60, 100)
    tracker.fail(new Error('boom'))
    const errorFrame = frames.at(-1)!
    expect(errorFrame.phase).toBe('error')
    expect(errorFrame.transferred).toBe(60)
    expect(errorFrame.total).toBe(100)
    expect(errorFrame.error).toBe('boom')
  })

  it('computes interval speed from the last emit, not total elapsed', () => {
    vi.useFakeTimers()
    let time = 0
    const now = (): number => time
    const { frames, tracker } = collect(100, now)
    tracker.step(10, 100)
    time += 1000
    tracker.step(110, 1000) // total jumped; speed over the 1s window
    const frame = frames.at(-1)!
    expect(frame.speedBps).toBe(100)
  })

  it('ignores steps and done after a failure', () => {
    const { frames, tracker } = collect(100)
    tracker.fail(new Error('boom'))
    tracker.step(50, 100)
    tracker.done()
    expect(frames).toHaveLength(2) // initial + error only
  })

  it('honors the SFTP step total as authoritative', () => {
    const { frames, tracker } = collect(0)
    tracker.step(5, 200)
    const frame = frames.at(-1)!
    expect(frame.total).toBe(200)
    expect(frame.percent).toBe(2.5)
  })
})
