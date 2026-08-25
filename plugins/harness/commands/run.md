---
description: 激活 / 关闭 Harness Engineering 端到端工作流，控制 src/ 编辑权限与 8 Phase 流程编排
category: workflow
allowed-tools: Bash, Write
---

# /harness — Harness Engineering 端到端工作流

> **核心原则：AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成。**
>
> **操作手册：AI 在执行前必须先调用 `use_skill("harness-conductor")` 加载编排器 skill，其中包含 Agent prompt 编写规范、常见失败模式对策、组件边界声明模板。**

---

## AI 执行协议 (MUST FOLLOW)

你是一个 Harness 工作流的主控 Agent。你的职责是 **调度 Agent 产出物 + 执行脚本推进 Phase**，而不是自己写状态文件。

### 必须加载的 Skill

在执行任何 Phase 操作前，先调用以下 skill：

```
use_skill("harness-conductor")
```

### 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
```

以下所有脚本路径均基于此目录。**始终使用完整路径** `node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/<脚本名>`。

### 执行流程（dispatch.js 单信源）

每轮只做三步，主 Agent 不读状态、不做判断、不拼 prompt：

```
Step 1: 执行 node $HARNESS/dispatch.js <storyId>
Step 2: 按 status 分支（四态互斥且穷尽）
  ┌ ready     → 若 readyToAdvance=true: 先执行 advanceCommand，再回 Step 1
  │             否则: Spawn nextAgent，prompt = agentPrompt（原样注入）
  ├ fix_loop  → 执行 recovery.command，再回 Step 1
  ├ blocked   → 按 recovery.description 处理，无 command 则转人工
  └ terminal  → 流程结束，按 recovery 提示收尾
Step 3: 子 Agent 汇报产出物路径 → 回 Step 1
```

dispatch.js 输出纯 JSON，含 `status` / `nextAgent` / `agentPrompt` / `advanceCommand` / `recovery`。
主 Agent 按 status 机械分支，**不自行判断当前 Phase 和下一步该调谁**。

dispatch.js 输出的 `nextAgent` 已是注册名，原样传给 Spawn 的 `name` 参数。
`agentPrompt` 已包含 Phase 上下文、契约文件内容、产出要求，原样传给 `prompt` 参数。
主 Agent 不读 Phase 不拼 prompt，只按 status 四态机械执行。

### Agent Prompt 单一信源

`agentPrompt` 由 `prompt-builder.js` 统一生成，**只有一个出口**: `dispatch.js` 的 `agentPrompt` 字段。
它已包含 Story ID、当前 Phase、上一 Phase 摘要、契约文件内容、历史教训、约束条款、产出物清单、
以及修复回路上下文（如有），**无占位符，原样注入即可**。

主 Agent **不得**自行读取 `contractFilesToLoad` / `phaseSummaryContent` / `lessonsFromHistory`
再拼装 prompt。一旦主 Agent 参与拼接，注入哪些上下文就变成一次自由裁量，
不同轮次内容不一致，Phase 2 的 `files[]` 写入范围也可能被漏掉——这是流程失控的直接来源。
prompt 内容需要调整时改 `prompt-builder.js`，不改主 Agent 行为。

### advance-phase.js 输出解读

只看 `success` 一个字段，两个分支：

```
success: true   → 回 Step 1 重新 dispatch.js（新 Phase 的指令由它给出）
success: false  → recovery.command 存在 → 原样执行 → 回 Step 1
                  recovery.command 为 null → 转人工，转述 recovery.description
