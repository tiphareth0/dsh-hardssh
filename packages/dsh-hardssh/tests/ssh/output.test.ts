import { describe, expect, it } from 'vitest'
import { BoundedUtf8Output, TRUNCATION_MARKER } from '../../src/ssh/exec/output.ts'

describe('BoundedUtf8Output', () => {
  it('collects output under the budget verbatim', () => {
    const out = new BoundedUtf8Output(1024)
    out.append(Buffer.from('hello '))
    out.append(Buffer.from('world'))
    expect(out.finish()).toBe('hello world')
    expect(out.bytesAccepted).toBe(11)
    expect(out.truncated).toBe(false)
  })

  it('decodes multi-byte characters split across chunks', () => {
    const out = new BoundedUtf8Output(1024)
    const bytes = Buffer.from('中文emoji😀ok')
    // Feed one byte at a time to force every possible chunk boundary.
    for (const byte of bytes) out.append(Buffer.from([byte]))
    expect(out.finish()).toBe('中文emoji😀ok')
    expect(out.truncated).toBe(false)
  })

  it('enforces the budget by raw bytes, not UTF-16 units', () => {
    // 6 CJK chars = 18 bytes (each 3 bytes), well above a 10-byte budget,
    // but only 6 UTF-16 code units — the old implementation would have
    // kept everything under a unit-based check.
    const out = new BoundedUtf8Output(10)
    out.append(Buffer.from('一二三四五六'))
    expect(out.bytesAccepted).toBeLessThanOrEqual(10)
    expect(out.truncated).toBe(true)
    expect(out.finish()).toBe('一二三' + TRUNCATION_MARKER)
  })

  it('truncates on a complete UTF-8 sequence boundary', () => {
    // Budget lands mid-character: 一二三 = 9 bytes, 四 starts at byte 9 and
    // spans 9..11 — a 10-byte budget must not emit a half 四.
    const out = new BoundedUtf8Output(10)
    out.append(Buffer.from('一二三四五六'))
    const text = out.finish()
    expect(text.startsWith('一二三')).toBe(true)
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(text).not.toContain('\uFFFD')
  })

  it('cuts exactly at the boundary when the split lands mid-chunk', () => {
    // 'a' + 5 CJK chars: bytes = 1 + 15 = 16. A 7-byte budget accepts
    // 'a' + 2 CJK (1+6=7), the third CJK would start at byte 7.
    const out = new BoundedUtf8Output(7)
    out.append(Buffer.from('a一二三四五'))
    expect(out.finish()).toBe('a一二' + TRUNCATION_MARKER)
    expect(out.bytesAccepted).toBe(7)
  })

  it('appends the truncation marker exactly once', () => {
    const out = new BoundedUtf8Output(4)
    out.append(Buffer.from('abcdefgh'))
    out.append(Buffer.from('ijkl')) // ignored after truncation
    const text = out.finish()
    const occurrences = text.split(TRUNCATION_MARKER).length - 1
    expect(occurrences).toBe(1)
    expect(out.bytesAccepted).toBe(4)
  })

  it('finish() is idempotent', () => {
    const out = new BoundedUtf8Output(64)
    out.append(Buffer.from('data'))
    expect(out.finish()).toBe('data')
    expect(out.finish()).toBe('data')
  })

  it('handles genuinely invalid UTF-8 with a single replacement char', () => {
    const out = new BoundedUtf8Output(1024)
    out.append(Buffer.from([0xc3, 0x28])) // invalid 2-byte sequence
    const text = out.finish()
    expect(text).toBe('\uFFFD(')
  })

  it('keeps the marker out of the byte budget', () => {
    const out = new BoundedUtf8Output(3)
    out.append(Buffer.from('abcdef'))
    const text = out.finish()
    expect(text.startsWith('abc')).toBe(true)
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true)
    expect(out.bytesAccepted).toBe(3)
  })
})
