---
name: figma-to-component-map
description: >
  生成完整的 Figma 画板清单（figma-frame-inventory.json），按「一个 Vue 组件 ↔ 一个 Figma node」
  的粒度精确绑定。任务规划师从 task 拆出涉及的 Vue 组件，在 Figma 中找到对应 node；
  找不到对应 node 的 Vue 组件标记为「无对应设计稿」，不硬凑、不兜底钻取。
  当 Story 含有 Figma 设计稿链接时，由 Phase 1 任务规划师调用本 skill。
---

# Figma 设计稿 → 组件映射

## 前置条件

- **必须已启动 Figma 桌面客户端**并打开了对应的设计文件。
- 若未运行，需告知用户并停止执行。**禁止**回退使用缓存数据。

### Figma MCP 通用执行策略（从 figma skill 合并而来）

> 本 skill 统一承载「读 Figma 设计稿」的全部策略，替代独立的 `figma` skill。

1. **立即调用**：检测到设计稿意图立即调用 Figma MCP 工具，100% 还原设计稿。
2. **重试机制**：第一次调用失败自动重试，最多重试 2 次（总共尝试 3 次）。
3. **失败处理**：3 次都失败 → **停止当前任务**，如实汇报失败，避免瞎猜乱做。
4. **工具选择**：
   - `get_design_context` — 获取完整设计上下文（首选，开发工程师 Phase 2 用）
   - `get_variable_defs` — 需要变量定义时
   - `get_screenshot` — 需要截图作为视觉基准
   - `get_metadata` — 遍历页面/帧结构（任务规划师专用）
5. 确保在尝试失败后不要继续执行依赖于设计稿的任务。

## 绑定粒度原则（核心，必读）

> **一个 Vue 组件 ↔ 一个 Figma node**。粒度是 Vue 组件文件级，不是组件内部的输入框/按钮/表格列。

| ✅ 正确粒度 | ❌ 错误粒度（过细） |
|-----------|-------------------|
| `AgentGroupDialog.vue` ↔ Figma「编辑分组弹窗」node | 把弹窗里的「分组名称输入框」「成员穿梭框」「保存按钮」各自单独绑定 |
| `AssignRuleTable.vue` ↔ Figma「分配规则表格」node | 把表格里的「每列表头」「操作列按钮」拆出来单独绑定 |

**找不到对应 node 的 Vue 组件 → 标记「无对应设计稿」，不硬凑、不递归钻取兜底。** 开发工程师对该组件自行实现，不依赖设计稿。

## 步骤 A（任务规划师专用）：生成画板清单 + Vue 组件级绑定

> **按需分析（任务规划阶段）**：本步骤由 **Phase 1 任务规划师**在拆 task 时执行（需求分析阶段不处理 Figma）。
> 只针对**要拆分的 task 涉及的 Vue 组件**生成清单，拆到哪些组件就拉哪些，避免重复分析浪费 token。
> **本步骤只用 `get_metadata`（轻量结构扫描）**，**禁止调用 `get_design_context` / `get_screenshot`**——那是开发工程师 Phase 2 的职责。

### 总体流程

```
任务 Vue 组件拆解  →  Figma frame 扫描  →  一对一匹配  →  构造链接 + 产出
   (第 0 步)          (第 1-2 步)        (第 3 步)      (第 4-5 步)
```

### 第 0 步：任务 Vue 组件拆解

> 在扫描 Figma 之前，先在 task 侧把"这个 task 涉及哪些 Vue 组件"拆到文件级。

对每个 UI task，任务规划师需产出 `vueComponents`（Vue 组件清单），描述该 task 实际触达的 Vue 组件文件：

**正例（组件级，达标）**：
```
task: "编辑分组弹窗-表单字段校验增强"
vueComponents:
  - { file: "AgentGroupDialog.vue", name: "编辑分组弹窗" }
  - { file: "AssignRuleTable.vue", name: "分配规则表格" }
```

**反例（过细或过泛，不可接受）**：
```
# 过细：拆到组件内部控件
vueComponents:
  - { file: "AgentGroupDialog.vue", name: "分组名称输入框" }   ← 控件不是 Vue 组件
  - { file: "AgentGroupDialog.vue", name: "保存按钮" }          ← 控件不是 Vue 组件

# 过泛：只到页面
vueComponents:
  - { file: "设置页.vue", name: "设置页" }   ← 太泛，应拆到页面内被改的子组件
```