```

输出中的 `phaseSummaryContent` / `contractFilesToLoad` / `lessonsFromHistory` 是
**给 `prompt-builder.js` 用的中间数据**，主 Agent 不消费、不解析、不注入。

### 错误恢复

**不需要决策树。** 恢复策略（fix-loop / `--auto-fix` 重试 / 降级 / 转人工）由 `policy.js`
按 `recovery level` 判定：1=自动修复、2=提示修复、3=降级、4=人工。主 Agent 不参与选择，
只执行 `dispatch.js` 或 `advance-phase.js` 给出的 `recovery.command`。

fix-loop 由 `advance-phase.js --fix-loop` 全程自动编排：提取 BLOCKER → 回退 Phase 2 →
重签限域 dev-pass（仅 `affectedFiles`）→ 生成 `fix-request.json` + `fix-context.md`。
执行完命令后回 Step 1，`dispatch.js` 会输出带 `fixLoopContext` 的 `agentPrompt`。

> 默认最大 2 轮，超出后 `dispatch.js` 输出 `status: blocked` 且 `recovery.command` 为 null → 转人工。

---

## 工作流生命周期命令

```bash
# 激活工作流（开始一个新 Story）
/harness start <storyId> "<标题>"
#   → 实际执行: node $HARNESS/harness-workflow.js start <storyId> "<标题>"
#   → 内部调用 create-workflow.js 创建 e2e-state.json
#   → 初始 Phase = 0

# 查看当前状态
/harness status
#   → 实际执行: node $HARNESS/harness-workflow.js status

