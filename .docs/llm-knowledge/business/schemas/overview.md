# Schemas 模块 — JSON Schema 契约

## 职责

定义各 Phase 产出物的 JSON Schema，由 schema-validator.js 校验。

## Schema 清单

| 文件 | 对应产出物 | 关键字段 |
|------|-----------|---------|
| acceptance-criteria.schema.json | acceptance-criteria.json | id/title/given/when/then/figmaNodeId/testType |
| acceptance-verification.schema.json | acceptance-verification.json | results 数组 |
| code-review.schema.json | code-review.json | issues 数组（severity/status） |
| e2e-state.schema.json | e2e-state.json | gateChecks/phase 状态 |
| fix-request.schema.json | fix-request.json | 修复请求 |
| fix-verification.schema.json | fix-verification.json | 修复验证 |
| open-questions.schema.json | open-questions.json | questions 数组 |
| story-input.schema.json | story-input.json | sources（prototypeUrls/figmaUrls） |
| task-dag.schema.json | task-dag.json | tasks 数组（figmaLink） |

## 关键约束

- 字段白名单制：Agent 不得添加 schema 未声明的字段
- `figmaNodeId` 用于 AC 关联 Figma 节点；`figmaLink` 用于 task 关联 Figma 链接（字段名需统一，见踩坑）
