# 实跑日志诊断与优化方案 —— `门店工单` fixbugs 全流程

> **数据来源**（均为实跑产物，非推演）
> - `门店工单_20260904085513.json` —— CodeBuddy 会话导出，208 条消息 / 129 次主 Agent 工具调用
> - `phase0.txt` / `phase1.txt` —— 子 Agent 片段日志，含 `dispatch.js` 与 `advance-phase.js` 的**原始 stdout**（不经导出截断）
>
> **被观测的流程**：`门店工单` 第 5 轮（前 4 轮已归档），mode=fixbugs，跨 3 仓，Phase 0→8 完整跑完。
> 交付：15 AC / 11 任务 5 批次 / 17 文件 +506−153 / 3 个 MR 已合并 / 3 个云端构建成功。
>
> **诊断日期**：2026-09-04

---

## 一、先纠正一个错误结论：经验飞轮没有坏

初次分析曾判定「历史教训注入全程失效」。该结论**错误**，起因是 grep 撞上结果条数上限，
只看到 `experience.js` 源码那几行就下了判断。补查后的证据：

| 证据位置 | 内容 |
|---|---|
| 日志 `line 160` / `222` | Phase 0 prompt 含 `## 历史教训` + `## 📚 历史经验教训 (Phase 0)` + `## 📊 度量洞察（跨 1 个项目 2 个 Story）` |
| 日志 `line 505` / `517` | 本次 run 中 `advance-phase 1` 失败产生的 `blocking_unresolved`，被记录后**当场注入了后续 Phase 0 重跑的 prompt** —— 单次会话内闭环 |
| 日志 `line 834`~`890` | 五个 Phase 2 batch 的 prompt 均带 `dev_pass_scope_violation（2026次！）` |
| 日志 `line 822` | `getLessonsAsChecklist` 的结果确实写进了 `task-dag.json` 的 `mustCheck` |

其中 **2026 次** 是 1890+84+10+… 的**累加值** —— 只有注入侧归并（v3.1）才会产出这个数。

`phase0.txt` / `phase1.txt` 里没有教训段，是因为两者都是 **Phase 1** 的 prompt，
而 `failure-patterns.json` 中没有任何 `phase: 1` 条目 —— 返回空是正确行为，不是缺陷。

## 二、已在生产验证通过的部分（无需改动）

- **输出契约收敛（v3）** —— `phase0.txt:34-54` 是 `advance-phase.js 门店工单 1` 的真实输出，
  字段恰为 `success / storyId / fromPhase / fromPhaseName / toPhase / toPhaseName / gateChecks /
  nextAgent / nextAgentLabel / expectedOutputs / agentPrompt`，无任何重复拷贝字段。
- **教训注入侧归并（v3.1）** —— 见上文 2026 次累加。
- **摘要与契约只给路径** —— `agentPrompt` 中摘要为 `phase-0-summary.md` 路径，契约为绝对路径清单。
- **门控 fail-closed 生效** —— Phase 0→1 因 6 项 blocking open-questions 被拒；
  Phase 3 的 BLOCKER B1 触发 `--fix-loop` 回退到 Phase 2。
- **三层职责边界基本守住** —— 所有推进都走 `advance-phase.js`，未手改 `e2e-state.json`，
  未跳 Phase，未自标 `open-questions.json` resolved（走 ask_followup + 派 requirement-analyst 增量更新）。

---

## 三、真实缺陷清单

### 3.1 主线判断

`## 契约文件内容` 在日志中出现于 `line 160-729` 与 `line 1489-1817`，
**830~1400 之间完全没有** —— 即 Phase 2/3/4 的 spawn prompt 是主 Agent 从零手写的。
它保留了教训段（还主动放大成「这个必须在 prompt 里强调」），
但把「读契约文件」换成了内联的「本 batch 任务详情（4 个任务的完整描述，含行号定位）」。

这反转了 `prompt-builder.js:87-89` 刻意做的决定（v2 明确写了「不再内联截断契约内容」）。
但主 Agent 有正当动机：11 任务分 5 批开发，而脚本给的 `agentPrompt` 只有「整个 Phase 2」
这一种粒度，**没有 batch 概念**。它不是在违规，是在补脚本的缺口。

