import { describe, expect, it } from 'vitest'
import { shellQuote } from '../src/shell.ts'

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'")
    expect(shellQuote('')).toBe("''")
  })

  it('escapes embedded single quotes the POSIX way', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'")
  })

  it('handles spaces, newlines and shell metacharacters as literals', () => {
    expect(shellQuote('a b')).toBe("'a b'")
    expect(shellQuote('$HOME')).toBe("'$HOME'")
    expect(shellQuote('a\nb')).toBe("'a\nb'")
    expect(shellQuote('*.ts')).toBe("'*.ts'")
  })
})
