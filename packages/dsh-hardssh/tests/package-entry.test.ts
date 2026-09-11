/**
 * C-02: the package advertises a reusable generic base, so the advertised
 * entry must be REAL — a build entry plus a package export — instead of
 * consumers reaching into `src/` (unstable layout, not guaranteed runnable).
 *
 * The assertions stay on the manifest/config text so they hold without a
 * build; the built artifact itself is verified by `pnpm exec tsdown`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/** The manifest fields this suite asserts on. */
interface PackageManifest {
  exports: Record<string, { types?: string; default?: string }>
  files: string[]
}

/** Parsed package.json of @tiphareth/dsh-hardssh. */
function manifest(): PackageManifest {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
}

describe('public base entry (C-02)', () => {
  it('exports ./base pointing at built JS and emitted types', () => {
    const entry = manifest().exports['./base']
    expect(entry).toBeDefined()
    expect(entry?.default).toBe('./lib/base/index.js')
    expect(entry?.types).toBe('./lib/types/base/index.d.ts')
  })

  it('keeps the types-only ./workspace entry and the node/client entries', () => {
    const exports = manifest().exports
    expect(exports['./workspace']?.default).toBe('./lib/workspace.js')
    expect(exports['.']?.default).toBe('./lib/index.js')
    expect(exports['./client']?.default).toBe('./lib/client.js')
  })

  it('ships the nested base artifact in the published files list', () => {
    expect(manifest().files).toContain('lib/base/*.js')
  })

  it('declares src/base/index.ts as a real tsdown entry', () => {
    const config = readFileSync(join(packageRoot, 'tsdown.config.ts'), 'utf8')
    expect(config).toContain("'src/base/index.ts'")
  })
})
