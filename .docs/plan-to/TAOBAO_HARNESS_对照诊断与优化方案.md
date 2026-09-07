# 淘宝主播 Agent Harness 对照诊断与优化方案

> 参照文献：`淘宝主播Agent的Harness工程实战-深度研读.md`（本仓库根目录，415 行）
> 诊断对象：`plugins/harness`（本仓库插件源码）
> 成文日期：2026-08-12
> 方法：用文献的 Harness = (E, T, C, S, L, V) 六元组框架逐项对照本项目实现，标注已有 / 缺失 / 薄弱，再给出优先级排序的落地改进项。

---

## 0. 阅读须知：三类改进项的边界

本文的优化方案分为三类，**请勿混淆**：

| 类别 | 含义 | 判定依据 |
|---|---|---|
| **A 类** | 本仓库 `docs/` 已有设计文档，但代码未实现 | 已核查目标文件不存在 |
| **B 类** | 本次诊断新发现，现有任何设计文档均未提及 | 已 Grep 全仓库确认无对应设计 |
| **C 类** | 淘宝文献独有、本项目从未纳入视野的机制 | 文献有、本仓库 docs 与代码均无 |

A 类不是新建议，是**待兑现的旧承诺**；B 类才是本次诊断的增量价值；C 类需要判断是否值得移植（见第 6 章的排除清单）。

---

## 1. 总体结论

**本项目的 Harness 骨架是健康的，短板集中在「工具层」与「上下文层」，而非「状态层」。**

三句话概括：

1. **S（状态存储）与 E（执行循环）是本项目的强项**。「单一信源」被确立为全项目最高哲学，`advance-phase.js` 独占状态机写权限，`dispatch.js` 实施三权分立（规划 / 执行 / 状态变更分离），这与文献第 4 节 Reducer 模式的意图一致 —— 都在防止「拼接就是判断，判断权回到主 Agent 手里」。
2. **T（工具注册）与 L（生命周期钩子）是明确短板**。没有工具注册表，没有幂等键，没有错误码分段，没有指数退避；hooks 只有 4 类时机且全部偏「守卫拦截」，缺文献强调的「引导前馈」。
3. **最严重的单点问题不在缺失某个大机制，而在一处生产/消费端断裂**：结构化错误的**生产端从未落地**。这不是设计缺陷，是实现漏项，且已经产生了可量化的实际损失（见 2.2）。

评级汇总（★ 为成熟度，五星制）：

| 维度 | 成熟度 | 一句话结论 |
|---|---|---|
| **E** 执行循环 | ★★★★☆ | 三权分立优秀，但 Phase 硬编码线性推进，无 DAG 规划、无 Checkpoint 回滚点 |
| **T** 工具注册 | ★★☆☆☆ | 有 Schema 校验与四级恢复，但无注册表、无幂等键、无错误码分段、无退避重试 |
| **C** 上下文管理 | ★★☆☆☆ | 只有单层 summary + 行数硬截断，无三级压缩、无大上下文外挂、无 token 预算 |
| **S** 状态存储 | ★★★★☆ | 单一信源底座扎实，但状态写入散落三处、无快照、无每轮 system-hint |
| **L** 生命周期钩子 | ★★☆☆☆ | 仅 4 类时机，全部是拦截型，缺 PreCompact / SubagentStop / UserPromptSubmit |
| **V** 评估度量 | ★★★☆☆ | 8 项指标 + 6 条洞察 + 误报扣除机制，但无成本 / 延迟 / 干预率，阈值硬编码 |
| **记忆**（跨维） | ★★☆☆☆ | 只有「失败模式」单一类型，无 L1/L2/L3 分层、无信任度、无遗忘、无对账 |

---

## 2. 实证数据：本仓库的真实运行痕迹

以下全部来自本仓库文件的直接统计，非估算。

### 2.1 代码规模

| 项 | 数值 | 来源 |
|---|---|---|
| 语料总量 | 89 文件 / 95,101 词 | graphify detect |
| 代码文件 | 51 个 | 同上 |
| 文档文件 | 38 个 | 同上 |
| AST 抽取产量 | 1,203 节点 / 1,949 边 | graphify AST pass |
| 6 个 Agent 定义合计 | 1,662 行 | 需求分析师 406 / 前端开发 354 / 代码审查 333 / 测试 210 / 发布 190 / 任务规划 169 |
| `lib/state.js` | 1,527 行 | 单文件最大 |
| `commands/advance-phase.js` | 1,147 行 | 次大 |
| `services/policy.js` | 773 行 | — |

### 2.2 失败模式实测分布（`scripts/experience/failure-patterns.json`，version 2.1）

**这是全项目最有价值的实证数据。** 22 条真实失败记录，按发生次数排序：

| failureType | Phase | 次数 | 状态 |
|---|---|---|---|
| `dev_pass_scope_violation`（3 条合计） | 2 | **146**（107 + 33 + 6） | confirmed |
| `artifact_missing` | 0 | 21 | confirmed |
| `unknown`（跨项目 task 缺 description） | 1 | **7** | **pending** |
| `unknown`（description 缺行号引用） | 1 | **7** | **pending** |
| `code_review_blocker` | 2 | 6 | confirmed |
| `code_review_blocker` | 3 | 2 | confirmed |
| `schema_validation_failed` | 0 | 2 | confirmed |

三条推论：

