---
name: "kb-query"
description: "渐进式分层知识库检索。三层检索：L1 脚本召回候选域并按相关性重排（Jev，缺失时降级为关键词匹配）→ L2 meta.yaml 精确筛选 → L3 按需加载文档（脚本直接给出待读文件清单）。支持4种模式：需求拆解/技术方案/接口搜索/知识问答。自动触发：代码修改、需求分析、接口查找、技术方案、改bug、新增功能等场景。查找代码时应与 graphify 双源交叉验证（query/explain/path）。"
---

# kb-query — 渐进式分层知识库检索（全局 Skill）

"渐进式分层加载"检索策略。
数据驱动：域列表和关键词从 `overview.md` + `meta.yaml` 动态获取，不硬编码。

---

## KB 根自动探测

知识库根（KB root）按 `project_type` 决定，与 `kb-update.cjs` 的 `resolveKbRoot` 同款逻辑：

| project_type | KB root | meta.yaml 路径 |
|-------------|---------|---------------|
| frontend | `.docs/llm-knowledge/frontend/` | `.docs/llm-knowledge/frontend/meta.yaml` |
| plugin / backend / library | `.docs/llm-knowledge/` | `.docs/llm-knowledge/meta.yaml` |

多端项目可在端层下扩展 `h5/`、`miniprogram/` 等子目录。多候选时按「更像真正知识库根」打分择优：含 `business/` 子目录 +2、含 `overview.md` +1。AI 执行 L1/L2 前应先按上表定位 KB root，后续所有 `overview.md` / `meta.yaml` / 域文档路径都基于该 root 拼接，不再硬编码。

> KB root = `.docs/llm-knowledge/frontend/`。

---

## 双源交叉验证（kb-query ∥ graphify）— 查找代码辅助

> 全局通用：在查找/定位代码时，**kb-query 应与 graphify 同时调用，双源交叉验证收敛**，不要只依赖单一检索方式（如仅 Explore agent 或仅文本搜索）。

### 为何双源并行
- **kb-query**（本 skill）：业务语义层——按功能模块/接口名检索，拿到业务语义、候选文件、该域历史踩坑（`pitfalls.md`）。
- **graphify**：结构层——`query "<报错信息/功能关键词>"` 拿结构视图，`explain "<模块>"` 理解职责，`path "<API>" "<渲染出口>"` 追数据流与调用链。

两者互补：kb-query 的历史踩坑常直接命中同类历史 bug；graphify 的调用链常暴露「需求没提但被波及」的隐式路径。缺一路容易定位到表象而非根因。

### 交叉验证收敛规则
| 情况 | 处理 |
|------|------|
| 两者指向同一文件 | 最高置信度，优先精读该文件 |
| 仅 kb-query 命中 | graphify `query` 补调用方，bug 可能在上游 |
| 仅 graphify 命中 | 知识库缺此模块，报告末尾建议 `kb-update` |
| 两边冲突 | 以源码为准，标注知识库过期 |

### 兜底
- `search_content` + `search_file`：仅当上述两路都没定位到文件时使用。

---

## 检索流程

### L1: 候选域召回 + 重排（优先走脚本）

```bash
node "<skill_dir>/kb-query.cjs" --query="<用户问题>" [--mode=A|B|C|D]
# 已有活跃 Story 时直接取 story-input.json 的主题，并可复用缓存：
node "<skill_dir>/kb-query.cjs" --story=<storyId> [--mode=A|B|C|D]
```

输出按相关性排名的域清单，每行附 `docs`（**已按模式映射 + 存在性过滤**的待读文件清单）
与 `missingDocs`。按 `ranked[].docs` 读文件即可进入 L3，**不要自行判断该读哪几篇**。

- 脚本会降级但不会失败：无 `TYPESAFE_API_KEY` / `HARNESS_JEV=0` / 命中域不足 2 个 /
  网络超时，一律降级为关键词排序并在 `source` 字段如实标注
  （`jev` / `keyword-fallback` / `keyword-only` / `no-kb`）
- **域关键词的富信源是 `meta.yaml` 的 `domains[].keywords`**（真实知识库单域可达 46 条，
  含组件名、字段名、枚举值、Story 专属 token）；`overview.md` 的域地图表关键词列是精简版
  （4~6 个/域），**仅作脚本不可用时的兜底**
- 无法匹配任何域（`ranked` 为空）→ 返回概述，询问补充上下文

### L2: meta.yaml 精确筛选

加载 KB root 下的 `meta.yaml`。

- 在匹配到的域配置中获取文件字段（`entry_files / files / stores / apis / components`，按项目类型而异）
- 根据查询模式确定需加载的文档类型

### L3: 按需加载

**模式 → 文档类型映射表只维护在 `kb-query.cjs` 的 `MODE_DOCS` 常量里**（`node kb-query.cjs --help` 可见），
本文件不重复该表 —— 两处各存一份必然漂移，且 L1 脚本输出的 `docs` 已按该表 + 存在性过滤算好。

脚本不可用时的兜底顺序（按模式取所需）：
`overview.md` → `api.md` → 按需 `architecture.md` / `pages.md` / `store.md` / `custom/`（**存在才读**）。

> ⚠️ 真实知识库里并非每个域都有 `config.md` / `pitfalls.md`（实测 chat / group-chat / settings
> 三域均无）—— 读之前先确认文件存在，否则是一次无效 read（纯 token 浪费）。

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
- 始终先读 overview.md（路径基于 KB root 自动探测，前端项目在 `frontend/` 端层下）
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
