---
name: figma-to-component-map
description: >
  Produce a complete Figma frame inventory (figma-frame-inventory.json) with precise full node links
  for the pages/dialogs/drawers/components a task touches, then bind each UI task to precise
  figmaRefs (nodeId+link). Used by the Phase 1 task planner when a Story has Figma design URLs.
---

# Figma Design → Component Map (v3 — 单一产出物 + 精确 Node 绑定)

## Prerequisites

- **Figma desktop app MUST be running** and have the design file open.
- If not running, tell the user and stop. Do NOT fall back to cached data.

### Figma MCP 通用执行策略（从 figma skill 合并而来）

> 本 skill 统一承载「读 Figma 设计稿」的全部策略，替代独立的 `figma` skill。

1. **立即调用**：检测到设计稿意图立即调用 Figma MCP 工具，100% 还原设计稿。
2. **重试机制**：第一次调用失败自动重试，最多重试 2 次（总共尝试 3 次）。
3. **失败处理**：3 次都失败 → **停止当前任务**，如实汇报失败，避免瞎猜乱做。
4. **工具选择**：
   - `get_design_context` — 获取完整设计上下文（首选）
   - `get_variable_defs` — 需要变量定义时
   - `get_screenshot` — 需要截图作为视觉基准
   - `get_metadata` — 遍历页面/帧结构
5. 确保在尝试失败后不要继续执行依赖于设计稿的任务。

## 步骤 A: Produce Frame Inventory (`figma-frame-inventory.json`)

> **按需分析（任务规划阶段）**：本 skill 由 **Phase 1 任务规划师**在拆 task 时调用（需求分析阶段不处理 Figma）。
> 只针对**要拆分的 task 涉及的文件/组件**生成 frame 清单，**不要全量扫描设计稿的所有页面**——
> 拆到哪些组件就拉哪些，避免重复分析浪费 token。
> 设计稿完整内容（布局/样式/文案/交互细节）不在此转译给下游，由开发 Agent 通过 Figma MCP 自行拉取。

### Step 1: List all pages

Call `get_metadata` **without a nodeId** to get the top-level page list:

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{}")
```

This returns GUID + name for every top-level page (e.g. `0:1` / "设置页", `1:2` / "会话页").

### Step 2: Scan pages for frames RELEVANT to the requirement

For each page ID referenced by the requirement-analysis.md, call `get_metadata` to dump the node tree, and focus on frames that correspond to the components/pages the requirement actually touches:

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{"nodeId":"0:1"}")
```

### Step 3: Extract and classify frames

From the XML tree, extract every `<frame>` with these classification rules:

| Type | Criteria |
|------|----------|
| **page** | 1920×1080, contains table headers / filter fields / tab bars |
| **dialog** | 400-800px wide, contains `.标题样式` + `底部操作` |
| **drawer** | 900-1000px wide, contains `抽屉标题栏` |
| **component** | Smaller reusable segment, checkboxes / inputs / buttons cluster |

### Step 4: Construct complete Figma node links

For EVERY extracted frame, build the full URL:

```
https://www.figma.com/design/{fileKey}/{fileName}?node-id={dashNodeId}&m=dev
```

- `{fileKey}` — from the original Figma URL (e.g. `qim2RjyYi833JXyFeIJd88`)
- `{fileName}` — URL-encoded file name from the original URL
- `{dashNodeId}` — node ID with `:` → `-` conversion (e.g. `3020:83533` → `3020-83533`)

### Step 5: Output `figma-frame-inventory.json`（唯一产出物，含可选 designSpec）

**Every frame MUST have a complete `link`.** `designSpec` 可选，若已提取到关键设计规格（尺寸/色值/间距/字体等）则填入，供开发 agent 作辅助参考（不替代 Figma MCP 完整拉取）。Format:

```json
{
  "fileKey": "qim2RjyYi833JXyFeIJd88",
  "fileName": "客服系统",
  "frames": [
    {
      "id": "3020:83533",
      "name": "编辑分组弹窗",
      "type": "dialog",
      "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-83533&m=dev",
      "rect": { "w": 634, "h": 520 },
      "designSpec": "标题栏 56px, 列表项高 55px, 关闭按钮 14×14, 主色 #2A6AF2"
    },
    {
      "id": "3020:78242",
      "name": "会话分配规则-高级设置",
      "type": "page",
      "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-78242&m=dev",
      "rect": { "w": 1920, "h": 1080 }
    }
  ]
}
```

Write to: `.codebuddy/plans/<storyId>/figma-frame-inventory.json`

> **注意**：本 skill 只产出这一个文件。不再产出 `figma-component-map.md`（已废弃）——设计稿完整内容由开发 Agent 通过 Figma MCP 自行拉取，frame-inventory 的 `designSpec` 仅作辅助参考。

