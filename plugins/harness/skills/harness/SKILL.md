---
name: harness
description: >
  Harness 工作流执行器 — 8 Phase 端到端流水线（Bug 分析 → 需求分析 → 任务规划 →
  代码开发 → 审查 → 测试 → 部署）。两条入口：新建工作流（识别 run / fixbugs 意图、
  写 story-input.json、启动）与继续编排（已有工作流中途恢复）。
  用户说「做个需求 / 开发功能 / 实现某页面」「修 bug / 处理 TAPD 缺陷 / 某功能报错」
  「继续 / 恢复某个 Story」，或直接调用 /harness 时使用本 skill。
---

# Harness — 工作流执行器

> **渐进式披露**：本文档只保留两件必用内容 —— **入口判模**与**三步循环骨架**。
> 条件性内容已外移到 `references/`：新建工作流与 story-input schema（`启动入口.md`）、
> 8 Phase 逐相门控（`phases/phase-N.md`）、脚本 API（`api/*.md`）、错误恢复、代码检索、
> 工作流生命周期、Prompt 单一信源。用到时按文末索引表 `read_file`，避免常驻 context 浪费。

## 入口：先选一条

两条入口互斥，走完一条就进三步循环：

| 条件 | 走哪条 |
|------|--------|
| 还没有 Story（`.codebuddy/plans/<storyId>/e2e-state.json` 不存在） | **入口 A：新建** |
| 工作流已存在，或入口 A 刚启动完 | **入口 B：继续编排** |

两套流程（run / fixbugs）走**同一条** 8 Phase 流水线。它们的全部差异都由脚本按
`story-input.json` 自动处理（`getStoryMode` / `isPrototypeRequired` / `detectFigmaSource` /
`prompt-builder` 的 mode 分支），**你不需要为两种模式做任何额外动作** —— 只要 mode 和 sources 写对。

### 入口 A：新建工作流

三步：**判模式 → 写输入 → 启动**。

#### A1. 识别意图 —— 入口 A 里唯一需要判断的动作

| 信号 | 判定 |
|------|------|
| TAPD 链接 + 「修 / bug / 缺陷 / 反馈 / 报错 / 异常 / 不生效 / 白屏」 | `fixbugs` |
| 明确的故障描述（现有功能坏了、行为不对） | `fixbugs` |
| 原型链接 / Figma 链接 / 「新增 / 开发 / 实现 / 支持 / 做一个」 | `run` |
| 两类信号并存，或都没有 | 用 `AskUserQuestion` 问一次，**不要猜** |
| 用户拒答或仍无法判定 | 兜底 `run` |

**兜底为什么选 `run`**：误判成 `fixbugs` 会**静默**关掉 Figma 硬门控，UI 开发全程没有 frame 清单
校验且没人会发现；误判成 `run` 只会在 Phase 0 门控处**显性**阻塞（要求原型分析 / featurePoints），
一眼可见、一步可改。fail-loud 优于 fail-silent。

#### A2. 写输入并启动

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
│  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）   │
└─ 主 Agent         = 触发                （无判断权，机械执行）  ─┘
```

**触发权 ≠ 决定权**：命令由主 Agent 敲，但是否合法由 `advance-phase.js` 独立裁定。
主 Agent 传错 targetPhase（越界／跨阶／倒退）会被脚本拒绝，不会写坏状态。

## 执行流程（三步循环）

每个循环只有三步。**主 Agent 不读状态、不做判断、不拼 prompt。**

```
Step 1: 执行 node ${HARNESS}/dispatch.js <storyId>
        → 输出纯 JSON，含 status / nextAgent / agentPrompt / advanceCommand

Step 2: 按 status 分支（四态互斥且穷尽，无「其他情况自行处理」）

  ┌ ready     → 若 readyToAdvance=true: 先执行 advanceCommand，再回 Step 1
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入，不加工）
  ├ fix_loop  → 执行 recovery.command
  ├ blocked   → 按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束（未创建／已完成／已归档），按 recovery 提示收尾

Step 3: 子 Agent 汇报产出物路径 → 回到 Step 1
```

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
需要人读的 8 Phase 总表（名称 / 注册名 / 产出物 / 门控实现）见 `references/phases/README.md`。

两条必守：

- **Spawn 必须用注册名**（英文，agent frontmatter 的 `name`）。Agent 文件名和正文标题是中文，
  但注册键是英文 `name` —— 传中文名无法解析到 Agent。`dispatch.js` 的 `nextAgent` 已是注册名。
- **推进命令不要手写**：从 `dispatch.js` 的 `advanceCommand` 取，它已算好 `targetPhase`。

## 铁律

**状态与契约**（门控的自证性，破了就等于自己放行）:

- 🚫 不直接写 / 改 `e2e-state.json` 或 `dev-pass.json`（状态机唯一信源，hook 会拦截）
- 🚫 不跳过 Phase
- 🚫 不自标记 `open-questions.json` resolved
- 🚫 主 Agent 不直接写 / 改 Phase 契约产出物（`acceptance-criteria.json` / `task-dag.json` /
  `*-verification.json` 等）—— 门控校验的就是这些文件，主 Agent 手改等于自己放行；要改就派对应
  子 Agent 增量更新（P3-1，2026-09 实跑诊断：主 Agent 曾手改 AC/task-dag/自写 fix-verification）

**职责不越界**（分析必须在子 Agent 上下文内完成）:

- 🚫 主 Agent 不加载 `tapd-bug-analyzer`、不调任何 TAPD MCP 工具 —— 中间推理会在跨 Agent 传递中
  丢失，且上下文被原始数据撑满，后续 8 个 Phase 全程带着无关内容
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

### 8 Phase 详情

| 场景 | 读取文件 |
|------|---------|
| `advance-phase.js` 在 Phase N→N+1 报门控失败 | `references/phases/phase-N.md`（N=0~7，只读当前那一个） |
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
