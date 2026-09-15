/**
 * Workspace-search bridge (P1-E): the seam side of the transparent glob/grep
 * takeover. The model-facing tools spawn the client's bundled ripgrep; in a
 * bound workspace this bridge answers that spawn from the workspace search and
 * projects the result back into ripgrep's own output shape.
 *
 * The argv literals below are what `@deepseek-ai/dsh-tool-fs-search`
 * (`buildGlobCommand` / `buildGrepCommand`, v0.1.5-rc.1) actually produces:
 * `--no-config`, then the mode flag, then the model values, then the VCS
 * excludes. They are duplicated here on purpose — a change there must be a
 * visible test change here, never a silently wrong search.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  confineSearchRoot,
  isClientSearchHelperPath,
  parseRgInvocation,
  WorkspaceSearchSpawner,
} from '../../src/remote/search-bridge.ts'
import type { RemoteSearchService } from '../../src/remote-search.ts'
import type { WorkspaceState } from '../../src/protocol.ts'
import { FakeEngine, asSshEngine } from '../providers/fake-ssh-engine.ts'

const RG_EXE = 'C:\\ProgramData\\dsh\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe'

/** Exactly what `buildGlobCommand({pattern, path})` returns, behind the exe. */
const globArgv = (pattern: string, path?: string): string[] => [
  RG_EXE,
  '--no-config',
  '--files',
  `--glob=${pattern}`,
  '--sort=modified',
  '--no-ignore',
  '--hidden',
  '--glob=!**/.git',
  '--glob=!**/.git/**',
  '--glob=!**/.svn',
  '--glob=!**/.svn/**',
  ...(path === undefined ? [] : ['--', path]),
]

/** Exactly what `buildGrepCommand({pattern, path, include})` returns. */
const grepArgv = (pattern: string, options: { path?: string; include?: string } = {}): string[] => [
  RG_EXE,
  '--no-config',
  '--json',
  `--regexp=${pattern}`,
  ...(options.include === undefined ? [] : [`--glob=${options.include}`]),
  ...(options.path === undefined ? [] : ['--', options.path]),
]

describe('search bridge recognition', () => {
  it('recognises the bundled-ripgrep argv shapes', () => {
    expect(isClientSearchHelperPath(RG_EXE)).toBe(true)
    expect(isClientSearchHelperPath('/opt/dsh/ripgrep/bin/rg')).toBe(true)
    expect(isClientSearchHelperPath('rg')).toBe(false)
    expect(isClientSearchHelperPath('/usr/bin/grep')).toBe(false)

    expect(parseRgInvocation(globArgv('src/**/*.ts', 'src'))).toEqual({
      mode: 'files',
      globs: ['src/**/*.ts'],
      path: 'src',
    })
    expect(parseRgInvocation(grepArgv('const\\s+x', { include: '*.ts', path: 'src' }))).toEqual({
      mode: 'json',
      globs: ['*.ts'],
      pattern: 'const\\s+x',
      path: 'src',
    })
    // VCS excludes are negated globs: ignored, the ladder skips those dirs.
    expect(parseRgInvocation(globArgv('**/*.log'))?.globs).toEqual(['**/*.log'])
  })

  it('refuses an argv it cannot serve instead of guessing', () => {
    // An unknown BARE flag may consume the next argument.
    expect(parseRgInvocation([RG_EXE, '--no-config', '--files', '--unknown-bare'])).toBeUndefined()
    // Unknown INLINE flags cannot, so they are tolerated.
    expect(parseRgInvocation([RG_EXE, '--no-config', '--files', '--threads=4', '--glob=*.ts'])?.mode).toBe('files')
    // No mode flag, or a json search with no pattern, is not one of our shapes.
    expect(parseRgInvocation([RG_EXE, '--no-config', '--glob=*.ts'])).toBeUndefined()
    expect(parseRgInvocation([RG_EXE, '--no-config', '--json'])).toBeUndefined()
    // Two positive globs cannot be expressed as one ladder pattern.
    expect(parseRgInvocation([RG_EXE, '--no-config', '--files', '--glob=a', '--glob=b'])).toBeUndefined()
  })

  it('confines the search root to the workspace root', () => {
    expect(confineSearchRoot('/srv/app', undefined)).toBe('/srv/app')
    expect(confineSearchRoot('/srv/app', '.')).toBe('/srv/app')
    expect(confineSearchRoot('/srv/app', 'src')).toBe('/srv/app/src')
    expect(confineSearchRoot('/srv/app/', 'src/nested')).toBe('/srv/app/src/nested')
    expect(confineSearchRoot('/srv/app', '/srv/app/src')).toBe('/srv/app/src')
    expect(() => confineSearchRoot('/srv/app', '/etc')).toThrow(/outside the workspace root/)
    expect(() => confineSearchRoot('/srv/app', '../../etc')).toThrow(/outside the workspace root/)
    // A Windows-shaped path is a caller mistake, reported as such (answering it
    // as an in-root filename would only produce a confusing "not found").
    expect(() => confineSearchRoot('/srv/app', 'C:\\Users\\me')).toThrow(/not a POSIX path/)
  })
})

