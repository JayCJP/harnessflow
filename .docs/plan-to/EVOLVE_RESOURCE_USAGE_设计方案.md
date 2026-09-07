# Harness 自进化 — 资源利用效率检查方案（v2）

> 状态：设计稿（未实现）
> 版本：v2 —— 融入「证据链」视角，从「查调用」升级为「查影响 + 可处置」
> 目标：让 harness-evolve 自进化检查从「只查流程跑没跑通」，扩展为「查 skill / 知识库 / MCP / 产物是否真的被用上，且能自动处置」
> 关联：`services/policy.js`、`commands/advance-phase.js`、`audit/harness-audit.js`、`lib/trace.js`、`skills/harness-evolve/SKILL.md`

---

## 〇、背景与问题

harness 是「自己开发自己」的项目。上一次跌倒暴露了一个根本性盲区：**自进化只检查 Story 产出物和运行轨迹，不检查「资源是否真的被消费」**。具体表现：

1. **Figma 断裂**：story-input 声明了 `figmaUrls`，但开发阶段从未真正调用 Figma MCP 拉设计，前端用默认样式实现。因为没留痕，事后无法发现。
2. **知识库空转**：prompt 里注入了 `lessonsFromHistory`、kb-query 指令，但 agent 可能一次都没调用，注入的教训形同虚设。
3. **skill 静默降级**：prompt 要求调用 `figma-to-component-map`，但该 skill 的二手产物没人产出时，agent 静默跳过，不报错。

**根因**：当前 `trace.js` 的 JSDoc 里声明了 `tool_call`、`agent_message` 两种事件类型，但**只有 7 个实现函数，没有 `traceToolCall` / `traceAgentMessage` 的实现**。skill / MCP 的调用根本没有被记录。

---

## 一、核心命题与 v2 的定位修正

v1 的核心命题是「把声明-消费一致性从 Figma 泛化成通用校验」。这个方向正确，但 v1 只解决了「**有没有叫外卖**」（埋点）的问题，没解决：

- 「**外卖是否真吃了**」（影响性）—— 调用了 ≠ 用上了
- 「**没吃怎么办**」（自愈）—— 发现了 ≠ 能修复

**v2 的三条定位修正**：

1. **trace 从「流水账」升级为「证据链」**：每条 tool_call 必须携带时间戳 + 资源指纹，能回答「谁、何时、用了什么、影响了哪个产物」。
2. **检查结果直接挂载到 Gate**，而非只写审计报告——查到了就 BLOCK 或降级，形成「不贰过」的闭环。
3. **产物利用率不靠 LLM 诊断 LLM**，靠「特征指纹」和「强制转化后的 Check List」做确定性判定。

---

## 二、v1 的核心缺陷（评审结论）

| # | 缺陷 | 后果 | v2 对策 |
|---|------|------|---------|
| 1 | 埋点依赖 Agent 自觉，缺强制/旁路机制 | Agent「偷懒」用了 Skill 结果却不走工具调用，trace 显示「没调用」却产出了「类似」结果 → 大量 False Positive | 旁路采集 + 特征指纹（见 §3.1、§5） |
| 2 | 产物利用率让 LLM 诊断 LLM 自己的产物 | 「左脚踩右脚」幻觉，倾向自我认定「参考了上下文」 | 特征指纹 + mustCheck 清单，确定性判定（见 §5、§7） |
| 3 | 缺时间线/因果校验 | Agent 写完代码后「出于好奇」补调一下 Figma，trace +1 但写代码时用的是默认样式 → 有调用但无效 | 时间戳前置校验（见 §4） |
| 4 | 检查层与 Gate 割裂 | 审计报告红字一片，但自进化流程照常放行 → 只报警不处置 | 检查结果注入 Gate，BLOCK/重试（见 §6） |

---

## 三、第一层：trace 埋点（采集层，升级为证据链）

### 3.1 现状

`lib/trace.js` 现有 7 个函数（agent_spawn / agent_result / gate_decision / phase_transition / error_recovery / git / experience），JSDoc 声明了 `tool_call`、`agent_message` 但无实现。

