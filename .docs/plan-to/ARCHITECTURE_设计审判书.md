# Harness 设计审判书 —— 以其自身端到端工程化标准审判其身

> **审判对象**：harness 插件 v2.0.0 的架构设计（被审对象即 `docs/ARCHITECTURE_架构技术分析.md` 所分析的系统）
> **审判方法**：以其人之道审判其身——法条全部取自 harness 自己宣称的工程原则，另补充端到端工程化通用判据；证据全部来自知识图谱 v2（1824 节点 / 2829 边 / 136 社区）定量数据与 17 份核心文档
> **裁决等级**：✅ 成立 ｜ ⚠️ 缓刑（附条件）｜ ❌ 有罪（须执行）｜ 💤 已裁决封存（已有明确决策记录，不再复审）
> **生成日期**：2026-09-04

---

## 第一章 审判框架

### 法条一：系统自我宣称的原则（取自 SKILL.md / README / 设计文档）

| # | 法条 | 立法出处 |
|---|------|---------|
| L1 | AI 不操作工作流状态，所有 Phase 推进必须通过脚本完成 | conductor SKILL「核心原则」 |
| L2 | 单一信源（PHASE_ARTIFACTS / PHASE_AGENTS / agentPrompt / writeStateFile / repos.json） | state.js、Agent-Prompt-单一信源.md |
| L3 | 三权分立：dispatch 只读 / advance-phase 唯一写 / 主 Agent 机械执行 | conductor SKILL |
| L4 | fail-closed：校验失败即 BLOCKER，不降级放行 | phases/README、schema-validator |
| L5 | 诚实性：如实告知，不静默跳过（observed / inferred / unobserved） | README、metrics 洞察 |
| L6 | 渐进式披露：按动作触发读取，不常驻 context | conductor SKILL、phases/README |
| L7 | 有界失败：修复回路有预算，用尽转人工，不无限空转 | 错误恢复.md |
| L8 | 经验飞轮：失败结构化沉淀 → 按相位注入 → 强制转化 | experience.js、EVOLVE 方案 |

### 法条二：端到端工程化通用判据

闭环完整性 / 状态一致性 / 流程经济学（阻塞与非阻塞的正确分配）/ 失败预算 / 可观测性 / 权责分离 / 复杂度预算 / 可进化性。

### 已裁决封存事项（宣布不再复审）

以下事项已有明确决策记录在案，本次审判**不重审、不重新劝服**，仅作为背景计入量刑：

- 💤 **build 门控默认关闭**：为保流程不阻塞接受 SCSS/模板编译错误后移至 Phase 7 云端暴露；async 化 + 多项目并发方案已否决；基准 commit 机制已否决。
- 💤 **Dispatch 大社区不拆分**：三权分立是刻意设计。

---

## 第二章 法条审判：宣称 vs 实证

### L1「AI 不操作状态」—— ✅ 成立（本庭见过最完整的实现之一）

**呈堂证据**：

1. `writeStateFile()` 是 `e2e-state.json` 唯一合法写入通道（lib.md）
2. `enforce-state-file.js` Hook 的 matcher **包含 Bash/execute_command**——连 shell 重定向绕过都拦（hooks.md）
3. `phase_integrity_violation` 主动检测：某 Phase 已标 completed 但 state.phase 在其之前 → 判定绕过脚本改状态，事件写 trace（错误恢复.md）
4. 图谱证据：State 结构化错误、状态机单一信源、相位跃迁与防篡改三个社区（合计 69 节点）全部围绕该原则凝聚

**判决**：三道防线（通道收窄 + 写拦截 + 事后检测）形成闭环，宣称与实现一致。唯一的写例外 `.dispatch-precheck.json` 已正确归类为诊断文件而非状态机文件，合规。

### L2「单一信源」—— ✅ 成立，但记录一项结构性风险

**呈堂证据**：五个单一信源（产出物清单 / Phase→Agent / agentPrompt / 状态写入 / 仓库注册）全部落实，且图谱 God Nodes 前 10 中 7 个是 `state.js` 的只读出口函数——**这就是单一信源的物理证据：所有依赖都汇聚到同一处**。

**判决**：原则成立。附带记录：`state.js` 是架构单点，改它影响面最大。这不是违规而是该原则的必然代价，缓解措施（回归测试矩阵 + harness-audit）在案，接受监管即可。

### L3「三权分立」—— ✅ 成立

**呈堂证据**：dispatch.js 零写权限（唯一例外已归类诊断文件）；advance-phase.js 独立校验入参（范围 0~7、步长必须 +1），主 Agent 传错 targetPhase 写不坏状态；主 Agent 的禁止清单（不读状态/不判断/不拼 prompt/不自行恢复）明确列在 SKILL 骨架。

