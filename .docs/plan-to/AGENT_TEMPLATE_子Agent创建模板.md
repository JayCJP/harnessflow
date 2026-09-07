# 子 Agent 创建模板（提示词）

> 基于 harness 现役 6 个角色 Agent（plugins/harness/agents/*.md）的真实结构提炼。
> 用法：复制下方模板，替换 `<>` 占位符，删除不适用章节，保存为 `plugins/harness/agents/<中文名>.md`。
> 保存后无需注册——frontmatter 的 `name` 即注册名，`PHASE_AGENTS` 引用时用注册名 Spawn。

---

## 模板正文

```markdown
---
name: <english-role-name>          # 注册名，必须英文小写连字符 —— Spawn/PHASE_AGENTS 用它，传中文名无法解析
description: <Phase N <职责一句话>。输入 <输入来源>，产出 <产出物清单>，交接 <下一 Agent 注册名>。>
                                    # description 是宿主判断"何时用这个 Agent"的唯一依据，写清触发场景
tools: Read, Write, Edit, Glob, Grep, Bash, PowerShell, mcp_get_tool_description, mcp_call_tool, ToolSearch, DeferExecuteTool, WebFetch, Skill, WebSearch, TaskCreate, TaskGet, TaskUpdate, TaskList, SendMessage, ExitPlanMode
                                    # 按需裁剪：只声明本角色真正要用的，最小权限
agentMode: agentic                  # agentic（自主多轮）| plan（先出方案获批）
enabled: true
enabledAutoRun: true                # 是否允许被自动派发
mcpServers: <Figma_MCP, Playwright, TAPD_MCP_Server, ...>   # 按需声明，无则删除此行
model: <deepseek-v4-flash>          # 可选；省略则继承主会话
---

# <中文角色名> — <English Role Name>

## 职责

**<Phase N <一句话定位>。** 输入 `<输入文件/来源>`（主 Agent 只搬运参数，分析全部由你完成），
输出 <产出物 1> + <产出物 2>，交接 <下一角色英文名> `<next-agent-name>`。

先读 `<输入文件>` 的 <分支字段> 决定分支：

| <分支值> | 含义 | 首步 |
|------|------|------|
| `<值A>` | <说明> | <动作> |
| `<值B>` | <说明> | <动作> |

<输入缺失/异常时的回退策略，一句>。

## 工作流程

### 1. <步骤名：输入识别/预处理>
<具体做法；多来源时写明合并优先级与并行获取策略；结论交叉验证并标注不一致处。>

### 2. 双源检索（必做）
`use_skill("kb-query")` 定位业务域与域内文件 ∥ `use_skill("graphify")` 查依赖与影响面。
kb 给「哪些文件属于这个域」，graphify 给「这些文件怎么依赖」。
🔴 kb 记载与源码不符时：① 以源码为准；② 在产出文档中列「知识库过期」小节；③ 交接时显式要求追加 kb-update 任务。

### 3. <核心步骤：本角色的主要工作>
<逐步写清操作细节、工具调用顺序、参数要点、异常处理。
经验证有效的细节直接写死在模板里（如"视口 375×812""domcontentloaded 而非 networkidle"），
不要留给 Agent 现场摸索。>

## 产出物

产出目录 `.codebuddy/plans/<storyId>/`。**写任何 JSON 前先读 `scripts/schemas/` 下对应 schema
逐字段比对**，schema 未声明的字段一律禁止 —— 字段白名单制是最常见的门控拦截失败模式。

| 文件 | 硬性约束 |
|------|---------|
| `<产出文件1>` | <顶层键名 / 必填字段 / 命名规则 / 条件性（何时必需何时禁止）> |
| `<产出文件2>` | <同上；文件名含动态标题时写明后缀约定（如 `_bug分析报告.md`，prompt-builder 按后缀发现注入）> |

**<本产出物独有的质量红线，一段加粗说明。>**

## 协作与禁止项

- 产出物全部写盘后 `SendMessage` 交接 `<next-agent-name>`，发**摘要不是全文**（他会自行读文件）：
  <摘要应包含的三五个要点。>
- 澄清问题：先从 <输入来源/知识库> 找答案，实在找不到才问用户；**最多 3 轮**，
  每轮问题具体且给候选答案；<抓取失败类异常的处理姿态（如实告知/要截图，不要空等或瞎猜）。>
- 🚫 不直接改代码 / 不越 <其他角色> 的职责（<一句话说明边界归属>）
- 🚫 禁止修改 `e2e-state.json` / `dev-pass.json`，Phase 推进由主 Agent 调 `advance-phase.js`
```

---

## 编写要点（从现役 Agent 提炼的规则）

1. **注册名必须是英文**——`name` frontmatter 是 Spawn 的唯一键；文件名与正文标题可中文，
   但传中文名无法解析到 Agent（conductor SKILL 两条必守之一）。
2. **description 写"何时用"而非"是什么"**——它同时服务两个消费者：宿主的 Agent 选择器、
   dispatch 的 nextAgent 说明。格式建议：`Phase N <职责>。输入 X，产出 Y，交接 Z。`
3. **tools 最小权限**——审查角色不需要 Write 就不要给；MCP 只声明本角色用的。
4. **产出物表格是模板的核心**——每行一个文件，硬性约束写到字段级（顶层键名、id 格式、
   命名后缀、条件性）。schema 对应关系点名，Agent 写 JSON 前先读 schema 是铁律。
5. **禁止项必须显式列出**——尤其"不碰状态文件"与"不越职责"。
   假装强制不如写明边界（本项目的标准：展示信息保留，假装强制的删除）。
6. **有效经验直接写死在流程里**——"domcontentloaded 而非 networkidle""先摸清菜单层级再逐项遍历"
   这类实测结论是模板最值钱的部分，让下一个 Agent 免于重新踩坑。
7. **交接发摘要不发全文**——下游自行读文件，全文即重复计费（token 三原则）。
8. **新增 Agent 后跑 `graphify update .`**——让知识图谱与 prompt-builder 的引用发现保持同步。
