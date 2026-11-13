# 定时任务提示词模板 —— 只查模式

> 全程只读：不改代码、不写 TAPD 评论、不改缺陷状态、不落盘、不建 agent team、不调 /start。
> 需要「查到就修」请用 [fix-prompt-template.md](fix-prompt-template.md)。
>
> 整段写入定时任务能力的 `prompt` 字段，**只替换 `{{}}` 占位，不改结构**。

````
【定时任务：轮询需求「{{STORY_TITLE}}」的关联 Bug（只查不修）】

需求：需求「{{STORY_TITLE}}」（id：{{TAPD_STORY_ID}}）的关联缺陷。

变量约定：
- 需求标题：{{STORY_TITLE}}（中文全称，照抄需求标题，不要改写、不要截断）
- 项目 workspace_id：{{WORKSPACE_ID}}（整数）
- 需求 id：{{TAPD_STORY_ID}}（有子需求时主+子 id 逗号拼接）
- 处理人：{{OWNER}}
- 状态过滤：new（新）| reopened（重新打开）—— 本项目状态枚举里只有这两个参与巡检

口径：需求关联 ∩ 处理人「{{OWNER}}」∩ 状态「new | reopened」。
关联边界只用 get_related_bugs；禁止 workspace 级全量查询；禁止标题关键词比对。

第 1 步（查询缺陷）

【1-1】取关联集合（只调一次）
get_related_bugs(workspace_id={{WORKSPACE_ID}}, options={"story_id": "{{TAPD_STORY_ID}}"})
- workspace_id 必须是整数 {{WORKSPACE_ID}}（传字符串报 must be integer）
- story_id 是字符串字面量键名（带双引号）；参数名蛇形，不要驼峰
- 有子需求时，主需求 + 全部子需求 id 用逗号拼接在同一字符串里传
- 返回 data:[{workspace_id, story_id, bug_id}]，**无 count 字段** → N = data.length
- limit / page 被忽略，一次返回全量，不需要翻页
- N = 0 → 直接跳第 3 步，本轮判定 0 条

【1-2】一次批量查询（不要逐条循环调 get_bug）
get_bug(workspace_id={{WORKSPACE_ID}}, options={
  id: "<N 个 bug_id 逗号拼接>",
  current_owner: "{{OWNER}}",
  status: "new|reopened",
  limit: 200,
  fields: "id,title,status,current_owner,created,module,description"
})
- id / current_owner / status 是同一层 AND 条件，三者同时生效，一次调用即可
- id 必须放在 options 里；写顶层会报 additional properties
- limit 必须 >= N（默认 10 会把 data 截断，但 count 仍是真实匹配数，用它对账）
- N 超过 200 时按 100 个一批切片，每批都带 limit:200
- current_owner 填 TAPD 昵称，模糊匹配多人字段（"黄德鹏;蔡杰鹏;" 能被 "蔡杰鹏" 命中）
- fields 必须显式声明，否则 title / description 不返回
- 状态**必须传英文 key**；传中文会返回 0 条。本项目枚举：new=新 / in_progress=接受处理 / assigned=已分配 / verified=已验证 / postponed=延期 / reopened=重新打开 / resolved=已解决 / rejected=已拒绝。
  查询只认 new 与 reopened，其余状态不参与巡检

【1-3】结果判定
- data 非空 → 这些就是本轮命中的 bug
- data 为空且 count = 0 → 本轮 0 条，进第 3 步
- count > 0 但 data 为空 → limit 不足导致截断，加大 limit 重查，**不要当成 0 条**

硬约束：
❌ 禁止 get_bug(status="new|reopened") 不带 id 的 workspace 级全量拉取
❌ 禁止 get_bug({"story_id": ...}) —— 该字段恒为空，永远查不到
❌ 禁止按标题关键词（「客服」「会话」「忙碌」等）判定相关性或做兜底检索
❌ get_related_bugs 返回空数组时，直接判定本轮 0 条，不要改走搜索或 workspace 级兜底
✅ 归属只认「需求关联 + 处理人 + 状态」三者，不靠标题猜测
❌ 本任务**只做查询与报告**：不修改任何代码、不写 TAPD 评论、不改缺陷状态、
   不创建 todo list 文件、不创建 Agent 或 Team、不做根因分析

第 2 步：无 bug 时
若本轮 0 条：输出「本轮无符合条件的新 bug」+ 关联数 N + 状态命中数，然后结束。
不创建任何文件，不发起任何后续动作。

第 3 步（输出报告）
无论结果多少条，都必须在该轮输出中报告：
- 关联数 N（get_related_bugs 返回条数）
- 状态命中数、最终命中数（三者交集）
- 命中清单：id / 标题 / 状态 / 处理人 / 模块 / 创建时间 /
  链接 https://www.tapd.cn/{{WORKSPACE_ID}}/bugtrace/bugs/view/{id} / 判定理由
- 若有待解决但处理人不是「{{OWNER}}」的缺陷，单独列出并注明「处理人不匹配，不纳入」
- **`reopened` 的缺陷单独成组标注**，并注明「已重新打开，存在上次未修好的可能，转自动修复模式时会读取评论再分析」
  （只查模式自己不读评论，只提示）
- 本轮有命中时注明「如需修复请告知，本任务不会自动处理」
````

## 占位说明

| 占位 | 取值 | 示例 |
|------|------|------|
| {{STORY_TITLE}} | 需求中文标题，写在提示词首行，让人一眼看出这条任务是哪个需求 | 【微赞+星享】【惠康】线上优化：忙碌状态的客服，需要支持对用户进行重新发起会话 |
| {{WORKSPACE_ID}} | TAPD 项目 workspace_id（**整数**） | 38260062 |
| {{TAPD_STORY_ID}} | TAPD 需求 id；有子需求时逗号拼接 | 1138260062001031479 |
| {{OWNER}} | 缺陷处理人（匹配 `current_owner`） | 蔡杰鹏 |

## 两次调用的设计依据

| 步骤 | 调用 | 作用 |
|------|------|------|
| 1-1 | `get_related_bugs` | 唯一关联边界，拿 `N = data.length` 个 bug_id |
| 1-2 | `get_bug` 带 `id`+`current_owner`+`status` | 三条件同层 AND，一次过滤完 |

对比逐条查询：N=18 时从 19 次调用降到 2 次，且过滤在服务端完成，无需逐条人工判断。

## 只查模式的边界（必须守住）

| 动作 | 只查模式 |
|------|:---:|
| 调 TAPD 查询接口 | ✅ |
| 输出文本清单 | ✅ |
| 落盘 todo list | ❌ |
| graphify / kb-query 分析 | ❌ |
| 写 TAPD 评论 / 改状态 | ❌ |
| 创建 Agent / Team | ❌ |
| 改代码 / git 操作 | ❌ |

## 只替换，不改结构

步骤顺序和分支含义都是踩坑总结出来的（见 SKILL.md 与 references/建任务实操.md），局部删改会导致模型行为偏移。
用户要求调整时，改占位或改单段内容，然后**整段重新生成**再创建任务。