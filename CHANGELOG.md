# 更新日志（Changelog）

> 自 v0.1.2 起开始记录；更早的迭代版本见 Git 提交历史。

## v0.2.2 — 2026-09-11

> 0.2.1 从未发布：该批次的修复与本轮对抗式复核的修正合并为本版本。已在真实 Linux 服务器上做过端到端验证。

与上游 DSH 内核对比复核后的缺陷修复批次。以下每条都先在源码中回读确认，再修复并补回归用例；**随后又经过一轮对抗式复核，7 条声明被证明不成立或只做了一半**，修正内容以 `> 修正（同批次复核）` 标注在原条目下。

### 修复（高）

- **`write` / `edit` 的沙箱升级入口被静默关闭（全量会话，含纯本地）**：`SwitchFileSystem.sandboxMode` 曾无条件返回 `undefined`（HSSH-19 的「保守」修复），而 `dsh-tool-fs` 在 `apply()` 时**只读一次**该能力事实，据此决定是否注册 `sandbox_permissions` / `justification` 两个参数（`lib/index.js:1151-1152`、`:610`/`:764`，并在 `:1192` 明确拒绝该参数）。结果是「被拒 → 一次性升级重试」这条唯一出路对所有会话消失。现改为**委托本地后端的真实模式**；远端世界没有本地沙箱语义，其升级策略在门面处**显式丢弃**（而不是被远端后端 4 参数签名静默吞掉）。
- **cutover marker 与账本存在性脱钩 → 静默且永久的数据丢失窗口**：marker 只做形状校验、从不与账本比对，而 `WorkspaceLedger` 把 `ENOENT` 当空数组。删除 `~/.dsh/workspaces/index.v1.json`（或被任何清理脚本删除）后，启动既不会重导也不会报错，全部工作区**静默消失**。现在：`marker.recordCount > 0` + 账本**缺失或不可解析** = 数据丢失，按 `.last-good` → 最新 `.backup-*` → legacy 重导**依次恢复**；**每个候选都必须满足 marker 记录的 id 集合**，恢复不出全部工作区的来源一律拒绝，全部不可用时**拒绝启动**（core not ready，seam 对锚点路径 fail closed），并留下 `recovery-report.json` 作为可见凭据。每次保存都会滚动维护一份 `.last-good` 恢复副本（首次提交种子化，此后保存先前已提交内容）。
  > **修正（同批次复核）**：本条的初版实现有两个缺陷，已被复现并修复：① legacy 层「文件存在即算恢复成功」，从不检查迁移结果——空 legacy 会让门禁放行并把 marker 重写成 `recordCount: 0`，**永久关闭**该门禁；② 恢复候选不与 marker 对账，可能静默恢复出更小的工作区集合。现在 legacy 层以**不带 reportPath** 的方式重导（绝不改写 marker）、必须读回并满足 marker 的 id 集合，否则返回失败。回归用例：空 legacy 必须拒绝启动且 marker 不变、`.last-good` 记录不全时拒绝、损坏账本可从 `.last-good` 恢复、显式空账本仍具权威。
- **agent 提示词与实现矛盾**：远端会话提示词仍称「glob / grep / pwsh 在本工作区不可用（已被自动拦截）」，而该 guard 早已删除、路由改由 seam 承担。首次修正时按「glob/grep 走已路由的 fs」重写——**那句话是错的**（见下方同批次复核的 P0 级修正），现已改为按真实行为描述：glob/grep 用本机打包的 ripgrep，看不到服务器内容，在 SSH 会话里会被明确拒绝，改用 `remote_search`；`pwsh` 等为客户端原生二进制，本机执行。
  > **修正（同批次复核）**：`dsh-tool-fs-search` 是用**已解析的本机 ripgrep 绝对路径** `ctx.subprocess.spawn`，并不经过 `ctx.fs`：Windows 上该路径被判为客户端原生 → 在本地空锚点目录里搜索（静默返回「无匹配」）；POSIX 上被判为远端 → 把本机路径发到服务器（必然 ENOENT）。两种都错。现在 `SwitchSubprocessRuntime` 对「路径形态的 rg/ripgrep」在远端会话中**显式拒绝并指向 `remote_search`**；裸 `rg` 仍作为普通服务器命令走远端。README 的「所有标准工具都自动远端执行」也已改正。

### 修复（中）

