# dsh-hardssh — SSH 远程工作区 + SSH 运维插件

已适配 DSH **0.1.5**（实测内核 `0.1.5-rc.1`；本包版本 `0.2.6-alpha`）。客户端 Windows / Linux / macOS 均可用（CI 在 Linux runner 上跑 Node 22.19 与 24 的完整套件；客户端路径、锚点与远端根之间的映射有专门的跨平台回归用例）。在 DSH Web GUI 中提供两块能力（单包单引擎）：

1. **SSH 运维**：右侧栏「SSH」Tab（从右侧栏标签条的「+」或右侧栏引导页入口打开）→ Web 终端（xterm + WebSocket PTY）、文件上传下载、本地端口转发隧道、当前服务器的远端命令；`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster` 六个 Agent 工具；主机配置存 `~/.dsh/dsh-ssh.json`。
2. **SSH 工作区**：左侧侧栏的全局入口行 → 中央面板管理服务器与工作区（增删改查 / `~/.ssh/config` 导入）；绑定后本地 harness 的 fs/subprocess 经接缝门面透明路由到远程主机执行（read/write/edit/bash 在绑定会话中即远程操作）；`remote_*` 三个 Agent 工具（`remote_ls` / `remote_search` / `remote_status`）用于显式操作远端工作区。

## 核心优势

- **对插件零改动**：`cordis.patch.yml` 禁用部署自带的 `fs-sandbox` / `subprocess` 行，由本包提供路由门面。任何走标准 `ctx.fs` / `ctx.subprocess` 的插件与标准工具，在 SSH 工作区会话里自动运行在远端。
- **通用工作区底座**：`WorkspaceRecord` / `Provider` / `Connection` / 能力契约 + Registry / Ledger / Router，与 SSH 解耦。SSH 只是一个 provider（如 `ssh`、`local`），可继续接 docker / wsl / 云 devbox，上层插件与 UI 不改；单一运行时，全链路读同一个台账。
- **少数插件只需改几处接口**：给 agent 的执行手册见 [`SKILLS.md`](./SKILLS.md)——判定命令、接口对照表、可照抄代码与自检清单。

## 架构

- **单一共享实例**：`HostStore` + `SshEngine`（ssh2 连接池）在 `src/index.ts` 创建一次，SSH 运维与 SSH 工作区共用同一引擎 —— 配置变更（PATCH/DELETE）同时失效所有连接，无双池问题。
- **接缝切换**：`cordis.patch.yml` 禁用部署自带的 `fs-sandbox` / `subprocess` 行，由 `dsh-hardssh/fs`、`dsh-hardssh/subprocess` 提供 provider 路由门面（本地 = 沙箱化原实现；远端 = 该 workspace 连接上的 `workspace.fs` / `workspace.process` capability）。
- **REST**：`/api/dsh-ssh`（运维路由，loopback-only）+ `/api/dsh-hardssh`（工作区路由，loopback-only）。
- **工作区核心服务**：`ctx.workspaceCore`（通用 WorkspaceCore：台账 + provider 路由 + capability 连接）是**唯一**的工作区运行时；`ctx.hardsshCore` 只保留 `hosts` + `engine` 供 SSH 专用集成消费（如四列 IDE 形态的 `dsh-workbench-tiphareth`）。
- **公开入口**：`@tiphareth/dsh-hardssh/base`（通用底座实现）、`@tiphareth/dsh-hardssh/workspace`（平台无关类型面）。

## 界面入口（全部走标准插件扩展点）

插件不使用任何 DOM 注入；两个界面都是内核公开的槽位注册：

| 界面 | 入口 | 槽位 |
|---|---|---|
| **SSH 工作区管理**（服务器 + 工作区增删改查，服务器行带已连接/未连接徽章） | 左侧侧栏「新会话」与「工作区」之间的全局入口行 → 中央面板 | `sidebar.panellist`（行）+ `main`（面板，key 同为 `dsh-hardssh-workspaces`） |
| **SSH 运维**（终端 / 传输 / 隧道 / 当前服务器命令） | 右侧栏标签条的「+」或右侧栏引导页入口 | `ctx.sidebarRightTabs.register`（类型）+ `sidebar.right.pane.tab`（正文）+ `sidebar.right.pane.tab.title`（标签文字） |