1. **`dev_pass_scope_violation` 一项占全部失败的 70%+**。最高频那条 107 次，rootCause 是「Agent 试图编辑 dev-pass 限域外的文件」。这说明限域机制**拦得住，但没教会** —— 事后拦截 146 次，说明前馈引导缺失。
2. **两条 `unknown` 各累计 7 次、合计 14 次，至今 `reviewStatus: pending`**。它们得不到任何自动恢复建议，因为类型无法被识别。根因见 2.3。
3. 失败集中在 Phase 0/1/2，Phase 3 之后骤降 —— 与 2.4 的门控覆盖分布**恰好相反**，这是本次诊断最重要的错配。

### 2.3 结构化错误体系的生产端断裂

| 事实 | 位置 |
|---|---|
| `structuredError(type, message, level, resolution)` 函数已定义 | `lib/state.js:1412` |
| `errorToType(...)` 反向推断函数已定义 | `lib/state.js:1432` |
| `lib/state.js` 中 `errors.push` 调用数 | **45 处** |
| 其中使用 `structuredError` 的 | **0 处** |
| 全项目 `structuredError` 实际调用点 | 仅 `services/policy.js` 11 处（L321/341/421/433/467/511/542/567/606/631/673） |

也就是说：**校验器（生产端）吐裸中文字符串，策略层（消费端）再用 `matchRecoverySuggestion` 靠中文关键词反推类型**。类型信息在生产时就被丢弃，消费时靠猜。

2.2 里那两条各 7 次的 `unknown`，直接对应以下三行裸字符串：

```js
// lib/state.js:1014-1026
result.errors.push(`${prefix}: 跨项目 task (project=${task.project}) 必须指定 repoPath`)      // L1016
result.errors.push(`${prefix}: 跨项目 task 必须有 description 字段`)                          // L1024
result.errors.push(`${prefix}: 跨项目 task description 必须包含行号引用（如 L123 或 line 45）`) // L1026
```

关键词不在 `RECOVERY_SUGGESTIONS` 里 → `errorToType` 返回 `unknown` → 无恢复建议 → 每次都需人工 → 累计 14 次仍 pending。**这是一条完整的、可验证的因果链，也是本方案 P0 的唯一硬依据。**

### 2.4 门控覆盖率 4/9

`services/policy.js` 中的 Phase 门控函数**只有 4 个**：

| 函数 | 行号 | 覆盖 Phase |
|---|---|---|
| `checkPhase0Gate` | L387 | 0 |
| `checkPhase1Gate` | L477 | 1 |
| `checkPhase3Gate` | L554 | 3 |
| `checkPhase4Gate` | L622 | 4 |

**Phase 2 / 5 / 6 / 7 / 8 无专属门控。** 而 Phase 2 正是 146 次违规的集中地 —— 违规最多的相位恰好没有门控。

### 2.5 状态写入分散与快照缺失

`commands/advance-phase.js`：

| 项 | 事实 |
|---|---|
| `state.phase = / state.status =` 赋值分支 | **3 处**：L283-284（rollback）、L530-531（fix-loop 固定设 phase=2）、L913-914（正常推进） |
| `writeStateFile` 调用 | 4 处：L308、L568、L1058、L1141 |
| `checkpoint` / `snapshot` 关键词 | **全项目 0 命中** |
| 幂等 / 退避相关 | 全项目仅 2 处：L873 一次性 `--auto-fix` 重试、L1015 一句「revokeDevPass 幂等」注释 |

三个分支各自维护 `state.phase`，等价于三份状态迁移实现 —— 与「单一信源」哲学在同一文件内自相矛盾。

### 2.6 可观测性字段缺口

`lib/trace.js`（207 行，8 个写 `trace.jsonl` 的函数）：

- JSDoc 声明了 `tool_call` 与 `agent_message` 两种事件类型，**但无对应函数**（声明与实现不一致）
- 全部事件**无 token 字段、无耗时字段**

直接后果：`audit/metrics-aggregator.js` 的 8 项指标全部是「流程是否跑通」，无法回答「跑通花了多少钱、多长时间」。文献第 9 节的在线指标（端到端延迟、干预率）在本项目**无数据基础**。

### 2.7 已设计但完全未实现的模块

核查结论（文件是否存在）：

| 文件 | 设计文档 | 是否存在 |
|---|---|---|
| `wf-graph.js` | `docs/DYNAMIC_WORKFLOW_设计方案.md`（569 行） | ❌ |
| `effects.js` | 同上 | ❌ |
| `gates.js` | 同上 | ❌ |
| `workflow-def.json` | 同上 | ❌ |
| `models/agent-work-loop.md` 落地到 metrics | `docs/BETTER_HARNESS_借鉴方案.md` 借鉴点 1 | ❌ 仅有 `docs/agent-work-loop.md` 定义文档（140 行） |
| `scripts/audit/trend-store.js` | 同上 借鉴点 2 | ❌ |
| `schemas/findings.schema.json` | 同上 借鉴点 5 | ❌ |
| `prompt-builder.js` 的 `feedforward` 区块 | 同上 借鉴点 6 | ❌ |

**569 行的动态工作流设计方案，落地率 0%。** 这个事实应当先于任何新提案被正视。

---

## 3. 六元组逐维诊断

### 3.1 E — Execution Loop（执行循环）★★★★☆

