---
name: harness-evolve
description: >
  Harness 自进化 Skill — 体检(audit) → 度量(metrics) → 诊断(weakness mining) → 治疗(proposal) → 验证(validation)，
  五步闭环，基于 Self-Harness 论文设计。分析 Harness 插件运行轨迹和产出物，自动发现失败模式，提出改进建议，验证后采纳。
  触发词: 自进化、harness evolve、分析harness产出、优化harness规则
---

# Harness Evolve — 自进化引擎

> 参考: Self-Harness (上海AI Lab, 2026) — 不换模型，让Harness自己进化
> 集成: harness-audit.js (体检) + metrics-aggregator.js (度量)

## 五步闭环流程

```
体检(audit) → 度量(metrics) → 诊断(mining) → 治疗(proposal) → 验证(validation)
    ↑                                                              |
    └──────────────── 采纳后进入下一轮 ────────────────────────────┘
```

## Step 0: 体检 (Health Check)

> 调用 `harness-audit.js` 获取当前 Harness 健康状态

**执行命令**:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit/harness-audit.js --json
```

**采集数据**:
- **核心脚本语法体检**（services/lib/audit/commands 全量 .js/.cjs 的 node --check）
- **引用完整性检查**（调用但未定义/未导出的悬空引用，抓 ReferenceError 元凶）
- **声明-消费一致性检查**（story-input 声明了 figmaUrl 但未产出 frame 清单）
- .harness-active 活跃 Story 状态
- dev-pass 有效性 + 限域精度
- 所有 Story 产出物完整性 (AC/task-dag/verification)
- 契约交叉引用检查

**输出到报告**:
```
## 体检结果
| 检查项 | 状态 | 说明 |
|--------|------|------|
| 活跃Story | ✅ | STORY-001 (Phase 4) |
| 产出物完整性 | ⚠ | 2个Story缺少code-review.json |
```

## Step 1: 度量 (Metrics Aggregation)

> 调用 `metrics-aggregator.js` 获取历史趋势数据

**执行命令**:
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/audit/metrics-aggregator.js --json
```

**采集指标**:
| 指标 | 阈值 | 说明 |
|------|------|------|
| Phase 耗时 | >20min | 瓶颈 Phase 识别 |
| 门控首次通过率 | <80% | 门控规则是否过严 |
| fix-loop 触发率 | >40% | Agent 产出物质量 |
| fix-loop 成功率 | <80% | 修复回路是否有效 |
| dev-pass 限域精度 | <70% | task-dag 文件声明是否精确 |
| BLOCKER 类型趋势 | 环比增长 | 哪种 BLOCKER 在恶化 |
| 资源使用（S3 新增） | — | skill/kb/mcp 调用统计（resourceUsage 字段） |

**输出到报告**:
```
## 度量结果
| 指标 | 当前值 | 趋势 | 状态 |
|------|--------|------|------|
| fix-loop触发率 | 45% | ↑+15% | 🔴 恶化 |
| 门控首次通过率 | 72% | ↓-8% | 🟡 关注 |
| Phase 2耗时 | 18min | → | 🟢 正常 |
```

## Step 2: 诊断 (Weakness Mining)

> 结合体检+度量结果 + trace.jsonl + fix-request.json + failure-patterns.json

**分析维度**:

**2.1 新问题 vs 持续问题**
- 对比 Step 1 的趋势数据
- 区分: 本次新增的问题 / 多轮持续存在的问题
- 优先级: 持续恶化 > 新增 > 偶发

**2.2 BLOCKER 根因归类**
- 从 code-review.json / fix-request.json 提取 BLOCKER
- 按根因聚合: 事件泄漏 / 状态管理 / 异步处理 / 格式错误
- 与 failure-patterns.json 历史数据交叉比对

**2.3 流程瓶颈定位**
- 从 trace.jsonl 时间戳计算各 Phase 耗时
- 识别最耗时 Phase → 是否需要增加 Agent 并行度

**2.4 open-questions 影响评估**
- 统计未 resolve 问题数量
- 是否导致 Phase 5 前多次人工确认

**2.5 Schema 校验失败统计**
- policy.js 门控中 schema_validation_failed 次数
- 哪种产出物格式错误最多 → 对应 Agent 需要加强约束

**2.6 资源利用效率（S3 新增）**
- 从 metrics.resourceUsage 读取 skill/kb/mcp 调用统计
- skill 使用效率：每个 Phase 该用的 skill 是否真的被调用（对照 PHASE_SKILLS 单一信源）
- 知识库空转：kb-query/graphify 调用为 0 → 注入的历史教训从未被查证
- MCP 消费：声明 figmaUrl 但 Figma MCP 调用为 0 → 静默降级（与上次 Figma 断裂同源）
- 产物利用率：task-dag.json 的 mustCheck 清单是否在代码产物中体现（教训是否真的被规避）

## Step 3: 治疗 (Harness Proposal)

> 针对 Step 2 诊断出的问题，AI 提出具体修改方案