> **本方案的主线**：凡是主 Agent 反复手写的地方，都是脚本能力缺失。
> 补脚本比加禁令有效。

### 3.2 缺陷总表

| # | 缺陷 | 证据 | 后果 |
|---|---|---|---|
| D1 | Phase 2 无 batch 级 prompt | 日志 830~1400 无契约段 | 主 Agent 手写 prompt，契约不再是唯一信源 |
| D2 | 跨仓检索三重失效 | `phase0.txt:139` Bash 失败后转全文搜索；25 次 `Search Content` 中 12 次零命中 | 48% 检索空转，关键词穷举 |
| D3 | dispatch 预检失败不入库 | `phase1.txt:18-27` 两条行号引用 blocker 修完直接 advance 成功 | 高频摩擦永远学不到，经验库饥饿 |
| D4 | `pendingBlockers.type` 为 `unknown` | `phase1.txt:20/24` | 即便入库也只进「待人工补录」 |
| D5 | 增量修复无上下文裁剪 | `phase1.txt:181/223` 688 行 bug 报告被读两遍 | 改 2 行 description 耗约 40 次工具调用 |
| D6 | 主 Agent 越界写契约产出物 | 手改 `acceptance-criteria.json`(P0)、`task-dag.json`(P1)、自写 `fix-verification.json`(P4) | 门控校验的就是这些文件，手改等于自己放行 |
| D7 | Phase 6 commit 落在已合并的 feature 分支 | 最终报告承认 `21e197e8cd` / `8bf511bb` 未进 dev | **真实交付缺口** |
| D8 | 多仓 plans 路径按 cwd 解析 | 产出物误写入 `CustomerServiceSystem/.codebuddy/plans/` 后被删 | 子 Agent 产出物写错仓 |
| D9 | `advanceCommand` 含未展开 `${CLAUDE_PLUGIN_ROOT}` | `phase0.txt:12` | PowerShell 下不可执行，必须手写绝对路径 |
| D10 | `commands.md` 字段表两头错 | `readyToAdvance`/`instruction` 在 `phase1.txt` 中不存在；`expectedOutputs`/`pendingBlockers` 未文档化 | 文档与实现不符 |
| D11 | 检索约束与探测预算不可证伪 | 「禁止**仅**用文本搜索」load 一次 skill 即合规；「预算 2 次」实际用 50+ 次 | 约束无强制力，纯 token 噪音 |
| D12 | `unverifiable` 占比不阻塞 | Phase 4 出 `1 passed / 0 failed / 14 unverifiable` 仍放行到部署 | 纸面通过 |

---

## 四、P0 — 修正性（存在真实交付缺口）

| # | 对应缺陷 | 改动 |
|---|---|---|
| **P0-0** | — | 先跑 `node plugins/harness/scripts/__tests__/run-all.js`。上一轮 A/B/C 的改动至今未经测试，绿了再动其余 |
| **P0-1** | D7 | Phase 6 产出物加分支校验：提交前跑 `merge-base --is-ancestor` 确认目标分支未合并；已合并则输出 BLOCKER 要求新开 MR。同时禁止主 Agent 代跑 `git commit`（见 P3-1） |
| **P0-2** | D8 | prompt 的「产出目录」改为**主仓绝对路径**。现为相对路径 `.codebuddy/plans/<id>/`，按子 Agent cwd 解析必然跑偏 |
| **P0-3** | D9 | `advanceCommand` 输出已展开的绝对路径 |

## 五、P1 — 补齐脚本能力（消除手写 prompt 的动机）

### P1-1 batch 级 prompt（最高杠杆，对应 D1）

`buildAgentPrompt` 增 `batchId` 参数：从 `task-dag.json` 取该 batch 的 task 列表，
输出「本批次目标仓 + task id 清单 + `files[]` 白名单」，契约文件仍**只给路径**。
`dispatch.js` 在 Phase 2 检测到多 batch 时，逐 batch 给出 spawn 指令。

改完主 Agent 就没有理由自己拼 Phase 2 prompt，「Prompt 单一信源」才第一次真正成立。

### P1-2 增量修复的窄上下文（对应 D5）

