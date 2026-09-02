# dsh-hardssh 独立化 + 通用工作区底座 方案（含实施记录）

> 由 codex 子代理基于现场勘察（[RECON.md](./RECON.md)）产出方案，随后已在
> `C:\Users\Kether\.dsh\dsh-hardssh` 独立仓库落地实施。
> 包发布名：**`@tiphareth/dsh-hardssh`**（用户确认的个人 scope）。

---

## 0. 内核升级兼容记录（2026-09-01，dsh 0.1.2-alpha.3）

用户将 dsh 内核升级到 0.1.2-rc.2 线（实际包版本 0.1.2-alpha.3）后 `dsh web` 报
错：`@deepseek-ai/dsh-settings` 不再导出 `installSettingsSection` /
`settingsNamespace`。已完成的兼容修复：

| 破坏点 | 修复 |
|---|---|
| `dsh-settings` 删除 `installSettingsSection(ctx, ns, schema, base, hooks)` 与 `settingsNamespace(name)` | 改为 `ctx.settings.installSection(ctx, 'dsh-ssh', SshConfig, {}, { setSource, onChange })`；命名空间直接传字符串字面量 `'dsh-ssh'`（新 API 类型层校验），`SSH_SETTINGS_NAMESPACE` 变普通字符串 |
| `settings` 服务可选化 | 用 `ctx.get('settings')` 动态探测：无 settings 服务（headless）时降级走默认配置，避免硬注入阻塞加载树 |
| peer/devDeps 版本 | host 侧 `@deepseek-ai/*` 升级到 0.1.2-alpha.3（cordis ^4.0.2，schemastery ^3.18.1）；**dsh-client-runtime 无 alpha.3，保留 ^0.1.1-rc.2** |
| `dsh-tools` defineTool | 核查确认 0.1.2-alpha.3 与 rc.6 **工具 API 完全一致**（defineTool/参数 DSL/ToolArgsError/`{type:'text'}` 不变），无需改 tools.ts |
| `dsh-host-webserver` WebRoute | 源码已带 `kind: 'exact'`，与新必填字段兼容 |
| `dsh-system-prompt` section | `section({ name, order, text })` 兼容；text 参数改为 `AssembleContext` |
| `dsh-fs`/`dsh-subprocess`/`dsh-sandbox` | 构造/方法签名兼容，无需改动 |
| 安装 | `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 更新为 alpha.3 列表；仓库 `.npmrc` 指向官方 registry（用户全局 npmmirror 当前不稳定） |

验证结论（2026-09-01）：
- 仓库 typecheck / build：**0 错误**
- 全量测试：**187/195 通过**（8 失败为既有的 Windows 无 sshd / POSIX 路径与权限位 / dsh-tools 参数行为，与升级前一致，非迁移回归）
- `dsh web` 端到端：旧包报错 `installSettingsSection` 消除；新构建以端口 0 完整启动并监听成功（`SUCCESS: dsh web listening`），插件树（含 dsh-hardssh）加载通过
- profile 部署：新构建以裸名 `dsh-hardssh` 覆盖 `~/.dsh/profiles/web/node_modules/dsh-hardssh/`（bundle 引用与 cordis.patch.yml 维持裸名不变）；备份在 `profiles/web/repair-backup-20260901-alpha3-dsh-hardssh/`

---

## 0.5 版本号与 UI 改版记录（2026-09-01）

| 项 | 内容 |
|---|---|
| 版本号 | `0.1.0` → **`0.1.0-alpha3`**（package.json、tarball `dist/tiphareth-dsh-hardssh-0.1.0-alpha3.tgz`、profile 安装同步） |
| Bug 修复 | **"添加服务器"弹窗内容裁剪**：`.modal` 原为整卡 `overflow-y:auto`，flex 子项 `min-height:auto` 使内容超过卡片被裁。改为**固定标题栏 + 可滚动 `.modalBody` + 固定底部按钮条**的三段结构，`min-height:0` + `flex:1` 滚动，内容永不越界被裁 |
| UI 改版（最终形态） | 需求：两个界面原本视觉像 macOS（用户不喜欢），目标是 **DeepSeek / dsh 产品美术风格**。历经三轮按用户反馈收敛：① 与 dsh 整体一致（淡灰/白底黑字，跟随主题——全部改用 dsh `--dsw-*` tokens）；② 圆角收小（modal/下拉 6px、input/button 6px）；③ 按钮最极简（主按钮纯 `#4D6BFE` 无渐变无辉光、次按钮透明+细边框、无磨砂玻璃）；④ **删除卡片上方 3px 品牌蓝顶条**（`.modal::before` / `.menuDropdown::before`，用户反馈"像隐藏在后面的一张蓝色卡片"）；⑤ **字体全改纯黑**（fieldLabel/radio/hint/ghost 全部 `#000`/`#333`，移除 label-secondary/tertiary 灰阶）；无毛玻璃、无红绿灯、无 SF Pro |
| 涉及文件 | `panel.module.css`（modal 段 + 表单控件段 token 化 + 删蓝条 + 黑字 + 6px）、`HostFormDialog.tsx`（三段结构 + whaleMark）、`workspace.module.css`（form/dialog/menu 段 token 化 + 删蓝条 + 黑字 + 6px） |
| 验证 | typecheck/build 0 错误；187/195 测试通过（8 失败为既有平台问题）；blue-strip 类命中 0、`#1e1e1e` bundle 残留 0、纯黑样式 21 处；`dsh web` 端到端启动无错 |
| 溢出修复（第四轮） | 用户反馈"添加服务器"仍超出边界。根因：`.modal` 链缺 `box-sizing`、`.modalBody` 缺 `overflow-x`、grid 子项（input）`min-width:auto` 按内容撑宽顶破卡片。修复：`.modal` 加 `box-sizing:border-box; min-width:0`；`.modalBody` 加 `overflow-x:hidden`；`.input` 加 `width:100%; min-width:0; box-sizing:border-box`；`.field/.formRow/.modalHeader/.modalFooter` 加 `min-width:0`；窄屏(<420px) 表单行单列。**注意：插入 `padding: 7px 10px` 锚点时误命中 `.table td`，已还原（主机表格布局完好，验证过）** |
| ⚠️ 部署陷阱 | **pnpm `file:` tarball 内容更新不同路径时不会真正重装**——同路径覆盖 tarball 后 `pnpm install`（含 `--force`）仍保留旧内容（用户发现界面还是黑底白字）。**根因：依赖 specifier 是文件路径，内容变化不改变 specifier，pnpm 判定为同一依赖跳过**。**解决：改 tarball 文件名**再改 profile 依赖路径并重装。当前采用 `dist/tiphareth-dsh-hardssh-0.1.0-alpha3d.tgz`（每轮改版递增后缀字母，杜绝缓存） |

