---
description: 激活 / 关闭 Harness Engineering 端到端工作流，控制 src/ 编辑权限与 8 Phase 流程编排
category: workflow
allowed-tools: Bash, Write
---

# /harness — Harness Engineering 端到端工作流

> **核心原则：AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**
>
> **操作手册：AI 在执行前必须先调用 `use_skill("harness-conductor")` 加载编排器 skill，其中包含 Agent prompt 编写规范、常见失败模式对策、组件边界声明模板。**

---

## AI 执行协议 (MUST FOLLOW)

你是一个 Harness 工作流的主控 Agent。你的职责是 **调度 Agent 产出物 + 执行脚本推进 Phase**，而不是自己写状态文件。

### 必须加载的 Skill

在执行任何 Phase 操作前，先调用以下 skill：

```
use_skill("harness-conductor")
```

### 脚本路径约定

```bash
HARNESS=${CODEBUDDY_PLUGIN_ROOT}/scripts/commands
```

以下所有脚本路径均基于此目录。**始终使用完整路径** `node ${CODEBUDDY_PLUGIN_ROOT}/scripts/commands/<脚本名>`。

### 每 Phase 执行循环（0→8 统一模式）

```
┌──────────────────────────────────────────────┐
│  1. Spawn 对应当前 Phase 的 Agent             │
│  2. 等待 Agent 产出对应 Phase 的产出物          │
│  3. 运行 advance-phase.js 推进到下一 Phase    │
│     ├── success: true → 进入下一 Phase（回到1）│
│     └── success: false → 进入错误恢复流程       │
└──────────────────────────────────────────────┘
```

### Phase → Agent → 推进脚本 → 下一 Phase 对照表

| 当前 | Spawn 的 Agent | Agent 产出物 | 推进命令 |
|------|---------------|-------------|---------|
| 0 | 需求分析师 | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` | `node $HARNESS/advance-phase.js <storyId> 1` |
| 1 | 任务规划师 | `task-dag.md` `task-dag.json` | `node $HARNESS/advance-phase.js <storyId> 2` |
| 2 | 前端开发工程师 | 代码变更（git diff） | `node $HARNESS/advance-phase.js <storyId> 3 [--lint-fix]` |
| 3 | 代码审查师 | `code-review.md` | `node $HARNESS/advance-phase.js <storyId> 4` |
| 4 | 测试工程师 | `test-report.md` `acceptance-verification.json` | `node $HARNESS/advance-phase.js <storyId> 5` |
| 5 | 发布助手 | git commit + push + MR | `node $HARNESS/advance-phase.js <storyId> 6` |
| 6 | 发布助手 | 知识库文档更新 | `node $HARNESS/advance-phase.js <storyId> 7` |
| 7 | 发布助手 | 部署 URL + 构建号 | `node $HARNESS/advance-phase.js <storyId> 8` |

> Phase 2 入口时 advance-phase.js 会自动签发 dev-pass；Phase 2→3 时自动撤销。

### advance-phase.js 输出解读

脚本输出为 JSON，AI 必须根据 `success` 字段分叉处理：

**success: true 时**：
```json
{
  "success": true,
  "storyId": "...",
  "fromPhase": 2, "toPhase": 3,
  "gateChecks": { "passed": true },
  "phaseSummaryContent": "...",       // ← 注入给下一个 Agent
  "contractFilesToLoad": ["..."],     // ← 告诉下一个 Agent 先读这些文件
  "lessonsFromHistory": "...",        // ← 注入给下一个 Agent（如有）
  "fixLoopContext": { "active": true, ... }  // ← 仅 Phase 2→3 修复回路复查时出现
}
```
**AI 动作**：读取 `contractFilesToLoad` 中的文件，将其内容 + `phaseSummaryContent` + `lessonsFromHistory` 注入到下一个 Agent 的 prompt 中。如有 `fixLoopContext.active`，额外注入修复上下文。

**success: false 时**：
```json
{
  "success": false,
  "gatePassed": false,
  "nextAction": {
    "action": "run_fix_loop",            // 或 "retry_with_auto_fix" / "manual_fix"
    "command": "advance-phase.js ...",  // 可直接执行的命令
    "description": "..."
  },
  "fixLoopAvailable": true,
  "blockers": ["..."],
  "structuredBlockers": [{ "type": "...", "message": "...", "level": 2 }]
}
```
**AI 动作**：读取 `nextAction.action`，执行对应恢复流程（见下节）。

---

## 错误恢复决策树

```
advance-phase 返回 success: false
│
├── nextAction.action === "run_fix_loop"
│   → 执行 nextAction.command（即 advance-phase.js <storyId> 2 --fix-loop）
│   → 该脚本输出 spawnPrompt → 将其注入给前端开发工程师 Agent
│   → 开发者修复完成后 → 重新执行 advance-phase.js <storyId> 3
│
├── nextAction.action === "retry_with_auto_fix"
│   → 执行 nextAction.command（即加 --auto-fix 重试）
│   → 自动修复格式类问题后重新门控
│
└── nextAction.action === "manual_fix"
    → 输出 structuredBlockers 给用户
    → 等待用户手动处理后重新推进