加 `scope: 'incremental'`：只列被点名的契约文件，**不注入** `## Story 背景资料`。
触发点是 dispatch 报了 `pendingBlockers`、主 Agent 派修复 Agent 时。

### P1-3 跨仓检索入口按仓下发（对应 D2）

这是「已 load kb-query + graphify 却仍大量用 `search_content`」的根因，三重失效叠加：

1. `graphify-out/` 与 `.docs/llm-knowledge/` 都按 **cwd** 解析，而 cwd 是 `userlive`
   —— 本轮唯一**不改代码**的仓（`phase0.txt:69` 自己写着「主仓 userlive 本轮无代码改动」）
2. 3 个目标仓里 **supply_admin 根本没有 llm-knowledge**（最终报告承认「supply_admin 无知识库」）
3. graphify 是 CLI，唯一通道是 Bash，而 Bash 在片段中失败率约 35%
   （`phase1.txt` 7 失败 / 12 成功，`phase0.txt` 另有 3 次）

`phase0.txt` 的时序最直白：`:133` 载入 graphify → `:136` 载入 kb-query →
`:139` **Bash execution failed!** → `:141` 起全是 Search File / Search Content。
而 `任务规划师.md:27` 原文「`search_content` 仅作兜底」—— 主通道 35% 不通时，兜底就是主路径。

**改动**：检测到 `repos.json` 有非 primary 条目时，逐仓输出「仓路径 /
`graphify-out/graph.json` 是否存在 / `.docs/llm-knowledge/` 是否存在 /
现成的 `cd <repoPath> && graphify query "..."` 样例」。
存在性预判主 Agent 本来就在跑（日志 `line 1613` 的 `Test-Path`），把结果落进 prompt。

无知识库的仓要**明写**「该仓只走 graphify + 源码精读，不要尝试 kb-query」——
48% 的零命中关键词穷举就是摸黑撞出来的。

> **注意**：`use_skill("graphify")` ≠ 跑了 graphify。日志里的 `Skill "graphify" loaded`
> 只证明说明书被读进上下文。没有任何证据表明 `graphify query` 真的执行过。

---

## 六、P2 — 门控与飞轮

### P2-1 预检失败补记（飞轮的盲区，对应 D3）

`dispatch.js` 零写权限，只有 `advance-phase.js` 会 `recordFailurePattern`。
`phase1.txt` 里那两条「跨项目 task description 必须包含行号引用」是 dispatch 的
`pendingBlockers` 报出来的，主 Agent 修完再 advance → **一次成功，失败从未入库**。
经验库至今没有任何行号引用条目，就是这么来的：**预检越好用，飞轮越饿**。

改法（不破坏零写权限）：`advance-phase.js` 成功时对账「上一次 dispatch 报过的 blocker
是否被消解」，补记一条 `preGateBlocked`。

### P2-2 给 `unknown` 补分类（对应 D4）

至少把 `lib/state.js:1086-1095` 那批 task-dag 校验规则映射成具体 `failureType`。

### P2-3 检索证据进产出物（对应 D11 前半）

现约束「禁止**仅**用文本搜索」不可证伪：load 过一次 skill 即自动合规，
那 12 次零命中搜索完全合法。

改成 `task-dag.json` 每个 task 加
`evidence: { source: 'graphify'|'kb'|'both'|'grep', ref: '<实际 query 或文档路径>' }`，
门控要求跨仓 task 的 `source` 必须含 `graphify` 或 `kb`。

对标行号引用门控 —— 那条管用，正是因为它**查产出物、不查过程**。

### P2-4 unverifiable 占比告警（对应 D12）

环境限制是真的（拿不到供应商/代理/客服三种登录态），但至少应出 WARNING
并写进 Phase 5 的确认项，而不是静默放行到部署。

## 七、P3 — 约束与文档一致性