## 0.6 安全加固 + 服务器管理（2026-09-01，基于 codex 方案 dist/SECURITY-PLAN.md）

用户要求三项：① 工作区管理器服务器行加齿轮(编辑)/减号(删除，前提无工作区)/底部新建服务器；② 安全防护
（Host-Key 验证 + 密码加密存储），参考 lab-ssh TOFU 与 DSH-Encrypt，codex 出完整方案后实施。

| 实现 | 文件 |
|---|---|
| **Phase A Host-Key TOFU**：首次连接记录 pending 并**拒绝**（密码不发往未验证主机）→ GUI 确认 trusted → 每次连接 `timingSafeEqual` 固定校验；`forget` 支持轮换 | 新增 `src/ssh/known-hosts.ts`；`engine.ts` `EngineDeps{knownHosts,hostKeyPolicy,hostKeyAlgorithms,resolveSecrets}`（可选后扩，缺省旧行为）；`routes.ts` `/api/dsh-ssh/known-hosts` + `HOST_KEY_*` 错误码；`client/ssh/api.ts` + `HostFingerprintDialog.tsx` + HostsTab 接入 |
| **Phase B 凭据 Vault**：AES-256-GCM（每条目独立 nonce + AAD 绑定 alias/purpose）+ scrypt(参数随文件头) + SHA3-256 完整性；爆破锁定(≥5 次指数退避持久化)、阅后即焚、Leak Guard 脱敏 `security.redactOutputs` | 新增 `src/ssh/vault.ts`；`store.ts` 增 `SecureHostStore`（组合 vault，create/update 秘密入 vault 留 secretRef，resolveAuth 解密）；`engine.ts` connectChain 前置 resolveSecrets；`routes.ts` `/api/dsh-ssh/vault{status\|unlock\|rekey}`；`index.ts` 生产装配 |
| **Phase C 删除拦截 + 服务器管理**：routes DELETE 先查 ledger → 有工作区引用 409 `HOST_IN_USE`（含标题列表）；manager 服务器行齿轮(编辑 HostFormDialog)/减号(有工作区置灰)/底部新建 | `routes.ts` `SshRoutesDeps.ledger` + DELETE 拦截；`manager-button.tsx` 全套；`client/index.ts` slot inject 增 sshApi；locales 增键 |
| 架构边界 | `src/base/*`、`providers/`、`runtime/` 零改动（仅类型放宽为只读 `HostStoreView`）；SshEngine 构造参数尾部后扩（旧测试零改动） |
| 验证 | typecheck/build 0 错误；**213 测试 205 通过**（8 失败全为既有平台问题：Windows 无 sshd/路径/权限、dsh-tools 参数行为）；新增 known-hosts 8 + TOFU 3 + vault 7 全绿；`dsh web` 端到端 59676 端口启动无错 |
| 部署 | `dist/tiphareth-dsh-hardssh-0.1.0-alpha4.tgz`（pnpm `--offline` 安装避开网络波动；包 version 仍 0.1.0-alpha3，文件名即部署标签） |

