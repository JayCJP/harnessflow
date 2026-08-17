# Commands 模块 — 命令入口

## 职责

定义用户可触发的顶层命令，作为 Harness 工作流的入口。

## 命令清单

| 命令 | 文件 | 用途 |
|------|------|------|
| run | run.md | 新功能开发全流程 |
| fixbugs | fixbugs.md | Bug 修复流程（分析下沉到 Phase 0） |
| archive | archive.md | Story 归档 |
| evolve | evolve.md | Harness 自进化（体检→度量→诊断→治疗→验证） |

## 关键机制

- 命令文档描述用户如何发起、参数如何搬运进 story-input.json
- 主 Agent 只搬运参数，不做分析（分析由需求分析师在 Phase 0 完成）
- story-input.json 的 `sources` 字段承载原型 URL、Figma URL、TAPD 链接、文本等输入
