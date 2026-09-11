/**
 * Build-time cleanup: remove previous build output before a fresh one.
 *
 * Without this, `lib/` accumulates stale artifacts — split chunks whose hash
 * changed (so the old file is never referenced again) and `.d.ts` files for
 * modules that were DELETED (tsc -b never removes them). Both are inside the
 * published `files` whitelist (`lib/*.js`, `lib/types/**\/*.d.ts`), so a
 * published package would otherwise ship dead code for removed modules.
 *
 * The tsc build info goes with it: `tsc -b` is incremental, so deleting `lib/`
 * while keeping the build info would make tsc believe the (now missing) output
 * is up to date and skip emitting it.
 *
 * Not published: `files` lists `scripts/export-legacy-workspaces.mjs` only.
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
for (const target of ['lib']) {
  rmSync(join(packageRoot, target), { recursive: true, force: true })
  console.log(`cleaned ${target}/`)
}
