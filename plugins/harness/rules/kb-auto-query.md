---
description: 
alwaysApply: true
enabled: true
updatedAt: 2026-07-10T08:08:13.482Z
provider: 
---

# 知识库自动检索规则

## 总则

在处理任何与项目业务相关的开发任务时，**必须先查阅知识库，再操作代码**。

## 自动触发场景

下列场景出现时，**无需等待用户说触发词**，直接按 L1→L2→L3 流程检索知识库：

1. **涉及功能模块** — 用户提到任意功能名称（如"会话""设置""工单"），先读 `overview.md` 业务域地图匹配域
2. **修改/新增代码** — "帮我改一下"、"新增一个功能"、"修复这个bug"
3. **询问实现** — "怎么实现的"、"在哪里"、"是什么逻辑"
4. **需求相关** — 包含 PRD、需求、方案、设计等关键词
5. **不确定入口** — 用户没有明确说文件路径，AI 需要自己定位时

## 执行流程

```
Step 1: read_file .docs/llm-knowledge/frontend/overview.md (定位域)
Step 2: read_file .docs/llm-knowledge/frontend/meta.yaml   (获取文件配置)
Step 3: load business/<domain>/overview.md                  (加载域文档)
Step 4: 按需加载 api.md / store.md / architecture.md 等
```

## 只加载必要的

- ❌ 禁止一次性加载所有域的文档
- ✅ 定位到 1-2 个域后，只加载该域的文档
- ✅ 文档不命中时，再用 search_content 搜索源码

## 与 graphify 的关系

知识库 > graphify > 源码搜索
知识库命中了就不要再用 graphify