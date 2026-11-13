/**
 * The shell's own rename must not desynchronise the plugin's record.
 *
 * `workspaces.rename` only touches the shell's workspace store; our SSH record
 * keeps its title, and every title-keyed surface (the badge, the panel) then
 * misses. The shell does expose the workspace id and the workspace path (our
 * anchor), which is what this join uses — plus the row's `data-row-key` gives the
 * badge a rename-proof identity.
 */
import { describe, expect, it } from 'vitest'
import { joinShellWorkspaces, titleDrift } from '../../src/client/workspace-title-sync.ts'

const RECORDS = [
  { id: 'r1', title: 'zebrafish_westlake_new', anchorPath: 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\c28b80a4' },
  { id: 'r2', title: 'tools', anchorPath: 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\67e4e61c' },
]

describe('joinShellWorkspaces', () => {
  it('joins by anchor path and tolerates case/slash spelling', () => {
    const joined = joinShellWorkspaces(RECORDS, [
      { workspaceId: 'w1', title: 'renamed-natively', path: 'c:/users/kether/.dsh/ssh-workspaces/C28B80A4' },
      { workspaceId: 'w2', title: 'tools', path: 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\67e4e61c\\' },
    ])
    expect([...joined.keys()].sort()).toEqual(['w1', 'w2'])
    expect(joined.get('w1')?.id).toBe('r1')
    expect(joined.get('w2')?.id).toBe('r2')
  })

  it('ignores shell workspaces that are not one of our anchors', () => {
    const joined = joinShellWorkspaces(RECORDS, [
      { workspaceId: 'local', title: 'some local project', path: 'D:\\projects\\x' },
      { workspaceId: 'nopath', title: 'no path' },
    ])
    expect(joined.size).toBe(0)
  })
})

describe('titleDrift', () => {
  it('reports the shell title when it differs from the record', () => {
    const drift = titleDrift(RECORDS, [
      { workspaceId: 'w1', title: 'westlake_new', path: RECORDS[0]!.anchorPath },
      { workspaceId: 'w2', title: 'tools', path: RECORDS[1]!.anchorPath },
    ])
    expect(drift).toEqual([{ id: 'r1', title: 'westlake_new' }])
  })

  it('never adopts an empty shell title', () => {
    expect(titleDrift(RECORDS, [
      { workspaceId: 'w1', title: '   ', path: RECORDS[0]!.anchorPath },
    ])).toEqual([])
  })

  it('reports nothing when both sides already agree', () => {
    expect(titleDrift(RECORDS, [
      { workspaceId: 'w1', title: 'zebrafish_westlake_new', path: RECORDS[0]!.anchorPath },
    ])).toEqual([])
  })
})
