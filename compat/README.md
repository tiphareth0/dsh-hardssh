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
| `dsh-0.1.5-rc.1.json` | ✅ passes (production-verified line) |
| `verified-incompatible-dsh-0.1.5-alpha.1.json` | ❌ `pnpm typecheck` fails |

### Why `0.1.5-alpha.1` fails

`@deepseek-ai/dsh-client-ui-slots@0.1.5-alpha.1` does not declare the `main`
slot, so the workspace manager panel registration is a type error:

```
Type '"main"' is not assignable to type
  '"root" | "conversation.session" | … | "sidebar.right.tab.menu.item"'
```

The center panel would therefore have nowhere to mount on that line. The
supported range starts at `0.1.5-rc.1`.

Re-checking a set (or bumping the range) is a deliberate, evidence-backed
change: run the matrix locally before widening anything.