| 文献要求 | 本项目现状 | 判定 |
|---|---|---|
| 全局 DAG 规划替代 ReAct 逐步试探 | `task-dag.json` 有 DAG **数据结构**，但 Phase 推进本身是硬编码线性 `+1` | 🟡 部分 |
| 主 Agent 只做编排，不亲自干活 | 已实现且写进 SessionStart 铁律第 3 条「主 Agent 不亲自编写代码 → 必须 spawn 专用 Agent」 | ✅ |
| SubAgent 上下文隔离 | 6 个 Agent 各有独立定义与工具白名单 | ✅ |
| 并行调度 | 任务规划师支持 Fork-Join 并行派发 | ✅ |
| 三层 Checkpoint | **无任何 checkpoint/snapshot 实现** | ❌ |
| 增量 Replan | 有 `--fix-loop`（max 2 轮）但固定回到 Phase 2，非按 DAG 差异重规划 | 🟡 部分 |

**核心差距**：文献的 PlanEngine 把「规划」做成一等公民（成功率 0.847 vs ReAct 0.737、平均迭代 5.44 vs 8.02）。本项目的 Phase 序列是**编译期固定**的 —— `advance-phase.js:690-691` 注释明确写「相位跃迁必须严格 +1」。这在流程稳定时是优点（可预测），但意味着无法跳过不适用的 Phase，也无法根据 Story 复杂度动态裁剪。`docs/DYNAMIC_WORKFLOW_设计方案.md` 已经识别了这一点并设计了 `wf-graph.js`，但未实现。

**值得肯定的是**：`dispatch.js` 的三权分立注释与四态机（`ready|blocked|fix_loop|terminal`）在架构清晰度上超过文献描述的水平。

### 3.2 T — Tool Registry（工具注册）★★☆☆☆

| 文献要求 | 本项目现状 | 判定 |
|---|---|---|
| 能力边界声明（工具自述能做什么/不能做什么） | 分散在 6 个 Agent 的 markdown 定义里，无机器可读注册表 | ❌ |
| Schema 强约束 | 有，`schemas/` + vendor 内联 ajv | ✅ |
| 幂等键（UUID） | **无**。全项目仅 1 句注释提到幂等 | ❌ |
| 结构化错误码分段（3xxx/4xxx/5xxx/9xxx） | 有四级恢复（L1 自动 / L2 提示 / L3 降级 / L4 阻塞）但**无错误码**，且分级与重试策略未绑定 | 🟡 部分 |
| 指数退避（5xxx 最多 3 次） | **无**。仅 `advance-phase.js:873` 一次性 `--auto-fix` | ❌ |
| 参数错误自动修复重试 1 次 | 有（`--auto-fix`），但不区分错误类别，所有错误共用一条路径 | 🟡 部分 |

**这是本项目最薄弱的维度。** 文献的错误码分段之所以关键，是因为它把「错误类别」和「恢复策略」做成了**编译期绑定**：4xxx 必然走「自动修复重试 1 次」，5xxx 必然走「指数退避 ≤3 次」，9xxx 必然「立即通知人工」。本项目的四级恢复是**运行期靠中文关键词匹配**决定的（见 2.3），既慢又脆。

### 3.3 C — Context Manager（上下文管理）★★☆☆☆

| 文献要求 | 本项目现状 | 判定 |
|---|---|---|
| 三级压缩（工具记录 → 历史轮次 → 当前消息） | 只有**单层** Phase summary（`context-refresh.js`），无分级 | ❌ |
| 大上下文外挂（OSS/Tair，只留 fileKey + 预览） | 无外挂，但契约文件本身按路径引用（形式上接近） | 🟡 部分 |
| Token 预算跟踪跨压缩边界 | **无 token 计量**（trace 无 token 字段，见 2.6） | ❌ |
| 渐进式压缩（先轻量，必要时升级） | 无升级路径，只有固定的 `maxLines=200` 行数截断 | ❌ |

**现有实现的具体形态**（`services/context-refresh.js` 239 行 + `services/prompt-builder.js` 375 行）：

- `generatePhaseSummary(storyId, phase)` → 写 `phase-N-summary.md`，含产出物 / 关键决策 / 待确认项 / 契约清单四段
- `loadLatestSummary(storyId, currentPhase, maxLines=200)` → 超 200 行**按行硬截断**并附提示
- `prompt-builder.js` 的 `CONTRACT_TRUNCATE_LIMIT = 3000`、`STORY_CONTEXT_TRUNCATE_LIMIT = 6000` —— 同样是**按字符数硬截断**

按行/按字符截断的问题是**语义边界不可控**：可能在 JSON 对象中间、在 markdown 表格中间、在代码块中间切断，下游 Agent 读到残缺结构。文献的三级压缩之所以分级，正是为了让每一级都在**语义完整单元**上操作。

`context-refresh.js:100-105` 有一段值得引用的注释，它记录了一次真实的漂移事故：

> 产出物清单来自 state.js 的 PHASE_ARTIFACTS（唯一信源）。此处不再自建映射表——历史上本函数维护过第二份表，与 PHASE_ARTIFACTS 漂移（Phase 0 多出原型/Figma 两项）。

这条注释是「单一信源」哲学在本项目内被**实战验证过**的证据，价值很高。

### 3.4 S — State Store（状态存储）★★★★☆

