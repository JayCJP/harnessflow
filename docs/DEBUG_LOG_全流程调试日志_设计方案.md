# 全流程调试日志（debug-log）设计方案

> **目标**：收集整个工作流运行过程的输出内容（脚本输出、方法输出、钩子决策、Agent 终报等），支持事后**流程回顾分析**——完整还原一次 Story 运行中「每个环节输出了什么」。
> **约束**：零运行时行为变更（纯追加旁路，零拦截、零注入变化）；不进 Agent 上下文（离线分析专用，不占 token）；不动既有 trace.jsonl 及其消费方。

---

## 1. 现状盘点：索引层已有，载荷层缺失

### 1.1 已有资产（索引层）

| 资产 | 内容 | 局限 |
|------|------|------|
| `trace.jsonl`（lib/trace.js） | 事件索引：agent_spawn / tool_call / gate_decision / phase_transition / error_recovery / experience / git | payload 压缩——gate_decision 只存计数与拼接串，**不含完整 blocker 对象** |
| `phase-N-summary.md` | 相位摘要 | 事后生成，非原始输出 |
| `.dispatch-precheck.json` | dispatch 预检诊断（唯一落盘的命令输出） | 仅 blocker 预检一种 |
| `experience/` | 失败模式结构化沉淀 | 只留「模式」，不留「现场」 |
| Story 产出物 | code-review.json 等 | 静态结果，无过程 |

### 1.2 盲区清单（本方案要补的）

| # | 盲区 | 现状 |
|---|------|------|
| B1 | 命令 stdout 全量 | dispatch / advance-phase 的 JSON 输出只进对话即消散——**agentPrompt 全文、gateChecks、recovery、pendingBlockers、batches 全部丢失** |
| B2 | 方法级输出 | runGateCheck 的结构化 blockers（type/level/resolution）、增量 lint 原始输出、attemptAutoRecovery 过程均不落盘 |
| B3 | 子 Agent 终报 | trace-command.js 只读 tool_input **拿不到 tool_response**；子 Agent 汇报内容丢失 |
| B4 | Hook 拒绝详情 | enforce-* 的拒绝只在 session-stop 汇总进 experience，原始理由/目标文件不留全量 |
| B5 | trace-command 漏匹配 | isHarnessCmd 只认 advance-phase / harness-workflow / archive-story，**dispatch.js 与 create-workflow.js 不被记录** |

### 1.3 关键架构洞察：单一信源让捕获点高度收敛

三权分立 + 单一信源的副产品是**捕获点极少**：

- `dispatch.js` 只有 **1 个输出出口**（结尾的 console.log）
- `advance-phase.js` 约 **7 个 console.log 出口**
- 命令输出天然**聚合了方法层内容**：gateChecks ← policy.runGateCheck、agentPrompt ← prompt-builder、recovery ← policy

因此「**命令出口捕获**」即可覆盖 90% 需求，方法级只需少量补点——不需要侵入每个 service。

---

## 2. 设计方案

### 2.1 总体形态：两层日志

```
trace.jsonl   = 索引层（不动）：紧凑事件，供 experience / metrics / evolve 消费
debug.jsonl   = 载荷层（新增）：全量输出，供流程回顾分析消费
```

两层弱关联（debug 记录冗余 ts / storyId / phase，可独立回放），不强绑事件 ID。

### 2.2 存储与记录格式

- **位置**：`.codebuddy/plans/<storyId>/debug.jsonl`（与 trace.jsonl 并列；随 archive 归档、随 restore 回来）
- **格式**：JSONL，每行一条：

```json
{
  "ts": "2026-09-05T12:34:56.789Z",
  "seq": 42,
  "storyId": "STORY-X",
  "phase": 2,
  "kind": "script_output",
  "source": "dispatch.js",
  "durationMs": 87,
  "data": { "...": "原始 payload 全量" },
  "truncated": false,
  "hash": null
}
```

- **kind 枚举**：

| kind | 来源 | 内容 |
|------|------|------|
| `script_output` | 5 个命令脚本 | dispatch / advance-phase / create-workflow / harness-workflow / archive-story 的完整 JSON 输出（含 agentPrompt 全文、gateChecks、recovery、pendingBlockers、batches） |
| `method_output` | 方法级补点 | 增量 lint 原始输出、attemptAutoRecovery 过程等**未被命令输出携带**的方法内容 |
| `hook_decision` | 6 个 hooks | 放行/拒绝 + 完整理由 + 目标文件/参数 |
| `state_change` | state.js writeStateFile | 状态变更的字段级 diff（phase / status / gateChecks） |
| `agent_report` | trace-command 扩展 | 子 Agent / Skill / MCP 调用的返回（宿主 PostToolUse 提供 tool_response 则全量，否则记 tool_input 并标注 responseUnavailable） |

- **截断与体积**：单条 payload 上限 64KB，超出截断并记 sha1 指纹（可对账）；典型 8-Phase Story 估算 2~5MB（agentPrompt 3-8KB × 循环 30-60 次 + 门控/钩子记录）
- **开关**：默认开启，`HARNESS_DEBUG=0` 关闭（离线文件不占上下文 token，磁盘成本可接受；关掉是逃生门）

