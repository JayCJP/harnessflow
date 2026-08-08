# Harness 动态可编排工作流 — 方案设计

> 目标: 把当前"固定 8 Phase 线性流水线"扩展为"可编排的动态工作流"，
> 且**不牺牲**现有插件最核心的资产 —— 门控在 LLM 推理链之外、触发权 ≠ 决定权。
>
> 状态: 设计稿（未实现）。本文只描述做什么、为什么、怎么做、怎么迁移。
> 会话: claude --resume d0786d16-6c30-4571-a7a8-ca4c44f6e7de

---

## 〇、先说结论

**不要走"让 LLM 现场写编排脚本"这条路。**

外部主流做法（见 §2）是把一次请求编译成一段 JS 编排脚本，用 `agent()` / `parallel()` /
`pipeline()` 原语跑起来。那套东西解决的是"一次性任务的并行调度"，它天然假设
**模型有编排决定权**。而本插件的全部工程价值恰恰建立在相反的假设上：

```
dispatch.js      = 读状态 + 说下一步   （只读，零写权限）
advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）
主 Agent         = 触发                （无判断权，机械执行）
```

`STORY-20260710-01` 的教训（task-planner 直接改 `state.phase` 跳过门控 → 催生
`validatePhaseIntegrity()`）、废弃 dispatcher Agent 的理由（"判断权回流即失控"）、
prompt-builder 收口的理由（"拼接就是判断"），全部指向同一件事：
**这个插件是靠剥夺模型的决定权换来的可控性。** 直接引入"模型写编排脚本"等于全部退回去。

所以本方案的核心命题是：

> **把"编排权"和"执行期决定权"拆成两件事。**
> 编排权（定义图的拓扑）交给**设计期**的声明式定义 + 静态校验器 + 人工审批；
> 执行期决定权仍然 100% 留在脚本里 —— 运行时只做"查图"，不做"造图"。

一句话：**动态的是图，不是走图的那个人。**

---

## 一、现状诊断：固定在哪里

逐条定位到文件和行为，这些就是改造靶点。

| # | 硬编码点 | 位置 | 为什么它让流程"固定" |
|---|---------|------|---------------------|
| 1 | 拓扑 = 位置数组 | `lib/state.js` `PHASE_SLUGS` / `PHASE_NAMES` | Phase 身份 = 整数下标。`MAX_PHASE = PHASE_SLUGS.length - 1` 在 `dispatch.js:43`、`advance-phase.js` 各推导一次 |
| 2 | 节点元数据 = 字面量对象 | `lib/state.js` `PHASE_ARTIFACTS` / `PHASE_AGENTS`（键 0-7） | 产出物、Agent 绑定写死；换一套 Agent 阵容要改源码 |
| 3 | 强制 `+1` 跃迁 | `advance-phase.js` `if (targetPhase !== currentPhase + 1)` | **与任何 DAG 拓扑结构性冲突** —— 分支、跳跃、汇聚一律拒绝 |
| 4 | 门控 = if/else 阶梯 | `services/policy.js` `runGateCheck` 里 `phaseNum === 0 / 1 / 3 / 4` | 加一个节点就要改 `policy.js` |
| 5 | 副作用绑死数字 | `advance-phase.js`：dev-pass 签发@2、撤销@3、兜底撤销@5、metrics+完成@7→8 | 节点顺序一变，副作用全错位 |
| 6 | 修复回路目标写死 | `advance-phase.js --fix-loop` 目标恒为 2，来源恒为 3/4，state key 是字面量 `'2_development'`；`dispatch.js` 里 `const isReviewOrTest = phase === 3 || phase === 4` | 只有一种修复回路形状 |
| 7 | Agent 阵容单一 | `PHASE_AGENTS` 绑定固定 6 个前端 Agent | 无法切后端 / 纯测试 / hotfix 阵容 |
| 8 | 影子拓扑表（隐蔽） | `create-workflow.js` 的 `phaseKeys[]`、`context-refresh.js` 的 `baseContracts{}`、`schema-validator.js` 的 `getPhaseArtifacts()`、`prompt-builder.js` 的 `targetPhase !== 3`、`e2e-state.schema.json` 的 `"maximum": 8` | **同一份拓扑知识散落在多个文件里各写一遍。** 这是最危险的一条：改拓扑要同步多处，漏一处就静默错位。<br>已消除：`context-refresh.js` 的 `phaseFiles{}` 改读 `PHASE_ARTIFACTS`；`getNextSteps{}`（第二份 Phase→Agent 映射）已删除 |

