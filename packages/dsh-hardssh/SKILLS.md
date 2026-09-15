# SKILLS — 把任意 DSH 插件适配到 SSH 工作区

> 写给 agent 的执行手册。目标：用**最少的接口替换**，让一个插件在 SSH 工作区及其 session 下正常工作。
> 底座包：`@tiphareth/dsh-hardssh`（本包）。参考实现：`src/client/session-connect-gate.ts`、`src/client/ssh/session-target.ts`、`src/providers/ssh/provider.ts`。

## 0. 先判断属于哪一类（决定要不要改）

| 插件的做法 | 结论 |
|---|---|
| 通过 `ctx.fs` / `ctx.subprocess`（DSH 标准服务）或标准工具（read / write / edit / bash / pwsh…）访问文件与进程 | **0 改动**。seam 已被替换，路由自动生效 |
| 依赖 **glob / grep** 做检索 | **0 改动**（0.2.5 起）。它们走 `dsh-tool-fs-search` 打包的 ripgrep，spawn 会被 subprocess seam 交给绑定的主机：宿主机有 rg 就跑同一条 argv，否则由搜索阶梯代答并投影成 rg 的输出形状。需要正则/显式预算时仍可用 `remote_search`，列目录用 `remote_ls` |
| 直接 `import 'node:fs'` / `node:child_process`，或自建「本地/远端」状态、自建 workspace 句柄 | 需要改接口，按第 1～3 节替换 |

判定命令（在插件源码根执行）：

```sh
rg -n "node:fs|node:child_process|from 'fs'|from 'child_process'|spawn\(|execFile\(" src
rg -n "remote|isRemote|mode\s*[:=].*local" src
```

命中即按对应小节替换。

## 1. 文件 / 进程：改用底座已替换的 seam

**把** 直接的 Node 文件与进程调用 **改为** DSH 标准服务：

| 现在 | 改为 | 导入 |
|---|---|---|
| `node:fs`、`node:fs/promises` | `ctx.fs`（`FileSystem`） | `@deepseek-ai/dsh-fs` |
| `node:child_process`、`spawn`、`exec` | `ctx.subprocess`（`SubprocessRuntime`） | `@deepseek-ai/dsh-subprocess` |

改完后 **不需要**任何 SSH / 远端分支：`dsh-hardssh` 已通过 `cordis.patch.yml` 把这两个 seam 替换为路由门面，按 session 的 cwd 决定本机还是远端。

```ts
// before
import { readFile } from 'node:fs/promises'
const text = await readFile(target, 'utf8')

// after —— ctx.fs 是 DSH FileSystem：先 resolve 得到 FsTarget，再读写
const file = await ctx.fs.resolve(target)      // 远端会话自动解析到远端
const text = await ctx.fs.readText(file)
await ctx.fs.writeText(file, next)

// before
import { execFile } from 'node:child_process'

// after —— ctx.subprocess 是 DSH SubprocessRuntime：spawn 同步返回句柄，done 给结果
const handle = ctx.subprocess.spawn({ argv: ['bash', '-lc', cmd], cwd })
const outcome = await handle.done
```

## 2. 工作区身份：改用 `workspaceCore`，不要自建映射

**把** 插件自己的「路径 → 远端 / 模式」映射与自建 workspace 句柄 **改为** 通用底座的查询接口：

| 现在 | 改为 | 位置 |
|---|---|---|
| 自己维护 path→远端映射 | `ctx.workspaceCore.findByAnchor(path)` / `openByAnchor(path)` | 底座公开面 |
| 需要「这个 cwd 属于哪个工作区」的连接 | `ctx.workspaceCore.openByAnchor(cwd)` → `WorkspaceConnection` | 同上 |
| 自己的 workspace 句柄类型 | `WorkspaceCore` / `WorkspaceConnection` / `WorkspaceRecord` | `@tiphareth/dsh-hardssh/workspace` |
| 自己实现的文件/进程能力契约 | `connection.get('workspace.fs' \| 'workspace.process' \| 'workspace.search')` | 同上 |

```ts
export const inject = ['workspaceCore']            // 声明依赖

const record = await ctx.workspaceCore.findByAnchor(cwd)   // 未命中 → 本地
if (record !== undefined) {
  const connection = await ctx.workspaceCore.openByAnchor(cwd)
  const remoteRoot = record.location.root                  // 远端根
  const fs = connection?.get('workspace.fs')               // DSH FileSystem
}
```

