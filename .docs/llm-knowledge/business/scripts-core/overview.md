# Scripts-Core 模块 — 核心逻辑

## 职责

Harness 的核心服务层，承载状态管理、prompt 构建、上下文压缩、策略与校验。

## 文件清单

### lib/（基础工具）

| 文件 | 职责 |
|------|------|
| state.js | 状态文件读写、路径常量、PHASE_ARTIFACTS、PHASE_SLUGS、loadRepos、仓库注册表 |
| trace.js | 全链路 trace 记录（agent_spawn/gate_decision/git/phase_transition 等） |

### services/（业务服务）

| 文件 | 职责 |
|------|------|
| prompt-builder.js | 构建每个 Phase 的 Agent prompt，注入契约/摘要/教训/Figma 指令 |
| context-refresh.js | Phase 完成后生成 summary，含运行时取证（Phase 2/5/6/7） |
| policy.js | 策略配置 |
| schema-validator.js | JSON Schema 校验 |
| validate-contracts.js | 契约文件校验 |
| validate-phase-gate.js | Phase 门控校验 |
| experience.js | 失败模式与度量洞察 |

## 关键设计

- **prompt-builder.js 的 Figma 处理**：
  - `detectFigmaSource` 检测 story-input 里的 figmaUrls
  - `buildFigmaAlignInstruction`（Phase 2 注入）：强制前端 agent 用 Figma MCP 拉完整设计内容
  - `readFigmaDesignMap`：读取 figma-component-map.md（可选辅助，缺失不阻断）
- **context-refresh.js 的运行时取证**：
  - Phase 2/5/6/7 无落盘文件，通过 `getRuntimeEvidence` 从 git/trace/meta.yaml 取证
  - `evidenceCodeChanges` / `evidenceGitCommits` / `evidenceKbRefresh` / `evidenceDeploy`

## 踩坑记录

- **Figma 链路断裂**：曾出现「figmaUrls 声明了但开发时没用上」——根因是二手 token 摘要（figma-component-map.md）没人产出，前端静默降级。已改为强制一手 MCP 拉取。
- **context-refresh ReferenceError**：generatePhaseSummary 引用 getRuntimeEvidence 但函数体缺失，Phase 2/5/6/7 完成即抛错。已补全。