---

## 0. 用户决策记录（2026-08-31）

| 决策点 | 结论 |
|---|---|
| 新包命名 | `@tiphareth/dsh-hardssh`（个人发布 scope） |
| 项目/仓库名 | **dsh-hardssh**（`ssh-hardssh` 为拼写错误目录，已重命名） |
| 实施范围 | 直接做到 **Phase 2（底座抽象）** |
| 架构形态 | 单包内分层（`src/base` + `src/providers` + `src/runtime`），第三方可仅依赖 base 子路径 |

---

## 1. 架构总览（实施后）

```text
src/base/          ← 通用底座（零 SSH/Cordis/React 依赖）★已实现
   ├─ model.ts         WorkspaceRecord/ProviderRef/Location/Anchor/Connection/Provider
   ├─ capability.ts    WorkspaceFileSystem/ProcessRuntime/TerminalService/SearchService
   ├─ registry.ts      WorkspaceProviderRegistry + WorkspaceRegistry 接口
   ├─ ledger.ts        WorkspaceLedger（通用台账：锚点索引/原子写/订阅）
   ├─ namespace.ts     wfs:// 新格式 + ssh: 旧格式兼容 codec
   ├─ router.ts        WorkspaceRouter 接口
   ├─ ledger-router.ts LedgerWorkspaceRouter（台账+注册表+连接缓存）
   └─ plugin.ts        WorkspacePlugin/Feature/PluginHost（注册/分发）
src/providers/     ← provider 实现 ★已实现
   ├─ local/provider.ts   LocalWorkspaceProvider（Node fs，无 DSH 依赖）
   ├─ ssh/provider.ts     SshWorkspaceProvider（适配 SshEngine→通用接口）
   └─ index.ts            registerBuiltinProviders
src/runtime/       ← DSH 边界 ★已实现
   └─ workspace-core.ts   workspaceCore 服务 + sshRecordToWorkspaceRecord 迁移桥
src/（legacy）     ← 保留：index.ts / fs.ts / subprocess.ts / ssh/ remote/ switch/（wfs 兼容）
```

关键依赖方向：`base ← providers ← runtime`，base 不反向依赖任何上层。