- **并发破坏面过大**：任一操作 abort 会 `markBroken` + `client.end()` 掐掉**整条共享连接**，同 alias 上并行的 exec / SFTP / tunnel 全部陪葬。现在 abort 只取消**该操作自己**的请求（`exec` 通过新增的 `OperationControl.signal` 关闭自己的 channel），且仅当该租约是**最后一个持有者**时才退休传输；abort 判定改用 `signal.aborted` 而不是 `error.name`（调用方会用 `abort(new Error('cancel'))` 这类 reason）。SFTP 超时不再无条件 `sftp.end()`：共享子系统在仍有在飞请求时只标记 suspect，待其**排空后**再轮换。exec 超时后增加宽限观察，未 ack 的通道计入半开计数，累计到阈值（4，低于 `MaxSessions` 10）即**drain**（不再 force）该传输；迟到的 ack 会**递减**计数，慢对端不会累积到退休。
  > **修正（同批次复核）**：初版只覆盖了被点名的那一处，实测仍有四类问题，已全部修复并有回归用例：① 租约在 abort 时立即释放，导致 `holdsOnlyLease()` 在请求仍在飞时报告「没有其他使用者」，随后另一个会话的 abort 仍会掐断它——现由 `holdLeaseUntilSettled()` 把释放绑定到**操作**结束；② 另有 4 处 `sftp.end()`（writeFile 停滞、recursive rm 超时、fastPut/fastGet 停滞）未走共享通道保护——现统一走 `retireSharedSubsystem()`；③ `inFlight` 只统计 `withSftpTimeout` 调用者，裸 stat / 读写流 / 传输不计数，轮换仍可能掐掉并发传输——现由 `enter()`/`leave()` 覆盖传输与 rm/writeFile；④ 半开通道计数只增不减且跨代不清零，对端稍慢就会被累计到 force 退休——现改为迟到 ack 递减 + drain 退休；⑤ `invalidate` 在 alias 无活跃传输时提前返回，该类 alias 的会话密码**永不清理**——现在也会通知退休。
- **脱敏缺口**：PTY 输出、终端 exit 错误、`test()` 失败消息此前不经过 leak guard。现在终端 WebSocket 路由是统一脱敏出口（已知密文精确替换，best-effort），`test()` 错误也走 `redact()`。
  > **修正（同批次复核）**：还有三处出口未覆盖，已补：远程 `workspace.process` / `workspace.terminal` 的**流式** stdout/stderr（此前完全绕过 leak guard）、上传失败的 NDJSON 错误帧、以及 `ssh_*` 工具的失败信封（`captureToolResult` 现在经 `engine.redact`）。同样对缺少 redactor 的引擎替身保持容错。
- **凭据面**：vault 曾位于 `~/.dsh/dsh-ssh-vault.json` —— **恰好是 fs seam 声明的本地根**，绑定远端会话的 agent 可读到密文；配合 `DSH_CREDENTIAL_PASSWORD` 自动解锁即可离线还原。现在：vault 迁至 `~/.dsh/ssh-secrets/`（启动时自动搬移旧文件），并在 `SwitchFileSystem.deniedRoots` 中**显式拒绝**访问；`DSH_CREDENTIAL_PASSWORD` 自动解锁改为**显式 opt-in**（新增配置 `vaultAutoUnlock: off|env`，默认 `off`）。
  > **修正（同批次复核）**：初版把这条写成「移出 `~/.dsh` 之外」，**不成立**——新路径仍在 `~/.dsh` 内（代码注释与 README 当时自相矛盾），且 `deniedRoots` 只在 `resolve`/`lstat` 生效，`stat`/`readText`/`writeText` 等按 target 派发的路径不复查；旧路径 `~/.dsh/dsh-ssh-vault.json` 也未列入拒绝。现在：注释与文档如实说明「位置不是保护，显式拒绝才是」；`deniedRoots` 覆盖 `resolve`/`lstat` 的本地分支**以及** `decode()` 这一所有 target 派发的唯一入口（本地后端按 canonical 路径作 key，故指向 vault 的符号链接同样被拒）；旧路径一并拒绝。同时明确写下残余风险：以同一用户在本机运行的命令（如客户端 `pwsh`）仍能读到该文件，真正的保护是加密 + 默认关闭的环境变量自动解锁。
- **会话密码实为进程级**：`clearSessionSecrets` 只在进程退出时调用，连接池 30 分钟空闲回收并**不清理**。现在连接池退休传输时通过 `onRetire` 回调丢弃该 alias 的会话密码与对应脱敏材料（按剩余密钥重建，避免影响其他 alias），与文档一致。轮换密码时**保留**旧值的脱敏（用旧凭据建立的连接可能仍在回显它），直到该连接退休才释放。
- **`remote_search` 假成功**：命令以 `find ... 2>/dev/null | head -c` 结尾，退出码取的是 `head`，根目录不存在/无权限时返回「成功、无匹配」。现在生产者写入临时目录、退出码与 stderr 经 NUL 分隔的 trailer 回传，**空结果 + 非零退出码 = 失败**（grep 的 exit 1 仍表示无匹配，exit 2 报错）。
  > **修正（同批次复核）**：临时文件改为 `mktemp -d` + `trap` 清理（此前两个 `mktemp` 半失败会漏一个文件，且超时被 kill 时 `rm -f` 不会执行）；trailer 缺失时不再回退到「包装器自己的 0 退出码」——那会让**恰好超时**的场景复活假成功，现在空 body + 无 trailer = 失败。