| 文献要求 | 本项目现状 | 判定 |
|---|---|---|
| 单一信源，LLM 不直接改状态 | 已实现，且写进 SessionStart 铁律第 4 条「禁止直接写/改 e2e-state.json 和 dev-pass.json」 | ✅ |
| Reducer 模式：LLM 只出 Action，纯函数做变更 | 精神一致（`advance-phase.js` 独占写权），但**无显式 `applyTransition(state, action)` 纯函数**，迁移逻辑散在 3 个分支（见 2.5） | 🟡 部分 |
| 每轮通过 system-hint 注入结构化 State | **只在 SessionStart 注入一次**（`hooks/session-start.js`），非每轮 | ❌ |
| Checkpoint 快照可回滚 | 有 `--rollback`（改 phase 指针 + 记 `rolledBackAt`），但**不恢复产出物快照** | 🟡 部分 |

**「只注入一次」是本维度的关键缺口。** `hooks/session-start.js` 的 `buildAdditionalContext()` 已经做得相当完整 —— 七段内容：工作流恢复标题、上轮产出物摘要、待确认项、gateChecks 三项、门控验证结果、经验教训 + 度量洞察、契约文件清单，末尾还有 5 条强制规则。**这套内容质量很高，但一次会话只出现一次。** 长会话中 Agent 会逐渐遗忘 Phase 状态与铁律 —— 这正是文献强调「每轮注入」的原因。

好消息是：**注入内容的构造函数已经写好了**，缺的只是一个每轮触发的时机。这使 4.4 的改造成本极低。

### 3.5 L — Lifecycle Hooks（生命周期钩子）★★☆☆☆

`plugins/harness/hooks/hooks.json`（59 行）实际只有 4 类时机：

| 时机 | 匹配器 | 用途 |
|---|---|---|
| `SessionStart` | — | 注入工作流上下文 |
| `PreToolUse` ×3 | `enforce-state-file`: `write_to_file\|replace_in_file\|Write\|Edit\|execute_command\|Bash`<br>`enforce-dev-pass`: `write_to_file\|replace_in_file`<br>`enforce-artifact`: `write_to_file\|replace_in_file` | **拦截** |
| `PostToolUse` | 仅 `execute_command` → `trace-command.js` | 记录 |
| `Stop` | — | — |

对照文献的 6 个时机（PreReasoning / PreToolCall / PostToolCall / PostReasoning / OnSessionEnd / OnLiveEnd）：

| 缺失时机 | 后果 |
|---|---|
| `UserPromptSubmit` | 无法每轮注入 state hint（直接导致 3.4 的缺口） |
| `PreCompact` | 上下文压缩前无法抢救关键状态 |
| `SubagentStop` | 子 Agent 产出无自动校验时机，只能等下一次 PreToolUse 拦截 |
| `PostToolUse` 覆盖不全 | 只监控 `execute_command`，**Write/Edit 的结果不被记录** |

**更本质的问题是钩子的「性格」**：现有 3 个 PreToolUse 全是拦截型（`enforce-*`）。`docs/BETTER_HARNESS_借鉴方案.md` 借鉴点 6 已精准命名此问题 ——「现有 hooks 偏『守卫拦截』，缺『引导前馈』」。2.2 的 146 次 `dev_pass_scope_violation` 就是最贵的注脚：**拦了 146 次，一次都没提前告诉 Agent 允许写哪些文件。**

### 3.6 V — Valuation Interface（评估度量）★★★☆☆

`audit/metrics-aggregator.js`（429 行）：8 项指标 + 6 条洞察规则 + 5 项硬编码 `THRESHOLDS`。

| 文献要求 | 本项目现状 | 判定 |
|---|---|---|
| 在线：操作成功率 | 有 | ✅ |
| 在线：审批通过率 | 有（门控通过率近似） | ✅ |
| 在线：干预率 | **无** | ❌ |
| 在线：端到端延迟 | **无**（trace 无耗时字段） | ❌ |
| 在线：成本（token） | **无**（trace 无 token 字段） | ❌ |
| 离线：标注集 / 对抗样本 | **无** | ❌ |
| 主观：1-5 分 / NPS | **无** | ❌ |
| 质量维度（非流程维度） | **无** —— 8 项指标全是「流程是否跑通」 | ❌ |

**值得表扬的一处设计**：P-003 误报空转扣除机制 —— 度量时主动扣掉误报造成的空转，这体现了对「指标可信度」的自觉。同一自觉在 `docs/BETTER_HARNESS_借鉴方案.md` 借鉴点 3（诚实性原则、未观测显式声明 `unobserved`）被进一步系统化，但**未实现**。

### 3.7 记忆机制（跨维）★★☆☆☆

文献的三层记忆 vs 本项目：

| 文献 | 定义 | 本项目 |
|---|---|---|
| **L1** 会话记忆 | 主观、当轮 | 无（Phase summary 勉强算，但不是记忆语义） |
| **L2** 事实记忆 | 客观可查 | 无 |
| **L3** 行为记忆 | 客观需聚合 | 🟡 `failure-patterns.json` 是唯一实现，但只存「失败」不存「成功偏好」 |

四项高级机制**全部缺失**：

