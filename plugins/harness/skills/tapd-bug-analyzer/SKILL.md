---
name: tapd-bug-analyzer
description: >
  TAPD 缺陷分析器 —— 从 TAPD 拉取需求关联的 bugs，按处理人过滤，
  逐条分析根因、定位代码、分类责任，产出结构化 Bug 分析报告文档。
  报告写入 Story 的 plans 目录，作为 Harness Phase 0（需求分析）的输入。
  触发：用户提供 TAPD 链接 + 处理人、提到"分析 TAPD bugs"、"生成 Bug 报告"。
  不执行代码修改，只产出分析文档。
---

# TAPD Bug Analyzer

## Overview

通过 TAPD MCP 采集需求关联的 bugs → 按处理人过滤 → 逐条深度分析（问题理解 → 代码定位 → 根因追踪 → 分类）→ 输出**结构化 Bug 分析报告**到 Story 的 plans 目录。

> 本 skill **只分析、不修代码**。产出文档作为 Harness 工作流 Phase 0 的输入材料。

## Harness 集成

```
TAPD Bug Analyzer                       Harness 工作流
       │                                     │
       │  产出 .codebuddy/plans/<storyId>/   │
       │  {storyTitle}_bug分析报告.md         │
       ├─────────────────────────────────────→ Phase 0（需求分析师）
       │                                     │
       │                                     ├→ Phase 1（任务规划师）
       │                                     ├→ Phase 2（前端开发工程师）
       │                                     └→ ...
```

- **Pre-Phase 0**：用户提供 TAPD 链接 + 处理人 + storyId → 本 skill 拉取需求关联的 bugs → 过滤处理人 → 产出报告到 `{STORY_DIR}/`
- **Phase 0**：需求分析师读取 `{STORY_DIR}/{storyTitle}_bug分析报告.md` → 产出 `requirement-analysis.md` + `acceptance-criteria.json` + `open-questions.json`
- **Phase 1→8**：标准 Harness 流水线

## 触发条件

- 用户提供 TAPD 需求链接 + 处理人 + storyId
- 用户提到"分析 TAPD bugs"、"拉取 TAPD 缺陷"、"生成 Bug 报告"
- `/harness fixbugs` 流程中自动加载

> **所有参数（workspace_id、处理人、storyId 等）必须从当前用户消息中动态提取，禁止硬编码。**

## 核心约束

1. **只分析，不修代码** — 产出报告后即结束，不进入代码修改
2. **产出到 Story 目录** — 必须写入 `${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/` 目录
3. **真实数据** — 所有字段来自 TAPD API 返回值或代码定义，禁止编造
4. **动态参数** — 从用户消息提取，禁止写死默认值

---

## 工作流（5 步）

### Step 1：提取参数

从用户消息中解析：

| 参数 | 必填 | 提取方式 |
|------|------|---------|
| `workspace_id` | ✅ | 正则 `tapd_fe/(\d+)/` 从 TAPD 链接提取 |
| 处理人 | ✅ | "处理人: XXX"、"负责人: XXX"、"指派给 XXX" |
| `storyId` | ✅ | `/harness fixbugs <storyId>` 或用户消息中指定 |
| `story_id` | 选填 | `/story/detail/{story_id}` 从 TAPD 链接提取 |
| 状态筛选 | 选填 | 默认 "待解决"，可指定 "重新打开" 等 |
| 终端类型 | 选填 | "H5"、"PC"、"移动端"、"小程序" |

**输出目录确定**：

```bash
STORY_DIR=${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>
```

> 如果 `${STORY_DIR}` 目录不存在，需先创建。

### Step 2：采集需求关联的 Bugs

#### 主流程：需求 → 关联 Bugs → 按处理人过滤

这是最常用的路径（`/harness fixbugs` 走此路径）：

```
1. get_stories_or_tasks(workspace_id, story_id)
   → 获取需求标题（用于命名报告文件）

2. get_related_bugs(workspace_id, story_id)
   → 获取需求关联的 bug_id 列表

3. 遍历 bug_id 列表，逐个 get_bug(id)
   → 按 current_owner 过滤：仅保留处理人匹配的 bugs
   → 按状态筛选（如有指定）

4. 对保留的 bugs 执行 Step 3→4→5
```

#### 备选路径

**有缺陷链接 → 查单个 bug**：
```
get_bug → id=提取的 bug_id
```

**仅有处理人 → workspace 级别查询**：
```
get_bug_count → get_bug(current_owner + 状态筛选，分页拉取)
```

### Step 3：读取 Bug 详情

对每个过滤后的 bug 调用：

| MCP 工具 | 用途 |
|----------|------|
| `get_comments` | 读取评论（开发讨论、处理记录） |
| `get_entity_attachments` | 获取附件（日志、截图文件） |
| `get_image` | 获取截图（如有图片引用） |
| `get_entity_custom_fields` | 自定义字段（如终端类型、严重级别） |

