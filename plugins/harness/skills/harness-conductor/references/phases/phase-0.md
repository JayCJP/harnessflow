# Phase 0 — 需求分析

> 门控实现：`services/policy.js` → `checkPhase0Gate()` / `checkPrdCoverage()` / `checkBugReportScope()`
> 通用三道检查见 [README.md](./README.md)

## 职责

Agent 注册名 **`requirement-analyst`**（需求分析师）。读取需求输入（`story-input.json` /
PRD / bug 分析报告 / 用户补充说明），产出需求分析文档、可测试的验收标准、待确认问题。
Agent 内部需调用 `use_skill("kb-query")` 检索项目知识库。

`mode=fixbugs` 时该 Agent 自行 `use_skill("tapd-bug-analyzer")` 拉取并分析 TAPD 缺陷 ——
主 Agent 不做这件事，也不调任何 TAPD MCP 工具。

## 产出物

| 文件 | 契约 | 条件 |
|------|------|------|
| `requirement-analysis.md` | — | 必需 |
| `acceptance-criteria.json` | ✅ | 必需 |
| `open-questions.json` | ✅ | 必需 |
| `prototype-analysis.md` | — | 仅当 `gateChecks.prototypeRequired=true` |
| `{标题}_bug分析报告.md` | — | 仅 `mode=fixbugs`；**prompt 级要求，非门控项**（见下） |

`prototypeRequired` 由 `state.js:isPrototypeRequired()` 判定：fixbugs 恒 false；
run 模式看 `sources.prototypeUrls` + `sources.figmaUrls` 是否非空。

⚠️ **Bug 分析报告的存在性没有门控**。文件名含动态标题，进不了 `PHASE_ARTIFACTS` 固定文件名表。
报告相关机制共三处，全部不阻断推进：`prompt-builder.js` 的 `expectedOutputs`（要求 Agent 产出）、
`readStoryContext()`（Phase 1~8 自动注入报告全文）、`policy.js:checkBugReportScope`
（仅当报告存在时扫描标题行是否含修复方案类章节 → warning，见下表）。
缺报告的实际后果是后续 Phase 拿不到 Bug 事实，而不是被门控挡住。
（历史上的废弃脚本 validate-phase-gate.js 曾对存在性设 blocker，与该取舍矛盾，2026-09 随脚本删除一并纠正。）

## 出门门控（Phase 0→1）

| 检查 | 级别 | failureType |
|------|------|-------------|
| `criteria` 为空 / 缺 id / 缺 description / id 重复 | BLOCKER (2) | `ac_empty_criteria` `ac_missing_id` `ac_missing_description` `ac_duplicate_id` |
| `acceptance-criteria.json` JSON 解析失败 | BLOCKER (2) | `ac_format_error` |
| `open-questions.json` 有 `blocking:true` 且未 resolved 的项 | BLOCKER (4) | `blocking_unresolved` |
| 有未 resolved 但非 blocking 的项 | WARNING | — |
| **run 模式** `acceptance-criteria.json` 缺 `featurePoints` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `coverage:"deferred"` 却没写 `deferredReason` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `covered` 却 `acIds` 为空，或引用了不存在的 AC | BLOCKER (2) | `prd_coverage_missing` |
| **fixbugs 模式** Bug 分析报告含修复方案类章节（修复建议/解决方案/测试验证等标题行） | WARNING | — |

⚠️ `featurePoints` 是 run 模式的硬要求，`fixbugs` 不要求（Bug 修复没有 PRD 功能点可枚举）。
它的存在理由：门控原先只能校验「已写下的 AC 是否格式合规」，发现不了「整条功能压根没进 AC」。

Figma frame-inventory **不在本门控校验** —— 由 Phase 1 任务规划师产出，在 Phase 1→2 校验。

## 契约格式

`acceptance-criteria.json`（schema: `scripts/schemas/acceptance-criteria.schema.json`）
```json
{
  "criteria": [{ "id": "AC-1", "description": "...", "testType": "ui|api|integration" }],
  "featurePoints": [
    { "id": "FP-1", "source": "PRD 3.2 节", "coverage": "covered", "acIds": ["AC-1"] },
    { "id": "FP-2", "source": "原型 P4", "coverage": "deferred", "deferredReason": "本期不做，依赖后端排期" }
  ]
}
```

`testType` 会在 Phase 4→5 决定证据强度门控的严格程度（`ui` 型最严）—— 见 [phase-4.md](./phase-4.md)。

`open-questions.json`（schema: `scripts/schemas/open-questions.schema.json`）：
`resolved` 只能由用户确认后标记，**AI 不得自行置 true**。

## 常见失败与对策

- **纯文字需求被卡「必须产出 prototype-analysis.md」**：`story-input.json` 缺失或写入晚于建流，
  `isPrototypeRequired()` 走保守分支恒 true。用 `create-workflow.js <id> --refresh-input` 回填；
  正向做法是建流时就带 `--input <file>`。
- **AC 全绿但功能缺失**：`featurePoints` 没枚举全。程序不猜 PRD 里有什么，只保证被枚举出来的
  功能点都落到 AC 或写明不做的原因 —— 枚举完整性靠 Agent，不靠门控。
