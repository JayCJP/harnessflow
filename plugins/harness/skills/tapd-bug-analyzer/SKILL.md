---
name: tapd-bug-analyzer
description: >
  TAPD 缺陷分析器 —— 从 TAPD 拉取需求关联的 bugs，按处理人过滤，
  逐条记录问题复述、复现步骤、代码定位、根因与责任方分类，产出结构化 Bug 分析报告。
  只采集事实，不产出修复方案（修复设计属于开发工程师）。
  报告写入 Story 的 plans 目录，由需求分析师在 Harness Phase 0 内部调用产出。
  触发：需求分析师在 fixbugs 模式下自行加载；用户提供 TAPD 链接 + 处理人。
  不执行代码修改，只产出分析文档。
---

# TAPD Bug Analyzer

## Overview

通过 TAPD MCP 采集需求关联的 bugs → 按处理人过滤 → 逐条采集事实（问题理解 → 复现路径 → 代码定位 → 根因追踪 → 责任方分类）→ 输出**结构化 Bug 分析报告**到 Story 的 plans 目录。

> 本 skill **只记录事实，不设计方案**。产出文档作为 Harness Phase 0 需求分析的输入材料。

## 🚨 边界：只回答「问题在哪、为什么」，不回答「应该怎么改」

这是本 skill 最容易越界的地方，单独强调：

| ✅ 应该写 | 🚫 禁止写 |
|----------|----------|
| 问题现象是什么 | 应该改成什么 |
| 怎么复现 | 修复建议 / 解决方案 / 改造方案 |
| 代码在哪个文件哪一行 | 伪代码、diff、`将 xxx 改为 yyy` |
| 为什么会错（数据流 + 触发条件） | 测试验证步骤 |
| 该谁负责（责任方分类） | 技术选型建议 |

**为什么这样切分**：

1. **上下文成本** —— 设计修复方案需要精读完整实现，而 Bug 分析阶段只需定位到嫌疑点。在分析阶段做设计会把大量源码拉进上下文，挤掉真正该记的事实。
2. **修复方案会过期** —— 报告在 Phase 0 产出，代码在 Phase 2 才改。中间 Phase 1 拆任务、多仓库协同都可能改变前提，Phase 0 写死的方案到 Phase 2 往往已不成立。
3. **职责归属** —— 开发工程师拿到「代码定位 + 根因」后会用 `kb-query ∥ graphify` 双源验证真实改动点再动手。上游给一个未经验证的方案，反而诱导开发跳过验证直接照抄。

> 责任方分类（前端-Bug / 后端-缺失 等）**不属于**修复方案，它是分诊事实 —— 决定这个 Bug 该不该由前端处理，必须保留。

## Harness 集成

```
Phase 0（需求分析师，单一上下文内完成两件事）
       │
       ├─ ① use_skill("tapd-bug-analyzer")
       │     └→ {STORY_DIR}/{storyTitle}_bug分析报告.md   ← 事实
       │
       └─ ② 基于 ① 的分析结论产出
             requirement-analysis.md（只引用 Bug 编号，不复制正文）
             acceptance-criteria.json（每个 Bug ≥ 1 条 AC）
             open-questions.json
                     │
                     ↓
       Phase 1 任务规划 → Phase 2 开发（自行设计修复）→ ...
```

- **调用方是需求分析师，不是主 Agent**。主 Agent 只把用户消息里的参数搬进 `story-input.json` 就结束职责，不加载本 skill、不做任何分析。
- 这样「分析」全程发生在需求分析师的上下文内：拉取 TAPD 原始数据、代码定位的中间推理都不会因跨 Agent 传递而丢失。
- 报告落在 Story 目录后，`prompt-builder.js` 的 `readStoryContext()` 会自动把它注入 Phase 0→8 的每个 prompt，无需任何人手动转述。

## 触发条件

- 需求分析师在 Phase 0 发现 `story-input.json` 的 `mode` 为 `fixbugs` → 自行加载本 skill
- 用户直接提供 TAPD 需求/缺陷链接 + 处理人
- 用户提到"分析 TAPD bugs"、"拉取 TAPD 缺陷"、"生成 Bug 报告"

