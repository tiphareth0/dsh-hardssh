/**
 * Host workspace registry compatibility.
 *
 * 0.2.0 renamed the service this plugin registers its anchors with:
 * `@deepseek-ai/dsh-workspace` provides `ctx.workspace` and ships no
 * `workspaceRegistry` alias. A single-name lookup silently no-ops on 0.2.0 — the
 * anchor is never registered as a real sidebar workspace and nothing reports it
 * — so these cases pin the version-tolerant lookup and the two registry
 * behaviours that differ from the pre-0.2.0 service:
 *
 *  - `resolveByPath` REJECTS for a path it does not know (it never creates one);
 *  - `create` requires an existing directory (`fs.realpath`);
 *  - `delete` answers false for an unknown id.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostWorkspaceRegistry, resolveHostWorkspace, type HostWorkspaceRegistry } from '../src/index.ts'

/** Context stand-in exposing only the service lookup the adapter performs. */
function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

/** A registry that behaves like the 0.2.0 one: rejects unknown paths, needs real dirs. */
function officialLikeRegistry(options: { paths?: string[]; deleteResult?: boolean } = {}) {
  const paths = new Set(options.paths ?? [])
  const calls: string[] = []
  const registry: HostWorkspaceRegistry = {
    async resolveByPath(path) {
      calls.push(`resolve:${path}`)
      // The real service REJECTS here rather than answering undefined.
      if (!paths.has(path)) throw new Error(`unknown workspace path '${path}'`)
      return { id: `ws:${path}` }
    },
    async create(path, title) {
      calls.push(`create:${path}:${title ?? ''}`)
      paths.add(path)
      return { id: `ws:${path}` }
    },
    async delete(id) {
      calls.push(`delete:${id}`)
      return options.deleteResult ?? true
    },
  }
  return { registry, calls, paths }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-ws-registry-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hostWorkspaceRegistry', () => {
  it('prefers the 0.2.0 name and still accepts the pre-0.2.0 name', () => {
    const modern = officialLikeRegistry().registry
    const legacy = officialLikeRegistry().registry
    expect(hostWorkspaceRegistry(ctxWith({ workspace: modern }))).toBe(modern)
    expect(hostWorkspaceRegistry(ctxWith({ workspaceRegistry: legacy }))).toBe(legacy)
    // Both present: the current name wins.
    expect(hostWorkspaceRegistry(ctxWith({ workspace: modern, workspaceRegistry: legacy }))).toBe(modern)
  })

  it('reports no registry instead of guessing when the service is absent or foreign', () => {
    expect(hostWorkspaceRegistry(ctxWith({}))).toBeUndefined()
    // A same-named service without the registry shape must not be adopted.
    expect(hostWorkspaceRegistry(ctxWith({ workspace: { id: 'not-a-registry' } }))).toBeUndefined()
    expect(hostWorkspaceRegistry(ctxWith({ workspace: { create: () => {} } }))).toBeUndefined()
  })
})

describe('resolveHostWorkspace', () => {
  it('turns the registry rejection for an unknown path into "not registered"', async () => {
    const { registry } = officialLikeRegistry()
    await expect(resolveHostWorkspace(registry, join(dir, 'absent'))).resolves.toBeUndefined()
  })

  it('returns the registered workspace for a known path', async () => {
    const anchor = join(dir, 'anchor')
    const { registry } = officialLikeRegistry({ paths: [anchor] })
    await expect(resolveHostWorkspace(registry, anchor)).resolves.toEqual({ id: `ws:${anchor}` })
  })
})