| # | 对应缺陷 | 改动 |
|---|---|---|
| **P3-1** | D6 | 铁律补一条：`🚫 AI 不直接写/改 Phase 契约产出物`（`acceptance-criteria.json` / `task-dag.json` / `*-verification.json`），要改就派对应子 Agent |
| **P3-2** | D2 | graphify / Bash 失败必须**上报主 Agent**，禁止静默降级到 `search_content`。此逻辑 `buildFigmaAlignInstruction` 对 Figma MCP 已有（「无法使用则立即停下上报，禁止硬做」），检索侧对齐即可 |
| **P3-3** | D10 | 修 `references/api/commands.md` 的 dispatch 字段表：补 `expectedOutputs` / `pendingBlockers`，把 `readyToAdvance` / `instruction` 标为条件性 |
| **P3-4** | D11 | 「环境探测预算最多 2 次工具调用」实际用了 50+ 次且无校验。要么写进汇报要求（回报实际调用次数），要么删掉省 token |
| **P3-5** | — | 承认或收编 prompt 前缀 —— 20 次 spawn 全带「⚠️ 环境探测结论（已由主 Agent 实测验证，禁止重复探测）」。省了 20 次重复探测，实用；但与「原样注入」冲突。P1-1 / P1-3 落地后大部分内容应由 `prompt-builder` 生成，剩余部分改文档承认 |

---

## 八、执行顺序与验证

```
P0-0 跑通测试   → 验证: run-all.js 全绿
P0-1..3         → 验证: 新增用例（分支已合并时 Phase 6 出 BLOCKER；
                          产出目录为绝对路径；advanceCommand 不含 "${"）
P1-1            → 验证: 多 batch task-dag 下 dispatch 输出 batch 级 spawn，
                          agentPrompt 含 files 白名单且不内联 task 正文
P1-2            → 验证: scope=incremental 时 prompt 不含「Story 背景资料」
P1-3            → 验证: repos.json 含非 primary 时逐仓输出检索入口与 KB/graph 存在性
P2-1..2         → 验证: advance 成功后 failure-patterns.json 新增 preGateBlocked，
                          且 type 非 unknown
P2-3..4         → 验证: 跨仓 task 缺 evidence 时门控 BLOCKER；unverifiable 过半出 WARNING
P3-*            → 文档与铁律，无脚本行为变更
```

**端到端复跑**：可用 `archive-story.js 门店工单 restore --round 5` 恢复一个跨仓 fixbugs
现场，核对三件事 ——

1. Phase 2 是否还需要主 Agent 手写 prompt
2. 跨仓检索的零命中率是否下降（基线 48%）
3. `preGateBlocked` 是否入库

## 九、明确不做的

- **不查教训注入** —— 已证实正常运行。Phase 1 为空是因为库里没有 `phase: 1` 条目。
- **不动 `readFailurePatterns` 的静默 catch**（`experience.js:83-88`）——
  初次分析把它当嫌疑点是基于错误结论，它没有造成任何观测到的问题。
- **不禁 `search_content`** —— 在没有知识库、图谱又摸不到的仓里读源码是**正确**做法。
  要治的是 48% 的零命中，不是工具选择本身。

## 附录：实跑观测数据

**主 Agent 工具调用**（129 次 / 11 种）：
`execute_command` 51、`read_file` 26、`task` 20、`list_dir` 7、`search_file` 7、
`search_content` 5、`replace_in_file` 4、`ask_followup_question` 3、`use_skill` 2、
`write_to_file` 2、`delete_file` 2。

**skill**：仅 `harness-start` + `harness-conductor`。
**MCP**：主 Agent 层**零调用**（符合铁律）。子 Agent 内部的 TAPD / devops / Figma MCP
不在导出范围内 —— `task` 只回传文本摘要。

**子 Agent spawn**（20 次）：requirement-analyst ×3、task-planner ×2、
frontend-developer ×6、code-reviewer ×3、test-engineer ×2、release-assistant ×4。
其中 **6 次为返工**（Phase 0 重新分析、task-dag 行号修复、Phase 3 重跑、Phase 4 重跑、
Phase 5 拆两次），返工率约 30%。日志自记教训一条：
「BLOCKER 修复建议的可操作性不足，导致需要多轮修复」。

**harness 脚本执行**（23 次）：`dispatch.js` ×9、`advance-phase.js` ×14
（含 1 次门控失败、1 次 `--fix-loop`）。相位轨迹：
`0 →(拒) →1 →2 →3 →2(fix-loop) →3 →4 →5 →6 →7 →8`。

