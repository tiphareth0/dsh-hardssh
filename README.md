# dsh-hardssh

[![version](https://img.shields.io/badge/version-0.2.5-4D6BFE)](CHANGELOG.md)
[![dsh](https://img.shields.io/badge/dsh-0.1.5-7a3ef3)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-BSD--3--Clause-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-7a3ef3)](https://github.com/topics/dsh-plugin)

**中文** · [English](./README.en.md)

**【DeepSeek Harness (DSH) 的 SSH 工作区 + SSH 运维插件】** · 已适配 DSH **0.1.5**（实测内核 `0.1.5-rc.1`）

把服务器上的任意目录变成 **SSH 工作区**：绑定后，该会话里的文件读写与命令执行**透明地运行在远端主机**，
你和 agent 都像在操作本机一样工作——同时提供完整的 SSH 运维面板（终端、传输、隧道、命令）。

## 界面预览

<div align="center">
  <img src="./image/SSH工作区预览.png" alt="SSH 工作区预览" width="720px"/>
  <p><em>把服务器上的目录变成工作区：会话内的文件读写、命令执行透明路由到远端主机</em></p>
  <img src="./image/SSH工作区管理.png" alt="SSH 工作区管理" width="720px"/>
  <p><em>按服务器分组管理 SSH 工作区：连接状态徽章、编辑/删除服务器、新建服务器</em></p>
</div>

## 核心优势

### 1. 对插件是「零改动」的远端能力

这是本插件与其他 SSH 方案最本质的区别：**不修改官方内核，只替换 DSH 的服务 seam。**

`cordis.patch.yml` 把部署自带的 `fs-sandbox` / `subprocess` 两行禁用，改由本插件提供路由门面。
因此**任何通过标准 `ctx.fs` / `ctx.subprocess` 接口工作的插件**，在 SSH 工作区会话里都自动运行在远端主机上——
不需要该插件写一行 SSH 代码，也不需要它知道远端的存在。

> 换句话说：**你已有的插件生态，开箱即可在服务器上跑。**

**一个必须说清的例外：`glob` / `grep` 不在其中。** 它们走的是本机打包的 ripgrep（由
`dsh-tool-fs-search` 直接用绝对路径 spawn），本机工具无法读取服务器上的工作区；把本机路径发到服务器上也不可能成立。
所以本插件在 SSH 会话里**明确拒绝**这两种调用（不会静默返回「无匹配」），并提示改用远端检索工具
`remote_search`（`mode="glob"` / `mode="grep"`）或 `ssh_exec`。同理，`pwsh` / `powershell` / `cmd`
是客户端原生二进制，在本机执行。远端文件读写与命令执行（`read` / `write` / `edit` / `bash`）走的是已替换的 seam，**在远端生效**。

### 2. 通用工作区底座：一套底座，适配所有插件

工作区能力没有焊死在 SSH 上。底层是平台无关的通用底座：

```
WorkspaceRecord / WorkspaceProvider / WorkspaceConnection / 能力(capability)
              +  WorkspaceRegistry / WorkspaceLedger / WorkspaceRouter / Switch 门面
```

- **SSH 只是其中一个 provider**（provider id = `ssh`），`local` 是另一个；同一套底座可以继续接
  `docker` / `wsl` / 云 devbox / 远端容器——**上层插件、工具、UI 全都不用改**。
- **唯一运行时**：seam 路由、工作区 CRUD、`remote_*` 工具、主机删除守卫全部读同一个台账，行为一致、无分歧。
- **能力按需降级**：provider 只实现自己支持的能力
  （`workspace.fs` / `workspace.process` / `workspace.search`），消费方 `get()` 拿不到就优雅降级。

### 3. 少数插件只需改几处接口——有给 agent 的适配手册

绝大多数插件走 seam 就是零改动。**少数自带文件/进程抽象、或自建「本地/远端」状态的插件**，
只需要把对应接口换成通用底座里的等价物，典型就是这几处：

| 插件里现在的东西 | 换成 |
|---|---|
| 直接 `node:fs` / `node:child_process` | `ctx.fs`（DSH FileSystem）/ `ctx.subprocess`（SubprocessRuntime） |
| 自建的 path→远端映射、「remote 模式」布尔量 | `ctx.workspaceCore.findByAnchor()` / `openByAnchor()` |
| 自建的 workspace 句柄类型 | `WorkspaceCore` / `WorkspaceConnection` / `WorkspaceRecord`（`@tiphareth/dsh-hardssh/workspace`） |
| 自建的文件/进程能力契约 | `connection.get('workspace.fs' \| 'workspace.process' \| 'workspace.search')` |
| 客户端自建的 local/remote 全局开关 | `ctx.sessions.list`（`current` + `byId[id].cwd`）+ 工作区快照的最长锚点匹配 |

**让 agent 直接读 [packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md) 即可完成适配**：
那是一份写给 agent 的执行手册，包含判定命令、接口对照表、可照抄的代码片段与自检清单。

### 4. 会话即服务器：操作台不会指错机器

右侧栏 SSH 操作台的目标**强制取自当前会话所在的 SSH 工作区**，没有服务器下拉框：

- 切到哪个 SSH 会话，终端 / 传输 / 隧道 / 命令就打向哪台服务器；
- 本地工作区会话下，操作台以模糊蒙版禁用并说明原因，而不是让你误操作到本机；
- 启动/刷新**只连接当前会话的服务器**，历史会话不会被扫一遍；
- 连接失败会弹出明确的错误对话框（用户主动取消密码/指纹输入不算失败）。

### 5. 安全默认值（VSCode Remote-SSH 式）

- 密码 / 密钥口令默认**不落盘**（`secretStorage: none`），首次连接输入一次、**在该连接存活期内复用**（连接池空闲回收后需重新输入）；
- 需要无人值守时可显式启用 `vault`（AES-256-GCM + scrypt）加密存储；
- 主机密钥 TOFU：首次连接弹指纹确认，密钥变更立即告警；
- 远端路径强收敛：provider 负责 root 约束，相对路径禁止 `..`，符号链接逃逸 fail closed。

## 特性

- **SSH 工作区**：任意 `user@host` 的目录即可成为工作区。绑定的会话透明远端路由；侧边栏工作区带服务器标识（已连接 / 未连接，悬停显示远端目录）。
- **SSH 运维（跟随会话）**：Web 终端（xterm + WebSocket PTY）、SFTP 上传下载、本地端口转发（访问内网数据库/服务）、当前服务器的远端命令。
- **主机管理**：左侧「SSH 工作区」面板按服务器分组列出全部主机与工作区，带已连接 / 未连接徽章，支持增删改查与 `~/.ssh/config` 导入。
- **Agent 工具**：`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster`，以及远端工作区工具 `remote_status` / `remote_ls` / `remote_search`（远端检索，替代在 SSH 会话里不可用的 `glob` / `grep`）。
- **多主机**：任意数量主机（`host` / `port` / `user` + 私钥、密码或 `SSH_AUTH_SOCK` agent），密码免提交、连接时输入；跨主机并发命令用 `ssh_cluster`。
- **不修改官方内核**：只作为普通插件挂载（目录流、左侧全局入口行、右侧栏 Tab），`dsh-workspace` 内核原样工作。

## 安装

已发布到 npm（当前版本 **`0.2.5`**，含插件所需的 `cordis.patch.yml` 与构建产物），一行安装：

```sh
dsh plugin --profile web add @tiphareth/dsh-hardssh
# 或 npx 形式（dsh 不在 PATH 时）
npx --yes @deepseek-ai/dsh plugin --profile web add @tiphareth/dsh-hardssh
```

开发/迭代用本机源码或本地 tarball：

```sh
# 源码链接（改码后重建 lib/ 并重启 dsh web 即生效，无需重新打包）
dsh plugin --profile web add link:</path/to/dsh-hardssh>/packages/dsh-hardssh

# 或先打包，再安装 tarball
pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist
dsh plugin --profile web add </path/to/dsh-hardssh>/dist/tiphareth-dsh-hardssh-0.2.5.tgz
```

手工方式：把包加入 profile 的 `dependencies`（`file:...` 指向 tarball）与
`dsh.profile.bundles` 列表，重启 `dsh web` 生效。

NPM 包页面：https://www.npmjs.com/package/@tiphareth/dsh-hardssh

> seam 替换机制见上文「核心优势 1」：它把「内核版本适配」压缩成很薄的一层，但**并不是零**——
> 插件仍静态依赖 DSH 的公共契约，因此声明了明确的支持区间，见下表。

## 兼容性

| 插件版本 | 已验证 DSH | Node | 远端主机 |
|---|---|---|---|
| `0.2.5`+ | `>=0.1.5-rc.1 <0.1.6`（生产环境实测 `0.1.5-rc.1`；CI 在 Node 22.19/24 上跑同一套件） | `^22.19.0 \|\| >=24.0.0` | POSIX + GNU 用户态（CentOS/RHEL 等实测） |

> 更早的 `0.1.5-alpha.1` **不支持**：`dsh-client-ui-slots@0.1.5-alpha.1` 没有 `main` 槽位，工作区面板无处挂载（矩阵实测 typecheck 直接失败）。见 `compat/README.md`。

- **内核侧契约**：插件实际使用的运行时导出（`FileSystem`/`FsError`/`SubprocessRuntime`/`SandboxedFileSystem`/`defineTool` 等）都由 `src/runtime/compat-contract.ts` 列明，并在测试里逐个 import 校验；`peerDependencies` 不再使用无边界 `"*"`。
- **可选集成**：`settings` / `systemPrompt` / `webServer` / 客户端 slot 缺失时**降级而不是失败**——插件照常加载，只是少了对应界面。
- **可见状态**：`GET /api/dsh-ssh/health` 返回各功能面（SSH 工具、工作区运行时、文件路由、命令路由）的 `ready/degraded/failed`；非 ready 时工作区面板顶部会显示横幅说明原因。
- **seam 失败不会拖垮宿主**：工作区运行时初始化失败时，替换行仍挂载本地后端（本机读写与命令继续可用），管理锚点窗口继续 fail closed；`ssh_*` 运维能力独立存活。

## 快速开始

1. **添加主机**：左侧「SSH 工作区」面板 → 新建服务器，填别名/主机/端口/用户名——**密码可留空**（新增不会连接，首次使用时再输入）。
2. **添加 SSH 工作区**：侧边栏「添加工作区」→ SSH 工作区 → 选服务器 → 浏览远端目录（首次会自动弹出连接：未信任则先确认主机指纹，随后输入一次密码）→ 命名创建。
3. **开始操作**：在这个工作区的会话里读写文件、运行命令即是远端执行；左侧面板出现远端目录标识与连接徽章。
4. **SSH 运维**：切到该 SSH 工作区的会话，右侧栏标签条「+」→ SSH（或右侧栏引导页入口）打开操作台——终端 / 传输 / 隧道 / 命令都自动作用于**当前会话所在的服务器**。

## 配置

| Key | Type | Default | 含义 |
| --- | --- | --- | --- |
| `announceToAgent` | boolean | `true` | 是否向 agent 注入 SSH 系统提示与工具引导 |
| `enabled` | boolean | `true` | **SSH 工作区界面开关**（不是插件总开关）。只控制本插件挂载的 SSH 工作区界面与工具：`/api/dsh-hardssh` 工作区 CRUD 路由、`remote_*` 工作区工具、工作区提示段落。SSH 运维能力（主机管理、`ssh_*` 工具、`/api/dsh-ssh`、Web 终端）由 `dsh-ssh` 设置命名空间的 `enabled` 单独控制；共享 engine/主机存储、fs/subprocess 路由 seam 与连接池不受它影响。 |
| `secretStorage` | enum | `none` | 凭据策略：`none` = 密码不落盘、连接时输入（VSCode Remote-SSH 式）；`vault` = 加密存储（供无人值守 agent）。**唯一来源是这里的插件配置**：Vault 与主机存储在插件加载时按它构造一次，因此改动后需重载插件/重启 `dsh web` 才生效。 |
| `vaultAutoUnlock` | enum | `off` | 是否允许 Vault 在插件加载时用 `DSH_CREDENTIAL_PASSWORD` 环境变量**自动解锁**：`off`（默认，需手动输入主密码）或 `env`（无人值守场景显式开启）。该变量对同用户的任何进程可见，因此默认关闭。仅 `secretStorage: vault` 时相关。 |

示例（`cordis.patch.yml`）：

```yaml
- id: hardssh
  name: dsh-hardssh
  config:
    secretStorage: none   # 或 vault
```

## 数据位置

- 主机配置：`~/.dsh/dsh-ssh.json`
- 通用工作区台账：`~/.dsh/workspaces/index.v1.json`
- 工作区锚点目录：`~/.dsh/workspaces/anchors`
- 主机密钥信任：`~/.dsh/ssh-known-hosts.json`
- `vault` 模式的加密凭据：`~/.dsh/ssh-secrets/dsh-ssh-vault.json`（位于 `~/.dsh` 内，但被 fs seam 在所有派发路径上拒绝访问）

以上文件按系统权限（0600 / 0700）落盘。

## 开发

```sh
pnpm install
pnpm --filter @tiphareth/dsh-hardssh typecheck   # 类型检查
pnpm test                                        # 测试（默认套件 ~12s；vault 用例已移出）
pnpm test:vault                                  # 只跑 vault 加密用例（~21s，scrypt 故意慢）
pnpm --filter @tiphareth/dsh-hardssh build       # 构建（lib/ 产物）
```

打包部署：`pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist`，
将 tarball 装入 profile（`pnpm add file:...`）后重启 `dsh web`。

## FAQ

**连接时要求输入密码 / 提示“需要密码”** —— 安全默认不保存密码：首次连接、浏览远端目录时会弹窗输入一次，在该连接存活期内复用；连接池空闲回收（默认 30 分钟）或进程重启后需重新输入。

**主机密钥变化 / 提示可能中间人** —— 服务器重装或轮换密钥：打开该服务器的 SSH 工作区会话时弹出「密钥已变更」对话框，按提示「重置」后重新信任。

**加了服务器但浏览目录失败** —— 确认该主机配置正确；首次浏览会先完成「信任指纹 + 输入密码」，之后即可浏览。

**打开页面时会不会把所有服务器都连一遍** —— 不会。启动/刷新只连接**当前会话**所属的服务器；历史会话不会被扫描。

**连接不上但没有任何提示** —— 会弹出「无法连接服务器」对话框并给出具体原因（网络不可达、认证失败、主机密钥异常等）。若你主动取消了密码框或指纹确认，则不算连接失败。

**右侧「SSH」操作台是灰的 / 打不开** —— 右侧栏 Tab 是每会话独立的：先切换到某个会话，再从右侧栏标签条「+」打开。当前会话是**本地工作区**时操作台保持模糊禁用——它只在 SSH 工作区会话下可用。

**操作台里为什么不能选服务器** —— 设计如此：操作台强制跟随当前会话所在的服务器，避免在同一面板里误操作到别的主机。要换服务器请切换会话。

**密码存哪里** —— 默认不落盘；启用 `secretStorage: vault` 后加密存储于 `~/.dsh/ssh-secrets/dsh-ssh-vault.json`。该目录**就在 `~/.dsh` 里**（`~/.dsh` 是 fs seam 声明的本地根），因此靠的是**显式拒绝**而非位置：`deniedRoots` 在 `resolve` / `lstat` 以及所有按 target 派发的读写路径上都会拒绝访问它，旧路径 `~/.dsh/dsh-ssh-vault.json` 同样被拒绝。诚实地说：以同一用户身份在本机运行的命令（例如客户端 `pwsh`）仍能读到这个文件——真正的保护是**它是加密的**，且环境变量自动解锁默认关闭，需要 `vaultAutoUnlock: env` 显式开启，所以拿到的只是离线的 scrypt 目标而不是可用凭据。

**怎么让别的插件支持 SSH 工作区** —— 大多数插件零改动（走 seam）。少数需要改接口的，让 agent 读 [packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md) 按手册适配。

## 安全说明

插件持有主机凭据后，agent 可以以你的身份在远端执行命令。请只添加你信任的机器。
默认策略下密码不写入磁盘（仅在会话内存中存在）；主机密钥采用 TOFU 首次信任。
如需无人值守自动化访问密码主机，再显式启用 `vault` 模式并妥善保管主密码。

## License

BSD-3-Clause

## Changelog

见 [CHANGELOG.md](./CHANGELOG.md)。