- **记忆对账**（矛盾累计 ≥3 次主动提示）—— 无
- **非对称信任度进化**（采纳+效果好 +0.05 / 采纳+效果差 -0.10 / 拒绝但 Agent 对 +0.03 / 拒绝且主播对 -0.05）—— 无
- **输出形态随 trust_score 自适应**（≥0.7 Recommend / 0.4-0.7 Evidence+弱参考 / <0.4 仅 Evidence）—— 无
- **多因子加权衰减遗忘** —— 无。`failure-patterns.json` 只增不减，`occurrences` 单调递增（107 次那条已经是历史包袱，即使问题已修也不会衰减）

`services/experience.js`（393 行）的去重键是三维 `phase + failureType + rootCauseKey(前 50 字符)`。这个设计合理，但有一处**注释与实现偏差**（非本次引入，仅记录）：

> 注释声称经验库位于 `~/.codebuddy/experience/`（全局跨项目共享），实际 `EXPERIENCE_DIR = path.join(__dirname, '..', 'experience')`（插件内，随插件走）

这个偏差有实际影响：**经验无法跨项目累积**，插件更新可能覆盖经验库。

---

## 4. 优化方案

### 4.A A 类：已设计未实现（8 项，不重复论证，只列兑现清单）

这 8 项的「为什么做」在对应设计文档里已论证充分，此处只回答「还差什么」。

| # | 项 | 设计出处 | 待建文件 | 关键改动点 |
|---|---|---|---|---|
| A1 | 动态工作流图 | `DYNAMIC_WORKFLOW_设计方案.md` | `scripts/lib/wf-graph.js` | 用 `workflow-def.json` 描述 Phase 拓扑，替代 `advance-phase.js:690` 的硬编码 `+1` |
| A2 | 副作用隔离层 | 同上 | `scripts/lib/effects.js` | 把文件写 / execSync 收敛到单层，便于测试与审计 |
| A3 | 门控注册表 | 同上 | `scripts/lib/gates.js` | 见 4.C.3，与 A1 共享 |
| A4 | 工作流定义 | 同上 | `workflow-def.json` | Phase 拓扑 + 产出物 + 门控三者的声明式绑定 |
| A5 | 五维评分落地 | `BETTER_HARNESS_借鉴方案.md` 借鉴点 1 | 改 `audit/metrics-aggregator.js` | 输出 `loop-insights.json`，缺失证据显式标 `unobserved` |
| A6 | 跨 Story 趋势库 | 同上 借鉴点 2 | `scripts/audit/trend-store.js` | 归档时追加而非重置；`harness trend <metric>` CLI |
| A7 | findings 证据契约 | 同上 借鉴点 5 | `schemas/findings.schema.json` | `id/dimension/severity/evidence/fixAction/scopedFiles`；`--fix-loop` 读 `scopedFiles` 自动生成 dev-pass 限域 |
| A8 | 前馈区块 | 同上 借鉴点 6 | 改 `services/prompt-builder.js` | 见 4.B.2，本方案给出更具体的落地形态 |

> **A7 与 4.B.2 存在协同**：A7 的 `scopedFiles` 正是 4.B.2 白名单的数据来源。若两项一起做，可省一半工作量。

### 4.B B 类：本次诊断新发现（3 项，全部 P0）

#### 4.B.1 结构化错误生产端下沉 —— 唯一有完整因果链证据的改动

**问题**：45 处 `errors.push` 全是裸字符串，0 处 `structuredError`（见 2.3）。类型信息在生产时丢弃，消费时靠中文关键词猜。实测代价：2 条 `unknown` × 7 次 = 14 次无恢复建议且至今 pending。

**改动点**（按优先次序）：

1. **`lib/state.js` — 先改 3 行，不是 45 行**。优先改造 2.3 列出的 L1016 / L1024 / L1026，因为它们是唯一有实测损失的三条：
   ```js
   // 改造前
   result.errors.push(`${prefix}: 跨项目 task 必须有 description 字段`)
   // 改造后
   result.errors.push(structuredError(
     'cross_project_task_missing_description',
     `${prefix}: 跨项目 task 必须有 description 字段`,
     2,                                    // L2 提示级
     '在 task-dag.json 中为该 task 补充 description，需含具体改动位置'
   ))
   ```
2. **`services/policy.js` — 补 `RECOVERY_SUGGESTIONS` 条目**，覆盖新增的 3 个 type。
3. **`services/experience.js` — 增 `confirmUnknownPattern(phase, rootCauseKey, newType)`**，把 `failure-patterns.json` 里已存在的 pending 记录回填正确 type，并置 `reviewStatus: 'confirmed'`。**否则历史的 14 次记录仍是 unknown**，改造效果不可见。
4. **剩余 42 处分批迁移**，按 `failure-patterns.json` 的实际命中频次排序，不要一次改完。

**兼容性关键**：`errorToType` 必须保留 —— 它是旧数据的兼容层。新代码走 `structuredError`，旧记录仍靠反推。**双轨并存是正确终态，不是过渡态**（外部传入的错误永远需要反推能力）。

**验收标准**：改造后重跑一次含跨项目 task 的 Story，`failure-patterns.json` 不再新增 `failureType: "unknown"` 记录。

#### 4.B.2 Phase 2 前馈白名单 —— 直击 146 次痛点

**问题**：`dev_pass_scope_violation` 146 次，占全部失败 70%+。现有机制是**纯事后拦截**：Agent 尝试写 → PreToolUse 拦 → 报错 → 重试。**从未在 Agent 动手前告知允许写哪些文件。**

**改动点**：

