# harness scripts/ 规范化重构 — 进展交接

> 最后更新: 2026-09-07
> 分支: `opt/prompt-and-gate-2026-09`
> 完整方案: `C:\Users\Intel\.claude\plans\synchronous-purring-pike.md`
> 工作目录: `plugins/harness/`（注意：`npm test` 必须在此目录下跑，仓库根没有 package.json）

## 一句话状态

9 个阶段**全部完成**（0/1/2/3/4/5/6/7/8）。
**测试基线：8 个文件 347 断言全绿；`npm run lint` 全绿**（ESLint v9.39.5 + neostandard 0.13）。
已按主题提交为 3 个 commit：收口 / CLI+hook / 拆分+lint。

## 验证命令

```bash
cd plugins/harness
npm test                       # 347 断言 / 8 文件
npm run lint                   # 必须全绿
node scripts/audit/harness-audit.js --json # 健康审计
```

---

## 已完成

### 阶段 0 — 基线
8 个测试文件 347 断言全绿（advance-phase 20 / debug-log 27 / experience-lessons 46 /
figma-detection 55 / fixbugs 50 / flow 30 / optimization 64 / story-input 55）。

### 阶段 1 — ESLint（2026-09-07 完成，此前被 `npm install` 阻塞）
`node_modules` 已装好，`eslint.config.js` 的参数名是对的，开箱可用。
`--fix` **修不动这里的报错**（全是 `no-unused-vars` 与少量风格规则），全部手工清：

- 删未用导入/变量 25 处（含 3 个测试文件的 `SANDBOX`、api-generator 的 `path`/`fs`）
- `enforce-state-file.js` 正则去多余转义 `[\/\\]` → `[\\/]`（字符类内等价）
- `optimization-regression.test.js` 的 `new RegExp('…')` 改正则字面量（等价）
- `policy.js:759` 加括号显式化优先级（**保持原语义**，见下方"发现但未改"）
- `swagger-parser.js` 两处 `}` 换行 + `else if` 归到同一行；`[k, v]` → `Object.values`
- `kb-init.cjs` 的 case 块加花括号；`kb-update.cjs` 的 `var` 改前置 `let`
- `eslint.config.js` 关掉 `no-template-curly-in-string`：4 处命中都是**输出给 Agent 的命令
  模板**，`${CLAUDE_PLUGIN_ROOT}` 必须保持字面量，改真插值反而输出空串

连带删掉的死代码：`gen-docs.cjs` 的 `readSourceRoot` + `SRC_ROOT` + `PROFILE_PATH`
（`SRC_ROOT` 无人用，前两者只为它服务）、`kb-init.cjs` 的 `commonTemplates`、
`advance-phase.js` 的 `phase3Key`/`phase4Key`、`session-start.js` 的 `inputData` 解析
（保留 `readStdin()` 调用以维持 stdin 消费行为）。

### 阶段 2 — 测试样板收口
新增 `scripts/__tests__/_helpers.js`（111 行）：`makeSandbox` / `ok` / `section` / `summarize`。
7 个测试文件改造，共删约 200 行重复样板。

**关键手法**：每个文件保留 `const SANDBOX = sandbox.root`，使文件体内所有 `SANDBOX`
引用（`spawnSync` 的 env、`path.join`）一行未动 —— 刻意压低出错面。
（注意：`debug-log.test.js` 末尾 `summarize(sandbox)` 要用到 sandbox 对象本身。）

### 阶段 3 — 路径与契约访问收口
- **`scripts/lib/paths.js`（112 行，零依赖）**：`normalizeProjectRoot` / `PROJECT_ROOT` /
  `PLANS_DIR` / `getStoryDir` / `ensureStoryDir` / `listStoryDirs` / `isStateFile`
- **`scripts/lib/artifacts.js`（167 行）**：`ARTIFACT` 文件名表（19 项，覆盖 json/md/jsonl）
  + `readJson` / `readText` / `readJsonl` / `artifactPath` / `archiveRoundDir` / `HARNESS_ACTIVE_FLAG`
- **断开循环依赖**：`debug-log.js` 原有的 `let _state` + `stateModule()` 惰性 require
  hack **整段删除**，改为 `require('./paths')`；`trace.js` 的 require 源同步改为 `./paths`
- **34 处硬编码文件名**替换为 `ARTIFACT.*` 常量
- `state.js` 从 `paths.js`/`artifacts.js` 再导出同名符号，**15 个调用方一行未动**

