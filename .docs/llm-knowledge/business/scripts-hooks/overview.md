# Scripts-Hooks 模块 — 钩子脚本

## 职责

在 Agent 生命周期关键节点执行的钩子，强制约束（产出物、dev-pass、状态文件、trace）。

## 文件清单

| 文件 | 职责 |
|------|------|
| enforce-artifact.js | 校验 Agent 是否产出必需文件 |
| enforce-dev-pass.js | 校验 dev-pass 权限 |
| enforce-state-file.js | 保护状态文件不被 Agent 篡改 |
| session-start.js | 会话启动钩子（注入上下文） |
| session-stop.js | 会话结束钩子 |
| trace-command.js | 命令执行 trace 记录 |

## 关键机制

- 钩子通过 hooks.json 注册，绑定到 Agent 生命周期事件
- enforce-* 类钩子拦截不合规操作（如 Agent 修改 e2e-state.json）