**判决**：触发权 ≠ 决定权的分离在代码层真实存在，非纸面宣称。

### L4「fail-closed」—— ⚠️ 缓刑（两处 fail-open，均有理由记录）

**fail-closed 成立的证据**：schema 校验失败即 BLOCKER 不降级；`isPrototypeRequired` 无 story-input 时保守返回 true；`--input` 校验不过则 exit 1 且不写标记文件。

**两处 fail-open（缓刑条件）**：

1. 编译校验默认关闭（`HARNESS_RUN_BUILD=1` 才启用）——流程不阻塞优先，已有裁决封存。附条件：`build:dev` 提速路径的建议保留在技术分析文档中，项目侧自愿采用。
2. 资源完整性检查（kb-query / graphify 未调用）只给 WARNING 不给 BLOCKER——理由正当（子 Agent tool_call 不入主 trace，证据不可靠时不给硬判罚，这本身是诚实性原则的体现）。

**判决**：原则主体成立；两处例外均有书面理由，属自觉的取舍而非疏漏。缓刑，无附加义务。

### L5「诚实性」—— ✅ 成立

**呈堂证据**：MCP 未配置时相关环节失败并如实告知，不静默跳过；Figma 桌面端未运行时子 Agent 停止而非退回缓存数据（零猜测还原）；度量体系 observed / inferred / unobserved 三态，证据不足不打分；dispatch 预检 blocker 与 advance-phase 实际裁定之间还设有对账补记机制（preGateBlocked）——**连自己的预检都不轻信**。

**判决**：成立，且是同类系统中的差异化优点。

### L6「渐进式披露」—— ✅ 成立

**呈堂证据**：conductor SKILL 只保留三步循环骨架，8 Phase 门控详情、脚本 API、错误恢复等全部外移 references 按动作触发；phases/README 明示「不要整目录通读」；图谱超边中有 14 条群体关系以 references 文档为信源——references 层承担了结构化知识的角色，证明该层在运行时确实被消费。

**判决**：成立。骨架 ~120 行 + 按需 references 的粒度经过实践校准（P3-5 迭代记录在案）。

### L7「有界失败」—— ✅ 成立（多数 Agent 系统缺这一条）

**呈堂证据**：review 与 test 各 2 轮独立预算（`DEFAULT_MAX_REVIEW_FIX_ROUNDS` / `DEFAULT_MAX_TEST_FIX_ROUNDS`）；用尽后 `dispatch.js` 输出 `status: blocked` 且 `recovery.command: null` → 强制转人工；未登记 failureType 命中 `RECOVERY_SUGGESTIONS.unknown` 并产生补录 warning——**连「未知失败」本身都被预算管理**。

**判决**：成立。修复回路的有界性是这套设计对「AI 无限重试空转」这一业界通病的直接回答。

### L8「经验飞轮」—— ✅ 成立，且是最大亮点

**呈堂证据**：双向闭环完整——门控失败 `recordFailurePattern`（结构化 failureType，无需文本反推）→ `getLessonsForPhase` 按相位注入 prompt → mustCheck 强制转化为可验证检查项；Hook 拒绝事件经 `session-stop.js:recordHookFailure` 沉淀；经验三级演化（lesson → pattern → instinct）+ harness-evolve 五步闭环把**自进化对象设为 harness 自身的规则**。

**判决**：成立。一个系统不仅用工程标准要求被开发的项目，还把自身暴露给同一标准的体检与治疗（evolve），这种自觉性罕见。

---

## 第三章 端到端流程审判

### 3.1 防线分布：前紧后松——⚠️ 记录在案，职责边界可辩护

| Phase | 本地防线强度 |
|-------|-------------|
| 0→1, 1→2, 2→3, 3→4, 4→5 | 硬门控（存在性 + Schema + 专属检查 + lint/可选编译） |
| 5→6, 6→7, 7→终态 | 仅产出物存在性 |

**指控**：全流程风险最高的不可逆操作（代码合并、云端部署）恰恰是本地防线最弱的环节。

**辩护**：GitLab MR 流程与 DevOps 云端构建本身就是外部质量系统（CI + 分支保护）；harness 的自我定位是**编排层**而非替代 CI。存在性检查确认「交付动作发生了」，质量把关交给外部系统，是职责边界而非缺陷。

**判决**：辩护成立，记录在案。若未来出现「MR 合了但内容错误逃过 Phase 5」类事故，此记录作为已知边界供追责参考。

### 3.2 返工半径经济学 —— 💤 已裁决封存（附一段定量说明）