```

**fix-loop 完整流程**（当审查/测试失败时由 advance-phase.js --fix-loop 自动编排）：

```
1. 脚本自动从 code-review.md / acceptance-verification.json 提取 BLOCKER
2. 自动回退到 Phase 2，重新签发限域 dev-pass（仅 affectedFiles）
3. 生成 fix-request.json + fix-context.md
4. 输出 spawnPrompt（包含待修复问题清单 + 约束 + 产出要求）
   → AI 将其注入前端开发工程师 Agent prompt
5. 开发者修复完成 → AI 执行 advance-phase.js <storyId> 3
   → 脚本自动注入 fixLoopContext 给代码审查师（增量审查）
```

> 默认最大 2 轮 fix-loop，超出 → `nextAction.action === "human_intervention_required"`

---

## 工作流生命周期命令

```bash
# 激活工作流（开始一个新 Story）
/harness start <storyId> "<标题>"
#   → 实际执行: node $HARNESS/harness-workflow.js start <storyId> "<标题>"
#   → 内部调用 create-workflow.js 创建 e2e-state.json
#   → 初始 Phase = 0

# 查看当前状态
/harness status
#   → 实际执行: node $HARNESS/harness-workflow.js status

# 关闭 Harness 模式
/harness end
#   → 实际执行: node $HARNESS/harness-workflow.js end
```

---

## 铁律 (MUST NOT)

| 禁止行为 | 原因 | 正确做法 |
|---------|------|---------|
| 🚫 AI 直接写/改 `e2e-state.json` | 状态机唯一信源，必须由脚本维护 | 始终用 `advance-phase.js` 推进 Phase |
| 🚫 AI 直接写/改 `dev-pass.json` | 通行证由脚本签发/撤销 | 脚本在 Phase 1→2 自动签发，Phase 2→3 自动撤销 |
| 🚫 AI 自行将 `open-questions.json` 中 `resolved` 设为 `true` | 待确认项必须由用户确认 | 提示用户在 open-questions.json 中手动标记 |
| 🚫 AI 跳过 Phase 直接进入开发 | 门控校验依赖前置产出物 | 逐 Phase 推进，确保每个 Phase 产出物完整 |
| 🚫 AI 在 Phase≠2 时编辑 `src/` | Hook 守卫会直接拒绝 | 先确认当前 Phase=2 且有有效 dev-pass |
| 🚫 AI 在归档后执行 `--rollback` / `--fix-loop` | 归档守卫拦截 | 先执行 `restore` 复档 |

---

## dev-pass 生命周期（AI 无需手动管理）

dev-pass 完全由 `advance-phase.js` 自动管理，AI 无需关心签发/撤销时机：

```
Phase 1→2: 脚本自动签发（限域到 task-dag.json 的 files[]）
Phase 2→3: 脚本自动撤销（主撤销点）
Phase 4→5: 脚本自动兜底撤销（防止 fix-loop 残留，幂等操作）
```

AI 只需要在 Phase 2 时 Spawn 前端开发工程师，脚本会确保 dev-pass 在正确的时间存在/消失。

| 操作 | 命令 | 场景 |
|------|------|------|
| 手动续签 | `node $HARNESS/advance-phase.js <storyId> 2 --renew-pass` | 开发超过 2h，dev-pass 过期 |
| fix-loop 重新签发 | 自动（`--fix-loop` 内部处理） | 审查/测试失败回退开发 |

---

## 附录 A：8 Phase 流水线详情（参考）

| P | 名称 | Agent | 产出物 | 门控要点 |
|---|------|-------|--------|---------|
| 0 | 需求分析 | 需求分析师 | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` | AC criteria 非空；open-questions 全 resolved。Agent 内部需调用 `use_skill("kb-query")` 检索项目知识库 |
| 1 | 任务规划 | 任务规划师 | `task-dag.md` `task-dag.json` | AC↔Task 交叉引用完整；推进时自动签发 dev-pass |
| 2 | 代码开发 | 前端开发工程师 | 代码变更 | ESLint 0 error；推进时撤销 dev-pass |
| 3 | 代码审查 | 代码审查师 | `code-review.md` | 无未修复 BLOCKER |
| 4 | 功能测试 | 测试工程师 | `test-report.md` `acceptance-verification.json` | failed=0；推进时兜底撤销 dev-pass |
| 5 | Git 提交 | 发布助手 | commit + push + MR | 禁止 --no-verify |
| 6 | 知识库更新 | 发布助手 | meta.yaml 刷新 | `use_skill("kb-update")` 调用成功（保留手工批注） |
| 7 | 云端部署 | 发布助手 | 部署 URL + 构建号 | devops 构建+发布成功 |

