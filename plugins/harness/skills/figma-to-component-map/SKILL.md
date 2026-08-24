---
name: figma-to-component-map
description: >
  Phase 0: produce a complete Figma frame inventory (figma-frame-inventory.json) with precise full
  node links for every page, dialog, drawer, and component. Phase 1: use task-dag.json figmaNodeId
  references for zero-guess design spec extraction. Should be used when the user provides a Figma URL.
---

# Figma Design → Component Map (v2 — Precise Links)

## Prerequisites

- **Figma desktop app MUST be running** and have the design file open.
- If not running, tell the user and stop. Do NOT fall back to cached data.

## Phase 0: Produce Frame Inventory (`figma-frame-inventory.json`)

> **按需分析（v2）**：本 skill 应在需求分析文档（`requirement-analysis.md`）产出之后调用。
> 根据需求分析文档**只针对涉及的组件**生成 frame 清单，**不要全量扫描设计稿的所有页面**——
> 需求不涉及的组件不必进清单，避免重复分析浪费 token。
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

### Step 5: Output `figma-frame-inventory.json`

**Every frame MUST have a complete `link`.** Format:

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
      "rect": { "w": 634, "h": 520 }
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

---

## Phase 1: Task → Frame Precise Mapping (via task-dag.json)

> Only run when `task-dag.json` exists and contains `figmaNodeId` fields.
> `figmaNodeId` 可为**单值 string** 或 **string 数组**（一个 task 处理多个组件时用数组）。逐个 node 拉取设计上下文。

### Step 1: Read `task-dag.json` figmaNodeId references

```json
// task-dag.json
{
  "tasks": [
    {
      "id": "T1",
      "title": "标签面板组件",
      "files": ["src/views/pc/Components/UserTagPanel.vue"],
      "figmaNodeId": ["3:456", "3:789"],
      "acceptanceCriteria": ["AC-001"]
    }
  ]
}
```

### Step 2: Direct design spec extraction (zero guessing)

For each task with `figmaNodeId`, call `get_design_context` for **EACH node ID** in the array (single value = one node):

```
mcp_call_tool(serverName="Figma", toolName="get_design_context",
  arguments="{"nodeId":"3:456","clientLanguages":"javascript,css,html","clientFrameworks":"vue"}")
```

And take a screenshot:

```
mcp_call_tool(serverName="Figma", toolName="get_screenshot", arguments="{"nodeId":"3:456"}")
```

### Step 3: Generate precise links for task prompt injection

For each task, output the exact Figma node link + design specs:

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
- If a task in `task-dag.json` has `figmaNodeId`, skip heuristics entirely — go straight to direct extraction.
- For pages (>10 child frames), prefer `get_metadata` over `get_design_context` to avoid truncation.
- `.`-prefixed instances (e.g. `.标题样式`) are Figma library components — treat their parent frame dimensions as the spec.