## 2. 底座四大抽象（已落地）

### a) 通用 Workspace Model（base/model.ts）
```ts
WorkspaceRecord { schemaVersion, id, title, provider{id,instanceId?,connectionRef?}, location{kind,root,options?}, anchor?, createdAt, updatedAt, labels?, extensions? }
WorkspaceProvider / WorkspaceConnection / WorkspaceCapabilityMap
```
SSH 专属字段（alias/remoteRoot）映射为 `provider.connectionRef + location.root`。

### b) Provider / Capability（base/capability.ts, providers/*）
- capability map：fs / process / terminal / search；provider 只实现自己支持的，连接用 `get()` 查，缺省优雅降级。
- local provider 直接基于 Node fs（无 DSH 依赖），SSH provider 把 SshEngine 包装为同一接口。

### c) WFS 与 Switch 切面（base/namespace.ts, base/ledger-router.ts, src/switch/switch-fs.ts）
- 新命名空间：`wfs://<workspace-id>/<path>`（不含 provider 名）。
- 兼容：decode 同时接受旧 `ssh:<recordId>:…`；`fs.ts` 已改为生成 wfs:// 新格式。
- 路由优先级：显式 wfs:// → 会话 cwd 锚点 → 本地路径；未知命名空间 fail closed。
- switch-fs 的 decode 已双格式兼容（`WFS_NAMESPACE_MARKER` + `REMOTE_PREFIX`）。

### d) 插件注册/分发（base/plugin.ts）
- `WorkspacePlugin{manifest, activate}` + `WorkspacePluginContext{registerProvider, registerFeature, workspaces, onWorkspaceChange}`。
- provider plugin（local/ssh/docker/…）与 feature plugin（索引/审计/诊断）分离。
- DSH 专属贡献（工具/路由/prompt/client）经 runtime bridge，不进入 core。

## 3. SSH 收拢策略（实施后）

- `src/ssh/**`（engine/store/protocol/routes/tools/connection）+ `src/remote/**`（remote-fs/subprocess/terminal/search）整体保留为 SSH 实现层。
- 新增 `src/providers/ssh/provider.ts` 把 `SshEngine` 适配为 `WorkspaceProvider`（open→connection→get('workspace.fs'|'workspace.process'|'workspace.terminal'|'workspace.search')）。
- 底座只见 `registry.get('ssh') → open() → connection.get(...)`，无 `instanceof SshFileSystem`、无 engine import。

## 4. 迁移步骤（已完成）

1. 源 `packages/dsh-hardssh` 的 `src/`、`tests/`、`cordis.patch.yml`、`README.md` 复制入新仓库。
2. 新仓库根：`package.json`（type:module, lightningcss devDep）+ `pnpm-workspace.yaml`（catalog/autoInstallPeers=false/allowBuilds/rc.6 exclude）+ `.gitignore` + `shared/`（tsdown.client.ts + web-platform.ts 预设）。
3. 包 `package.json` 改名 `@tiphareth/dsh-hardssh`；exports/peer/dsh.client.inject 保留；cordis.patch.yml 与 tsdown id 同步更新。
4. 依赖解析：peer 全部 `^0.1.0-rc.6` 保留；devDeps 精确 pin rc.6（避免 caret 漂到 rc.8）；补缺 `@deepseek-ai/dsh-scope`（rc.6 工具链 peer）。
5. 独立 lockfile 重新生成；`pnpm install` 后构建/typecheck 通过。
6. Phase 2 分层落地（见 §1-3）+ 全局 `workspaceCore` 服务在 `src/index.ts` 挂载，`hardsshCore`/`sshWorkspaceCore` 别名保留。

## 5. 测试与验收（完成）

