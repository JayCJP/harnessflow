# Experience 模块 — 失败模式与度量

## 职责

沉淀 Harness 运行中的失败模式（failure-patterns）和度量洞察（metrics-insights），供后续 Phase 注入 prompt 作为「历史教训」。

## 文件清单

| 文件 | 职责 |
|------|------|
| failure-patterns.json | 失败模式库（按 Phase 分类） |
| failures/ | 失败案例目录 |
| metrics-insights.json | 度量洞察（按 Phase 分类） |

## 关键机制

- experience.js 提供 `getLessonsForPhase(phase)` 和 `getMetricsInsights(phase)`
- prompt-builder 构建 prompt 时注入对应 Phase 的历史教训
- 失败模式通过 harness-evolve 的「诊断」环节自动挖掘
