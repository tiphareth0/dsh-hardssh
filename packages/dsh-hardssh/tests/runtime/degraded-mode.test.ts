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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyFs } from '../../src/fs.ts'
import { apply as applySubprocess } from '../../src/subprocess.ts'
import { anchorRoot } from '../../src/ledger.ts'
import {
  bindHardsshHealthFeature,
  HardsshHealthRegistry,
  mountHardsshHealth,
  watchHardsshOptionalServices,
} from '../../src/runtime/health.ts'

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

    // The sibling row publishes state but never registers the shared service;
    // only the main bundle entry owns `provide('hardsshHealth', ...)`.
    expect(ctx.get('hardsshHealth')).toBeUndefined()
    const registry = mountHardsshHealth(ctx)
    await vi.waitFor(() => expect(registry.snapshot().features.fsRouting.state).toBe('degraded'))
    const health = registry.snapshot()
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

    expect(ctx.get('hardsshHealth')).toBeUndefined()
    const registry = mountHardsshHealth(ctx)
    await vi.waitFor(() => expect(registry.snapshot().features.subprocessRouting.state).toBe('degraded'))
    const health = registry.snapshot()
    expect(health.features.subprocessRouting.state).toBe('degraded')
  })
})

describe('workspaceCore readiness health', () => {
  it('turns both seam features ready when a late core initializes, without a first fs/spawn call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-core-ready-'))
    created.push(root)
    const ctx = degradedContext(root)
    const registry = mountHardsshHealth(ctx)
    applyFs(ctx)
    applySubprocess(ctx)

    let ready = false
    let resolveReady!: () => void
    const pending = new Promise<void>(resolve => { resolveReady = resolve })
    const core = {
      isReady: () => ready,
      whenReady: () => pending,
    }
    ctx.provide('workspaceCore', core as never)

    await vi.waitFor(() => {
      expect(registry.snapshot().features.fsRouting.state).toBe('degraded')
      expect(registry.snapshot().features.subprocessRouting.state).toBe('degraded')
    })
    ready = true
    resolveReady()
    await vi.waitFor(() => {
      expect(registry.snapshot().features.fsRouting).toEqual({ state: 'ready' })
      expect(registry.snapshot().features.subprocessRouting).toEqual({ state: 'ready' })
    })
  })

  it('keeps local fallbacks degraded when late core initialization rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'health-core-failed-'))
    created.push(root)
    const ctx = degradedContext(root)
    const registry = mountHardsshHealth(ctx)
    applyFs(ctx)
    applySubprocess(ctx)
    ctx.provide('workspaceCore', {
      isReady: () => false,
      whenReady: () => Promise.reject(new Error('ledger corrupt')),
    } as never)

    await vi.waitFor(() => {
      expect(registry.snapshot().features.fsRouting.reason).toMatch(/ledger corrupt/)
      expect(registry.snapshot().features.subprocessRouting.reason).toMatch(/ledger corrupt/)
    })
    expect(registry.snapshot().features.fsRouting.state).toBe('degraded')
    expect(registry.snapshot().features.subprocessRouting.state).toBe('degraded')
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
    const updatedAt = health.snapshot().updatedAt
    health.set('sshTools', { state: 'ready' })
    expect(health.snapshot().updatedAt).toBe(updatedAt)
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

  it('lets a sibling publish before the main provider becomes visible', async () => {
    const ctx = new Context()
    const setHealth = bindHardsshHealthFeature(ctx, 'subprocessRouting', {
      state: 'degraded',
      reason: 'workspaceCore is unavailable',
    })

    // A later state must be replayed, and binding must not register a competing
    // hardsshHealth provider while the main bundle entry is still activating.
    setHealth({ state: 'ready' })
    const registry = mountHardsshHealth(ctx)
    await vi.waitFor(() => expect(registry.snapshot().features.subprocessRouting).toEqual({ state: 'ready' }))
  })

  it('binds immediately when the single provider is already visible', async () => {
    const ctx = new Context()
    const registry = mountHardsshHealth(ctx)
    const setHealth = bindHardsshHealthFeature(ctx, 'fsRouting', { state: 'ready' })
    await vi.waitFor(() => expect(registry.snapshot().features.fsRouting).toEqual({ state: 'ready' }))

    setHealth({ state: 'failed', reason: 'later failure', missing: ['router'] })
    await vi.waitFor(() => expect(registry.snapshot().features.fsRouting).toEqual({
      state: 'failed',
      reason: 'later failure',
      missing: ['router'],
    }))
  })

  it('copies an unbound latest value before replaying it', async () => {
    const ctx = new Context()
    const missing = ['workspaceCore']
    const setHealth = bindHardsshHealthFeature(ctx, 'fsRouting', { state: 'degraded', missing })
    missing.push('caller mutation')
    setHealth({ state: 'degraded', reason: 'waiting', missing: ['router'] })
    const registry = mountHardsshHealth(ctx)
    await vi.waitFor(() => expect(registry.snapshot().features.fsRouting).toEqual({
      state: 'degraded',
      reason: 'waiting',
      missing: ['router'],
    }))
  })

  it('tracks an optional service that appears after the initial probe', async () => {
    const ctx = new Context()
    const registry = mountHardsshHealth(ctx)
    watchHardsshOptionalServices(ctx, registry)
    expect(registry.snapshot().optionalServices.find(item => item.service === 'systemPrompt')?.available).toBe(false)

    ctx.provide('systemPrompt', { section: () => () => {} })
    await vi.waitFor(() => expect(
      registry.snapshot().optionalServices.find(item => item.service === 'systemPrompt')?.available,
    ).toBe(true))
  })
})