- **深色主题对话框黑底黑字**：5 个对话框硬编码 `color: #000000` 配主题背景 token，改为 `var(--dsw-alias-label-primary, …)`（管理面板同样处理）。

### 修复（低）

- `/api/dsh-ssh/ls` 补齐与 workspace 路由同规格的路径校验（拒绝 NUL / 反斜杠 / 非 POSIX 绝对路径）。
- `/exec`、`/test`、`/ls`、`/cluster` 接入 `AbortSignal`：客户端断开即中止远端命令，不再跑满预算。
- `connect-host` 不再把 `listHosts()` 失败缓存成空 Map（此前一次失败即永久失去登录名提示）。
- 工作区面板的连接状态读取失败不再静默降级为「状态未知」，改为显示可见错误横幅。
- 删除死代码：`HostsTab.tsx`（236 行，仅类型 re-export）、`LocalBackend`（168 行，仅测试在用）及其用例、`BaseWorkspaceRouter`、`globalWorkspaceRegistry`、`mustRefuseUnreadyRouting`（其 B-01 语义改在**生产 seam** 上断言）、`WorkspaceRuntimeMode` 的 `'legacy'` 分支，以及 `backend.ts` 中随之失效的搜索常量与 helper。
- **host 侧 anchor 比较合并为单一实现**：`src/ledger.ts` 与 `src/base/ledger.ts` 各有一份且 Windows/UNC 根处理已分歧，现 `src/ledger.ts` 改为 re-export `base/ledger.ts` 的实现，保留 Windows 混合分隔符行为用例。
  > **修正（同批次复核）**：说「单一实现」是夸张的——`switch/subprocess` 的 `isUnder`（本地根/拒绝根成员判定）与客户端 `session-connect-gate.ts` 仍各有一份。客户端那份**不能**共享：`base/ledger.ts` 依赖 `node:fs`，无法进入浏览器产物。此处保留分歧并各自注明原因，不再声称全仓单一实现。
- 仓库卫生：内部审查报告、迁移计划、验证日志等加入 `.gitignore`（部分此前已被忽略），过期报告顶部加「已过期 + 已修项」标注。
- **构建产物卫生**：`lib/` 此前会累积陈旧产物——hash 变化后不再被引用的旧 chunk，以及**已删除模块**的 `.d.ts`（`tsc -b` 从不删除它们）——而 `files` 白名单（`lib/*.js`、`lib/types/**/*.d.ts`）会把它们一起发布。新增 `scripts/clean-build.mjs` 并在 `build` 前执行：清空 `lib/`（含 tsc build info，避免增量构建跳过输出）。清理后 `lib/` 只剩被引用的 9 个 JS 文件与当前模块的声明。

### 内部

- 新增 `SshEngine.noteLeakedChannel()` / `noteChannelClosed()`、`ClientLease.holdsOnlyLease()`、`holdLeaseUntilSettled()`、`ConnectionPoolOptions.onRetire`、`Vault` 的 `allowEnvUnlock`、`inspectGenericLedger()`、`recoverGenericLedger()`（含 marker 对账）、`migrateLegacyVault()`、`SwitchSubprocessRuntime` 的客户端搜索工具拒绝、`SwitchFileSystem.assertNotDenied()`。
- 测试：新增/改写 60+ 条用例（沙箱模式委托与远端策略丢弃、账本缺失/损坏恢复与**空 legacy 必须拒绝**、marker 不被降级、候选须满足 marker id 集合、提示词与真实行为一致、search 真实退出码与 trailer 缺失、vault 迁移与自动解锁 opt-in、deniedRoots 全路径覆盖与远端同名路径不误伤、池退休通知（含无活跃传输的 alias）、租约随操作结束才释放、abort 隔离、共享 SFTP 通道在传输停滞/超时时不被掐断、终端与流式通道脱敏、密码轮换后旧值仍脱敏、`/ls` 校验与客户端断开中止、面板错误态）。全量 **49 个测试文件 / 466 通过 / 3 跳过**。
- **复核机制**：本批次的所有「已修复」声明都在复核中被逐条回读，其中 5 条被证明**不成立或只做了一半**（账本门禁可被空 legacy 绕过、glob/grep 远端语义、vault 位置与拒绝覆盖面、并发整改只改了被点名的一处、`.last-good` 注释与断言自相矛盾）。修正内容以 `> 修正（同批次复核）` 标注在原条目下。

### 真机验证（真实 Linux 服务器，2026-09-11）

在一台真实的 Linux 服务器（CentOS 7 / 64 核，密码认证、`secretStorage: none`）上做了端到端验证：

