/**
 * P0 degraded-mode coverage: the fs/subprocess replacement rows are mounted by
 * the bundle patch AFTER the deployment's own `fs-sandbox`/`subprocess` rows are
 * disabled. They must therefore always mount, keep the local host usable when
 * the workspace core is missing or failed, refuse the managed SSH anchor window
 * (fail closed, never local), and report the degradation through health.
 *
 * These tests mount the REAL apply() functions — not a hand-rolled facade — so
 * a future hard dependency on `workspaceCore` fails here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as applyFs } from '../../src/fs.ts'
import { apply as applySubprocess } from '../../src/subprocess.ts'
import { anchorRoot } from '../../src/ledger.ts'
import { HardsshHealthRegistry, mountHardsshHealth } from '../../src/runtime/health.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A host context with the sandbox policy but deliberately NO workspaceCore. */
function degradedContext(root: string): Context {
  const ctx = new Context()
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: root }
  ctx.provide('sandboxPolicy', {
    defaultMode: policy.mode,
    workspaceRoot: root,
    resolve: () => policy,
  })
  return ctx
}

describe('degraded mode without a workspace core', () => {
  it('mounts the filesystem row, keeps the local backend usable, and reports degraded routing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'degraded-fs-'))
    created.push(root)
    writeFileSync(join(root, 'local.txt'), 'local content')
    const ctx = degradedContext(root)

    // The point of P0: mounting must NOT depend on workspaceCore.
    expect(() => { applyFs(ctx) }).not.toThrow()
    expect(ctx.fs).toBeDefined()

    // Local access still works (the host did not lose its filesystem).
    const target = await ctx.fs.resolve(join(root, 'local.txt'))
    await expect(ctx.fs.readText(target)).resolves.toBe('local content')

    const health = mountHardsshHealth(ctx).snapshot()
    expect(health.features.fsRouting.state).toBe('degraded')
    expect(health.features.fsRouting.reason).toMatch(/workspaceCore/)
  })

  it('fails closed for the managed anchor window instead of touching the client filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'degraded-anchor-'))
    created.push(root)
    const ctx = degradedContext(root)
    applyFs(ctx)

    const insideAnchor = join(anchorRoot(), 'some-workspace', 'file.txt')
    await expect(ctx.fs.resolve(insideAnchor)).rejects.toThrow(/anchor root|fails closed/)
    await expect(ctx.fs.lstat(insideAnchor)).rejects.toThrow(/anchor root|fails closed/)
  })

  it('mounts the subprocess row, keeps local execution, and refuses the anchor window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'degraded-sub-'))
    created.push(root)
    const ctx = degradedContext(root)

    expect(() => { applySubprocess(ctx) }).not.toThrow()
    expect(ctx.subprocess).toBeDefined()

    // A local, non-anchor cwd still spawns on this machine.
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 30_000,
    } as never)
    const outcome = await (handle as unknown as { done: Promise<{ exitCode: number | null }> }).done
    expect(outcome.exitCode).toBe(0)

    // Execution beneath the managed anchor root stays refused (fail closed).
    expect(() => ctx.subprocess.spawn({
      argv: [process.execPath, '-e', '0'],
      cwd: join(anchorRoot(), 'some-workspace'),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 10_000,
    } as never)).toThrow(/anchor root|fails closed/)

    const health = mountHardsshHealth(ctx).snapshot()
    expect(health.features.subprocessRouting.state).toBe('degraded')
  })
})

describe('hardssh health registry', () => {
  it('starts degraded for every surface and flips per feature', () => {
    const health = new HardsshHealthRegistry()
    const initial = health.snapshot()
    expect(Object.values(initial.features).every(feature => feature.state === 'degraded')).toBe(true)
    expect(initial.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(initial.testedDshRange).toContain('0.1.5')

    health.set('sshTools', { state: 'ready' })
    expect(health.snapshot().features.sshTools.state).toBe('ready')
    // Unrelated features are untouched.
    expect(health.snapshot().features.workspaceCore.state).toBe('degraded')
  })

  it('hands out copies so a reader cannot mutate the registry', () => {
    const health = new HardsshHealthRegistry()
    health.set('fsRouting', { state: 'failed', reason: 'contract mismatch', missing: ['readByteRange'] })
    const first = health.snapshot()
    first.features.fsRouting.missing?.push('tampered')
    first.features.fsRouting.state = 'ready'
    const second = health.snapshot()
    expect(second.features.fsRouting.state).toBe('failed')
    expect(second.features.fsRouting.missing).toEqual(['readByteRange'])
  })

  it('adopts an existing registry instead of mounting a second one', () => {
    const ctx = new Context()
    const mounted = mountHardsshHealth(ctx)
    expect(mountHardsshHealth(ctx)).toBe(mounted)
  })
})