### 阶段 4 — CLI 范式 + 输出契约
| 文件 | process.exit | module.exports |
|---|---|---|
| `services/validate-contracts.js` | 3 → 2（都在 `require.main` 内） | `{ validateContracts }` |
| `commands/harness-workflow.js` | 5 → 1 | `{ main, cmdStart, cmdEnd, cmdStatus }` |
| `commands/archive-story.js` | 11 → 1 | `{ main, cmdArchive, cmdRestore, cmdList, cmdStatus }` |

**stdout 纯净化**：`advance-phase.js` 全部 20 处进度文本改走 `console.error`，stdout 只剩
末尾一份 JSON。三处测试 hack（`lastIndexOf('{\n  "success"')`）删除，改为直接 `JSON.parse(stdout)`。

### 阶段 5 — 切分 advance-phase.js（2026-09-07 完成）
1351 行 → 主文件 892 行 + 三个子模块：

| 子模块 | 行数 | 内容 |
|---|---|---|
| `commands/phase-ops/renew-pass.js` | 68 | `--renew-pass`（targetPhase≠2 时返回 null，主流程继续） |
| `commands/phase-ops/rollback.js` | 176 | `--rollback` |
| `commands/phase-ops/fix-loop.js` | 330 | `--fix-loop`（含两个 `extractFixIssuesFrom*`） |

**接口约定**：子模块只做「计算 + 落盘」，返回 `{ exitCode, output }`，由主文件统一
`emit()` + `process.exit()` —— 保证 debug 留痕的 `source` 始终是 `advance-phase.js`，
输出契约只有一个出口。主文件同时拿掉了函数内重复 `require('../lib/state')`（`PHASE_ARTIFACTS`）。

**验证手法（可复用）**：切分前先写了一份 16 场景的 A/B 对比脚本（沙箱建两个同构 story，
分别跑改前/改后脚本，对比 exit code + stdout + stderr + **落盘文件全量内容**，归一化
时间戳/耗时/脚本绝对路径/沙箱目录名），确认基线零差异后再动刀，切完仍是 16/16 等价。
覆盖：缺参、state 缺失、越界、倒退、跨 Phase、同 Phase、renew-pass（含非 Phase 2 的
"不接管"路径）、rollback（含回到 Phase 2 的预算重置）、fix-loop（正常/预算耗尽/无问题/
从验收提取）、真实推进 0→1 与 2→3。脚本用完即删（未入库）。

**未做**：`main(argv)` + `require.main` 守卫化。它要求把 900 行过程代码缩进进函数体，
diff 会大到无法审查，收益（可测试性）已被现有 CLI 级测试覆盖；如需再单独做一次。

### 阶段 6 — Hook 运行器
新增 `scripts/lib/hook-runner.js`（178 行）：`runHook(event, handler)` 吃掉 stdin 读取、
JSON 解析兜底、`tool_name`/`tool_input` 归一化、`apply_patch` 路径正则、决策渲染、退出码。

4 个 hook 全部改造（`enforce-state-file` / `enforce-artifact` / `enforce-dev-pass` /
`trace-command`），25 处放行样板消除。

**验证手法**：改前脚本留快照（含 `vendor/` 与 `package.json`），对 6 个 hook 喂同一份
stdin 对比输出与退出码 —— 全一致（`session-stop` 的差异只有 `sessionEndedAt` 与耗时）。

### 阶段 7 — 删手写扫描器（2026-09-07 完成）
先用一个含悬空引用的临时文件验证 ESLint `no-undef` 真能报错，确认可替代后删除
`harness-audit.js` 的 `auditCoreScripts` + `auditDanglingReferences` +
`stripStringsAndComments`（共 219 行）及 `run()` 里的调用，连带删 `execSync` 导入。
保留 `auditActiveStory`/`auditDevPass`/`auditContracts`/`auditDeclarationConsumption`/`auditArtifacts`。

**顺序教训**：这个文件头注释里用了零宽空格写 `/* ... *​/`（否则会提前闭合注释），
ESLint 报 `no-irregular-whitespace`。先做阶段 7 再收尾阶段 1，就不必为待删代码纠结。

### 新增 `scripts/__tests__/advance-phase.test.js`（20 断言）
覆盖：缺参用法、state 缺失、targetPhase 越界不写状态、倒退 vs 跨 Phase 的不同指引、
纯数字 storyId 歧义解析（TAPD ID 场景）、`plans/` 前缀剥离、stdout 只含 JSON 的契约断言。

---

## 顺带修掉的真实缺陷（都不在原计划内）

