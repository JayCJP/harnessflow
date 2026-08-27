# Harness 插件仓库 — 知识库总览

## 项目定位

`harness-marketplace` 是一个 **Harness 工作流编排插件**，通过多 Agent 协同把「需求 → 分析 → 规划 → 开发 → 审查 → 测试 → 提交 → 部署」的完整软件交付流程自动化。

- **技术栈**：Node.js（CommonJS 脚本）+ Markdown（Agent/Skill 定义）+ JSON Schema（契约校验）
- **核心机制**：Phase 门控推进 + 状态机（e2e-state.json）+ 全链路 trace + 上下文压缩（context-refresh）
- **扩展方式**：Agent 定义、Skill、Hook、Schema 均为声明式，可插拔

## 模块地图（关键词 → 模块文档）

| 关键词 | 模块 | 文档入口 |
|--------|------|----------|
| agent、角色、需求分析师、前端开发、代码审查、测试、发布、任务规划 | agents | `business/agents/overview.md` |
| run、fixbugs、archive、evolve、工作流入口 | skills | `business/skills/overview.md` |
| prompt-builder、context-refresh、state、trace、policy、schema-validator | scripts-core | `business/scripts-core/overview.md` |
| advance-phase、create-workflow、dispatch、harness-workflow | scripts-commands | `business/scripts-commands/overview.md` |
| enforce-*、session-start、session-stop、trace-command、钩子 | scripts-hooks | `business/scripts-hooks/overview.md` |
| schema、acceptance-criteria、task-dag、code-review、验收 | schemas | `business/schemas/overview.md` |
| figma、kb-query、kb-update、kb-init、gen-project-docs、api-generator | skills | `business/skills/overview.md` |
| failure-patterns、metrics-insights、失败模式、度量 | experience | `business/experience/overview.md` |

## Phase 流水线概览

| Phase | 名称 | 负责 Agent | 关键产出 |
|-------|------|-----------|---------|
| 0 | 需求分析 | 需求分析师 | requirement-analysis.md、acceptance-criteria.json、figma-frame-inventory.json |
| 1 | 任务规划 | 任务规划师 | task-dag.json |
| 2 | 前端开发 | 前端开发工程师 | 代码变更 |
| 3 | 代码审查 | 代码审查师 | code-review.json |
| 4 | 测试 | 测试工程师 | acceptance-verification.json、test-report.md |
| 5 | Git 提交 | 发布助手 | commit |
| 6 | 知识库刷新 | 发布助手 | meta.yaml 更新 |
| 7 | 云端部署 | 发布助手 | 构建/部署记录 |

## 常见改动入口

- 改 Agent 行为 → `plugins/harness/agents/*.md`
- 改 Phase 门控/推进 → `plugins/harness/scripts/commands/advance-phase.js`
- 改 prompt 注入 → `plugins/harness/scripts/services/prompt-builder.js`
- 改状态/契约 → `plugins/harness/scripts/lib/state.js` + `plugins/harness/scripts/schemas/*.json`
- 改上下文压缩 → `plugins/harness/scripts/services/context-refresh.js`
- 新增能力 → `plugins/harness/skills/*/SKILL.md`
