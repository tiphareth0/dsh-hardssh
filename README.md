# dsh-hardssh

[![version](https://img.shields.io/badge/version-0.2.6--alpha-4D6BFE)](CHANGELOG.md)
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

**`glob` / `grep` 也包含在内——通过「工作区搜索桥」。** 官方 `dsh-tool-fs-search` 会用本机绝对路径 spawn 打包的
ripgrep，本机工具读不到服务器上的工作区。现在这条 spawn 不再被拒绝（0.2.5 之前的行为），而是由 subprocess seam 交给
绑定的主机来回答：宿主机有 ripgrep 就**在服务器上执行同一条 argv**；没有则由搜索阶梯代答，并把结果投影回 ripgrep 自己的
输出形状（`--files` 列表 / `rg --json` 匹配记录），原生工具层原样格式化。路径是工作区根下的 POSIX 路径，`path` 参数超出
工作区根会被拒绝。需要正则语法与显式预算、或宿主机没有可用正则引擎时，仍用 `remote_search`。同理，`pwsh` / `powershell` / `cmd`
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
- 点「连接」后工作区徽章显示**连接中**指示；密码错误 / 认证拒绝 / 断联会**立即重开密码框并显示具体 SSH 原因**（不是笼统的失败提示）；
- 主机密钥 TOFU：首次连接弹指纹确认，密钥变更立即告警；
- 远端路径强收敛：provider 负责 root 约束，相对路径禁止 `..`，符号链接逃逸 fail closed；
- **可选的每主机命令守卫**：给某台主机配一组「禁止命令」，agent 尝试执行时会被拦下并给出你写的提示（例如「登录节点禁止计算，请用 srun/sbatch 提交」）。默认**不拦截**任何主机，详见下文「[主机命令守卫](#主机命令守卫可选)」。

## 特性

- **SSH 工作区**：任意 `user@host` 的目录即可成为工作区。绑定的会话透明远端路由；侧边栏工作区带服务器标识（已连接 / 未连接，悬停显示远端目录）。
- **SSH 运维（跟随会话）**：Web 终端（xterm + WebSocket PTY）、SFTP 上传下载、本地端口转发（访问内网数据库/服务）、当前服务器的远端命令。
- **主机管理**：左侧「SSH 工作区」面板按服务器分组列出全部主机与工作区，带已连接 / 未连接徽章，支持增删改查与 `~/.ssh/config` 导入。
- **命令守卫（按主机可选）**：每台主机可配置「禁止命令」（正则 + 命令名，自动解包 `bash -c` / `sudo` / 绝对路径），agent 在 `ssh_exec` / `ssh_cluster` / `bash` 里尝试执行时被拦下并显示你写的提示；也可在编辑服务器的对话框里直接填。默认不拦截。
- **远端地址显示**：SSH 工作区的「工作区文件」面板、侧边栏工作区行的悬停提示都显示**远端真实路径**（本地锚点目录只是路由占位，不暴露给用户）。
- **Agent 工具**：`ssh_list` / `ssh_exec` / `ssh_upload` / `ssh_download` / `ssh_tunnel` / `ssh_cluster`，以及远端工作区工具 `remote_status` / `remote_ls` / `remote_search`（远端检索：正则语法、显式预算，以及宿主机没有可用正则引擎时的明确报错；`glob` / `grep` 已能直接查远端，见上文）。
- **多主机**：任意数量主机（`host` / `port` / `user` + 私钥、密码或 `SSH_AUTH_SOCK` agent），密码免提交、连接时输入；跨主机并发命令用 `ssh_cluster`。
- **不修改官方内核**：只作为普通插件挂载（目录流、左侧全局入口行、右侧栏 Tab），`dsh-workspace` 内核原样工作。

## 安装

已发布到 npm。正式版是 **`0.2.5`**（可直接 `add @tiphareth/dsh-hardssh`）；本仓库当前版本 **`0.2.6-alpha`** 是预发布版，安装时显式指定版本：

```sh
# 预发布版（本仓库当前版本）
dsh plugin --profile web add @tiphareth/dsh-hardssh@0.2.6-alpha
# 或仍装正式版
dsh plugin --profile web add @tiphareth/dsh-hardssh
# npx 形式（dsh 不在 PATH 时）
npx --yes @deepseek-ai/dsh plugin --profile web add @tiphareth/dsh-hardssh@0.2.6-alpha
```

开发/迭代用本机源码或本地 tarball：

```sh
# 源码链接（改码后重建 lib/ 并重启 dsh web 即生效，无需重新打包）
dsh plugin --profile web add link:</path/to/dsh-hardssh>/packages/dsh-hardssh

# 或先打包，再安装 tarball
pnpm --filter @tiphareth/dsh-hardssh pack --pack-destination dist
dsh plugin --profile web add </path/to/dsh-hardssh>/dist/tiphareth-dsh-hardssh-0.2.6-alpha.tgz
```

手工方式：把包加入 profile 的 `dependencies`（`file:...` 指向 tarball）与
`dsh.profile.bundles` 列表，重启 `dsh web` 生效。

NPM 包页面：https://www.npmjs.com/package/@tiphareth/dsh-hardssh

> seam 替换机制见上文「核心优势 1」：它把「内核版本适配」压缩成很薄的一层，但**并不是零**——
> 插件仍静态依赖 DSH 的公共契约，因此声明了明确的支持区间，见下表。

## 兼容性

| 插件版本 | 已验证 DSH | Node | 远端主机 |
|---|---|---|---|
| `0.2.5`+（当前 `0.2.6-alpha`） | `>=0.1.5-rc.1 <0.1.6`（生产环境实测 `0.1.5-rc.1`；CI 在 Node 22.19/24 上跑同一套件） | `^22.19.0 \|\| >=24.0.0` | POSIX（GNU 工具链实测：CentOS/RHEL；BSD/BusyBox 缺 GNU 参数时自动退回 SFTP，功能受限但可用） |

> 更早的 `0.1.5-alpha.1` **不支持**：`dsh-client-ui-slots@0.1.5-alpha.1` 没有 `main` 槽位，工作区面板无处挂载（矩阵实测 typecheck 直接失败）。见 `compat/README.md`。

- **内核侧契约**：插件实际使用的运行时导出（`FileSystem`/`FsError`/`SubprocessRuntime`/`SandboxedFileSystem`/`defineTool` 等）都由 `src/runtime/compat-contract.ts` 列明，并在测试里逐个 import 校验；`peerDependencies` 不再使用无边界 `"*"`。
- **可选集成**：`settings` / `systemPrompt` / `webServer` / 客户端 slot 缺失时**降级而不是失败**——插件照常加载，只是少了对应界面。
- **可见状态**：`GET /api/dsh-ssh/health` 返回各功能面（SSH 工具、工作区运行时、文件路由、命令路由）的 `ready/degraded/failed`；非 ready 时工作区面板顶部会显示横幅说明原因。
- **seam 失败不会拖垮宿主**：工作区运行时初始化失败时，替换行仍挂载本地后端（本机读写与命令继续可用），管理锚点窗口继续 fail closed；`ssh_*` 运维能力独立存活。
- **远端路径规范化不依赖 GNU 工具**：`workspace.fs` 的路径解析改走协议级 SFTP `realpath`（缺失叶子按「最近已存在祖先 + 后缀」逐级解析），不再执行 `realpath -mz … | base64 -w0`，BSD/macOS、BusyBox 主机不会仅因缺少 GNU `realpath -m/-z` 就整条路径解析失败。
- **远端搜索按实测能力分三级**：连接建立后探测一次该主机能用什么（`rg`、`find -printf`/`-mmin`、`grep -Z`/`--exclude-dir`、`mktemp`，**不猜 `uname`**），内容检索走 `rg` → POSIX `grep` → **SFTP 遍历**兜底，文件名/glob 走 POSIX `find` → SFTP 兜底；SFTP 兜底不执行任何远端命令，带深度/条数/字节预算并跳过 `.git`、`node_modules` 与符号链接目录。`remote_search` 支持 `syntax="fixed"`（默认）或 `"regex"`，正则需要主机有 `rg` 或 GNU `grep`，否则明确报错。

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

## 主机命令守卫（可选）

**用途**：某些服务器不允许直接跑重活（典型是 Slurm 集群的**登录节点**：只能提交作业，不能就地计算）。给这台主机配一组「禁止命令」后，agent/工具尝试执行会被**拦下并显示你写的提示**，把它引导到正确的提交方式。

**默认不拦截**：没配 `commandPolicy` 的主机行为完全不变。

### 在哪里配

两种等价方式（都写入 `~/.dsh/dsh-ssh.json` 的该主机条目）：

1. **GUI**：左侧「SSH 工作区」→ 该主机行的 ⚙（编辑服务器）→ 三个输入框：
   - 「禁止命令（每行一个正则）」
   - 「禁止命令名称（每行一个，自动解包）」
   - 「豁免命令名称（可选）」+「提示信息（可选）」
   保存即生效（**表单即真值**：清空即移除该主机的拦截）。
2. **直接编辑配置**：

```jsonc
{
  "alias": "login-node",
  "host": "192.0.2.10",
  "user": "alice",
  "auth": { "kind": "password", "secretRef": "…" },
  "commandPolicy": {
    "deny": [
      "(^|[;&|(])\\s*(?:/?[^ /]+/){0,3}(python[0-9.]*|ipython|Rscript|R|make|gcc|g\\+\\+)(\\s|$)"
    ],
    "denyCommands": ["python", "python3", "Rscript", "R", "matlab", "julia", "make", "cmake", "gcc", "g++"],
    "allowCommands": [],
    "hint": "本服务器为 slurm 集群的登录节点，不可进行运算；请用 srun/sbatch 提交到计算节点。"
  }
}
```

### 两种规则怎么选

| 字段 | 判定方式 | 能抓到的典型形态 |
|---|---|---|
| `deny`（正则） | 对**整条命令文本**匹配（命令位置锚定） | `python x.py`、`cd /a && python x.py`、`/usr/bin/python3 …` |
| `denyCommands`（命令名） | 先**解包**再比对名字：跳过前置 `FOO=bar`、剥掉包装词（`sudo` / `env` / `time` / `nohup` / `bash -c "…"` 等）、去路径取 basename | `bash -c 'python x.py'`、`sudo -u me python3 …`、`nohup /usr/bin/python3 x.py` |
| `allowCommands` | 上述名字的**例外**（豁免优先） | 某个你允许偶发内联运行的命令名 |

两者可同时用；`srun -p gpu python train.py`、`sbatch run.sh`、`squeue` 这类提交/查询命令**不会被误伤**（`srun`/`sbatch` 不在禁止名单里，且正则锚定命令位置）。

### 拦截发生在哪

- **工具层**：`ssh_exec` / `ssh_cluster` / `bash`——按主机别名或会话所在工作区定位该主机策略；
- **seam 层**：任何经 `ctx.subprocess` 的远端 spawn（含第三方插件直连）对 `argv[0]` 与整行各查一次。

命中时报错形如：

```text
dsh-hardssh: 已阻止在 login-node 上执行该命令（命中该主机的禁止规则 /…/ 或 禁止命令 "python"）。
本服务器为 slurm 集群的登录节点，不可进行运算；请用 srun/sbatch 提交到计算节点。
```

### 诚实边界

这是**护栏（guardrail），不是沙箱**：`$(…)`、base64 解出再跑、脚本内部稍后调用计算命令，都能绕过。它的价值是**防止误用 + 把 agent 引导到提交路径**；真正的硬约束应放在服务器侧（Slurm 分区限额、`pam_slurm_adopt`、PATH 里的 shim）。
另外 `bash` 本身不建议放进 `denyCommands`：它会被当作**包装词**剥壳（这正是能抓到 `bash -c python` 的原因），把它列为禁止名会连 `bash` 工具自身的每个 spawn 一起拦掉。

## 数据位置

- 主机配置：`~/.dsh/dsh-ssh.json`（含每主机的 `commandPolicy` 命令守卫，见上文）
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

**怎么禁止 agent 在某台服务器上跑计算命令（例如登录节点）** —— 给该主机配 `commandPolicy`：GUI 里点该主机的 ⚙（编辑服务器），填「禁止命令名称」和「提示信息」，保存即生效；或直接编辑 `~/.dsh/dsh-ssh.json`。默认不拦截。详见「[主机命令守卫](#主机命令守卫可选)」——注意它是护栏而非沙箱。

**怎么让别的插件支持 SSH 工作区** —— 大多数插件零改动（走 seam）。少数需要改接口的，让 agent 读 [packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md) 按手册适配。

## 安全说明

插件持有主机凭据后，agent 可以以你的身份在远端执行命令。请只添加你信任的机器。
默认策略下密码不写入磁盘（仅在会话内存中存在）；主机密钥采用 TOFU 首次信任。
如需无人值守自动化访问密码主机，再显式启用 `vault` 模式并妥善保管主密码。

## License

BSD-3-Clause

## Changelog

见 [CHANGELOG.md](./CHANGELOG.md)。