**开局故障**：首次 `dispatch.js` 因 `experience.js` 重复代码块 `SyntaxError` 完全无法运行，
主 Agent 现场改 marketplace 插件源码（`replace_in_file`，日志 `line 144`）才继续。
副作用是主 Agent 由此获得了「可以改插件文件」的先例。

---

## 十、落地记录（2026-09-04 实施完毕）

### 用户裁定（v2/v3）

1. **P0-1（D7 分支校验）不做** —— 整套改动取消，不实施、不写测试用例。
2. **P0-2 / P0-3 动态读取** —— 产出目录与 advanceCommand 均为运行时动态解析
   （复用 `state.js` 的 `PLANS_DIR` / `path.resolve(__dirname, ...)` 推导），不写死绝对路径。
3. **P3-4（探测预算表述）不做**。
4. **P2-3 收紧（v3）**：evidence 门控只接受含 graphify 的来源（`graphify`/`both` 通过，
   `kb`/`grep` 单独不满足）—— 倒逼在目标仓真实执行过 graphify 检索。

### 实施偏差与关键决策

- **Phase 2 spawn 主通道确认**：Phase 2 门控无产出物检查，`dispatch` 对 Phase 2 走分支 B，
  Phase 2 的 agentPrompt 实际由 **advance-phase.js 推进输出**下发 —— 故 P1-1 的 batch 序列
  同时加在 `advance-phase.js`（推进 1→2 输出 `batches[]`）与 `dispatch.js`（fix_loop 分支 A）。
- **task-dag schema 已有 `batches` 字段**（盘点时确认），P1-1 无需改 schema 的 batch 部分，
  仅补 `evidence` 字段（task 13 键 → 14 键，文档已同步）。
- **P2-1 落盘可行性**：hooks 只拦 `e2e-state.json`（`isStateFile`），`plans/` 目录其他文件
  不受拦截，`.dispatch-precheck.json` 落盘方案成立；已在 `dispatch.js` 文件头声明
  「零写权限的唯一且有意的例外（诊断类，非状态机文件）」。
- **hooks 的 `enforce-artifact.js` 输出命令**（含错误路径 `.codebuddy/scripts/`）本次未改，
  控制改动范围于 commands/services 层。

### 落地清单

| 项 | 改动 |
|---|---|
| P0-0 | 基线确认 55/55 全绿；进行中改动均为运行时数据文件（不冲突） |
| P0-2 | `prompt-builder.js`：产出目录 / story-input 指路 / fixContextFile 全部改 `path.join(PLANS_DIR, ...)` 绝对路径 |
| P0-3 | `dispatch.js` 新增 `PLUGIN_ROOT`+`pluginCmd()`，4 处命令动态展开；`advance-phase.js` 新增 `ADVANCE_CMD`/`ARCHIVE_CMD`，10 处输出命令绝对化；`policy.js` 8 处 resolution/fixLoopHint 绝对化 |
| P1-1 | `prompt-builder.js` 新增 `readTaskBatches` / `buildBatchScopeSection`（目标仓 + task 清单 + files 白名单，不内联正文）；`advance-phase.js` 推进到 Phase 2 多 batch 时输出 `batches[]` spawn 序列；`dispatch.js` 分支 A 同步；`任务规划师.md` 补 batch 引导（14 键） |
| P1-2 | `buildAgentPrompt` 增 `scope:'incremental'`（跳过背景/Figma 摘要，注入 fix-request 等窄上下文）；新增 `buildFixLoopSpawnPrompt` 收编 `advance-phase.js --fix-loop` 手写 prompt 体；`dispatch.js` fix_loop 分支传 `scope:'incremental'` |
| P1-3 | `prompt-builder.js` 新增 `buildRepoSearchEntries`：repos.json 有非 primary 条目时逐仓输出绝对路径 / 图谱与知识库存在性预判 / `cd <repo> && graphify query` 样例；无知识库仓明示「只走 graphify + 源码精读」；Phase 0/1/2 注入 |
| P2-1 | `dispatch.js` 预检 blocker 落盘 `.dispatch-precheck.json`；`advance-phase.js` 新增 `reconcileDispatchPrecheck`：推进成功对账补记 `preGateBlocked` 教训并清除留痕 |
| P2-2 | `policy.js` `checkPhase1Gate` 补 4 类结构化映射（`task_missing_repo_path` / `task_missing_description` / `task_missing_line_ref` / `task_missing_evidence`），杜绝 unknown；`RECOVERY_SUGGESTIONS` 注册对应条目 |
| P2-3 | `state.js` `checkTaskDagJson` 增跨仓 task evidence 校验（source 必须含 graphify）；`task-dag.schema.json` 增 `evidence` 字段（枚举 4 值，门控只认含 graphify）；`任务规划师.md` 补填写引导 |
| P2-4 | `policy.js` `checkPhase4Gate`：unverifiable ≥50% 输出「⚠️ 强告警」WARNING（不阻塞），随推进写入 gateChecks；`phase-5.md` 补「发布前确认」段 |
| P3-1 | `SKILL.md` 铁律第 5 条：AI 不直接写/改 Phase 契约产出物 |
| P3-2 | `AGENT_CONSTRAINTS` 第 3 条：graphify/Bash 检索失败必须停下上报，禁止静默降级文本搜索 |
| P3-3 | `commands.md` dispatch 字段表：补 `expectedOutputs` / `pendingBlockers` / `fixLoopContext` / `batches`，`readyToAdvance` / `instruction` 标条件性，advanceCommand 标注绝对路径口径 |
| P3-5 | `SKILL.md` Spawn 前置注入段补说明：跨仓检索入口类前缀已由 prompt-builder 生成 |

