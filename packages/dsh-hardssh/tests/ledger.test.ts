import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAnchorPath, isPathUnderAnchor, normalizeRemoteRoot } from '../src/ledger.ts'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore } from '../src/runtime/workspace-core.ts'
import { genericFsWorldFor } from '../src/fs.ts'
import { genericSubprocessFor } from '../src/subprocess.ts'

describe('normalizeRemoteRoot', () => {
  it('keeps / as /', () => {
    expect(normalizeRemoteRoot('/')).toBe('/')
  })

  it('collapses duplicate separators and dot segments', () => {
    expect(normalizeRemoteRoot('/home/u///')).toBe('/home/u')
    expect(normalizeRemoteRoot('/a/./b/')).toBe('/a/b')
    expect(normalizeRemoteRoot('/a/../b')).toBe('/b')
  })

  it('rejects relative paths and NUL', () => {
    expect(() => normalizeRemoteRoot('home/u')).toThrow(/absolute/)
    expect(() => normalizeRemoteRoot('')).toThrow(/absolute/)
    expect(() => normalizeRemoteRoot('/a\0b')).toThrow(/NUL/)
  })
})

/**
 * B-01, asserted at the PRODUCTION seam instead of a standalone predicate: while
 * the workspace core is not ready, a cwd inside the reserved anchor root must be
 * refused (never degraded to the client machine), while ordinary local cwds stay
 * routable.
 */
describe('unready routing fails closed on the reserved anchor root (B-01)', () => {
  const anchorsRoot = '/home/u/.dsh/ssh-workspaces'
  const anchor = `${anchorsRoot}/ws-1`
  /** A core that was constructed but never initialized: isReady() === false. */
  const unready = (): DefaultWorkspaceCore => new DefaultWorkspaceCore(
    new WorkspaceLedger(join(tmpdir(), `b01-ledger-${Math.random().toString(36).slice(2)}.json`)),
    new WorkspaceProviderRegistry(),
  )

  it('refuses an anchor-root cwd for both seams while routing is not ready', () => {
    const core = unready()
    expect(core.isReady()).toBe(false)
    expect(() => genericFsWorldFor(core, anchor, [anchorsRoot])).toThrow(/not ready/)
    expect(() => genericFsWorldFor(core, `${anchor}/src`, [anchorsRoot])).toThrow(/not ready/)
    expect(() => genericSubprocessFor(core, anchor, [anchorsRoot])).toThrow(/not ready/)
  })

  it('matches the Windows anchor shape with mixed separators', () => {
    const core = unready()
    const winRoot = 'C:\\Users\\me\\.dsh\\ssh-workspaces'
    expect(() => genericFsWorldFor(core, `${winRoot}\\ws-1`, [winRoot])).toThrow(/not ready/)
    expect(() => genericFsWorldFor(core, 'c:/users/me/.dsh/ssh-workspaces/ws-1/src', [winRoot])).toThrow(/not ready/)
  })

  it('leaves local cwds and a missing cwd routable', () => {
    const core = unready()
    expect(genericFsWorldFor(core, join(tmpdir(), 'other'), [anchorsRoot])).toBeUndefined()
    expect(genericFsWorldFor(core, undefined, [anchorsRoot])).toBeUndefined()
    expect(genericFsWorldFor(core, '', [anchorsRoot])).toBeUndefined()
    expect(genericSubprocessFor(core, join(tmpdir(), 'other'), [anchorsRoot])).toBeUndefined()
  })
})

describe('anchor helpers', () => {
  it('matches Windows paths case-insensitively with mixed separators', () => {
    expect(isPathUnderAnchor(
      'C:\\Users\\Name\\.dsh\\ssh-workspaces\\id',
      'c:/users/name/.dsh/ssh-workspaces/id/src/index.ts',
    )).toBe(true)
  })

  it('does not match a lexical sibling prefix', () => {
    expect(isPathUnderAnchor('/work/project', '/work/project-other')).toBe(false)
  })

  it('keeps POSIX comparison case-sensitive', () => {
    expect(isPathUnderAnchor('/Work/Project', '/work/project/file')).toBe(false)
  })

  it('preserves filesystem roots while trimming trailing separators', () => {
    expect(normalizeAnchorPath('/')).toBe('/')
    expect(normalizeAnchorPath('C:\\')).toBe('c:\\')
  })
})