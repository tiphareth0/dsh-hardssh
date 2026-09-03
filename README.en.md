**English** · [中文](./README.md)

---

# dsh-hardssh

[![version](https://img.shields.io/badge/version-0.1.2-4D6BFE)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

**SSH workspace + SSH operations plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

## How it works (seam replacement)

The plugin **does not modify the official core**. Following DSH's cordis plugin
model, it replaces the official `dsh-fs` / `dsh-subprocess` service seams via
`cordis.patch.yml` with `dsh-hardssh`'s local/remote switching implementation.
Once a session is bound to an SSH workspace, its `fs` / `subprocess` calls are
**transparently routed to the remote host** (SFTP reads/writes + remote shell)
while local sessions stay untouched. As a result, **any plugin that works
through the standard fs/subprocess interfaces runs on the remote server inside
an SSH workspace with no extra adaptation** — a natural property of cordis
dependency injection and seam replacement. For the same reason the plugin does
not depend on the internal API of any specific core version: it **supports all
dsh core versions** (the latest core is `0.1.2-alpha.3`).

Manage several SSH hosts inside the DSH Web GUI, turn any directory on a host
into an **SSH workspace**: once bound, file I/O and command execution in that
session are transparently routed to the remote host (SFTP reads/writes, remote
bash), while untouched local sessions keep working. A full SSH operations
panel (terminal, transfers, tunnels, cluster, host management) is included.

- **SSH workspaces** — any `user@host` directory can become a workspace. The
  session's `fs` / `subprocess` go through the seam to the remote side
  (SFTP + remote shell) automatically; local sessions are unaffected.
- **SSH operations** — sidebar "SSH" panel: web terminal (xterm + WebSocket
  PTY), file upload/download (SFTP), local port forwarding (reach internal
  databases/services), cluster execution, host CRUD + `~/.ssh/config` import,
  connection test.
- **Agent tools** — `ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` /
  `ssh_tunnel` / `ssh_cluster`, plus the `remote_*` workspace tools.
- **VSCode Remote-SSH style security defaults** — passwords/passphrases are
  **never persisted** (`secretStorage: none`); on first connect or remote
  directory browse a dialog asks once and the credential is reused for the
  session. An optional encrypted `vault` mode supports unattended agents.
  Host-key TOFU (first-connect fingerprint confirm, change = warning)
  protects against MITM.
- **Generic base** — workspace plumbing (WorkspaceLedger / Provider /
  Registry / Router / WFS) is decoupled from SSH, so other plugins can reuse
  the same local/remote workspace model.

## Features

- **Multi-host** — any number of hosts (`host` / `port` / `user` + key,
  password, or `SSH_AUTH_SOCK` agent). Passwords are optional at creation and
  entered on first use.
- **SSH workspaces** — Add workspace → pick host → browse the remote
  directory → name it; the bound session routes remote transparently.
  Sidebar rows carry a server badge (blue = connected, gray = offline;
  hover shows the remote directory).
- **Web terminal** — xterm + WebSocket PTY, sharing the connection pool
  (idle 30 min auto-disconnect).
- **Transfers / tunnels / cluster** — SFTP upload/download, local port
  forwarding (`127.0.0.1`), concurrent multi-host commands.
- **Host management** — create/edit/delete (delete guarded while workspaces
  reference the host), `~/.ssh/config` import, one-click connection test.
- **Security**
  - `secretStorage`: `none` (default, VSCode-style; session-memory only) or
    `vault` (AES-256-GCM + scrypt encrypted storage for unattended agents).
  - Host-key TOFU (`~/.dsh/ssh-known-hosts.json`): first connect shows a
    fingerprint confirm; a changed key asks to reset/re-trust.
  - Session password table: connect/test/browse prompt once, reuse for the
    session, cleared on process exit.
- **Data locations** — host config `~/.dsh/dsh-ssh.json`; workspace ledger &
  anchors under `~/.dsh/ssh-workspaces`; private files written 0600.
- **No core modification** — shipped as a normal plugin (directory flow,
  session-header button, sidebar entry); the official workspace core is not
  patched.

## Install

Published on npm (`0.1.2`, ships the required `cordis.patch.yml` and built
artifacts) — one command:

```sh
dsh plugin --profile web add @tiphareth/dsh-hardssh
# or via npx when `dsh` is not on PATH
npx --yes @deepseek-ai/dsh plugin --profile web add @tiphareth/dsh-hardssh
```

For development / local iteration, install from a local tarball or the source
checkout:

```sh
dsh plugin --profile web add C:/Users/Kether/.dsh/dsh-hardssh/dist/tiphareth-dsh-hardssh-0.1.2.tgz
# or link the source (rebuild lib/ after code changes and restart; no re-packing)
dsh plugin --profile web add link:C:/Users/Kether/.dsh/dsh-hardssh/packages/dsh-hardssh
```

npm package page: https://www.npmjs.com/package/@tiphareth/dsh-hardssh

Alternatively add the package to the profile's `dependencies` (`file:...` →
tarball) and to `dsh.profile.bundles`, then restart `dsh web`.

> Compatible with all dsh core versions (latest core: `0.1.2-alpha.3`; see
> "How it works (seam replacement)" above — no per-core-version adaptation).

## Quick start

1. **Add a host** — SSH panel → new server: alias/host/port/user. The
   **password may be left empty** (adding never connects; it is asked on
   first use).
2. **Add an SSH workspace** — sidebar "Add workspace" → SSH workspace → pick
   a server → browse the remote directory (first browse connects
   automatically: confirm the host fingerprint if untrusted, then enter the
   password once) → name it.
3. **Work** — in the workspace session, reading/writing files and running
   commands executes on the remote host; the sidebar row shows the remote
   directory badge. The SSH panel also offers terminal, transfers, tunnels
   and cluster runs.

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `announceToAgent` | boolean | — | inject SSH system-prompt guidance & tools into the agent |
| `enabled` | boolean | — | plugin master switch |
| `secretStorage` | enum | `none` | `none` = no persisted credentials, prompt at connect (VSCode Remote-SSH style); `vault` = encrypted storage (unattended agents) |

Example (`cordis.patch.yml`):

```yaml
- id: hardssh
  name: dsh-hardssh
  config:
    secretStorage: none   # or vault
```

## Development

```sh
pnpm install
pnpm --filter @tiphareth/dsh-hardssh typecheck
pnpm --filter @tiphareth/dsh-hardssh exec vitest run
pnpm --filter @tiphareth/dsh-hardssh build
```

Pack & deploy: `pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist`,
then `pnpm add file:...` into the profile and restart `dsh web`.

## FAQ

**Prompted to enter a password / "credential required"** — passwords are never
saved by default: connect, test and remote browse ask once per session; a
process restart asks again.

**Host key changed / possible MITM** — the server was reinstalled or rotated
keys: SSH panel → host → test triggers the fingerprint dialog → "Reset",
then re-trust.

**Added a host but browsing fails** — make sure the host config is correct;
the first browse completes "trust fingerprint + enter password" first.

**Clicking a workspace does nothing** — the click connects automatically
(fingerprint/password dialogs if needed); on failure check the row banner or
"Test" in the SSH panel.

**Where is my password stored?** — nowhere by default (session memory only);
with `secretStorage: vault` it is encrypted in `~/.dsh/dsh-ssh-vault.json`.

## Safety

With host credentials configured, the agent runs commands on those hosts as
your user. Only add machines you trust. By default nothing is written to
disk; host keys use first-trust TOFU. Enable `vault` mode explicitly (and
guard the master password) only when unattended access to password hosts is
required.

## License

BSD-3-Clause

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).