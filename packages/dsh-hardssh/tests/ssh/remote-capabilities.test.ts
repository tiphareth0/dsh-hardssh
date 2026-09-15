/** Connection-level remote capability probe (P1-B).
 *
 * The probe decides which search backend may run on a host, so these tests pin
 * down both halves: the classification of a real-looking report (GNU, BSD,
 * BusyBox, Windows/unknown) and the lifecycle (one probe per connection
 * generation, shared by concurrent callers, never cached when it failed, and
 * never able to reject a caller that did not cancel). */
import { describe, expect, it, vi } from 'vitest'
import type { ExecResult } from '../../src/ssh/protocol.ts'
import {
  CAPABILITY_PROBE_MARKER,
  RemoteCapabilityService,
  capabilityProbeCommand,
  classifyCapabilities,
  unknownCapabilities,
} from '../../src/ssh/capabilities/service.ts'

/** One line of the `key\tvalue` report the probe command prints. */
const line = (key: string, value: string): string => `${key}\t${value}\n`

/** A Debian/CentOS-like host with ripgrep and GNU findutils/coreutils. */
const GNU_REPORT =
  line('uname', 'Linux')
  + line('shell', '/bin/bash')
  + line('rg.path', '/usr/bin/rg')
  + line('rg.ver', 'ripgrep 13.0.0')
  + line('find.path', '/usr/bin/find')
  + line('find.ver', "find (GNU findutils) 4.5.11")
  + line('find.printf', 'yes')
  + line('find.mmin', 'yes')
  + line('grep.path', '/usr/bin/grep')
  + line('grep.ver', 'grep (GNU grep) 2.20')
  + line('grep.null', 'yes')
  + line('grep.exclude-dir', 'yes')
  + line('mktemp.path', '/usr/bin/mktemp')

/** macOS/BSD: no `-printf`, no `--exclude-dir`, no system rg. */
const BSD_REPORT =
  line('uname', 'Darwin')
  + line('shell', '/bin/zsh')
  + line('rg.path', '')
  + line('rg.ver', '')
  + line('find.path', '/usr/bin/find')
  + line('find.ver', '')
  + line('find.printf', 'no')
  + line('find.mmin', 'no')
  + line('grep.path', '/usr/bin/grep')
  + line('grep.ver', 'grep (BSD grep, GNU compatible) 2.5.1-FreeBSD')
  + line('grep.null', 'yes')
  + line('grep.exclude-dir', 'no')
  + line('mktemp.path', '/usr/bin/mktemp')

/** Alpine: BusyBox everything, no rg. */
const BUSYBOX_REPORT =
  line('uname', 'Linux')
  + line('shell', '/bin/ash')
  + line('rg.path', '')
  + line('rg.ver', '')
  + line('find.path', '/bin/find')
  + line('find.ver', 'BusyBox v1.36.1 (2023-11-07 18:53:09 UTC) multi-call binary.')
  + line('find.printf', 'no')
  + line('find.mmin', 'yes')
  + line('grep.path', '/bin/grep')
  + line('grep.ver', 'BusyBox v1.36.1 (2023-11-07 18:53:09 UTC) multi-call binary.')
  + line('grep.null', 'no')
  + line('grep.exclude-dir', 'no')
  + line('mktemp.path', '/bin/mktemp')