**拆解规则**：
1. 从 task 标题 + 描述 + 待改文件路径，反推实际触达的 Vue 组件文件（`.vue`）。
2. 粒度锁定在 Vue 组件文件级：一个 `.vue` 文件 = 一个条目。组件内部的输入框/按钮/表格列不算独立条目。
3. 一个 task 可涉及多个 Vue 组件（改多处时全部列出）。
4. 若 task 是新增 Vue 组件，`vueComponents` 写"新增 XXX.vue"，匹配时定位同页面内同类参照组件的 node 作为布局参考；若同类参照也找不到，标「无对应设计稿」。

> `vueComponents` 是匹配的"目标指令"。粒度对不对直接决定绑定质量。

### 第 1 步：列出所有页面

调用 `get_metadata`，**不传 nodeId**，获取顶层页面列表：

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{}")
```

该调用会返回每个顶层页面的 GUID 与名称（例如 `0:1` / "设置页"，`1:2` / "会话页"）。

### 第 2 步：扫描页面 frame 树

对包含 task 目标 Vue 组件的页面，调用 `get_metadata` 导出节点树，获取该页面下所有 frame/component 实例：

```
mcp_call_tool(serverName="Figma", toolName="get_metadata", arguments="{"nodeId":"0:1"}")
```

frame 分类规则（供识别用）：

| 类型 | 判定条件 |
|------|----------|
| **page（页面）** | 1920×1080，含表头/筛选字段/标签栏 |
| **dialog（弹窗）** | 宽 400-800px，含 `.标题样式` + `底部操作` |
| **drawer（抽屉）** | 宽 900-1000px，含 `抽屉标题栏` |
| **component（组件）** | 较小的可复用片段，含复选框/输入框/按钮集群 |

> 扫描只到 frame/component 实例级，**不递归钻取到控件叶子**。一个 frame 就是一个候选 node。

### 第 3 步：Vue 组件 ↔ Figma node 一对一匹配

> 对 `vueComponents` 中的每个 Vue 组件，在 Figma frame 树中找**一个**对应的 node。

#### 匹配规则（按优先级从高到低）

1. **名称精确对应**：Vue 组件的语义名（如"编辑分组弹窗"）与某 frame 的 name 完全一致或包含。
2. **语义对应**：Vue 组件名（如 `AgentGroupDialog`）与 frame name 语义对应（Agent=分组、Dialog=弹窗、Rule=规则、Table=表格）。
3. **控件类型对应**：Vue 组件类型词（Dialog/Table/Form/Tabs/Transfer/Select）与 frame name 含同类控件语义匹配。

#### 匹配结果（三种情况）

| 情况 | 处理 |
|------|------|
| ✅ 找到唯一对应 node | 绑定该 nodeId，`matchConfidence` 按规则置信度标 `high`/`medium` |
| ⚠️ 找到多个候选 | 取语义最接近的一个，`matchConfidence` 标 `medium`，`path` 注明其他候选供复核 |
| ❌ 找不到对应 node | **不硬凑、不钻取兜底**，标 `matched: false` + `reason: "无对应设计稿"` |

> **关键约束：找不到就不匹配。** 不要为了凑满清单而递归钻取到子控件、不要用启发式硬猜。开发工程师对「无对应设计稿」的组件自行实现。

#### 匹配示例

```
vueComponents:
  - AgentGroupDialog.vue  / 编辑分组弹窗    → Figma「编辑分组弹窗」node 3020:83533 ✅ high
  - AssignRuleTable.vue   / 分配规则表格    → Figma「分配规则-表格」node 3020:78250 ✅ high
  - GroupNameInput.vue    / 分组名称输入框  → Figma 无对应 frame        ❌ 无对应设计稿（不钻取）
  - SaveButton.vue        / 保存按钮        → Figma 无对应 frame        ❌ 无对应设计稿（不钻取）