### 验证

新增 `__tests__/optimization-regression.test.js`（51 断言，run-all 自动发现）覆盖全部验证项；
全量回归 **6 个测试文件 / 282 断言全绿**。P2-1 端到端用例对全局 `failure-patterns.json`
做备份/还原，不污染生产经验库。

既有测试的 2 处断言随行为升级同步更新（story-input 路径绝对化、约束 2 条 → 3 条）。

### 实跑反馈（2026-09-04 当晚，bug-1138260062001211901 / CustomerServiceSystem 单仓 fixbugs）

**现象**：实跑者看到子 Agent prompt 中路径显示为 `D:\workfile\CustomerServiceSystem.codebuddy\plans\...`
（`CustomerServiceSystem` 与 `.codebuddy` 之间无分隔符），判定「拼接的路径错了」并中断流程。

**诊断（非脚本缺陷）**：
- dispatch 原始 JSON 输出的路径**正确**（`D:\workfile\CustomerServiceSystem\.codebuddy\plans\...`，
  本会话主仓即 CustomerServiceSystem，PLANS_DIR 解析无误）；
- 「缺分隔符」只出现在会话 UI 渲染层：markdown 把 `\.` 当转义序列吃掉（`\.` → `.`），
  `\b`/`\p`/`\s` 等字母转义不合法故原样保留 —— 铁证是子 Agent 自行构造的
  `C:\Users\Intel\.codebuddy\...schema.json` 也显示为 `Intel.codebuddy`，但该读取
  实际成功（文件仅存在于带分隔符的正确路径）；
- 子 Agent 实际收到并使用的路径正确（story-input 14 行 / repos.json 7 行均读取成功）。

**防御性修复（v3.1）**：注入 prompt 与输出命令的路径一律**正斜杠形式**
（`D:/workfile/...`），任何渲染层原样保留，Node / PowerShell / Windows API 全兼容：
- `prompt-builder.js` 新增 `toPosix()`，应用于产出目录 / story-input 指路 / 摘要路径 /
  契约文件清单 / fixContextFile / 增量修复上下文 / fix-loop 修复请求 / 跨仓检索入口（含 cd 样例）
- `dispatch.js` `pluginCmd()`、`advance-phase.js` `ADVANCE_CMD`/`ARCHIVE_CMD`、
  `policy.js` `ADVANCE_CMD` 的命令路径同步正斜杠化
- 回归新增 2 条断言（注入路径无 `\.codebuddy` 反斜杠形态、advanceCommand 纯正斜杠），
  全量 6 文件 / 284 断言全绿