> **所有参数（workspace_id、处理人、storyId 等）必须动态提取，禁止硬编码。**
> 参数优先从 `.codebuddy/plans/<storyId>/story-input.json` 的 `sources` 读取；该文件不存在时回退到当前用户消息。

## 核心约束

1. **只记录事实，不设计方案** — 见上文「边界」表格，产出中不得出现修复建议 / 测试验证章节
2. **只分析，不修代码** — 产出报告后即结束，不进入代码修改
3. **产出到 Story 目录** — 必须写入 `${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/` 目录
4. **真实数据** — 所有字段来自 TAPD API 返回值或代码定义，禁止编造
5. **动态参数** — 从 `story-input.json` 或用户消息提取，禁止写死默认值

---

## 工作流（5 步）

### Step 1：提取参数

**优先读取 `story-input.json`**（需求分析师在 Phase 0 的 prompt 中已获得其内容）：

```bash
STORY_DIR=${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>
cat ${STORY_DIR}/story-input.json
```

| 参数 | 必填 | story-input.json 字段 | 回退提取方式（无该文件时） |
|------|------|----------------------|--------------------------|
| `workspace_id` | ✅ | `sources.workspaceId` | 正则 `tapd_fe/(\d+)/` 从 TAPD 链接提取 |
| 处理人 | ✅ | `sources.owner` | "处理人: XXX"、"负责人: XXX"、"指派给 XXX" |
| `storyId` | ✅ | 顶层 `storyId` | `/start fixbugs <storyId>` 或用户消息中指定 |
| `story_id` | 选填 | `sources.storyIdInTapd` | `/story/detail/{story_id}` 从 TAPD 链接提取 |
| 状态筛选 | 选填 | `sources.statusFilter` | 默认 "待解决"，可指定 "重新打开" 等 |
| 终端类型 | 选填 | `sources.terminal` | "H5"、"PC"、"移动端"、"小程序" |

> 如果 `${STORY_DIR}` 目录不存在，需先创建。

### Step 2：采集需求关联的 Bugs

#### 主流程：需求 → 关联 Bugs → 按处理人过滤

这是最常用的路径（`/start fixbugs` 走此路径）：

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

| MCP 工具 | 必做 | 落进 bug-list.json 的字段 |
|----------|:---:|--------------------------|
| `get_bug` | ✅ | `status` / `title` / `description` |
| `get_comments` | ✅ **无条件** | `commentCount` / `lastCommentAt` / `commentDigest` |
| `get_entity_attachments` | 有则读 | 截图/日志要点写进报告正文 |
| `get_image` | 有则读 | 同上 |
| `get_entity_custom_fields` | 有则读 | 终端类型 / 严重级别 |

> **评论必须读，不看状态**。不论 `new` 还是 `reopened`，进 Phase 0 就要读评论：
> 测试往往只改状态、把复现信息（环境域名、版本号、录屏）写在评论里，`description` 里没有。
> 按状态决定读不读，会让「new 但有补充评论」的缺陷漏掉全部新信息。
>
> `commentDigest` 写一句话要点；确实没评论时写 `commentCount: 0` 并留空 digest ——
> **留空可以，不读不行**（Phase 0→1 门控会对此记 warning）。

### Step 4：逐条采集事实

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

> **定位到即停**。确认「问题出在这里」就够了，不要为了设计改法而通读整个模块 —— 那是 Phase 2 开发工程师的工作，且他会重新做一次双源验证。

#### 4.4 根因分析
- 判断：代码逻辑缺陷 / 数据异常 / 接口问题 / 环境问题
- 追踪数据流：API → Store → computed → 渲染
- 提取触发条件（什么情况下会错、什么情况下不会错）

> 根因回答的是「**为什么会错**」，不是「**应该怎么改**」。
> ✅「`userInfo` 在 onMounted 前被 computed 读取，此时为 undefined」
> 🚫「应把初始化移到 created 中」