```

`GroupNameInput.vue` / `SaveButton.vue` 是组件内部子控件，Figma 没有为它们单独建 frame，**不匹配**。开发工程师实现 `AgentGroupDialog.vue` 时通过该弹窗 node 的 `get_design_context` 自行还原内部控件。

### 第 4 步：构造 node 完整链接

为**每个匹配到的 node** 构造完整 URL：

```
https://www.figma.com/design/{fileKey}/{fileName}?node-id={dashNodeId}&m=dev
```

- `{fileKey}` — 取自原始 Figma URL（例如 `qim2RjyYi833JXyFeIJd88`）
- `{fileName}` — 对原始 URL 中的文件名做 URL 编码
- `{dashNodeId}` — 将节点 ID 中的 `:` 替换为 `-`（例如 `3020:83533` → `3020-83533`）

### 第 5 步：输出 `figma-frame-inventory.json`（唯一产出物）

**每个匹配到的 node 必须有完整 `link`。** `designSpec` **不填**——因为本步骤只用 `get_metadata`，拿不到色值/间距/字体（那是 `get_design_context` 的职责，由开发工程师 Phase 2 拉取）。

产出物分两部分：
1. `frames`：Figma frame 全景清单（含 `id`/`name`/`type`/`link`/`rect`）
2. `tasks`：每个 UI task 的 Vue 组件级绑定（含 `taskId`/`vueComponents`/`figmaRefs`）

格式如下：

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
      "id": "3020:78250",
      "name": "分配规则-表格",
      "type": "component",
      "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-78250&m=dev",
      "rect": { "w": 1200, "h": 400 }
    }
  ],
  "tasks": [
    {
      "taskId": "T1",
      "taskTitle": "编辑分组弹窗-表单字段校验增强",
      "vueComponents": [
        { "file": "AgentGroupDialog.vue", "name": "编辑分组弹窗" },
        { "file": "AssignRuleTable.vue", "name": "分配规则表格" },
        { "file": "GroupNameInput.vue", "name": "分组名称输入框" },
        { "file": "SaveButton.vue", "name": "保存按钮" }
      ],
      "figmaRefs": [
        {
          "vueFile": "AgentGroupDialog.vue",
          "nodeId": "3020:83533",
          "name": "编辑分组弹窗",
          "type": "dialog",
          "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-83533&m=dev",
          "matchConfidence": "high"
        },
        {
          "vueFile": "AssignRuleTable.vue",
          "nodeId": "3020:78250",
          "name": "分配规则-表格",
          "type": "component",
          "link": "https://www.figma.com/design/qim2RjyYi833JXyFeIJd88/%E5%AE%A2%E6%9C%8D%E7%B3%BB%E7%BB%9F?node-id=3020-78250&m=dev",
          "matchConfidence": "high"
        },
        {
          "vueFile": "GroupNameInput.vue",
          "matched": false,
          "reason": "无对应设计稿（Figma 未为该子控件单独建 frame，属 AgentGroupDialog 内部实现）"
        },
        {
          "vueFile": "SaveButton.vue",
          "matched": false,
          "reason": "无对应设计稿（Figma 未为该子控件单独建 frame，属 AgentGroupDialog 内部实现）"
        }
      ]
    }
  ]
}
```

字段说明：
- `vueComponents`：task 涉及的 Vue 组件文件清单（全部列出，含未匹配的）。
- `figmaRefs[].vueFile`：对应的 Vue 组件文件，与 `vueComponents` 一一对应。
- `figmaRefs[].nodeId`：匹配到的 Figma node Id（Vue 组件级，非控件级）。
- `figmaRefs[].matched`：是否匹配到设计稿。`false` 时无 `nodeId`/`link`，只有 `reason` 说明。
- `figmaRefs[].matchConfidence`：匹配置信度（`high`/`medium`），低置信度需人工复核。
- 未匹配的 Vue 组件明确标 `matched: false` + `reason`，开发工程师对该组件自行实现，不依赖设计稿。

写入路径：`.codebuddy/plans/<storyId>/figma-frame-inventory.json`

> **注意**：本 skill 只产出这一个文件。不再产出 `figma-component-map.md`（已废弃）。设计稿完整内容由开发 Agent（Phase 2）通过 `get_design_context` 自行拉取，任务规划师不拉设计细节。

## 设计稿内容拉取（开发工程师 Phase 2 专属，任务规划师不执行）

> 任务规划师完成 inventory 后，**不要**对任何 node 调用 `get_design_context` / `get_screenshot`。
> 开发工程师在 Phase 2 实现 UI 时，对 inventory 中每个 task 的 `figmaRefs[].nodeId`（`matched: true` 的）调用 `get_design_context`，拉取该 Vue 组件对应 node 的完整设计规格并 100% 还原。
> `matched: false` 的 Vue 组件无设计稿，开发工程师自行实现，不调用 Figma MCP。
> 这样设计稿内容只被拉取一次（开发阶段），避免任务规划师与开发重复调用。

## 兜底方案：启发式匹配（仅当 figmaNodeId 不可用时）

当 `task-dag.json` 中**没有** `figmaNodeId`/`figmaRefs` 字段时，回退到旧的启发式方案：

