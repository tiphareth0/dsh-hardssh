# Security policy and static-scan rationale

This document states what `@tiphareth/dsh-hardssh` is allowed to do, what it deliberately
does **not** do, and why the capability-surface items a static scanner reports on this
repository are expected rather than exploitable.

## 1. What this plugin is

A DSH (DeepSeek Harness) plugin with two halves:

1. **SSH operations** — host management, Web terminal, upload/download, local port
   forwarding, and the `ssh_exec` / `ssh_cluster` agent tools. Running commands on the remote
   hosts **the user configured** is the point of this half.
2. **Workspace routing** — `cordis.patch.yml` disables the deployment's own `fs-sandbox` /
   `subprocess` rows and this package provides routing facades in their place, so a session
   bound to an SSH workspace has its file I/O and commands executed on that host. A local
   session behaves exactly like the stock rows.

Executing commands is therefore **the feature**, not an incident. Everything below is the
constraint set around it.

## 2. Trust boundaries

| Surface | Constraint | Where |
|---|---|---|
| HTTP REST (`/api/dsh-ssh/*`, `/api/dsh-hardssh/*`) | loopback peer **and** loopback `Host` header **and** same-origin (`Origin` / `Sec-Fetch-Site`) — a DNS-rebound page cannot reach it | `src/host-http.ts`, `src/routes.ts`, `src/ssh/routes.ts` (`guard()`) |
| WebSocket terminal upgrade | the same loopback + same-origin check before `handleUpgrade` | `src/ssh/routes.ts` |
| Host configuration | `~/.dsh/dsh-ssh.json`, written `0600` inside a `0700` directory | `src/ssh/store.ts` |
| Credentials | **not persisted by default** (`secretStorage: none`): session memory only, reused for the lifetime of a pooled connection. Opt-in `vault` mode encrypts with AES-256-GCM + scrypt (`0600`), and that directory is refused by the fs seam even in a bound session | `src/ssh/vault.ts`, `src/fs.ts` (`deniedRoots`) |
| Host identity | trust-on-first-use; a changed host key re-prompts | `src/ssh/…` |
| Remote file operations | every path is resolved and confined to the workspace's remote root; a symlink that escapes fails closed | `src/remote/remote-fs.ts` (`confine`) |
| Local workspace operations | confined to the local workspace root; shell spawns get the same root jail | `src/providers/local/provider.ts` (`assertInsideRoot`) |
| Command policy (optional) | per-host deny/allow for command **names** and regexes, enforced at the tool layer and at the subprocess seam. Documented as a **guardrail, not a sandbox** | `src/ssh/command-policy.ts` |
| Outbound network | only the SSH hosts the user configured — no telemetry, no third-party endpoint anywhere in `src/` | — |

The local OS sandbox does **not** constrain remote execution: a process on the server cannot
be confined by the client's kernel. The plugin states that boundary instead of hiding it.

## 3. What it does not do

- No telemetry, analytics, or update pings. Every `fetch()` in the source targets this
  plugin's own `/api/...` routes; the only outbound sockets are SSH connections to hosts the
  user added.
- No reading of credential files. The plugin never opens SSH private-key files. The only
  `~/.ssh` interaction is the explicit **"Import ~/.ssh/config"** action (reads host entries)
  and the private-key **path** the user types into the add-host form.
- No credential exfiltration path: with the default storage the password/passphrase never
  reaches disk, and no code path sends it anywhere except the SSH handshake.
- No destructive operation outside the resolved workspace root, no privilege escalation, no
  persistence installation (no cron/systemd/rc files, no `authorized_keys` writes).

## 4. Static-scan findings: expected, and why

| Scanner finding | What the code actually is |
|---|---|
| `Shell command execution` — `src/base/capability.ts:53`, `src/ssh/capabilities/service.ts:174` | **Interface declarations** (`WorkspaceProcessRuntime.exec`, `RemoteCapabilityDeps.exec`). No implementation, no shell, no `child_process`. The rule matches the method name. |
| `Shell command execution` — `src/ssh/engine.ts:298-300` | The SSH exec API: run one command on a **user-configured remote host** over the pooled connection, with a server-side budget so a timeout cannot orphan the remote process. Reached by the `ssh_exec` / `ssh_cluster` tools and by the loopback-only `/api/dsh-ssh/exec` route. |
| `Shell command execution` — `src/providers/local/provider.ts:305` | Local workspace-process fallback for base-only consumers: `child_process.exec(command, { cwd })` **after** `assertInsideRoot`. The command string arrives from the in-process DSH subprocess seam (the agent's own shell tool), never from an HTTP request. |
| `Child process module usage` — `src/providers/local/provider.ts:140/142` | Delegation to DSH's `LocalSubprocessRuntime`, cwd root-jailed first. `node:child_process` is imported in exactly one source file (the standalone fallback above). |
| `Reference to .ssh credentials` — `src/client/ssh/locales.ts:57/227` | **UI hint strings** only. They used to name a default private-key file as the example; they now describe the field generically, so no credential path or key filename is embedded. No file access was involved either way. |
| `HTTP request to a raw IP address` — `tests/host-http.test.ts:69/91/95` | Assertions of the **loopback / DNS-rebinding guard itself**: they pin that a non-loopback peer, a foreign `Origin`, and a cross-site fetch are all refused. The literals are loopback addresses inside test fixtures. |

None of these are hardcoded secrets, exfiltration endpoints, destructive operations, or
mining — the categories a submission gate treats as blocking.

## 5. Reporting a vulnerability

Open a GitHub security advisory (preferred) or contact the maintainer privately. Please
include the plugin version, the platform, and a minimal reproduction. There is no bug-bounty
program; fixes ship in the next release and are credited in `CHANGELOG.md` unless you ask
otherwise.

## 6. 中文摘要

本插件的功能本身就是在**用户自行配置的远端主机**上执行命令、读写文件，因此静态扫描器必然会
命中 `exec` 方法名、`child_process` 导入这类能力面条目——它们不是漏洞，也不是密钥或地址泄露：

- 命中的两处 `exec` 只是**接口声明**，没有实现、没有 shell；
- `ssh/engine.ts` 的 `exec` 是 SSH 命令 API，HTTP 入口限本机回环 + 同源，WebSocket 终端升级同
  样先过这道闸；
- 本地回退实现会先把 cwd 收敛到工作区根（`assertInsideRoot`），命令串来自进程内的 DSH
  subprocess seam，不经 HTTP；
- `.ssh` 命中只是界面提示文案（已改写为不带 `.ssh` 路径的通用提示）；
- 测试里的 `127.0.0.1` 是**回环守卫的断言**本身，正是防 DNS rebinding / 跨站请求的回归用例。

凭据默认不落盘（`vault` 模式为 AES-256-GCM + scrypt，且该目录被 fs seam 拒绝访问）；源码中
没有任何第三方外联地址，出站连接只有用户配置的 SSH 主机；命令策略是**护栏而非沙箱**，硬约束
应放在服务器侧。