### 3.2 新增函数（带时间戳 + 指纹的证据链）

```js
/**
 * 记录一次工具 / skill / MCP 调用 —— 证据链的核心节点
 * @param {string} storyId
 * @param {Object} opts
 * @param {string} opts.tool - 工具名（use_skill / mcp_call_tool / graphify 等）
 * @param {string} [opts.skill] - skill 名（kb-query / graphify / figma-to-component-map）
 * @param {string} [opts.mcp] - MCP 名（figma / playwright / tapd）
 * @param {string} [opts.mcpTool] - MCP 工具名（get_design_context）
 * @param {number} [opts.phase] - Phase 编号
 * @param {string} [opts.agent] - 发起调用的 Agent 名
 * @param {string} [opts.resourceHash] - 资源指纹（教训/设计的 hash，见 §5）
 * @param {string} [opts.result] - success / failed
 * @param {Object} [opts.details] - 附加信息
 */
function traceToolCall (storyId, opts) {
  appendTrace(storyId, {
    type: 'tool_call',
    ts: new Date().toISOString(),   // 时间戳 —— 时间线校验的依据
    tool: opts.tool,
    skill: opts.skill || null,
    mcp: opts.mcp || null,
    mcpTool: opts.mcpTool || null,
    phase: opts.phase != null ? String(opts.phase) : null,
    agent: opts.agent || null,
    resourceHash: opts.resourceHash || null,
    result: opts.result || 'success',
    details: opts.details || {}
  })
}
```

> **关键**：`ts` 是每条 tool_call 的**绝对时间戳**，这是 §4 时间线校验的地基。`appendTrace` 本身已写 `ts`，但 v2 要求检查逻辑**必须依赖它做前后序判断**，不能只看「有没有」。

### 3.3 旁路采集（对策 #1 的落地）

不能只靠 Agent 走 `use_skill` 工具时主动埋点。补一道**旁路**：

- `hooks/trace-command.js`（PostToolUse hook）已能拿到 `event.tool_name` 和 `event.tool_input`。把「只记录 advance-phase/harness-workflow/archive-story」的过滤，扩展为「记录所有 Skill / MCP 调用」。
- **旁路的价值**：即使 Agent 想「偷懒」，只要它真调了工具，hook 就能抓到，不依赖 Agent 主动写 trace。

> 旁路仍无法覆盖「Agent 凭记忆直接写代码、连工具都没调」的情况。这类「隐性消费」只能靠 §5 的特征指纹在产物侧反推，而非在调用侧硬抓。

---

## 四、时间戳前置校验（Temporal Check，对策 #3）

**规则**：一次有效的「资源消费」，必须满足 **tool_call 的时间 ≤ 产物落盘的时间**。

具体到 Figma 场景：
- `traceToolCall` 里 `mcp='figma'` 的 `ts`，必须**早于** `git add`（或产物文件 mtime）。
- 若 Figma MCP 调用发生在代码提交**之后** → 判定 `TOO_LATE`，降级为 WARNING，**不算有效消费**。

**落地**：在检查逻辑里，对每个「声明→消费」对，取：
- `declaredAt` = story-input / prompt 注入时间（Phase 开始时间）
- `consumedAt` = tool_call 的 ts
- `producedAt` = 产物文件 mtime / git add 时间

判定：
```
consumedAt == null            → MISSING（未消费，BLOCKER）
declaredAt ≤ consumedAt ≤ producedAt → CONSUMED（有效）
consumedAt > producedAt       → TOO_LATE（无效消费，WARNING）
```

---

## 五、特征指纹（Artifact Fingerprint，对策 #1、#2 的根治）

**核心思想**：不直接查「有没有用上下文」，而是查「产物是否受到了上下文的影响」。

### 5.1 教训指纹（lessonsFromHistory）

