# 定时任务提示词模板 —— 自动修复模式

> 查到缺陷后交给 `/start fixbugs` 走完整 7 Phase 流水线。分析、门控、dev-pass、验收、
> TAPD 回写全部由 harness 负责，本任务不自行分析、不改代码、不建 Agent Team。
>
> 整段写入定时任务能力的 `prompt` 字段，**只替换 `{{}}` 占位，不改结构**。

````
【定时任务：轮询需求「{{STORY_TITLE}}」的关联 Bug 并自动修复】

需求：「{{STORY_TITLE}}」（TAPD id：{{TAPD_STORY_ID}}）的关联缺陷。

变量约定：
- 需求标题：{{STORY_TITLE}}（中文全称，照抄需求标题，不要改写、不要截断）
- 项目 workspace_id：{{WORKSPACE_ID}}（整数）
- 需求 id：{{TAPD_STORY_ID}}（有子需求时主+子 id 逗号拼接）
- 处理人：{{OWNER}}
- 状态过滤：new（新）| reopened（重新打开）
- 工作流 Story ID：{{STORY_ID}}（固定不变，复用同一个 Story，禁止新建）

范围：本仓库是前端项目。分类为 backend / collab 的缺陷由 harness 写评论转交，不改代码。

════════ 第 0 步：锁检查（只读，不做任何写入）════════

读 {{PLANS_DIR}}/.harness-active（JSON：active / storyId / title / mode / activatedAt）。

| 情况 | 动作 |
|------|------|
| 文件不存在 | 正常，进入第 1 步 |
| 存在且 storyId === {{STORY_ID}} | 输出「上一轮仍在执行（Phase N），本轮跳过」，**立即结束**：不查 TAPD、不读 bug-list、不改任何文件 |
| 存在且 storyId !== {{STORY_ID}} | 输出「其他 Story（<storyId>）占用中，本轮跳过」，**立即结束** |

若标志存在但对应 e2e-state.json 已不存在或已归档，属陈旧残留：
输出「检测到陈旧的 harness 激活标志，请先执行 /end 清理」，本轮结束。
**不要自己删除该标志** —— 清理激活状态是状态操作，只能由 /end 执行。

════════ 第 1 步：查询缺陷（两次调用）════════

口径：需求关联 ∩ 处理人「{{OWNER}}」∩ 状态「new | reopened」。
关联边界只用 get_related_bugs；禁止 workspace 级全量查询；禁止标题关键词比对。

【1-1】取关联集合（只调一次）
get_related_bugs(workspace_id={{WORKSPACE_ID}}, options={"story_id": "{{TAPD_STORY_ID}}"})
- workspace_id 必须是整数；story_id 蛇形且键名带双引号
- 返回 data:[{bug_id,...}]，无 count → N = data.length；limit/page 被忽略，一次返回全量
- N = 0 → 本轮 0 条，跳第 6 步出报告（不建流、不改任何文件）

【1-2】一次批量过滤（不要逐条循环）
get_bug(workspace_id={{WORKSPACE_ID}}, options={
  id: "<N 个 bug_id 逗号拼接>",
  current_owner: "{{OWNER}}",
  status: "new|reopened",
  limit: 200,
  fields: "id,title,status,current_owner,created,module,description"
})
- id / current_owner / status 同层 AND，一次调用完成；id 必须放 options 里
- limit 必须 >= N；N > 200 时按 100 一批切片，每批 limit:200
- 状态必须传英文 key；本项目：new=新 / reopened=重新打开 / in_progress=接受处理 /
  assigned=已分配 / verified=已验证 / postponed=延期 / resolved=已解决 / rejected=已拒绝
- fields 必须显式声明，否则 title/description 不返回

【1-3】判定
- data 非空 → 命中集合，进第 3 步
- data 空且 count=0 → 0 条，跳第 6 步
- count>0 但 data 空 → limit 不够，加大重查，不许当成 0 条

════════ 第 3 步：与 bug-list.json 对账（只读，不写）════════

读 {{PLANS_DIR}}/{{STORY_ID}}/bug-list.json。
- 文件不存在 → 全部命中都是「新缺陷」（首轮），直接进第 4 步
- 文件存在 → 对每条命中按下面四态分流

对每个命中的 bugId，在 bugs[] 里查找，并按顺序判定：

【3-A】bugs[] 中找不到该 bugId
  → 判定：新缺陷。首次进入流程。

【3-B】找到，且 writeback 存在（我们曾写过评论）
  实时调 get_comments(workspace_id={{WORKSPACE_ID}}, options={bug_id: "<bugId>"})，
  按时间升序取最近 10 条，取出最新一条评论的时间 latestCommentAt。

  | 比较 | 判定 | 含义 |
  |------|------|------|
  | latestCommentAt > writeback.commentedAt | **真打回** | 我们修完后测试又复现并留言 |
  | latestCommentAt <= writeback.commentedAt | **疑似误操作** | 状态变了但没人说话，读评论确认 |

  再结合 writeback.commentKind 细分：
  - fixed      → 我们写过「已修复」被打回，重点查「修得不全 / 环境未更新」
  - to_backend → 我们只转给后端，从未修过前端代码。这是后端修完被打回，
                 **重新分析并考虑改分类为 frontend**（后端改过一次失败，可能需要前端配合）
  - to_collab  → 同上，重新分析并考虑改分类
  - manual     → 曾经转人工，被打回说明仍需人工判断，本轮转人工确认

  判定为「真打回」时，读到的评论要点必须写进本轮报告，并注明属于哪一类：
    A. 没修好（现象与原缺陷一致）→ 重新查根因
    B. 新问题（现象超出原缺陷范围）→ 建议测试拆分单独立缺陷
    C. 判断不出（只有「还是不行」）→ 转人工确认

