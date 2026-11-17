---
name: start
description: >
  Start — Harness 工作流执行器（启动/推进 7 Phase 流水线：需求分析 → 任务规划 → 代码开发 →
  代码审查 → 知识库更新 → Git 提交 + MR（主流程终点）→ 云端部署（可选））。两条入口：新建工作流（识别 run / fixbugs 意图、
  写 story-input.json、启动）与继续编排（已有工作流中途恢复）。
  用户说「做个需求 / 开发功能 / 实现某页面」「修 bug / 处理 TAPD 缺陷 / 某功能报错」
  「继续 / 恢复某个 Story」，或直接调用 /start 时使用本 skill。
  如需结束/取消当前工作流的激活状态，使用 /end skill。
---

# Start — Harness 工作流执行器

> **渐进式披露**：本文档只保留两件必用内容 —— **入口判模**与**三步循环骨架**。
> 条件性内容已外移到 `references/`：新建工作流与 story-input schema（`启动入口.md`）、
> 7 Phase 逐相门控（`phases/phase-N.md`）、脚本 API（`api/*.md`）、错误恢复、代码检索、
> 工作流生命周期、Prompt 单一信源。用到时按文末索引表 `read_file`，避免常驻 context 浪费。

## 入口：先选一条

两条入口互斥，走完一条就进三步循环：

| 条件 | 走哪条 |
|------|--------|
| 还没有 Story（`.codebuddy/plans/<storyId>/e2e-state.json` 不存在） | **入口 A：新建** |
| 工作流已存在，或入口 A 刚启动完 | **入口 B：继续编排** |

> ⚠️ 判这张表之前**先确认 storyId**：用户已经给了 id 且目录存在 → 直接进入口 B，
> 不要因为「想重新开始」就新建一个。重复建 Story 是最常见的失控来源，见 A2。

两套流程（run / fixbugs）走**同一条** 7 Phase 流水线。它们的全部差异都由脚本按
`story-input.json` 自动处理（`getStoryMode` / `isPrototypeRequired` / `detectFigmaSource` /
`prompt-builder` 的 mode 分支），**你不需要为两种模式做任何额外动作** —— 只要 mode 和 sources 写对。

### 入口 A：新建工作流

四步：**判模式 → 定 storyId → 写输入 → 启动**。前两步都是「宁可多问一句，不要错判一次」。

#### A1. 判模式 —— 入口 A 里唯一需要判断的动作

先问一句本质问题：**这件事的新增能力是什么？**

| 本质 | 判定 | 典型信号 | 反例（看着像但不算） |
|------|------|---------|---------------------|
| **没有新增能力**，只是让已有的东西按原本该有的样子工作 | `fixbugs` | 报错 / 白屏 / 不生效 / 数值错 / 行为与预期不符 / TAPD 缺陷链接 / 「修一下」「这是 bug」 | 「优化一下这个页面的样式」——没有「坏了」的预期，属改善 |
| **有新增能力**，用户能做的事变多了 | `run` | 新增 / 开发 / 实现 / 支持 / 做一个 / 加一个 / 原型链接 / Figma 链接 | 改个文案、调个色值 —— 改动小但确实是「以前没有的形态」 |

**三分法（信号冲突时按这个顺序判）**：

1. **有缺陷载体 → `fixbugs`**：TAPD 链接 / bug 单号 / 「测试提的」「反馈说」
2. **有新增载体 → `run`**：原型链接 / Figma 链接 / PRD
3. **只有自然语言 → 看动词**：「坏 / 错 / 不 / 失效 / 异常 / 崩」→ `fixbugs`；
   「新 / 加 / 支持 / 实现 / 优化成」→ `run`

**两类信号同时出现**（如「这个页面报错，顺便把新加的导出功能也做了」）：
说明是两件事，**不要合并成一个 Story**。用 `AskUserQuestion` 问清「先修 bug 还是先做功能」，
按用户选择只建一个，另一件单独再开一轮。

**判不出来时**：用 `AskUserQuestion` 问一次，**不要猜**；用户拒答或仍无法判定 → 兜底 `run`。

**兜底为什么选 `run`**：误判成 `fixbugs` 会**静默**关掉 Figma 硬门控与 `featurePoints` 功能点枚举
（UI 开发全程没有 frame 清单校验、功能缺失也无人发现）；误判成 `run` 只会在 Phase 0 门控处
**显性**阻塞（要求原型分析 / featurePoints），一眼可见、一步可改。fail-loud 优于 fail-silent。