describe('capability report classification', () => {
  it('classifies a GNU/POSIX host with ripgrep', () => {
    expect(classifyCapabilities(GNU_REPORT)).toEqual({
      platform: 'posix',
      shell: 'bash',
      rg: { available: true, version: 'ripgrep 13.0.0' },
      find: { vendor: 'gnu', printf: true, mmin: true },
      grep: { vendor: 'gnu', nullFile: true, excludeDir: true },
      mktemp: true,
    })
  })

  it('classifies BSD/macOS by the probed flags, not by the uname string', () => {
    const capabilities = classifyCapabilities(BSD_REPORT)
    expect(capabilities.platform).toBe('posix')
    expect(capabilities.shell).toBe('sh')
    expect(capabilities.rg).toEqual({ available: false })
    expect(capabilities.find).toEqual({ vendor: 'bsd', printf: false, mmin: false })
    // BSD grep reports itself GNU-compatible in the banner; the probed
    // `--exclude-dir` answer is what the POSIX grep template must trust.
    expect(capabilities.grep).toEqual({ vendor: 'bsd', nullFile: true, excludeDir: false })
  })

  it('classifies a BusyBox host', () => {
    const capabilities = classifyCapabilities(BUSYBOX_REPORT)
    expect(capabilities.find.vendor).toBe('busybox')
    expect(capabilities.grep.vendor).toBe('busybox')
    expect(capabilities.find.mmin).toBe(true)
    expect(capabilities.grep.excludeDir).toBe(false)
    expect(capabilities.shell).toBe('sh')
  })

  it('classifies MSYS/Cygwin and PowerShell shells as Windows', () => {
    const report = line('uname', 'MINGW64_NT-10.0-22631')
      + line('shell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    const capabilities = classifyCapabilities(report)
    expect(capabilities.platform).toBe('windows')
    expect(capabilities.shell).toBe('powershell')
    expect(capabilities.rg.available).toBe(false)
    expect(capabilities.find.vendor).toBe(false)
  })

  it('reports unknown for an empty or unparseable report', () => {
    expect(classifyCapabilities('')).toEqual(unknownCapabilities())
    expect(classifyCapabilities('cmd.exe is not recognized\n')).toEqual(unknownCapabilities())
  })

  it('does not let a duplicated or oversized value change the answer', () => {
    const report = line('uname', 'Linux')
      + line('rg.path', `/opt/${'x'.repeat(2000)}/rg`)
      + line('uname', 'Windows_NT')
    const capabilities = classifyCapabilities(report)
    // First value wins, and the value is truncated to the parser budget.
    expect(capabilities.platform).toBe('posix')
    expect(capabilities.rg.available).toBe(true)
  })

  it('probes the flags instead of grepping a version string for them', () => {
    // A GNU-looking banner with a non-working `-printf`/`-Z` must not be trusted.
    const report = line('uname', 'Linux')
      + line('find.path', '/usr/bin/find')
      + line('find.ver', 'find (GNU findutils) 4.9.0')
      + line('find.printf', 'no')
      + line('grep.path', '/usr/bin/grep')
      + line('grep.null', 'no')
    const capabilities = classifyCapabilities(report)
    expect(capabilities.find).toEqual({ vendor: 'gnu', printf: false, mmin: false })
    expect(capabilities.grep.nullFile).toBe(false)
  })

  it('builds a read-only probe command with the marker and no traversal', () => {
    const command = capabilityProbeCommand()
    expect(command.startsWith(CAPABILITY_PROBE_MARKER)).toBe(true)
    // `find /` is only ever asked to stat the root itself.
    expect(command).toContain('find / -maxdepth 0')
    expect(command).not.toMatch(/find \/[^ ]* -printf [^x]/)
    for (const forbidden of ['rm ', 'mv ', '> /', 'chmod', 'mktemp -d']) {
      expect(command).not.toContain(forbidden)
    }
  })
})

/** Engineer one probe result out of a scripted exec. */
function execResult(stdout: string, overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    timedOut: false,
    stdout,
    stderr: '',
    durationMs: 1,
    ...overrides,
  }
}

interface Harness {
  service: RemoteCapabilityService
  calls: string[]
  setReport(report: string): void
  setGeneration(generation: number): void
  bumpGeneration(): void
}

function harness(
  report = GNU_REPORT,
  exec?: (alias: string, command: string) => Promise<ExecResult>,
): Harness {
  let current = report
  let generation = 0
  const calls: string[] = []
  const service = new RemoteCapabilityService({
    exec: async (alias, command) => {
      calls.push(command)
      if (exec !== undefined) return await exec(alias, command)
      return execResult(current)
    },
    generation: () => generation,
  })
  return {
    service,
    calls,
    setReport: (value) => { current = value },
    setGeneration: (value) => { generation = value },
    bumpGeneration: () => { generation += 1 },
  }
}

