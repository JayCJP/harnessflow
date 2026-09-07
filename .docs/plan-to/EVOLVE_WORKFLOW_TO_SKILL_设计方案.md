# Harness 自进化 — 重复工作流沉淀为 Skill 方案

> 状态：设计稿（未实现）
> 目标：在自进化闭环中，识别重复出现的工作流（操作序列/流程模式），自动沉淀为可复用的 Skill
> 关联：`skills/harness-evolve/`、`scripts/lib/trace.js`（证据链）、`scripts/services/experience.js`（经验库）、`~/.codebuddy/skills/skill-creator/`（skill 生成器）

---

## 〇、背景与问题

harness 自进化已有两套沉淀机制：

1. **failure-patterns.json**（experience.js）：沉淀「失败模式」——踩过的坑、根因、对策。解决「不贰过」。
2. **metrics-insights.json**（experience.js）：沉淀「度量洞察」——跨项目的流程级建议。解决「流程调优」。

但还缺第三套：**沉淀「工作流模式」**。当一个操作序列（如「列表页 CRUD 开发」「接口对接」「Bug 修复」）在不同 Story 中反复出现时，每次都要 Agent 从零推理一遍流程，浪费 token 且质量不稳定。这些重复的流程应该被识别出来，沉淀为可复用的 Skill。

**根因**：当前 harness 只记录「失败」和「度量」，不记录「成功的、可复用的操作序列」。trace 证据链（上一轮已埋点 `tool_call` / `agent_message`）已经具备了识别重复序列的数据基础，但缺少「识别 → 提案 → 生成 skill」的闭环。

---

## 一、核心命题

> **把「重复的操作序列」从 Story 历史中提取出来，沉淀为可被下次直接调用的 Skill。**

这与上一轮「声明-消费一致性」是同一哲学的两个侧面：
- 声明-消费 = 检查「该用的资源有没有用」
- 工作流沉淀 = 提取「反复出现的流程」变成可复用资产

---

## 二、关键概念厘清（避免设计错误）

必须区分三个层次的「重复」，它们对应不同的沉淀物：

| 层次 | 是什么 | 沉淀为 | 已有/新增 |
|------|--------|--------|-----------|
| 失败模式 | 踩过的坑、根因、对策 | failure-patterns.json | 已有 |
| 度量洞察 | 流程级建议（耗时、门控率） | metrics-insights.json | 已有 |
| **工作流模式** | 可复用的操作序列/流程 | **Skill** | **本方案新增** |

**一个具体的例子**：
- 失败模式：「列表页开发漏了分页参数校验」（坑）
- 工作流模式：「列表页开发」这个操作序列本身——「需求分析 → 确定字段 → 建组件 → 接接口 → 加分页/搜索/空态 → 测试」（流程）

前者是「别踩这个坑」，后者是「这个流程以后照着走」。两者都该沉淀，但形态不同：坑进 failure-patterns，流程进 skill。

---

## 三、重复工作流的识别（信号源）

### 3.1 信号源（全部基于已有资产）

| 信号 | 数据来源 | 识别什么 |
|------|---------|---------|
| tool_call 序列相似性 | trace.jsonl（上一轮已埋点） | 多个 Story 的 skill/MCP 调用序列高度相似 |
| task-dag 结构相似性 | task-dag.json | 任务拆分的拓扑结构重复（如都是「建列表→接接口→加交互」） |
| 需求类型相似性 | story-input.json 的 mode/title | 同类型需求反复出现（CRUD / 对接 / 修复） |
| 产出物结构相似性 | 各 Story 的产物文件 | 产物文件清单/结构重复 |
| failureType 关联性 | failure-patterns.json | 某类工作流反复触发同类失败 |

### 3.2 识别算法（保守、只报高置信）

```
对任意两个已完成的 Story A、B：
  seqA = 从 trace 提取的 tool_call 序列（skill + mcp 名，按 phase 排序）
  seqB = 同上
  相似度 = LCS(seqA, seqB) / max(len(seqA), len(seqB))

  若相似度 > 0.7 且出现 ≥ 3 次（≥3 个 Story 共享该序列）→ 候选工作流
```

**为什么用 LCS（最长公共子序列）而非精确匹配**：操作序列会有少量差异（变量名、顺序微调），LCS 能容忍局部差异，抓到「骨架相同」。

### 3.3 候选工作流的置信度分级

| 级别 | 条件 | 处置 |
|------|------|------|
| pattern | 相似度 > 0.7，出现 2 次 | 记录候选，待观察 |
| instinct | 相似度 > 0.7，出现 ≥ 3 次 | 提案沉淀为 skill |
| （否决） | 相似度 ≤ 0.7 | 不视为重复 |

> 这个分级与 harness-evolve 现有的 lesson/pattern/instinct 三级进化逻辑对齐。

---

## 四、沉淀为 Skill 的机制

