# Commands 模块 — 已迁移

## 职责

原有 4 个命令入口已迁移为可直接触发的 Skill；脚本命令仍位于 `plugins/harness/scripts/commands/`。

## 命令清单

| 入口 | Skill | 用途 |
|------|------|------|
| run | harness-run | 新功能开发全流程 |
| fixbugs | harness-fixbugs | Bug 修复流程（分析下沉到 Phase 0） |
| archive | harness-archive | Story 归档 |
| evolve | harness-evolve | Harness 自进化（体检→度量→诊断→治疗→验证） |

## 关键机制

- Skill 文档描述用户如何发起、参数如何搬运进 story-input.json
- 主 Agent 只搬运参数，不做分析（分析由需求分析师在 Phase 0 完成）
- story-input.json 的 `sources` 字段承载原型 URL、Figma URL、TAPD 链接、文本等输入
