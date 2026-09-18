# CODEBUDDY.md

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## 项目是什么

Harness Marketplace —— 一个 **AI 编程助手的插件市场仓库**（同时兼容 Claude Code / CodeBuddy Code）。
仓库本身不产出业务代码，产出的是 **Harness 插件**：一条覆盖「需求分析 → 任务规划 → 代码开发 → 代码审查 → Git 提交 → 知识库更新 → 云端部署」的端到端自动化流水线。

- 主文档：[README.md](./README.md)（面向用户） / [INSTALL.md](./INSTALL.md)（面向 AI 代理的安装验证）
- 插件本体：`plugins/harness/`
- 市场清单（两份内容须保持一致）：`.claude-plugin/marketplace.json`、`.codebuddy-plugin/marketplace.json`

## 核心设计原则（改代码前必读）

**AI 不操作状态，只机械执行。** 这是全仓库最重要的一条约束，几乎所有架构决策都由它推导：

- `scripts/commands/dispatch.js` 是**只读调度器** —— 读状态、判门控、说下一步，零写权限，返回四态 `ready / fix_loop / blocked / terminal`
- `scripts/commands/advance-phase.js` 是**相位跃迁唯一执行者** —— 判门控、写状态、签发/撤销 dev-pass
- 主 Agent 无判断权，按 `status` 机械分支
- `scripts/services/prompt-builder.js` 是 **agentPrompt 的唯一出口**（dispatch 与 advance-phase 都调它），主 Agent 只做原样注入、不做拼接 —— 拼接即判断，判断权回到主 Agent 就会导致流程失控

**同物多信源必须彻底收敛。** 仓库对「同一事实写在两处」极度敏感，改动时不要留副本或 fallback：

- 产出物清单唯一信源 = `scripts/lib/phases.js` 的 `PHASE_ARTIFACTS`
- 声明范围匹配唯一信源 = `scripts/lib/scope.js`（曾有 dev-pass.js / enforce-dev-pass.js 两份同构实现，已删除）
- `scripts/lib/paths.js` **只允许依赖 node 内建 fs/path**，不得 require 仓库内其他模块 —— 它存在的意义就是断掉 state/debug-log/trace 三者的循环依赖，一旦引入上层 require 环立刻复原

**事后审计优于事前硬拦。** 文件级限域拦截已被取消（`scope.js` 头部注释详述三条原因：Phase 1 无法穷尽依赖、原实现只匹配 Write/Edit 而 Bash 写入可绕过形成逆向淘汰、越界应以「实际改了什么」判定）。现在是 Phase 2→3 用 git 实际变更比对 `task-dag.json` 的 `files[]`，范围外改动落 `scope-amendments.json` 交 Phase 3 逐条核对必要性。**不要重新引入事前文件拦截。**

## 插件结构

```
plugins/harness/
├── plugin.json            # 插件元信息（agents/skills/hooks/outputStyles 入口）
├── agents/                # 5 个角色 Agent（中文文件名 + 英文 frontmatter name）
├── skills/                # start/end/archive/evolve、kb-*、gen-project-docs、api-generator、figma-*、prototype-capture、tapd-bug-analyzer
├── hooks/hooks.json       # SessionStart / PreToolUse / PostToolUse / Stop 钩子声明
├── scripts/
│   ├── commands/          # dispatch.js、advance-phase.js、create-workflow.js、harness-workflow.js、archive-story.js
│   ├── services/          # policy.js（门控）、prompt-builder.js、schema-validator.js、context-refresh.js、experience.js
│   ├── lib/               # 零依赖底座：paths / phases / artifacts / dev-pass / scope / state / contracts / repos
│   ├── hooks/             # enforce-dev-pass.js、enforce-artifact.js、enforce-state-file.js、session-*.js、trace-command.js
│   ├── schemas/           # 8 个 JSON Schema（ajv 校验）
│   ├── audit/             # harness-audit.js、metrics-aggregator.js（自进化体检）
│   ├── experience/        # 失败模式库、指标洞察、改进提案
│   └── __tests__/         # 9 个 .test.js，run-all.js 串行跑
└── vendor/ajv.bundle.js   # 内置单文件 ajv（免 npm install）
```

