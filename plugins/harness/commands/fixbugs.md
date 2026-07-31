---
description: Harness Bug 修复流水线 — 从 TAPD 拉取 Bug 分析报告，自动触发端到端修复流程
category: workflow
allowed-tools: Bash, Write
---

# /harness fixbugs — Bug 修复端到端流水线

> 串联 TAPD Bug Analyzer + Harness 8 Phase 流水线。
> 先拉取 Bug 并产出分析报告，再逐 Phase 推进修复（需求分析 → 开发 → 审查 → 测试 → 部署）。

## 用法

```bash
/harness fixbugs <storyId> "<标题>" <TAPD链接> [处理人: XXX] [状态筛选: 待解决]
```

**示例**：
```
/harness fixbugs STORY-001 "管家反馈需求合集" https://www.tapd.cn/tapd_fe/10109441/story/detail/xxx 处理人: 小明 状态筛选: 待解决
```

## AI 执行协议

你是 Harness 工作流的主控 Agent。按以下流程依次执行。

### 必须加载的 Skill

在执行任何操作前，先调用以下 skill：

```
use_skill("harness-conductor")
```

### 脚本路径约定

```bash
HARNESS=${CODEBUDDY_PLUGIN_ROOT}/scripts/commands
STORY_DIR=${CODEBUDDY_PROJECT_DIR}/.codebuddy/plans/<storyId>
```

## 执行流程（3 阶段）

```
┌─────────────────────────────────────────────────────────┐
│  阶段 1：Harness 初始化 + Bug 分析（Pre-Phase 0）          │
│  ├── 1A. harness-workflow.js start <storyId> "<标题>"   │
│  └── 1B. 加载 tapd-bug-analyzer skill → 产出报告           │
│                                                         │
│  阶段 2：Harness Phase 0（需求分析）                       │
│  └── 需求分析师 Agent（读取 bug分析报告.md）                │
│                                                         │
│  阶段 3：Harness Phase 1→8（标准流水线）                    │
│  └── 按 run 命令的标准 Phase 循环执行                      │
└─────────────────────────────────────────────────────────┘
```

---

## 阶段 1：Harness 初始化 + Bug 分析

### Step 1A：启动 Harness

```bash
node $HARNESS/harness-workflow.js start <storyId> "<标题>"
```

确认 e2e-state.json 创建成功，Phase = 0。

### Step 1B：加载 Bug Analyzer Skill 并产出报告

**加载 skill**：
调用 `use_skill("tapd-bug-analyzer")` 加载 TAPD Bug Analyzer。

**输入**：从用户消息中提取的 TAPD 链接、处理人、状态筛选等参数。

**产出**：`{storyTitle}_bug分析报告.md`，写入 `${STORY_DIR}/`（当前 Story 的 plans 目录）。

**检查点**：
- 报告文件已生成且非空
- Bug 清单完整（含复述、根因、代码定位、修复建议）
- 按项目分组、按优先级排序

> 如果 TAPD 连接失败或 Bug 列表为空，中止流程并提示用户。

---

## 阶段 2：Harness Phase 0（需求分析）

从 Stage 1 的 Bug 分析报告出发，进入标准 Harness 流程。

### 推进命令

```bash
node $HARNESS/advance-phase.js <storyId> 1
```

### Phase 0 Agent：需求分析师

Spawn `requirement-analyst`（需求分析师）Agent，prompt 必须包含：

```
## 上下文

本 Story 为 Bug 修复任务。Bug 分析报告: ${STORY_DIR}/{storyTitle}_bug分析报告.md

请读取该报告，提取以下信息：
- 涉及的 Bug 列表和项目
- 需修改的文件清单（从报告的代码定位章节提取）
- 按项目分组的修复范围

## 产出要求

基于 Bug 分析报告生成：
1. requirement-analysis.md — Bug 修复需求文档（汇总所有 Bug 及修复目标）
2. acceptance-criteria.json — 验收标准（每条 Bug 对应至少 1 个 AC）
3. open-questions.json — 待确认问题（如有不确定的修复方案）

## 约束

- 验收标准必须可测试，关联具体 Bug
- AC description 中引用 Bug 分析报告中的 Bug #
- 跨项目 Bug 需在 AC 中标注所属项目
```

### 推进检查

- `advance-phase.js` 返回 `success: true`
- `acceptance-criteria.json` 的 criteria 非空
- `open-questions.json` 中所有条目的 `resolved` 必须为 `true`（用户已确认）

---

## 阶段 3：Phase 1→8 标准流水线

此后完全按照 `/harness run` 的 Phase 循环执行（详见 run.md）。

### Phase 1：任务规划

Spawn `task-planner`（任务规划师），prompt 中注入 Bug 分析报告的代码定位信息，确保 task-dag 中的 files[] 包含所有受影响文件。

### Phase 2：代码开发

Spawn `frontend-developer`（前端开发工程师，如有多项目，并行启动多个开发者 Agent）。

每个 prompt 必须包含对应项目的 Bug 分析报告章节（问题复述 + 根因 + 修复建议）。

### Phase 3→8

按标准流程执行（代码审查 → 测试 → Git 提交 → 知识库 → 部署）。

---

## 与 /harness run 的区别

| 维度 | `/harness run` | `/harness fixbugs` |
|------|---------------|-------------------|
| 前置动作 | 无 | TAPD 拉取 Bug + 分析报告 |
| Phase 0 输入 | 用户提供的 PRD/描述 | `bug分析报告.md` |
| Phase 0 Agent prompt | 通用需求分析 | 含 Bug 报告路径 + 结构化指引 |
| 适用场景 | 新功能开发 | Bug 修复任务 |

## 铁律

- 🚫 AI 不直接写 e2e-state.json / dev-pass.json
- 🚫 AI 不跳过 Phase 直接开发
- 🚫 AI 不自行标记 open-questions 为 resolved
- ✅ Bug 分析报告必须产出一份 `.md` 文件
- ✅ Phase 0 必须读取 Bug 分析报告作为输入