> 判错的代价不对称：`run` 判错会卡在门控（可救），`fixbugs` 判错会静默放行（不可救）。
> 所以**拿不准就往 `run` 靠**。

#### A2. 定 storyId —— 绝不轻易新建

> 🚫 **默认动作是「复用」，不是「新建」。** 新建 Story 意味着一整套 e2e-state / plans 目录 /
> 已产出的分析全部作废重来，代价远大于多问一句。

**按以下顺序判定，命中即停：**

| # | 情形 | 动作 |
|---|------|------|
| 1 | 用户消息里出现 storyId（`STORY-YYYYMMDD-NN` 或自定 id） | **直接用它**，不要「看起来像旧的就换个新的」 |
| 2 | 用户给了 TAPD 链接 + 需求 id | 先查是否已有 Story 覆盖同一需求（`story-input.json` 的 `sources.storyIdInTapd`），命中则复用 |
| 3 | `.codebuddy/plans/` 下存在同主题的 Story（标题相近 / 同一需求） | **列给用户选「复用 X 还是新建」**，不要自己决定 |
| 4 | 当前有激活的 Story（`.harness-active` 存在） | 脚本会直接拒绝启动并提示先 `/end` —— **不要绕过，按提示处理** |
| 5 | 确实全新 | 才新建。storyId **自己定**（如 `STORY-20261113-01`），不要省略让脚本自动生成 |

**为什么必须自己定 storyId 而不是省略**：省略时脚本会生成 `STORY-YYYYMMDD-NN`，而
`STORY_DIR` 需要提前知道才能写 `story-input.json` —— 拿不到目录就只能事后补救；
且自动生成的 id 与用户口头提到的 id 对不上时，会变成两个 Story 各跑一半。

**枚举已有 Story 的命令**（查同主题重复时用）：

```bash
ls ${CLAUDE_PROJECT_DIR}/.codebuddy/plans/                 # 全部 Story 目录
cat ${CLAUDE_PROJECT_DIR}/.codebuddy/plans/.harness-active  # 当前激活的 Story（若存在）
```

**复用已有 Story 的做法**：不调用 `start`（那会被「工作流已存在」拒绝），直接进
**入口 B 的三步循环** —— 它会自动接着当前 Phase 往下推。仅在需要更新输入时用
`create-workflow.js <storyId> --refresh-input` 回填。

> ⚠️ `createWorkflow` 遇到已存在的 storyId 会**报错拒绝**（不覆盖）。看到
> 「工作流已存在」不要换 id 重试 —— 那是脚本在提醒你「这个 Story 已经有了，去接着跑」。

#### A3. 写输入并启动

`sources` 字段表、两个 JSON 样例、schema 约束、启动命令全部在 `references/启动入口.md` ——
**现在 `read_file` 它**，按 Step 2A / 2B 执行。

> 🚫 入口 A 到此为止 —— 不要在这里判断 Phase、不要拼 prompt、不要自己调 `advance-phase.js`。
> 那些是下面三步循环的事。

启动成功后进 **入口 B**。

### 入口 B：继续编排

进入下面的**三步循环**。这是本 skill 的核心，也是运行时唯一需要反复执行的部分。

## 核心原则

> **AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**

三层职责边界，不可越界：

```
┌─ dispatch.js      = 读状态 + 说下一步   （只读，零写权限）      ─┐
│                     ↑ 下一步指令 / agentPrompt 的唯一出口        │
│  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）   │
│                     ↑ 只报推进结果，不输出下一步、不输出 prompt  │
└─ 主 Agent         = 触发                （无判断权，机械执行）  ─┘
```

**触发权 ≠ 决定权**：命令由主 Agent 敲，但是否合法由 `advance-phase.js` 独立裁定。
主 Agent 传错 targetPhase（越界／跨阶／倒退）会被脚本拒绝，不会写坏状态。

**推进后一律回 Step 1**：`advance-phase.js` 无论成功失败都不给下一步命令 ——
成功回 Step 1 取新 Phase 指令，失败回 Step 1 取 `recovery.command`。
命令只有一个信源，主 Agent 不自行拼 `--fix-loop` 之类的命令。

## 执行流程（三步循环）

每个循环只有三步。**主 Agent 不读状态、不做判断、不拼 prompt。**