用返工半径衡量 build 默认关闭的代价：本地拦截时错误暴露在 Phase 2→3 门控，返工半径 = fix-loop 回到 Phase 2（同相位）；云端暴露时在 Phase 7，返工半径跨 5 个相位（7→2），且每轮 fix-loop 若触发全量构建（上限 900s）将进一步放大。**经济学上该取舍成立的条件是：编译类错误发生率 × 跨相位返工成本 < 全量构建阻塞成本 × 触发频次。** 现有裁决选择了流程不阻塞优先，该条件检验交由实际运行数据（metrics-aggregator 的 phase 时长统计）完成，不再复审。

### 3.3 观测盲区：子 Agent tool_call 不入 trace —— ⚠️ 说明一次，封存

已知边界：Figma MCP 消费检查因此被移除，kb-query 检查因此降为 WARNING。该盲区源于架构（主 trace 只记主流程），修复需要跨层改造，收益有限。按既有处理方式：说明一次，接受已知边界不修。

### 3.4 fixbugs 模式的 Figma 豁免 —— ✅ 辩护成立

指控：fixbugs 不开设计稿硬门控，UI 修复无设计对齐校验。辩护：修复只碰个别页面，全量 frame 清单会卡死修复流程（设计文档明示理由）；且「有设计稿就该解析」的指引仍注入。判决：**边界经过计算而非疏忽**，成立。

### 3.5 run/fixbugs 模式派发链 —— ✅ 成立

`getStoryMode` 三级回退（story-input → e2e-state → 'run'）+ 无输入时原型要求保守为 true，fail-closed 贯穿模式判定。「fixbugs 漏加 --mode 会退回 run」的后果在 README 中明示——已知行为，有文档。

---

## 第四章 图谱定量证据的补充指控

### 4.1 state.js 单点 —— ⚠️ 接受监管，不判刑

7/10 God Nodes 出自单文件。这是 L2 单一信源原则的必然物理形态。缓解在案：`__tests__/` 六套回归测试 + harness-audit。**判：结构性风险，测试覆盖为监管条件。**

### 4.2 Schema 碎片化 —— ❌ 轻罪，可赎（文档级补救）

~90 个碎片社区 / 857 个弱连接节点。九大契约之间运行时靠 `validateContractReferences` 交叉校验，但**静态层零关联**——人导航困难，图谱聚合失败。判：轻罪。赎罪方式见第五章第 2 项（补一份契约关系索引文档，纯文档级改动）。

### 4.3 图谱 180 条悬空端点边 —— ⚠️ 工具层债务

跨块语义引用指向未创建的概念节点，属抽取管道的可修复损耗，非被审系统之罪。记录在案，修复属 graphify 层职责（占位节点补建）。

### 4.4 Dispatch 社区内聚度 0.050 —— ✅ 无罪释放

社区检测算法把「协作频繁」误读为「应拆分」。dispatch / advance-phase / prompt-builder 三文件高频协作正是三权分立的运行时表现，拆分反而违反 L3。无罪。

### 4.5 `validate-phase-gate.js`：活的假门控 —— ❌ 有罪，须按三步配套执行

> **⚠️ 更正记录（2026-09-04 复核）**：本节初版误判为「零调用的死代码、删除零运行时行为变更」。
> 全仓 grep 复核发现**两个活跃调用方**，且深入检查后定性升级——它不是惰性死代码，
> 而是**持有已废弃判定逻辑、仍在向 Agent 输出与权威门控相反结论的活体**。以下为修正后的事实与判决。

**呈堂证据（全部经代码复核）**：

1. **session-start.js 在调用它**（:52 `GATE_SCRIPT`、:60-79 `runGateValidation`、:240-242 每个活跃工作流执行一次）。会话启动时其结果以「门控验证通过/失败」注入 Agent 上下文。
2. **fixbugs-regression.test.js 在用它做预言机**（:69-76 `gate()` helper，4 处调用），其中 :129 断言「缺 Bug 报告 → 阻断」。
3. **权威路径没有这个检查**：`policy.js` 从不调用 `findBugAnalysisReports()`（grep 为空）；phase-0.md:28-33 明文：「Bug 分析报告没有门控……缺报告的实际后果是后续 Phase 拿不到 Bug 事实，而不是被门控挡住」。
4. **文档自相矛盾**：phase-0.md 要花一段 ⚠️ 辟谣「旧文档曾声称缺报告则拦截」；而 tapd-bug-analyzer/SKILL.md:282 仍把它当现行机制引用（「validate-phase-gate.js 会扫描标题行」）；services.md 自述「不在生效路径上」——对相位推进成立，但漏了 session-start 注入路径。

**矛盾后果**：fixbugs 模式缺 Bug 报告时，session-start 注入「❌ 门控验证失败」，而 advance-phase.js（policy.js）会放行——同一系统对 Agent 发出两个相反信号；回归测试则为废弃行为盖绿灯。

