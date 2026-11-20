---
name: evolve
description: >
  Harness 自进化分析 —— 体检(audit) → 度量(metrics) → 诊断(mining) → 治疗(proposal) → 验证(validation)
  五步闭环。当用户说「/evolve」「复盘流程」「分析工作流问题」「为什么这个 Story 卡住/反复返工」「优化 harness 流程」时使用。
  不自动改文件，产出提案由用户确认后执行。
---

# /evolve — Harness 自进化分析

> 参考: Self-Harness (上海AI Lab, 2026) + harness-audit.js + metrics-aggregator.js

## 职责边界

- **只读分析**：跑体检/度量脚本、读 trace/debug/契约、生成提案。**不改任何文件**。
- **提案 ≠ 执行**：Step 3 产出修改提案，采纳与否由用户决定。采纳后才落盘。
- **不重复实现**：审计/度量的判定逻辑在脚本里，本 skill 只负责编排五步与解读结果，不在 prompt 里另写一套判定规则。

## 用法

```bash
/evolve <storyId>              # 完整五步闭环
/evolve all                    # 分析所有已归档 Story
/evolve <storyId> --check-only # 只跑 Step 0+1（体检+度量）
/evolve <storyId> --propose-only # 只跑 Step 3+4（提案+验证）
```

脚本在 `plugins/harness/` 下执行（相对于插件根）。

## 五步闭环

| Step | 名称 | 动作 | 产出 |
|---|---|---|---|
| 0 | 体检 | `node scripts/audit/harness-audit.js --json` | 状态/产出物/契约健康度，BLOCKER 清单 |
| 1 | 度量 | `node scripts/audit/metrics-aggregator.js --json` | Phase 耗时/门控通过率/fix-loop 指标 |
| 2 | 诊断 | 结合 0+1 + `trace.jsonl` + `debug.jsonl` + `fix-request.json` | 新旧问题、根因归类、瓶颈定位 |
| 3 | 治疗 | 生成修改提案，定 `evolutionLevel` | 目标文件 + 具体改法 |
| 4 | 验证 | 模拟改后效果，对比 fix-loop/BLOCKER/耗时 | 采纳 / 拒绝 / inconclusive |

完成后输出结构化自进化报告。**全程不改文件**，由用户确认后执行。

### Step 2 诊断要点

- 区分新问题 vs 持续问题（对比上次报告，同类反复出现即持续）。
- BLOCKER 按 `cat` 归类（state / contract / artifact / decl-consume / dev-pass）。
- 线索分两层：先看 `trace.jsonl` 索引层（事件+计数），看不出「为什么」再用 `debug-replay.js` 下钻载荷层（完整现场）。
- fixbugs Story 有审计盲区，需人工核对——详见 reference。

### Step 3 治疗要点

- 目标文件：`agents/*.md` / `policy.js` / `advance-phase.js` / `schemas/` / `scripts/lib/*`。
- `evolutionLevel`：`lesson`（单次）/ `pattern`（跨 Story）/ `instinct`（低风险自动注入）。
- 提案涉及「同一事实多处实现」时，按仓库铁律收敛单一信源、删副本、不留 fallback。

### Step 4 验证要点

- 对比修改前后的 fix-loop 触发/成功率、BLOCKER 数、Phase 耗时。
- 采纳后重新跑 audit 评分，确认无回归。

## 按需加载

| 场景 | 读哪个 reference |
|---|---|
| Step 2 要看事件类型、trace 字段、debug-replay 命令、根因归类 | [诊断与线索层级.md](references/诊断与线索层级.md) |
| Step 0/1 要看脚本输出字段、指标口径、阈值、fixbugs 审计边界、evolutionLevel 细则 | [指标口径与审计项.md](references/指标口径与审计项.md) |

## 铁律

1. **度量脚本必须带 `--json`** —— 默认模式会合并洞察到全局经验库（写副作用），分析阶段只读取。
2. **索引层优先于载荷层** —— trace 能定位就不展开 debug.jsonl，避免上下文淹没。
3. **空项目跳过度量结论** —— `storyCount: 0` 时满分默认值无意义。
4. **诊断不写状态文件** —— debug-replay 只读，`e2e-state.json` / `dev-pass.json` 由脚本签发。
5. **不自动改文件** —— 提案先给用户确认。