/** Minimal fake handle for the forward branch. */
function fakeHandle(text: string, exitCode: number): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => {},
    waitForExit: async () => true,
  } as unknown as SubprocessHandle
}

interface Harness {
  spawner: WorkspaceSearchSpawner
  forward: ReturnType<typeof vi.fn>
  engine: FakeEngine
  search: { glob: ReturnType<typeof vi.fn>; grep: ReturnType<typeof vi.fn> }
  spec(overrides?: Partial<SubprocessSpawnSpec>): SubprocessSpawnSpec
}

function harness(options: { rgOnHost?: boolean; state?: Partial<WorkspaceState> } = {}): Harness {
  const engine = new FakeEngine()
  if (options.rgOnHost === true) engine.capabilitiesResult = { ...engine.capabilitiesResult, rg: { available: true, version: 'ripgrep 13.0.0' } }
  const state: WorkspaceState = {
    mode: 'remote',
    alias: 'host',
    remoteRoot: '/srv/app',
    ...options.state,
  }
  const search = {
    glob: vi.fn(async () => ({ hits: [] as string[], truncated: false, backend: 'find-grep' as const })),
    grep: vi.fn(async () => ({ lines: [] as string[], truncated: false, backend: 'find-grep' as const })),
  }
  const forward = vi.fn(() => fakeHandle('/srv/app/src/a.ts\n', 0))
  const spawner = new WorkspaceSearchSpawner({
    engine: asSshEngine(engine),
    getState: () => state,
    spillDir: mkdtempSync(join(tmpdir(), 'search-bridge-')),
    forward: forward as unknown as (spec: SubprocessSpawnSpec) => SubprocessHandle,
    search: () => search as unknown as RemoteSearchService,
  })
  return {
    spawner,
    forward,
    engine,
    search,
    spec: (overrides = {}) => ({
      argv: globArgv('**/*.ts'),
      cwd: 'C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-1',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
      graceMs: 1000,
      ...overrides,
    }),
  }
}

/** Resolve a handle's collected stdout after it settles. */
async function stdoutOf(handle: SubprocessHandle): Promise<string> {
  await handle.done
  return handle.collected.stdout?.readFrom(0).text ?? ''
}

