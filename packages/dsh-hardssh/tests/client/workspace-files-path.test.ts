import { describe, expect, it } from 'vitest'
import { normalizeFilesPath, remapAnchorToRemote } from '../../src/client/workspace-files-path.ts'

describe('normalizeFilesPath', () => {
  it('unifies separators and drops trailing separators', () => {
    expect(normalizeFilesPath('C:\\Users\\me/.dsh/ssh-workspaces/ws-1\\')).toBe('c:/users/me/.dsh/ssh-workspaces/ws-1')
    expect(normalizeFilesPath('/data/app')).toBe('/data/app')
  })
})

describe('remapAnchorToRemote', () => {
  const ANCHOR = 'C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-1'
  const REMOTE = '/data/home/alice/project/tools'

  it('rewrites the root itself', () => {
    expect(remapAnchorToRemote(ANCHOR, REMOTE, ANCHOR)).toBe(REMOTE)
    expect(remapAnchorToRemote(ANCHOR, `${REMOTE}/`, ANCHOR)).toBe(REMOTE)
  })

  it('rewrites a path under the anchor, keeping the tail', () => {
    expect(remapAnchorToRemote(ANCHOR, REMOTE, `${ANCHOR}\\src\\a.ts`)).toBe(`${REMOTE}/src/a.ts`)
    expect(remapAnchorToRemote(ANCHOR, REMOTE, `${ANCHOR}/src/a.ts`)).toBe(`${REMOTE}/src/a.ts`)
  })

  it('is case-insensitive for Windows anchors (different spelling of the same root)', () => {
    expect(remapAnchorToRemote(ANCHOR, REMOTE, 'c:/users/me/.dsh/ssh-workspaces/ws-1/src/a.ts')).toBe(`${REMOTE}/src/a.ts`)
  })

  it('leaves unrelated paths unchanged', () => {
    expect(remapAnchorToRemote(ANCHOR, REMOTE, '/etc/hosts')).toBe('/etc/hosts')
    expect(remapAnchorToRemote(ANCHOR, REMOTE, 'C:\\Windows\\System32')).toBe('C:\\Windows\\System32')
    // A sibling anchor must not match.
    expect(remapAnchorToRemote(ANCHOR, REMOTE, 'C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-2')).toBe('C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-2')
  })
})