要点：

- `findByAnchor` / `openByAnchor` 会先等待运行时就绪，是**首选**读写路径。
- 已经持有连接时，用 `record.id` 走 `openById(record.id)` 复用同一条连接，不要重新按路径解析。
- 需要在渲染热路径上做**同步**判断时，底座内部用的是 `core.router.fromAnchor(cwd)`（seam 门面即如此）。
  该属性在 `WorkspaceCore` 上标注为**内部兼容面**（`@deprecated`），插件应优先用异步高阶层；
  确实需要同步判定（例如渲染期不能 await）才使用它，并集中封装在一个适配函数里。
- 未就绪或未命中时**不要**猜测：未命中即当本地处理；锚点目录下未注册的路径应 fail closed。
- `WorkspaceRecord.provider.id` 是 provider 类型（`ssh` / `local` / …），用它做能力判断，**不要**用 alias 当身份。
- SSH 工作区的服务器别名在 `record.provider.connectionRef.id`（`alias` 只是展示用）；远端根在 `record.location.root`。

## 3. 注册新 provider（只有要接新后端时才做）

**把** 自建的后端注册 **改为** 底座的 provider 契约：

```ts
const provider: WorkspaceProvider = {
  manifest: {
    id: 'docker', version: '1.0.0',
    apiVersion: WORKSPACE_PROVIDER_API_VERSION,   // 当前 = 2
    displayName: 'Docker',
    capabilities: ['workspace.fs', 'workspace.process', 'workspace.search'],
  },
  validate(record) { /* 校验 root / ref 可解析，不碰网络 */ },
  async open(record, context) { /* 返回 WorkspaceConnection：get()/status()/close() */ },
}

const dispose = ctx.workspaceCore.registerProvider(provider)
```

`get()` 的返回值必须直接用 DSH 官方类型（`FileSystem` / `SubprocessRuntime`）或底座能力类型（`WorkspaceSearchService`），这样所有消费方无需分支。

## 4. 客户端（浏览器侧）：按 session 取远端身份

**把** 自建的「当前是否远端 / 当前连哪台」状态 **改为** 从公开的 session 列表 + 工作区快照推导：

| 现在 | 改为 |
|---|---|
| 全局的 local/remote 开关 | `ctx.sessions.list.getSnapshot()` 的 `current` + `byId[id].cwd` |
| 自建的 alias / 远端选择器 | 最长匹配的 workspace anchor → `workspace.alias` / `workspace.remoteRoot` |
| 各自轮询工作区列表 | 共享一个 `WorkspaceManager` 快照（订阅即可，不要二次拉取） |

参考实现（照抄这两个文件即可）：

- `src/client/session-connect-gate.ts` — `SessionGateList` 适配层 + `makeAnchorWorkspaceResolver()`（最长锚点匹配、Windows 大小写折叠）+ 打开会话时探测服务器。
- `src/client/ssh/session-target.ts` — `createSessionSshTargetSource()`：`Session → 固定远端目标` 的可订阅数据源（`useSyncExternalStore` 友好，快照引用稳定）。

约定：

- 面板 / Tab 的目标**跟随 session**，不要在面板里放服务器下拉框（切换服务器 = 切换 session）。
- session 未绑定工作区时，渲染明确的不可用状态（例如模糊蒙版），不要静默失败或回退到本机操作。

## 5. 自检清单

1. `rg "node:fs|node:child_process" src` 无生产命中（测试除外）。
2. 不再存在自建的 path→远端映射或 local/remote 全局状态。
3. 所有工作区查询都经 `ctx.workspaceCore`；provider 身份判断用 `record.provider.id`。
4. 在 SSH 工作区 session 中执行插件核心功能 → 落在远端（用 `remote_*` 工具或远端 `pwd` 复核）。
5. 在本地 session 中执行同一功能 → 行为与改造前一致。
6. 单元测试里用假 `WorkspaceCore` 注入即可，无需真实 SSH。

## 6. 不要做

- 不要在插件里直接建 SSH 连接 —— 连接、凭据、TOFU 都由底座的引擎统一管理。
- 不要缓存 `WorkspaceRecord` 当作长期身份 —— 用 `id` + `findByAnchor()` 重新解析。
- 不要用本机 `realpath` 解析远端路径 —— 交给 `workspace.fs` capability。
- 不要假设锚点目录存在或可写 —— 它只是 session cwd 的占位锚点。