1. **`services/policy.js` Phase 4→5 告警从未触发过** — 读 `oqCheck.unresolvedCount`，
   而 `checkOpenQuestions` 从不返回该字段，`undefined > 0` 恒为 false。已改为 `.unresolved.length`。
2. **`hooks/enforce-dev-pass.js` 限域拒绝消息输出 `[object Object]`** — `allowedPaths.join(', ')`
   而元素是 `{repo, path}` 对象。已加 `describeAllowed()`，输出 `main:src/views/Foo.vue, main:src/api/`。
3. **`checkOpenQuestions` 双实现语义分叉** — 统一到 `state.js` 一份（按 schema 的 boolean
   契约用 `!== true`），`dispatch.js` 改为 `openQuestionWarnings()` 薄封装。
4. **`__tests__/debug-log.test.js` 的 `since 过滤` 是 flaky 测试** — 三条 record 同步写入
   常落同一毫秒，写死"返回 2 条"会间歇假红。改为断言 since 语义本身。

## 发现但未改（需你拍板）

- **`services/policy.js:759` 疑似优先级 bug**：
  `lower.includes('acceptancecriteria') && lower.includes('空') || lower.includes('缺少')`
  按 JS 优先级等价于 `(A && B) || C`，即**只要文本含"缺少"就会判为 `empty_ac_ref`**，
  不需要含 acceptancecriteria。本次只加括号显式化、保持原语义，未改判定逻辑 ——
  改它会改变门控行为，超出纯重构范围。

---

## 关键决策（勿回退）

### 硬约束
- **运行时零依赖**：`dependencies` 必须为空，插件被安装后 node 直跑、不能要求 `npm install`。
  ajv 以 `vendor/ajv.bundle.js` 内联。lint 工具**只进 devDependencies**。
- **hook 退出码是宿主契约**：放行 exit 0，拒绝 **exit 2**（不是 1）。改动会让拦截静默失效。
- **hook 失效必须是"不拦"而不是"卡住主流程"**：空 stdin / 非 JSON / handler 抛异常
  一律放行 exit 0。

### 三个踩过的坑
- **`isSrcFile` 不能进 `paths.js`** —— 它调用 `getRepoForFile`（依赖 repos.json 反查），
  属仓库注册表层，放进去会破坏"零依赖"前提、循环依赖复原。已留在 `state.js`。
- **测试沙箱必须可选** —— `experience-lessons.test.js` 有意不用沙箱（其 `EXPERIENCE_DIR`
  由 `__dirname` 推导、不受环境变量影响，见该文件头注释）。helper 不能强制建沙箱。
- **hook deny 输出字段并非齐整** —— `enforce-dev-pass` 三处拒绝都带 `stopReason` +
  `recordFailure`，而 `enforce-state-file` 的 apply_patch 通道拒绝只有
  `permissionDecisionReason`。runner 把这两字段做成可选；**给原本没有的分支补齐就是行为变更**。

### 其他
- `state.js` 只做聚合再导出，调用方一行不动；新代码引精确模块，旧引用自然衰减。
- 沙箱环境变量 `CODEBUDDY_PROJECT_DIR` 与 `CLAUDE_PROJECT_DIR` **必须同时设**，
  且必须在 `require` 被测模块**之前**（`PLANS_DIR` 是模块加载期求值的）。