> 有 Figma 时 Phase 0 额外产出 `figma-frame-inventory.json`，Phase 1 额外产出 `figma-component-map.md`
> 每个 Phase 完成后 `advance-phase.js` 自动生成 `phase-N-summary.md`

## 附录 B：契约文件格式（参考）

**acceptance-criteria.json** (Phase 0，需求分析师产出):
```json
{ "criteria": [{ "id": "AC-1", "description": "...", "testType": "ui|api|integration" }] }
```

**task-dag.json** (Phase 1，任务规划师产出):
```json
{
  "tasks": [{
    "id": "task-1",
    "title": "...",                              // MUST: title 而非 name
    "files": ["src/store/config.js"],             // 用于 dev-pass 限域 + 影响范围
    "acceptanceCriteria": ["AC-1"],               // MUST: 非空，关联验收标准
    "figmaLink": ["https://www.figma.com/..."],   // UI 任务必填，非 UI 任务为 null
    "parallelizable": true,
    "project": "userlive",                        // 可选，跨项目时必填
    "repoPath": "D:/workfile/userlive"            // 可选，跨项目时必填（绝对路径）
  }]
}
```

**acceptance-verification.json** (Phase 4，测试工程师产出):
```json
{
  "results": [{ "id": "AC-1", "status": "passed|failed|unverifiable", "evidence": ["截图/日志"] }],
  "summary": { "total": 10, "passed": 10, "failed": 0, "unverifiable": 0 }
}
```

## 附录 C：Hook 守卫（自动运行，AI 无需干预）

| Hook | 触发时机 | 作用 |
|------|---------|------|
| `enforce-no-direct-code-edit.cjs` | 每次文件 write/replace | dev-pass 有效性 + 路径限域 + Phase 校验 |
| `enforce-artifact-before-phase.cjs` | 同上 | Phase 0-1 产出物存在性确认 |
| `session-start.cjs` | 对话启动 | 断点恢复 + 加载 summary + 注入经验 + 契约清单 |

