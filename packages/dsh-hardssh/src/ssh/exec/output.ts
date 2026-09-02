/**
 * Incremental UTF-8 output collector with a strict BYTE budget.
 *
 * The previous implementation compared `text.length` (UTF-16 code units)
 * against `chunk.length` (bytes) and decoded each chunk in isolation, so
 * multi-byte characters split across chunks turned into U+FFFD and the
 * budget was never truly enforced. This collector counts raw input bytes,
 * decodes across chunk boundaries with StringDecoder, and truncates on a
 * complete UTF-8 sequence boundary.
 * @module dsh-ssh/exec/output
 */

import { StringDecoder } from 'node:string_decoder'

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
    // complete UTF-8 sequence, then stop accepting input. Back off from a
    // continuation byte (0b10xxxxxx) to the sequence lead, and drop the
    // lead itself when its continuations were cut away.
    let cut = remaining
    while (cut > 0 && (chunk[cut] & 0xc0) === 0x80) cut -= 1
    if (cut > 0 && (chunk[cut - 1] & 0xc0) === 0xc0) cut -= 1
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