当 Phase 0 注入一条历史教训（如「上次因漏了 padding 导致 UI 错乱」）时：
1. trace 记录该教训的 **Hash 指纹**（`resourceHash`）。
2. Phase 2 代码生成后，对产物（CSS/TSX）做 **AST 扫描**，检查是否出现「padding 相关防御性代码」。
3. 判定：指纹对应的防御代码出现 → `CONSUMED`；否则 → `STALE`（教训注入但未生效）。

### 5.2 收益

从「查调用」升级为「查影响」。这才是自进化真正要的东西——**不贰过**，意味着教训要真的改变行为，而不只是被「引用」过。

### 5.3 实现边界

- 指纹→防御代码的映射，先覆盖**可结构化、高频**的教训类型（样式属性、事件清理、空态处理等）。
- 无法 AST 化的教训，不强行自动化，标记 `unobserved`，交由 §7 的 mustCheck 清单走「人工/AST 混合」路径。

---

## 六、检查结果注入 Gate（对策 #4，关闭审计与执行割裂）

**现状**：门控逻辑在 `services/policy.js`（`runGateCheck` + `checkPhase0Gate`~`checkPhase4Gate`），挂载点在 `advance-phase.js:766` 的 `policy.runGateCheck(storyId, p, state)`。**不需要新增 gate.js**。

**改动**：在 `policy.js` 增加资源完整性检查函数，纳入 `runGateCheck`：

```js
/**
 * 资源完整性检查 —— 声明了资源但未有效消费
 * @param {string} storyId
 * @param {number} phaseNum - 当前 Phase
 * @param {Object} state
 * @returns {{ passed: boolean, blockers: Array, warnings: Array }}
 */
function checkResourceIntegrity (storyId, phaseNum, state) { ... }
```

**阈值联动（区分 BLOCK 与降级）**：

| 场景 | 判定 | 处置 |
|------|------|------|
| 声明 figmaUrls + 0 次 Figma MCP 调用 | BLOCKER | **BLOCK**：不进入下一 Phase，强制重试 |
| Figma MCP 调用 TOO_LATE | WARNING | 放行，但记 debt + Evo Score 扣分 |
| kb-query 调用 0 次 | WARNING | 放行，记 debt + 扣分 |
| 教训指纹 STALE | WARNING | 放行，记 debt + 扣分 |

> **关键设计**：只有「显式声明 + 硬性依赖」的资源（如 figmaUrls）才配 BLOCK；「软性资源」（知识库、教训）用 WARNING + 扣分，避免门控过严导致流程死锁。这与 §8 的「必用 vs 条件」区分一致。

---

## 七、显式声明 vs 隐式需求 + 强制转化 Check List（对策 #2 落地）

当前只检查 `figmaUrls` 这类**显式声明**。但 `lessonsFromHistory` 是**隐式注入**的，没有显式 flag，无法直接检查。

**对策**：在 `context-refresh.js` 阶段，强制把 `lessonsFromHistory` 转化为「待验证 Check List」，写进 `task-dag.json`：

```json
{
  "tasks": [ ... ],
  "mustCheck": [
    { "lesson": "上次漏 padding 导致 UI 错乱", "fingerprint": "hash-abc", "check": "padding 属性存在" },
    { "lesson": "事件监听未清理", "fingerprint": "hash-def", "check": "onBeforeUnmount 存在" }
  ]
}
```

**检查层**只需遍历 `task-dag.json` 的 `mustCheck`，判断每条 `check` 是否在代码中体现——**不需要解析 prompt 语义**，也不需要 LLM 自我诊断。

**收益**：
- 4.4 产物利用率维度从此可确定性落地。
- 教训的「注入 → 转化 → 验证」形成闭环，不再依赖 Agent 自觉或 LLM 幻觉。

---

## 八、自救机制（对策 #5，从发现到修复）

查到「声明了 Figma 但没调 MCP」时，**不要只报 BLOCKER**，要当场补救：

- 新增 `hooks/auto-recover.js`（或扩展 advance-phase 的 fix-loop）：
  - 把 `figmaUrls` 强制塞入下一 Phase 的 System Prompt，设置 `priority: high`。
  - 强制 Agent 先调 `mcp_call_tool` 再写代码。
