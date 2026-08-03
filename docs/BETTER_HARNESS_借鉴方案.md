# Better Harness 借鉴方案

> 参考对象: github.com/QoderAI/better-harness（阿里云 Qoder 开源，MIT）
> 目标: 从 Better Harness 提取可学习点，逐项给出"优化什么 / 目的 / 解决什么问题 / 好处 / 影响范围 / 怎么做"
> 适用: 本 harness 插件（C:/Users/Intel/.codebuddy/harness-marketplace/plugins/harness）

---

## 借鉴点总览

| # | 借鉴点 | 对应本插件现状 |
|---|--------|----------------|
| 1 | 五维 Agent Work Loop 评估模型 | metrics-aggregator 仅测"流程是否跑通"，缺质量维度 |
| 2 | 跨 Story 历史趋势对比 | 每次跑完归档/重置，无纵向趋势库 |
| 3 | 诚实性原则（未观测显式声明） | P-001 已修 dev-pass 误报，但仍可能"编造健康度" |
| 4 | 宿主适配器（薄层多端） | 强绑 CodeBuddy 单一宿主 |
| 5 | findings.json 证据契约 + 范围限定修复计划 | 自进化产物偏文本，缺结构化契约 |
| 6 | 前馈-反馈传感机制 | 现有 hooks 偏"守卫拦截"，缺"引导前馈" |

---

## 借鉴点 1：五维 Agent Work Loop 评估模型

**优化什么**
将 metrics-aggregator 的度量维度从"流程健康度"（phase 推进率、门控通过率、dev-pass 精度）扩展为 Better Harness 的五维模型：
- Task Understanding（目标理解）
- Controlled Execution（受控执行）
- Change Validation（变更验证）
- Reliable Delivery（可靠交付）
- Learning Capture（学习捕获）

**目的**
让度量不仅回答"流程跑通了吗"，还回答"跑得好不好、可不可信、下次能否更好"。

**解决什么问题**
当前 metrics 只能证明"Phase 0→8 连贯、门控无 BLOCKER"，但无法暴露：
- 需求是否被真正理解（Task Understanding）
- 开发是否在受控路径（Controlled Execution）
- 验收是否真有证据支撑（Change Validation）
- 交付是否绕过质量门（Reliable Delivery）
- 经验是否被沉淀复用（Learning Capture）

**好处**
- 度量从"体检表"升级为"能力雷达图"，定位能力短板而非仅流程断点
- 为自进化 proposal 提供更结构化的改进靶心
- 与 Better Harness 对齐后，评估结果可横向对标行业实践

**影响范围**
- `scripts/audit/metrics-aggregator.js`（核心改造）
- `scripts/services/policy.js`（门控可引入五维权重）
- 新增 `models/agent-work-loop.md`（五维定义与证据映射，参考 Better Harness）
- `experience/failure-patterns.json`（沉淀维度对齐）

**怎么做**
1. 在 `models/` 新增 `agent-work-loop.md`，定义五维 + 每维的"证据来源字段"（如 Controlled Execution 证据= skills/commands/MCP 调用数）
2. 改造 `metrics-aggregator.js`：除现有指标外，从 `trace.jsonl` + `e2e-state.json` 提取五维证据，输出 `loop-insights.json`
3. 每维给 0-1 置信分 + 证据列表，缺失证据显式标 `unobserved`（衔接借鉴点 3）
4. 在 advance-phase Phase 7→8 聚合时一并生成，保持现有调用链不动

---

## 借鉴点 2：跨 Story 历史趋势对比

**优化什么**
建立全局趋势库，记录每个 Story 的五维评分 / 关键指标随时间变化，而非每次归档即清零。

**目的**
识别"改了 AGENTS.md / 加了 hook 后，工作循环是否真的变好"，而非单次自评。

**解决什么问题**
当前自进化闭环（audit→metrics→mining→proposal→validation）只分析单个 Story，无法回答"这个 proposal 历史上有没有被验证有效"。Better Harness 明确指出：检查通过≠改善，需后期可比结果。

**好处**
- 自进化 proposal 可带"历史验证状态"（validated / unvalidated）
- 避免重复提已被证伪的优化
- 给团队提供"能力基线→趋势"的可视化资产

