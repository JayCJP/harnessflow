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
| `bug-list.json` | ✅ | 仅 `mode=fixbugs`；**门控项**，见「缺陷清单契约」 |

### 缺陷清单契约 `bug-list.json`（fixbugs 模式）

Phase 0 的 bug 级状态唯一结构化信源。人读的 `*_bug分析报告.md` 是它的投影 ——
报告文件名含动态标题，程序读不了，所以「分析了哪几个 bug / 各自该谁修 / 是否读过评论」
必须落到这个固定文件名上。

| 字段 | 含义 |
|------|------|
| `bugId` / `title` / `status` | TAPD 原样搬运，`status` 是 TAPD 原始 key 不是本地进度 |
| `category` | `frontend` / `backend` / `collab`，决定进不进开发任务 |
| `commentCount` / `commentDigest` / `lastCommentAt` | 评论读取证据（**每个缺陷必读评论**，不看状态） |
| `fingerprint` | 标题 40 字 + 描述 200 字的 hash，用于识别同一缺陷是否变化 |
| `linked` | 是否排进本次修复范围，backend / collab 通常 `false` |
| `writeback` | 回写凭证，**只由 `tapd-writeback.js --record` 写，Agent 不得手写** |

Schema 见 `scripts/schemas/bug-list.schema.json`，产出方式见 `tapd-bug-analyzer` 的 5.2 节。

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
| `open-questions.json` 有项未被用户确认（无 `confirmation`，含 AI 已给建议稿） | BLOCKER (4) | `user_confirmation_required` |
| `open-questions.json` 有项缺建议稿（`resolution` 为空） | BLOCKER (4) | `open_questions_unresolved` |
| `confirmation` 缺 `confirmedVia`/`confirmedAt`（疑似未经 resolve-question.js 写入） | WARNING | — |
| **run 模式** `acceptance-criteria.json` 缺 `featurePoints` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `coverage:"deferred"` 却没写 `deferredReason` | BLOCKER (2) | `prd_coverage_missing` |
| **run 模式** 功能点 `covered` 却 `acIds` 为空，或引用了不存在的 AC | BLOCKER (2) | `prd_coverage_missing` |
| **fixbugs 模式** Bug 分析报告含修复方案类章节（修复建议/解决方案/测试验证等标题行） | WARNING | — |
| **fixbugs 模式** `bug-list.json` 不存在 | BLOCKER (2) | `bug_list_missing` |
| **fixbugs 模式** `bug-list.json` 的 `bugs` 数组为空 | BLOCKER (2) | `bug_list_empty` |
| **fixbugs 模式** 某缺陷缺 `category` | BLOCKER (2) | `bug_list_missing_category` |
| **fixbugs 模式** 某缺陷既无 `commentCount` 也无 `commentDigest`（疑似未读评论） | WARNING | — |

⚠️ `featurePoints` 是 run 模式的硬要求，`fixbugs` 不要求（Bug 修复没有 PRD 功能点可枚举）。
它的存在理由：门控原先只能校验「已写下的 AC 是否格式合规」，发现不了「整条功能压根没进 AC」。

Figma frame-inventory **不在本门控校验** —— 由 Phase 1 任务规划师产出，在 Phase 1→2 校验。

## 契约格式

`acceptance-criteria.json`（schema: `scripts/schemas/acceptance-criteria.schema.json`）
```json
{
  "criteria": [{ "id": "AC-1", "description": "..." }],
  "featurePoints": [
    { "id": "FP-1", "source": "PRD 3.2 节", "coverage": "covered", "acIds": ["AC-1"] },
    { "id": "FP-2", "source": "原型 P4", "coverage": "deferred", "deferredReason": "本期不做，依赖后端排期" }
  ]
}
```

`open-questions.json`（schema: `scripts/schemas/open-questions.schema.json`）：
`resolved` 字段已废弃（门控不读）；每条 question 须含建议稿 `resolution` + `resolutionSource`；
**确认的唯一载体是 `confirmation` 字段**，约定由 `resolve-question.js` 在用户答复后写入，AI 不得自行填写。

## 分类后立即回写 TAPD（fixbugs 模式）

分类为 `backend` / `collab` 的缺陷，**分析完就写评论告知相关方**，不要等修复流程走完：

```bash
# 1. 首次校验状态映射（本轮只需一次）
node ${HARNESS}/../services/tapd-writeback.js <storyId> --check-status-map '<get_workflows_status_map 返回 JSON>'
# 2. 用 create_comments 发出评论（正文由 tapd-writeback.buildComment 生成，勿自行措辞）
# 3. 登记回写凭证（跨轮去重依据）
node ${HARNESS}/../services/tapd-writeback.js <storyId> --record <bugId> --kind to_backend
```

- `frontend` 缺陷**此时不写评论** —— 等 Phase 3 验收通过后统一写，避免先写「已修复」又被打回
- 评论只写「现象 + 结论 + 需要谁做什么」，不贴代码 / diff / 文件路径 / 函数名，总长 ≤ 120 字
- `backend` / `collab` **不改 TAPD 状态**，流转权归对方

## 常见失败与对策

- **纯文字需求被卡「必须产出 prototype-analysis.md」**：`story-input.json` 缺失或写入晚于建流，
  `isPrototypeRequired()` 走保守分支恒 true。用 `create-workflow.js <id> --refresh-input` 回填；
  正向做法是建流时就带 `--input <file>`。
- **AC 全绿但功能缺失**：`featurePoints` 没枚举全。程序不猜 PRD 里有什么，只保证被枚举出来的
  功能点都落到 AC 或写明不做的原因 —— 枚举完整性靠 Agent，不靠门控。