- **服务器事实**：`rg = NONE`（服务器上**没有 ripgrep**），`find` / `grep` / `mktemp` 齐备。这从外部证实了 glob/grep 的能力边界：即使把 argv 改写成远端 `rg` 也无从执行，`remote_search`（走 `find`/`grep`）是唯一可行路径。
- **`remote_search` 包装命令（真机执行同一命令形状）**：
  - 正常根 → `code=0`、body 为 NUL 分隔记录、stderr 为空；
  - **不存在的根 → `code=1` + 74 字节 stderr**（旧实现此处返回「成功、无匹配」，即用户报告的假成功）；
  - scratch 根 `-mmin +10` 修剪：伪造的陈旧目录被清除、新目录保留；
  - `trap` 清理：shell 退出后该次运行的 `run.XXXXXX` 目录已消失。
  - **顺带发现并修掉一个残余问题**：早期版本在服务端留下了一个真实残留目录（内含 `out`/`err`，属本用户）。原因是 `trap` **无法覆盖 SIGKILL**，而 exec 超时正是以 KILL 结束命令。wrapper 因此改为写入**每用户固定 scratch 根**并由每次搜索修剪超过 10 分钟的目录，`/tmp` 不再被逐个污染。
- **0.2.2 路由行为（独立 3099 实例，与运行中的 3080 隔离）**：
  - `/connections` → `{connected:[]}`（只读、不拨号）；
  - `/ls` 相对路径与反斜杠路径 → **400 且在任何凭据/连接动作之前**（本批次新增校验）；
  - `/ls` 合法路径 → 500 带类型化 `code: NEEDS_PASSWORD` + `secret`（透传链路完好）；
  - `/test` → 200 `{ok:false, code:'NEEDS_PASSWORD', secret:'password'}`（交互式门禁完好）；
  - 未知 alias → 明确报错。
  - 该实例能正常启动也说明**新的账本门禁在真实 `~/.dsh/workspaces` 上正确放行**（未生成 `recovery-report.json`）。
- **顺带修正的文案**：真机返回的 `NEEDS_PASSWORD` 消息仍写「本会话内复用」，与 0.2.2 的「连接存活期」语义不符；`manager.ts` 的该消息、`store.ts` 与 `index.ts` 的注释一并改正。

### 重启后的真机回归与修复

- **真机新发现并修复（我引入的回归）：本地会话的 glob/grep 被我上一轮的拒绝逻辑打断。** 重启后 `glob`/`grep` 对**任何**路径都报 `ripgrep launch failed`（连 `C:\ProgramData` 也是）。逐层隔离（先排除路由拒绝 → 再确认 `@vscode/ripgrep` 在各候选根都能解析 → 用 DSH 自己的 local runtime 直接 spawn rg 成功 → 最后给构建产物插桩）后定位到根因：
  `SwitchSubprocessRuntime.effectiveRuntime` 用**对象身份**判断「是否本地」——`runtime === this.deps.local`——而从容器取到的服务实例与 `deps.local` **并非同一对象**（插桩输出：两者 `constructor.name` 都是 `LocalSubprocessRuntime`，但 `===` 为 `false`）。于是本地会话也走进「远端」分支，命中我为 glob/grep 新增的拒绝逻辑，**所有会话的 glob/grep 全部失效**。
  **修法**：不再比较身份，改由**路由答案本身**表达本地——`SwitchSubprocessDeps.worldFor` 返回类型改为 `SubprocessRuntime | undefined`（`undefined` = 本地），`src/subprocess.ts` 对应返回 `undefined`，facade 直接据此分流（与 fs facade 用 `namespace === ''` 表达本地同一思路）。隔离复现：修复前抛拒绝错误；修复后 `exitCode 0` 且能读到 ripgrep 输出。测试接线同步更新，并在拒绝用例中写明这条回归。
  审计结论：全仓已无其它「按身份比较服务实例」的判断。
- **修复后的真机验证**（同一台服务器）：
  - `exec`：stdout/stderr 分离、`exit 7` 原样透传；`timeoutMs=2000` 的 `sleep 30` → 报超时，随后连接**仍可用**（未被污染）。
  - **上传/下载字节完全一致**：`SKILLS.md` 7468 字节上传后远端 `md5`/`sha256` 与本地相同；下载回来后 `sha256` 仍相同（SFTP 写入与 fastGet 均正常）。
  - **隧道可用**：`127.0.0.1:57327 → 服务器:22` 本地监听成功，经隧道完成 TCP 握手并读到远端 `SSH-2.0-OpenSSH_7.4`；停止后本地端口释放。
  - `ssh_cluster`：限定单主机 → `ok`；`aliases=[<主机>,'does-not-exist']` → **整批拒绝且未执行任何命令**（未知 alias 的整批保护有效）。
  - 远端探针目录、临时文件与所有测试进程均已清理（`leftover_sleeps=0`、scratch 根不存在）。
