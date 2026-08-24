---
name: harness-conductor
description: >
  Harness 工作流编排器 — 调度 Agent、管理 Phase 推进、错误恢复决策。
  当用户使用 /harness 命令时自动加载。包含 Agent prompt 编写规范、
  常见失败模式对策、组件边界声明模板。
---

# Harness Conductor — 工作流编排器

> **渐进式披露**：本文档只保留每次循环必用的**骨架**（核心原则、执行流程、Phase→Agent 对照、铁律）。
> 条件性内容（错误恢复 / 代码检索 / 工作流生命周期 / Prompt 单一信源）已外移到 `references/`，
> 用到时按需 `read_file` 读取，避免常驻 context 浪费。

## 核心原则

> **AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**

三层职责边界，不可越界：

```
┌─ dispatch.js      = 读状态 + 说下一步   （只读，零写权限）      ─┐
│  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）   │
└─ 主 Agent         = 触发                （无判断权，机械执行）  ─┘
```

**触发权 ≠ 决定权**：命令由主 Agent 敲，但是否合法由 `advance-phase.js` 独立裁定。
主 Agent 传错 targetPhase（越界／跨阶／倒退）会被脚本拒绝，不会写坏状态。

## 执行流程

每个循环只有三步。**主 Agent 不读状态、不做判断、不拼 prompt。**

```
Step 1: 执行 node ${HARNESS}/dispatch.js <storyId>
        → 输出纯 JSON，含 status / nextAgent / agentPrompt / advanceCommand

Step 2: 按 status 分支（四态互斥且穷尽，无「其他情况自行处理」）

  ┌ ready     → 若 readyToAdvance=true: 先执行 advanceCommand，再回 Step 1
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入，不加工）
  ├ fix_loop  → 执行 recovery.command
  ├ blocked   → 按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束（未创建／已完成／已归档），按 recovery 提示收尾

Step 3: 子 Agent 汇报产出物路径 → 回到 Step 1
```

如有 `warnings` → 转述给用户确认，但不因此改变分支。

**主 Agent 禁止的行为**:
- 🚫 禁止直接读取 e2e-state.json（由 dispatch.js 读取）
- 🚫 禁止自行判断当前 Phase 和下一步该调谁（由 dispatch.js 查表）
- 🚫 禁止自行处理异常恢复（由 dispatch.js 输出 recovery）
- 🚫 禁止自行拼接或改写 `agentPrompt`（它已完整，无占位符）
- ✅ 主 Agent 只做两件机械动作: Spawn 指定的 Agent、执行给定的命令

## 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

## Phase → Agent 对照（仅供阅读，不作为执行依据）

> ⚠️ 这张表是**给人看的**。运行时的权威来源是 `scripts/lib/state.js` 的 `PHASE_AGENTS`，
> 由 `dispatch.js` 查表后以 `nextAgent` 字段输出。主 Agent 用 `nextAgent`，不查这张表。

| 当前 | Agent（注册名） | 产出物 |
|------|-------|--------|
| 0 | 需求分析师 `requirement-analyst` | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` |
| 1 | 任务规划师 `task-planner` | `task-dag.md` `task-dag.json` |
| 2 | 前端开发工程师 `frontend-developer` | 代码变更（git diff） |
| 3 | 代码审查师 `code-reviewer` | `code-review.json` |
| 4 | 测试工程师 `test-engineer` | `test-report.md` `acceptance-verification.json` |
| 5 | 发布助手 `release-assistant` | git commit + push |
| 6 | 发布助手 `release-assistant` | 知识库更新 |
| 7 | 发布助手 `release-assistant` | 部署 URL + 构建号 |
| 8 | —（终态，无 Agent） | 流程结束 |

**Spawn 时必须用注册名**（表中反引号内的英文，即 agent frontmatter 的 `name` 字段）。
Agent 文件名和正文标题是中文，但注册键是英文 `name`——传中文名无法解析到 Agent。
`dispatch.js` 的 `nextAgent` 已是注册名，直接使用即可。

**推进命令不要手写**：从 `dispatch.js` 的 `advanceCommand` 字段取，它已算好 `targetPhase`。

## 铁律

- 🚫 AI 不直接写/改 `e2e-state.json`
- 🚫 AI 不直接写/改 `dev-pass.json`
- 🚫 AI 不跳过 Phase
- 🚫 AI 不自标记 `open-questions.json` resolved

---

## 按需读取的资源（渐进式披露）

| 场景 | 读取文件 |
|------|---------|
| advance-phase 推进失败 | `references/错误恢复.md` |
| 需要查找/定位代码 | `references/代码检索规范.md` |
| 激活/查看/归档/复档工作流 | `references/工作流生命周期.md` |
| 理解为何不能加工 prompt | `references/Agent-Prompt-单一信源.md` |
