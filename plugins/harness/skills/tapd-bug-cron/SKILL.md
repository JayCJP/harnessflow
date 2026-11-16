---
name: tapd-bug-cron
description: >
  TAPD 缺陷定时巡检与自动修复 —— 为某个 TAPD 需求创建定时任务，按 cron 周期轮询其关联缺陷。
  两种模式：只查（零副作用，只输出清单）与自动修复（命中后交给 /start fixbugs 走完整
  7 Phase 流水线，含门控、dev-pass、TAPD 回写）。复用 harness 的 .harness-active 单例锁，
  有进行中的工作流时本轮直接跳过。
  用户说「定时查 bug / 定时修 bug / 建个缺陷巡检任务 / 轮询这个需求的缺陷」时使用本 skill。
  单次手动修 bug 请直接用 /start fixbugs，不要走本 skill。
---

# TAPD 缺陷定时巡检

> **本 skill 只负责「定时触发」这一件事。** 修复本身完全交给 `/start fixbugs` ——
> 分析、门控、dev-pass、验收、TAPD 回写都在那边，这里不重复实现，也不另建 Agent Team。

## 模式判定

| 用户信号 | 模式 |
|---|---|
| 「定时查 / 只查 / 先别动代码 / 观察一下」 | **只查** |
| 「定时修 / 查到就修 / 自动处理缺陷 / 按流程修复」 | **自动修复** |
| 没说清 | **只查**（零副作用），并追问一句「要不要顺带自动修复？」 |

默认只查的理由：自动修复会改代码、写 TAPD 评论、改缺陷状态，全是外部副作用。
先跑一两轮校准查询口径与缺陷质量，再升级，代价低得多。

## 两种模式对照

| | 只查 | 自动修复 |
|---|---|---|
| 查询 TAPD | ✅ | ✅ |
| 输出清单报告 | ✅ | ✅ |
| 调 `/start fixbugs` | ❌ | ✅ |
| 改代码 | ❌ | ✅（由 harness 执行） |
| 写 TAPD 评论 / 改状态 | ❌ | ✅（由 harness 执行） |
| 外部副作用 | **无** | 有 |

## 建任务三件事

### 1. 确定固定 storyId（自动修复模式必做）

定时任务**必须复用同一个 Story**。每轮新建 Story 会让 `bug-list.json` 与历史断档，
reopened 判定也失去依据。

- 建任务时确定，形如 `STORY-CRON-<TAPD需求id后8位>`，写进提示词占位 `{{STORY_ID}}`
- 该 Story **只由这个定时任务推进**，不要手动另开

### 2. 生成提示词

- 只查 → [assets/query-prompt-template.md](assets/query-prompt-template.md)
- 自动修复 → [assets/fix-prompt-template.md](assets/fix-prompt-template.md)

**整段生成，只替换 `{{}}` 占位，不改结构** —— 步骤顺序与分支是踩坑总结，局部删改会让模型行为偏移。

### 3. 建任务约束

| # | 约束 |
|---|---|
| 1 | **提示词首行写需求中文标题**，照抄不截断 —— 任务列表只显示开头几十字，泛称认不出是哪个需求 |
| 2 | cron **避开 0 分和 30 分**：20 分钟 `7,27,47 * * * *`；30 分钟 `11,41 * * * *`；60 分钟 `13 * * * *` |
| 3 | 开启持久化，有效期 30 天 |
| 4 | **同一需求只保留一个任务**（只查与自动修复也算重复） |
| 5 | 删除旧任务前先展示 id / cron / prompt 前 50 字，确认后才删 |
| 6 | 建自动修复任务**必须告知用户**：会自动改代码 + 写 TAPD 评论 + 改状态 |
| 7 | 提醒用户把 `.codebuddy/` 加进 `.gitignore`（不擅自改） |
| 8 | 创建后核对：任务存在、cron 与预期一致、prompt 首行能看到需求标题、`{{STORY_ID}}` 已替换 |

任务 id 取自创建返回值或 `.codebuddy/scheduled_tasks.json` 的 `tasks[].id`，不要解析文本硬抠。

## 两条运行时铁律

### 铁律 1：有进行中的 harness → 本轮直接返回

定时任务第 0 步读 `.codebuddy/plans/.harness-active`：

| 情况 | 动作 |
|---|---|
| 存在且 `storyId` 是本任务的 Story | 输出「上一轮仍在执行（Phase N），本轮跳过」，**不查 TAPD、不改任何文件** |
| 存在但 `storyId` 是别的 Story | 输出「其他 Story 占用中（X），本轮跳过」 |
| 不存在 | 正常执行 |

**不新建 `.lock`** —— harness 的 `.harness-active` 就是单例锁，加一层就是两个信源。

**不自动清理陈旧标志**：标志残留时应提示用户执行 `/end`，清理激活状态属状态操作，
定时任务无权替用户决定。

### 铁律 2：reopened 判定看本地 `writeback`，不看 TAPD 单独判断

TAPD 只说「它现在是 reopened」，不说「这个 reopened 是不是我修出来的」。
判断依据在 `bug-list.json` 的 `writeback` 字段（由 `tapd-writeback.js --record` 写入）。

完整四态分流见 [assets/fix-prompt-template.md](assets/fix-prompt-template.md) 第 3 步，核心是：

| 情形 | 判据 | 含义 |
|---|---|---|
| 新缺陷 | `bugs[]` 里找不到该 bugId | 首次进入，正常分析 |
| 真打回 | 有 `writeback` 且评论时间晚于 `commentedAt` | 我们修完测试又复现，要重新查根因 |
| 疑似误操作 | 有 `writeback` 但评论时间早于或等于 | 状态变了没人说话，读一次评论确认 |
| 分类变化 | `commentKind` 是 `to_backend`/`to_collab` | 我们从没修过，是别人修了被打回，需重新分类 |

评论时间通过**实时调 `get_comments`** 获得，与 `writeback.commentedAt` 比对 ——
不在 `bug-list.json` 里存 `lastCommentAt`（避免为单一用途增加契约字段）。

## 与 /start fixbugs 的边界

| 动作 | 本 skill | /start fixbugs |
|---|---|---|
| 查 TAPD 缺陷 | ✅ 每轮 | ✅ Phase 0 一次 |
| 建 Story / 推进 Phase | ❌ | ✅ |
| 分析、修复、验收 | ❌ | ✅ |
| TAPD 回写 | ❌ | ✅ |
| 维护 `bug-list.json` | ❌ 只读比对 | ✅ 由需求分析师写 |

**定时任务不写 `bug-list.json`** —— 它是 Phase 0→1 门控依据，写它等于改门控输入。
对账结论只输出到报告，实际写入由 Phase 0 需求分析师完成。

## 到终态后怎么办

`dispatch` 返回 `terminal` 时，定时任务**不自动重开**，只输出待办：

```
本 Story 主流程已完成（至 Git 提交 + MR）。本轮检测到 N 个新缺陷：...
建议 /harness archive 归档后重新发起。
```

不做自动 `--rollback`：那等于让定时任务决定「什么时候开启新一轮开发」，是判断权回流。

---

## 按需读取

| 场景 | 读取文件 |
|------|---------|
| 生成只查模式的提示词 | `assets/query-prompt-template.md` |
| 生成自动修复模式的提示词 | `assets/fix-prompt-template.md` |
| 查 TAPD 的参数口径、状态枚举、踩坑 | `references/query-rules.md` |
| 建任务的具体操作要点与真实案例 | `references/建任务实操.md` |