- **第二次重启后：服务端预算包装实测通过（本条此前标为「仍未验证」）**
  - 包装确实下发：远端命令的父进程实测为 `timeout -k 2 3 /bin/bash -c …`；
  - `timeoutMs=2000` 的 `sleep 987654`：客户端 2s 超时后不再等待，服务端 3s 预算到期即清理 —— 等待 7s 后实测 **`orphans=0`**（修复前该 `sleep` 会一直存活到自然结束）；
  - 普通命令语义无副作用：stdout / stderr 分离、多语句与内嵌引号（`it's`）原样、`pwd` 正确、**`exit 7` 原样透传**；
  - `ssh_cluster` 的每主机命令同样经过包装（`exit 3` 按失败上报、`exit 0` 正常返回）；
  - 服务器已清理干净：探针目录、search scratch 根、`/tmp` 探针文件与全部测试进程（`leftover_sleeps=0`）。

## v0.2.0 — 2026-09-11

SSH 运维操作台改为**会话绑定**，修复启动批量连接与连接失败无提示，并在工作区管理面板加入服务器连接状态。

### 新增

- **右侧栏 SSH 操作台跟随当前会话**：操作目标由当前会话 `cwd` → 最长匹配的 SSH 工作区锚点解析得到，终端 / 传输 / 隧道 / 命令四个子页强制使用该工作区的 `alias` 与 `remoteRoot`。**移除全部服务器下拉框**——不再可能在同一面板里误操作到别的主机。
  - 传输页以工作区 `remoteRoot` 初始化远程路径与目录浏览器。
  - 隧道页只列出 / 停止 / 新建当前服务器的隧道（`stopAll` 与列表都按 alias 过滤）。
  - 命令页只对当前服务器执行（跨主机并发仍通过 `ssh_cluster` Agent 工具）。
  - 操作台顶部显示「跟随当前会话：{alias} · {remoteRoot}」。
- **本地会话模糊蒙版**：当前会话属于本地工作区时，操作台不挂载任何操作组件，渲染模糊的禁用占位并提示「SSH 操作台仅适用于 SSH 工作区会话」；SSH 会话下则随会话切换自动换绑并重置子页状态。
- **工作区管理面板的服务器连接徽章**：左侧「SSH 工作区」面板按服务器分组列出**全部**主机，每行显示「已连接 / 未连接」徽章（绿色圆点 = 连接池有活跃传输）。每 3 秒刷新一次，只读 `/api/dsh-ssh/connections`，**打开面板不会拨号**。
- **连接失败对话框**：非交互连接失败（网络不可达、认证失败、主机密钥异常、重试耗尽）弹出「无法连接服务器 {alias}」对话框并显示具体原因；同一 alias 只保留一个对话框。用户主动取消密码框 / 指纹确认仍不算失败。

### 修复

- **启动时批量连接所有服务器**：连接闸门在会话列表 `phase === 'pending'`（初始空列表，尚未拉到宿主机列表）时就完成了一次「采纳」，导致首个成功的列表拉取把**每一个历史会话**都当成新建会话，逐台探测其服务器。现在闸门在 `phase === 'ready'` 之前不建立基准；启动/刷新只探测**被恢复的当前会话**所属服务器，历史会话不再被扫描，本地会话不触发任何连接。
- **连接失败没有任何提示**：`connectHost` 此前对非交互失败只写 `console.warn`，GUI 上完全静默。现在统一经可见对话框上报。

### 内部

- 新增 `src/client/ssh/session-target.ts`：`Session → SSH target` 的可订阅数据源（`useSyncExternalStore` 友好，快照按 key 缓存保持引用稳定），基于公开的 `ctx.sessions.list` 与 `WorkspaceManager`，不引入第二份工作区句柄。
- `makeAnchorAliasResolver` 泛化为 `makeAnchorWorkspaceResolver<T>`，别名解析改为它的薄封装（最长锚点匹配、Windows 路径大小写折叠保持不变）。
- 新增 `ConnectionErrorDialog`；`SessionGateList` 增加 `phase()`。
- 测试：新增 `session-ssh-target`、`session-operations-panel`、`connect-host-feedback`、`workspace-panel-connections` 四组用例；`session-connect-gate` 增补「pending → ready 只探测当前 SSH 会话」回归。全量 47 个测试文件、428 通过 / 3 跳过。

### 文档

- README（中/英）重写：声明已适配最新版 DSH `0.1.5`；突出「对插件零改动的远端能力」「一套通用底座适配所有插件」「会话即服务器」「安全默认值」等优势；移除历史开发线叙述与限制性说明。
- 新增 [`packages/dsh-hardssh/SKILLS.md`](./packages/dsh-hardssh/SKILLS.md)：写给 agent 的插件适配手册（判定命令 → 接口对照表 → 可照抄代码 → 自检清单 → 禁止事项）；README 中给出「让 agent 直接读取 skills 完成适配」的指引。

## v0.2.0 一并包含（此前记录为未发布）