1. **`services/prompt-builder.js` 新增 `buildWritableFilesSection(storyId, taskId)`**：从 `task-dag.json` 读取当前 task 的 `files` 数组，渲染为显式白名单：
   ```markdown
   ## 📝 本任务可写文件白名单（唯一允许修改的文件）
   1. `src/views/xxx/Foo.vue`
   2. `src/api/bar.ts`

   ⛔ 白名单外的任何文件修改都会被 enforce-dev-pass 钩子拦截。
   若确需修改白名单外文件 → 停止并向主 Agent 报告，由任务规划师更新 task-dag.json，禁止自行绕过。
   ```
2. **`AGENT_CONSTRAINTS` 增第 6 条铁律**（现有 5 条）：「只允许修改可写文件白名单内的文件；需要越界时上报而非绕过」。
3. **`hooks/enforce-dev-pass.js` 的拦截消息附上白名单**。现在的报错只说「限域外」，不说「限域内是哪些」—— Agent 得不到纠正所需的信息，只能盲试。这一处改动最小、收益最直接。

**为什么这是 P0 而非 P1**：146 次 × 每次至少一轮往返，是全项目最大的确定性浪费。而改动面只有 3 个文件、无状态机风险。

**验收标准**：新 Story 的 Phase 2 中 `dev_pass_scope_violation` 单 Story 发生次数从两位数降到个位数。

#### 4.B.3 trace 补 token 与耗时 —— 为 V 维度铺数据底座

**问题**：`lib/trace.js` 无 token、无耗时字段（见 2.6），导致文献第 9 节的成本 / 延迟指标在本项目**无数据基础**。同时 JSDoc 声明的 `tool_call` / `agent_message` 两种事件**无对应函数**。

**改动点**：

1. **`lib/trace.js` 新增 `traceToolCall(...)` 与 `traceAgentResult(...)`**，补齐 JSDoc 已声明但缺失的两个函数。
2. 所有事件统一增三字段：`durationMs`、`inputTokens`、`outputTokens`。
3. **`hooks/hooks.json` 的 `PostToolUse` 匹配器从 `execute_command` 扩到 `Write|Edit|write_to_file|replace_in_file`** —— 当前 Write/Edit 结果完全不被记录。
4. **`audit/metrics-aggregator.js` 增两项指标**：`avgPhaseDurationMs`、`totalTokensPerStory`。

**诚实性硬要求（不可妥协）**：宿主未提供 token 数据时，**字段写 `null`，绝不用 0 冒充**。metrics 遇 `null` 输出 `status: 'unobserved'` 而非 `0`。这与 A5（借鉴点 3 诚实性原则）是同一原则的两个落点 —— **一个 0 会污染所有历史趋势，且无法事后区分「真的 0」和「没测到」**。

### 4.C C 类：淘宝文献独有机制（6 项）

#### 4.C.1 每轮 system-hint 注入（P1，性价比最高）

**问题**：state 只在 SessionStart 注入一次（见 3.4）。

**改动点**：

1. **抽出 `services/state-hint.js`**，把 `hooks/session-start.js` 的 `buildAdditionalContext()` 移入并导出。
2. **`hooks/hooks.json` 新增 `UserPromptSubmit` 钩子** → 调用 `state-hint.js` 的**精简版**（只注入 Phase 编号 / status / 未解决 open-questions 数 / 5 条铁律，**不重复注入产出物摘要与契约全文**）。
3. `session-start.js` 改为调用 `state-hint.js` 的完整版。

**必须共用同一模块，不能各写一份** —— 否则就是在制造 `context-refresh.js:100-105` 注释里记录过的那类漂移（第二份映射表与信源不一致）。这条注释是本项目自己的教训，不该再犯第二次。

**注意事项**：每轮注入会持续消耗 token。精简版应控制在 ~30 行内，且必须**先做 4.B.3**（否则无法度量这项改动的成本代价）。

#### 4.C.2 错误码分段与重试策略编译期绑定（P1）

**改动点**：`services/policy.js` 的 `RECOVERY_SUGGESTIONS` 每条增 `code` 与 `retry` 两字段：

| 段 | 语义 | retry 策略 |
|---|---|---|
| `3xxx` | 业务错误（如门控不通过） | `{ mode: 'change_strategy', max: 0 }` |
| `4xxx` | 参数 / Schema 错误 | `{ mode: 'auto_fix', max: 1 }` |
| `5xxx` | 系统 / IO 错误 | `{ mode: 'exponential_backoff', max: 3, baseMs: 1000 }` |
| `9xxx` | 不可恢复 | `{ mode: 'notify_human', max: 0 }` |

映射到现有四级恢复：3xxx→L2、4xxx→L1、5xxx→L1（带退避）、9xxx→L4。**现有四级不必推翻，是给它补上「重试语义」。**

**依赖 4.B.1** —— 没有生产端的 type，就没有可挂 code 的锚点。顺序不能反。

#### 4.C.3 门控注册表补齐 Phase 2 / 5 / 7（P1）

**问题**：门控覆盖 4/9，且违规最多的 Phase 2 无门控（见 2.4）。

**改动点**：`services/policy.js` 增 `PHASE_GATES` 映射表：

