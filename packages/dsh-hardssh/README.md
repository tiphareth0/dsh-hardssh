# dsh-hardssh — SSH 远程工作区 + SSH 运维插件

在 DSH Web GUI 中提供两块能力（原 `dsh-ssh` 插件已整体并入本包并删除，单包单引擎）：

1. **SSH 运维**：侧边栏「SSH」入口 → 主机管理面板（增删改查 / `~/.ssh/config` 导入 / 连接测试）、Web 终端（xterm + WebSocket PTY）、文件上传下载、本地端口转发隧道、集群并发执行；`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster` 六个 Agent 工具；主机配置存 `~/.dsh/dsh-ssh.json`。
2. **SSH 工作区**：会话头部按钮进入 SSH 模式，左侧出现远程文件树面板；本地 harness 的 fs/subprocess 经接缝门面透明路由到远程主机执行（read/write/edit/bash 在 SSH 模式下即远程操作）；`remote_*` 九个 Agent 工具用于显式操作。

## 架构

- **单一共享实例**：`HostStore` + `SshEngine`（ssh2 连接池）在 `src/index.ts` 创建一次，SSH 运维与 SSH 工作区共用同一引擎 —— 配置变更（PATCH/DELETE）同时失效所有连接，无双池问题。
- **接缝切换**：`cordis.patch.yml` 禁用部署自带的 `fs-sandbox` / `subprocess` 行，由 `dsh-hardssh/fs`、`dsh-hardssh/subprocess` 提供模式路由门面（本地 = 沙箱化原实现；远程 = SFTP/SSH 实现）。
- **REST**：`/api/dsh-ssh`（运维路由，loopback-only）+ `/api/dsh-hardssh`（工作区路由，loopback-only）。兼容协议名（`/api/dsh-ssh`、`dsh-ssh` settings namespace、`plugin:dsh-ssh` 提示词段）刻意保留，不改名。
- **工作区核心服务**：`ctx.hardsshCore` / `ctx.sshWorkspaceCore` 指向同一 core（ledger + engine + runner），供 `dsh-workbench-tiphareth`（四列 IDE）消费。

## 安装

```sh
# profile 机制，热插拔；需重启 dsh
dsh plugin --profile <name> add link:<repo>/packages/dsh-hardssh
```

## 开发

```sh
# 改码后一键同步 + 验证（build → 同步 profile 插件快照 → 独立实例启动验证）
pwsh scripts/sync-verify.ps1
# 单测 / 类型 / 构建
pnpm --filter dsh-hardssh typecheck
pnpm --filter dsh-hardssh test
pnpm --filter dsh-hardssh build
```

> 注意：profile 的插件依赖是 `file:` 安装副本，pnpm install 会把它重建为指向源码的
> junction（会让 DSH 平台 peer 解析断链）。日常改码后**只跑 sync-verify.ps1**（复制快照 +
> 验证），不要跑 pnpm install；仅当 profile package.json 依赖声明变化时才 install，
> 之后必须重跑 sync-verify 恢复快照。

## 安全模型

- `/api/dsh-ssh/*` 与 `/api/dsh-hardssh/*` 仅限 loopback（含同源校验）。
- 认证材料沿用 `~/.dsh/dsh-ssh.json`（0600 / 0700），不新增存储。
- 路径 gate：远程操作 root 必须等于 resolved remoteRoot；相对路径禁止 `..`。
- 远程操作消耗真实远程资源：工具描述与宣告段明确「先确认再执行」；grep/glob 限深限条数。
- SSH 模式下本机沙箱不对远程执行生效（远程进程无法被本地内核沙箱约束）——门面的 `sandboxMode` 在远程模式报告 `undefined`。

## 已知限制

- SSH 模式下 `pwsh` 工具在 POSIX 远程主机上不可用（请用 bash 语义命令或 `ssh_exec`）。
- 远程 grep/glob/realpath 依赖 GNU find/grep/coreutils（-printf / -mz / base64 -w0）；限深 4~6 层、限 200 条。
- 断线重连沿用引擎语义；传输/执行消耗真实远程资源，先确认再操作。