【3-C】找到，但没有 writeback（我们只分析过、没写评论）
  → 判定：重新分析。可能是上一轮分析后未走到修复，或分类需要修正。

【3-D】找到，writeback 存在，但 TAPD 状态仍为 new
  → 这是正常现象（改完等人工提测，状态由人流转）。
  → **跳过，不要重复修复**。报告里记「已修复待流转」。

════════ 第 4 步：交给 harness 修复 ════════

把第 3 步得出的「待处理集合」（新缺陷 + 真打回 + 疑似误操作 + 重新分析项）交给 harness。

【4-1】bug-list.json 不存在（首轮）
  按 /start skill 入口 A 建流：mode = fixbugs，storyId 用 {{STORY_ID}}，
  sources 填 tapdUrl / workspaceId / storyIdInTapd / owner。
  **不要省略 storyId 让脚本自动生成**。

【4-2】bug-list.json 已存在
  不手改 bug-list.json（它是 Phase 0→1 门控依据）。
  把「待处理集合」的 bugId 列表与判定结论写进 {{PLANS_DIR}}/{{STORY_ID}}/story-input.json 的
  sources.text 字段（追加，不覆盖原值），然后按 /start 入口 B 继续推进 ——
  Phase 0 需求分析师会重新拉 TAPD 并据此更新清单。

【4-3】待处理集合为空
  输出「本轮无新增缺陷」并跳第 6 步，不建流、不推进。

之后**严格按 /start skill 的三步循环执行**：
  Step 1 执行 dispatch.js → Step 2 按 status 四态（ready / fix_loop / blocked / terminal）分支
  → Step 3 子 Agent 汇报后回 Step 1。
修复、门控、dev-pass、TAPD 回写全部由 harness 负责，本任务不介入。

════════ 第 5 步：终态处理 ════════

dispatch 返回 terminal 时，**不要自动重开工作流**，输出待办并结束：

  本 Story 已完成（Phase 7）。本轮检测到 N 个新缺陷：<id> <标题>...
  建议执行 /harness archive 归档后重新发起。

不做 --rollback：定时任务无权决定「何时开启新一轮开发」。

════════ 第 6 步：输出报告 ════════

本轮必须输出（并写入 {{PLANS_DIR}}/{{STORY_ID}}/cron-report-<YYYYMMDD-HHmm>.md）：

1 锁检查结果：是否因进行中而跳过
2 查询统计：关联数 N / 状态命中数 / 待处理数
3 对账结果（逐条）：
   | bugId | 标题 | TAPD状态 | 本地记录 | 判定 | 依据 |
   判定取值：新缺陷 / 真打回 / 疑似误操作 / 重新分析 / 已修复待流转
4 harness 执行结果：本轮到哪个 Phase、是否有 blocked / fix_loop
5 待人工确认清单：bugId / 触发原因 / 待决问题

若本轮 0 条命中：只输出「本轮无符合条件的新缺陷」+ 关联数 N，不做其他动作。

════════ 铁律 ════════

- 🚫 不新建 storyId，永远复用 {{STORY_ID}}
- 🚫 不手改 bug-list.json / e2e-state.json / dev-pass.json
- 🚫 不删除 .harness-active（清理激活状态只能由 /end 执行）
- 🚫 不自行分析根因、不改代码、不建 Agent Team —— 这些是 harness 的职责
- 🚫 不执行 git commit / push，改动留在工作区由人处理
- 🚫 自动 repair 到终态后不自动重开
````

## 占位说明

| 占位 | 取值 | 示例 |
|------|------|------|
| `{{STORY_TITLE}}` | 需求中文标题，写在首行 | 【微赞+星享】【大众】红包领取上限支持按照时间段 |
| `{{WORKSPACE_ID}}` | TAPD workspace_id（**整数**） | 38260062 |
| `{{TAPD_STORY_ID}}` | TAPD 需求 id；有子需求时逗号拼接 | 1138260062001031699 |
| `{{OWNER}}` | 缺陷处理人（匹配 `current_owner`） | 蔡鹏 |
| `{{STORY_ID}}` | 本定时任务固定的工作流 Story ID | STORY-CRON-001031699 |
| `{{PLANS_DIR}}` | 项目状态目录 | `.codebuddy/plans`（绝对路径，正斜杠） |

## 四态分流的依据

TAPD 只能告诉我们「它现在是 reopened」，不能告诉我们「这个 reopened 是不是我们修出来的」。
判断依据在本地 `bug-list.json` 的 `writeback` 字段：

| 字段 | 语义 |
|------|------|
| `writeback.commentedAt` | 我们上次写评论的时间 |
| `writeback.commentKind` | 上次写的哪类评论（fixed / to_backend / to_collab / manual） |
| `writeback.statusChangedAt` | 是否改过 TAPD 状态 |

评论时间靠**实时调 `get_comments`** 获得，不在 `bug-list.json` 里存 `lastCommentAt` ——
避免为单一用途给契约加字段（schema 骨架体积护栏也吃紧）。

## 与旧版（自建 Agent Team）的区别

| 维度 | 旧版 | 本版 |
|------|------|------|
| 修复实现 | 自建 planner/generator/evaluator Team | `/start fixbugs` 7 Phase 流水线 |
| 状态信源 | `todo-list.md` + `.lock` + 指纹 | `bug-list.json` + `.harness-active` |
| 质量门控 | evaluator 主观四查 | AC 契约 + schema + 门控脚本 |
| 提示词长度 | 392 行（内联整套流程） | ~150 行（大部分交给 harness） |

旧版最大的问题是**两套状态机互相污染**（旧 skill 自己记录过这个坑）。
整合后只有一个状态机，定时任务只负责「何时触发」。