# 关闭 Harness 模式
/harness end
#   → 实际执行: node $HARNESS/harness-workflow.js end
```

---

## 初始化两步：start 之后必须写 story-input.json

`start` 只建状态文件，**不携带用户的原始输入**。原始输入走 `story-input.json`
这个单独通道 —— 与 `/harness fixbugs` 用的是同一份 schema、同一批消费者。

### Step 1A：启动工作流

```bash
node $HARNESS/harness-workflow.js start <storyId> "<标题>"
```

### Step 1B：写 story-input.json（run 模式同样必须写）

把用户消息里的链接、终端、补充描述**原样**写入，不做解析、不做归纳、不访问外部系统：

```bash
${CLAUDE_PROJECT_DIR}/.codebuddy/plans/<storyId>/story-input.json
```

```json
{
  "mode": "run",
  "storyId": "STORY-001",
  "title": "1v1客服等级分配模式",
  "createdAt": "2026-08-08T10:00:00.000Z",
  "sources": {
    "prototypeUrls": ["https://proto.example.com/xxx"],
    "figmaUrls": ["https://www.figma.com/design/AbC123/订单中心?node-id=12-345"],
    "terminal": "H5",
    "text": "用户消息中除上述链接外的补充描述"
  }
}
```

字段规则（`sources` 下全部选填，按用户实际给了什么写什么）：

| 字段 | 来源 | 写入后的效果 |
|------|------|------------|
| `mode` | 固定 `"run"` | 决定 Phase 0/2 注入哪套指引 |
| `sources.prototypeUrls` | 用户消息中的原型链接 | 非空 → `prototypeRequired = true`，Phase 0 需产出 `prototype-analysis.md` |
| `sources.figmaUrls` | 用户消息中的 Figma 链接 | 非空 → **自动开启 Figma 硬门控**（详见下节） |
| `sources.terminal` | 用户提到的 H5 / PC / 小程序 | 进 Phase 0 prompt，影响检索策略 |
| `sources.text` | 剩余自由描述 | 进 Phase 0 prompt |

> Schema: `scripts/schemas/story-input.schema.json`（`additionalProperties: false`，多写字段会校验失败）。
> 从 URL 提正则、拆参数是**搬运**，不是分析 —— 允许做。判断需求影响哪些文件、该怎么改，是分析 —— 归 Phase 0 需求分析师。

### Step 1C：回填判定（Step 1B 之后必须执行一次）

`start` 先执行、`story-input.json` 后写入，所以建流程那一刻两项判定拿不到输入：
`prototypeRequired` 走保守分支（恒为 `true`）、`hasFigmaDesign` 恒为 `false`。写完输入后执行：

```bash
node $HARNESS/create-workflow.js <storyId> --refresh-input
```

只回填 `hasFigmaDesign` 与 `gateChecks.prototypeRequired`，**不碰 `phase` / `status`** ——
相位跃迁仍归 `advance-phase.js` 独有。输出会打印两项判定的最终值与依据。

> 漏执行的后果：无原型的纯文字需求会被卡在「必须产出 `prototype-analysis.md`」，
> 有 Figma 的需求则完全不会触发设计稿门控。

---

## Figma 设计稿的两条通道

给了 `figmaUrls` 后，系统分两条独立通道处理，**互不替代**：

| 通道 | 开关 | run | fixbugs | 作用 |
|------|------|-----|---------|------|
| **解析指引**（软） | 只看 `figmaUrls` 非空 | ✅ 注入 | ✅ 注入 | Phase 1 prompt 里显式点名 `use_skill("figma-to-component-map")`，要求任务规划师拆 task 时产出 frame-inventory，禁止凭链接猜 UI 结构 |
| **硬门控**（阻断） | `state.hasFigmaDesign` | ✅ 开启 | ❌ 关闭 | Phase 1→2 校验 `figma-frame-inventory.json` 完整性 + task 的 `figmaNodeId`/`figmaRefs` 必须命中清单内的 frame |

门控分级（`services/policy.js` 实现，`advance-phase.js` 调用）：

| 检查 | 级别 |
|------|------|
| `figma-frame-inventory.json` 缺失/不完整（Phase 1 产出） | BLOCKER |
| task 的 `figmaNodeId`/`figmaRefs` 不在 frame 清单中 | BLOCKER |
| 含 `.vue` 的 task 完全没写 `figmaNodeId`/`figmaRefs` | WARNING（可能是纯逻辑改动，不阻断） |

Figma 处理在 Phase 1（任务规划）：需求分析师只做需求分析不拉设计稿，任务规划师拆 task 时才处理
（只针对要拆的组件精确拉取，并绑定 figmaRefs）——真正"按需拉稿"，避免需求阶段猜测性全量拉取。

为什么 fixbugs 不开硬门控：Bug 修复只碰个别页面，要求 frame 清单会直接把修复流程卡死；
但"有设计稿就该去解析"两种模式都成立，所以解析指引不分模式注入（Phase 1）。

```bash
# 任何模式强制开启硬门控（覆盖自动推导）
node $HARNESS/create-workflow.js <storyId> --refresh-input --figma
```

前置条件：Figma 桌面端需处于运行状态并已打开该文件。未运行时子 Agent 应如实告知并停止，
不得退回缓存数据 —— 这条已写进 Phase 1 任务规划师的 `agentPrompt`。

---

## 铁律 (MUST NOT)

| 禁止行为 | 原因 | 正确做法 |
|---------|------|---------|
| 🚫 AI 直接写/改 `e2e-state.json` | 状态机唯一信源，必须由脚本维护 | 始终用 `advance-phase.js` 推进 Phase |
| 🚫 AI 直接写/改 `dev-pass.json` | 通行证由脚本签发/撤销 | 脚本在 Phase 1→2 自动签发，Phase 2→3 自动撤销 |
| 🚫 AI 自行将 `open-questions.json` 中 `resolved` 设为 `true` | 待确认项必须由用户确认 | 提示用户在 open-questions.json 中手动标记 |
| 🚫 AI 跳过 Phase 直接进入开发 | 门控校验依赖前置产出物 | 逐 Phase 推进，确保每个 Phase 产出物完整 |
| 🚫 AI 在 Phase≠2 时编辑 `src/` | Hook 守卫会直接拒绝 | 先确认当前 Phase=2 且有有效 dev-pass |
| 🚫 AI 在归档后执行 `--rollback` / `--fix-loop` | 归档守卫拦截 | 先执行 `restore` 复档 |

---

## dev-pass 生命周期（AI 无需手动管理）

dev-pass 完全由 `advance-phase.js` 自动管理，AI 无需关心签发/撤销时机：

```
Phase 1→2: 脚本自动签发（限域到 task-dag.json 的 files[]）
Phase 2→3: 脚本自动撤销（主撤销点）
Phase 4→5: 脚本自动兜底撤销（防止 fix-loop 残留，幂等操作）
```

AI 只需要在 Phase 2 时 Spawn 前端开发工程师 `frontend-developer`，脚本会确保 dev-pass 在正确的时间存在/消失。

| 操作 | 命令 | 场景 |
|------|------|------|
| 手动续签 | `node $HARNESS/advance-phase.js <storyId> 2 --renew-pass` | 开发超过 2h，dev-pass 过期 |
| fix-loop 重新签发 | 自动（`--fix-loop` 内部处理） | 审查/测试失败回退开发 |

---

## 附录 A：8 Phase 流水线详情（参考）

| P | 名称 | Agent | 产出物 | 门控要点 |
|---|------|-------|--------|---------|
| 0 | 需求分析 | 需求分析师 | `requirement-analysis.md` `acceptance-criteria.json` `open-questions.json` | AC criteria 非空；open-questions 全 resolved。Agent 内部需调用 `use_skill("kb-query")` 检索项目知识库 |
| 1 | 任务规划 | 任务规划师 | `task-dag.md` `task-dag.json` | AC↔Task 交叉引用完整；推进时自动签发 dev-pass |
| 2 | 代码开发 | 前端开发工程师 | 代码变更 | **变更文件增量 ESLint 0 error + 本地编译通过**（均为 BLOCKER）；推进时撤销 dev-pass |
| 3 | 代码审查 | 代码审查师 | `code-review.json` | 无未修复 BLOCKER（`issues[].status === "open"` 且 `severity === "BLOCKER"`） |
| 4 | 功能测试 | 测试工程师 | `test-report.md` `acceptance-verification.json` | failed=0；ui 型 AC 不得凭 static 证据判 passed；审查未修项与 AC 结论不得矛盾；推进时兜底撤销 dev-pass |
| 5 | Git 提交 | 发布助手 | commit + push + MR | 禁止 --no-verify |
| 6 | 知识库更新 | 发布助手 | meta.yaml 刷新 | `use_skill("kb-update")` 调用成功（保留手工批注） |
| 7 | 云端部署 | 发布助手 | 部署 URL + 构建号 | devops 构建+发布成功 |

> 有 Figma 时 Phase 1（任务规划）额外产出 `figma-frame-inventory.json`（唯一 Figma 产出物，frame 可含可选 `designSpec`），需求分析阶段不处理设计稿
> 每个 Phase 完成后 `advance-phase.js` 自动生成 `phase-N-summary.md`

### Phase 2→3 的 lint / 编译门控

Phase 2 此前没有任何专项检查，`ESLint 0 error` 只是一句口头约定 —— 结果 SCSS 编译错误
一路逃到 Phase 7 云端构建才暴露。现在 `checkPhase2Gate` 会真跑：

- **增量 lint**：只 lint `git status --porcelain` 列出的变更文件（`.js/.jsx/.ts/.tsx/.vue`），
  用 `npx eslint --format compact`。只 lint 变更是为了不让仓库存量 lint 债永久卡住门控；
  用 `npx` 而非 `npm run lint` 是为了保证门控绝不会 `--fix` 改动代码。
- **编译校验**：按 `build:dev` → `build:test` → `build` 顺序取第一个存在的 script 执行。
  编译无法增量，但存量代码本应可编译，失败即可归因于本次变更。

降级为 warning 而非阻断的情况：仓库路径不存在、无未提交变更、找不到 eslint、无 build script。

```bash
# 跳过编译校验（会在门控结果里留 warning 痕迹）
HARNESS_SKIP_BUILD=1 node $HARNESS/advance-phase.js <storyId> 3
```

> 权衡：若项目只有生产构建 script（如 `vue-cli-service build --mode production`），
> 每次 Phase 2→3（含每轮 fix-loop）都会触发一次全量构建。构建慢的项目建议在
> `package.json` 补一个更快的 `build:dev`，门控会自动优先选它。

## 附录 B：契约文件格式（参考）

**acceptance-criteria.json** (Phase 0，需求分析师产出):
```json
{ "criteria": [{ "id": "AC-1", "description": "...", "testType": "ui|api|integration" }] }
```

**task-dag.json** (Phase 1，任务规划师产出):
```json
{
  "tasks": [{
    "id": "task-1",
    "title": "...",                              // MUST: title 而非 name
    "files": ["src/store/config.js"],             // 用于 dev-pass 限域 + 影响范围
    "acceptanceCriteria": ["AC-1"],               // MUST: 非空，关联验收标准
    "figmaLink": ["https://www.figma.com/..."],   // UI 任务必填，非 UI 任务为 null
    "figmaRefs": [{ "nodeId": "3020:83533", "link": "https://www.figma.com/..." }], // 可选，UI 任务精确绑定要拉取的 node + 完整链接
    "parallelizable": true,
    "project": "userlive",                        // 可选，跨项目时必填
    "repoPath": "D:/workfile/userlive"            // 可选，跨项目时必填（绝对路径）
  }]
}
```

**code-review.json** (Phase 3，代码审查师产出 — 唯一产出物，已废弃 code-review.md):
```json
{
  "storyId": "STORY-001",              // MUST
  "issues": [{
    "id": "B1",                        // MUST: 匹配 ^(B|W|S)\d+$
    "severity": "BLOCKER|WARNING|SUGGESTION",
    "status": "open|fixed|skipped",    // MUST: 门控唯一信源，BLOCKER+open 阻断推进
    "file": "src/views/xxx.vue",       // MUST: 问题出现位置
    "line": 42,
    "title": "...",                    // MUST
    "description": "...",              // MUST
    "suggestion": "...",
    "impact": "...",                   // 可选：影响范围/影响到的 AC-N（供 Phase 4 交叉对账）
    "reason": "...",                   // 可选：根因分析
    "project": "userlive",             // 可选：跨仓时声明问题所属仓库
    "repoPath": "D:/workfile/userlive" // 可选：跨仓时声明修复点仓库路径
  }],
  "summary": { "blockerCount": 0, "warningCount": 0, "suggestionCount": 0 }  // MUST
}
```

> 顶层 schema 为 `additionalProperties: false`（storyId/issues/summary 之外的顶层字段会被门控拒绝）；
> `issues[]` 内为 `additionalProperties: true`，可额外携带 `impact/reason/project/repoPath` 等字段
> （供 Phase 4 交叉对账与 fix-loop 跨仓定位消费）。字段约束以 `scripts/schemas/code-review.schema.json` 为准。

**acceptance-verification.json** (Phase 4，测试工程师产出):
```json
{
  "results": [{ "id": "AC-1", "status": "passed|failed|unverifiable", "evidenceType": "playwright|manual|api|static", "evidence": ["截图/日志"] }],
  "summary": { "total": 10, "passed": 10, "failed": 0, "unverifiable": 0 }
}
```

### Phase 4→5 的证据强度门控

`evidenceType` 声明证据从哪来。门控按 `acceptance-criteria.json` 的 `testType` 分级：

| 情形 | 判定 | failureType |
|------|------|-------------|
| `testType=ui` + `passed` + `evidenceType=static` | **BLOCKER** | `static_evidence_for_ui_ac` |
| 其余 testType + `passed` + `evidenceType=static` | WARNING（聚合成一条） | — |
| code-review 中 open 的问题自称影响某 AC，而该 AC 判 passed | **BLOCKER** | `review_acceptance_conflict` |

设计取舍：交互型断言（点击/禁用态/弹窗/勾选）读代码读不出来，只能实跑，所以硬阻塞；
集成/接口型 AC 若也一律阻塞，会迫使大批 AC 降级成 `unverifiable` —— 那是把门控变成墙，不是提高质量。
`unverifiable` 不阻塞门控（`checkAcceptanceVerification` 已移除比例阈值，降级为 warning）；
给不出运行时证据时的正确做法是标 `unverifiable` + 写明环境限制，而不是用 `static` 冒充 `passed`。

## 附录 C：Hook 守卫（自动运行，AI 无需干预）

| Hook | 触发时机 | 作用 |
|------|---------|------|
| `enforce-state-file.js` | 每次文件 write/replace | 拦截对 e2e-state.json / dev-pass.json 的写操作 |
| `enforce-dev-pass.js` | 同上 | dev-pass 有效性 + 路径限域 + Phase 校验 |
| `enforce-artifact.js` | 同上 | Phase 0-1 产出物存在性确认 |
| `session-start.js` | 对话启动 | 断点恢复 + 加载 summary + 注入经验 + 契约清单 |

## 附录 D：文件目录结构（参考）

```
<PROJECT_ROOT>/.codebuddy/plans/<storyId>/
├── e2e-state.json          # 工作流状态（phase 唯一信源，脚本维护）
├── repos.json              # 仓库注册表（story 级独立）
├── trace.jsonl             # 全链路审计
├── dev-pass.json           # 开发通行证（仅 Phase 2 存在，脚本自动管理）
├── phase-N-summary.md      # Phase 上下文摘要（脚本自动生成）
├── archive/                # 归档目录
│   ├── round-{N}/          #   终态归档（详见 /harness archive）
│   └── *.archived          #   --rollback / --fix-loop 归档
└── ...                     # 各 Phase 产出物
```

## 附录 E：脚本速查（参考）

> 根路径：`${CLAUDE_PLUGIN_ROOT}/scripts/`

### commands/ — 工作流命令脚本（AI 直接调用）

| 脚本 | 用途 |
|------|------|
| `commands/harness-workflow.js` | 工作流生命周期：`start` 激活 / `end` 关闭 / `status` 查看状态 |
| `commands/create-workflow.js` | 创建 e2e-state.json（被 harness-workflow.js start 内部调用）；`--refresh-input` 在 story-input.json 写入后回填原型/Figma 判定 |
| `commands/advance-phase.js` | Phase 状态机推进 + dev-pass 生命周期 + 门控校验 + 修复回路 |
| `commands/archive-story.js` | Story 归档 / 复档 / 列表 / 状态 |

### services/ — 服务层脚本（被 advance-phase.js 内部调用，AI 不直接调）

| 脚本 | 用途 |
|------|------|
| `services/policy.js` | 风险门控层：产出物校验 + 契约一致性检查 + 结构化 blocker 输出 |
| `services/experience.js` | 经验沉淀飞轮：记录失败模式 + 向 Agent prompt 注入历史教训 |
| `services/context-refresh.js` | 上下文刷新：每个 Phase 完成后生成 phase-N-summary.md |
| `services/validate-contracts.js` | 契约文件校验：检查 AC/task-dag/verification 等契约文件完整性 |
| `services/validate-phase-gate.js` | ⚠️ 已废弃：不在生效路径上，仅作人工诊断。生效门控是 `services/policy.js` |

### lib/ — 基础库（被各脚本引用，AI 不直接调）

| 脚本 | 用途 |
|------|------|
| `lib/state.js` | 状态文件读写：e2e-state.json / dev-pass.json 的 CRUD 操作 |
| `lib/trace.js` | 全链路 trace 记录：写 trace.jsonl 供调试/审计/经验沉淀 |

### hooks/ — Hook 守卫（自动运行，AI 无需干预）

| 脚本 | 用途 |
|------|------|
| `hooks/enforce-dev-pass.js` | PreToolUse Hook：src/ 编辑保护，校验 dev-pass 有效性 + 路径限域 |
| `hooks/enforce-artifact.js` | PreToolUse Hook：防跳 Phase，检查前置产出物是否存在 |
| `hooks/session-start.js` | SessionStart Hook：断点恢复 + 加载 summary + 注入经验教训 |
| `hooks/session-stop.js` | Stop Hook：清理过期 dev-pass + 沉淀 Hook 拒绝事件到经验库 |
| `hooks/trace-command.js` | PostToolUse Hook：命令执行后自动记录 trace.jsonl |

### audit/ — 审计工具（按需手动执行）

| 脚本 | 用途 |
|------|------|
| `audit/harness-audit.js` | 工作流健康审计：检查 settings.json / e2e-state / 产出物完整性 |
| `audit/check-prototype-doc.js` | 原型文档检查：create-workflow 前置校验 prototype-analysis.md 存在性 |
| `audit/metrics-aggregator.js` | 指标聚合：工作流统计数据汇总 |
