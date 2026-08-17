# Agents 模块 — 角色 Agent 定义

## 职责

定义 Harness 流水线中 6 个角色 Agent 的行为规范、工具集、MCP 服务、执行流程与产出约束。

## Agent 清单

| Agent | 文件 | 职责 | 关键约束 |
|-------|------|------|---------|
| 需求分析师 | 需求分析师.md | Phase 0 需求分析、原型/Figma 抓取、验收标准 | fixbugs 模式下自行调 tapd-bug-analyzer |
| 任务规划师 | 任务规划师.md | Phase 1 任务 DAG 拆解 | 依赖识别、Fork-Join 并行 |
| 前端开发工程师 | 前端开发工程师.md | Phase 2 编码 | 有 figmaLink 必须调 Figma MCP 拉完整设计 |
| 代码审查师 | 代码审查师.md | Phase 3 审查 | 分级 BLOCKER/WARNING/SUGGESTION |
| 测试工程师 | 测试工程师.md | Phase 4 验收测试 | 逐条 AC 回归 |
| 发布助手 | 发布助手.md | Phase 5/6/7 提交/知识库/部署 | 禁止 --no-verify 跳过钩子 |

## 关键机制

- Agent 通过 frontmatter 声明 `tools`、`agentMode`、`mcpServers`（如前端开发的 `Figma AI Bridge, Figma`）
- Agent 文档内嵌「核心原则」「知识库集成」「执行流程」「产出约束」等章节
- 多 Agent 通过 SendMessage 协作，任务通过 task-dag 派发

## 踩坑记录

- 前端开发工程师的 Figma 应用：曾出现「链接存在 ≠ 样式对齐」问题，已强化为「必须亲自调 Figma MCP 拉完整设计内容」（见 scripts-core/prompt-builder 的 buildFigmaAlignInstruction）
