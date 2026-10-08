/**
 * UTF-8 sequence-boundary arithmetic shared by the two byte-budgeted output
 * collectors.
 *
 * The engine's exec capture (`src/ssh/exec/output.ts`) keeps a bounded HEAD and
 * decodes as it goes; the remote subprocess projection
 * (`src/remote/output.ts`) keeps a bounded TAIL window and decodes on read. Both
 * cut raw bytes at a budget boundary, and a naive cut splits a multi-byte
 * character — the head collector would emit U+FFFD where the character was cut,
 * the tail window would open on a stray continuation byte. These helpers are the
 * single place that knows where a UTF-8 sequence starts.
 *
 * No imports on purpose: this module is safe for the browser half too.
 * @module dsh-hardssh/utf8
 */

/** True for a UTF-8 continuation byte (`0b10xxxxxx`). */
function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80
}

/** True for a UTF-8 sequence lead byte (`0b11xxxxxx`). */
function isLead(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0xc0
}

/**
 * Largest cut at or before `cut` that ends on a complete character.
 *
 * Use when keeping a PREFIX: walk back off continuation bytes (their lead would
 * be kept, leaving a truncated character) and then off a trailing lead whose
 * continuations fall outside the cut.
 * @param bytes - the buffer being cut.
 * @param cut - the byte budget (an index into `bytes`).
 * @returns the aligned cut, never below 0.
 */
export function utf8FloorCut(bytes: Uint8Array, cut: number): number {
  let end = Math.min(cut, bytes.length)
  while (end > 0 && end < bytes.length && isContinuation(bytes[end])) end -= 1
  if (end > 0 && isLead(bytes[end - 1])) end -= 1
  return Math.max(0, end)
}

/**
 * Smallest start at or after `start` that begins a character.
 *
 * Use when a SUFFIX starts at a byte boundary the collector itself chose (a
 * dropped head): leading continuation bytes belong to a character whose lead was
 * dropped, so they must go too. Do NOT apply this to bytes that merely arrived
 * in a new chunk — a chunk boundary can legitimately fall inside a character
 * whose lead is still retained.
 * @param bytes - the buffer being started.
 * @param start - the candidate start index.
 * @returns the aligned start, at most `bytes.length`.
 */
export function utf8CeilStart(bytes: Uint8Array, start: number): number {
  let index = Math.max(0, start)
  while (isContinuation(bytes[index])) index += 1
  return index
}