**影响范围**
- 新增 `scripts/audit/trend-store.js`（读写全局趋势库，存 `harness-marketplace/plugins/harness/.trend/store.json` 或全局 `.codebuddy`）
- `metrics-aggregator.js` 末尾调用 trend-store 追加本 Story 快照
- 新增 `harness trend <metric>` CLI 查看趋势
- 不影响现有 Story 流程，纯增量

**怎么做**
1. 新增 `trend-store.js`：每次 metrics 聚合后 append `{storyId, timestamp, fiveDimScores, blockers, fixLoops}` 到全局 store
2. `metrics-aggregator.js` 在现有聚合后调用 `trend-store.append()`
3. 提供 `harness trend --dim controlled_execution` 输出该维跨 Story 折线（文本/JSON）
4. 在 proposal 生成时读取趋势，标注该优化历史命中/证伪次数

---

## 借鉴点 3：诚实性原则（未观测显式声明）

**优化什么**
在 metrics / audit 输出中，对任何"无法从证据证实"的结论，显式标注 `unobserved` / `inferred`，禁止无证据打分。

**目的**
防止"健康度报告"变成自我感觉良好的装饰，保持证据可追溯。

**解决什么问题**
P-001 已修过 dev-pass 精度从 0→1 的误报（之前从已删除的 dev-pass.json 读，恒报 0）。但类似风险仍在：如"Learning Capture=高"若仅凭存在 memory 文件就给高分，是伪证据。

**好处**
- 报告可信度提升，决策者能区分"已证实"与"推测"
- 与 Better Harness 的 honesty principle 对齐，便于对外对标
- 倒逼采集器补全证据而非编造分数

**影响范围**
- `scripts/audit/metrics-aggregator.js`（评分逻辑加 evidence gate）
- `scripts/audit/harness-audit.js`（audit 结论加 `confidence` 字段）
- `models/agent-work-loop.md`（定义每维的最小证据门槛）

**怎么做**
1. 在 `agent-work-loop.md` 为每维定义"最低证据门槛"（如 Change Validation 需至少 1 条 test/lint hook 记录）
2. `metrics-aggregator.js` 评分函数改为：`if (evidence.length < threshold) return {score: null, status: 'unobserved'}`
3. 输出 JSON 中每条指标带 `evidence: [...]` 与 `confidence: 'observed'|'inferred'|'unobserved'`
4. 报告渲染时 `unobserved` 项以灰色/待确认样式呈现，不参与总分计算

---

## 借鉴点 4：宿主适配器（薄层多端）

**优化什么**
将"宿主相关"的逻辑（路径解析、激活标记、trace 落地、状态文件位置）抽成宿主适配层，支持 CodeBuddy 之外的宿主（如 Claude Code / Cursor / Qoder 等）。

**目的**
让 harness 编排能力不绑死单宿主，扩大复用面。

**解决什么问题**
当前 `state.js` 的 `PROJECT_ROOT` / `PLANS_DIR` 假定 CodeBuddy 的 `.codebuddy/plans/` 约定；`harness-workflow.js` 的 `.harness-active` 标记也是 CodeBuddy 特有。换宿主需改多处硬编码。

**好处**
- 同一套 8 Phase 编排可服务多端团队
- 适配层隔离变动，核心脚本零改
- 与 Better Harness 的 8 宿主适配器理念一致，可反向借鉴其适配接口

**影响范围**
- 新增 `scripts/lib/host-adapter.js`（定义 `getPlansDir() / getActiveFlag() / getStateLocation()` 等接口）
- `state.js` / `harness-workflow.js` 改为调用 adapter 而非硬编码
- 新增 `adapters/codebuddy.js`（现有行为）、`adapters/claude-code.js`（占位）等
- 高风险改造，需充分测试，建议独立分支进行

**怎么做**
1. 抽象 `HostAdapter` 接口，列出所有宿主差异点（路径、标记文件、激活协议）
2. 将 `state.js` 中 `PROJECT_ROOT`/`PLANS_DIR` 改为 `adapter.getPlansDir()`
3. 实现 `codebuddy` adapter（迁移现有逻辑），其余 adapter 先留接口占位
4. 用环境变量 `HARNESS_HOST=codebuddy` 切换，默认 codebuddy 保持兼容

