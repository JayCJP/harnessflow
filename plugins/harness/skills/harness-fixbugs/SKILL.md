---
name: harness-fixbugs
description: Harness Bug 修复流水线 — 以 fixbugs 模式启动标准 8 Phase 流程，Bug 分析由需求分析师在 Phase 0 内完成
---

# /harness fixbugs — Bug 修复端到端流水线

> 与 `/harness run` 走**同一条** 8 Phase 流水线，唯一区别是 `mode=fixbugs`：
> 免除原型文档要求，且 Phase 0 的需求分析师会自行拉取并分析 TAPD 缺陷。
>
> **主 Agent 不分析 Bug。** 你只负责把用户给的参数搬进 `story-input.json`，然后进入标准 dispatch 循环。

## 用法

```bash
/harness fixbugs <storyId> "<标题>" <TAPD链接> [处理人: XXX] [状态筛选: 待解决]
```

**示例**：
```
/harness fixbugs STORY-001 "管家反馈需求合集" https://www.tapd.cn/tapd_fe/10109441/story/detail/xxx 处理人: 小明 状态筛选: 待解决
```

## AI 执行协议

你是 Harness 工作流的主控 Agent。职责是 **搬运参数 + 执行脚本推进 Phase**，不做任何 Bug 分析。

### 必须加载的 Skill

```
use_skill("harness-conductor")
```

### 脚本路径约定

```bash
HARNESS=${CLAUDE_PLUGIN_ROOT}/scripts/commands
STORY_DIR=${CLAUDE_PROJECT_DIR}/.codebuddy/plans/<storyId>
```

## 执行流程（2 阶段）

```
┌─────────────────────────────────────────────────────────┐
│  阶段 1：初始化（主 Agent，只搬参数不分析）                 │
│  ├── 1A. harness-workflow.js start ... --mode=fixbugs   │
│  └── 1B. 写 story-input.json（TAPD 链接 / 处理人 / 筛选） │
│                                                         │
│  阶段 2：标准 dispatch 循环（Phase 0→8）                   │
│  └── Phase 0 需求分析师内部:                              │
│        use_skill("tapd-bug-analyzer") → Bug 分析报告      │
│        → requirement-analysis.md + AC + open-questions   │
└─────────────────────────────────────────────────────────┘
```

---

## 阶段 1：初始化

### Step 1A：以 fixbugs 模式启动

```bash
node $HARNESS/harness-workflow.js start <storyId> "<标题>" --mode=fixbugs
```

`--mode=fixbugs` 的作用：

- `e2e-state.json` 记录 `mode: "fixbugs"`
- `gateChecks.prototypeRequired = false` → **不再生成空的 `prototype-analysis.md`**，Phase 0→1 门控也不检查它
- `prompt-builder.js` 会给 Phase 0 注入 Bug 分析指引、给 Phase 2 注入「修复方案自行设计」说明

确认返回 `e2e-state.json: ✅ 已创建`，Phase = 0。

### Step 1B：写 story-input.json

把用户消息里的参数**原样**写入，不做解析、不做归纳、不访问 TAPD：

```bash
${STORY_DIR}/story-input.json
```

```json
{
  "mode": "fixbugs",
  "storyId": "STORY-001",
  "title": "管家反馈需求合集",
  "createdAt": "2026-08-04T10:00:00.000Z",
  "sources": {
    "tapdUrl": "https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944xxxx",
    "workspaceId": "10109441",
    "storyIdInTapd": "1010944xxxx",
    "owner": "小明",
    "statusFilter": "待解决",
    "terminal": "H5",
    "text": "用户消息中除上述参数外的补充描述"
  }
}
```

字段规则：

| 字段 | 必填 | 来源 |
|------|------|------|
| `mode` | ✅ | 固定 `"fixbugs"` |
| `sources.tapdUrl` | ✅ | 用户消息中的 TAPD 链接，原样复制 |
| `sources.workspaceId` | ✅ | 从链接 `tapd_fe/(\d+)/` 提取 |
| `sources.storyIdInTapd` | 选填 | 从链接 `/story/detail/(\d+)` 提取 |
| `sources.owner` | ✅ | "处理人: XXX" |
| `sources.statusFilter` | 选填 | "状态筛选: XXX"，缺省不写 |
| `sources.terminal` | 选填 | 用户提到的 H5 / PC / 小程序 |
| `sources.figmaUrls` | 选填 | 用户消息中的 Figma 链接，原样复制 |
| `sources.text` | 选填 | 剩余自由描述 |

> Schema: `scripts/schemas/story-input.schema.json`（`additionalProperties: false`，多写字段会校验失败）。
> 从 URL 提正则、拆参数是**搬运**，不是分析 —— 允许做。判断哪些 Bug 归前端、代码在哪个文件，是分析 —— 不允许做。

> **给了 `figmaUrls` 时**：Phase 0 的 `agentPrompt` 会自动注入 `use_skill("figma-to-component-map")` 解析指引，
> 但 fixbugs **不开 Figma 硬门控** —— Bug 修复只碰个别页面，要求全量 frame 清单会把修复流程卡死。
> 确需强制门控时执行 `node $HARNESS/create-workflow.js <storyId> --refresh-input --figma`。