## 附录 D：文件目录结构（参考）

```
<PROJECT_ROOT>/.codebuddy/plans/<storyId>/
├── e2e-state.json          # 工作流状态（phase 唯一信源，脚本维护）
├── repos.json              # 仓库注册表（story 级独立）
├── trace.jsonl             # 全链路审计
├── dev-pass.json           # 开发通行证（仅 Phase 2 存在，脚本自动管理）
├── phase-N-summary.md      # Phase 上下文摘要（脚本自动生成）
├── archive/                # 归档目录
│   ├── round-{N}/          #   终态归档（详见 /harness archive）
│   └── *.archived          #   --rollback / --fix-loop 归档
└── ...                     # 各 Phase 产出物
```

## 附录 E：脚本速查（参考）

> 根路径：`${CODEBUDDY_PLUGIN_ROOT}/scripts/`

### commands/ — 工作流命令脚本（AI 直接调用）

| 脚本 | 用途 |
|------|------|
| `commands/harness-workflow.js` | 工作流生命周期：`start` 激活 / `end` 关闭 / `status` 查看状态 |
| `commands/create-workflow.js` | 创建 e2e-state.json（被 harness-workflow.js start 内部调用） |
| `commands/advance-phase.js` | Phase 状态机推进 + dev-pass 生命周期 + 门控校验 + 修复回路 |
| `commands/archive-story.js` | Story 归档 / 复档 / 列表 / 状态 |

### services/ — 服务层脚本（被 advance-phase.js 内部调用，AI 不直接调）

| 脚本 | 用途 |
|------|------|
| `services/policy.js` | 风险门控层：产出物校验 + 契约一致性检查 + 结构化 blocker 输出 |
| `services/experience.js` | 经验沉淀飞轮：记录失败模式 + 向 Agent prompt 注入历史教训 |
| `services/context-refresh.js` | 上下文刷新：每个 Phase 完成后生成 phase-N-summary.md |
| `services/validate-contracts.js` | 契约文件校验：检查 AC/task-dag/verification 等契约文件完整性 |
| `services/validate-phase-gate.js` | Phase 门控预检：推进前校验前置产出物是否满足门控条件 |

### lib/ — 基础库（被各脚本引用，AI 不直接调）

| 脚本 | 用途 |
|------|------|
| `lib/state.js` | 状态文件读写：e2e-state.json / dev-pass.json 的 CRUD 操作 |
| `lib/trace.js` | 全链路 trace 记录：写 trace.jsonl 供调试/审计/经验沉淀 |

### hooks/ — Hook 守卫（自动运行，AI 无需干预）

| 脚本 | 用途 |
|------|------|
| `hooks/enforce-dev-pass.js` | PreToolUse Hook：src/ 编辑保护，校验 dev-pass 有效性 + 路径限域 |
| `hooks/enforce-artifact.js` | PreToolUse Hook：防跳 Phase，检查前置产出物是否存在 |
| `hooks/session-start.js` | SessionStart Hook：断点恢复 + 加载 summary + 注入经验教训 |
| `hooks/session-stop.js` | SessionStop Hook：清理过期 dev-pass + 沉淀 Hook 拒绝事件到经验库 |
| `hooks/trace-command.js` | PostToolUse Hook：命令执行后自动记录 trace.jsonl |

### audit/ — 审计工具（按需手动执行）

| 脚本 | 用途 |
|------|------|
| `audit/harness-audit.js` | 工作流健康审计：检查 settings.json / e2e-state / 产出物完整性 |
| `audit/check-prototype-doc.js` | 原型文档检查：create-workflow 前置校验 prototype-analysis.md 存在性 |
| `audit/metrics-aggregator.js` | 指标聚合：工作流统计数据汇总 |