#### 4.5 复现步骤

这是本次分析要交付给开发工程师的关键事实之一 —— 开发无法复现就无法验证修复是否生效。

按以下结构记录，信息来自 TAPD 描述 + 评论 + 截图：

```
前置条件: 账号类型 / 数据状态 / 环境（测试环境、特定商户）
复现步骤: 1. ... 2. ... 3. ...（可点击可操作的具体动作）
预期结果: ...
实际结果: ...
复现概率: 必现 / 偶现（附触发条件）
```

> TAPD 信息不足以还原复现路径时，**如实标注「TAPD 未提供，需向报告人确认」**，不要凭代码推测编造步骤 —— 编造的复现路径会让开发按错误场景验证。此类缺口应由需求分析师写进 `open-questions.json`。

### Step 5：分类 + 产出报告到 Story 目录

#### 5.1 问题分类（责任方分诊）

| 类别 | 负责方 | 说明 |
|------|--------|------|
| 前端-Bug | 前端修改 | 逻辑错误、渲染异常 |
| 前端-体验 | 前端优化 | UI 不美观、交互不便 |
| 后端-Bug | 后端修复 | 接口报错、数据错误 |
| 后端-缺失 | 后端补充 | 缺少字段、接口未实现 |
| 协作-联调 | 双方协作 | 接口定义不一致 |

> 分类只判断「该谁改」，不判断「怎么改」。后端类问题标注清楚后，需求分析师会把它转成 `open-questions.json` 的待确认项，而不是排进前端开发任务。

#### 5.2 输出路径（两个文件，缺一不可）

```
${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/{storyTitle}_bug分析报告.md   ← 人读，事实记录
${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>/bug-list.json                 ← 程序读，唯一结构化信源
```

> 报告文件名使用 `get_stories_or_tasks` 返回的需求标题，非法字符替换为 `_`。
> 后缀必须是 `_bug分析报告.md` —— `prompt-builder.js` 与门控校验都按此后缀自动发现该文件。
>
> `bug-list.json` 是 **fixbugs 模式的必需产出物**（Phase 0→1 门控硬校验），格式见
> `scripts/schemas/bug-list.schema.json`。职责切分：报告给人看（复现步骤、数据流、代码定位），
> 清单给程序读（状态、分类、评论证据、回写凭证）。**两边信息不能互相缺失**：报告里有的
> 缺陷必须在清单里有一条，清单里的 `category` 必须与报告的分类章节一致。

`bug-list.json` 最小样例：

```json
{
  "syncedAt": "2026-11-13T10:20:00+08:00",
  "bugs": [
    {
      "bugId": "1218765",
      "title": "会话窗口缺少工单草稿标识",
      "status": "new",
      "category": "frontend",
      "fingerprint": "a1b2c3d4",
      "commentCount": 3,
      "commentDigest": "测试补充：仅在 PC 端复现，H5 正常",
      "lastCommentAt": "2026-11-12T15:30:00+08:00",
      "linked": true
    },
    {
      "bugId": "1218790",
      "title": "工单列表不显示草稿状态",
      "status": "new",
      "category": "backend",
      "commentCount": 0,
      "linked": false
    }
  ]
}
```

字段口径：

| 字段 | 含义 | 注意 |
|------|------|------|
| `status` | TAPD **原始状态**（new / reopened / in_progress…） | 不是本地修复进度 |
| `category` | 分诊结论 frontend / backend / collab | 与 5.1 的分类对应关系见下 |
| `linked` | 是否排进本次修复范围 | backend / collab 通常 `false` |
| `writeback` | 回写凭证（由 `tapd-writeback.js --record` 写） | **需求分析师不要手写此字段** |

分类映射（5.1 → `category`）：`前端-Bug` / `前端-体验` → `frontend`；
`后端-Bug` / `后端-缺失` → `backend`；`协作-联调` → `collab`。

#### 5.3 报告文件结构