describe('search bridge rungs', () => {
  it('runs the IDENTICAL argv on a host that has ripgrep', async () => {
    const h = harness({ rgOnHost: true })
    const handle = h.spawner.spawn(h.spec({ argv: globArgv('src/**/*.ts', 'src') }))
    expect(await stdoutOf(handle)).toBe('/srv/app/src/a.ts\n')
    expect(h.forward).toHaveBeenCalledTimes(1)
    const forwarded = h.forward.mock.calls[0]![0] as SubprocessSpawnSpec
    // Only argv[0] changes: everything else (flags, caps, cwd, signal) is the
    // caller's, so the native tool layer sees real ripgrep output.
    expect(forwarded.argv[0]).toBe('rg')
    expect(forwarded.argv.slice(1)).toEqual(globArgv('src/**/*.ts', 'src').slice(1))
    expect(forwarded.cwd).toBe(h.spec().cwd)
    expect(h.search.glob).not.toHaveBeenCalled()
  })

  it('answers a --files listing from the ladder when the host has no ripgrep', async () => {
    const h = harness()
    h.search.glob.mockResolvedValue({ hits: ['/srv/app/src/a.ts', '/srv/app/src/b.ts'], truncated: false, backend: 'sftp' })
    const handle = h.spawner.spawn(h.spec({ argv: globArgv('**/*.ts') }))
    expect(await stdoutOf(handle)).toBe('/srv/app/src/a.ts\n/srv/app/src/b.ts\n')
    expect(await handle.done).toMatchObject({ exitCode: 0 })
    expect(h.forward).not.toHaveBeenCalled()
    // A files listing must never include directories.
    expect(h.search.glob).toHaveBeenCalledWith(
      { alias: 'host', root: '/srv/app' },
      '**/*.ts',
      expect.anything(),
      { filesOnly: true },
    )
  })

  it('reports exit 1 and no output for an empty listing', async () => {
    const h = harness()
    const handle = h.spawner.spawn(h.spec())
    expect(await stdoutOf(handle)).toBe('')
    expect(await handle.done).toMatchObject({ exitCode: 1, signal: null })
  })

  it('projects a content search into rg --json records the native parser accepts', async () => {
    const h = harness()
    h.search.grep.mockResolvedValue({
      lines: ['/srv/app/src/a.ts:2:const needle = 2', '/srv/app/src/b.js:1:const needle = 9'],
      truncated: false,
      backend: 'find-grep',
    })
    const handle = h.spawner.spawn(h.spec({ argv: grepArgv('needle', { include: '*.ts' }) }))
    const text = await stdoutOf(handle)
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    expect(records).toEqual([
      { type: 'match', data: { path: { text: '/srv/app/src/a.ts' }, line_number: 2, lines: { text: 'const needle = 2\n' } } },
    ])
    // The regex flag of the native grep tool maps onto the ladder's regex rung.
    expect(h.search.grep).toHaveBeenCalledWith(
      { alias: 'host', root: '/srv/app' },
      'needle',
      { syntax: 'regex', signal: expect.anything() },
    )
  })

  it('reports a failed search as exit 2 with its reason on stderr, never as an opaque rejection', async () => {
    const h = harness()
    h.search.grep.mockRejectedValue(new Error('remote grep failed with exit code 2 (grep: Unmatched ( or \\()'))
    const handle = h.spawner.spawn(h.spec({ argv: grepArgv('(unclosed') }))
    // Settled, not rejected: the native tool reads stderr only for a settled
    // outcome, so a rejection would reach the model as a bare "provider failure".
    await expect(handle.done).resolves.toEqual({ exitCode: 2, signal: null })
    expect(handle.collected.stderr?.readFrom(0).text ?? '').toContain('Unmatched (')
    expect(handle.collected.stdout?.readFrom(0).text ?? '').toBe('')
  })

  it('settles a caller abort without an opaque failure (the tool classifies the abort itself)', async () => {
    const h = harness()
    const controller = new AbortController()
    h.search.glob.mockImplementation(async () => {
      controller.abort(new Error('tool timed out'))
      throw new Error('aborted while searching')
    })
    const handle = h.spawner.spawn(h.spec({ signal: controller.signal }))
    await expect(handle.done).resolves.toEqual({ exitCode: 2, signal: null })
    expect(handle.collected.stderr?.readFrom(0).text ?? '').toContain('aborted')
  })

  it('refuses a search root outside the workspace and runs nothing', async () => {
    const h = harness()
    const handle = h.spawner.spawn(h.spec({ argv: globArgv('**/*.ts', '/etc') }))
    await expect(handle.done).resolves.toEqual({ exitCode: 2, signal: null })
    expect(handle.collected.stderr?.readFrom(0).text ?? '').toContain('outside the workspace root')
    expect(h.search.glob).not.toHaveBeenCalled()
    expect(h.forward).not.toHaveBeenCalled()
  })

  it('throws the actionable refusal for an argv it does not recognise', () => {
    const h = harness()
    expect(() => h.spawner.spawn(h.spec({ argv: [RG_EXE, '--no-config', '--unknown-bare'] })))
      .toThrow(/client-side search tool and cannot read the remote workspace/)
    expect(() => h.spawner.spawn(h.spec({ argv: [RG_EXE, '--no-config', '--unknown-bare'] })))
      .toThrow(/remote_search/)
    expect(h.forward).not.toHaveBeenCalled()
  })

  it('redacts the synthesised output like every other remote output path', async () => {
    const h = harness()
    h.search.glob.mockResolvedValue({ hits: ['/srv/app/secret-hunter2.ts'], truncated: false, backend: 'sftp' })
    h.engine.redact = (text: string) => text.replaceAll('hunter2', '***')
    const handle = h.spawner.spawn(h.spec())
    expect(await stdoutOf(handle)).toBe('/srv/app/secret-***.ts\n')
  })
})