```
Step 1: 执行 node ${HARNESS}/dispatch.js <storyId>
        → 输出纯 JSON，含 status / nextAgent / agentPrompt / advanceCommand

Step 2: 按 status 分支（四态互斥且穷尽，无「其他情况自行处理」）

  ┌ ready     → 若 readyToAdvance=true: 先执行 advanceCommand，再回 Step 1
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入，不加工）
  ├ fix_loop  → 执行 recovery.command
  ├ blocked   → 按 recovery.description 处理
  │             ├ type=user_confirmation_required: 把待确认项**一次性**列给用户
  │             │  （格式：Q-N 问题 / 建议稿 / 依据来源，blocking 项排前），
  │             │  用户逐条答复或明确说"全部采纳"
  │             │  → 逐条执行 resolve-question.js（--answer 用户原话 / --accept 采纳建议稿），
  │             │    用户明确表达"全部采纳"时用 --accept-all 一次落账
  │             │  → 回 Step 1（不要自行给 open-questions.json 加 confirmation）
  │             └ 其他 type: 按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束（未创建／已完成／已归档），按 recovery 提示收尾

Step 3: 子 Agent 汇报产出物路径 → 回到 Step 1
```

> **advanceCommand 执行完，无论成功失败都回 Step 1。**
> `advance-phase.js` 的输出只回答「推进了没有 / 门卡在哪」，`success: false` 时不要
> 自己找恢复命令 —— 回 Step 1，dispatch 会按 status 给 `recovery.command`。

如有 `warnings` → 转述给用户确认，但不因此改变分支。

**主 Agent 禁止的行为**:
- 🚫 禁止直接读取 e2e-state.json（由 dispatch.js 读取）
- 🚫 禁止自行判断当前 Phase 和下一步该调谁（由 dispatch.js 查表）
- 🚫 禁止自行处理异常恢复（由 dispatch.js 输出 recovery）
- 🚫 禁止改写 `agentPrompt` 正文或替换其内容（它已完整，无占位符）
- ✅ 主 Agent 只做两件机械动作: Spawn 指定的 Agent、执行给定的命令

## Spawn 前置注入（唯一允许的 prompt 加工）

`agentPrompt` 正文原样注入，但**允许在正文之前 prepend** 以下三类信息块（实测可消除大量子 Agent 空转与返工）：

1. **已验证环境事实块**（instinct 级，必须做）——主 Agent 此前实测过的环境结论，放 prompt 首部，标注
   「⚠️ 环境探测结论（已由主 Agent 实测验证，禁止重复探测，直接进入开发）」，典型条目：
   - CLI 可用性（如 `graphify.exe` 安装路径、Python 版本）与各仓 `graphify-out/graph.json` 存在性
   - 本地限制（用户禁止启动开发服务器 / npm 命令执行前须先询问 / 无法连接 test 环境）
   - 已核实的文件状态（哪些文件的未提交改动属上轮遗留，不属于本轮开发/审查范围）
   - 工具不可用时的降级路径（如 Bash 类工具不可用 → 用 Grep/Read 完成第二源验证，不要耗轮次探测）
   - 探测预算兜底：即使有此块，仍写明「环境探测最多允许 2 次工具调用」
   > 为什么必须做：子 Agent 看不到主 Agent 的执行历史，会从零开始探测环境。实测案例：3 个开发 Agent
   > 因误判 graphify 不可用全部耗尽轮次空转；重试时注入环境事实块后一次通过。
   >
   > P3-5（2026-09）: 跨仓检索入口（各仓绝对路径、graphify 图谱/知识库存在性预判、
   > `cd <repo> && graphify query` 标准样例）已由 prompt-builder 生成并注入 `agentPrompt` 正文 ——
   > 主 Agent 不必再为这些结论手工拼接前缀，前置注入仅保留 prompt 未覆盖的实测结论
   > （CLI 可用性、本地限制、文件遗留状态等）。
   >
   > 降级路径的边界：只指「换一种 agent 原生能力」（如 Bash 类工具不可用 → 用 Grep/Read 完成验证），

2. **用户裁决块**——主 Agent 已向用户确认的决议（如「某遗留项本轮不修，登记为开放风险」「某改动保留并随本轮提交」），防止子 Agent 把已裁决项重新当问题上报或擅自改动。
3. **重试说明块**——重试场景注明上轮失败原因与硬性要求（如「上一轮未落盘任何产出物，必须用 write_to_file 实际落盘，不要只在对话里输出内容」）。

> 除上述三类前置块外，禁止任何其它加工；三类块都只能**追加在正文之前**，不得插入或删改进正文。

## 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

## Phase → Agent（不作为执行依据）

运行时的权威来源是 `scripts/lib/state.js` 的 `PHASE_AGENTS`，由 `dispatch.js` 查表后以
`nextAgent` 字段输出。**主 Agent 用 `nextAgent`，不查任何表。**
需要人读的 7 Phase 总表（名称 / 注册名 / 产出物 / 门控实现）见 `references/phases/README.md`。