```markdown
# {storyTitle}_bug分析报告

> 本报告只记录事实（问题 / 复现 / 定位 / 根因），不含修复方案。
> 修复实现由 Phase 2 前端开发工程师基于「代码定位」自行设计。

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
#### 复现步骤
（前置条件 / 步骤 / 预期结果 / 实际结果 / 复现概率）
#### 根因分析
##### 数据流追踪
##### 触发条件
##### 代码定位
（文件 + 函数 + 行号；标注 kb-query / graphify 两路的命中情况与置信度）

### Bug #2: {标题}
...

## 4. 优先级排序

| 优先级 | Bug | 原因 |
|--------|-----|------|
| P0 | #3 | 阻塞核心流程 |
| P1 | #1, #5 | 影响用户体验 |
...
```

> 🚫 报告中不得出现 `#### 修复建议`、`#### 解决方案`、`#### 测试验证` 等章节。
> Phase 0→1 门控（`policy.js`）会扫描标题行，命中时输出 warning。

#### 5.4 TAPD 回写（分类后立即做，只对 backend / collab）

需求分析师产出清单后，**本轮不修的前端之外缺陷要立刻告知相关方**，不要等修复流程走完。

| 分类 | 动作 |
|------|------|
| `backend` | `create_comments` 写「转后端」评论，**不改状态** |
| `collab` | `create_comments` 写「待联调」评论，**不改状态** |
| `frontend` | **此处不写评论** —— 等 Phase 3 验收通过后统一写（避免先写「已修复」又被打回） |

评论正文由脚本生成，**不要自己组织措辞**：

```bash
# 1. 首次校验状态映射（本轮只需一次）
node ${HARNESS}/../services/tapd-writeback.js <storyId> --check-status-map '<get_workflows_status_map 的返回 JSON>'

# 2. 生成评论正文 —— to_backend 要写清后端服务/接口/字段/预期行为（协议契约）
node ${HARNESS}/../services/tapd-writeback.js <storyId> --compose to_backend \
  --symptom '工单列表不显示草稿状态' \
  --frontend-checked '前端已正确透传 orderId 并按返回字段渲染' \
  --backend-service '工单服务' \
  --api-endpoint 'GET /api/tickets' \
  --fields '缺少 draftFlag 字段' \
  --expected-behavior '列表接口返回 draftFlag 标识草稿状态'
# to_collab 用 --compose to_collab --symptom ... --pending-items ... [--api-endpoint ... --fields ...]
# 接口/字段为可选段，信息不全时不填，模板自动用「未提供」占位

# 3. 把上一步输出 JSON 的 text 原样作为 create_comments 的 description 发出

# 4. 登记回写凭证（跨轮去重依据）
node ${HARNESS}/../services/tapd-writeback.js <storyId> --record <bugId> --kind to_backend
```

评论硬约束（脚本注释里也有）：

- **写协议契约，不写实现**：后端服务名、接口路径、字段名、预期值要写清；但不贴代码片段、
  不贴 diff、不列源码文件路径、不写函数名 —— 后者对后端定位问题没有价值
- **目标 500 字内说清楚**（软目标，不设硬上限），按结构分段承载信息
- 同一 bug 同一结论只写一次；`--record` 落的 `writeback.commentedAt` 就是去重凭证

---

## 工具参考

### TAPD MCP 工具

| 工具 | 用途 |
|------|------|
| `get_bug` | 按 ID 查询单个缺陷详情 |
| `get_bug_count` | 统计缺陷数量 |
| `get_related_bugs` | 查询需求关联的 bug_id 列表 |
| `get_stories_or_tasks` | 查询需求详情（获取标题） |
| `get_comments` | 读取缺陷评论（**每个缺陷必读**，也是写评论前的去重依据） |
| `create_comments` | 写评论（转后端 / 待联调场景） |
| `update_bug` | 改状态（**仅前端缺陷且验收通过**时置 `in_progress`） |
| `get_workflows_status_map` | 校验状态 key 与中文名是否匹配（首次调用一次） |
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