### 2.3 捕获机制：显式埋点，不做 stdout 劫持

**不采用** `process.stdout.write` 包装/劫持：魔法层违背项目「显式单一信源」哲学，CJS 多入口易漏、难测。

**做法**：新建 `lib/debug-log.js` 单一信源模块，在收敛点显式调用：

```js
// lib/debug-log.js
debugLog.record(storyId, kind, data, { source, phase, durationMs })  // 同步追加，静默失败（与 trace 同哲学）
debugLog.isEnabled()                                                  // HARNESS_DEBUG !== '0'
debugLog.read(storyId, { kind, phase, since, limit })                 // 读取端（replay 工具用）
```

### 2.4 明确不存储的东西（减少重复）

- **session-start 注入内容**：索引卡是 story 状态的纯函数，可由 `state_change` 记录在回放时**重算任意历史时刻的注入**，无需存储（三原则之「减少重复」）
- **子 Agent 会话内部过程**：那是宿主的领域——只捕获边界事件（spawn 时的 agentPrompt 终值、终报 tool_response）
- **产出物文件内容**：已在 Story 目录，debug 只记「谁在何时产出」的引用

---

## 3. 实现清单（分批，最小改动优先）

### P1 主链路（覆盖 B1 / B4，回顾分析的核心路径）

1. `lib/debug-log.js`（record / read / isEnabled + 单测：截断、开关、静默失败）
2. `dispatch.js` 唯一输出口埋点（含 durationMs 计时）
3. `advance-phase.js` 约 7 个输出口埋点（抽一个 `emit()` 局部小助手统一「console.log + record」）
4. `create-workflow.js` / `harness-workflow.js` / `archive-story.js` 输出口埋点
5. `state.js` writeStateFile 埋点（变更前后 diff 摘要）
6. `enforce-state-file` / `enforce-dev-pass` / `enforce-artifact` 三 hooks 埋点（hook_decision）
7. `audit/debug-replay.js` 骨架：`--kind` / `--phase` / `--since` 过滤 + markdown 时间线输出

### P2 补盲（覆盖 B2 / B3 / B5）

8. `trace-command.js`：补 dispatch / create-workflow 匹配 + tool_response 捕获（agent_report）
9. `policy.js` L2 方法补点：runIncrementalLint 原始输出、attemptAutoRecovery 过程
10. `debug-replay.js` 补全：相位跃迁自动分段、`--verbose` 展开 payload、`--round N` 读归档轮次

### P3 可选（按需）

11. harness-evolve 诊断环节升级为消费 debug.jsonl 全量内容（根因分析从「事件+计数」升级为「完整输出对照」）
12. replay 重建历史时刻索引卡（注入内容重算）

---

## 4. 典型回顾场景验证（设计自检）

| 回顾问题 | 由哪些记录回答 |
|---------|---------------|
| 这次 Story 一共跑了几轮循环、每步 dispatch 说了什么？ | `script_output`(dispatch) 按 seq 回放 |
| Phase 2→3 门控卡了几次、每次 blocker 是什么？ | `script_output`(advance-phase) 的 gateChecks + `state_change` 分段 |
| 前端开发 Agent 当时收到的完整 prompt？ | `script_output`(dispatch).agentPrompt 全文 |
| 为什么那次编辑 src/ 被拒了？ | `hook_decision`(enforce-dev-pass) 完整理由 |
| fix-loop 每轮的上下文与影响文件？ | `script_output`(advance-phase).fixLoopContext |
| 这个 Agent 最后汇报了什么？ | `agent_report`（P2，取决于宿主是否提供 tool_response） |
| 状态是怎么一步步变成这样的？ | `state_change` diff 序列 |

---

## 5. 取舍记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 默认开 vs env-gate | 默认开 + `HARNESS_DEBUG=0` 逃生门 | 不占上下文 token；磁盘 2~5MB/Story 可接受；回顾是刚需 |
| 显式埋点 vs stdout 劫持 | 显式埋点 | 项目「显式单一信源」哲学；可测、不漏、无魔法 |
| story 级文件 vs 全局文件 | story 级 | 随归档生命周期、与 trace 对齐、无跨 story 并发写 |
| agentPrompt 存于 dispatch 输出 vs prompt-builder 单独存 | 随命令输出存一次 | 两个 consumer 都会带出，单独存必重复（减少重复） |
| 注入内容 | 不存，回放重算 | 纯函数可重建，存储即冗余 |
| trace.jsonl | 完全不动 | 既有消费方（experience/metrics/evolve/session-stop）零影响 |

---

## 6. 铁律兼容性自查

- ✅ AI 不写状态机文件：debug-log 只追加自己的 `debug.jsonl`，零写权限于 e2e-state / dev-pass
- ✅ 主 Agent 行为零变化：埋点全在脚本/hook 内部，不改变任何 stdout 契约
- ✅ 失败不阻塞：record 静默失败（与 trace.js 同哲学），debug 写入异常不影响流程
- ✅ 不进上下文：debug.jsonl 只被 replay 工具离线读取，不注入任何 prompt
