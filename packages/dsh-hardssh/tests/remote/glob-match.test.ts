/** Glob matching dialect shared by the shell and SFTP search rungs (P1-D). */

import { describe, expect, it } from 'vitest'
import { globLiteralPrefix, globMatches, globToRegExp } from '../../src/remote/glob-match.ts'

describe('glob matching', () => {
  it('keeps `*` inside one path segment', () => {
    expect(globMatches('*.ts', 'a.ts')).toBe(true)
    expect(globMatches('*.ts', 'src/a.ts')).toBe(false)
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/nested/a.ts')).toBe(false)
  })

  it('lets `**` cross directories and `**/` match zero levels', () => {
    // The regression: the old `find -path` template missed depth-1 hits.
    expect(globMatches('**/*.ts', 'a.ts')).toBe(true)
    expect(globMatches('**/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('**/*.ts', 'src/deep/a.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'src/deep/a.ts')).toBe(true)
    expect(globMatches('src/**/*.ts', 'other/a.ts')).toBe(false)
  })

  it('supports `?` and character classes', () => {
    expect(globMatches('a?.ts', 'ab.ts')).toBe(true)
    expect(globMatches('a?.ts', 'a/b.ts')).toBe(false)
    expect(globMatches('a[bc].ts', 'ab.ts')).toBe(true)
    expect(globMatches('a[!bc].ts', 'ad.ts')).toBe(true)
    expect(globMatches('a[!bc].ts', 'ab.ts')).toBe(false)
    // An unterminated class is a literal `[`, not a syntax error.
    expect(globMatches('a[b.ts', 'a[b.ts')).toBe(true)
  })

  it('treats regex metacharacters as literals', () => {
    expect(globMatches('a+b.ts', 'a+b.ts')).toBe(true)
    expect(globMatches('a+b.ts', 'aab.ts')).toBe(false)
    expect(globToRegExp('a.ts').source).toBe('^a\\.ts$')
  })

  it('anchors the pattern to the whole path', () => {
    expect(globMatches('a.ts', 'a.ts.bak')).toBe(false)
    expect(globMatches('a.ts', 'xa.ts')).toBe(false)
  })

  it('derives the literal anchor directory of a pattern', () => {
    expect(globLiteralPrefix('*.ts')).toBe('')
    expect(globLiteralPrefix('**/*.ts')).toBe('')
    expect(globLiteralPrefix('src/*.ts')).toBe('src')
    expect(globLiteralPrefix('src/**/*.ts')).toBe('src')
    expect(globLiteralPrefix('src/app/deep/*.ts')).toBe('src/app/deep')
    expect(globLiteralPrefix('/src/*.ts')).toBe('src')
  })
})
