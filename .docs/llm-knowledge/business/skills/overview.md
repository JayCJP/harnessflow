# Skills 模块 — 可插拔 Skill

## 职责

扩展 Harness 能力的 Skill 集合，每个 Skill 有独立的 SKILL.md 定义触发词和执行流程。

## Skill 清单

| Skill | 目录 | 用途 |
|-------|------|------|
| figma | figma/ | 读取分析 Figma 设计稿（get_design_context/get_screenshot） |
| figma-to-component-map | figma-to-component-map/ | Phase 0 产出 frame inventory，Phase 1 精确映射 |
| kb-query | kb-query/ | 分层知识库检索（L1 overview→L2 meta→L3 文档） |
| kb-update | kb-update/ | 任务后增量更新知识库 |
| kb-init | kb-init/ | 初始化知识库目录骨架 |
| gen-project-docs | gen-project-docs/ | 扫描源码生成 8 类文档 |
| api-generator | api-generator/ | Swagger → 接口定义/请求函数 |
| harness-conductor | harness-conductor/ | 工作流编排器 |
| harness-run | harness-run/ | 新功能开发全流程 |
| harness-fixbugs | harness-fixbugs/ | Bug 修复全流程 |
| harness-archive | harness-archive/ | Story 归档、复档与历史查询 |
| harness-evolve | harness-evolve/ | Harness 自进化（体检→度量→诊断→治疗→验证） |
| tapd-bug-analyzer | tapd-bug-analyzer/ | TAPD 缺陷分析 |

## 关键机制

- Skill 通过 frontmatter 声明 `description`（含触发词）
- 每个 Skill 自包含脚本（.cjs），脚本执行确定性操作，AI 负责认知操作
- figma-to-component-map 依赖 Figma 桌面端 MCP 运行，未运行则告知用户停止，不退回缓存