---

## 借鉴点 5：findings.json 证据契约 + 范围限定修复计划

**优化什么**
将自进化 proposal / audit 发现项，统一为结构化 `findings.json` 契约：每条含 `id / dimension / severity / evidence[] / fixAction / scopedFixPlan`。

**目的**
让"发现→修复"链路可被机器消费、可被审查、可被历史追踪。

**解决什么问题**
当前自进化输出偏 Markdown 叙述（mining 的 proposal、audit 的 WARNING），下游 Agent 需解析文本才能行动，易丢字段。

**好处**
- 修复计划可被脚本直接消费，减少人工中转
- 每条 finding 带"范围限定"（只改哪些文件），防止修复扩散
- 与 Better Harness 的 findings.json 对齐，便于对标

**影响范围**
- 新增 `schemas/findings.schema.json`
- `scripts/audit/metrics-aggregator.js` / `harness-audit.js` 输出 findings.json
- `advance-phase.js` 的 `--fix-loop` 直接读取 findings.json 生成修复计划
- `experience/failure-patterns.json` 可复用同一 schema

**怎么做**
1. 定义 `findings.schema.json`（`id/dimension/severity/evidence/fixAction/scopedFiles`）
2. audit / metrics 脚本末尾额外 emit `findings.json`（与现有 Markdown 并存）
3. `advance-phase.js --fix-loop` 优先读 findings.json 的 `scopedFiles` 生成 dev-pass 限域
4. trend-store 关联 findings 的 `id` 做历史命中统计（衔接借鉴点 2）

---

## 借鉴点 6：前馈-反馈传感机制

**优化什么**
在现有"守卫 hooks（反馈拦截）"之外，补一层"前馈引导"：在 Phase 启动前，向 Agent 注入该 Phase 的目标基线、验收证据要求、既往失败模式（前馈）。

**目的**
让 Agent 在行动前就"知道目标和完成定义"（对应五维的 Task Understanding），而非仅靠事后门控兜错。

**解决什么问题**
当前 `prompt-builder.js` 已注入历史教训（lessonsFromHistory），但偏"不要犯某错"，缺"本 Phase 应交付的可验证证据清单"（前馈）。Better Harness 强调 feedforward guides 在行动前引导。

**好处**
- Agent 启动即有清晰"完成定义"，减少返工
- 与五维 Task Understanding 直接对应，度量有前置锚点
- 前馈+反馈形成闭环，门控从"拦截器"升级为"教练"

**影响范围**
- `scripts/services/prompt-builder.js`（注入前馈区块）
- `models/agent-work-loop.md`（每 Phase 的前馈清单）
- 各 Phase 的 Agent prompt 模板
- 不影响门控逻辑，纯 prompt 增强

**怎么做**
1. 在 `agent-work-loop.md` 为每个 Phase 定义"前馈基线"（目标 + 必交付证据 + 既往坑）
2. `prompt-builder.js` 新增 `feedforward` 区块，从 model 读取注入
3. Agent 完成时须回扣前馈证据（如 Phase 2 须列"已改文件 + 测试命令"），供 metrics 的 Change Validation 消费
4. 与借鉴点 1 的五维评分打通：前馈声明→反馈验证→闭环评分

---

## 实施建议（优先级排序）

| 优先级 | 借鉴点 | 理由 |
|--------|--------|------|
| P0 | 1 五维模型 + 3 诚实性原则 | 直接提升度量可信度，改动集中在 audit 脚本，风险低 |
| P0 | 5 findings.json 契约 | 打通"发现→修复"机器链路，赋能现有 fix-loop |
| P1 | 2 跨 Story 趋势 | 让自进化有历史验证，需新增存储，中等改动 |
| P1 | 6 前馈传感 | prompt 增强，低风险，配合五维形成闭环 |
| P2 | 4 宿主适配器 | 高收益但高风险，需独立分支，非紧迫 |

> 所有改造均建议：先在 `harness-marketplace/plugins/harness` 建特性分支，单测覆盖后合并；不破坏现有 8 Phase 主链路。