代码审查整改（C-02 / C-04 / A-05 / B-14 客户端侧 / D-05 / D-08）：让文档与实现一致，并收敛重复的传输层。

- **界面入口迁移到标准插件扩展点（适配 dsh 0.1.5 新 GUI）**：旧版的两处界面靠 DOM 注入（`[data-pane="sidebar"]` 插入入口行、`[data-pane="conversation"]` 塞入面板 + CSS 藏显），而 0.1.5 的 AppFrame 只输出 `data-sidebar-collapsed` / `data-rightbar-*` / `data-dragging`，`data-pane` 已不存在——两处界面在新内核上**静默失效**。现已全部改为公开槽位注册：
  - **SSH 工作区管理 → 左侧全局入口 + 中央面板**：`sidebar.panellist` 注册入口行（其 `id` 同时是 `main` 槽的 key），`main` 注册面板正文。行的按钮、标签与选中高亮由侧栏 shell 渲染；选中即切换中央列，切回会话即关闭面板。会话头部的「SSH 工作区」按钮与其下拉浮层**已删除**（功能并入该面板）。
  - **SSH 运维 → 右侧栏 page 类型 Tab**：`ctx.sidebarRightTabs.register({ id, kind, title, guide })` 注册类型，`sidebar.right.pane.tab` 注册正文，`sidebar.right.pane.tab.title` 注册标签文字。不声明 `patterns`（page 类型），只按 kind 打开，入口是右侧栏标签条的「+」与引导页——插件不强制展开右侧栏。Tab 实例按会话作用域，因此不自动打开。
  - 内部子标签由五个收敛为四个（**终端 / 传输 / 隧道 / 集群**）：主机 CRUD 归入左侧全局面板，不再在右侧重复。
  - **删除的 DOM 注入层**：`src/client/ssh/mount.tsx`、`src/client/ssh/sidebar-entry.ts`、`src/client/ssh/panel/controller.ts`、`src/client/manager-button.tsx`；`panel.module.css` 移除会话栏接管与入口行规则。
  - **顺带清理的两个同类死代码**：`workspace-badges.ts`（侧栏工作区行的远端徽章与悬停路径改写）与 `workspace-gate.ts`（点击工作区行前的连接门）同样依赖 `[class*="projectRow"]` 这类**非契约的选择器**，在新内核上无法可靠修复（内核不提供行装饰槽位，工作区列表 DOM 也无稳定属性）。徽章整块删除；连接门中仍被目录流使用的 `connectHost`（探测 + 主机指纹 TOFU / 会话密码弹窗）提取为 `src/client/connect-host.ts` 保留，非交互失败只写 console。路由安全本身由 host 侧按 cwd 判定，不受影响。
  - **接口包基线对齐**：`@deepseek-ai/dsh-client-ui-{slots,layout,sidebar,sidebar-right,workspace,conversation,settings}` 由 `0.1.2-alpha.3` 升到 `0.1.5-rc.1`（新槽位/新服务的类型只在这些版本里存在）。客户端对这些包全部是 type-only import，因此这次升级只影响编译期，浏览器产物运行时不加载它们。

- **代码审查缺陷修复（HSSH-01～21）**：按逐条裁决修复审查报告确认的问题。
  - **数据与删除边界**：迁移完成状态改为**原子持久化的 cutover marker**，不再靠「generic 中是否有 SSH 记录 / 内容是否相同」猜测（HSSH-01）；SSH 专用 CRUD 在 mutation 前校验 `provider.id === 'ssh'`，不再能改名/删除其他 provider 的工作区（HSSH-02）；删除工作区改为**先注销宿主 sidebar、再删台账**，注销失败时原 `id`/`anchor` 完整保留，不再生成新身份的「假回滚」（HSSH-03）。
  - **远端破坏面**：`rm` 在同一 SFTP 会话内先 lstat 叶子（symlink 只 unlink 链接），仅对递归目录做 canonical 化并在任何 `readdir`/`unlink` 之前拒绝等价于根目录的路径（`/`、`/.`、`/tmp/..`）（HSSH-05）。
  - **资源与并发**：WebSocket 终端帧严格运行时校验，非法帧只关闭该 socket 且整个回调是 no-throw 边界（HSSH-06）；Vault 的 `unlock`/`rekey`/`store`/`remove` 在单实例内统一串行，消除并发首次解锁与 KDF 窗口内的凭据丢失（HSSH-07）；sidebar 连接门精确移除已注册的 capture handler，重挂不再残留旧 alias 闭包（HSSH-08）；隧道正常短连接的 socket 从登记表移除，传输失败时立即幂等释放 lease（HSSH-09 / HSSH-10）；`invalidate(drain)` 允许旧 draining generation 与新 active generation 并存，配置更新不再必然失败（HSSH-20）。
  - **会话与传输**：显式 `aliases` 批量执行前整批拒绝未知 alias，不再静默丢弃（HSSH-12）；SFTP 读写在有进展时重置真正的 idle deadline，移除整文件绝对时限（HSSH-14）；传输贯通 `AbortSignal`（客户端 → 路由 → engine），上传改为「远端 partial → commit frame → rename」并在提交点后区分 `RESULT_UNKNOWN`，断开连接/组件卸载都会中止远端工作并清理 staging（HSSH-11）；终端在未成功移交 handle 的任何失败路径上关闭独占会话，`workspace root` 校验前移到打开 shell 之前（HSSH-15）；终端 ready 前输入做有界缓冲、resize 只保留最新，客户端 finalize 幂等保证 `onExit` 只回调一次（HSSH-17）。
  - **客户端时序**：目录流（宿主列表 / 目录浏览 / 目录选择 / 创建）与工作区管理器各数据源改为「只有最新请求可提交」，浏览期间禁用所有会改变路径的入口（HSSH-16）。
  - **语义与可移植性**：`SwitchFileSystem.sandboxMode` 保守返回 `undefined`，不再把本地沙箱模式当成所有 world 的默认值（HSSH-19）；真实 sshd 集成用例改为 capability skip，`~` 展开与 0600 权限断言按平台处理，Windows 上不再出现虚假红灯（HSSH-21）。
  - **未采纳**：`proxyJump` 递归展开（HSSH-13）——现有协议把 `proxyJump` 定义为目标自带的有序扁平链，递归展开会改变既有配置语义，属功能扩张而非缺陷修复。
