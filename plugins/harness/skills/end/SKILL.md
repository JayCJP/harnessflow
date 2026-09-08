---
name: end
description: >
  结束 / 取消当前 Harness 工作流的激活状态。当用户想退出一个正在进行的 harness 会话、
  解除 src/ 编辑的 dev-pass 限制、不再推进某个 Story（说「结束 / 退出 / end / 停止 harness」）
  时使用。注意：这与归档（archive）不同 —— end 只删除激活标记，不移动 Story 文件。
  归档请使用 /harness-archive。
---

# /end — 结束 Harness 工作流激活

> **结束 ≠ 归档**：
> - `end`（本 skill）= 删除 `.codebuddy/plans/.harness-active` 标记，解除 src/ 编辑的 dev-pass 限制。
> - `archive`（`/harness-archive`）= 将 Story 文件移到 `archive/round-N/`，是另一功能。
>
> 通常顺序：先归档（如需保留产物），再 `/end`。

## 触发时机

用户明确要**退出当前 harness 工作流**（结束激活、放开 src/ 编辑）时使用，例如：
- 「结束 / 退出 / end / 停止 harness」
- 工作流已完成或已归档，不再需要 dev-pass 保护

## 脚本

```bash
# 脚本路径：${CLAUDE_PLUGIN_ROOT}/scripts/commands
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js end
```

> 对应 `harness-workflow.js` 的 `end` 子命令（`cmdEnd`），**幂等**，可安全重复调用。

## 行为

| 场景 | 输出 | 退出码 |
|------|------|--------|
| 未激活（无 `.harness-active`） | `ℹ️ Harness 模式未激活，无需关闭` | 0 |
| 已激活 | 删除标记文件，输出 `✅ Harness 模式已关闭` | 0 |

## 执行流程

1. 执行上方脚本命令，读取返回 JSON。
2. 若返回 `ok: true` 且含 `message`，向用户转述结果。
3. 结束前**建议先确认**当前 Story 已完成 / 已归档；如需保留产物，先走 `/harness-archive archive` 再 `/end`。

## 边界与安全

- `end` 只删 `.harness-active` 标记，**不移动 / 不删除任何 Story 文件**。
- 结束会解除 src/ 编辑的 dev-pass 保护，仅应在确认收尾后执行。
- 与 `start`（`/start`）成对：`/start` 激活，`/end` 结束。
