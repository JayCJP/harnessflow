# TAPD 查询口径与状态枚举

> 定时任务两种模式共用的查询规则。修复流程不在这里 —— 见 `/start fixbugs` 的 `references/phases/`。

## 核心口径（一句话）

```
命中集合 = get_related_bugs 关联 bug_id 集合
         ∩ current_owner 命中「处理人」
         ∩ status ∈ {new, reopened}
```

关联边界**只用 `get_related_bugs`**。

## TAPD MCP 的真实能力边界（必读，2026-11 实测）

| 坑 | 实测结论 | 对策 |
|---|---|---|
| `get_bug` 的 `owner` / `story_id` 恒为空 | 用它们过滤=永远 0 条 | 处理人用 `current_owner`；不要用 `get_bug({story_id})` |
| 状态参数传中文 | `"待解决\|重新打开"` 返回 0 条 | **必须传英文 key**：查询 `new\|reopened`，回写 `in_progress` |
| `get_bug` 默认 `limit=10` | `data` 被截断，但 `count` 是真实匹配数 | `limit` 传 `>= N`，用 `count` 对账 |
| 逐条 `get_bug` 补详情 | 浪费 N 次调用 | `id` + `current_owner` + `status` 是**同层 AND**，一次批量搞定 |
| `fields` 不声明 | `title` / `description` 不返回 | 必须显式列出需要的字段 |
| `get_related_bugs` 无 `count` | 数量就是 `data.length` | 别找 count；`limit`/`page` 也会被忽略 |
| 多需求/子需求 | 单个 story_id 只能查一个 | 主+子 id **逗号拼接**在同一字符串里（实测 18+81 → 99 条一次返回） |
| 状态流转猜 key | 「接受/处理」实际是 `in_progress`，写成 `resolved` 会误关单 | 目标固定 `in_progress`；首次 `get_workflows_status_map` 校验 |

## TAPD 缺陷状态枚举（2026-11 实测）

| 英文 key | 中文名 | 用途 |
|---|---|---|
| `new` | 新 | **查询**：待解决 |
| `reopened` | 重新打开 | **查询**：回归失败重开；**必须读评论**（见下文） |
| `in_progress` | 接受/处理 | **回写**：验收通过后的目标状态 |
| `assigned` | 已分配 | 只读参考 |
| `verified` | 已验证 | 只读参考 |
| `resolved` | 已解决 | 只读参考（**不自动写入**） |
| `postponed` | 延期 | 只读参考 |
| `rejected` | 已拒绝 | 只读参考 |

- **查询过滤**只认 `new` / `reopened`，其余状态一律不参与巡检。
- **回写目标**固定 `in_progress`（中文「接受/处理」），不要写成 `resolved`。
- 首次调用 `get_workflows_status_map(workspace_id)` 校验一次；若返回 key 与此表不符，**以接口返回为准**并在报告里告警。
- 这张表是避免猜 key 的兜底，不是替代校验的理由。

## 正确姿势（两次调用）

```json
// 1. 关联集合
get_related_bugs(38260062, {"story_id": "<主需求ID,子需求ID...>"})
// → data:[{bug_id,...}]，N = data.length

// 2. 一次批量过滤（三条件同层 AND）
get_bug(38260062, {
  "id": "<N 个 bug_id 逗号拼接>",
  "current_owner": "<姓名>",
  "status": "new|reopened",
  "limit": 200,
  "fields": "id,title,status,current_owner,created,module,description"
})
```

`current_owner` 是模糊匹配多人字段，`"黄德鹏;蔡杰鹏;"` 能被 `"蔡杰鹏"` 命中。

## 结果判定

| 情况 | 判定 |
|---|---|
| `data` 非空 | 命中集合 |
| `data` 空且 `count=0` | 本轮 0 条 |
| `count > 0` 但 `data` 空 | `limit` 不足被截断，加大重查，**不要当成 0 条** |

## 硬约束

- ❌ 禁止 `get_bug(status="new|reopened")` 不带 id 的 workspace 级全量拉取
- ❌ 禁止 `get_bug({"story_id": ...})`（字段恒为空）
- ❌ 禁止按标题关键词判定相关性或兜底检索
- ❌ `get_related_bugs` 返回空数组 = 本轮 0 条，不要改走搜索
- ✅ 归属只认「需求关联 + 处理人 + 状态」

## 评论读取（reopened 必读）

`get_comments` 不只用于写评论前去重，**在重新打开场景下它是分析输入**。

### 何时必须读

| 条件 | 是否读评论 | 说明 |
|---|:---:|---|
| `status = reopened` | ✅ **无条件读** | 重新打开是人工动作，评论往往承载复现信息，**不比对指纹** |
| `status = new` 且本地无记录 | ❌ | 新 bug，描述即全部信息 |
| `status = new` 且指纹变化 | ✅ 读 | 描述被追加了内容，评论可能有补充 |
| `status = new` 且指纹未变 | ❌ | 纯重复命中，跳过 |

```
get_comments(workspace_id={{WORKSPACE_ID}}, options={bug_id: "<bug_id>"})
```

### 读哪些

- **按时间升序取最近 10 条**（含所有评论者，不只是自己写的）
- 重点看**测试/产品**写的评论，时间戳必须晚于上一次分析时间
- 没人写过评论时，`get_comments` 返回空 → 正常，不报错

### 读出来干什么

**必须区分两种情形**，处理方式完全不同：

| 情形 | 判断依据 | 动作 |
|---|---|---|
| **没修好** | 评论描述的现象与原 bug 一致（同一操作路径、同一预期 vs 实际） | 重新分析根因：原修复可能不完整或未覆盖边界 |
| **新问题** | 评论描述了原 bug 之外的现象（不同入口、不同场景） | 按新信息重新分类，可能归入不同类别 |
| **判断不出** | 评论信息模糊、只有「还是不行」 | 归 `待人工确认`，**不要猜** |

读到的评论要**作为代码证据之外的第二类证据**写入 `analysis/<bug_id>.md` 的「复现条件」段，标注来源与时间。

### 指纹的补充

指纹仍按 `标题前 40 字 + 描述前 200 字` 计算，**不把评论混入指纹** —— 评论会不断增加，混进去等于每轮都变、每轮重做。

`reopened` 靠**状态信号**触发读评论，不靠指纹。

## 回写工具

| 动作 | 调用 | 注意 |
|---|---|---|
| 写评论 | `create_comments(workspace_id, options={bug_id, description, ...})` | 纯文本 + 换行，不要 HTML |
| 改状态 | `update_bug(workspace_id, options={id, status, ...})` | `id` 放 options；`status` 用 `in_progress` |
| 查现状 | `get_comments` / `get_bug` | 写评论前先查，避免重复 |

**参数坑**：`workspace_id` 必须整数；`get_bug` / `update_bug` 的 `id` 必须放在 `options` 里（写顶层报 `additional properties`）；`story_id` 蛇形且键名带双引号。