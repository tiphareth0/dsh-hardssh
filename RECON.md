# dsh-hardssh 现状勘察（供方案分析使用）

本文件为从 `C:\Users\Kether\dsh-sshworkspaces` 现场采集的事实，供拆解/底座化方案参考。

## 1. 源项目结构
- 根仓库：`C:\Users\Kether\dsh-sshworkspaces`（pnpm workspace）
- `pnpm-workspace.yaml`: `packages/*`，catalog 固定 toolchain（typescript 5.9.2 / vitest 4.1.8 / jsdom 30.0.1 / tsdown 0.22.14 / react 18.3.1），`autoInstallPeers: false`，`allowBuilds` 含 ssh2/esbuild/node-pty/cpu-features/koffi/dsh-subprocess-local。
- `packages/`: `dsh-aionui-panel`, `dsh-hardssh`, `dsh-shared`（仅含 node_modules，实际为空壳）, `dsh-workbench-tiphareth`。
- `dsh-shared` 实际为空（只有 node_modules，无 src / package.json），即 dsh-hardssh 对外部兄弟包几乎没有实质源码依赖，只依赖 `@deepseek-ai/*` 官方 peer 运行时 + 少量三方（ssh2/ws/xterm）。

## 2. dsh-hardssh 包（目标拆解对象）
`packages/dsh-hardssh`:
- 文件：`src/`(源码), `lib/`(构建产物), `tests/`, `tsup/tsconfig/tsdown 配置`, `cordis.patch.yml`, `README.md`
- `package.json`: name `dsh-hardssh` v0.1.0 private, type module, engines node ^22.19||>=24; main `lib/index.js`；exports 支持 `.` `/fs` `/subprocess` `/client` 子路径；`dsh.bundle.patch=cordis.patch.yml`；`dsh.client.inject=[dsh-client-runtime, dsh-client-connection, dsh-client-ui-settings]`、platform web。
- scripts: build=`tsc -b && tsdown`, bundle=`tsdown`, watch, typecheck, test=vitest, prepare=tsdown
- dependencies: @xterm/addon-fit, @xterm/xterm, ssh2, ws
- peerDependencies: @deepseek-ai/cordis, dsh-client-connection/locale/runtime/ui-settings/ui-sidebar/ui-slots, dsh-fs, dsh-fs-sandbox, dsh-host-webserver, schemastery, dsh-settings, dsh-subprocess(+local), dsh-system-prompt, dsh-timeout, dsh-tools, react/react-dom —— 全部是 `^0.1.0-rc.6`（DHS 官方运行时，运行时从 dsh profile 树解析，不自动装 peer 副本避免双实例）。
- devDependencies: 加 dsh-client-ui-conversation、dsh-client-ui-workspace(0.1.0-rc.8)、dsh-fs-local、dsh-invariants、dsh-llm、dsh-sandbox、dsh-sandbox-policy、@deepseek-ai/cordis、@types/*、jsdom/react/react-dom/tsdown/typescript/vitest(catalog)。
- license BSD-3-Clause; files: lib/*.js, lib/types/**/*.d.ts, src, cordis.patch.yml, README.md

## 3. 源码架构（src/）
### 3.1 入口与核心
- `src/index.ts`（host half，cordis 插件 name=`hardssh`, inject=['tools','systemPrompt']）
  - Config: {enabled, announceToAgent}
  - 生命周期：建 HostStore → SshEngine → RemoteSearchService → SshWorkspaceLedger → WorkspaceSeamState；`ctx.provide('hardsshCore', core)`（另以 `sshWorkspaceCore` 别名提供）。
  - 调 `mountSshCapability(ctx, {store, engine})`（SSH 运维表面对接共享引擎）。
  - routes 通过动态 `ctx.inject(['webServer'], ...)` 注册（headless 无 webServer 也不阻塞）。
  - 注册 remote_* 工具（makeWorkspaceTools）；工具 guard 拦截 SSH 会话里的 glob/grep/pwsh；systemPrompt section 输出本地/远程指引。
  - 宿主工作区注册钩子 registerHostWorkspace/unregisterHostWorkspace（操作 `workspaceRegistry` 可选服务）。
- `src/core.ts`: `HardsshCore` = {hosts, engine, ledger, seams, resolveRemote?}；deprecated 别名 `EasysshCore`；cordis Context 声明增强。
- `src/protocol.ts`: 纯类型契约（WorkspaceMode local|remote、WorkspaceState、WorkspaceEntry、DirListing、FileRead、FileWriteResult、SearchHit、SearchView、ApiErrorBody、WORKSPACE_API 常量、SshWorkspaceRecord{id,title,alias,remoteRoot,anchorPath,createdAt}、SshWorkspaceLedger、RemoteDirEntry）。
- `src/ledger.ts`: `SshWorkspaceLedger` —— SSH 绑定工作区台账：本地锚点目录↔远端目录映射。持久化 `~/.dsh/dsh-hardssh-workspaces.json`；锚点根 `~/.dsh/ssh-workspaces/<id>/`。原子写、增量 subscriber、同步锚点索引（findByAnchorSync）。CRUD: create/rename/remove/get/list/findByAnchor/snapshot。
- `src/seam-state.ts`: `WorkspaceSeamState` —— 共享派生缝状态：台账派生路由快照 + 每条记录的 fs/subprocess 实例；fs 与 subprocess 两条缝读同一状态避免脑裂。bindFs/bindSub 工厂，worldForFs/worldForFsNamespace/runtimeForSub。
- `src/remote-runner.ts`: `RemoteWorkspaceRunner` —— 让其他插件（dsh-workbench-tiphareth）对 SSH 绑定工作区跑 git/files/terminal；`resolveRemote(anchorPath)` → RemoteWorkspaceContext{alias, remoteRoot, git, run, list, stat, readFile, writeFile, mkdir, rm, rename, openTerminal}。鸭子类型，避免编译期依赖。

