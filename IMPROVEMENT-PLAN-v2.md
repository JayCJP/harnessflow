# Harness 插件改进建议清单（v2）

> 基于真实 Story `ai-as`（支持AI客助）全流程复盘生成。
> 数据源：`D:\test-blanch\ai-as\CustomerServiceSystem\.codebuddy\plans\ai-as\`（26 个产物 + trace.jsonl 141 条 + debug.jsonl）
> 会话数据：`D:\test-blanch\ai-as\会话记录_20260908163629.json`（19 轮 request / 42 次子 Agent 派单 / 59 次脚本调用）
> ⑧⑨⑩⑪ 数据源：`C:\Users\Intel\Downloads\debug-log.json`（36 条脚本输出，覆盖 Phase 0→3；问题 ⑧ 根因已用最小仓库实测复现）
> 生成日期：2026-09-08（⑧⑨⑩⑪ 补充于同日 debug-log 复盘）

---

## 一、本次运行实测数据（改动依据）

| 项 | 数值 |
|---|---|
| 时长 | 02:04 → 08:34 UTC（6.5h） |
| Token 总耗 | 32,459,993（input 32.36M / output 100.9K） |
| 上下文峰值 | 358,899 token |
| 子 Agent 派单 | 42 次：frontend-developer 21 / **code-reviewer 10** / requirement-analyst 4 / test-engineer 3 / task-planner 2 / release-assistant 2 |
| 脚本调用 | dispatch 17；advance-phase 30（`3`×10、`4`×6、`2 --fix-loop`×5、`2 --rollback`×4、`2 --renew-pass`×2） |
| 门控 | 21 次判定全 pass、0 blocker（warnings 全程累积不消） |
| 护栏拦截 | 4 次（dev_pass_expired ×2、dev_pass_scope_violation ×2） |
| 经验捕获 | 8 次（schema_validation_failed ×4、static_evidence_for_ui_ac、lint_error、orphan_ac、task_missing_evidence） |
| 最终结果 | 28 条 AC：12 passed / 0 failed / **16 unverifiable（57%）** |

### 三个核心病灶

1. **Figma 没对齐返工** —— Phase 0/1/2 三层门控全绿，UI 却做成了四 Tab，直到用户本地预览才暴露。
2. **Phase 4 空转 6 次** —— `advance 4` 执行 6 次，`test-engineer` 只派 3 次（其中 2 次是修 schema），真正测试只有 1 次。
3. **契约 schema 违规 3 次** —— 3 次子 Agent 派单实质是「改 JSON 字段」，不是做审查/测试。

---

## 二、Figma 返工根因（三层失效叠加，供 ⑥⑦ 参考）

| 层 | 失效点 | 证据 |
|---|---|---|
| 插件 | Phase 1 明令「禁止 `get_design_context`」，规划师只能看帧名；却允许把结构假设写进 task title | `prompt-builder.js:331`；task-3 title =「…面板容器（**四 Tab** + …）」 |
|  | 面板容器 task-3 绑到整页帧 `3723:54509`（1920×1080），而非 AI 客助本体 `3736:59784`（400×1064 drawer） | `task-dag.json` task-3 `figmaRefs` |
| 子 Agent | 拉到了正确结构却服从 task-dag：返回原文「AI 客助内部四能力在设计稿中是纵向卡片，**本任务严格遵循 task-dag「四 Tab」的明确指令**」 | 会话 req3 tool-result #17 |
|  | 派单要求「停下上报」，Agent 定义里却没这条 | `前端开发工程师.md` 无对应规则 |
| 门控 | Figma 门控只校验「frame 命中清单 / figmaNodeId 存在」，不校验「实现是否用了设计稿内容」 | `3723:54509` 命中清单即放行 |

---

## 三、改进项清单

### ① 任何阶段都能回 Phase 2 —— 现状已支持，缺的是暴露

**现状**：`phase-ops/rollback.js:70` 只校验 `targetPhase < currentPhase`，从 3/4/5/6 回 2 **本来就通**。

**为什么没用起来**：`dispatch.js:293,354` 出口只有一条 `advanceCommand = ADVANCE_CMD <storyId> <phase+1>`，
**从不给回退命令**。Agent 看到的下一步永远是 +1，想改代码只能先推到 4 再 rollback —— Phase 4 空转 5 次由此而来。

| 文件 | 改动 |
|---|---|
| `scripts/commands/dispatch.js:293,354` | 出口增加 `rollbackCommand: ADVANCE_CMD <storyId> 2 --rollback`（`phase >= 3` 时给出） |

**改动量**：极小 ｜ **阻塞**：无

---

### ② 移除 Phase 4 测试环节 ⚠️ 需拍板

**理由**：本次测试无运行时环境，14 条 UI 型 AC 靠静态审读判 passed，被门控 `static_evidence_for_ui_ac` 打回 21 个 blocker。
结论不可靠，属于虚伪验证。

**影响面（已全量 grep）**：

| 层 | 文件 |
|---|---|
| 定义 | `lib/phases.js`（`PHASE_SLUGS[4]` / `PHASE_NAMES[4]` / `PHASE_ARTIFACTS[4]` / `PHASE_AGENTS[4]`） |
| 脚本 | `advance-phase.js`、`create-workflow.js`、`phase-ops/fix-loop.js`（`sourcePhase===4` 分支）、`lib/dev-pass.js`、`services/policy.js`、`services/prompt-builder.js`、`audit/harness-audit.js` |
| Schema | `schemas/e2e-state.schema.json`、`schemas/fix-verification.schema.json` |
| 文档 | `skills/start/references/phases/phase-4.md`、`phases/README.md` |
| Agent | `agents/测试工程师.md`（删除）、`代码审查师.md`、`前端开发工程师.md`（交接语句改写） |
| 测试 | `__tests__/optimization-regression.test.js` |

**拍板点 1**：`PHASE_SLUGS` 是数组，删 `index 4` 会让 5/6/7/8 前移，`MAX_PHASE` 8→7，所有硬编码 phase 号连带要改。

- **方案 A（重编号，推荐）**：0/1/2/3/4=Git提交/5=知识库/6=部署/7=完成。彻底，需扫全仓硬编码 phase 号。
- **方案 B（留空位）**：数组留 `null` 占位，`MAX_PHASE` 不变。改动最小，但留假状态。

**拍板点 2**：`acceptance-verification.json` 与 28 条 AC 移除后还验不验？谁来验？
（选项：彻底不验 / 并入 Phase 3 审查时顺带判 / 保留产物但改由人工确认）

> **✅ 2026-09-08 已落地**
> - 编号方案：**方案 A 重编号**（0/1/2/3/4=Git提交/5=知识库/6=部署/7=完成，`MAX_PHASE` 8→7）
> - AC 归属：**并入 Phase 3 审查顺带判** —— `code-reviewer` 逐条核对 `acceptance-criteria.json`，
>   未通过的 AC 以 `severity: "BLOCKER"` 记入 `issues[]`（title 注明 AC 编号），复用既有修复回路；
>   `acceptance-verification.json` / `test-report.md` 与 `test-engineer` 一并删除
> - 存量 Story：**不迁移**（均为 `D:\test-blanch` 下的测试 Story，跑完即归档）
>
> 落地范围（30 文件）：`lib/phases.js`（常量表重编号）、`lib/artifacts.js`、`lib/contracts.js`
> （删 `checkAcceptanceVerification`）、`lib/state.js`、`lib/dev-pass.js`（删 `maxTestFixRounds`）、
> `services/policy.js`（删 `checkPhase4Gate` / `crossCheckReviewVsAcceptance` / `checkEvidenceQuality`）、
> `services/context-refresh.js`、`services/schema-validator.js`、`services/validate-contracts.js`、
> `commands/create-workflow.js`（phases 键）、`commands/dispatch.js`、`commands/advance-phase.js`
> （fix-loop 限 `currentPhase === 3`）、`commands/phase-ops/fix-loop.js`、`audit/*`、`hooks/session-stop.js`、
> 3 个 schema、`agents/测试工程师.md`（删除）、`skills/start/references/phases/*`（phase-5/6/7 → 4/5/6）。
>
> 原 `checkEvidenceQuality` 的护栏意图（UI 型 AC 不得仅凭代码审读判 passed）已迁移为
> Phase 3 的 Agent 规则，写入 `phase-3.md` 与 `PHASE_AGENTS[3].instruction`。

**改动量**：大（14 文件）｜ **阻塞**：是

---

### ③ agentPrompt 注入 Schema —— 当前完全没有

**现状**：`prompt-builder.js` 里 **0 处 schema 引用**（已 grep 确认）。9 个 schema 只被门控消费，Agent 生成前看不到。

**驱动方式**：`PHASE_ARTIFACTS` 已有 `contract: true` 标记，可直接映射到 schema 文件。

| Phase | contract 产出物 | 对应 schema |
|---|---|---|
| 0 | acceptance-criteria.json、open-questions.json | 同名 |
| 1 | task-dag.json | 同名 |
| 3 | code-review.json | 同名 |
| 4 | acceptance-verification.json | 随 ② 删除 |

**拍板点 3 —— 注入粒度**（本次 3 次违规全栽在 `additionalProperties: false`，不是字段语义）：

- **A 全文注入**：最保险，但 9 个 schema 全量进 prompt，与成本优化原则冲突，fix-loop 多轮重复计费。
- **B 骨架注入（推荐）**：只注入**顶层键白名单 + required 列表 + `additionalProperties: false` 警告 + 枚举取值**，约每 schema 15~30 行。本次 3 次违规（`summary.notes`、root 多字段、`estimate` 类型）全覆盖。
- **C 只给路径**：最省，但本次已证明 Agent 不会主动读（派单写了 schema 路径，#40 仍改错）。

> **✅ 2026-09-08 已落地（方案 B 骨架注入）**
> 新增 `scripts/services/schema-injector.js`，由 `PHASE_ARTIFACTS` 的 `contract: true` 驱动
> （不另立 Phase→契约映射），注入位置在「产出要求」之后。
> 下探深度固定 2 层（顶层 + 一层），实测体积：Phase 0 = 1306 字符 / Phase 1 = 1185 / Phase 3 = 961。
> 覆盖本次 3 次违规：`estimate`(integer) 类型明示、`summary` 嵌套白名单（防 `summary.notes`）、
> 顶层与元素层的 `additionalProperties: false` 双重强调。
> 回归测试新增第 9 节共 14 条断言（含「单 Phase 骨架 ≤2KB」成本护栏）。

**实现**：新增 `services/schema-injector.js`，由 `prompt-builder` 在产出要求段前插入。

**改动量**：中（新增 1 模块 + prompt-builder 接线）｜ **阻塞**：需选 A/B/C

---

### ④ filePath 强制大写盘符

**现状**：护栏是**字符串前缀匹配**（`repos.js:141,145`，`repos.json` 存 `D:\...`）。子 Agent 传 `d:/...` 即失配。
本次 22 次派单踩坑，第 23 次才由主 Agent 自己悟出来写进 prompt。

| 文件 | 改动 |
|---|---|
| `lib/repos.js:141,145,162` | `getRepoForFile` / `isSrcFile` 比较两侧统一走 `toUpperDrive()` |
| `lib/paths.js` | 导出 `toUpperDrive()` 供复用 |

**改动量**：小（2 文件）｜ **阻塞**：无

---

### ⑤ dev-pass 不限时间，只限文件

| 文件 | 行 | 改动 |
|---|---|---|
| `lib/dev-pass.js` | 92 | 删 `DEV_PASS_TTL` |
| `lib/dev-pass.js` | 162-168 | `isDevPassValid` 去掉 `now < expiresAt`，只保留 allowedPaths 校验 |
| `lib/dev-pass.js` | 190 | `renewDevPass` 变 no-op → **连同 `phase-ops/renew-pass.js` 与 `advance-phase.js --renew-pass` 分支一并删除**（本次用了 2 次，全因过期续签） |
| `lib/state.js` | 128,150 | 去掉 `DEV_PASS_TTL` 导入/再导出 |
| `phase-ops/rollback.js` | 110 | `issueDevPass(storyId, DEV_PASS_TTL, ...)` 去掉 ttl 参数 |

**改动后**：dev-pass 只剩「Phase 2 + allowedPaths 限域」两个约束。

**连带项**：本次 2 次 `dev_pass_scope_violation` 是 `SmartQuery.vue` 不在 `task-dag.files` 里。
限域收紧后这类拦截会更频繁 → 建议同步在 Phase 1→2 门控加「files 完整性校验（组件引用闭包）」，否则变成新卡点。

**改动量**：中（5 文件 + 删 1 命令）｜ **阻塞**：无

---

### ⑥ Phase 1 允许分析 Figma 内容

**现状**：`prompt-builder.js:331` 明令
> 只用 `get_metadata` 扫帧结构，禁止调用 `get_design_context` / `get_screenshot`

这是本次返工的源头：规划师只能看帧名 → 把「四 Tab」写进 task-3 title → 把面板容器绑到整页帧而非 drawer 帧。

**改法**：放开 `get_design_context`，但限定范围：

- 允许**每个要拆的 UI task 拉 1 次** `get_design_context`，用于确定**结构**（布局方式、区块划分、嵌套层级）
- 仍禁止全文件扫描、禁止为「扫清单」而拉
- **新增约束**：task title / description 禁止固化未经设计稿确认的结构假设（「四 Tab」即由此而来），结构以 Phase 1 拉取结论为准

| 文件 | 改动 |
|---|---|
| `services/prompt-builder.js:331` | 改写 `buildTaskPlannerFigmaInstruction` 的 Figma 工具约束段 |
| `agents/任务规划师.md` | 同步 |

**成本提示**：`get_design_context` 单次返回可达 200KB（本次 req4 实测 200,984 字符）。
放开后 Phase 1 token 会明显上涨，建议限定「每 task 最多 1 次」并优先拉**容器/页面级**帧。

**改动量**：小（2 文件）｜ **阻塞**：无

---

### ⑦ 前端 Agent：Figma MCP 不可用则停止

**现状两处不一致**：

| 位置 | 有无「不可用则停下」 |
|---|---|
| `prompt-builder.js:249`（派单注入） | ✅ 有 |
| `agents/前端开发工程师.md` | ❌ **没有** |

本次 task-3 子 Agent 就是在这条缝里硬做的。且它**拉到了正确结构却服从了 task-dag**
—— Agent 定义里只写了「与 MCP 返回冲突时以 MCP 为准」，没写「与 task 描述冲突时以谁为准」。

**改法**（`agents/前端开发工程师.md`）：

1. 常规流程第 1 步补硬规则：MCP 不可用 / 返回错误 / Figma 桌面端未运行 → **立即停止，回报主 Agent，不得降级为凭摘要或截图实现**
2. 补冲突优先级：**Figma MCP 返回 > task-dag 描述 > 自身推断**；发现冲突停下上报，不得自行裁决
3. 与 `prompt-builder.js:248-250` 保持一致，消除双信源分叉

**改动量**：小（2 文件）｜ **阻塞**：无

---

### ⑧ 门控 lint 漏掉「新增目录」下的所有文件 ⚠️ 静默放行

**证据**：Story `ai-as` 主仓 5 次增量 lint，`files` 恒为同样的 7 个文件；
而 fix-request 点名的 `src/views/pc/ChatComponents/AiAssistant/SummaryHelper.vue`（新增目录 `AiAssistant/` 下）
改了 2 轮，**从未被 lint 过一次** —— 门控显示 pass，实际零校验。

**根因**（已用最小仓库实测复现）：`policy.js:1128` 有一行 `.filter(p => !p.endsWith('/'))`，
而 `git status --porcelain` 对**未跟踪的新增目录**只输出目录本身：

```
$ git status --porcelain                     # 新建 src/newdir/New.vue
?? src/                                      ← 以 / 结尾，被那行 filter 丢弃

$ git status --porcelain --untracked-files=all
?? src/newdir/New.vue                        ← 逐文件列出，能进 lint
```

被 lint 的 7 个文件全是**已跟踪文件的修改**（` M src/...`，不带 `/`）所以进了列表；
新增目录下的文件则被整体过滤。即：**只要代码写在新建目录里，就永远不进 lint。**

| 文件 | 行 | 改动 |
|---|---|---|
| `services/policy.js` | 1108 | `'git status --porcelain'` → `'git status --porcelain --untracked-files=all'` |

**预期副作用**：修好后新增文件首次进 lint，可能暴露此前一直被漏掉的 lint error。
这是**预期内**（本就该被拦），不是回归，但会让首次门控多一轮修复。

**验证**：
```bash
cd <repo> && git status --porcelain --untracked-files=all | grep -cE "\.(vue|js|ts)$"
# 应显著多于修改前的条数，且新增目录下的文件在列
```

**改动量**：极小（1 行）｜ **阻塞**：无

---

### ⑨ 同一条 warning 被 push 30 次 —— 刷屏且掩盖真因

**证据**：`ai-as` 一次门控里，`未归类的失败模式 (failureType: schema_validation_failed)`
以**完全相同的文本出现 30 遍**。

**根因**：两个独立缺陷叠加

| # | 位置 | 问题 |
|---|---|---|
| a | `services/policy.js:390-402` | 循环内对每个 blocker 都 `warnings.push(...)`，**未按 failureType 去重** |
| b | `services/policy.js:85` 映射表 | `schema_validation_failed` **从未登记**进 `RECOVERY_SUGGESTIONS`，30 个 blocker 全部落到 `unknown`（`policy.js:283-289`） |

(b) 是根本：未登记 → 落 unknown → 恢复建议被降级成 level 3 兜底文案 + 每次刷屏。
本次经验捕获 8 次里 `schema_validation_failed` 占 4 次（见第一节），属高频类型，早该有独立条目。

| 文件 | 行 | 改动 |
|---|---|---|
| `services/policy.js` | 399 | 循环外加 `const warned = new Set()`，push 前判断是否已告警过该 failureType（约 +4 行） |
| `services/policy.js` | `RECOVERY_SUGGESTIONS` | 补 `schema_validation_failed: { level: 2, action: '请检查 task-dag.json 格式是否符合规范，参考 schemas/ 目录下的 schema 定义', autoFixable: false }` |

**连带项**（同类一行修复，建议同批处理）：`commands/dispatch.js:116` 的 `.slice(0, 5)`
导致文案写成「有 **6** 个未确认问题: Q-01, Q-02, Q-03, Q-04, **Q-05**」—— 计数与列表自相矛盾。
改为 `.slice(0, 5)` 后补 `…等 N 个` 即可。

**验证**：`__tests__/optimization-regression.test.js:440` 已有护栏
「所有 pushIssue type 均已登记 RECOVERY_SUGGESTIONS」，补条目后应仍绿。

**改动量**：小（1 文件，约 9 行）｜ **阻塞**：无

---

### ⑩ state_change 三份冗余 + 随轮次线性膨胀

**证据**：单条 `state_change` 记录从 1760B 涨到 5455B（3.1×），且**每多一轮 fix round 就再涨一截**。

**根因**：`lib/story-state.js:76`

```js
debugLog.record(storyId, 'state_change', { diff, after: state }, { source: 'state.js', ... })
```

`diff` 里 `from` / `to` **各存一份**完整 `gateChecks`（含**累积**的 `gateValidationResults` 数组），
`after` 又存一遍完整 state —— 同一份数据 3 份，且三份随轮次同步膨胀。

| 文件 | 行 | 改动 |
|---|---|---|
| `lib/story-state.js` | 76 | `{ diff, after: state }` → `{ diff }` |

**理由**：`e2e-state.json` 本身已落盘在 `plans/<storyId>/` 下，是权威信源；
debug-log 里的 `after` 是第二副本（同物多信源），两份不一致时反而误导排障。`diff.to` 已含变更后新值。

**收益**：单条 -38%（5455B → ~3380B），并**消除随 fix round 的线性膨胀**。

**改动量**：极小（1 行）｜ **阻塞**：无

---

### ⑪ fix_loop spawnPrompt 滚雪球

**证据**：第 1 轮 3 个 issue → 5112B；第 2 轮只剩 **1 个** issue → 仍有 4126B。
问题数降到 1/3，体积几乎没降 —— 那 1 条描述里塞了「原问题 + 第 1 轮修复 + 残余缺陷」三轮历史。

**根因**：**不在脚本**。`services/prompt-builder.js:605-609` 只是把 `issues[].description` 原样展开。
膨胀源是 **code-reviewer 把 description 写成「增量叙述体」**，把前几轮修复历史复述一遍写进 `fix-request.json`，
`commands/phase-ops/fix-loop.js:391` 原样透传 → 整段打进主会话。

**改法（脚本侧兜底，推荐）**：

| 文件 | 行 | 改动 |
|---|---|---|
| `services/prompt-builder.js` | 605-609 | 单条 `description` / `suggestion` 加上限（600 字符），超出截断并附 `…（完整描述见 <fixRequestPath>）` |

信息不丢：prompt 的 631-632 行本就要求子 Agent「先读取 fix-request.json 了解完整上下文」。

**治本方案**（改动大，可选）：在 `fix-request.json` schema 约定 `description` 只写**当前残余缺陷**，
历史轮次放 `fix-report-roundN.md` 或独立字段 `previousRounds[]`，并同步改 `agents/代码审查师.md` 的写法约定。

**收益**：每条 spawnPrompt 4~5KB → 约 1.5KB，且轮次再多也不滚雪球。

**改动量**：小（1 文件 3 行）｜ **阻塞**：无

---

### ⑫ agentPrompt 检索入口精简为「仓目录 + /graphify」

**背景**：`buildRepoSearchEntries` 原本逐仓下发 8~12 行（图谱/知识库存在性预判、建图命令、
bash 执行样例），多仓场景成倍膨胀。

**精简原则**：只下发**脚本才知道、子 Agent 猜不到**的事实 —— 各仓绝对目录（来自 `repos.json`）
与「graphify / 知识库按 cwd 解析，跨仓须先 `cd`」（48% 检索空转的根因）。
其余（graphify 用法、命令样例、存在性）交给 `graphify` skill 自行披露。

| 文件 | 行 | 改动 |
|---|---|---|
| `services/prompt-builder.js` | `buildRepoSearchEntries` | 逐仓展开改为目录列表 + 一句 `/graphify` 指引 |

**收益**：2 仓场景 25 行 → 11 行；多仓越多差距越大。

**改动量**：小（1 函数）｜ **阻塞**：无

---

## 四、执行顺序

> **⑧⑨ 优先级提示**：这两项是 2026-09-08 复盘 debug-log 时发现的**静默缺陷**
>（门控显示 pass 却零校验 / 真因被 30 条重复 warning 淹没），改动仅 1~9 行、无回归风险，
> 建议提到 ③④⑤ 之前做，可与 ① 同批处理。⑩⑪ 属成本优化，独立无依赖。

| 序 | 项 | 改动量 | 阻塞 | 理由 |
|---|---|---|---|---|
| 1 | ① dispatch 给回退命令 | 极小 | 否 | 立即止血 Phase 4 空转 |
| 2 | ⑦ 前端 Figma 停用 + 冲突优先级 | 小 | 否 | 直接命中本次最大返工点 |
| 3 | ⑥ Phase 1 放开设计稿分析 | 小 | 否 | 与 ⑦ 配套，同属 Figma 链 |
| 4 | ④ 盘符规范化 | 小 | 否 | 独立 |
| 5 | ⑤ dev-pass 去 TTL | 中 | 否 | 独立，连带删 `--renew-pass` |
| 6 | ③ schema 骨架注入 | 中 | **选 A/B/C** | 消除 3 次填表派单 |
| 7 | ② 移除 Phase 4 | 大 | **选编号方案 + AC 归属** | 影响面最大，放最后 |
| 8 | ⑧ lint 漏新增目录文件 | 极小 | 否 | 静默放行，门控形同虚设；1 行 |
| 9 | ⑨ warning 去重 + 补登记 | 小 | 否 | 解刷屏，恢复建议不再降级；连带修 6/5 计数矛盾 |
| 10 | ⑩ state_change 去冗余 | 极小 | 否 | 消除随轮次线性膨胀；1 行 |
| 11 | ⑪ fix_loop prompt 截断 | 小 | 否 | 独立，防多轮滚雪球 |
| 12 | ⑫ 检索入口精简 | 小 | 否 | **已落地** |

### 本次已落地项（2026-09-08）

| 项 | 方案 | 状态 |
|---|---|---|
| ② 移除 Phase 4 | A 重编号 + AC 并入 Phase 3 + 存量不迁移 | ✅ 已落地并同步缓存副本 |
| ③ agentPrompt 注入 Schema | B 骨架注入 | ✅ 已落地并同步缓存副本 |
| ⑫ 检索入口精简 | 仓目录 + `/graphify` | ✅ 已落地并同步缓存副本 |

**测试状态**：`__tests__/run-all.js` 7/8 文件全绿；`optimization-regression` 87/88，
唯一失败项 `failure-patterns.json 补记 preGateBlocked` 为**改动前既有失败**
（已用 `git stash` 撤掉改动复跑确认，原版同样报 `[0,1,2,0,1,4]`），与本次改动无关。

---

## 五、待拍板

1. **② 编号方案**：A 重编号 / B 留空位？移除后 28 条 AC 还验不验、谁来验？
2. **③ 注入粒度**：A 全文 / B 骨架（推荐）/ C 只给路径？

---

## 六、落地注意事项

- **双副本（重要）**：本仓库 `plugins/harness/` 只是**源仓**（git 版本控制）。
  运行时实际执行的是**缓存副本**
  `C:\Users\Intel\.codebuddy\plugins\cache\harness-marketplace\harness\2.0.0\`
  —— SKILL.md 的 `HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands` 解析到缓存副本，不是源仓。
  实测依据：缓存副本下有**独立的** `scripts/commands/dispatch.js`（17891 B，链接数 1，非硬链接/软链）。
  → **脚本和 skill 一样，改完都要逐个 `cp` 到缓存副本对应路径才生效**（此前记成「脚本直接生效」，已更正）。
  → 同步时**只复制改动文件，绝不要整目录覆盖** —— 会把缓存里积累的运行时数据
    （经验库 `experience/failure-patterns.json` 两份已分叉，缓存版更全）回退成源仓版本。
  → 改完验证方式：`grep` 你新加的标识符，缓存副本里有才算同步上。
- **回归测试**：`scripts/__tests__/` 下 `advance-phase.test.js`、`optimization-regression.test.js`、`figma-detection.test.js`
  直接断言 prompt-builder / dispatch 输出，改这两处须同步更新断言。