### Step 4：逐条深度分析

对每个 bug 执行：

#### 4.1 问题理解
- 1-2 句话复述 bug
- 提取操作路径、预期 vs 实际行为
- 从标题 + 描述 + 评论中还原完整上下文

#### 4.2 终端识别
- **H5**：小程序、Vant、REM、移动端、vzanlivemobile / vzanlive
- **PC**：客服工作台、Element Plus / ElementUI、PC端、userlive

#### 4.3 代码定位

**双源并行检索，交叉验证收敛**：

```
kb-query ∥ graphify  →  交叉验证  →  search_content 兜底
```

1. **同时发起两路检索**（不是先后降级）
   - **知识库** (`kb-query`)：按功能模块/接口名检索，拿到业务语义 + 候选文件 + 该域历史踩坑
   - **graphify**：`query "<报错信息/功能关键词>"` 拿到结构视图，`explain "<模块>"` 理解职责，`path "<API>" "<渲染出口>"` 追数据流

2. **交叉验证收敛到嫌疑点**

   | 情况 | 处理 |
   |------|------|
   | 两者都指向同一文件 | 最高置信度，优先精读该文件 |
   | 仅知识库命中 | `graphify query` 补调用方，bug 可能在上游 |
   | 仅 graphify 命中 | 知识库缺此模块，报告末尾建议 `kb-update` |
   | 两边冲突 | 以源码为准，标注知识库过期 |

   > 知识库的 `pitfalls.md` 常直接命中同类历史 bug，graphify 的调用链常暴露「需求没提但被波及」的隐式路径 —— 两者互补，缺一路就容易定位到表象而非根因。

3. **源码搜索兜底**：`search_content` + `search_file`，仅当上述两路都没定位到文件时使用

定位到**具体文件 + 函数 + 行号**。

#### 4.4 根因分析
- 判断：代码逻辑缺陷 / 数据异常 / 接口问题 / 环境问题
- 追踪数据流：API → Store → computed → 渲染
- 提取触发条件

### Step 5：分类 + 产出报告到 Story 目录

#### 5.1 问题分类

| 类别 | 负责方 | 说明 |
|------|--------|------|
| 前端-Bug | 前端修改 | 逻辑错误、渲染异常 |
| 前端-体验 | 前端优化 | UI 不美观、交互不便 |
| 后端-Bug | 后端修复 | 接口报错、数据错误 |
| 后端-缺失 | 后端补充 | 缺少字段、接口未实现 |
| 协作-联调 | 双方协作 | 接口定义不一致 |

#### 5.2 输出路径

```
${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/{storyTitle}_bug分析报告.md
```

> 文件名使用 `get_stories_or_tasks` 返回的需求标题，非法字符替换为 `_`。

#### 5.3 报告文件结构

```markdown
# {storyTitle}_bug分析报告

## 1. 总览

| # | Bug ID | 标题 | 终端 | 分类 | 优先级 | 文件 |
|---|--------|------|------|------|--------|------|

## 2. 按项目分组的 Bug 清单

### 项目 A (路径)
| Bug # | 标题 | 文件 |

### 项目 B (路径)
| Bug # | 标题 | 文件 |

## 3. 逐条详细分析

### Bug #1: {标题}

#### 缺陷复述
#### 根因分析
##### 数据流追踪
##### 触发条件
##### 代码定位
#### 修复建议
#### 测试验证

### Bug #2: {标题}
...

## 4. 修复优先级建议

| 优先级 | Bug | 原因 |
|--------|-----|------|
| P0 | #3 | 阻塞核心流程 |
| P1 | #1, #5 | 影响用户体验 |
...
```

---

## 工具参考

### TAPD MCP 工具

| 工具 | 用途 |
|------|------|
| `get_bug` | 按 ID 查询单个缺陷详情 |
| `get_bug_count` | 统计缺陷数量 |
| `get_related_bugs` | 查询需求关联的 bug_id 列表 |
| `get_stories_or_tasks` | 查询需求详情（获取标题） |
| `get_comments` | 读取缺陷评论 |
| `get_entity_attachments` | 获取附件列表 |
| `get_image` | 获取截图/图片 |
| `get_entity_custom_fields` | 自定义字段配置 |

### 代码定位工具（双源并行 + 兜底）

| 层级 | 工具 | 用途 |
|------|------|------|
| 主检索 A | `kb-query` skill | 语义层：按功能模块/接口名查结构化文档、历史踩坑 |
| 主检索 B | `graphify query/explain/path` | 结构层：搜关键词、理解模块职责、追调用链与数据流 |
| 兜底 | `search_content` + `search_file` | 文本匹配，仅当 A+B 都未定位到文件时使用 |

> A 与 B **同时调用**并交叉验证，不是 A 命中就跳过 B。
