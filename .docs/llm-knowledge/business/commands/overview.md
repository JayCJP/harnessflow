# Commands 模块 — 已迁移

## 职责

原有 4 个命令入口已迁移为可直接触发的 Skill；其中 run / fixbugs 进一步合并为单一入口
`harness-start`（意图识别决定 mode）。脚本命令仍位于 `plugins/harness/scripts/commands/`。

## 命令清单

| 入口 | Skill | 用途 |
|------|------|------|
| run / fixbugs | harness-start | 统一入口：识别意图判 mode，梳理输入，启动后交棒 conductor |
| archive | harness-archive | Story 归档 |
| evolve | harness-evolve | Harness 自进化（体检→度量→诊断→治疗→验证） |

## 关键机制

- Skill 文档描述用户如何发起、参数如何搬运进 story-input.json
- 主 Agent 只搬运参数，不做分析（分析由需求分析师在 Phase 0 完成）
- story-input.json 的 `sources` 字段承载原型 URL、Figma URL、TAPD 链接、文本等输入
- `mode` 写在 story-input.json 里，是 run / fixbugs 全部行为差异的唯一驱动（`getStoryMode`
  / `isPrototypeRequired` / `detectFigmaSource` / `prompt-builder` 的 mode 分支）
- 启动用 `harness-workflow.js start ... --input <file>`：建流前摄入并校验输入，
  原型/Figma 判定一次算准，取代原先「start → 写输入 → `--refresh-input` 回填」三步
