/**
 * Path-utility tests for the workspace store. The `LocalBackend` class these
 * used to cover is gone: `GenericWorkspaceStore` is the only record source, and
 * local filesystem access is owned by the sandboxed `ctx.fs` implementation
 * behind the switching facade.
 */
import { describe, expect, it } from 'vitest'
import { BackendError, isInside, normalizeRel, relToAbs } from '../src/backend.ts'

describe('path utils', () => {
  it('normalizes rel paths and rejects ".."', () => {
    expect(normalizeRel('a//b/./c')).toBe('a/b/c')
    expect(normalizeRel('')).toBe('')
    expect(() => normalizeRel('../x')).toThrow(BackendError)
    expect(() => normalizeRel('a/../b')).toThrow(BackendError)
  })

  it('resolves rel against a root', () => {
    expect(relToAbs('/home/u', 'a/b')).toBe('/home/u/a/b')
    expect(relToAbs('/home/u', '')).toBe('/home/u')
    expect(relToAbs('/home/u/', 'x')).toBe('/home/u/x')
  })

  it('isInside gates prefixes', () => {
    expect(isInside('/home/u', '/home/u/a')).toBe(true)
    expect(isInside('/home/u', '/home/u')).toBe(true)
    expect(isInside('/home/u', '/home/u2')).toBe(false)
    expect(isInside('/home/u', '/home')).toBe(false)
  })
})
