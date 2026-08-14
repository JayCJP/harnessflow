# Scripts-Commands 模块 — 命令实现

## 职责

顶层命令的具体实现脚本，驱动 Phase 推进、工作流创建、任务派发。

## 文件清单

| 文件 | 职责 |
|------|------|
| advance-phase.js | Phase 推进核心：门控校验、dev-pass 管理、fix 回路、summary 生成 |
| create-workflow.js | 创建工作流、初始化 story-input.json、repos.json |
| dispatch.js | Agent 任务派发 |
| harness-workflow.js | 工作流编排入口 |
| archive-story.js | Story 归档 |

## 关键机制

- **门控推进**：advance-phase.js 校验 gateChecks，通过后写 phase_transition trace
- **fix 回路**：Phase 3 审查发现问题 → 回退 Phase 2 → 修复 → 重新审查（最多 MAX_FIX_ROUNDS 轮）
- **dev-pass**：Phase 1→2 签发，Phase 2→3 撤销，控制开发权限范围
- **度量聚合**：Phase 7 完成后调用 metrics-aggregator