- 这才是「进化」：**从发现断裂，到自动修复断裂**。

**触发时机**：`checkResourceIntegrity` 判定 BLOCKER 时，在返回的 `blockers` 里附带 `recovery` 动作，advance-phase 的 fix-loop 读取并执行，而非仅提示人工。

---

## 九、执行优先级（双轨并行，调整原 Stage 顺序）

原 v1 的 Stage 1→2→3 线性依赖改为**双轨并行**，按「先补地基、再抓跌倒、再锦上添花」排序：

| 阶段 | 内容 | 优先级理由 |
|------|------|-----------|
| **S0（地基）** | 补 `traceToolCall` 的**时间戳 + 资源 Hash** 字段 | 没有时间戳和指纹，后面全部废 |
| **S1（止血）** | MCP 强制调用检查 + Gate BLOCK 联动 | 直接解决上次 Figma 跌倒，立竿见影 |
| **S2（关键）** | 历史教训转 mustCheck 清单 | 让 4.4 维度可落地，不依赖 LLM 自我诊断 |
| **S3（增强）** | 统计 skill/知识库使用次数 + Evo Score 扣分 | 用于度量进化评分，而非阻断 |
| **S4（远期）** | 产物利用率深度语义分析 | 待 trace 数据足够后用小模型判断，现阶段不强求 |

---

## 十、落地改动清单（按 S0-S4）

| 阶段 | 文件 | 改动 |
|------|------|------|
| S0 | `lib/trace.js` | 新增 `traceToolCall`（含 ts + resourceHash）、`traceAgentMessage` |
| S0 | `hooks/trace-command.js` | 扩展过滤，记录 Skill/MCP 调用（旁路采集） |
| S1 | `services/policy.js` | 新增 `checkResourceIntegrity`，纳入 `runGateCheck` |
| S1 | `commands/advance-phase.js` | fix-loop 读取资源 BLOCKER 的 recovery 动作 |
| S2 | `services/context-refresh.js` | lessonsFromHistory 转化为 mustCheck 写 task-dag.json |
| S2 | `lib/state.js` | 新增 `PHASE_SKILLS`（阶段→该用 skill 单一信源） |
| S3 | `audit/metrics-aggregator.js` | 新增 skill/kb/mcp 使用统计 + Evo Score 扣分 |
| S3 | `skills/harness-evolve/SKILL.md` | 新增资源利用检查步骤 + 阈值说明 |
| S4 | （待定） | 小模型做产物利用率语义分析 |

---

## 十一、风险与对策（v2 增量）

| 风险 | 等级 | 对策 |
|------|------|------|
| 旁路仍抓不到「凭记忆写代码」的隐性消费 | 高 | 不硬抓调用侧，靠特征指纹在产物侧反推（§5） |
| 特征指纹的「教训→防御代码」映射覆盖不全 | 中 | 先覆盖高频可结构化类型，其余标 `unobserved`，不误判 |
| Gate 注入资源检查导致流程死锁 | 中 | 只有「显式声明 + 硬依赖」才 BLOCK，软资源用 WARNING + 扣分 |
| 时间戳依赖系统时钟一致性 | 低 | 统一用 ISO 时间戳；跨时钟漂移场景用文件 mtime 兜底 |
| 历史 Story 无新埋点数据 | 中 | 新埋点只对未来 Story 生效，历史标 `unobserved` |

---

## 十二、核心结论

v1 解决了「有没有叫外卖」（埋点），v2 补上了两个更关键的环节：

1. **「外卖是否真吃了」（影响性）**：用时间戳前置校验 + 特征指纹，从「查调用」升级为「查影响」。
2. **「没吃怎么办」（自愈）**：检查结果直接挂载到 Gate，BLOCK 并触发 auto-recover，而不是只写报告。

把 trace 从「流水账」升级为「证据链」（含时间戳、指纹、强制转化后的 Check List），并把检查结果直接挂到 gate 上，harness 才能真正实现「不贰过」。
