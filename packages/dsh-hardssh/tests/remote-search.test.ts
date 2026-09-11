/**
 * RemoteSearchService unit tests (P1-11): command building, literal escaping,
 * NUL-delimited parsing, and truncation rules — verified against a fake
 * engine that records commands and returns constructed output.
 */

import { describe, expect, it } from 'vitest'
import type { SshEngine } from '../src/ssh/engine.ts'
import { RemoteSearchService } from '../src/remote-search.ts'

interface ExecShape {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
}

/** In-memory engine stub: records commands, returns scripted output. */
class FakeEngine {
  commands: string[] = []
  respond: { stdout: string; exitCode?: number; success?: boolean } = { stdout: '' }

  async exec(_alias: string, command: string): Promise<ExecShape> {
    this.commands.push(command)
    return {
      success: this.respond.success ?? true,
      exitCode: this.respond.exitCode ?? 0,
      stdout: this.respond.stdout,
      stderr: '',
    }
  }
}

const engine = (fake: FakeEngine): SshEngine => fake as unknown as SshEngine
const target = { alias: 'host', root: '/srv/app' }

describe('RemoteSearchService (P1-11)', () => {
  it('searchNames escapes find metacharacters and uses NUL output', async () => {
    const fake = new FakeEngine()
    fake.respond = { stdout: 'd\0/srv/app/src\0f\0/srv/app/a[b]*?.ts\0' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.searchNames(target, 'a[b]*?.ts')
    expect(fake.commands[0]).toContain('-iname')
    expect(fake.commands[0]).toContain('\\*')
    expect(fake.commands[0]).toContain('%y\\0%p\\0')
    expect(result.hits).toEqual([
      { path: '/srv/app/src', isDir: true },
      { path: '/srv/app/a[b]*?.ts', isDir: false },
    ])
    expect(result.truncated).toBe(false)
  })

  it('searchNames caps at 200 hits and reports truncation only when more exist', async () => {
    const fake = new FakeEngine()
    const records: string[] = []
    for (let i = 0; i < 201; i += 1) records.push('f', `/srv/app/f${i}.ts`)
    fake.respond = { stdout: records.join('\0') + '\0' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.searchNames(target, 'f')
    expect(result.hits).toHaveLength(200)
    expect(result.truncated).toBe(true)
  })

  it('exactly 200 hits is NOT truncation', async () => {
    const fake = new FakeEngine()
    const records: string[] = []
    for (let i = 0; i < 200; i += 1) records.push('f', `/srv/app/f${i}.ts`)
    fake.respond = { stdout: records.join('\0') + '\0' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.searchNames(target, 'f')
    expect(result.hits).toHaveLength(200)
    expect(result.truncated).toBe(false)
  })

  it('glob keeps glob semantics and parses NUL records', async () => {
    const fake = new FakeEngine()
    fake.respond = { stdout: '/srv/app/a.ts\0/srv/app/b.ts\0' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.glob(target, '**/*.ts')
    expect(fake.commands[0]).toContain('-path')
    expect(fake.commands[0]).toContain('%p\\0')
    expect(result.hits).toEqual(['/srv/app/a.ts', '/srv/app/b.ts'])
    expect(result.truncated).toBe(false)
  })

  it('grepFixed uses -F -Z -- and treats exit 1 as no matches', async () => {
    const fake = new FakeEngine()
    fake.respond = { stdout: '', exitCode: 1, success: false }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.grepFixed(target, 'hello.world')
    expect(fake.commands[0]).toContain('grep -rInFZ')
    expect(fake.commands[0]).toContain('--')
    expect(result.lines).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('grepFixed parses NUL-separated file boundaries and continuations', async () => {
    const fake = new FakeEngine()
    fake.respond = { stdout: '/srv/app/a.ts\0:const x = 1\n:b const y = 2\n' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.grepFixed(target, 'x')
    expect(result.lines).toEqual([
      '/srv/app/a.ts:const x = 1',
      '/srv/app/a.ts:b const y = 2',
    ])
  })

  it('grep truncation is measured in bytes, not UTF-16 units', async () => {
    const fake = new FakeEngine()
    // 199999 ASCII + one 3-byte char: byteLength 200002 >= 200000, UTF-16 length 200000.
    fake.respond = { stdout: 'x'.repeat(199_999) + '你' }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.grepFixed(target, 'x')
    expect(result.truncated).toBe(true)
  })

  it('rejects NUL in the grep pattern defensively', async () => {
    const fake = new FakeEngine()
    const service = new RemoteSearchService(engine(fake))
    const result = await service.grepFixed(target, 'a\0b')
    expect(fake.commands).toHaveLength(0)
    expect(result.lines).toEqual([])
  })
})

/**
 * P1-5: the producer's real exit code and stderr must survive the output cap.
 * `find ... | head -c N` reported head's status, so a missing root or a
 * permission failure returned "success, no matches" and the agent concluded the
 * remote really had no such file.
 */
describe('RemoteSearchService producer status (P1-5)', () => {
  /** Fake engine that also returns a wrapped stdout trailer like the real shell. */
  class WrappingEngine extends FakeEngine {
    stderr = ''
    override async exec(_alias: string, command: string): Promise<ExecShape> {
      this.commands.push(command)
      return { success: true, exitCode: 0, stdout: this.respond.stdout, stderr: this.stderr }
    }
  }

  /** Build the stdout a wrapped command produces: capped body + status trailer. */
  const wrapped = (body: string, code: number, err = ''): string =>
    `${body}\0DSH_SEARCH_STATUS:${code}\0${err}`

  it('fails instead of reporting an empty success when the root is missing', async () => {
    const fake = new WrappingEngine()
    fake.respond = { stdout: wrapped('', 1, "find: '/srv/gone': No such file or directory") }
    const service = new RemoteSearchService(engine(fake))
    await expect(service.searchNames(target, 'x')).rejects.toThrow("find: '/srv/gone': No such file or directory")
  })

  it('fails the same way for glob and surfaces permission errors', async () => {
    const fake = new WrappingEngine()
    fake.respond = { stdout: wrapped('', 1, "find: '/srv/app': Permission denied") }
    const service = new RemoteSearchService(engine(fake))
    await expect(service.glob(target, '**/*.ts')).rejects.toThrow('Permission denied')
  })

  it('still returns hits a partially failing find produced', async () => {
    const fake = new WrappingEngine()
    fake.respond = { stdout: wrapped('f\0/srv/app/a.ts\0', 1, 'find: permission denied on subdir') }
    const service = new RemoteSearchService(engine(fake))
    const result = await service.searchNames(target, 'a')
    expect(result.hits).toEqual([{ path: '/srv/app/a.ts', isDir: false }])
  })

  it('grep keeps exit 1 as "no matches" but fails on exit 2', async () => {
    const noMatch = new WrappingEngine()
    noMatch.respond = { stdout: wrapped('', 1) }
    await expect(new RemoteSearchService(engine(noMatch)).grepFixed(target, 'zzz'))
      .resolves.toEqual({ lines: [], truncated: false })

    const broken = new WrappingEngine()
    broken.respond = { stdout: wrapped('', 2, 'grep: /srv/app: No such file or directory') }
    await expect(new RemoteSearchService(engine(broken)).grepFixed(target, 'zzz'))
      .rejects.toThrow('No such file or directory')
  })

  it('measures truncation from the capped body, not the trailer', async () => {
    const fake = new WrappingEngine()
    fake.respond = { stdout: wrapped('x'.repeat(199_999) + '你', 0) }
    const result = await new RemoteSearchService(engine(fake)).grepFixed(target, 'x')
    expect(result.truncated).toBe(true)
  })

  it('fails instead of trusting the wrapper status when the trailer is missing', async () => {
    // A hard-killed search shell leaves no trailer; the wrapper itself exits 0
    // (its last command succeeded). Falling back to that would resurrect the
    // "success, no matches" bug for precisely the timed-out case.
    const fake = new WrappingEngine()
    fake.respond = { stdout: '' }
    await expect(new RemoteSearchService(engine(fake)).searchNames(target, 'x'))
      .rejects.toThrow(/did not report a result status/)
  })

  it('cleans its temp directory through a trap and prunes abandoned ones', async () => {
    const fake = new WrappingEngine()
    fake.respond = { stdout: wrapped('', 0) }
    await new RemoteSearchService(engine(fake)).glob(target, '**/*.ts')
    const command = fake.commands[0] ?? ''
    // One mktemp -d (a half-failed `mktemp` pair leaked the first file) under a
    // per-user scratch root, plus a trap: SIGKILL cannot be trapped, so the next
    // search prunes anything the previous one left behind.
    expect(command).toContain('mktemp -d "$__dsh_root/run.XXXXXX"')
    expect(command).toContain('trap')
    expect(command).toContain('dsh-hardssh-search')
    expect(command).toContain('-mmin +10 -exec rm -rf')
    expect(command).not.toContain('mktemp) && __dsh_err=$(mktemp)')
  })
})