第 8 条决定了改造顺序 —— **必须先收口，再动态化**。否则动态化只是把 1 份硬编码变成 6 份不一致的动态配置。

---

## 二、外部调研：学到什么、不学什么

### 2.1 Claude Code 系 —— 动态编排原语

- [FlorianBruniaux/claude-code-ultimate-guide — Dynamic Workflows](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/guide/workflows/dynamic-workflows.md)：动态工作流 = 一个 JS 文件，用 `agent` / `parallel` / `pipeline` / `phase` 原语编排子 Agent。
- [anthropics/claude-code issue #66032](https://github.com/anthropics/claude-code/issues/66032)：Workflow 工具执行 `.claude/workflows/*.js` 里的**确定性编排脚本**，`parallel()` 扇出、`pipeline()` 流水。
- [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex)：模型先写编排脚本，再由 `agent()` 原语跨数十个 Agent 执行。
- [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)：一次请求 → 一段 JS 编排脚本，扇出到隔离子 Agent，按任务路由到不同模型。
- [barkain/claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration)：用 hook 强制任务委派给专职 Agent。
- [zb-ss/claude-plugin-workflow](https://github.com/zb-ss/claude-plugin-workflow)：分层 Agent + 执行模式，状态记在 Markdown / org-mode。
- [Medium — What Makes Claude's New Dynamic Workflows Different](https://medium.com/data-science-collective/claudes-new-dynamic-workflows-changed-how-i-think-about-ai-coding-e1dc7649e516)：关键动作是"先生成编排脚本"，而不是立刻开始 spawn。
- [Reddit r/ClaudeAI — plugin for orchestrating workflows](https://www.reddit.com/r/ClaudeAI/comments/1s4pawa/claude_code_plugin_for_orchestrating_workflows/)：Conductor 式编排。

**学**：`parallel()`（栅栏，等齐）与 `pipeline()`（无栅栏，逐项穿过各阶段）这组区分，是描述"批次内并行 / 批次间串行"最精确的语言 —— 正好对应本插件 Phase 2 的 Fork-Join。
**不学**：让模型现场生成编排脚本（理由见 §0）。

### 2.2 传统工作流引擎 —— 图的正确长相

- [Argo Workflows — dag-daemon-retry-strategy.yaml](https://github.com/argoproj/argo-workflows/blob/main/examples/dag-daemon-retry-strategy.yaml)：YAML 声明 DAG，节点用 `depends` 表达边，模板级 `retryStrategy { limit }`。**YAML/JSON 定义的工作流改动不需要重新部署引擎** —— 这正是我们要的"改流程不改代码"。
- [Apache Seata — Saga 模式](https://seata.apache.org/docs/user/mode/saga/)：状态机 DSL，**每个节点可配置补偿节点**；异常时逆序执行已成功节点的补偿。同时提供**回滚恢复**与**向前恢复**两个方向。
- [orieg/yaml-workflow](https://github.com/orieg/yaml-workflow) 与其[错误处理指南](https://orieg.github.io/yaml-workflow/guide/error-handling/)：每步 `on_error { action: retry | fail | continue | next, retry, delay, message }`。把失败处理建模成**枚举**而非单一重试次数。
- [Dapr — Workflow patterns](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/)：扇出/扇入、监视器、外部事件等标准模式。
- [Workflow Engine vs. State Machine](https://workflowengine.io/blog/workflow-engine-vs-state-machine/)：工作流引擎在上一步完成时自动跃迁（确定性），状态机需外部事件驱动（灵活但异步）。
- [Code-First Workflow Engines: Architectural Patterns](https://www.val.town/x/nbbaier/wrkflw/code/workflow-engines-research-report.md)：Temporal / Airflow / Prefect / Dagster 表面差异很大，但**都收敛到"面向 DAG 的 DSL + 状态机运行时 + 编排与执行分离"**。

**这才是本方案的主要参照系。** 主流答案不是"生成脚本"，而是**声明式 DAG + 持久化状态机运行时**。本插件已经有一个相当扎实的状态机运行时（`advance-phase.js` + `policy.js` + trace），缺的只是它上面那层声明式 DAG。

---

## 三、总体架构

```
┌─ 设计期（Design Time）── 编排权在这里，且必须经过校验和人工确认 ──────┐
│                                                                        │
│   workflow-templates/*.workflow.json    ← 内置模板（随插件发布）         │
│   .codebuddy/workflows/*.workflow.json  ← 项目自定义模板                 │
│              │                                                          │
│              ├─ /harness compose  ← AI 可辅助起草，但产物是【数据】      │
│              │                       不是可执行代码，必须过 linter      │
│              ▼                                                          │
│   wf-lint.js  ← 静态校验器：Schema + 图可达性 + 无环 + 能力闭合 +        │
│                  门控/副作用/Agent 全部已注册 → 不过不给用             │
└────────────────────────────────────────────────────────────────────────┘
                               │  编译产物: workflow.lock.json（钉进 Story 目录）
                               ▼
┌─ 执行期（Run Time）── 决定权 100% 在脚本，模型只有触发权 ───────────────┐
│                                                                        │
│   wf-graph.js       图查询：节点/边/入度出度/合法后继（纯函数，只读）     │
│   dispatch.js       读状态 + 查图 → 说下一步（只读，零写权限）           │
│   advance-phase.js  验边合法性 + 跑门控 + 执行副作用 + 写状态（唯一写者） │
│   policy.js         门控注册表查表（不再是 if/else 阶梯）                │
│   effects.js        副作用注册表查表（dev-pass / metrics / lint ...）    │
│   主 Agent          触发（无判断权，机械执行）                           │
└────────────────────────────────────────────────────────────────────────┘
```

三条铁律，一条都不放松：

1. **运行时不产生新拓扑。** Story 一旦启动，`workflow.lock.json` 冻结；改流程要显式重开或显式 `--rebase-workflow`（写 trace、要人确认）。
2. **模型不能写 lock 文件。** 与 `e2e-state.json` / `dev-pass.json` 同级保护，`enforce-state-file.js` 加一条匹配。
3. **未注册即不可用。** 模板里出现任何未在注册表登记的 gate / effect / agent → linter 直接拒绝。杜绝"模板里写个字符串就能执行任意行为"。

> 新增的 **编排权** 不是把决定权还给模型，而是把它挪到**设计期**，并在那里加上
> Schema 校验 + 图校验 + 能力白名单 + 人工确认四道闸。运行期的权力分配一个字没改。

---

## 四、工作流定义（WFD）Schema

### 4.1 顶层结构

```jsonc
{
  "$schema": "harness://workflow/v1",
  "id": "frontend-standard",
  "version": "1.0.0",
  "name": "前端标准流程",
  "description": "需求分析 → 任务规划 → 开发 → 审查 → 测试 → 提交 → 知识库 → 部署",
  "entry": "requirement_analysis",
  "terminal": ["completed"],

  "defaults": {
    "maxFixRounds": 2,
    "onFail": { "action": "block", "level": 4 }
  },

  "nodes": [ /* 见 4.2 */ ],
  "edges": [ /* 见 4.3 */ ]
}
```

**关键决策：节点用字符串 `id`，不用整数。** 这是整个方案的地基。
整数下标隐含"全序"，全序隐含"+1 跃迁"，`+1` 跃迁排斥一切非线性拓扑。
换成命名节点后，"下一个"从算术运算变成图查询。

### 4.2 节点定义

```jsonc
{
  "id": "development",
  "label": "代码开发",
  "type": "agent",              // agent | fanout | join | checkpoint | terminal

  "agent": {
    "name": "frontend-developer",
    "label": "前端开发工程师",
    "instruction": "按 task-dag.json 的批次执行开发任务……"
  },

  "artifacts": [
    { "fileName": null, "description": "代码变更（git diff）", "contract": false }
  ],

  "gates": ["artifact-exists", "schema-valid"],   // ← 门控注册表里的 id

  "effects": {
    "onEnter": [
      { "id": "issue-dev-pass", "with": { "scopeFrom": "task-dag.json" } }
    ],
    "onExit": [
      { "id": "revoke-dev-pass" },
      { "id": "eslint-fix", "when": "flags.lintFix" }
    ]
  },

  "context": {
    "contracts": ["task-dag.json", "acceptance-criteria.json"],
    "summaryFrom": "task_planning"
  },

  "fanout": {                    // 仅 type=fanout
    "mode": "pipeline",          // parallel(栅栏) | pipeline(无栅栏)
    "itemsFrom": "task-dag.json#/batches",
    "maxConcurrency": 4
  }
}
```

设计说明：

- `gates` / `effects[].id` 都是**注册表 key**，不是代码。模板是纯数据，不含可执行逻辑 —— 这条约束让"模型辅助起草模板"变得安全。
- `effects` 分 `onEnter` / `onExit`，直接吸收 `advance-phase.js` 里那堆 `if (targetPhase === 2)` 的副作用。dev-pass 的签发/撤销从"藏在推进函数里的 if"变成"节点上的显式声明"。
- `context.contracts` / `summaryFrom` 收编 `context-refresh.js` 的 `baseContracts{}`，消灭影子拓扑表（诊断 #8）。
- `fanout.mode` 直接借用调研里的 `parallel` / `pipeline` 语义 —— Phase 2 现在是"batch 内并行、batch 间串行"，正是 `pipeline`。

### 4.3 边定义

```jsonc
{
  "edges": [
    { "from": "requirement_analysis", "to": "task_planning" },
    { "from": "task_planning",        "to": "development" },
    { "from": "development",          "to": "code_review" },

    // 条件分支：门控结果驱动，条件是【注册的谓词 id】，不是任意表达式
    { "from": "code_review", "to": "e2e_verification", "when": "gate.passed" },
    { "from": "code_review", "to": "development",
      "when": "gate.hasBlocker",
      "kind": "fix_loop",
      "fixLoop": {
        "maxRounds": 2,
        "issuesFrom": ["code-review.json"],
        "scopeFrom": "affectedFiles",
        "onExhausted": { "action": "escalate", "level": 4 }
      }
    },

    { "from": "e2e_verification", "to": "git_submit", "when": "gate.passed" },
    { "from": "e2e_verification", "to": "development",
      "when": "gate.hasFailedAC", "kind": "fix_loop",
      "fixLoop": { "maxRounds": 2, "issuesFrom": ["acceptance-verification.json", "test-report.md"] } },

    { "from": "git_submit",           "to": "knowledge_base_update" },
    { "from": "knowledge_base_update", "to": "deployment" },
    { "from": "deployment",           "to": "completed" }
  ]
}
```

- `when` 只能取**注册谓词**：`gate.passed` / `gate.hasBlocker` / `gate.hasFailedAC` / `flags.<name>` / `state.<field>` 等。**不支持任意表达式求值** —— 模板是数据不是代码，不给注入面。
- `kind: "fix_loop"` 把修复回路从"硬编码回 Phase 2"泛化成**一类边**。`dispatch.js` 里那句 `phase === 3 || phase === 4` 消失，改为"当前节点存在 kind=fix_loop 的可用出边"。
- `--rollback` 同理归为 `kind: "rollback"` 边（逆向恢复），与 Seata 的**回滚恢复 / 向前恢复**双向语义对齐。

### 4.4 Phase 2 的 Fork-Join 用图表达

现在 Phase 2 的并行是"prompt 里让主 Agent 自己按 batch spawn"，图化之后可以显式：

```jsonc
{ "id": "dev_fanout", "type": "fanout",
  "fanout": { "mode": "pipeline", "itemsFrom": "task-dag.json#/batches", "maxConcurrency": 4 },
  "body": "development_unit" },
{ "id": "development_unit", "type": "agent", "agent": { "name": "frontend-developer" } },
{ "id": "dev_join", "type": "join", "joinPolicy": "all-success" }
```

价值不在于"能并行"（现在也能），而在于**并行结构变成可校验、可追踪、可度量的一等公民** ——
`trace.jsonl` 能记录每个分支，`metrics-aggregator` 能算真实并行度，
不再依赖主 Agent 读 `task-dag.json` 后的自由发挥。

---

## 五、运行时改造

### 5.1 `wf-graph.js`（新增，纯只读）

图的唯一查询入口。所有拓扑问题都问它，不许任何人自己推。

```js
loadWorkflow(storyId)          // 读 Story 的 workflow.lock.json，无则回落内置默认模板
getNode(wf, nodeId)
getOutEdges(wf, nodeId)
resolveNext(wf, nodeId, ctx)   // ctx = { gate, state, flags } → 匹配 when → 合法后继（可多条）
isLegalEdge(wf, from, to)      // 替代 targetPhase === currentPhase + 1
isTerminal(wf, nodeId)
topoOrder(wf)                  // 供 UI / summary / 兼容层的 phaseIndex 使用
validate(wf)                   // linter 内核：无环、可达、终态可达、能力闭合
```

### 5.2 `advance-phase.js` 的两道防线：保住，但泛化

现在的两道防线是"范围检查 + `+1` 检查"。改造后：

```js
// 防线 1（不变）: 目标节点必须存在于图中
if (!wfGraph.getNode(wf, targetNode)) reject('unknown_node')

// 防线 2（泛化，语义等价、能力更强）:
//   原: targetPhase === currentPhase + 1
//   新: 目标必须是当前节点在【当前 ctx】下的合法后继
const legal = wfGraph.resolveNext(wf, currentNode, { gate, state, flags })
if (!legal.some(e => e.to === targetNode)) reject('illegal_transition')
```

**这一步是整个方案里最需要说清楚的地方**：`+1` 规则的真实作用不是"限制成线性"，
而是"**不信任调用方传入的目标**"。泛化后这个不信任一点没减 ——
主 Agent 传什么都要过 `resolveNext` 的裁定，只是"合法后继"的定义从算术变成查图。
线性模板下 `resolveNext` 恰好只返回一个后继，行为与今天**逐字节等价**。

`validatePhaseIntegrity()` 同样保留：把"`phases.N_*` 已 completed 但 `state.phase` 落后"
的检测改为"`nodes.<id>.status` 已 completed 但 `state.currentNode` 不在其后继集合中"。

### 5.3 `policy.js`：if/else 阶梯 → 门控注册表

```js
const GATE_REGISTRY = {
  'artifact-exists':      { fn: gateArtifactExists,     appliesTo: 'any' },
  'schema-valid':         { fn: gateSchemaValid,        appliesTo: 'any' },
  'ac-contract':          { fn: gateAcceptanceCriteria, produces: ['ac_format_error', 'ac_missing_id', ...] },
  'open-questions':       { fn: gateOpenQuestions,      produces: ['open_questions_unresolved'] },
  'task-dag-contract':    { fn: gateTaskDag,            produces: ['task_missing_id', 'orphan_ac', ...] },
  'code-review-blocker':  { fn: gateCodeReviewBlocker,  produces: ['code_review_blocker'] },
  'acceptance-verified':  { fn: gateAcceptanceVerified, produces: ['ac_verification_failed'] },
  'figma-inventory':      { fn: gateFigmaInventory,     when: 'state.hasFigmaDesign' }
}

function runGateCheck (storyId, nodeId, state) {
  const node = wfGraph.getNode(loadWorkflow(storyId), nodeId)
  const result = emptyResult()
  for (const gateId of node.gates || []) {
    const g = GATE_REGISTRY[gateId]
    if (!g) return fatal(`未注册门控: ${gateId}`)   // fail-closed
    if (g.when && !evalPredicate(g.when, state)) continue
    g.fn(storyId, state, result, node)
  }
  attachRecoveries(result)   // RECOVERY_SUGGESTIONS 完全不动
  return result
}
```

`RECOVERY_SUGGESTIONS`（那张按 `failureType` 索引的大表）、`level 1-4` 分级、
`structuredError` 结构**全部原样保留**。改的只是"谁在什么时候被调用"，不改"失败怎么处理"。
`produces` 字段是新增的可选元数据，给 linter 用来验证 failureType 全部已注册。

### 5.4 `effects.js`（新增）：副作用注册表

把 `advance-phase.js` 里散落的 `if (targetPhase === N)` 收进白名单：

```js
const EFFECT_REGISTRY = {
  'issue-dev-pass':   { fn: effIssueDevPass,   writes: ['dev-pass.json'] },
  'revoke-dev-pass':  { fn: effRevokeDevPass,  writes: ['dev-pass.json'] },
  'eslint-fix':       { fn: effEslintFix,      writes: ['<repo>/src/**'] },
  'aggregate-metrics':{ fn: effAggregateMetrics, writes: ['metrics-insights.json', 'loop-insights.json'] },
  'generate-summary': { fn: effGenerateSummary,  writes: ['phase-*-summary.md'] },
  'mark-completed':   { fn: effMarkCompleted,    writes: ['e2e-state.json'] }
}
```

`writes` 声明让审计能回答"这条流程一共会动哪些文件"，而不必读代码。
**副作用只能从注册表里选**，模板写不出新副作用 —— 这是"模板是数据"的兑现方式。

### 5.5 `dispatch.js`：四态不变，判断依据换成图

四态（`ready` / `blocked` / `fix_loop` / `terminal`）**互斥且穷尽的契约保持不变** ——
主 Agent 的三步循环和 `harness-conductor` SKILL 的执行流程**一个字不用改**。变的只有内部：

| 原逻辑 | 新逻辑 |
|--------|--------|
| `phase > MAX_PHASE - 1` → terminal | `wfGraph.isTerminal(wf, currentNode)` |
| `phase === 3 \|\| phase === 4` 且 fixLoopAvailable → fix_loop | 存在 `kind=fix_loop` 且 `when` 成立的出边 → fix_loop |
| `advanceCommand = ... ${phase + 1}` | `advanceCommand = ... ${resolveNext(...)[0].to}` |
| 多后继时 | 输出 `choices[]`，**由 gate 谓词裁定，不让主 Agent 选**；若谓词无法唯一裁定 → `blocked` + `recovery` 转人工 |

最后一行是关键安全阀：**图可以有分叉，但运行时永远不能出现"要模型选一条"的时刻。**
分叉必须由确定性谓词消解；消解不了就停下问人。

### 5.6 状态文件演进

```jsonc
{
  "storyId": "STORY-20260803-01",
  "workflow": { "id": "frontend-standard", "version": "1.0.0", "lock": "workflow.lock.json" },
  "currentNode": "development",
  "phase": 2,                    // ← 兼容字段：topoOrder 中的序号，只写不读
  "status": "running",
  "nodes": {
    "requirement_analysis": { "status": "completed", "completedAt": "..." },
    "task_planning":        { "status": "completed" },
    "development":          { "status": "running", "fixRound": 1 }
  },
  "phases": { "0_requirement_analysis": { "status": "completed" } }  // ← 兼容字段，双写
}
```

`phase` 与 `phases` 保留为**只写不读**的兼容投影（由 `topoOrder` 计算），
让 `metrics-aggregator` / `harness-audit` / 历史 Story 在迁移期继续工作。
`e2e-state.schema.json` 的 `phase.maximum: 8` 放开为 `minimum: 0`。

---

## 六、模板库

随插件内置，覆盖真实场景；用户可复制改造。

| 模板 id | 场景 | 拓扑要点 |
|---------|------|---------|
| `frontend-standard` | 现有 8 Phase | 与今天**行为完全等价**，作为迁移基准和回归基线 |
| `hotfix` | 紧急修复 | 入口直接 `development`，跳过分析/规划；保留审查+测试；收编现有 `--bypass` |
| `bugfix` | `/harness fixbugs` | `bug_analysis → development → code_review → e2e → submit`，无部署 |
| `fullstack` | 前后端协同 | `task_planning` 后 `fanout` 到 `frontend-developer` + `backend-developer`，`join` 后统一审查 |
| `review-only` | 存量代码审计 | `code_review → 输出报告`，无 dev-pass、无提交 |
| `spike` | 技术预研 | `requirement_analysis → prototype → 归档`，不进主干 |

模板解决的是诊断 #7（Agent 阵容单一）：换阵容 = 换模板，不改源码。

---

## 七、`/harness compose` —— AI 辅助编排，但受四道闸

这是唯一让模型参与编排的入口，也是最需要小心的地方。

```
用户: /harness compose "这次只要改后端接口，不用前端开发，但要跑契约测试"
  │
  ├─ 1. AI 读模板库 + 节点能力清单（gate/effect/agent 注册表），起草 workflow.json
  │       ⚠ 产出【纯数据】，不含任何可执行代码
  │
  ├─ 2. wf-lint.js 静态校验（不过则打回，最多重试 2 次，超限转人工）
  │       ├─ JSON Schema 合规
  │       ├─ 图性质: 无环 / entry 可达所有节点 / 所有节点可达 terminal
  │       ├─ 能力闭合: 引用的 gate/effect/agent 全部已注册
  │       ├─ 契约闭合: 节点 context.contracts 必由某前驱节点的 artifacts 产出
  │       └─ 安全: 无自定义表达式；写 e2e-state/dev-pass 的 effect 必须来自注册表
  │
  ├─ 3. 渲染为人类可读的 Mermaid 图 + 差异对比（vs 最接近的内置模板）
  │
  └─ 4. 人工确认 → 写入 .codebuddy/workflows/<id>.workflow.json + trace 记录
          未确认 → 不落盘
```

**闸门的本质**：模型能提议的一切，都必须落在预先注册的能力集合之内。
它组合积木，但不能造新积木；造新积木（新 gate / 新 effect）是**改插件源码**，走代码评审。

这与调研中"模型先写编排脚本"的路线的区别，值得点明：
那条路线里，脚本**就是**执行体，模型写什么就跑什么；
这里模型写的是**受约束的数据**，执行体永远是已审计过的脚本。
安全边界从"信任模型的输出"移到了"信任注册表的封闭性"。

---

## 八、迁移路线

严格分阶段，**每阶段都可独立上线、可回滚、行为等价**。

### Stage 0 — 收口影子拓扑（必做前置，不引入任何新能力）

诊断 #8 是最大的隐患。先把散落的拓扑知识全部收敛到 `lib/state.js` 的单一结构：

```js
const PHASE_DEF = [
  { id: 'requirement_analysis', label: '需求分析',
    agent: {...}, artifacts: [...], gates: [...], effects: {...},
    context: { contracts: [...], summaryFrom: null } },
  ...
]
// 旧常量全部由它派生，对外签名不变
const PHASE_SLUGS    = PHASE_DEF.map(p => p.id)
const PHASE_NAMES    = PHASE_DEF.map(p => p.label)
const PHASE_AGENTS   = Object.fromEntries(PHASE_DEF.map((p, i) => [i, p.agent]))
const PHASE_ARTIFACTS= Object.fromEntries(PHASE_DEF.map((p, i) => [i, { artifacts: p.artifacts }]))
```

同时改造 `context-refresh.js`、`schema-validator.js`、`create-workflow.js` 改为读 `PHASE_DEF`。
**验收：全流程行为零差异**，所有现有 Story 跑通。这一步纯重构，风险最低，收益最大。

### Stage 1 — 图运行时（默认模板 = 现有流程）

- 新增 `wf-graph.js` + `workflow-templates/frontend-standard.workflow.json`（由 Stage 0 的 `PHASE_DEF` 直接导出生成，保证等价）
- `advance-phase.js` 的 `+1` 检查换成 `isLegalEdge`；`dispatch.js` 的终态/推进判断换成图查询
- `e2e-state.json` 双写 `currentNode` + `phase`
- **验收：线性模板下 `resolveNext` 恒返回单一后继，全流程与 Stage 0 逐字节等价**；老 Story（无 `currentNode`）通过兼容层按 `phase` 反查节点

### Stage 2 — 注册表化门控与副作用

- `policy.js` → `GATE_REGISTRY`；新增 `effects.js` → `EFFECT_REGISTRY`
- `--fix-loop` 参数化：目标节点、来源产出物、限域字段全部从边的 `fixLoop` 配置读
- **验收：现有 fix-loop 回归用例全通过**（含 2 轮耗尽转人工）

### Stage 3 — 模板库 + `wf-lint.js`

- 落地 6 个内置模板；`harness-workflow.js start` 增加 `--workflow <id>`
- `--bypass` 标记为 deprecated，内部改为 `--workflow hotfix`（保留旧参数一个版本）
- **验收：每个模板都有一条端到端冒烟用例**

### Stage 4 — `/harness compose` + fanout/join

- AI 辅助编排（四道闸）
- `type: fanout | join` 落地，Phase 2 的 Fork-Join 从 prompt 约定升级为图结构
- `metrics-aggregator` 增加真实并行度、图覆盖率指标

### Stage 5 — 收尾

- `phase` / `phases` 兼容字段标记 deprecated（保留至少 2 个版本）
- `docs/` 与 `harness-conductor/SKILL.md` 的对照表改为"由 `wf-graph.js` 生成"，
  彻底消除"给人看的表"和"运行时真表"不一致的风险

---

## 九、与现有资产的兼容性对照

| 现有资产 | 影响 | 说明 |
|---------|------|------|
| `harness-conductor` 三步循环 | **零改动** | 四态契约不变，主 Agent 行为不变 |
| `agentPrompt` 单一信源 | 零改动 | `prompt-builder` 改为从节点定义取 agent/artifacts，出口唯一性不变 |
| `RECOVERY_SUGGESTIONS` / level 1-4 | 零改动 | 只改调用时机 |
| `enforce-state-file.js` / `enforce-dev-pass.js` | 加一条匹配 | 保护 `workflow.lock.json` |
| `validatePhaseIntegrity()` | 语义迁移 | 整数比较 → 图后继集合判定 |
| dev-pass 限域机制 | 零改动 | 从"Phase 2 硬编码"变成"节点 effect 声明"，签发逻辑本身不动 |
| 契约 Schema (8 个) | 零改动 | 新增 `workflow.schema.json` |
| 五维 Agent Work Loop (`docs/agent-work-loop.md`) | **需重映射** | 维度当前锚定 Phase 编号（如 "Phase 0→1"），须改为锚定**节点角色标签**（如 `role: understanding \| execution \| validation \| delivery`），否则换模板即失效 |
| `trace.jsonl` | 增字段 | 事件加 `nodeId` / `workflowId`，旧字段保留 |
| 历史 Story | 可读 | 无 `currentNode` 时按 `phase` + 默认模板反查 |

倒数第二行的五维重映射容易被忽略但很关键：现有度量体系是**按 Phase 编号硬绑**的，
一旦模板可变，"Phase 0→1 = Task Understanding" 这个假设立刻失效。
建议在节点定义上加 `role` 字段，度量按 `role` 聚合而非按序号。

---

## 十、风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 动态化削弱门控刚性 | **高** | 图是设计期产物 + linter 强校验 + 运行时只查不造；分叉必须由确定性谓词消解，消解不了转人工 |
| 模板与注册表漂移（模板引用了已删的 gate） | 中 | `wf-lint` 在 `start` 时再校验一次；fail-closed |
| 影子拓扑残留导致静默错位 | **高** | Stage 0 强制先收口，且 Stage 0 独立验收 |
| 五维度量因模板可变而失真 | 中 | 节点加 `role` 字段，度量按 role 聚合（见 §9） |
| 多后继时运行时歧义 | 中 | `resolveNext` 返回 >1 且谓词无法唯一裁定 → 直接 `blocked`，不允许模型选 |
| 迁移期新旧状态文件混杂 | 中 | 双写 `currentNode` + `phase`；兼容读取层；老 Story 走默认模板 |
| 过度设计（用不上 fanout/join） | 中 | Stage 0-2 已覆盖 80% 价值；Stage 4 可按实际需求推迟或砍掉 |

---

## 十一、优先级建议

| 优先级 | 内容 | 理由 |
|--------|------|------|
| **P0** | Stage 0 收口影子拓扑 | 纯重构、零行为变化、消除当前最大隐患。**即使动态化方案最终不做，这一步也该做** |
| **P0** | Stage 1 图运行时 + 默认模板 | 拿掉 `+1` 约束，地基就位 |
| **P1** | Stage 2 注册表化 | 让"加节点不改 policy.js"成立 |
| **P1** | Stage 3 模板库 | 直接兑现业务价值（hotfix / bugfix / fullstack） |
| **P2** | Stage 4 compose + fanout | 收益高但复杂度陡增，建议前三阶段稳定后再评估 |
| **P2** | 五维度量重映射 | 与 Stage 3 同步做，避免度量失真 |

---

## 参考资料

**Claude Code 动态编排**
- [FlorianBruniaux/claude-code-ultimate-guide — Dynamic Workflows](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/guide/workflows/dynamic-workflows.md)
- [anthropics/claude-code issue #66032 — Workflow 工具](https://github.com/anthropics/claude-code/issues/66032)
- [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex)
- [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows)
- [barkain/claude-code-workflow-orchestration](https://github.com/barkain/claude-code-workflow-orchestration)
- [zb-ss/claude-plugin-workflow](https://github.com/zb-ss/claude-plugin-workflow)
- [Medium — What Makes Claude's New Dynamic Workflows Different](https://medium.com/data-science-collective/claudes-new-dynamic-workflows-changed-how-i-think-about-ai-coding-e1dc7649e516)
- [Reddit r/ClaudeAI — Plugin for orchestrating workflows](https://www.reddit.com/r/ClaudeAI/comments/1s4pawa/claude_code_plugin_for_orchestrating_workflows/)

**工作流引擎与 DAG 编排**
- [Argo Workflows — dag-daemon-retry-strategy.yaml](https://github.com/argoproj/argo-workflows/blob/main/examples/dag-daemon-retry-strategy.yaml)
- [Apache Seata — Saga 模式（节点级补偿 / 双向恢复）](https://seata.apache.org/docs/user/mode/saga/)
- [orieg/yaml-workflow](https://github.com/orieg/yaml-workflow) · [错误处理指南](https://orieg.github.io/yaml-workflow/guide/error-handling/)
- [Dapr — Workflow patterns](https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/)
- [Workflow Engine vs. State Machine](https://workflowengine.io/blog/workflow-engine-vs-state-machine/)
- [Code-First Workflow Engines: Architectural Patterns and Design](https://www.val.town/x/nbbaier/wrkflw/code/workflow-engines-research-report.md)
- [Saga: How to implement complex business transactions without two phase commit](https://blog.bernd-ruecker.com/saga-how-to-implement-complex-business-transactions-without-two-phase-commit-e00aa41a1b1b)

**本仓库内部**
- `docs/BETTER_HARNESS_借鉴方案.md`（宿主适配器 / findings.json 契约，与本方案 Stage 2-3 可并轨）
- `docs/agent-work-loop.md`（五维模型，需按 §9 重映射）
- `docs/OPTIMIZATION_SUMMARY.md`（dispatch.js 取代 dispatcher Agent 的原始论证）
