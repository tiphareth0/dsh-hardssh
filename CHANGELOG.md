# 更新日志（Changelog）

> 自 v0.1.2 起开始记录；更早的迭代版本见 Git 提交历史。

## v0.1.2-alpha — 2026-09-02（开发线）

面向市场发布准备：npm 仓库关联（`repository`/`homepage`）补全；peer 依赖放宽为全版本
dsh 内核兼容（`@deepseek-ai/dsh-*` → `*`）。功能与 v0.1.2 一致，另含：
README 界面预览与「实现原理（seam 替换）」说明、连接门弹窗可重复唤起修复、
工作区悬停显示远端目录、dsh 原生风格 UI。

## v0.1.2 — 2026-09-02

从 `dsh-sshworkspaces` 元项目拆分为独立插件后的首个版本，适配最新版Deepseek Harness（0.1.2-alpha.3）。

- **拆分独立**：包名 `@tiphareth/dsh-hardssh`，独立 pnpm workspace，独立 `typecheck` / `build` / `test`。
- **更通用的底座**：抽象出通用工作区底座（WorkspaceLedger / WorkspaceProvider / Registry / Router / WFS 切换），本地与远程工作区统一接入，便于其他插件复用。
- **新增安全措施**：
  - VSCode Remote-SSH 式凭据策略（`secretStorage`：默认 `none` 密码不落盘，可选 `vault` 加密存储）；
  - 会话级密码表（连接 / 浏览目录时弹窗输入一次，会话内复用，进程退出即清空）；
  - 主机密钥 TOFU + 指纹确认框（防中间人）。
- **UI 优化**：SSH 面板与工作区管理器（主机增删改查、连接状态徽章、点击连接门、远端目录悬停提示、DeepSeek 风格视觉、弹窗自适应高度）。