## 关键约束

- **运行时零依赖。** 插件安装后由 node 直跑，**绝不能**要求 `npm install`。ajv 以 `vendor/ajv.bundle.js` 内联；eslint/neostandard 只在 devDependencies。`package.json` 里 `dependencies` 必须保持 `{}`。
- **Agent 注册名是英文。** `PHASE_AGENTS` 的 `agent` 字段对应 agent 文件 frontmatter 的 `name`（如 `requirement-analyst`）。文件名与正文标题是中文，`label` 仅供人类阅读，**禁止用于 Spawn**（传中文名解析不到 Agent）。
- **`PHASE_SLUGS` 数组长度即最大 Phase。** `MAX_PHASE = PHASE_SLUGS.length - 1`，当前 0-7 共 8 个槽位（7 是终态）。数组增删时无其他硬编码需要同步。
- **测试沙箱必须在 require 之前设环境变量。** `paths.js` 的 `PROJECT_ROOT` / `PLANS_DIR` 是**模块加载期求值**（读 `CODEBUDDY_PROJECT_DIR`，回退 `CLAUDE_PROJECT_DIR`，再回退 cwd）。测试用例要设这两个变量后再 require 被测模块，只设一个会导致沙箱失效、读到真实项目目录。
- **测试串行执行。** `run-all.js` 逐个 spawn，因为每个用例都改环境变量，并行会互相覆盖。
- **路径注入用正斜杠。** 注入 prompt / 输出给人看的路径须走 `toForwardSlashes`：UI 的 markdown 渲染层会把 `\.` 当转义吃掉（`D:\repo\.codebuddy` 渲染成 `D:\repo.codebuddy`），曾导致用户误判脚本拼错路径而中断流程。

## 常用命令

全部在 `plugins/harness/` 下执行：

```bash
npm test                    # 或 node scripts/__tests__/run-all.js
node scripts/__tests__/fixbugs-regression.test.js        # 单跑某个用例
npm run lint                # eslint（neostandard）
node scripts/audit/harness-audit.js --json               # 自进化体检
```

调试：宿主启动时加 `--debug`；`scripts/audit/debug-replay.js` 可回放 trace。

## 状态文件纪律（铁律）

- 🚫 **不手改** `.codebuddy/plans/<storyId>/e2e-state.json` / `dev-pass.json` —— 全部由脚本签发/推进，`enforce-state-file.js` hook 会拦截并记录违规
- 🚫 **Phase ≠ 2 时不编辑 `src/`** —— `enforce-dev-pass.js` 直接拒绝；Phase 2 超时用 `--renew-pass` 续签（dev-pass 默认 TTL 2 小时）
- 🚫 **不自行把 `open-questions.json` 的 `resolved` 设为 `true`** —— 必须由用户确认
- `.codebuddy/` 被 gitignore，是运行时状态目录，不入库

## 已知状态

`npm test` 当前并非全绿：55/55 用例通过的测试文件有 7 个，另有 2 个文件存在失败断言，合计 5 条失败 ——

- `fixbugs-regression.test.js`：3 条，断言 `AGENT_CONSTRAINTS` 为 4 条且含「检索失败上报」「Bash 失败交代」
- `optimization-regression.test.js`：2 条，断言同一批约束已注入 agentPrompt

而 `prompt-builder.js:102` 当前是 2 条。这是 **token 优化收敛与测试期望之间的未对齐**（`prompt-builder.js` 头部注释里两处说法也自相矛盾：一处写「从 5 条减到 2 条」，一处写「现 4 条」）。修 bug 时先确认是改代码补回约束、还是改测试对齐 2 条，不要默认全绿。

## 分支与交付

- 主干 `master`；当前工作分支 `kb-opt`
- 另有 `for-claude-code` / `for-codex` 适配分支
- 远程有两个 origin（`origin` / `origin2`）
- 插件版本号在两处声明且需同步：`plugins/harness/plugin.json` 与市场清单里的 `version`
- 提交时不要跳过 pre-commit 钩子
