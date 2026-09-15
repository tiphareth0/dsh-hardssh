import { describe, expect, it } from 'vitest'
import { checkLocalWorkspacePath } from '../../src/client/local-workspace-path.ts'

describe('checkLocalWorkspacePath', () => {
  it('rejects a Windows drive root', () => {
    // The reported failure: the kernel's session creation runs
    // mkdir(cwd, { recursive: true }), and Windows answers a drive root with
    // EPERM instead of swallowing an existing directory.
    for (const input of ['C:\\', 'C:/', 'c:\\', 'C:', 'D:\\', ' C:\\ ']) {
      expect(checkLocalWorkspacePath(input), input).toEqual({ ok: false, problem: 'filesystem-root' })
    }
  })

  it('rejects UNC share roots', () => {
    for (const input of ['\\\\server\\share', '\\\\server\\share\\', '//server/share']) {
      expect(checkLocalWorkspacePath(input), input).toEqual({ ok: false, problem: 'filesystem-root' })
    }
  })

  it('rejects the POSIX root', () => {
    expect(checkLocalWorkspacePath('/')).toEqual({ ok: false, problem: 'filesystem-root' })
  })

  it('rejects relative and empty input', () => {
    expect(checkLocalWorkspacePath('   ')).toEqual({ ok: false, problem: 'empty' })
    expect(checkLocalWorkspacePath('projects/app')).toEqual({ ok: false, problem: 'not-absolute' })
    expect(checkLocalWorkspacePath('C:projects')).toEqual({ ok: false, problem: 'not-absolute' })
  })

  it('accepts real directories and only trims trailing separators', () => {
    expect(checkLocalWorkspacePath('C:\\projects')).toEqual({ ok: true, path: 'C:\\projects' })
    expect(checkLocalWorkspacePath('C:\\projects\\')).toEqual({ ok: true, path: 'C:\\projects' })
    expect(checkLocalWorkspacePath('C:/projects/app//')).toEqual({ ok: true, path: 'C:/projects/app' })
    expect(checkLocalWorkspacePath('/home/me/proj/')).toEqual({ ok: true, path: '/home/me/proj' })
    expect(checkLocalWorkspacePath('\\\\server\\share\\proj')).toEqual({ ok: true, path: '\\\\server\\share\\proj' })
    // Case and inner separators are preserved: the workspace must point exactly
    // where the operator picked.
    expect(checkLocalWorkspacePath('c:\\Projects\\App')).toEqual({ ok: true, path: 'c:\\Projects\\App' })
  })
})
