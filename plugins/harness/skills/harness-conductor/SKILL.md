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
| 3 | 代码审查师 | `code-review.md` | `node ${HARNESS}/advance-phase.js <storyId> 4` |
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

## 铁律

- 🚫 AI 不直接写/改 `e2e-state.json`
- 🚫 AI 不直接写/改 `dev-pass.json`
- 🚫 AI 不跳过 Phase
- 🚫 AI 不自标记 `open-questions.json` resolved