右侧栏 Tab 是 **page 类型**（不声明 `patterns`），只按 kind 打开，由用户从右侧栏自己的入口打开；插件不会强制展开右侧栏。右侧栏 Tab 实例是**每会话独立**的（内核的会话作用域语义），因此切换会话后需要重新打开该 Tab。

## 会话绑定语义（操作台不选服务器）

- 操作台的 SSH 目标由**当前会话的 `cwd`** 决定：最长匹配的 SSH 工作区锚点胜出，取该工作区的 `alias` 与 `remoteRoot`。终端 / 传输 / 隧道 / 命令四个子页都强制使用它，**不提供服务器下拉框**。
- 会话在本地工作区（或未绑定任何 SSH 工作区）时，操作台不挂载任何操作组件，改为渲染**模糊蒙版**并提示「SSH 操作台仅适用于 SSH 工作区会话」。
- 切换会话时操作台随 `Session → alias` 自动切换，并重置子页状态。
- 数据源是公开的 `ctx.sessions.list`（`current` + `byId[id].cwd`）+ `WorkspaceManager` 快照，两者都可订阅，不存在第二份工作区句柄。

## 连接行为

- **启动/刷新只连接当前会话的服务器**：连接闸门在 `ctx.sessions.list` 的 `phase === 'ready'` 之前不建立基准，避免历史会话被误判为「新建会话」而逐台探测；本地会话不触发任何连接。
- **非交互失败可见**：探测失败（网络不可达、认证失败、主机密钥异常、重试耗尽）会弹出「无法连接服务器」对话框并显示具体原因；用户主动取消密码/指纹弹窗不算失败。
- **认证被拒立刻重弹并给出原因**：凭据已输入后服务器仍拒绝时，重新打开密码对话框并携带具体 SSH 错误，而不是落到非交互失败对话框。
- **连接中可见**：连接期间左侧工作区徽章显示旋转指示器，状态翻转原地替换。
- **工作区文件面板显示远端地址**：面板根锚在本机（会话 cwd），内容已经是远端、地址与面包屑也重写为远端根，避免「地址是本机、内容是服务器」的错觉。
- **状态徽章只读**：左侧面板每 3 秒读取 `/api/dsh-ssh/connections`（连接池 live alias 列表）刷新「已连接 / 未连接」徽章，**不会**主动拨号。

## 主机命令守卫（可选，默认不拦截）

面向「登录节点禁止直接计算」这类主机策略：**默认什么都不拦**，只有给某台主机配了 `commandPolicy` 才生效。配置写在 `~/.dsh/dsh-ssh.json` 的单台主机条目里，也可以在「新建/编辑服务器」对话框里填：

```jsonc
{
  "alias": "login-node",
  "host": "192.0.2.10",
  "user": "alice",
  "commandPolicy": {
    "deny": ["(^|[;&|(])\\s*(?:/?[^ /]+/){0,3}(python[0-9.]*|Rscript|R|make|gcc|g\\+\\+)(\\s|$)"],
    "denyCommands": ["python", "python3", "Rscript", "R", "matlab", "julia", "make", "cmake", "gcc", "g++"],
    "allowCommands": [],
    "hint": "登录节点不可直接计算，请用 srun/sbatch 提交到计算节点。"
  }
}
```

- `deny`：每行一个正则，匹配整条命令文本（命令位置锚定，`srun -p gpu python x.py` 这类提交命令不会误伤）；
- `denyCommands`：命令名清单，匹配前先「解包」——跳过 `FOO=bar`、剥掉 `sudo`/`env`/`time`/`nohup`/`bash -c "…"` 等包装、去路径取 basename，因此 `bash -c 'python x.py'`、`sudo python3 …`、`/usr/bin/python3 …` 都能抓到；
- `allowCommands`：上述名字的例外（豁免优先）；
- `hint`：命中时附在报错里的可操作提示；
- 拦截发生在两层：工具层 `ctx.tools.guard()`（`ssh_exec` / `ssh_cluster` / `bash`）与 seam 层（任何经 `ctx.subprocess` 的远端 spawn，含第三方插件直连）；
- **这是护栏而非沙箱**：`$(…)`、base64、脚本内部再调用计算命令都能绕过；真正的硬约束要在服务器侧（Slurm 限额、`pam_slurm_adopt`、PATH shim）。另外 `bash` 本身不要列进 `denyCommands`——它被当作包装词剥壳，列为禁止名会连 bash 工具自身的 spawn 一起拦掉。

