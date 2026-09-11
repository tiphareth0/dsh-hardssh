/**
 * `secureLocalTransferPath` is the boundary between the remote SSH tools and the
 * DSH host filesystem: `ssh_upload` / `ssh_download` bridge remote I/O to local
 * paths, so the only allowed local roots are the invoking session's workspace.
 * A hole here is a sandbox escape, hence the explicit escape-attempt cases
 * (`..` traversal and symlink/junction redirection) below.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { secureLocalTransferPath } from '../../src/ssh/local-transfer-policy.ts'

let base: string
/** The session workspace (validated absolute cwd). */
let root: string
/** A sibling directory that must never be reachable through the session root. */
let outside: string

/** Tool call context carrying only what the policy reads. */
function runContext(cwd: string | undefined, withSession = true): ToolRunContext {
  if (!withSession) return {} as unknown as ToolRunContext
  return { agent: { session: { header: { cwd } } } } as unknown as ToolRunContext
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'local-transfer-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'inside.txt'), 'inside')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  // A directory link planted inside the workspace and pointing out of it: the
  // canonicalizing check must still refuse it.
  symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('secureLocalTransferPath — accepted paths', () => {
  it('returns the canonical path of an existing in-workspace upload source', () => {
    const source = join(root, 'inside.txt')
    expect(secureLocalTransferPath(runContext(root), source, 'upload-source'))
      .toBe(realpathSync.native(source))
  })

  it('canonicalizes a download destination under its nearest existing ancestor', () => {
    const destination = join(root, 'a', 'b', 'new.txt')
    expect(secureLocalTransferPath(runContext(root), destination, 'download-destination'))
      .toBe(resolve(realpathSync.native(root), 'a', 'b', 'new.txt'))
  })

  it('accepts an existing in-workspace download destination', () => {
    const destination = join(root, 'inside.txt')
    expect(secureLocalTransferPath(runContext(root), destination, 'download-destination'))
      .toBe(realpathSync.native(destination))
  })

  it('compares canonical roots, so a symlinked cwd still matches real paths beneath it', () => {
    const alias = join(base, 'workspace-link')
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(secureLocalTransferPath(runContext(alias), join(root, 'inside.txt'), 'upload-source'))
      .toBe(realpathSync.native(join(root, 'inside.txt')))
  })
})

describe('secureLocalTransferPath — out-of-workspace rejection', () => {
  it('rejects an upload source reached with `..` traversal', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(root, '..', 'outside', 'secret.txt'), 'upload-source'))
      .toThrow(/outside the invoking session workspace/)
  })

  it('rejects a download destination outside the workspace', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(outside, 'written.txt'), 'download-destination'))
      .toThrow(/outside the invoking session workspace/)
  })

  it('rejects a download that would create directories outside the workspace', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(root, '..', 'outside', 'deep', 'written.txt'), 'download-destination'))
      .toThrow(/outside the invoking session workspace/)
  })

  it('rejects an upload source that escapes through a junction inside the workspace', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(root, 'escape', 'secret.txt'), 'upload-source'))
      .toThrow(/outside the invoking session workspace/)
  })

  it('rejects a download destination that escapes through a junction inside the workspace', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(root, 'escape', 'written.txt'), 'download-destination'))
      .toThrow(/outside the invoking session workspace/)
  })

  it('rejects the workspace root itself as an upload source', () => {
    expect(() => secureLocalTransferPath(runContext(root), root, 'upload-source'))
      .toThrow(/is not a regular file/)
  })
})

describe('secureLocalTransferPath — argument validation', () => {
  it('rejects a call without an invoking session workspace', () => {
    expect(() => secureLocalTransferPath(runContext(undefined, false), join(root, 'inside.txt'), 'upload-source'))
      .toThrow(/no invoking session workspace/)
  })

  it('rejects a session whose cwd is empty', () => {
    expect(() => secureLocalTransferPath(runContext(undefined), join(root, 'inside.txt'), 'upload-source'))
      .toThrow(/no invoking session workspace/)
  })

  it('rejects a relative session cwd', () => {
    expect(() => secureLocalTransferPath(runContext('relative/dir'), join(root, 'inside.txt'), 'upload-source'))
      .toThrow(/cwd is not absolute/)
  })

  it('rejects an unavailable session cwd', () => {
    expect(() => secureLocalTransferPath(runContext(join(base, 'gone')), join(root, 'inside.txt'), 'upload-source'))
      .toThrow(/is unavailable/)
  })

  it('rejects a relative local path', () => {
    expect(() => secureLocalTransferPath(runContext(root), 'inside.txt', 'upload-source'))
      .toThrow(/must be absolute/)
  })
})

describe('secureLocalTransferPath — source requirements', () => {
  it('rejects a missing upload source', () => {
    expect(() => secureLocalTransferPath(runContext(root), join(root, 'missing.txt'), 'upload-source'))
      .toThrow(/does not exist/)
  })

  it('rejects a directory as an upload source', () => {
    mkdirSync(join(root, 'dir'), { recursive: true })
    expect(() => secureLocalTransferPath(runContext(root), join(root, 'dir'), 'upload-source'))
      .toThrow(/is not a regular file/)
  })
})