```js
const PHASE_GATES = {
  0: checkPhase0Gate,
  1: checkPhase1Gate,
  2: checkPhase2Gate,   // 新增：dev-pass 限域声明完整性 + task-dag files 非空
  3: checkPhase3Gate,
  4: checkPhase4Gate,
  5: checkPhase5Gate,   // 新增：open-questions 全部 resolved（对应已确认的 open_questions_never_resolved 模式）
  6: null,              // 显式声明无门控，而非遗漏
  7: checkPhase7Gate,   // 新增：发布前 Git 状态干净 + 无未修复 BLOCKER
  8: null
}
```

**`6: null` 的显式声明很重要** —— 区分「设计上无门控」与「忘了写」。当前 5 个缺口无法区分这两种情况。

Phase 5 门控有实证依据：`failure-patterns.json` 中 `open_questions_never_resolved` 已是 confirmed 模式。

#### 4.C.4 语义化截断替代行数/字符硬截断（P2）

**问题**：`loadLatestSummary` 按行截断（`maxLines=200`）、`prompt-builder.js` 按字符截断（3000 / 6000），都可能切在 JSON 或表格中间（见 3.3）。

**改动点**：

1. **markdown 内容按 `## ` 标题边界截断**，宁可少给一节，不给半节。
2. **JSON 契约超限时不截断，改为「摘要 + 完整文件路径」**：给出条目数与关键字段清单，让 Agent 需要时自己 Read。这与文献「大上下文外挂只留 fileKey + 预览」是同一思路的轻量版 —— **本项目有本地文件系统，不需要 OSS**。
3. `trace.jsonl` 的 tool_call 事件按工具名聚合计数，而非逐条保留。

#### 4.C.5 Checkpoint 快照与 Reducer 收敛（P2）

**问题**：状态迁移散在 3 个分支、无快照（见 2.5）。

**改动点**：

1. **`lib/state.js` 增纯函数 `applyTransition(state, action)`**，`action` 形如 `{ type: 'ADVANCE'|'ROLLBACK'|'FIX_LOOP', targetPhase, reason }`。`advance-phase.js` 的 3 处分支全部改为构造 action 后调用它。**这是把「单一信源」从文件层面推进到函数层面。**
2. **`writeStateFile` 前把旧 state 与产出物清单存入 `.codebuddy/plans/<storyId>/checkpoints/phase-N.json`**。
3. `advance-phase.js` 增 `--restore <phase>`，把 `--rollback`（只改指针）升级为真回滚（恢复产出物）。

**风险提示**：这是本方案唯一触及状态机核心的改动。**必须先有单测覆盖 `applyTransition` 的 3 条路径再切换调用点**，否则会破坏 8 Phase 主链路 —— 这也是 `docs/BETTER_HARNESS_借鉴方案.md` 末句的要求。

#### 4.C.6 记忆信任度与衰减遗忘（P3，只取两个切片）

**问题**：`failure-patterns.json` 只增不减，`occurrences` 单调递增。107 次那条即使问题已修，权重仍是最高，会持续污染经验推荐。

**改动点**（**只移植两项，不移植三层记忆全套**）：

1. **非对称奖惩**：`services/experience.js` 增 `confidence` 字段。模式被引用且成功规避 → `+0.05`；被引用但仍失败 → `-0.10`（**惩罚重于奖励**，这是文献非对称设计的核心，防止经验库自我强化错误结论）。
2. **衰减遗忘**：增 `lastSeenAt`。超 90 天未复现的模式 `confidence *= 0.8`；低于 0.2 移入 `failure-patterns.archive.json`（**归档不删除** —— 删除会丢失「这个问题曾经存在」的信息）。

**顺带修一个偏差**：3.7 提到 `experience.js` 注释声称 `~/.codebuddy/experience/` 但实际在插件内。**要么改注释、要么改实现，二者必须一致。** 建议改实现（迁到用户目录），理由是插件更新不该覆盖经验库 —— 但这会改变数据位置，需要一次迁移脚本。

---

## 5. 实施顺序

### 5.1 排序原则

按 **(实测损失 × 改动确定性) ÷ 状态机风险** 排序，不按维度成熟度排序。理由：3.2 显示 T 维度最薄弱（★★），但 T 的缺失（无幂等键、无退避）在本项目**尚无一条实测失败记录**；而 Phase 2 限域违规有 146 次实测损失。**照维度短板排序会先做没痛感的事。**

### 5.2 顺序表

