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
>
> **🆕 主 Agent 使用 dispatcher 模式: 不读状态、不做决策、只照 dispatcher 指令执行。**

## dispatcher 模式执行流程（新）

主 Agent 在每个 Phase 推进循环中执行以下步骤：

```
Step 1: Spawn dispatcher Agent
        → 输入: Story ID
        → dispatcher 读取 e2e-state.json → 按 Phase→Agent 映射表输出调度指令

Step 2: 读取 dispatcher 输出的 JSON 指令
        → 提取: nextAgent / instruction / inputFiles / advanceCommand / warnings

Step 3: 如有 warnings → 提醒用户确认

Step 4: 如有 recovery → 按 recovery.command 执行（如 fix-loop）

Step 5: Spawn nextAgent（注入 instruction + inputFiles 文件内容）
        → 使用 advance-phase.js 输出的 suggestedAgentPrompt 作为 prompt 模板

Step 6: Agent 完成 → 汇报产出物路径

Step 7: 执行 advanceCommand（advance-phase.js 推进 Phase）

Step 8: 回到 Step 1（dispatcher 根据新 phase 输出下一步）
```

**主 Agent 禁止的行为**:
- 🚫 禁止直接读取 e2e-state.json（由 dispatcher 读取）
- 🚫 禁止自行判断当前 Phase 和下一步该调谁（由 dispatcher 决策）
- 🚫 禁止自行处理异常恢复（由 dispatcher 输出 recovery 指令）
- ✅ 主 Agent 只做一件事: 按 dispatcher 指令执行

## 脚本路径约定

```bash
HARNESS=${CODEBUDDY_PLUGIN_ROOT}/scripts/commands
```

## Phase → Agent → 推进命令对照

| 当前 | Agent | 产出物 | 推进命令 |
|------|-------|--------|---------|
| 0 | 需求分析师 | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` | `node ${HARNESS}/advance-phase.js <storyId> 1` |
| 1 | 任务规划师 | `task-dag.md` `task-dag.json` | `node ${HARNESS}/advance-phase.js <storyId> 2` |
| 2 | 前端开发工程师 | 代码变更（git diff） | `node ${HARNESS}/advance-phase.js <storyId> 3` |
| 3 | 代码审查师 | `code-review.json` | `node ${HARNESS}/advance-phase.js <storyId> 4` |
| 4 | 测试工程师 | `test-report.md` `acceptance-verification.json` | `node ${HARNESS}/advance-phase.js <storyId> 5` |
| 5 | 发布助手 | git commit + push | `node ${HARNESS}/advance-phase.js <storyId> 6` |
| 6 | 发布助手 | 知识库更新 | `node ${HARNESS}/advance-phase.js <storyId> 7` |
| 7 | 发布助手 | 部署 URL + 构建号 | `node ${HARNESS}/advance-phase.js <storyId> 8` |

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

```
advance-phase 返回 success: false
├── run_fix_loop → 执行提示的命令 → 开发者修复 → 重新推进
├── retry_with_auto_fix → 加 --auto-fix 重试
└── manual_fix → 提示用户手动处理
```

## Agent Prompt 编写规范

1. 必须包含：Story ID、当前 Phase、上一个 Phase 的 summary
2. 必须注入：`phaseSummaryContent` + `contractFilesToLoad`
3. 必须注入：`lessonsFromHistory`（历史教训）
4. Phase 2 Agent 必须包含：task-dag.json 中的 files[] 范围

### 使用 suggestedAgentPrompt（推荐方式）

advance-phase.js 推进后输出中已包含 `suggestedAgentPrompt` 字段，主 Agent 应直接使用：

```
1. 执行 advance-phase.js <storyId> <targetPhase>
2. 从 JSON 输出中提取 suggestedAgentPrompt
3. 将 {主Agent在此填写具体任务描述} 和 {产出要求} 替换为实际内容
4. 将完整 prompt 注入到 Spawn Agent 的 prompt 参数中
```

**示例流程**:
```
advance-phase.js 输出:
{
  "success": true,
  "suggestedAgentPrompt": "## Story: STORY-001 | Phase: 2 (代码开发)\n\n## 上一 Phase 摘要\n...\n\n## 契约文件内容\n### acceptance-criteria.json\n```json\n{...}\n```\n\n## 约束\n- 🚫 禁止修改 e2e-state.json...\n\n## 你的任务\n{主Agent在此填写具体任务描述}\n\n## 产出要求\n{主Agent在此填写本Phase需要产出的文件清单}"
}

主 Agent 操作:
1. 读取 suggestedAgentPrompt
2. 替换 {主Agent在此填写具体任务描述} → "修复 RoleManage.vue 的筛选下拉框缺少全部选项"
3. 替换 {产出要求} → "修改 src/views/pc/manage/RoleManage.vue"
4. Spawn frontend-developer Agent，prompt = 替换后的 suggestedAgentPrompt
```

### 手动构造 prompt（不推荐，容易遗漏上下文）

如果必须手动构造，至少包含：
- advance-phase.js 输出中的 phaseSummaryContent
- advance-phase.js 输出中的 contractFilesToLoad 文件内容
- advance-phase.js 输出中的 lessonsFromHistory
- advance-phase.js 输出中的 agentConstraints

## 铁律

- 🚫 AI 不直接写/改 `e2e-state.json`
- 🚫 AI 不直接写/改 `dev-pass.json`
- 🚫 AI 不跳过 Phase
- 🚫 AI 不自标记 `open-questions.json` resolved
