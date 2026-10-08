/**
 * Bounded host-side projection of one remote output stream with a local
 * spill file. Ported from UynajGI/dsh-ssh (MIT) — verbatim semantics, plus the
 * UTF-8 window alignment noted on `push`.
 *
 * Not a duplicate of `src/ssh/exec/output.ts`: that collector keeps a bounded
 * HEAD and decodes as bytes arrive (engine exec capture), while this one keeps a
 * bounded TAIL window over the whole stream and answers incremental reads
 * (`SubprocessOutputReader`). They share only the sequence-boundary arithmetic
 * in `src/utf8.ts`.
 */

import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollectedOutput, SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { utf8CeilStart } from '../utf8.ts'

let spillCounter = 0
let defaultSpillDir: string | undefined

/**
 * Drop the partial character the byte-budget trim left at the window start.
 * @param chunks - the retained chunk list, trimmed in place.
 * @returns how many leading bytes were dropped.
 */
function alignWindowStart(chunks: Buffer[]): number {
  let dropped = 0
  while (chunks.length > 0) {
    const head = chunks[0] as Buffer
    const aligned = utf8CeilStart(head, 0)
    if (aligned === 0) break
    if (aligned >= head.length) {
      // The whole chunk is continuation bytes: its lead was already dropped.
      chunks.shift()
      dropped += head.length
      continue
    }
    chunks[0] = head.subarray(aligned)
    dropped += aligned
    break
  }
  return dropped
}

/** Private (0700) per-process spill directory under the OS tmpdir, created lazily. */
function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'dsh-subprocess-ssh-'))
  return defaultSpillDir
}

/**
 * Collects one remote stream with a bounded in-memory tail. On first overflow
 * a spill file is opened (when a spill cap is configured) and every chunk —
 * already-collected ones included — is appended there while the full stream
 * stays within the cap; without one, only the in-memory tail is retained.
 */
export class SshOutputCollector implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retained = 0
  private total = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly label: string,
    private readonly spillDir: string = privateSpillDir(),
  ) {
    this.spillDisabled = maxSpillBytes === undefined
  }

  /** Append one byte-faithful remote chunk, trimming the retained tail to the cap. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    const buffer = Buffer.from(chunk)
    this.total += buffer.length
    const overflows = this.retained + buffer.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(buffer)
    this.chunks.push(buffer)
    this.retained += buffer.length
    let trimmed = false
    while (this.retained > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retained - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retained -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retained -= excess
      }
      this.dropped = true
      trimmed = true
    }
    // The budget cuts at a byte boundary, so the window may now open on the
    // continuation bytes of a character whose lead was just dropped. Align only
    // when THIS push trimmed: a chunk boundary on its own can legitimately fall
    // inside a character whose lead is still retained.
    if (trimmed) this.retained -= alignWindowStart(this.chunks)
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retained)
    const windowStart = this.total - this.retained
    const lossy = fromByte < windowStart
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - windowStart))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }

  /** Open the spill file lazily and append one chunk (plus any prior chunks once). */
  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      this.spillFile = join(
        this.spillDir,
        `dsh-subprocess-ssh-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
  }

  /** Close the spill file once the stream has ended; stop advertising it on a failed close. */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /** Seal the spill and return the final collected output. */
  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...(this.spillFile !== undefined ? { spillPath: this.spillFile } : {}),
    }
  }
}