1. 读取 `task-dag.json` 任务标题 → 提取 Vue 组件名
2. 与清单中的 frame 名称做匹配：
   - "分配规则" → 含 "分配" 的 frame
   - "分组" → 含 "分组" 的 frame
   - "标签" → 含 "标签" 的 frame
3. UI 模式匹配：含穿梭框的弹窗 → AgentGroupDialog；分步表单 → CreateDialog
4. 输出匹配到的链接，但**标注「⚠️ 启发式匹配」**，供人工复核
5. **找不到对应 frame 的 Vue 组件 → 不匹配**，不硬凑。

> 启发式匹配粒度同样是 Vue 组件级，找不到就不匹配。优先保证第 0-3 步产出精确 figmaRefs，兜底方案仅在异常情况下使用。

## 输出模板

### Vue 组件级精确绑定（推荐，figmaRefs 可用时）：

```markdown
## Figma → 组件清单（Vue 组件级，共 N 个 task）

### Task T1：编辑分组弹窗-表单字段校验增强

| Vue 组件 | Figma Node ID | 完整 Figma 链接 | 匹配置信度 | 状态 |
|---------|--------------|----------------|-----------|------|
| AgentGroupDialog.vue | `3020:83533` | [链接](https://...) | high | ✅ 已匹配 |
| AssignRuleTable.vue | `3020:78250` | [链接](https://...) | high | ✅ 已匹配 |
| GroupNameInput.vue | — | — | — | ❌ 无对应设计稿 |
| SaveButton.vue | — | — | — | ❌ 无对应设计稿 |

（设计规格不在此列出——由开发工程师 Phase 2 对已匹配 nodeId 调 get_design_context 拉取；未匹配组件自行实现）
```

### 顶层精确（figmaNodeId 可用但未做组件级匹配，旧版兼容）：

```markdown
## Figma → 组件清单（顶层精确，共 N 个画板）

| 组件/页面 | Figma Node ID | 完整 Figma 链接 | 类型 |
|---------|--------------|----------------|------|
| `编辑分组弹窗` | `3020:83533` | [链接](https://...) | dialog |
| `会话分配规则-高级设置` | `3020:78242` | [链接](https://...) | page |

（设计规格不在此列出——由开发工程师 Phase 2 通过 get_design_context 拉取）
```

### 启发式匹配（标注为兜底）：

```markdown
## Figma → 组件清单（启发式，共 N 个画板）

| 组件/页面 | Figma Node ID | 完整 Figma 链接 | 匹配方式 |
|---------|--------------|----------------|---------| 
| `AssignRule.vue` | `3020:78242` | [链接](https://...) | ⚠️ 启发式（名称+UI） |
```

## 重要说明

- **每个链接必须是完整 URL**，含 `?node-id=...&m=dev` —— 不能只给节点 ID。
- URL 中的 `node-id` 用 `-` 分隔（例如 `3020-83533`）；API 调用则用 `:`（例如 `3020:83533`）。
- 产出物唯一：只产出 `figma-frame-inventory.json`（含 `frames` 全景清单 + `tasks` Vue 组件级绑定，不含 designSpec）。`figma-component-map.md` 已废弃。
- **绑定粒度 = 一个 Vue 组件 ↔ 一个 Figma node**。禁止把 Vue 组件内部的输入框/按钮/表格列拆出来单独绑定。禁止递归钻取到控件叶子节点。
- **找不到对应 node 的 Vue 组件 → 标 `matched: false`，不硬凑、不钻取兜底。** 开发工程师对该组件自行实现。
- **匹配只用 `get_metadata`**。**禁止**用 `get_design_context` 做匹配（那是 Phase 2 职责，且会拉冗余设计内容）。
- **设计稿内容只由开发工程师 Phase 2 通过 `get_design_context` 拉取**，任务规划师只用 `get_metadata` 扫结构，不拉设计细节（避免重复调用）。
- 任务规划师在 task-dag 中应为每个 UI task 写 `figmaRefs: [{vueFile, nodeId, name, link}]`（Vue 组件级一对一）；开发 agent 据此一次精准拉取，不做全量探索。
- 若 `task-dag.json` 中的任务已含 `figmaRefs`/`figmaNodeId`，跳过启发式匹配——直接走精确提取。
- 对于子画板数 >10 的页面，优先用 `get_metadata` 而非 `get_design_context`，避免内容被截断。
- 以 `.` 开头的实例（例如 `.标题样式`）是 Figma 组件库组件——将其父 frame 的尺寸作为规格依据。