### 3.2 主机/远端路由缝（switch）
- `src/fs.ts`: `name='hardssh-fs'`, inject=['hardsshCore','sandboxPolicy']。本地后端 SandboxedFileSystem 放入 isolate 子作用域；bindFs 每条记录建 SshFileSystem；new SwitchFileSystem(ctx,{local, worldFor, worldForNamespace})。
- `src/subprocess.ts`: `name='hardssh-subprocess'`, inject=['hardsshCore']。LocalSubprocessRuntime 本地；bindSub 每条记录建 SshSubprocessRuntime；new SwitchSubprocessRuntime。
- `src/switch/switch-fs.ts`: `SwitchFileSystem extends FileSystem` —— 按会话 cwd 路由每个文件系统调用到目标后端；远程命名空间键 `ssh:<recordId>:`；本地为空命名空间；translateAnchorPath 把模型给的本地锚点路径改写为远端根；未知 SSH 命名空间 fail closed。resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText 全部委托解码后的后端。
- `src/switch/switch-subprocess.ts`: 类似子进程切面。

### 3.3 远端实现（remote/*）
- `src/remote/remote-fs.ts`: SshFileSystem（SFTP 文件系统）。
- `src/remote/remote-subprocess.ts`: SshSubprocessRuntime。
- `src/remote/remote-process.ts`, `remote-terminal.ts`, `environment.ts`（per-alias 环境缓存 + invalidateRemoteEnvironment）, `output.ts`。

### 3.4 SSH 专属（ssh/*）
- `src/ssh/engine.ts`: SshEngine（ssh2 连接池/短连接、exec/ls/stat/readFile/writeFile/mkdir/rm/rename/openShell、PTY）。
- `src/ssh/store.ts`: HostStore（~/.dsh/dsh-ssh.json 主机配置）。
- `src/ssh/plugin.ts`: mountSshCapability —— 挂 SSH 运维表面：/api/dsh-ssh 路由+terminal upgrade、ssh_* 六工具（sshList/sshExec/sshUpload/sshDownload/sshTunnel/sshCluster）、dsh-ssh settings 命名空间、SSH_GUIDANCE prompt section。
- `src/ssh/protocol.ts`, `routes.ts`, `tools.ts`, `connection/{pool,lease}.ts`, `exec/output.ts`, `transfer/progress.ts`。

### 3.5 其他
- `src/backend.ts`: LedgerWorkspaceFileService（浏览器面板读文件服务）。
- `src/routes.ts`, `src/tools.ts`（remote_* 服务）：remote_ls/remote_search/remote_status 等。
- `src/remote-search.ts`, `src/host-http.ts`, `src/client-http.ts`, `src/shell.ts`。
- `src/client/*`: 浏览器半（React）—— api, directory-flow, manager-button, state, workspace.module.css, ssh/panel/*（SshPanel, HostsTab, TerminalTab, TransferTab, TunnelsTab, ClusterTab, controller, helpers, HostFormDialog）。
- `cordis.patch.yml`: 供 dsh host 的 profile 缝补丁（禁用内建 fs/subprocess/fs-sandbox 由 hardssh 接替）。

## 4. 关键设计要点（底座化相关）
1. 该插件已实现「分工作区」：本地会话→本地沙箱；SSH 绑定会话→远端主机。路由锚=会话 cwd。
2. `ctx.fs` / `ctx.subprocess` 被 hardssh 的 Switch* 切面替换，接替宿主原本的 fs/subprocess provider。
3. 关键抽象已有雏形但 SSH 强耦合：
   - `WorkspaceWorld`（backend+namespace）其实独立于 SSH，但命名空间前缀硬编码 `ssh:`。
   - `SshWorkspaceRecord`（alias/remoteRoot 字段）耦合 SSH。
   - `HardsshCore`、`WorkspaceSeamState`、`RemoteWorkspaceRunner` 接口本质上通用，但都挂着 Ssh 前缀/SSH 引擎依赖。
   - ssh_* 运维工具与 remote_* 工作区工具混在一个包。
4. `RemoteWorkspaceRunner.resolveRemote` 已经是一个「把第三方插件接入工作区分发」的雏形（鸭子类型）。
5. 宿主交互点：cordis 插件（name/inject/config/apply）、ctx.provide('hardsshCore'/'sshWorkspaceCore')、ctx.fs/ctx.subprocess 提供者替换、systemPrompt.section、ctx.tools.register/guard、webServer 路由、workspaceRegistry 可选服务、dsh.bundle.patch（cordis.patch.yml 缝补丁）、dsh.client inject。
6. 目标输出位置：`C:\Users\Kether\.dsh\ssh-hardssh`（当前为空目录，仅 RECON.md）。
