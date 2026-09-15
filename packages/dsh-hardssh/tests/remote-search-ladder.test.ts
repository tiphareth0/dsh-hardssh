/** Search backend ladder (P1-D): rg → POSIX templates → SFTP fallback. */

import { describe, expect, it } from 'vitest'
import type { RemoteCapabilities } from '../src/ssh/capabilities/service.ts'
import { unknownCapabilities } from '../src/ssh/capabilities/service.ts'
import { RemoteSearchService } from '../src/remote-search.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'

const target = { alias: 'host', root: '/srv/app' }

const GNU: RemoteCapabilities = {
  platform: 'posix',
  shell: 'bash',
  rg: { available: false },
  find: { vendor: 'gnu', printf: true, mmin: true },
  grep: { vendor: 'gnu', nullFile: true, excludeDir: true },
  mktemp: true,
}

/** Build a service whose capability probe answers with `capabilities`. */
function service(fake: FakeEngine, capabilities?: RemoteCapabilities | (() => never)): RemoteSearchService {
  const report = capabilities ?? fake.capabilitiesResult
  const probe = typeof report === 'function'
    ? report
    : async () => report
  return new RemoteSearchService(asSshEngine(fake), probe as (alias: string) => Promise<RemoteCapabilities>)
}

/** Scripted stdout as the status-preserving wrapper produces it. */
const wrapped = (body: string, code: number, err = ''): string => `${body}\0DSH_SEARCH_STATUS:${code}\0${err}`

describe('search ladder — ripgrep rung', () => {
  const withRg = { ...GNU, rg: { available: true, version: 'ripgrep 13.0.0' } }

  it('uses rg --vimgrep for a fixed-string grep and drops the column field', async () => {
    const fake = new FakeEngine()
    fake.onUnknownCommand = () => wrapped('/srv/app/a.ts:3:7:const x = 1\n', 0)
    const result = await service(fake, withRg).grep(target, 'x')
    const command = fake.commands[0] ?? ''
    expect(command).toContain('rg --vimgrep')
    expect(command).toContain('--fixed-strings')
    expect(command).toContain('--no-ignore')
    expect(command).toContain('--hidden')
    expect(command).toContain("--glob '!.git'")
    expect(result.lines).toEqual(['/srv/app/a.ts:3:const x = 1'])
    expect(result.backend).toBe('rg')
  })

  it('passes the pattern through as a regex when syntax="regex"', async () => {
    const fake = new FakeEngine()
    fake.onUnknownCommand = () => wrapped('', 1)
    await service(fake, withRg).grep(target, 'const\\s+x', { syntax: 'regex' })
    const command = fake.commands[0] ?? ''
    expect(command).not.toContain('--fixed-strings')
    expect(command).toContain('const\\s+x')
  })

  it('treats rg exit 1 as no matches and exit 2 as a failure', async () => {
    const noMatch = new FakeEngine()
    noMatch.onUnknownCommand = () => wrapped('', 1)
    await expect(service(noMatch, withRg).grep(target, 'zzz'))
      .resolves.toMatchObject({ lines: [], truncated: false, backend: 'rg' })

    const broken = new FakeEngine()
    broken.onUnknownCommand = () => wrapped('', 2, 'rg: /srv/app: No such file or directory')
    await expect(service(broken, withRg).grep(target, 'zzz')).rejects.toThrow('No such file or directory')
  })
})

describe('search ladder — SFTP fallback', () => {
  /** A BSD/BusyBox host: neither rung's flags were probed. */
  const BSD: RemoteCapabilities = {
    ...unknownCapabilities(),
    platform: 'posix',
    shell: 'sh',
    find: { vendor: 'bsd', printf: false, mmin: false },
    grep: { vendor: 'busybox', nullFile: false, excludeDir: false },
    mktemp: true,
  }

  function seeded(): FakeEngine {
    const fake = new FakeEngine()
    fake.capabilitiesResult = BSD
    fake.seedFile('/srv/app/README.md', '# app\n')
    fake.seedFile('/srv/app/src/main.ts', 'export const main = 1\nconst needle = 2\n')
    fake.seedFile('/srv/app/src/other.ts', 'nothing here\n')
    fake.seedFile('/srv/app/node_modules/pkg/needle.ts', 'needle\n')
    return fake
  }

  it('globs and name-searches over SFTP without running any command', async () => {
    const fake = seeded()
    const search = service(fake)
    const glob = await search.glob(target, '**/*.ts')
    expect(glob.hits).toEqual(['/srv/app/src/main.ts', '/srv/app/src/other.ts'])
    expect(glob.backend).toBe('sftp')
    const names = await search.searchNames(target, 'main')
    expect(names.hits).toEqual([{ path: '/srv/app/src/main.ts', isDir: false }])
    expect(names.backend).toBe('sftp')
    expect(fake.commands).toEqual([])
  })

  it('greps over SFTP with fixed strings', async () => {
    const fake = seeded()
    const result = await service(fake).grep(target, 'needle')
    expect(result.lines).toEqual(['/srv/app/src/main.ts:2:const needle = 2'])
    expect(result.backend).toBe('sftp')
    expect(fake.commands).toEqual([])
  })

  it('refuses a regex search when the host has no regex engine', async () => {
    const fake = seeded()
    await expect(service(fake).grep(target, 'need.*le', { syntax: 'regex' }))
      .rejects.toThrow(/regex content search is unavailable/)
    expect(fake.commands).toEqual([])
  })

  it('falls back when mktemp is missing (the status wrapper cannot run)', async () => {
    const fake = seeded()
    fake.capabilitiesResult = { ...GNU, mktemp: false }
    const result = await service(fake).glob(target, '**/*.ts')
    expect(result.backend).toBe('sftp')
    expect(fake.commands).toEqual([])
  })

  it('falls back when the probe itself fails, instead of failing the search', async () => {
    const fake = seeded()
    const search = service(fake, () => { throw new Error('probe exploded') })
    const result = await search.grep(target, 'needle')
    expect(result.backend).toBe('sftp')
    expect(result.lines).toEqual(['/srv/app/src/main.ts:2:const needle = 2'])
  })

  it('still fails loudly when the root itself cannot be listed', async () => {
    const fake = new FakeEngine()
    fake.capabilitiesResult = BSD
    await expect(service(fake).glob({ ...target, root: '/srv/missing' }, '**/*.ts'))
      .rejects.toThrow(/no such file or directory: \/srv\/missing/)
  })
})

describe('search ladder — POSIX rung', () => {
  it('keeps using the probed GNU templates when they are available', async () => {
    const fake = new FakeEngine()
    fake.onUnknownCommand = () => wrapped('f\0/srv/app/a.ts\0', 0)
    const search = service(fake, GNU)
    const result = await search.glob(target, '**/*.ts')
    expect(result.backend).toBe('find-grep')
    expect(fake.commands[0]).toContain('find ')
    await search.grep(target, 'x')
    expect(fake.commands[1]).toContain('grep -rInFZ')
  })

  it('uses grep -E for a regex on a GNU host', async () => {
    const fake = new FakeEngine()
    fake.onUnknownCommand = () => wrapped('', 1)
    await service(fake, GNU).grep(target, 'a.*b', { syntax: 'regex' })
    expect(fake.commands[0]).toContain('grep -rInEZ')
  })
})