### Step 1C：回填判定

Step 1A 先执行、`story-input.json` 后写入，建流程那一刻 `hasFigmaDesign` 拿不到输入而恒为 `false`。
写完输入后执行一次回填（fixbugs 的 `prototypeRequired` 恒为 false，本步主要影响 Figma 判定）：

```bash
node $HARNESS/create-workflow.js <storyId> --refresh-input
```

只回填 `hasFigmaDesign` 与 `gateChecks.prototypeRequired`，**不碰 `phase` / `status`**。

---

## 阶段 2：标准 dispatch 循环

此后与 `/harness run` **完全一致**（详见 run.md）：

```
Step 1: node $HARNESS/dispatch.js <storyId>
Step 2: 按 status 四态分支
  ┌ ready     → readyToAdvance=true 则执行 advanceCommand，否则 Spawn nextAgent（prompt = agentPrompt 原样注入）
  ├ fix_loop  → 执行 recovery.command
  ├ blocked   → 按 recovery.description 处理
  └ terminal  → 收尾
Step 3: 子 Agent 汇报产出物路径 → 回 Step 1
```

主 Agent **不拼 prompt**。`agentPrompt` 由 `prompt-builder.js` 统一生成，fixbugs 模式下它已经包含：

| Phase | 自动注入的内容 |
|-------|--------------|
| 0 | `story-input.json` 原文 + 「自行 `use_skill("tapd-bug-analyzer")`、报告只记事实不写修复方案」指引 |
| 0 | 产出物清单里追加 `{标题}_bug分析报告.md` |
| 1→8 | Story 目录下的 `*bug分析报告.md` 全文（由 `readStoryContext()` 自动发现并注入） |
| 2 | 「Bug 修复说明」：报告只给事实，**修复怎么改由开发工程师用 `kb-query ∥ graphify` 双源验证后自行设计** |

### Phase 0 门控

`validate-phase-gate.js` 在 fixbugs 模式下额外检查：

- **阻断项**：Story 目录必须存在 `*bug分析报告.md`，否则 Phase 0→1 被拦截
- **警告项**：报告标题行出现 `修复建议` / `解决方案` / `测试验证` 等 → 输出警告（越界但不阻断）

---

## 与 /harness run 的区别

| 维度 | `/harness run` | `/harness fixbugs` |
|------|---------------|-------------------|
| 启动参数 | `start <id> "<标题>"` | `start <id> "<标题>" --mode=fixbugs` |
| 主 Agent 前置动作 | 写 `story-input.json` + `--refresh-input` 回填 | 同左（仅搬参数，不分析） |
| 原型文档 | 提供了原型/Figma 链接则必需 | 免除 |
| Figma 解析指引 | 有 `figmaUrls` 就注入 | 同左 |
| Figma 硬门控 | 有 `figmaUrls` 则开启 | 关闭（`--figma` 可强制开） |
| Phase 0 产出物 | requirement-analysis / AC / open-questions | 同左 **+ `{标题}_bug分析报告.md`** |
| Bug 分析执行方 | — | **Phase 0 需求分析师**（非主 Agent） |
| Phase 1→8 | 标准流水线 | 完全相同 |

## 铁律

| 禁止行为 | 原因 |
|---------|------|
| 🚫 主 Agent 加载 `tapd-bug-analyzer` | 分析必须发生在需求分析师上下文内。主 Agent 分析会导致：① 中间推理（候选文件排除过程、双源命中情况）在跨 Agent 传递中丢失；② 主 Agent 上下文被 TAPD 原始数据 + 源码撑满，后续 8 个 Phase 的调度全程带着这些无关内容 |
| 🚫 主 Agent 调用任何 TAPD MCP 工具 | 同上 |
| 🚫 主 Agent 自行拼 Phase 0 prompt | `agentPrompt` 是唯一出口，自行拼装会导致注入内容逐轮不一致 |
| 🚫 AI 直接写 e2e-state.json / dev-pass.json | 状态机唯一信源，只能由脚本维护 |
| 🚫 AI 跳过 Phase 直接开发 | 门控依赖前置产出物 |
| 🚫 AI 自行标记 open-questions 为 resolved | 待确认项必须由用户确认 |

| 必做 | 说明 |
|------|------|
| ✅ `--mode=fixbugs` 必须带上 | 漏掉会退回 run 模式，重新要求原型文档且不做 Bug 报告门控 |
| ✅ `story-input.json` 必须在 Phase 0 dispatch 前写好 | 需求分析师靠它拿 TAPD 参数；缺失则 prompt 里没有 sources，分析师只能回退到用户描述 |
| ✅ 写完 `story-input.json` 执行一次 `--refresh-input` | 建流程早于写输入，不回填则 `hasFigmaDesign` 恒为 false，Figma 解析指引虽在但门控状态与实际输入不符 |
