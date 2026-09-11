# SKILLS

插件适配手册（写给 agent）：**[packages/dsh-hardssh/SKILLS.md](./packages/dsh-hardssh/SKILLS.md)**

用途：让任意 DSH 插件通过最少的接口替换，适配 SSH 工作区及其 session。
包含判定命令、接口对照表（`node:fs` → `ctx.fs`、自建映射 → `workspaceCore`、自建句柄 → `WorkspaceConnection` 等）、
可照抄代码片段与自检清单。
