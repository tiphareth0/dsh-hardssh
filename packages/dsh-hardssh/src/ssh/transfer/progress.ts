/**
 * Shared transfer-progress tracker for fastPut/fastGet (P1-19): one
 * throttle/speed/percent rule set so uploads and downloads cannot drift.
 * Sends an initial 0-frame on creation, never throttles the final step,
 * keeps the last known progress on failure, and always reports 100% on done.
 */

import type { TransferProgress } from '../protocol.ts'

/** Throttle window between progress frames (~10 fps). */
const THROTTLE_MS = 100

export interface TransferProgressTracker {
  step(transferred: number, total: number): void
  done(): void
  fail(error: unknown): void
}

export function createTransferProgressTracker(
  file: string,
  initialTotal: number,
  emit?: (progress: TransferProgress) => void,
  now: () => number = Date.now,
): TransferProgressTracker {
  let total = initialTotal
  let lastTransferred = 0
  let lastEmit = now()
  let lastTime = now()
  let hasEmitted = false
  let finished = false

  // Initial 0% frame: marks the transfer as started. Deliberately does NOT
  // advance the throttle state, so the first real step always goes through.
  emit?.({ phase: 'transferring', file, transferred: 0, total, percent: 0, speedBps: undefined })

  const emitFrame = (transferred: number, phase: TransferProgress['phase'], extra?: Partial<TransferProgress>): void => {
    const intervalSec = (now() - lastTime) / 1000
    emit?.({
      phase,
      file,
      transferred,
      total,
      percent: phase === 'done' ? 100 : total > 0 ? Math.round((transferred / total) * 1000) / 10 : 0,
      ...(phase === 'transferring'
        ? { speedBps: intervalSec > 0 ? Math.round((transferred - lastTransferred) / intervalSec) : undefined }
        : {}),
      ...extra,
    })
    if (phase !== 'transferring') return
    hasEmitted = true
    lastTransferred = transferred
    lastEmit = now()
    lastTime = now()
  }

  return {
    step(transferred, stepTotal) {
      if (finished) return
      total = stepTotal // the SFTP step total is authoritative
      if (hasEmitted && now() - lastEmit < THROTTLE_MS && transferred < total) return
      emitFrame(transferred, 'transferring')
    },
    done() {
      if (finished) return
      finished = true
      emitFrame(total, 'done')
    },
    fail(error) {
      if (finished) return
      finished = true
      // Keep the last known progress instead of zeroing it.
      emitFrame(lastTransferred, 'error', { error: error instanceof Error ? error.message : String(error) })
    },
  }
}
