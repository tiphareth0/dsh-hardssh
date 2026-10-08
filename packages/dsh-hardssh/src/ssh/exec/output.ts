/**
 * Incremental UTF-8 output collector with a strict BYTE budget.
 *
 * The previous implementation compared `text.length` (UTF-16 code units)
 * against `chunk.length` (bytes) and decoded each chunk in isolation, so
 * multi-byte characters split across chunks turned into U+FFFD and the
 * budget was never truly enforced. This collector counts raw input bytes,
 * decodes across chunk boundaries with StringDecoder, and truncates on a
 * complete UTF-8 sequence boundary (`utf8FloorCut`, shared with the
 * tail-window collector in `src/remote/output.ts` — that one keeps a SUFFIX and
 * uses the mirror-image `utf8CeilStart`; the two are deliberately separate
 * policies, not duplicates).
 * @module dsh-ssh/exec/output
 */

import { StringDecoder } from 'node:string_decoder'
import { utf8FloorCut } from '../../utf8.ts'

/** Marker appended when the captured output hits the byte budget. */
export const TRUNCATION_MARKER = '\n[output truncated]'

/** One captured stream (stdout or stderr). */
export class BoundedUtf8Output {
  private readonly decoder = new StringDecoder('utf8')
  private readonly parts: string[] = []
  private _bytesAccepted = 0
  private _truncated = false
  private _ended = false

  constructor(private readonly maxBytes: number) {}

  /** Raw bytes accepted so far (before truncation). */
  get bytesAccepted(): number {
    return this._bytesAccepted
  }

  /** True once the byte budget was hit and output was cut. */
  get truncated(): boolean {
    return this._truncated
  }

  append(chunk: Buffer): void {
    if (this._truncated || chunk.length === 0) return
    const remaining = this.maxBytes - this._bytesAccepted
    if (chunk.length <= remaining) {
      this._bytesAccepted += chunk.length
      this.parts.push(this.decoder.write(chunk))
      return
    }
    // Budget exhausted mid-chunk: keep the longest prefix that ends on a
    // complete UTF-8 sequence, then stop accepting input.
    const cut = utf8FloorCut(chunk, remaining)
    const kept = chunk.subarray(0, cut)
    this._bytesAccepted += kept.length
    if (kept.length > 0) this.parts.push(this.decoder.write(kept))
    this.parts.push(this.decoder.end())
    this._ended = true
    this._truncated = true
  }

  /** The captured text (truncation marker appended when cut). Idempotent. */
  finish(): string {
    if (!this._ended) {
      this._ended = true
      this.parts.push(this.decoder.end())
    }
    const text = this.parts.join('')
    return this._truncated ? text + TRUNCATION_MARKER : text
  }
}