describe('capability probe lifecycle', () => {
  it('probes once per connection generation and reuses the cached report', async () => {
    const h = harness()
    const first = await h.service.capabilities('host')
    const second = await h.service.capabilities('host')
    expect(second).toBe(first)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toContain(CAPABILITY_PROBE_MARKER)

    // A host-config change (invalidate) bumps the generation: probe again, and
    // report whatever the new host says.
    h.bumpGeneration()
    h.setReport(BSD_REPORT)
    const third = await h.service.capabilities('host')
    expect(h.calls).toHaveLength(2)
    expect(third.find.vendor).toBe('bsd')
  })

  it('shares one in-flight probe between concurrent callers', async () => {
    let release!: (result: ExecResult) => void
    const h = harness(GNU_REPORT, async () => await new Promise<ExecResult>((resolve) => { release = resolve }))
    const [a, b] = [h.service.capabilities('host'), h.service.capabilities('host')]
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    release(execResult(GNU_REPORT))
    expect((await a).rg.available).toBe(true)
    expect(await b).toEqual(await a)
    expect(h.calls).toHaveLength(1)
  })

  it('degrades to unknown without caching when the probe times out', async () => {
    const h = harness(GNU_REPORT, async () => execResult('', { success: false, exitCode: null, timedOut: true }))
    expect(await h.service.capabilities('host')).toEqual(unknownCapabilities())
    // Not cached: the next caller tries the host again.
    expect(await h.service.capabilities('host')).toEqual(unknownCapabilities())
    expect(h.calls).toHaveLength(2)
  })

  it('degrades to unknown when exec itself fails, and keeps the transport usable', async () => {
    let fail = true
    const h = harness(GNU_REPORT, async () => {
      if (fail) throw new Error('connection refused')
      return execResult(GNU_REPORT)
    })
    await expect(h.service.capabilities('host')).resolves.toEqual(unknownCapabilities())
    fail = false
    expect((await h.service.capabilities('host')).platform).toBe('posix')
  })

  it('does not cache a report that carries no parseable values', async () => {
    const h = harness('cmd.exe: command not found\n')
    expect(await h.service.capabilities('host')).toEqual(unknownCapabilities())
    expect(await h.service.capabilities('host')).toEqual(unknownCapabilities())
    expect(h.calls).toHaveLength(2)
  })

  it('drops a report the connection outlived while probing', async () => {
    let release!: (result: ExecResult) => void
    let first = true
    const h = harness(GNU_REPORT, async () => {
      if (!first) return execResult(BSD_REPORT)
      first = false
      return await new Promise<ExecResult>((resolve) => { release = resolve })
    })
    const pending = h.service.capabilities('host')
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    // The connection is invalidated while the probe is in flight.
    h.bumpGeneration()
    release(execResult(GNU_REPORT))
    expect((await pending).platform).toBe('posix')
    // The stale report was dropped, so the next caller probes the new host.
    expect((await h.service.capabilities('host')).find.vendor).toBe('bsd')
    expect(h.calls).toHaveLength(2)
  })

  it('lets only the aborting caller fail, and does not poison the cache', async () => {
    const h = harness(GNU_REPORT)
    const controller = new AbortController()
    controller.abort(new Error('caller went away'))
    await expect(h.service.capabilities('host', controller.signal)).rejects.toThrow(/caller went away/)

    // A shared probe is not cancelled by one caller's abort.
    let release!: (result: ExecResult) => void
    const shared = harness(GNU_REPORT, async () => await new Promise<ExecResult>((resolve) => { release = resolve }))
    const waiter = shared.service.capabilities('host')
    const controller2 = new AbortController()
    const aborted = shared.service.capabilities('host', controller2.signal)
    await vi.waitFor(() => expect(shared.calls).toHaveLength(1))
    controller2.abort(new Error('second caller left'))
    await expect(aborted).rejects.toThrow(/second caller left/)
    release(execResult(GNU_REPORT))
    expect((await waiter).platform).toBe('posix')
  })

  it('forgets one alias, or every alias, on demand', async () => {
    const h = harness()
    await h.service.capabilities('host')
    await h.service.capabilities('other')
    expect(h.calls).toHaveLength(2)
    h.service.forget('host')
    await h.service.capabilities('host')
    await h.service.capabilities('other')
    expect(h.calls).toHaveLength(3)
    h.service.forget()
    await h.service.capabilities('host')
    expect(h.calls).toHaveLength(4)
    h.service.dispose()
    await h.service.capabilities('host')
    expect(h.calls).toHaveLength(5)
  })
})