- 子模块（phase-ops/*）不 emit、不 exit，输出与留痕统一在主文件出口。
- `enforce-state-file.js` 原先自带一份 stdin 读取实现（与 `state.js` 的 `readStdin`
  是两套重复代码），已统一到 `hook-runner.js`。

### 明确不做
- **不上 TypeScript**：会破坏 `${CLAUDE_PLUGIN_ROOT}/scripts/xxx.js` 的直接可执行性。
  想要类型收益就加 `// @ts-check`（现有 JSDoc 已足够密）。
- **不换 jest/vitest**：现有 `spawnSync` + 手写断言配合"沙箱须在 require 前设环境变量"
  这个硬约束反而更可控。真要 runner 用内置 `node:test`。
- **不合并 `audit/` 进 `services/`**：受众不同（audit 出人读报告，services 给流程做门控）。

---

### 阶段 8 — 拆 `state.js`（2026-09-07 完成）
1584 行 / 64 个导出符号 / 被 15 个文件 require（注意：导出是 64 不是计划里写的 55，
阶段 3 后符号有增加）。按自身分组注释切成 7 个模块 + 1 个零依赖底座：

| 模块 | 行数 | 内容 |
|---|---|---|
| `lib/stdin.js` | 68 | readStdin（零依赖，原 state.js 与 hook-runner.js 各有一份逐行相同的实现） |
| `lib/repos.js` | 170 | 仓库注册表 repos.json + isSrcFile |
| `lib/phases.js` | 210 | PHASE_SLUGS/NAMES/ARTIFACTS/AGENTS + 三个查表 |
| `lib/story-state.js` | 165 | e2e-state CRUD + 活跃工作流 + cleanStoryDir |
| `lib/artifacts-check.js` | 400 | 产出物存在性 + Figma 链路校验 |
| `lib/contracts.js` | 400 | 契约文件常量 + 读取 + 5 个 check |
| `lib/dev-pass.js` | 265 | dev-pass 生命周期 + 修复轮次预算 |
| `lib/errors.js` | 70 | structuredError / errorToString / errorToType |

`state.js` 只剩聚合再导出（约 230 行，其中大半是头注释），**15 个调用方一行未动**。

**验收**：`Object.keys(require('./scripts/lib/state')).length === 64`，
且符号集合与顺序与拆分前**逐项一致**（已脚本核对：缺失 0 / 新增 0 / 顺序 true）。

**依赖方向**：paths / artifacts / stdin 零依赖 → repos、phases → story-state →
contracts → artifacts-check、dev-pass → state（聚合层）。无循环；已用脚本逐个
require `lib/` `services/` `commands/phase-ops/` 全量模块验证可加载。
（注意：**不要 require hooks/ 与 CLI 型脚本做加载测试** —— 它们顶层即执行，
require 会真跑起来，hook 还会阻塞在 readStdin 上。）

**未动的重复实现**：`hooks/session-start.js` 另有一份只读一次的简化 readStdin
（openSync + 单次 readSync，无 fd 0 快路径），语义与 stdin.js 有差异，替换会改变
其输入行为，本次保留。

---

## 已完成全部 9 个阶段，无待办。

---

## 本次新增文件一览

```
plugins/harness/eslint.config.js                        flat config + neostandard
plugins/harness/scripts/lib/paths.js                    112 行，零依赖底座（项目根/Story 目录）
plugins/harness/scripts/lib/artifacts.js                167 行，ARTIFACT 表 + 读取
plugins/harness/scripts/lib/stdin.js                    68 行，stdin 读取（零依赖）
plugins/harness/scripts/lib/hook-runner.js              155 行，runHook（readStdin 迁出至 stdin.js）
plugins/harness/scripts/lib/repos.js                    170 行
plugins/harness/scripts/lib/phases.js                   210 行
plugins/harness/scripts/lib/story-state.js              165 行
plugins/harness/scripts/lib/artifacts-check.js          400 行
plugins/harness/scripts/lib/contracts.js                400 行
plugins/harness/scripts/lib/dev-pass.js                 265 行
plugins/harness/scripts/lib/errors.js                   70 行
plugins/harness/scripts/commands/phase-ops/renew-pass.js 62 行
plugins/harness/scripts/commands/phase-ops/rollback.js   179 行
plugins/harness/scripts/commands/phase-ops/fix-loop.js   426 行
plugins/harness/scripts/__tests__/_helpers.js           111 行，测试设施
plugins/harness/scripts/__tests__/advance-phase.test.js  20 断言
plugins/harness/node_modules/ + package-lock.json       仅 devDependencies（eslint），运行时仍零依赖
```

## 提交情况

已按主题提交为 3 个 commit（用 `git commit -- <paths>` 限定路径，未动上一会话
已 staged 的 `agents/*.md` 与 `.plugins-cache.json`）：

1. **收口** — paths/artifacts/stdin 三个零依赖底座、测试设施 `_helpers.js`、
   34 处硬编码文件名常量化、state ⇄ debug-log 循环依赖消除
2. **CLI + hook** — 三个 CLI 的 `main()` + `require.main` 范式、stdout 纯净化、
   hook-runner 与 4 个 hook 改造
3. **拆分 + lint** — state.js 拆 7 个模块、advance-phase 拆 phase-ops/、
   harness-audit 删手写扫描器、ESLint 接入与 40 处报错清零、skills/ 风格收敛

阶段 2/3 与阶段 1/5/7 改到过同一批文件（如 `debug-log.js`），严格做到
"一个阶段一个 commit" 需要 `git add -p` 分 hunk；重叠文件按**最后一次改动所属
阶段**归入对应 commit。
