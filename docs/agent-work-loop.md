# Agent Work Loop — 五维评估模型定义

> 借鉴 Better Harness (QoderAI/better-harness) 的 Agent Work Loop 思想，
> 适配本 harness 插件的 8 Phase 状态机与 trace 证据源。
>
> 用途: 供 `scripts/audit/metrics-aggregator.js` 与 `scripts/audit/harness-audit.js`
>       统一引用，确保"维度定义 ↔ 证据提取 ↔ 评分门槛"一致。
>
> 核心原则: **评估不只问"跑通没"，更要问"跑得好不好、可信不可信、下次能否更好"**。
>           每个维度必须有可观测证据；无法证实则显式标 `unobserved`，禁止编造分数。

---

## 五维总览

| 维度 | 本插件对应阶段 | 一句话含义 |
|------|----------------|------------|
| Task Understanding | Phase 0→1 | 需求目标与边界是否被真正理解 |
| Controlled Execution | Phase 2 | 开发是否在受控路径（精确限域）内执行 |
| Change Validation | Phase 3→4 | 变更是否有可验证证据支撑 |
| Reliable Delivery | Phase 5→7 | 交付是否绕过质量门、是否可靠 |
| Learning Capture | 全周期 | 失败经验是否被记录与沉淀复用 |

---

## 维度 1: Task Understanding（需求理解）

**正向信号**（证据来源，均为现有函数/字段）:
- `acceptance-criteria.json` 合法 (checkAcceptanceCriteria.valid=true) 且 ≥1 条
- `open-questions.json` 全部 resolved (checkOpenQuestions.allResolved=true)
- AC↔Task 交叉引用完整 (validateContractReferences.valid=true，orphanACs=0, invalidRefs=0)

**反向信号**:
- AC 文件不存在 → 无法观测，标 `unobserved`
- AC 存在但格式非法 / open-questions 有未决议项 → 理解不完整

**最小证据门槛**: 至少 `acceptance-criteria.json` 存在且 valid，否则 `unobserved`
**评分映射**:
- ac_valid → +0.4
- oq_all_resolved → +0.3
- ac_task_ref_intact → +0.3

---

## 维度 2: Controlled Execution（受控执行）

**正向信号**:
- dev-pass source = `task-dag.json`（精确限域，getDevPassAllowedPaths.source==='task-dag.json'）
- state.bypass = false（未绕过受控路径）

**反向信号**:
- dev-pass 降级为 `fallback-src-glob`（src/** 全局授权）→ 受控性弱
- state.bypass = true → 直接绕过

**最小证据门槛**: 至少能取得 dev-pass 来源或 bypass 字段，否则 `unobserved`
**评分映射**:
- source==='task-dag.json' → 基础 0.8，否则 0.3
- 若有 bypass → 扣 0.3（下限 0）

---

## 维度 3: Change Validation（变更验证）

**正向信号**:
- `code-review.json` 存在（Phase 3 产出物）
- `acceptance-verification.json` 全部 passed (checkAcceptanceVerification.allPassed=true)
- 每条验收结果至少 1 条 evidence
- trace 中有 `git:commit success` 事件

**反向信号**:
- acceptance-verification 不存在 → `unobserved`
- 存在 failed / unverifiable 条目 → 验证不完整

**最小证据门槛**: `acceptance-verification.json` 存在，否则 `unobserved`
**评分映射**:
- allPassed → +0.7
- 每条 evidence 累加，最多 +0.3（evidence_count * 0.1，上限 0.3）

---

## 维度 4: Reliable Delivery（可靠交付）

**正向信号**:
- trace `git:push success` 或 `git:mr success`
- `phases['7_deployment'].status === 'completed'`
- 最终 state.status === 'completed' 且 phases 无 rolledBack

**反向信号**:
- 缺 git push 成功记录 → 交付链路断
- 存在 rollback → 不可靠

**最小证据门槛**: 至少 git push 成功 或 deploy completed 之一，否则 `unobserved`
**评分映射**:
- push success → +0.5
- deploy completed → +0.5

---

## 维度 5: Learning Capture（学习捕获）

**正向信号**:
- trace `experience` 事件 ≥1（含 failureType + rootCause + resolution）
- trace `error_recovery` recovered 比例高
- `experience/failure-patterns.json` 被命中复用（后续趋势库支撑）

**反向信号**:
- 无任何 experience / error_recovery 记录 → `unobserved`

**诚实性约束（重要）**:
单 Story 只能证明"经验被**记录**"，**无法证明"被复用"**。
因此本维度即使有记录，最多标 `inferred` 而非 `observed`，
避免 Better Harness 警示的"编造健康度"问题。

**最小证据门槛**: 至少 1 条 experience 或 error_recovery 事件，否则 `unobserved`
**评分映射**:
- experience 事件: 每条 +0.2，上限 0.6
- recovery_rate(recovered/(recovered+failed)): 最高 +0.4
- status: 有 experience 记录 → 'inferred'；否则 'observed'（无记录即明确"未捕获"）

---

## status 枚举约定

| status | 含义 | 是否计入总分 |
|--------|------|--------------|
| observed | 有充分直接证据支撑 | 是 |
| inferred | 有间接/弱证据，结论带推测 | 是（但报告中以区分样式呈现） |
| unobserved | 证据缺失，无法证实 | 否（score=null，不参与平均分） |

---

## 与现有结构的衔接

- 五维评分函数统一放在 `scripts/audit/metrics-aggregator.js` 内（新增，不删原 8 指标）
- 输出到每个 Story 的 `loop-insights.json`（与现有 `metrics-insights.json` 并存）
- `advance-phase.js` 的 Phase 7→8 聚合触发点（execSync 调 aggregator）自动带上五维输出
- 后续衔接:
  - 借鉴点 3（诚实性原则）: 本文件 status 字段即其雏形
  - 借鉴点 2（跨 Story 趋势）: fiveDimensions 可被 trend-store 追加到全局库
  - 借鉴点 6（前馈传感）: capabilityGaps 可被 prompt-builder 注入下一轮
