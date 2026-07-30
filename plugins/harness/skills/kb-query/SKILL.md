---
name: "kb-query"
description: "渐进式分层知识库检索。三层检索：L1 overview关键词匹配定位域 → L2 meta.yaml精确筛选 → L3 按需加载文档。支持4种模式：需求拆解/技术方案/接口搜索/知识问答。自动触发：代码修改、需求分析、接口查找、技术方案、改bug、新增功能等场景。"
location: "user"
---

# kb-query — 渐进式分层知识库检索（全局 Skill）

"渐进式分层加载"检索策略。
数据驱动：域列表和关键词从 `overview.md` + `meta.yaml` 动态获取，不硬编码。

---

## 检索流程

### L1: 全局总览匹配（始终执行）

加载 `.docs/llm-knowledge/frontend/overview.md` 的「业务域地图」表。

- 提取用户问题关键词
- 与业务域地图的关键词列匹配 → 收敛到 1-2 个域
- 无法匹配 → 返回概述，询问补充上下文

### L2: meta.yaml 精确筛选

加载 `.docs/llm-knowledge/frontend/meta.yaml`。

- 在匹配到的域配置中获取 `entry_files / stores / apis / components`
- 根据查询模式确定需加载的文档类型

### L3: 按需加载

| 模式 | 触发条件 | 加载文档 |
|------|---------|---------|
| **A-需求拆解** | PRD/需求分解为 Story | `overview.md` + `api.md` + `architecture.md` |
| **B-技术方案** | 设计技术方案、评估改动 | `overview.md` + `pages.md` + `api.md` + `store.md` + `architecture.md` |
| **C-接口搜索** | 查找特定 API | `api.md` → 未命中则 `search_content` |
| **D-知识问答** | 业务概念、流程、字段含义 | `overview.md` → 按需 `architecture.md` / `pitfalls.md` / `custom/` |

### L4: 深度搜索（兜底）

- `search_content` 在 `src/` 搜索关键词
- `search_file` 文件名模式匹配

---

## 检索策略

### ❌ 禁止
- 一次加载所有域文档
- 跳过 L1 overview 直接搜代码
- 精准定位域后仍全量搜索

### ✅ 必须
- 始终先读 overview.md
- meta.yaml 确认域后再加载域文档
- 优先 `read_file` 读已生成文档，不命中才 `search_content`
- 加载时说明命中了哪个域、哪种模式

---

## 执行示例

```
用户: "1v1会话转接功能怎么实现的？"

L1: overview.md → 关键词"会话""转接" → 命中 chat 域
L2: meta.yaml → chat 域 apis: csReception, oneToOne
L3: business/chat/architecture.md → 转接流程说明
L4: search_content "transfer" → 补充接口细节

输出: "TransferDialog → csReception.transferSession → WebSocket 通知刷新"
```

```
用户: "帮我拆解需求：工单列表增加导出功能"

L1: overview.md → 关键词"工单" → 命中 ticket 域
L2: meta.yaml → ticket 域 apis/stores
L3: business/ticket/overview.md + api.md + architecture.md
→ 分析现有结构 → 拆解 Story

输出:
- Story 1: 导出 API
- Story 2: 导出按钮组件
- Story 3: 进度提示与下载
- 涉及文件: [列表]
```