### 4.1 复用 skill-creator

已有 `~/.codebuddy/skills/skill-creator/`，提供 `init_skill.py`（生成骨架）+ `package_skill.py`（校验打包）。本方案复用，不重复造轮子。

### 4.2 Skill 存到哪里

| 场景 | 存放位置 | 说明 |
|------|---------|------|
| 项目内工作流（如某业务的 CRUD） | `plugins/harness/skills/` | 随插件分发，项目内复用 |
| 跨项目通用工作流 | `~/.codebuddy/skills/` | 全局复用 |

### 4.3 生成流程（在 harness-evolve 的诊断→治疗阶段）

```
Step 2 诊断（mining）新增「工作流挖掘」：
  - 扫描已完成 Story 的 trace tool_call 序列
  - 用 LCS 找重复序列
  - 相似度 > 0.7 且 ≥3 次 → 输出候选工作流

Step 3 治疗（proposal）新增「skill 提案」：
  - 对候选工作流，生成 skill 提案（skill 名、触发词、流程步骤、复用资源）
  - 复用 skill-creator 生成 skill 骨架

Step 4 验证（validation）：
  - 人工确认 skill 是否合理（避免沉淀错误/过度具体的流程）
  - 确认后正式写入 skills/ 目录
```

### 4.4 Skill 的内容结构（复用 skill-creator 规范）

```
workflow-xxx/
├── SKILL.md          # name + description（触发词）+ 流程步骤
├── scripts/          # 可复用的脚本（如接口对接模板、脚手架）
└── references/       # 参考文档（如字段规范、踩坑记录）
```

**SKILL.md 的 description 是关键触发机制**，必须写清楚「何时用这个 skill」，例如：
```
description: "列表页 CRUD 开发工作流。当需要开发列表页（含搜索、分页、空态、增删改查）时使用。包含：字段确定→组件搭建→接口对接→交互完善→测试验证。"
```

---

## 五、与现有资产的关系

| 现有资产 | 关系 |
|---------|------|
| `failure-patterns.json` | 互补：坑进 failure-patterns，流程进 skill |
| `metrics-insights.json` | 互补：度量洞察是「建议」，skill 是「可执行的流程」 |
| trace 证据链（tool_call/agent_message） | 工作流识别的**数据地基**，上一轮埋点直接复用 |
| skill-creator | 直接复用其 init/package 脚本，不重复实现 |
| harness-evolve 五步闭环 | 在「诊断→治疗→验证」三步中插入「工作流挖掘→skill 提案→skill 确认」 |
| kb-init / kb-query | skill 沉淀后，知识库可记录「哪些 skill 可用」，供 kb-query 检索 |

---

## 六、落地优先级

| 阶段 | 内容 | 优先级理由 |
|------|------|-----------|
| **W0（地基）** | trace 里补 `workflow_fingerprint`（操作序列指纹），让 LCS 有数据可算 | 没有指纹，识别就是空转 |
| **W1（识别）** | harness-evolve 诊断阶段加「工作流挖掘」：LCS 找重复序列 | 核心价值所在 |
| **W2（提案）** | 治疗阶段加「skill 提案」：候选工作流 → skill 骨架 | 从识别到产出 |
| **W3（验证）** | 验证阶段加「skill 确认」：人工确认 + 复用校验 | 防止沉淀错误流程 |
| **W4（增强）** | skill 使用追踪：沉淀后统计 skill 复用率，形成闭环 | 度量 skill 是否真的被复用 |

---

## 七、风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 把「相似但不应复用」的流程误判为重复 | 高 | LCS 阈值 0.7 + 出现 ≥3 次 + 人工确认三道闸 |
| 沉淀的 skill 过度具体（只适用于单个 Story） | 中 | 只沉淀「骨架相同、参数可变」的流程；过度具体的走 failure-patterns |
| 工作流识别依赖 trace 埋点质量 | 中 | trace 埋点已在上一轮补上，但需确保 tool_call 序列完整 |
| skill 沉淀后没人用（静默失败） | 中 | W4 加 skill 复用率追踪，复用率为 0 的 skill 标记待清理 |
| 与 skill-creator 的触发机制冲突 | 低 | 复用 skill-creator 的 init/package，description 遵循其触发规范 |

---

## 八、核心结论

harness 自进化已有「沉淀失败模式」和「沉淀度量洞察」两套机制，缺第三套——「沉淀工作流模式」。本方案补齐它：

1. **识别**：用 trace 证据链的 tool_call 序列，LCS 找重复操作序列
2. **沉淀**：复用 skill-creator，把重复序列转成可复用的 skill
3. **闭环**：skill 沉淀后追踪复用率，复用率为 0 的清理

这与上一轮「声明-消费一致性」形成完整的自进化三件套：
- **不贰过**（failure-patterns）
- **流程调优**（metrics-insights）
- **流程复用**（本方案：workflow → skill）