**判决**：按项目自己的标准——**展示信息保留，假装强制的删除**。session-start 注入的是废弃判定的结果，属误导性展示而非诚实展示；测试预言机指向废弃脚本，属验证错误对象。有罪，但执行须按以下顺序（直接 rm 会破坏 session-start 上下文注入与 4 条测试断言）。

---

## 第五章 量刑与执行清单

按改动量从小到大排序（最小改动优先原则）：

| # | 事项 | 级别 | 动作 |
|---|------|------|------|
| 1 | 清理 `validate-phase-gate.js`（三步配套，顺序不可颠倒） | ❌ 立即执行 | ① session-start.js 删 `GATE_SCRIPT`/`runGateValidation` 及 gateResult 展示段（其余注入源均保留）；② fixbugs-regression.test.js 预言机迁至 `policy.js:runGateCheck`，按文档行为断言「缺报告不阻断」——「越界标题扫描」若要保留则将该检查迁入 policy.js（warning 级），不要则删断言；③ 删文件 + 修 3 处文档（services.md ⚠️ 段、tapd-bug-analyzer/SKILL.md:282、phase-0.md:32 简化）+ state.js :18/:626 两处注释 |
| 2 | 补 Schema 契约关系索引 | 赎罪 | 纯文档：在 `schemas/` 或 references 加一份契约关系说明（AC↔task-dag↔verification 的引用图），改善人导航与图谱聚合 |
| 3 | Phase 5-7 产出物轻量 schema 化（可选） | 自愿 | 复用现有 SCHEMA_MAP 模式给 MR URL / 构建号 / 部署 URL 加格式校验——复用既有机制，非新机制 |
| 4 | 落地后运行 `graphify update .` | 收尾 | 保持图谱与代码同步（AST-only，无 API 成本） |
| 5 | 子 Agent trace 盲区 / build 默认值 / Dispatch 不拆分 | 💤 封存 | 已有裁决记录，不再复审 |

---

## 终审判决

### 评分表

| 端到端工程化判据 | 得分 | 裁决 |
|------------------|------|------|
| 状态一致性（L1/L2/L3） | 9.5 | ✅ 三道防线 + 单一信源 + 独立裁定，宣称与实现零偏差 |
| 失败预算（L7） | 9.0 | ✅ 有界修复回路 + 未知失败也纳入预算管理 |
| 可进化性（L8） | 9.0 | ✅ 经验飞轮 + evolve 把自身开放给同一标准 |
| 诚实性（L5） | 9.0 | ✅ 连自己的预检都不轻信（对账补记） |
| 权责分离（人机分工） | 9.0 | ✅ blocked→人工的出口设计 + dev-pass 权限最小化 |
| 端到端闭环完整性 | 8.5 | ✅ 摄取→部署→知识更新→经验回注，全环闭合 |
| 复杂度预算 | 8.0 | ⚠️ Schema 碎片化 + state.js 单点（后者属原则的必然代价） |
| 流程经济学 | 8.0 | ⚠️ build 后移的返工半径（已裁决封存）+ 前紧后松防线（可辩护） |
| 可观测性 | 7.5 | ⚠️ 主链路 trace 完整，但子 Agent 盲区（已封存） |
| **综合** | **8.7 / 10** | **主架构无罪，一项立即执行，两项缓刑封存** |

### 总评

这个系统最值得肯定的不是任何单一机制，而是**宣称与实现的零偏差**：八条自称的原则在代码层全部可验证，两处例外（fail-open）都有书面理由——在 AI Agent 工程这个「PPT 架构」重灾区，这种言行一致本身就是最高级的工程化。

端到端视角的最终判词：harness 把「端到端」理解为**闭环而非直线**——不止 intake 到 deploy 的 8 个相位，还包括知识更新（Phase 6）与经验回注（experience + evolve）构成的学习回路。多数流水线止步于直线，它做成了环。

需要执行的只有一件事：按三步配套清理 `validate-phase-gate.js`——**它比死代码更糟：死代码是惰性的，它是一个仍在向 Agent 输出过时判定的活体假门控，还有一套测试为它背书。用被审系统自己的标准判的刑，它没有辩护余地。**

> **复核更正**：初版终审判决称该文件「零调用、删除零运行时行为变更」，经代码复核不成立
>（session-start.js 与 fixbugs-regression.test.js 两个活跃调用方），已按上表三步配套方案修正。
> 结论方向不变（清理），但删除前必须先拆除两个调用方，否则会破坏会话恢复注入与回归测试。

---

*审判依据：知识图谱 v2（`graphify-out/graph.json`，2026-09-04 构建）· 技术分析卷宗（`docs/ARCHITECTURE_架构技术分析.md`）· 17 份核心文档*