---

## 步骤 B: Task → Frame Precise Mapping (via task-dag.json)

> Only run when `task-dag.json` exists and contains `figmaRefs` / `figmaNodeId` fields.
> `figmaRefs` 为**精确配对数组**（每个元素含 nodeId + link），一个 task 处理多个组件时有多个元素；
> `figmaNodeId` 是门控校验用的简化字段（单值 string 或 string 数组）。两者可并存，精确拉取用 figmaRefs。

### Step 1: Read `task-dag.json` figmaRefs references

```json
// task-dag.json
{
  "tasks": [
    {
      "id": "T1",
      "title": "标签面板组件",
      "files": ["src/views/pc/Components/UserTagPanel.vue"],
      "figmaRefs": [
        { "nodeId": "3:456", "link": "https://www.figma.com/design/xxx?node-id=3-456&m=dev" },
        { "nodeId": "3:789", "link": "https://www.figma.com/design/xxx?node-id=3-789&m=dev" }
      ],
      "figmaNodeId": ["3:456", "3:789"],
      "acceptanceCriteria": ["AC-001"]
    }
  ]
}
```

### Step 2: Direct design spec extraction (zero guessing)

For each task with `figmaRefs` / `figmaNodeId`, call `get_design_context` for **EACH node ID** (single value = one node):

```
mcp_call_tool(serverName="Figma", toolName="get_design_context",
  arguments="{"nodeId":"3:456","clientLanguages":"javascript,css,html","clientFrameworks":"vue"}")
```

And take a screenshot:

```
mcp_call_tool(serverName="Figma", toolName="get_screenshot", arguments="{"nodeId":"3:456"}")
```

### Step 3: Output exact node links for each task

For each task, output the exact Figma node link + design specs (供任务规划师写入 task-dag 的 figmaRefs，开发 agent 据此精准拉取):

```
T1 标签面板组件:
  Figma: https://www.figma.com/design/{fileKey}/{fileName}?node-id=3-456&m=dev
  Node: 3:456 (drawer, 360×auto)
  Key specs: header 56px, list items 55px each, checkbox 14×14
```

---

## Fallback: Heuristic Matching (only when figmaNodeId not available)

When `task-dag.json` does NOT have `figmaNodeId` fields, fall back to the old heuristic approach:

1. Read `task-dag.json` task titles → extract component names
2. Match against frame names from the inventory:
   - "分配规则" → frames containing "分配"
   - "分组" → frames containing "分组"
   - "标签" → frames containing "标签"
3. UI pattern matching: dialog with shuttle → AgentGroupDialog; steps form → CreateDialog
4. Output the matched links, but **mark as "⚠️ heuristic match"** for human review

---

## Output Template

### When figmaNodeId available (precise):

```markdown
## Figma → Component Mapping (Precise, N tasks)

| 组件文件 | Task ID | Figma Node ID | 完整 Figma 链接 | 设计规格 |
|---------|---------|--------------|----------------|---------|
| `UserTagPanel.vue` | T1 | `3:456` | [链接](https://...) | drawer 360×auto |
| `AssignRule.vue` | T4 | `3020:78242` | [链接](https://...) | page 1920×1080 |

## Design Specs (per component)

### UserTagPanel.vue → T1
- **Node**: `3:456`
- **Link**: https://www.figma.com/design/...?node-id=3-456&m=dev
- **Size**: 360px × auto
- **Key**: 标签列表, 彩色圆角, 关闭按钮 14×14
```

### When heuristic (mark as fallback):

```markdown
## Figma → Component Mapping (Heuristic, N tasks)

| 组件文件 | Figma Node ID | 完整 Figma 链接 | 匹配方式 |
|---------|--------------|----------------|---------| 
| `AssignRule.vue` | `3020:78242` | [链接](https://...) | ⚠️ heuristics (名称+UI) |
```

## Important Notes

- **Every link must be a complete URL** with `?node-id=...&m=dev` — never just the node ID.
- `node-id` in URLs uses `-` separator (e.g. `3020-83533`). API calls use `:` (e.g. `3020:83533`).
- 产出物唯一：只产出 `figma-frame-inventory.json`（frame 可含可选 `designSpec`）。`figma-component-map.md` 已废弃。
- 任务规划师在 task-dag 中应为每个 UI task 写 `figmaRefs: [{nodeId, link}]`（精确配对），开发 agent 据此一次精准拉取，不做全量探索。
- If a task in `task-dag.json` has `figmaRefs`/`figmaNodeId`, skip heuristics entirely — go straight to direct extraction.
- For pages (>10 child frames), prefer `get_metadata` over `get_design_context` to avoid truncation.
- `.`-prefixed instances (e.g. `.标题样式`) are Figma library components — treat their parent frame dimensions as the spec.