| 批次 | 项 | 触及文件 | 状态机风险 | 前置依赖 | 验收信号 |
|---|---|---|---|---|---|
| **第 1 批** | 4.B.2 前馈白名单 | `prompt-builder.js`、`enforce-dev-pass.js` | 无 | 无 | 单 Story `dev_pass_scope_violation` 降至个位数 |
| | 4.B.1 结构化错误（先 3 行） | `state.js` L1016/1024/1026、`policy.js`、`experience.js` | 无 | 无 | 不再新增 `unknown` 记录 |
| | 4.B.3 trace 补字段 | `trace.js`、`hooks.json`、`metrics-aggregator.js` | 无 | 无 | metrics 出现 duration / token 两项（或显式 `unobserved`） |
| **第 2 批** | 4.C.1 每轮 hint | 新建 `state-hint.js`、改 `hooks.json`、`session-start.js` | 低 | **4.B.3**（要能度量成本） | 长会话中 Agent 不再遗忘 Phase 铁律 |
| | 4.C.3 门控注册表 | `policy.js` | 低 | 无 | 9 个 Phase 全部有明确门控或显式 `null` |
| | 4.C.2 错误码绑定 | `policy.js` | 低 | **4.B.1**（需要 type 锚点） | 5xxx 类错误出现退避重试记录 |
| | A5 + A7 五维评分 + findings 契约 | `metrics-aggregator.js`、新建 `findings.schema.json` | 低 | 4.B.3 | `loop-insights.json` 产出，含 `unobserved` 标注 |
| **第 3 批** | 4.B.1 剩余 42 处迁移 | `state.js` | 无 | 第 1 批 | — |
| | 4.C.4 语义化截断 | `context-refresh.js`、`prompt-builder.js` | 低 | 无 | 下游 Agent 不再读到残缺 JSON / 表格 |
| | A6 趋势库 | 新建 `trend-store.js` | 低 | A5 | `harness trend <metric>` 可用 |
| **第 4 批** | 4.C.5 Checkpoint + Reducer | `state.js`、`advance-phase.js` | **高** | **单测先行** | `--restore` 可恢复产出物；3 条路径单测绿 |
| | A1–A4 动态工作流 | 新建 4 文件 + 改 `advance-phase.js` | **高** | 4.C.5 | Phase 拓扑可声明式配置 |
| **第 5 批** | 4.C.6 记忆信任度 | `experience.js` | 无 | 无 | 90 天未复现模式自动降权归档 |
| | A8 前馈区块泛化 | `prompt-builder.js` | 无 | 4.B.2 | 前馈从 Phase 2 扩展到全 Phase |

### 5.3 三条硬约束

1. **第 4 批必须单测先行**。`applyTransition` 的 3 条路径（ADVANCE / ROLLBACK / FIX_LOOP）单测绿了才允许切换 `advance-phase.js` 的调用点。这是 `docs/BETTER_HARNESS_借鉴方案.md` 末句的明确要求：「先在 harness-marketplace/plugins/harness 建特性分支，单测覆盖后合并；不破坏现有 8 Phase 主链路」。
2. **A1–A4 的落地率是 0%，不是「进行中」**。569 行设计方案零实现，若第 4 批仍不动，建议**显式标注该方案为「暂缓」**而非留在 docs 里造成「已规划」的错觉。悬而未决的设计文档会持续误导后续判断。
3. **禁止跳过 4.B.3 直接做度量类改进（A5/A6）**。没有 token 与耗时的原始数据，五维评分与趋势库只能测「流程是否跑通」，重复现有 8 项指标的局限。

---

## 6. 不建议移植的部分

文献中有 5 项机制**明确不建议移植**，理由是场景前提不成立。列出它们与列出建议项同等重要 —— 避免后续把「淘宝有」当成「应该有」。

| 文献机制 | 不移植理由 |
|---|---|
| **OSS / Tair 大上下文外挂** | 淘宝面对的是跨机房分布式 Agent，需要外部对象存储做上下文卸载。本项目是**单机本地插件**，文件系统本身就是「外挂」。4.C.4 的「摘要 + 路径」已达成同等效果，引入 OSS 只增加运维成本。 |
| **MySQL + Hologres 存储分治** | 同上。淘宝需要 Hologres 做记忆的混合检索（向量 + 标量）是因为记忆规模在百万级。本项目的 `failure-patterns.json` 是 22 条，JSON 文件完全够用。**过早引入数据库是本项目最容易犯的过度工程。** |
| **沙箱隔离执行** | 淘宝的 Skill 是主播上传的用户代码，必须沙箱。本项目的 Agent 执行的是**用户自己项目的构建脚本**，用户对自己的代码有完全信任，沙箱只会阻碍正常构建。（安全边界不同：淘宝防的是第三方代码，本项目防的是 Agent 误操作 —— 后者靠 dev-pass 限域已解决。） |
| **trust_score 三档输出形态** | 文献里 `≥0.7 Recommend / 0.4-0.7 Evidence+弱参考 / <0.4 仅 Evidence` 是给**人类主播**看的，目的是让 Agent 在不确定时不要越权建议。本项目的消费者是**开发者 + 下游 Agent**，需要的是确定的结构化契约，「弱参考」这种模糊态会破坏契约的可解析性。4.C.6 只取信任度的**内部权重**用途，不取输出形态。 |
| **Langfuse 可观测平台** | 需要独立部署服务。本项目的 `trace.jsonl` + `metrics-aggregator.js` 已覆盖核心需求。若将来确需可视化，导出 OpenTelemetry 格式比绑定 Langfuse 更合适。 |

---

## 7. 一句话总结

**本项目不缺架构，缺的是把已有架构的「生产端」补齐**：

- 结构化错误的消费端写好了（`policy.js` 11 处），生产端 0 处（`state.js` 45 处裸字符串）
- state 注入的内容构造好了（`session-start.js` 七段内容质量很高），触发时机只有 1 次
- 限域拦截做好了（146 次成功拦截），前馈告知 0 次
- 门控框架做好了（4 个函数质量高），覆盖 4/9 且漏掉违规最多的 Phase 2
- DAG 数据结构有了（`task-dag.json`），Phase 推进仍是硬编码 `+1`

五条全部是同一形态：**能力已建成，接入未完成。** 这比「缺少某个大机制」好得多 —— 意味着第 1 批三项改动（触及 6 个文件、零状态机风险）就能吃掉当前 70% 以上的实测损失。