## 原生工具在绑定会话里的行为

| 工具 | 行为 |
|---|---|
| `read` / `write` / `edit` / `bash` / `pwsh`(本机) | 经 `ctx.fs` / `ctx.subprocess` 路由：SSH 会话里就是远端操作 |
| `glob` / `grep` | 走搜索桥：宿主机有 ripgrep 就发同一条 argv，否则由搜索阶梯（rg → POSIX 工具 → SFTP 遍历）代答并投影成 rg 的输出形状；不再「显式拒绝」 |
| `remote_ls` / `remote_search` / `remote_status` | 显式远程运维工具（列目录、正则/字面量检索、绑定状态） |

## 安装

```sh
# 已发布 npm：正式版 0.2.5；本版本 0.2.6-alpha 为预发布，安装时显式指定
dsh plugin --profile web add @tiphareth/dsh-hardssh@0.2.6-alpha
# 或跟随正式版
dsh plugin --profile web add @tiphareth/dsh-hardssh

# 开发/迭代：源码链接（改码重建 lib/ 后重启即生效）
dsh plugin --profile web add link:<repo>/packages/dsh-hardssh
```

## 开发

在仓库根目录执行：

```sh
pnpm --filter dsh-hardssh typecheck   # 类型检查
pnpm test                             # 默认测试套件（vault 加密用例已移出，约 12s）
pnpm test:vault                       # 只跑 vault 用例（约 21s，scrypt 派生故意慢）
pnpm --filter dsh-hardssh build       # 产出 lib/（构建前先清空，避免陈旧产物）
```

> profile 通过 `link:` 指向本包源码目录，因此改码后只需重新 `build`（产出 `lib/`）并重启
> `dsh web` 即生效；不要把依赖改成 `file:` 安装副本，那会让 profile 加载一份快照而不是源码。

## 安全模型

- `/api/dsh-ssh/*` 与 `/api/dsh-hardssh/*` 仅限 loopback（含同源校验）。
- 认证材料沿用 `~/.dsh/dsh-ssh.json`（0600 / 0700），不新增存储。
- 路径 gate：远程操作 root 必须等于 resolved remoteRoot；相对路径禁止 `..`；`workspace.fs` / `workspace.process` capability 在解析后的 canonical 路径上再做一次 root 收敛（symlink 逃逸 fail closed）。
- 远程操作消耗真实远程资源：工具描述与宣告段明确「先确认再执行」；`remote_search` 有深度与条数上限；`glob` / `grep` 在 SSH 会话里由搜索桥代答（同一条 ripgrep argv，或搜索阶梯），不会把本机结果冒充服务器内容——宿主机既无 rg 也无 GNU grep 时，正则检索明确报错而不是把正则当字面量搜。
- 客户端路径不会被当成服务器路径：绑定会话的 cwd 是本机锚点目录，两个 seam 在派发前把它映射到工作区远端根（`src/switch/anchor-path.ts`）；根之外的**词法**越界按 `FS_NOT_FOUND` 作答，使 `dsh-agent-instructions` 从会话 cwd 向上找项目根的探测能继续走，而符号链接逃逸仍按 `FS_IO_ERROR` fail closed。
- SSH 模式下本机沙箱不对远程执行生效（远程进程无法被本地内核沙箱约束）：门面的 `sandboxMode` 委托本地后端的真实模式（`write` / `edit` 的沙箱升级入口据此注册），而远端世界的升级策略在门面处**显式丢弃**。
- 凭据默认不落盘；`secretStorage: vault` 时以 AES-256-GCM + scrypt 加密存储于 `~/.dsh/ssh-secrets/dsh-ssh-vault.json`（被 fs seam 拒绝访问），且 `DSH_CREDENTIAL_PASSWORD` 自动解锁默认关闭（需 `vaultAutoUnlock: env`）。会话密码按**连接存活期**复用，连接池回收即失效。

完整的信任边界、能力清单，以及静态扫描命中项（`exec` 方法名、`child_process`、私钥路径字面量等）的逐条说明见仓库根目录的 [SECURITY.md](https://github.com/tiphareth0/dsh-hardssh/blob/master/SECURITY.md)。