两条必守：

- **Spawn 必须用注册名**（英文，agent frontmatter 的 `name`）。Agent 文件名和正文标题是中文，
  但注册键是英文 `name` —— 传中文名无法解析到 Agent。`dispatch.js` 的 `nextAgent` 已是注册名。
- **推进命令不要手写**：从 `dispatch.js` 的 `advanceCommand` 取，它已算好 `targetPhase`。

## 铁律

**状态与契约**（门控的自证性，破了就等于自己放行）:

- 🚫 不直接写 / 改 `e2e-state.json` 或 `dev-pass.json`（状态机唯一信源，hook 会拦截）
- 🚫 不跳过 Phase
- 🚫 不替用户确认 open-questions：建议稿只写 `resolution`；**`confirmation` 字段只经
  `resolve-question.js` 在用户答复后写入**（--answer 用户原话 / --accept 采纳建议稿 / --accept-all
  全部采纳），任何 Agent 不得手写该字段（手写的 confirmation 会触发门控格式 warning 并被人工复核）
- 🚫 主 Agent 不直接写 / 改 Phase 契约产出物（`acceptance-criteria.json` / `task-dag.json` /
  `*-verification.json` 等）—— 门控校验的就是这些文件，主 Agent 手改等于自己放行；要改就派对应
  子 Agent 增量更新（P3-1，2026-09 实跑诊断：主 Agent 曾手改 AC/task-dag/自写 fix-verification）

**入口判定的两条硬约束**:

- 🚫 **不猜模式** —— 判不准就问，兜底选 `run`（误判成 fixbugs 会静默关闭 Figma 门控与功能点枚举）
- 🚫 **不轻易新建 Story** —— 先复用、先问、先查 `.harness-active`；用户给了 storyId 就用它。
  看到「工作流已存在」是脚本在让你去接着跑，不是让你换个 id 重来

**职责不越界**（分析必须在子 Agent 上下文内完成）:

- 🚫 主 Agent 不在分析阶段加载 `tapd-bug-analyzer`、不调 TAPD MCP 拉详情/评论 —— 中间推理
  会在跨 Agent 传递中丢失，且上下文被原始数据撑满，后续 7 个 Phase 全程带着无关内容。
  TAPD 交互在各自 Agent 会话内完成：Phase 0 分析由需求分析师、Phase 3 回写由代码审查师，主 Agent 不介入
- 🚫 主 Agent 不分析 Bug / 不判断改哪些文件 —— 那是 Phase 0 与 Phase 2 的职责
- 🚫 主 Agent 不自行拼 Phase 0 prompt —— `agentPrompt` 是唯一出口，自行拼装会导致注入内容逐轮不一致

---

## 按需读取的资源（渐进式披露）

> 下面四张表的触发条件都是**动作**，不是「想了解就读」。没发生对应动作就不要读，
> 常驻 context 只需要上面的骨架。

### 启动

| 场景 | 读取文件 |
|------|---------|
| 需要新建工作流 / 写 `story-input.json` / 查 `sources` 字段与样例 | `references/启动入口.md` |

### 编排通用

| 场景 | 读取文件 |
|------|---------|
| advance-phase 推进失败 | `references/错误恢复.md` |
| 需要查找/定位代码 | `references/代码检索规范.md` |
| 激活/查看/归档/复档工作流 | `references/工作流生命周期.md` |
| 理解为何不能加工 prompt | `references/Agent-Prompt-单一信源.md` |

### 7 Phase 详情

| 场景 | 读取文件 |
|------|---------|
| `advance-phase.js` 在 Phase N→N+1 报门控失败 | `references/phases/phase-N.md`（N=0~6，只读当前那一个） |
| 需要核对某 Phase 该产出什么 / Story 目录结构 / 通用门控 | `references/phases/README.md` |

`phase-N.md` 统一 5 段：职责与 Agent 注册名 → 产出物清单 → 出门门控（级别 + failureType）
→ 契约格式 → 常见失败与对策。

### 脚本 API（按意图查，不按目录查）

| 我要… | 读取文件 |
|-------|---------|
| 查 `dispatch.js` 输出字段 / 某个 CLI flag 怎么写 | `references/api/commands.md` |
| 改 Agent prompt 内容、加一道门控、改恢复建议 | `references/api/services.md` |
| 查 Phase 常量 / 产出物表 / dev-pass 与契约读取函数 | `references/api/lib.md` |
| 编辑或命令被 hook 拒绝了，要知道是谁拒的、怎么办 | `references/api/hooks.md` |