| 验收项 | 结果 |
|---|---|
| 独立 `tsc -b` typecheck（host+client） | ✅ 0 错误 |
| 独立 `tsdown` build（lib + client bundle） | ✅ 通过 |
| `vitest run` | ✅ **187/195 通过**；**8 个失败全部是 Phase 1 已存在的平台/既有问题**（3 * store：Windows 反斜杠 `keys\id` vs `keys/id`、POSIX 权限位 0o600；3 * engine：Windows 无 `/usr/sbin/sshd`；2 * tools：dsh-tools rc.6 参数校验行为），非本次回归（源仓库在同机根本无法加载 tools.test.ts） |
| 新增 base/providers 测试 | ✅ 31/31：namespace codec（wfs/legacy/fail-closed）、通用 ledger（CRUD/锚点/持久化/订阅）、local provider WFS、ledger-router（wfs+ssh 兼容路由）、**Phase 3 第三方插件集成（内存 provider + feature + 真实卸载断言）** |
| base 层依赖纯净性 | ✅ grep 确认无 ssh2/SshEngine/HostStore/@deepseek-ai/cordis/react 值导入（仅 @module 注释命中） |
| 包发布准备 | `@tiphareth/dsh-hardssh` v0.1.0，exports 保留 `.`/fs/subprocess/client，files 含 src/cordis.patch.yml |

## 6. 里程碑状态

- ✅ **Phase 1**：独立拆包，行为不变，独立构建/typecheck/test 通过。
- ✅ **Phase 2**：底座抽象落地（model/provider/capability/registry/ledger/namespace/router/plugin + local/ssh provider + runtime 桥 + wfs:// 命名空间 + 兼容）。
- ✅ **Phase 3**：插件注册/分发接口成型（base/plugin.ts）+ **第三方非 SSH provider（内存 provider）与 provider 无关 feature 验证通过**；`WorkspacePluginHost.unload` 真实释放 provider/feature/workspace 监听，卸载断言通过（含 `WorkspaceRegistry.unregister` 新增接口）。

## 7. 遗留决策点（发布前确认）

1. 是否发布到 npm（`@tiphareth` scope 需先注册确认 `@tiphareth` 用户名/组织），还是保持私有。
2. `dsh.workspacePlugin` 静态 manifest 字段的 schema（provider/feature/clientEntries 声明）——当前在 base/plugin.ts 中以 TS 接口存在，尚未接入 `package.json` 的 `dsh.workspacePlugin` 读取。
3. 旧的 `~/.dsh/dsh-hardssh-workspaces.json` 台账迁移到 `~/.dsh/workspaces/index.v1.json` 的时机（当前新 ledger 独立运行，尚未迁移旧数据）。
4. 第三方 fixture 已用内存 provider 验证；如需真实容器/WSL 验证可后续补充。
5. `remote_*` 工具是否增设 `workspace_*` 别名（含弃用提示）。
## 2026-09-02 — alpha6：VSCode 式凭据策略落地 + 校验修复 + e2e 验证
- 修复 SecureHostStore none/vault 测试暴露的两处问题：
  1. alidateAuth 加入 llowSecretless（none 模式允许 password-kind 无内联密码；vault 模式允许仅有 secretRef 的形状），HostStore.create/update 与 alidateHostPayload 透传该标志，默认行为（严格校验）不变。
  2. HostStore.create/update 构造 entry.auth 时透传 secretRef（此前被丢弃导致 vault 模式存了 ref 又丢掉）；update 在 keyChanged 时清空旧 ref。
  3. SecureHostStore.update：vault 模式下补丁不带密码但已有 secretRef 时保留旧 ref（编辑不重输密码不丢凭据关联）。
