/**
 * Shared UTF-8 sequence-boundary arithmetic (`src/utf8.ts`) and the tail-window
 * collector that uses its forward-alignment half (`src/remote/output.ts`).
 *
 * The two collectors cut raw bytes at a budget boundary: the head collector
 * (`src/ssh/exec/output.ts`, covered by tests/ssh/output.test.ts) keeps a prefix
 * and must not end inside a character; the tail collector keeps a suffix and
 * must not OPEN inside one. The tail cases here pin the rule that alignment runs
 * ONLY after this collector dropped head bytes itself — a chunk boundary that
 * falls inside a character whose lead is still retained must survive intact.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { SshOutputCollector } from '../../src/remote/output.ts'
import { utf8CeilStart, utf8FloorCut } from '../../src/utf8.ts'

/** UTF-8 bytes of one 3-byte character (中) and one 4-byte character (😀). */
const ZHONG = Buffer.from('中', 'utf8')
const EMOJI = Buffer.from('😀', 'utf8')

describe('utf8FloorCut', () => {
  it('keeps a whole character when the budget lands on its last byte', () => {
    const text = Buffer.from('a中', 'utf8')
    expect(utf8FloorCut(text, text.length)).toBe(text.length)
  })

  it('drops the lead byte whose continuations fall outside the budget', () => {
    const text = Buffer.from('a中', 'utf8')
    // Budget 1..3 cuts inside 中: only 'a' (1 byte) is a complete character.
    expect(utf8FloorCut(text, 2)).toBe(1)
    expect(utf8FloorCut(text, 3)).toBe(1)
    expect(utf8FloorCut(text, 4)).toBe(4)
  })

  it('never returns a negative cut', () => {
    expect(utf8FloorCut(ZHONG, 0)).toBe(0)
    expect(utf8FloorCut(ZHONG, -5)).toBe(0)
  })
})

describe('utf8CeilStart', () => {
  it('skips leading continuation bytes to the next character', () => {
    expect(utf8CeilStart(ZHONG, 1)).toBe(ZHONG.length)
    expect(utf8CeilStart(ZHONG, 2)).toBe(ZHONG.length)
    expect(utf8CeilStart(ZHONG, 0)).toBe(0)
  })

  it('skips a whole 4-byte character that lost its lead', () => {
    expect(utf8CeilStart(EMOJI, 1)).toBe(EMOJI.length)
  })
})

describe('SshOutputCollector window alignment', () => {
  it('retains the tail window with byte offsets and lossiness', () => {
    const collector = new SshOutputCollector(8, undefined, 'test')
    collector.push(Buffer.from('abcdef', 'utf8'))
    expect(collector.finalize()).toEqual({ text: 'abcdef', truncated: false })
    collector.push(Buffer.from('ghij', 'utf8'))
    // 10 bytes streamed, 8 retained: the head is gone, readFrom reports lossy.
    const read = collector.readFrom(0)
    expect(read).toMatchObject({ lossy: true, nextOffset: 10 })
    expect(read.text).toBe('cdefghij')
  })

  it('does not open the window inside the character it trimmed past', () => {
    // Budget 4 bytes; '中中' is 6 bytes, so the trim leaves a 1-byte tail of the
    // first character, which must be dropped instead of decoded as U+FFFD.
    const collector = new SshOutputCollector(4, undefined, 'utf8-window')
    collector.push(Buffer.from('中中', 'utf8'))
    const output = collector.finalize()
    expect(output.truncated).toBe(true)
    expect(output.text).not.toContain('\uFFFD')
    expect(output.text).toBe('中')
  })

  it('keeps a character whose lead arrived in an earlier chunk of the same push window', () => {
    // No trim happens here: the split is delivered by the transport, not by the
    // budget, so the lead is still retained and the pair decodes to one character.
    const collector = new SshOutputCollector(64, undefined, 'chunk-split')
    collector.push(ZHONG.subarray(0, 1))
    collector.push(ZHONG.subarray(1))
    expect(collector.finalize()).toEqual({ text: '中', truncated: false })
  })

  it('still reports the spilled tail once the window opens mid-character', () => {
    const collector = new SshOutputCollector(4, 1024, 'utf8-spill')
    collector.push(Buffer.from('中中中', 'utf8'))
    const output = collector.finalize()
    expect(output.truncated).toBe(true)
    expect(output.spillPath).toBeDefined()
    expect(output.text).not.toContain('\uFFFD')
  })
})