- **已知缺口（本次未修复，单独开卡）**：generic 路径的 `workspace.process`（`SshSubprocessRuntime`）对 `spec.cwd` 不做 root 收敛——`remote-process.ts` 的 `resolveRemoteCwd()` 对任何 `/` 开头的 cwd 直接返回，`remote-subprocess.ts` 的 `spawn()` 也不再校验。这是既有行为（被删除的 `SshWorkspaceProcess.exec()` 曾有 canonical 收敛，但在生产装配中从未被使用），不是本次整改引入的回归；文档未把它描述为受 root 约束。

- **运行时收缩收尾（HSSH-04 / HSSH-18 / HSSH-22）**：删除全部已无生产调用者的兼容层，工作区运行时只保留唯一一套 generic 实现。
  - **删除的文件**：`src/remote-runner.ts`（`RemoteWorkspaceRunner` 兼容桥）、`src/seam-state.ts`（`WorkspaceSeamState`）。
  - **删除的类/接口**：`SshWorkspaceLedger`（旧 SSH 台账类；`src/ledger.ts` 只保留 `anchorRoot` / `anchorPathFor` / `ledgerPath` / `defaultTitle` / `normalizeRemoteRoot` / `normalizeAnchorPath` / `isPathUnderAnchor` / `mustRefuseUnreadyRouting` 等仍被使用的路径 helper）、`RemoteBackend`、`LedgerWorkspaceFileService`、`WorkspaceBackend`、`WorkspaceFileService`、`WorkspaceFileContext`、`SshWorkspaceFileSystem` / `SshWorkspaceProcess`（无 cordis context 的降级实现）、`WorkspaceCore.fromSshRecord` / `sshRecordToWorkspaceRecord` / `export type { SshWorkspaceLedger }`。
  - **收紧的签名**：`createSshWorkspaceProvider(engine, context)` 与 `registerBuiltinProviders(registry, deps, context)` 的 `context` 改为**必需**；`workspace.fs` / `workspace.process` 一律交付正式 DSH `SshFileSystem` / `SshSubprocessRuntime`（不再有第二套降级实现）。
  - **不再有 `runtimeMode`**：删除 `runtimeMode` 配置项与 `DSH_HARDSSH_RUNTIME_MODE` 环境变量以及 legacy 装配分支。generic 运行时是唯一实现。
  - **永久 cutover marker（HSSH-01）**：`bootstrapGenericWorkspaceCore` + migration report 保留。运行时只在**无有效 marker** 时做一次 legacy→generic 导入；导入成功后启动绝不再读冻结的 legacy 源、绝不按内容猜测、绝不重新 merge。
  - **回滚改为独立离线工具**：generic→legacy 的应急导出是独立脚本 `scripts/export-legacy-workspaces.mjs`（`pnpm workspace:export-legacy` / bin `dsh-hardssh-export-legacy`），不在插件进程内、不参与运行时装配、需显式 `--apply` 且留备份。
  - **测试覆盖不丢**：被删类的断言迁移到正式路径——runner 用例改为 `WorkspaceCore.openByAnchor()` + `workspace.fs` capability 集成用例；`RemoteBackend` / `SshWorkspaceLedger` / `WorkspaceSeamState` 的用例迁移到 generic router/seam（含「已删除工作区后 cwd 与陈旧 namespace 一律 fail closed」与 unready 锚点门禁）；lexical/canonical confinement 断言迁移到使用正式 `Context` 的 `SshFileSystem` / `SshSubprocessRuntime`。
