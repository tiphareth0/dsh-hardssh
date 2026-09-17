# Static-scan findings, item by item

Companion to [SECURITY.md](./SECURITY.md). Written for the reviewer of an automated scan:
every finding class this repository triggers is listed with the **exact code it points at**,
who can reach that code, and what (if anything) was changed.

Line numbers are as of `b7358aa` (plugin `0.2.6-alpha`).

## 0. How the scan reads this plugin

`@tiphareth/dsh-hardssh` runs commands and reads/writes files **on the remote hosts the user
configured**; that is its purpose. dsh.so's own risk model maps "shell / subprocess" and
"dynamic code execution" hits to **needs review (medium)**, not critical — only hardcoded
secrets, exfiltration endpoints, destructive patterns and mining are blocking. This
repository has none of those four: no secret material is embedded, `src/` contains no
third-party endpoint (every `fetch()` targets this plugin's own `/api/...` routes), and file
deletion/rewrite is limited to a resolved workspace root plus the plugin's own state files
(`~/.dsh/dsh-ssh.json`, the optional vault, the workspace ledger — all written by atomic
temp-file rename).

Verify the load-bearing claims yourself:

```sh
# 1. no credential-file access anywhere in the source
git grep -nE "id_rsa|id_ed25519|id_ecdsa|\.pem|BEGIN .*PRIVATE KEY" -- packages/dsh-hardssh/src
#    → no output

# 2. every HTTP call goes to the plugin's own relative /api/... route
git grep -nE "API_BASE\s*=|api/dsh" -- packages/dsh-hardssh/src | head
#    → the base constants are relative paths; every fetch() below uses them

# 3. exactly one source file touches node:child_process
git grep -ln "node:child_process" -- packages/dsh-hardssh/src
#    → packages/dsh-hardssh/src/providers/local/provider.ts

# 4. the only absolute URLs in src are a vendored-CSS license header, one upstream-attribution
#    comment, and the loopback URL built from the request's own Host header — no endpoint
git grep -nE "https?://" -- packages/dsh-hardssh/src
```

## A. "Shell command execution (exec / execSync)"

Seven sites carry the method name `exec`. Six are not local shell execution at all.

| # | Location | What it actually is |
|---|---|---|
| A1 | `src/base/capability.ts:53` | **Interface declaration** — `WorkspaceProcessRuntime.exec(...)`. No body, no shell, no `child_process`. It is the capability type the workspace providers implement. |
| A2 | `src/ssh/capabilities/service.ts:174` | **Interface declaration** — `RemoteCapabilityDeps.exec(...)`, injected into the remote capability probe. The implementation is A3. |
| A3 | `src/ssh/engine.ts:298-300` | **Remote execution over the pooled SSH connection** (ssh2 channel): run one command on a host the user configured. Wrapped in a server-side budget (`wrapCommandWithServerBudget`) so a client timeout cannot leave an orphan process on the server. |
| A4 | `src/ssh/engine.ts:194` | The **binding** that feeds A3 into the capability probe: `exec: (alias, command, options) => this.exec(...)`. Not a second implementation. |
| A5 | `src/providers/ssh/provider.ts:94` | The SSH provider's `process()` capability factory — returns DSH's `SshSubprocessRuntime` (structured argv/env/stdio + terminal protocol). No local process is started. |
| A6 | `src/client/ssh/api.ts:135` | **Browser-side wrapper**: `fetch(SSH_API.exec, { method: 'POST', … })` → posts to this plugin's own `/api/dsh-ssh/exec`. Runs nothing locally; the server route is loopback + same-origin gated. |
| A7 | `src/providers/local/provider.ts:305` | The **local workspace-process fallback** for base-only consumers: `child_process.exec(command, { cwd })`. `cwd` is resolved and checked by `assertInsideRoot` **before** the call. |

Who can reach each of these:

- **A3 / A4 / A5** — the `ssh_exec` / `ssh_cluster` agent tools, and `POST /api/dsh-ssh/exec`.
  That route goes through `guard()` (`src/ssh/routes.ts:353`): loopback peer **and** loopback
  `Host` **and** same-origin `Origin` / `Sec-Fetch-Site`. The WebSocket terminal upgrade
  applies the same check before `handleUpgrade` (`src/ssh/routes.ts:1017`).
- **A7** — the *in-process* DSH subprocess seam, i.e. the agent's own shell tool inside a
  local workspace session. There is no HTTP route that reaches it. Its command string is a
  shell command line by contract (that is what the harness's bash tool passes); the only
  constraint this plugin adds is the workspace-root jail on `cwd`.

`execSync` appears nowhere in `src/` or `tests/`.

## B. "Child process module usage (Node.js)"

`node:child_process` is imported in exactly **one** source file — `src/providers/local/provider.ts`
(line 20, used at line 310, A7 above). Every other process spawn in `src/` is a *delegation*:

| Location | Delegates to |
|---|---|
| `src/providers/local/provider.ts:140` | DSH's `LocalSubprocessRuntime` (`this.runtime.spawn(spec)`), after `assertInsideRoot` |
| `src/switch/switch-subprocess.ts:138` | the routing facade: picks the local or the workspace runtime by `cwd` |
| `src/remote/remote-subprocess.ts:182` | an SSH exec channel (remote process, never a local child) |
| `src/remote/search-bridge.ts:225` | the same remote channel, for search helper spawns |

Tests that spawn processes do so to build their own fixtures — a throwaway local `sshd`
(`tests/ssh/helpers/sshd.ts`, `tests/ssh/helpers/ssh-server.ts`) and `git` for
rollback tests (`tests/runtime/workspace-rollback.test.ts`). None of it ships in the package
(`files` excludes `tests/`).

## C. "Reference to .ssh credentials"

There is no credential-file access anywhere in the source. What the scanner matched was text:

| Before | Now |
|---|---|
| `src/client/ssh/locales.ts:57` — zh UI hint `如 ~/.ssh/id_ed25519` | `私钥文件的绝对路径（如 /home/you/keys/your-key）` |
| `src/client/ssh/locales.ts:227` — en UI hint `e.g. ~/.ssh/id_ed25519` | `Absolute path to the private key file (e.g. /home/you/keys/your-key)` |
| test fixtures naming key files (`tests/ssh/store.test.ts`, `tests/ssh/secure-store.test.ts`) | neutral `~/keys/project-key` / `~/keys/dev-key` (assertions updated) |

After those edits `git grep -nE "id_rsa|id_ed25519|id_ecdsa|\.pem" -- packages/dsh-hardssh` returns
nothing. What remains is `~/.ssh/config`, which names a **feature**: the explicit
"Import ~/.ssh/config" action that reads host entries (`Host`/`HostName`/`User`/`Port`/
`IdentityFile`/`ProxyJump`) into the host list when the user clicks it. No private key is
opened, copied, or transmitted by that path or any other.

Credential handling, for the record: nothing is persisted in the default mode
(`secretStorage: none` — passwords/passphrases live in session memory and are dropped when the
pooled connection is recycled); opt-in `vault` mode encrypts with AES-256-GCM + scrypt under a
directory the fs seam refuses to serve; host config is written `0600` in a `0700` directory.

## D. "HTTP request to a raw IP address"

Every IP literal in `src/` is loopback:

| Location | Why |
|---|---|
| `src/host-http.ts:24,33` | the **loopback guard itself** — the allow-list of peer addresses and `Host` names that may reach the plugin's REST routes |
| `src/client/ssh/locales.ts` (tunnel hints) | UI text describing the local end of a port-forward tunnel |
| `src/ssh/connection/manager.ts:909` | ssh2 `forwardOut('127.0.0.1', 0, nextHost, nextPort)` — the standard way to open a ProxyJump hop from the client side |

The flagged test hits (`tests/host-http.test.ts:69/91/95`) are **assertions of that guard**:
they pin that a non-loopback peer, an `Origin` on a different port, and a cross-site fetch are
all refused. Removing or rewriting them would delete the regression test for DNS-rebinding /
CSRF protection.

## E. What is constrained, summarised

- REST + WebSocket: loopback and same-origin only (`guard()`, `isLoopbackRequest`).
- Host config `0600` / `0700`; credentials not persisted by default; vault directory denied to
  the fs seam.
- Host keys: trust-on-first-use; a changed key re-prompts.
- Remote file paths: resolved and confined to the workspace's remote root; symlink escape
  fails closed. Local workspace paths: same, plus the shell spawn jail.
- Optional per-host command policy (deny/allow names and regexes) — documented as a
  **guardrail, not a sandbox**; hard limits belong on the server.
- No telemetry, no third-party endpoint, no persistence installation (no cron/systemd/rc
  files, no `authorized_keys` writes).

## F. Questions from a reviewer

Open an issue on <https://github.com/tiphareth0/dsh-hardssh/issues> — please include the
finding, the file, and what you would need to see to call it resolved.
