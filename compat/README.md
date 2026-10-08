# DSH compatibility sets

Each `dsh-*.json` here is one **coherent** set of `@deepseek-ai/*` versions to run
the plugin against. `scripts/compat/apply-set.mjs` applies a set to an ephemeral
checkout (devDependencies + root `pnpm.overrides`), which is exactly what
`.github/workflows/compat.yml` does per matrix leg.

Rules:

- A set is added only with evidence that `pnpm typecheck`, the test suite, the
  build and `npm pack` all pass against it.
- The declared `peerDependencies` range in `packages/dsh-hardssh/package.json`
  must not be wider than the sets that pass.
- `verified-incompatible-*.json` records a set that was tried and failed, so the
  failure is not re-litigated from scratch. It is NOT part of the CI matrix.

## Current state

| Set | Result |
|---|---|
| `dsh-0.1.5-rc.1.json` | ✅ passes (production-verified baseline) |
| `dsh-0.1.5-rc.2.json` | ✅ passes |
| `dsh-0.1.6-alpha.1.json` | ✅ passes |
| `dsh-0.1.6-alpha.2.json` | ✅ passes (current 0.1.6 line; components that do not publish `0.1.6-alpha.x` stay on `0.1.5-rc.2` — currently only `dsh-code-runtime`) |
| `verified-incompatible-dsh-0.1.5-alpha.1.json` | ❌ `pnpm typecheck` fails |

### Why `0.1.5-alpha.*` stays unsupported

`@deepseek-ai/dsh-client-ui-slots@0.1.5-alpha.1` does not declare the `main`
slot, so the workspace manager panel registration is a type error:

```
Type '"main"' is not assignable to type
  '"root" | "conversation.session" | … | "sidebar.right.tab.menu.item"'
```

The center panel would therefore have nowhere to mount on that line; supporting
it would require a degraded slot-registration shim, which is not worth the
complexity for a pre-rc line. The supported range starts at `0.1.5-rc.1`.

### Range widening notes

- The declared peer range `>=0.1.5-rc.1 <0.1.7 || >=0.1.6-alpha.1` matches the
  four passing sets **and** future `0.1.6` stable, and excludes `0.1.5-alpha.*`
  and `0.1.7+`. The `|| >=0.1.6-alpha.1` arm is required because semver only
  matches a prerelease candidate when some comparator shares its
  major.minor.patch tuple and carries a prerelease — a bare
  `>=0.1.5-rc.1 <0.1.7` silently excludes `0.1.6-alpha.x`.

Re-checking a set (or bumping the range) is a deliberate, evidence-backed
change: run the matrix locally before widening anything.

### Why there is no `0.2.0` set yet

The 0.2.0 line is supported and exercised in production — the official Desktop app runs
`0.2.0-rc.2`, where the host half (activation, the `/api/dsh-*` routes, registration into
the official `ctx.workspace`) was verified and the client session-follow was ported to the
new session API — but a `dsh-0.2.0-rc.2.json` set is **not** in the matrix yet: the browser
half still takes its `ClientContext` type from `@deepseek-ai/dsh-client-runtime`, a package
0.2.0 removed. Adding the set therefore requires dropping that type-only import first. The
peer entry for it is already gone, so runtime installation on 0.2.0 is unaffected.