- **配置单一来源（C-04）**：`secretStorage` 以插件配置为唯一来源——Vault 与主机存储按它在插件加载时构造一次。`dsh-ssh` 设置命名空间的同名项**不会**切换存储模式（其值被忽略）；两者不一致时，插件在启动及每次设置变更后打印明确警告，指出请求值、当前实际运行的模式，并说明应改插件配置后重载插件（重启 `dsh web`），不再静默假装已生效。
- **客户端传输层统一（A-05 / B-14 客户端侧）**：客户端只保留一套 HTTP 传输层（`src/client-http.ts` 的 `HttpApiError` + `readJson`），工作区客户端与 SSH 客户端共用；`SshApiError` 是同一个类的别名（既有 `instanceof` 判断继续有效），`WorkspaceApiError` 为其子类。错误对象始终携带 HTTP 状态与解析后的响应体：`code` / `secret` / `hostKeyFingerprint` / `hostKeyMismatch` / `remaining` / `retryAfterMs`。上传/下载此前自拼错误字符串、丢弃结构化字段的问题一并修复：这两条路径的失败现在抛出同形状的类型化错误，认证 / TOFU 失败可以触发 GUI 交互弹窗；非 JSON（如网关 HTML）错误体不再把原文当作消息。
- **公共底座入口（C-02）**：新增真实构建入口 `src/base/index.ts` → `lib/base/index.js`，并在 `package.json` exports 中提供 `./base`（`./workspace` 保留为类型面）。README 不再把底座描述为“已可稳定复用”。
- **文档对齐实现（D-05 / D-08）**：README（中文/英文）新增「当前状态」说明——通用 WorkspaceCore/台账是**唯一**的工作区运行时，旧 SSH 台账仅在首次启动、尚无 cutover marker 时作为一次性导入来源（不存在 `runtimeMode` / `DSH_HARDSSH_RUNTIME_MODE` / legacy 回退路径，回滚用独立离线导出脚本）；`workspace.fs` 的 version 检查是 **best-effort**（进程内按 target 写锁 + 版本比较，同进程串行化并拒绝陈旧版本，**不是远端原子 CAS**，跨进程/跨机器并发写无法原子仲裁）；通用底座 API 标记为**实验性**。`enabled` 改为描述其真实作用（只控制本插件挂载的 SSH 工作区路由、`remote_*` 工具与提示段落），不再称为“插件总开关”。

## v0.1.3 — 2026-09-04

市场收录修复：npm `repository` 字段补上 monorepo 子包映射（`directory: packages/dsh-hardssh`、
url 按 npm 规范写作 `git+https://…`），使 npm 映射探测能把发布包指回被收录的仓库子路径，
站点不再回退到会启动失败的 github 源码安装。功能与 v0.1.2-alpha 一致。

## v0.1.2-alpha — 2026-09-02（开发线）

面向市场发布准备：npm 仓库关联（`repository`/`homepage`）补全；peer 依赖放宽为全版本
dsh 内核兼容（`@deepseek-ai/dsh-*` → `*`）。功能与 v0.1.2 一致，另含：
README 界面预览与「实现原理（seam 替换）」说明、连接门弹窗可重复唤起修复、
工作区悬停显示远端目录、dsh 原生风格 UI。

## v0.1.2 — 2026-09-02

从 `dsh-sshworkspaces` 元项目拆分为独立插件后的首个版本，适配最新版Deepseek Harness（0.1.2-alpha.3）。

- **拆分独立**：包名 `@tiphareth/dsh-hardssh`，独立 pnpm workspace，独立 `typecheck` / `build` / `test`。
- **更通用的底座**：抽象出通用工作区底座（WorkspaceLedger / WorkspaceProvider / Registry / Router / WFS 切换）。**事后更正**：本条发布时只代表抽象层已就位——生产路由当时仍由旧 SSH 台账承担；通用台账接管生产路由与公共 `./base` 入口见「未发布」一节。**再更正（收尾）**：通用台账现在、且是唯一的工作区运行时，旧 SSH 台账类与其回退装配（`SshWorkspaceLedger` / `WorkspaceSeamState` / `runtimeMode` / compat runner）已全部删除。
- **新增安全措施**：
  - VSCode Remote-SSH 式凭据策略（`secretStorage`：默认 `none` 密码不落盘，可选 `vault` 加密存储）；
  - 会话级密码表（连接 / 浏览目录时弹窗输入一次，会话内复用，进程退出即清空）；
  - 主机密钥 TOFU + 指纹确认框（防中间人）。
- **UI 优化**：SSH 面板与工作区管理器（主机增删改查、连接状态徽章、点击连接门、远端目录悬停提示、DeepSeek 风格视觉、弹窗自适应高度）。