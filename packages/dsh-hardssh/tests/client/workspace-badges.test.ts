/**
 * The shell-tooltip rewrite for SSH workspaces.
 *
 * DSH renders its own styled tooltip bubble for a sidebar row and prints the
 * workspace PATH there. For an SSH workspace that path is the LOCAL anchor
 * directory (`~/.dsh/ssh-workspaces/<id>`) — meaningless to the user, who asked
 * to see the remote directory instead. The plugin added a second tooltip via a
 * row `<title>` attribute, which produced two cards in a row: the shell's (local
 * anchor) and then the plugin's (remote). The fix is one implementation: keep
 * the shell bubble and rewrite its text, which is what `replaceAnchorPaths`
 * does (the DOM walk itself needs a browser and is exercised in the GUI).
 */
import { describe, expect, it } from 'vitest'
import { replaceAnchorPaths } from '../../src/client/workspace-badges.ts'

const ANCHOR = 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\7821e2ce'
const LABEL = '/yutiancheng/2026/regvelo（regvelo）'

function labels(): Map<string, string> {
  return new Map([
    [ANCHOR, LABEL],
    [ANCHOR.replace(/\\/g, '/'), LABEL],
  ])
}

describe('replaceAnchorPaths', () => {
  it('replaces the local anchor with the remote label', () => {
    expect(replaceAnchorPaths(ANCHOR, labels())).toBe(LABEL)
  })

  it('rewrites an anchor embedded in a longer tooltip line', () => {
    expect(replaceAnchorPaths(`打开 ${ANCHOR} 中的文件`, labels())).toBe(`打开 ${LABEL} 中的文件`)
  })

  it('matches case-insensitively and with forward slashes', () => {
    expect(replaceAnchorPaths(ANCHOR.toLowerCase(), labels())).toBe(LABEL)
    expect(replaceAnchorPaths(ANCHOR.replace(/\\/g, '/'), labels())).toBe(LABEL)
  })

  it('leaves unrelated text untouched', () => {
    const text = 'C:\\Users\\Kether\\.dsh\\ssh-workspaces\\other-id'
    expect(replaceAnchorPaths(text, labels())).toBe(text)
    expect(replaceAnchorPaths('普通文本', labels())).toBe('普通文本')
  })

  it('is idempotent and tolerates `$` in the label', () => {
    const map = new Map([['/tmp/anchor', 'cost $1 path']])
    const once = replaceAnchorPaths('/tmp/anchor', map)
    expect(once).toBe('cost $1 path')
    expect(replaceAnchorPaths(once, map)).toBe(once)
  })

  it('ignores an empty anchor entry', () => {
    const map = new Map([['', 'should-not-apply']])
    expect(replaceAnchorPaths('anything', map)).toBe('anything')
  })
})
