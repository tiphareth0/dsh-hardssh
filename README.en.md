# dsh-hardssh

[![version](https://img.shields.io/badge/version-0.2.5-4D6BFE)](CHANGELOG.md)
[![dsh](https://img.shields.io/badge/dsh-0.1.5-7a3ef3)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

**English** · [中文](./README.md)

**SSH workspace + SSH operations plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).** Compatible with DSH **0.1.5** (tested against kernel `0.1.5-rc.1`).

Turn any directory on a server into an **SSH workspace**: once bound, file I/O and
command execution in that session run **transparently on the remote host** — you and
the agent work exactly as if it were local — plus a complete SSH operations panel
(terminal, transfers, tunnels, commands).

## Screenshots

<div align="center">
  <img src="./image/SSH工作区预览.png" alt="SSH workspace preview" width="720px"/>
  <p><em>Turn a server directory into a workspace — file I/O and commands route transparently to the remote host</em></p>
  <img src="./image/SSH工作区管理.png" alt="SSH workspace manager" width="720px"/>
  <p><em>Manage SSH workspaces grouped by server: connection badges, edit/delete servers, add a new server</em></p>
</div>

## Why this plugin

### 1. Remote capability with zero changes to plugins

This is the key difference from other SSH approaches: **the official core is not
modified — only DSH's service seams are replaced.**

`cordis.patch.yml` disables the deployment's built-in `fs-sandbox` / `subprocess`
rows and mounts this plugin's routing facades instead. As a result **any plugin that
works through the standard `ctx.fs` / `ctx.subprocess` interfaces runs on the remote
host inside an SSH-workspace session**, with no SSH code in that plugin and no
awareness of the remote side at all.

> In short: **your existing plugin ecosystem runs on the server out of the box.**

**One exception has to be stated plainly: `glob` / `grep` are NOT part of that.**
They run the client's bundled ripgrep (spawned by `dsh-tool-fs-search` at an absolute
local path), which cannot read the remote workspace, and sending that client path to
the server cannot work either. This plugin therefore **refuses** those calls inside an
SSH session (it never silently answers "no matches") and points at the remote tools
`remote_search` (`mode="glob"` / `mode="grep"`) or `ssh_exec`. Likewise `pwsh` /
`powershell` / `cmd` are client-native binaries and run on this machine. Remote file
I/O and command execution (`read` / `write` / `edit` / `bash`) go through the replaced
seams and **do** take effect on the server.

### 2. One generic base, adaptable to every plugin

Workspace capability is not welded to SSH. Underneath sits a platform-neutral base:

```
WorkspaceRecord / WorkspaceProvider / WorkspaceConnection / capabilities
              +  WorkspaceRegistry / WorkspaceLedger / WorkspaceRouter / switch facades
```

- **SSH is just one provider** (provider id `ssh`); `local` is another. The same base
  can host `docker` / `wsl` / cloud devboxes / remote containers — with **no changes
  to the plugins, tools or UI above it**.
- **A single runtime**: no second assembly, no dual local/remote ledger, no runtime
  mode switch. Seam routing, workspace CRUD, the `remote_*` tools and the host-delete
  guard all read the same ledger.
- **Capability-based degradation**: a provider implements only what it supports
  (`workspace.fs` / `workspace.process` / `workspace.search`); consumers that cannot
  `get()` a capability degrade gracefully.

### 3. A few interface swaps for the rare plugin — with an agent-ready manual

Most plugins need **zero** changes through the seams. The rare plugin that brings its
own file/process abstraction or its own local/remote state only has to swap a few
touch-points for their generic-base equivalents:

| What the plugin has today | Replace with |
|---|---|
| direct `node:fs` / `node:child_process` | `ctx.fs` (DSH FileSystem) / `ctx.subprocess` (SubprocessRuntime) |
| its own path→remote map or "remote mode" flag | `ctx.workspaceCore.findByAnchor()` / `openByAnchor()` |
| its own workspace handle type | `WorkspaceCore` / `WorkspaceConnection` / `WorkspaceRecord` (`@tiphareth/dsh-hardssh/workspace`) |
| its own file/process capability contract | `connection.get('workspace.fs' \| 'workspace.process' \| 'workspace.search')` |
| its own client-side local/remote global switch | `ctx.sessions.list` (`current` + `byId[id].cwd`) + longest-anchor match over the workspace snapshot |

**Point an agent at [packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md) and it
can do the adaptation itself** — that file is an execution manual for agents: detection
commands, the interface mapping table, copy-ready snippets and a self-check list.

### 4. The session *is* the server: the console cannot hit the wrong machine

The right-sidebar SSH console takes its target **from the current session's SSH
workspace**; there is no host dropdown:

- whichever SSH session you switch to is the server its terminal / transfers /
  tunnels / commands talk to;
- for a local-workspace session the console renders a blurred, disabled mask that
  explains why — instead of silently operating on the local machine;
- startup/refresh connects **only the current session's** server; historical
  sessions are never swept;
- a failed connection raises an explicit error dialog (cancelling a
  password/fingerprint prompt yourself is not a failure).

### 5. VSCode Remote-SSH style secure defaults

- Passwords / passphrases are **never persisted** by default (`secretStorage: none`):
  entered once and reused **for the lifetime of that connection** (an idle pool
  recycle asks again);
- opt-in `vault` mode (AES-256-GCM + scrypt) for unattended agents, stored at
  `~/.dsh/ssh-secrets/dsh-ssh-vault.json`. That directory **is inside `~/.dsh`**
  (which the fs seam declares a local root), so the protection is an explicit
  DENY — `deniedRoots` refuses it on `resolve` / `lstat` and on every target-based
  read/write path, and the pre-relocation path is denied too — not its location.
  Plainly: a command running as the same user on this machine (e.g. the
  client-side `pwsh`) can still read the file; what keeps the credential safe is
  that it is encrypted and that auto-unlock from `DSH_CREDENTIAL_PASSWORD` is
  **off by default** (`vaultAutoUnlock: env` opts in), so a stolen file is an
  offline scrypt target rather than a usable credential;
- host-key TOFU: fingerprint confirm on first connect, immediate warning on change;
- strict remote path confinement: the provider owns root confinement, `..` is
  rejected in relative paths, symlink escapes fail closed.

## Features

- **SSH workspaces** — any `user@host` directory can become a workspace; the bound
  session routes remotely. Sidebar rows carry the server badge (connected /
  disconnected, hover shows the remote directory).
- **SSH operations, bound to the session** — web terminal (xterm + WebSocket PTY),
  SFTP upload/download, local port forwarding (reach internal databases/services),
  remote commands on the current server.
- **Host management** — the left-sidebar "SSH workspaces" panel lists every host and
  workspace grouped per server with connected / disconnected badges, plus CRUD and
  `~/.ssh/config` import.
- **Agent tools** — `ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` /
  `ssh_tunnel` / `ssh_cluster`, plus the remote workspace tools `remote_status` /
  `remote_ls` / `remote_search` (remote search, standing in for `glob` / `grep`,
  which cannot work inside an SSH session).
- **Multi-host** — any number of hosts (`host` / `port` / `user` + key, password, or
  `SSH_AUTH_SOCK` agent); passwords are optional at creation. Cross-host fan-out via
  `ssh_cluster`.
- **No core modification** — shipped as a normal plugin (directory flow, left-sidebar
  global entry row, right-sidebar tab); the official workspace core is untouched.

## Install

Published on npm (current version **`0.2.5`**, shipping the required `cordis.patch.yml`
and built artifacts) — one command:

```sh
dsh plugin --profile web add @tiphareth/dsh-hardssh
# or via npx when `dsh` is not on PATH
npx --yes @deepseek-ai/dsh plugin --profile web add @tiphareth/dsh-hardssh
```

For development / local iteration, install from the source checkout or a local tarball:

```sh
# source link (rebuild lib/ after edits and restart dsh web; no re-packing)
dsh plugin --profile web add link:</path/to/dsh-hardssh>/packages/dsh-hardssh

# or pack a tarball first
pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist
dsh plugin --profile web add </path/to/dsh-hardssh>/dist/tiphareth-dsh-hardssh-0.2.5.tgz
```

Alternatively add the package to the profile's `dependencies` (`file:...` → tarball) and
to `dsh.profile.bundles`, then restart `dsh web`.

npm package page: https://www.npmjs.com/package/@tiphareth/dsh-hardssh

> See "Why this plugin 1" for the seam mechanism: it compresses core-version adaptation
> into a thin layer, but **not to zero** — the plugin still depends statically on public DSH
> contracts, so the supported range is declared explicitly below.

## Compatibility

| Plugin | Verified DSH | Node | Remote hosts |
|---|---|---|---|
| `0.2.5`+ | `>=0.1.5-rc.1 <0.1.6` (production verified on `0.1.5-rc.1`; CI runs the same suite on Node 22.19/24) | `^22.19.0 \|\| >=24.0.0` | POSIX with GNU userland (verified on CentOS/RHEL) |

> The earlier `0.1.5-alpha.1` is **not** supported: `dsh-client-ui-slots@0.1.5-alpha.1` declares no `main` slot, so the workspace panel has nowhere to mount (the matrix fails typecheck). See `compat/README.md`.

- **Core contract**: the runtime exports the plugin actually uses (`FileSystem`/`FsError`/`SubprocessRuntime`/`SandboxedFileSystem`/`defineTool`, …) are listed in `src/runtime/compat-contract.ts` and imported individually by a test; `peerDependencies` no longer use an unbounded `"*"`.
- **Optional integrations** (`settings` / `systemPrompt` / `webServer` / client slots) degrade instead of failing: the plugin loads and only the corresponding surface is missing.
- **Visible state**: `GET /api/dsh-ssh/health` reports `ready/degraded/failed` per surface (SSH tools, workspace runtime, file routing, command routing); the workspace panel shows a banner explaining any non-ready surface.
- **A failing seam cannot take down the host**: if the workspace runtime fails to initialize, the replacement rows still mount the local backend (local I/O and commands keep working), the managed anchor window stays fail-closed, and the `ssh_*` capability survives on its own.
- **Remote path canonicalization needs no GNU tools**: `workspace.fs` path resolution now uses the protocol-level SFTP `realpath` (a missing leaf is resolved through its nearest existing ancestor with the suffix re-appended) instead of running `realpath -mz … | base64 -w0`, so a BSD/macOS or BusyBox host no longer breaks every path resolution just for lacking GNU `realpath -m/-z`. Remote search and `mktemp`/`chmod` still assume POSIX + GNU — see the "Remote hosts" column above.

## Quick start

1. **Add a host** — left-sidebar "SSH workspaces" panel → new server:
   alias/host/port/user. The **password may be left empty** (adding never connects;
   it is asked on first use).
2. **Add an SSH workspace** — sidebar "Add workspace" → SSH workspace → pick a server
   → browse the remote directory (the first browse connects automatically: confirm the
   host fingerprint if untrusted, then enter the password once) → name it.
3. **Work** — in that workspace session, reading/writing files and running commands
   executes on the remote host; the left panel shows the remote directory and the
   connection badge.
4. **SSH operations** — switch to that SSH-workspace session and open the
   right-sidebar tab strip "+" → SSH (or the guide entry). Terminal, transfers,
   tunnels and commands all act on **the current session's server**.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `announceToAgent` | boolean | `true` | inject SSH system-prompt guidance & tools into the agent |
| `enabled` | boolean | `true` | **SSH-workspace surface switch, not a plugin master switch.** It gates only what this plugin mounts: the `/api/dsh-hardssh` workspace CRUD routes, the `remote_*` workspace tools and the workspace guidance section. The SSH operations capability (host manager, `ssh_*` tools, `/api/dsh-ssh`, web terminal) is controlled separately by the `enabled` key of the `dsh-ssh` settings namespace; the shared engine/host store, the fs/subprocess routing seams and the connection pool keep running. |
| `secretStorage` | enum | `none` | `none` = no persisted credentials, prompt at connect (VSCode Remote-SSH style); `vault` = encrypted storage (unattended agents). **This plugin config is the only source**: the vault and host store are constructed from it once at plugin load, so changing it requires a plugin reload / `dsh web` restart. |
| `vaultAutoUnlock` | enum | `off` | Whether the vault may auto-unlock from the `DSH_CREDENTIAL_PASSWORD` environment variable at plugin load: `off` (default, master password entered by hand) or `env` (explicit opt-in for unattended setups). That variable is visible to anything running as the same user, hence off by default. Only meaningful with `secretStorage: vault`. |

Example (`cordis.patch.yml`):

```yaml
- id: hardssh
  name: dsh-hardssh
  config:
    secretStorage: none   # or vault
```

## Data locations

- Host config: `~/.dsh/dsh-ssh.json`
- Generic workspace ledger: `~/.dsh/workspaces/index.v1.json`
- Workspace anchors: `~/.dsh/workspaces/anchors`
- Host-key trust: `~/.dsh/ssh-known-hosts.json`
- `vault` mode ciphertext: `~/.dsh/ssh-secrets/dsh-ssh-vault.json` (inside `~/.dsh`,
  but denied to the fs seam on every dispatch path)

These files are written with owner-only permissions (0600 / 0700).

## Development

```sh
pnpm install
pnpm --filter @tiphareth/dsh-hardssh typecheck   # type check
pnpm test                                        # test suite (~12s; vault cases moved out)
pnpm test:vault                                  # vault crypto cases only (~21s, scrypt is slow by design)
pnpm --filter @tiphareth/dsh-hardssh build       # build (lib/ artifacts)
```

Pack & deploy: `pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist`,
then `pnpm add file:...` into the profile and restart `dsh web`.

## FAQ

**Prompted to enter a password / "credential required"** — passwords are never saved
by default: connect and remote browse ask once per session; a process restart asks
again.

**Host key changed / possible MITM** — the server was reinstalled or rotated keys:
opening an SSH-workspace session on that server raises the "key changed" dialog;
press "Reset" and re-trust.

**Added a host but browsing fails** — make sure the host config is correct; the first
browse completes "trust fingerprint + enter password" first.

**Does opening the GUI connect every server?** — No. Startup/refresh connects **only
the current session's** server; historical sessions are never swept.

**A connection fails with no visible feedback** — a "Unable to connect to {alias}"
dialog names the concrete reason (unreachable host, auth failure, host-key problem,
…). Cancelling a password or fingerprint prompt yourself is not a failure.

**The right-sidebar SSH console is greyed out / won't open** — right-sidebar tabs are
per-session: switch to a session first, then open the tab from the strip "+". If the
session uses a **local** workspace the console stays blurred and disabled — it is only
available for SSH-workspace sessions.

**Why can't I pick a server in the console?** — By design: the console follows the
current session's server so a panel action can never hit the wrong host. Switch
sessions to change server.

**Where is my password stored?** — nowhere by default (session memory only, reused
for the lifetime of the pooled connection); with `secretStorage: vault` it is
encrypted in `~/.dsh/ssh-secrets/dsh-ssh-vault.json`. The fs seam refuses that
directory (and the pre-relocation path) wherever it is addressed, but a local command
running as the same user can still read the file — the real protection is the
encryption plus auto-unlock being off unless `vaultAutoUnlock: env` is set.

**How do I make another plugin work with SSH workspaces?** — most plugins need zero
changes (they go through the seams). For the rare one that needs interface swaps, point
an agent at [packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md).

## Safety

With host credentials configured, the agent runs commands on those hosts as your user.
Only add machines you trust. By default nothing is written to disk; host keys use
first-trust TOFU. Enable `vault` mode explicitly (and guard the master password) only
when unattended access to password hosts is required.

## License

BSD-3-Clause

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
