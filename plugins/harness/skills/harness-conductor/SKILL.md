---
name: harness-conductor
description: >
  Harness 工作流编排器 — 调度 Agent、管理 Phase 推进、错误恢复决策。
  当用户使用 /harness 命令时自动加载。包含 Agent prompt 编写规范、
  常见失败模式对策、组件边界声明模板。
---

# Harness Conductor — 工作流编排器

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

## 工作流生命周期

```bash
# 激活工作流
node ${HARNESS}/harness-workflow.js start <storyId> "<标题>"

# 查看状态
node ${HARNESS}/harness-workflow.js status

# 归档
node ${HARNESS}/archive-story.js <storyId> archive [--force]

# 复档
node ${HARNESS}/archive-story.js <storyId> restore [--round N] [--force]
```

## 错误恢复

**不需要决策树。** `advance-phase.js` 返回 `success: false` 时，输出中已带 `recovery.command`，
主 Agent 执行它，然后回到 Step 1 重新 `dispatch.js`。

```
advance-phase.js 失败
  ├─ recovery.command 存在 → 原样执行 → 回 Step 1
  └─ recovery.command 为 null → 转人工，转述 recovery.description 给用户
```

恢复策略（fix-loop / --auto-fix 重试 / 转人工）由 `policy.js` 按 `recovery level` 判定：
1=自动修复、2=提示修复、3=降级、4=人工。主 Agent 不参与选择。

## Agent Prompt 单一信源

`agentPrompt` 由 `prompt-builder.js` 统一生成，**只有一个出口**: `dispatch.js` 输出的 `agentPrompt` 字段。
它已包含 Story ID、当前 Phase、上一 Phase 摘要、契约文件内容、历史教训、约束条款、产出物清单，
**无占位符，可直接原样注入**。

```
node ${HARNESS}/dispatch.js <storyId>
  └─ agentPrompt      ← 原样传给 Spawn 的 prompt 参数
     nextAgent        ← 传给 Spawn 的 Agent 注册名
     expectedOutputs  ← 本 Phase 应产出的文件（用于校验子 Agent 汇报）
```

**为什么不允许主 Agent 加工 prompt**: 一旦主 Agent 参与拼接，注入哪些上下文就变成一次自由裁量，
不同轮次注入的内容会不一致，Phase 2 的 `files[]` 写入范围也可能被漏掉——这是流程不可控的直接来源。
prompt 内容需要调整时，改 `prompt-builder.js`，不改主 Agent 行为。

## 代码检索规范（查找代码时强制）

> 编排过程中需要查找/定位代码（Spawn 子 Agent、撰写上下文、判断改动范围）时，**必须使用双源交叉验证**，
> 不要只依赖单一检索方式（如仅 Explore agent 或仅文本搜索）。

**标准流程**:
1. **kb-query** — 业务语义层：按功能模块/接口名检索，拿业务语义、候选文件、历史踩坑
2. **graphify** — 结构层：`query "<关键词>"` 拿结构视图，`explain "<模块>"` 理解职责，`path "<API>" "<渲染出口>"` 追调用链
3. 双源交叉验证收敛（规则见 kb-query skill「双源交叉验证」章节）
4. `search_content` / `search_file` 兜底：仅当两路都没定位到文件时使用

**禁止**:
- 🚫 仅用 Explore agent 或仅文本搜索定位代码
- 🚫 跳过 kb-query / graphify 直接猜文件路径

## 铁律

- 🚫 AI 不直接写/改 `e2e-state.json`
- 🚫 AI 不直接写/改 `dev-pass.json`
- 🚫 AI 不跳过 Phase
- 🚫 AI 不自标记 `open-questions.json` resolved