**可修改的目标文件**:
- Agent 配置文件 (agents/*.md) — 修改 prompt 约束、产出物要求
- failure-patterns.json — 新增/更新失败模式 (lesson→pattern→instinct 三级)
- policy.js — 新增门控规则
- advance-phase.js — 调整流程逻辑
- schemas/*.schema.json — 加强格式校验

**提案格式**:
```json
{
  "proposalId": "P-001",
  "weaknessType": "high_fix_loop_rate",
  "targetFile": "agents/前端开发工程师.md",
  "currentBehavior": "Agent prompt 中未强调事件监听器清理",
  "proposedChange": "在 prompt 中增加 '必须使用 onBeforeUnmount 清理所有事件监听器'",
  "evidence": "Phase 3 审查中事件泄漏类 BLOCKER 出现 3 次，趋势 ↑+15%",
  "expectedImprovement": "减少事件泄漏类 BLOCKER 50%",
  "regressionRisk": "低 — 仅增加提示词，不影响现有逻辑",
  "validationMethod": "运行相同 Story 流程，对比 fix-loop 次数",
  "evolutionLevel": "pattern"
}
```

**evolutionLevel 说明**:
- `lesson`: 单次记录 (出现 1 次) → 写入 failure-patterns.json
- `pattern`: 跨 Story 归纳 (出现 ≥2 次) → 注入 lessonsFromHistory
- `instinct`: 自动注入 (出现 ≥3 次且验证有效) → 直接写入 Agent prompt

## Step 4: 验证 (Proposal Validation)

> 模拟验证 + 回归测试，决定是否采纳

**4.1 模拟验证**
- 用历史 Story 数据模拟修改后的效果
- 对比: fix-loop 次数、BLOCKER 数量、流程耗时

**4.2 接受规则**
| 条件 | 结果 |
|------|------|
| fix-loop ↓ OR BLOCKER ↓ | ✅ 采纳 |
| 性能退化 >20% | ❌ 拒绝 |
| 无变化 | ⚠ inconclusive |

**4.3 回退机制**
- 采纳 → 写入对应文件 + 记录到 failure-patterns.json
- 拒绝 → 记录原因 + 下次不重复提案
- inconclusive → 标记待观察 + 下次重新评估

**4.4 采纳后自动执行 audit 重新评分**
- 修改后重新运行 harness-audit.js + metrics-aggregator.js
- 对比修改前后分数
- 分数提升 → 确认有效
- 分数下降 → 回退修改

## 完整输出格式

```markdown
## Harness 自进化报告

### 0. 体检结果 (audit)
| 检查项 | 状态 | 说明 |
|--------|------|------|
| 活跃Story | ✅ | STORY-001 Phase 4 |
| 产出物 | ⚠ | 2个Story缺code-review.json |

### 1. 度量结果 (metrics)
| 指标 | 当前值 | 趋势 | 状态 |
|------|--------|------|------|
| fix-loop触发率 | 45% | ↑+15% | 🔴 |
| 门控首次通过率 | 72% | ↓-8% | 🟡 |

### 2. 诊断 (weakness mining)
| 弱点类型 | 出现次数 | 趋势 | 严重度 |
|---------|---------|------|--------|
| 事件泄漏 BLOCKER | 3 | ↑ | 🔴 高 |
| task-dag title 缺失 | 2 | → | 🟡 中 |

### 3. 治疗方案 (proposals)
| ID | 目标文件 | 改动说明 | 预期收益 | 进化级别 |
|----|---------|---------|---------|---------|
| P-001 | agents/前端开发工程师.md | 增加事件清理约束 | BLOCKER-50% | pattern |
| P-002 | schemas/task-dag.schema.json | title改为required | 格式错误-100% | instinct |

### 4. 验证结果 (validation)
| ID | 验证方式 | 结果 | 状态 |
|----|---------|------|------|
| P-001 | 模拟对比 | fix-loop -1 | ✅ 采纳 |
| P-002 | 模拟对比 | 格式错误归零 | ✅ 采纳 |

### 5. 重新评分 (re-audit)
| 指标 | 修改前 | 修改后 | 变化 |
|------|--------|--------|------|
| fix-loop触发率 | 45% | 30% | ✅ -15% |
| 门控首次通过率 | 72% | 85% | ✅ +13% |
```

## 使用方式

```
# 完整五步闭环
/harness-evolve STORY-20260710-01

# 只分析所有已归档 Story
/harness-evolve all

# 只跑体检+度量 (不生成提案)
/harness-evolve STORY-20260710-01 --check-only

# 只跑提案+验证 (已有诊断结果)
/harness-evolve STORY-20260710-01 --propose-only
```

## 约束

- 🚫 不自动修改文件: 提案需用户确认后执行
- 🚫 不覆盖手工批注: Agent 配置文件中的 CUSTOM 标记区域不修改
- 🚫 不重复提案: 已拒绝的提案记录原因，下次跳过
- ✅ 所有提案必须有数据证据支撑 (trace + metrics + audit)
- ✅ 采纳后自动重新评分验证效果
- ✅ 修改可回退: 记录修改前状态