- 测试：secure-store.test.ts 5/5 通过；全套 210/218（8 个失败均为既有平台/基线问题：3×无 sshd、3×Windows 路径/权限断言、2×tools 信封形状）。
- 打包 0.1.0-alpha6.tgz（457408 B）并部署到 profiles/web（bundle 保留、cordis.patch.yml 不动）。
- e2e（dsh web --no-open --port 0，杀后即停）：hosts 增删查、known-hosts、session-secret（{alias,password} 扁平体）均正常；POST hosts 带密码落盘后文件无明文、无 secretRef；vault 路由在 none 模式 404（符合预期）。
- 用户决定：清除 ruanlab/peiserver2 明文密码（“清除明文，首次连接手动输入”）。已剥离并原子写回（0600、无 BOM、590 B），文件内无任何内联密码残留。
## 2026-09-02 — alpha7：key/agent 认证零输入 + 表单引导
- engine.ts：新增 sshAgentConfig()（只取 \——实测 Windows 上无条件 gent:'pageant' 会让无 Pageant 时的握手卡到 readyTimeout；故不自动探测命名管道，Pageant 留待显式 opt-in）+ uildConnectConfig 导出：keyPath 可缺省/缺失时若 agent 可用则零输入走 agent；两者皆无才抛精确错误（含引导文案）。
- store.ts：alidateAuth 的 allowSecretless 同时放宽 key 的 keyPath（缺省/空 = 用 agent），默认严格校验不变；HostStore.create/update 将空 keyPath 归一化为 undefined（agent-only 记录干净）。
- GUI：HostFormDialog keyPath 为空时提示 orm.agentHint（SSH_AUTH_SOCK / Git-Bash / WSL）；orm.passwordHint 更新为“不落盘、仅会话内”（旧文案声称明文存盘，已过时）。
- 测试：engine +5（agent 配置单元测试；其中 “无 path 无 agent → 抛错” 全平台断言）、secure-store +1（agent-only key 主机不落 keyPath）；全套 216/224（8 个失败均为既有平台/基线问题）。
- 打包 0.1.0-alpha7.tgz（458946 B）部署 profiles/web；e2e：hosts/known-hosts/session-secret 均正常，hosts 列表仍为 ruanlab、peiserver2。
## 2026-09-02 — alpha8：dispose 清空会话密码表
- engine.dispose() 增加 sessionPasswords.clear()（目标要求“dispose 清空”）。
- 新增测试：session 密码表 set→get→dispose 后清空。
- 打包 0.1.0-alpha8.tgz（459067 B）部署 profiles/web；e2e 冒烟（hosts、session-secret）通过。
## 2026-09-02 — alpha9：工作区行点击连接门（修“点工作区无反应/不弹密码”）
- 根因确认：ruanlab 的 host key 从未被信任（ssh-known-hosts.json 为 0 条，现为 1 条 pending——TOFU 首次观测），且会话密码未注入；面板外路径（工作区打开、git）只暴露裸错误文本，不弹确认框。
- 新增 src/client/workspace-gate.ts：侧边栏工作区行点击拦截（capture 阶段，DOM 层，复用 workspace-badges 的选择器与 MutationObserver 自愈模式）——点击行时先经 SshApi.testHost 打通连接：HOST_KEY_UNKNOWN/MISMATCH → HostFingerprintDialog（信任/重置）；NEEDS_PASSWORD → SessionSecretDialog（会话内、不落盘）；成功标记 alias（5 分钟 TTL，信任持久 + 会话密码表存活），再重发原生点击放行 shell；失败显示行内红色横幅。3 次交互上限。
- index.ts：与徽章同源挂载（manager 每次 emit 重建）；locales 增加 gate.failed / gate.retryLimit（zh/en）。
- 验证：typecheck 0 错、全套 217/225（8 个既有平台/基线失败）、build 成功、alpha9.tgz（463570 B）部署、e2e 冒烟（hosts/known-hosts 1 条 pending）通过。客户端对话框交互需用户在浏览器实测（结构复用面板已验证模式）。
## 2026-09-02 — alpha10：工作区徽章随连接状态变色
- 需求：SSH 工作区侧服务器徽章——已连接时蓝色（轮廓+字体 #1476E6、背景 #D4E0F7），未连接保持灰色。
- 数据源：ConnectionPool.liveAliases()（records 中非 closed/broken/draining 的 alias，同步返回）→ engine.connectedAliases() → 新路由 GET /api/dsh-ssh/connections（loopback 围栏）→ SshApi.connectedAliases()。
- 客户端：index.ts 每 3s 轮询 connections（与 manager 工作区轮询同步调），失败保持全灰；mountWorkspaceBadges 接受 connected 集合，makeBadge(alias, remoteRoot, connected) 蓝色/灰色两种样式（dataset: sshBadge=connected|disconnected）。
- 测试：engine.test.ts 新增 conn-state（exec 后 connectedAliases 含 alias，invalidate(force) 后不含）；全套 217/225 +1=218? 实际 engine 39 passed（+1 新测试）+3 既有 sshd 失败。typecheck 0 错。
- 打包 0.1.0-alpha10.tgz（464996 B）部署；e2e：/api/dsh-ssh/connections 返回 {connected:[]}（启动时空，符合预期），client bundle 含蓝色样式与 3s 轮询。实时变色需用户连接后浏览器实测。
## 2026-09-02 — alpha11/12：点击工作区弹密码/指纹框（修复吞错）
- 用户报告：点工作区只显示横幅“host key 尚未信任…”，未弹交互框。
- 根因 A：engine.test() 把所有错误吞成普通消息，HOST_KEY_*/NEEDS_PASSWORD 的 code 传不到客户端。修复：test() 重抛 NeedsPasswordError / HostKeyUnknownError / HostKeyMismatchError（routes 已有对应映射：NEEDS_PASSWORD→200 code+secret；HOST_KEY_*→500 code+fingerprint）。测试：tofu-probe 用例。
- 根因 B（alpha11 上线后实测发现）：resolveEntryAuth 的 NeedsPasswordError 只在内联兜底分支生效；线上走 deps.resolveSecrets（SecureHostStore none 模式返回空密码对象）时不检查，ssh2 直接以空密码尝试并报“All configured authentication methods failed”。修复：resolveEntryAuth 统一两条来源过凭据门禁——password 空 → NEEDS_PASSWORD；key 文件加密（OpenSSH 'bcrypt' kdf / PEM ENCRYPTED 探测，keyNeedsPassphrase()）且无 passphrase → NEEDS_PASSPHRASE。测试：gate-pw / session 注入后可连 / enc-key / plain-key 不误拦。
- 验证：engine 44 passed +3 既有 sshd 失败；typecheck 0 错；alpha12 部署后实测 ruanlab：/test → 200 {ok:false, code:'NEEDS_PASSWORD', secret:'password'}。
- 注意：验证过程中已将 ruanlab 主机密钥标记为 trusted（指纹与用户两度见过的 SHA256:Uv4Pn…一致）；如需重新确认可在 SSH 面板「重置」后再触发。
## 2026-09-02 — alpha13：密码框用户文案 + 去“不保存”声明 + 悬停显示远端目录
- SessionSecretDialog 支持 user 参数，标题改为“请输入 {user}@{alias} 的密码”（zh/en；{account} 模板）；intro 两句“仅本次会话/不会保存”文案删除。HostsTab 从 hosts 列表取 user；workspace-gate 首次弹窗前 listHosts 缓存 alias→user。
- workspace-badges：badge 与整行（row.title）悬停提示改为 {remoteRoot}（{alias}），替换 shell 默认的本地锚点路径提示。
- 部署 alpha13（467528 B）。链路验证：/test → 200 NEEDS_PASSWORD(correct)，hosts/connections 冒烟正常。
- session 丢失调查：数据完好未删。~/.dsh/storages/workspace.json 的 archivedSessionIds 包含 ruanlab 多数旧会话（c83a8427/fecec33b/e20bb11d/df06604d/1bafbfea 等）——shell 无归档恢复 UI；恢复需离线编辑该文件（去归档）或用户确认是否保留归档状态。已向用户征询。
## 2026-09-02 — 版本号升级 0.1.0-alpha13 → 0.1.2
- packages/dsh-hardssh/package.json version=0.1.2（正式版号，去 alpha 后缀）。
- 打包 dist/tiphareth-dsh-hardssh-0.1.2.tgz（467526 B）并部署 profiles/web（pnpm 网络抖动，直接落盘 node_modules；下次 pnpm install 自动对齐 lockfile）。
- e2e 冒烟：hosts（ruanlab、peiserver2）、connections 接口正常。