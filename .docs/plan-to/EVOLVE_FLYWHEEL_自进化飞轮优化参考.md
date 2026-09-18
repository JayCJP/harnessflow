# 自进化飞轮（`/evolve`）优化参考

> **目标**：把本项目 `/evolve` 自进化 skill 的现状摊开，与《一篇讲透 Agent 自进化飞轮怎么搭》(腾讯技术工程, 2026-08-26) 的四齿轮模型对照，沉淀出「信号 / 记忆 / 落地 / 控制」四个齿轮及「飞轮咬合」的差距清单与优化方向。
> **约束**：本文为**参考读物**，不改任何代码。优化清单只列方向（改什么、为什么、落到哪、改动量、风险），不含实现细节与伪代码。
> **状态**：调研稿（未实现）。事实部分均带 `file:line` 或命令取证，代码可能随迭代变动，引用前请复核。
> **前置**：本文 §1.2 的三条实证结论来自 2026-09-18 的一次 `/evolve` 实跑与 `git` 取证，属**确定性事实**，优先于任何设计推论。

---

## 〇、结论摘要

本项目 `/evolve` 已具备「体检 → 度量 → 诊断 → 治疗 → 验证」五步骨架，四齿轮的**组件**基本齐备，
但**齿轮之间的箭头是断的** —— 用文章的话说：「问题不在任何单个环节，而在环节之间的衔接」。

三条实测断点（按严重度）：

| 优先级 | 断点 | 影响 | 改动量 |
|--------|------|------|--------|
| **P0** | 运行期经验库被纳入 git 版本控制 | `getLessonsForPhase()` 恒返回空串，**历史教训注入通道实际是死的**；本地积累的记忆会被任意 git 操作覆盖 | 小（`.gitignore` + `git rm --cached`） |
| **P0** | 通路 ④（生效 → 下一轮评测）无落盘目标 | 提案采纳后无法复评，`/evolve` 退化为「一次性体检」而非飞轮 | 小（建 `experience/proposals/` + 快照对比） |
| **P1** | 陈旧洞察无退役 / 降权路径 | 库中至少 3 条洞察与当前度量**直接矛盾**，仍在持续注入 prompt | 中（`experience.js` 两个函数 + 注入过滤） |

**如果只做一件事**：做第一条（经验库移出 git）。它成本最低、证据最硬，且是其它一切优化的前提 ——
记忆存不住时，讨论「记忆治理」没有意义。

**元原则（来自文章，本文所有建议都服从它）**：
① 评测的可信度 > 系统的复杂度；② 记忆是治理问题不是存储问题；③ 闭环价值在于环节之间的衔接。

---

## 一、文章框架 × 本项目现状对照

### 1.1 四齿轮映射

| 文章齿轮 | 文章要点 | 本项目落点 | 现状评价 |
|---|---|---|---|
| ① 信号（评测） | 三重职责（方向/门控/筛选）、评测集三分法、终点是归因分流、评估器本身要被评测、Skill 四层验证 | `audit/harness-audit.js`、`audit/metrics-aggregator.js` | **部分失真**：指标口径把非失败计为失败；无固定验证集；无评估器自评 |
| ② 积累（记忆） | 治理而非存储、非对称淘汰(+0.05/-0.12)、分层 L0-L3、渐进披露 + Token 预算、冲突解决、时效衰减 | `services/experience.js`、`experience/failure-patterns.json`、`metrics-insights.json` | **最薄弱**：只进不出、无退役、无淘汰、无来源标记、静默覆盖对策 |
| ③ 落地（工程化） | 八环节链路、三路信号汇聚、五层安全门控、灰度 + 自动回滚、版本化一切、Diff 模式、Dreaming | `skills/evolve/SKILL.md` Step 3/4 | **仅具形态**：有诊断→提案，无门控分层、无版本化、无回流 |
| ④ 控制（人机协作） | 教练非操作者、分级自主、五个人工节点、审核疲劳三层解法、对齐漂移三层防护 | `skills/evolve/SKILL.md` 的「不自动改文件」 | **近乎空白**：无分级自主、无红线清单、无审核疲劳对策、无漂移防护 |
| 咬合 | 四条数据通路 | 见 §三 | 通路 ① ✅ / ② ⚠️ 手动 / ③ ⚠️ / ④ ❌ |
| `skills/evolve/` | 五步闭环骨架（体检→度量→诊断→治疗→验证） | `skills/evolve/SKILL.md`（60 行） | 骨架正确，但缺「衔接」与「治理」层 |

### 1.2 三条实测断点（确定性证据）

#### 断点 1 · 运行期经验库被 git 跟踪，记忆被提交覆盖清空

| 观测 | 值 | 取证方式 |
|------|-----|---------|
| `.gitignore` | **无 `experience` 任何条目** | `Get-Content .gitignore` |
| `failure-patterns.json` / `metrics-insights.json` | **均被跟踪** | `git ls-files plugins/harness/scripts/experience/` |
| 当前 HEAD 版本 | `{"patterns": [], "version": "2.1", ...}` —— **空库** | `git show HEAD:...failure-patterns.json` |
| 提交历史大小震荡 | `81 → 6630 → 81 → 7987 → 6482 → 1324 → … → 81` | `git log` 逐版本统计字符数 |
| 历史提交信息 | 含 `chore(harness): 清空失效模式记录`、`chore(harness): 更新经验库失败模式与指标洞察数据` | `git log --oneline` |

**结论**：运行期**可变数据**被当作**配置**管理，导致本地积累的经验反复被 commit / checkout 覆盖。
`experience.js:49` 的 `EXPERIENCE_DIR` 指向 `plugins/harness/scripts/experience`（在仓库内），
因此写入的每一条 `recordFailurePattern` 都处在「下一次 git 操作即可能丢失」的状态。

**连带后果**：`getLessonsForPhase()`（`experience.js:167`）读到空库 → 恒返回 `''` →
`prompt-builder.js:735` 注入的「历史教训」段永远为空。**注入通道形同虚设，但流程自述为「已有」。**

#### 断点 2 · 通路 ④（回流登记）无落盘目标

- `experience/proposals/` 在取证时**不存在**（截至本文成稿为「存在但为空」）；`experience/failures/` 存在但为空（0 文件）。
- 即：**飞轮最后一颗螺丝（生效 → 下一轮评测）从未拧上**，提案采纳与否都无留档、无复评。

#### 断点 3 · 陈旧洞察持续注入

`mergeInsightsToGlobal`（`experience.js:404-459`）**只有 upsert 分支，没有退役 / 降权路径**；
`getMetricsInsights`（`experience.js:469`）只按 `targetPhase` 取 Top-N，**不过滤陈旧**。实测库中至少 3 条与当前度量直接矛盾：

| 洞察 | 库中 evidence | 当前度量 | 判定 |
|---|---|---|---|
| `INSIGHT-kb-not-consumed` | `kb 检索 0 次` | `kbCalls = 13`（kb-query 7 + graphify 6） | **直接矛盾** |
| `INSIGHT-fix-loop-success` | `首轮成功率 50%` | `fixLoopSuccessRate = 1` | **直接矛盾** |
| `INSIGHT-bottleneck-p1/p4/p6` | `2 个 Story: avg=21/28/91min` | 样本扩至 5 个 Story，Phase 1 avg≈4min（低于 20min 阈值） | 样本漂移 |

**双向危害**：既注入**被证伪的教训**（错误归因），又因无退役而**永久霸占注入窗口**（挤出真正有效的教训）。

---

## 二、四齿轮优化清单

> 每条含：**改什么 / 为什么 / 落到哪 / 改动量 / 风险**。

### 2.1 齿轮① 信号（评测）

| # | 改什么 | 为什么 | 落到哪 | 改动量 | 风险 |
|---|---|---|---|---|---|
| 1 | **指标口径失真修正**（不改判定，只加诊断计数） | `metrics-aggregator.js:168-175` 把「信息性 warning」与「fix-loop 设计性重跑」都算作门控未一次通过；实跑中一个无任何 blocker 失败的 Story 贡献了 2 次「非一次通过」 | `audit/metrics-aggregator.js` | 小 | 低（**明令不改** `pass/fail` 判定与 `THRESHOLDS`） |
| 2 | **反事实校验入协议** | 指标改善未必是真改善。已实证漂移：bottleneck 洞察消失是因样本从 2 扩到 5 个 Story | `skills/evolve/SKILL.md` Step 1 后 | 小 | 无（纯文档） |
| 3 | **固定验证集（test 集）** | 文章要求 train/val/test 严格分离；本项目 Step 4 的「模拟验证」不可信 | 新增 `experience/regression-set.json` | 中 | 低 |
| 4 | **元评测（评估器自评）** | 评测器本身也需要被评测，否则在错误信号上做优化 | 新增（或复用 `regression-set`） | 中 | 低 |
| 5 | **阈值外置** | `THRESHOLDS`（`metrics-aggregator.js:65-70`）硬编码，阈值本身也应是被治理对象 | → `experience/thresholds.json` | 小 | 低 |

**校验规则（建议写进 skill）**：
- **漂移校验** —— 指标改善是否来自「新 Story 任务类型变了 / 变简单了」？（对比 AC 数、task 数、Phase 计数）
- **门槛校验** —— 指标改善是否来自「门控被放宽了」？**这是自进化系统最隐蔽的自欺，必须每次做。**

### 2.2 齿轮② 记忆（积累）—— 本项目最薄弱齿轮

| # | 改什么 | 为什么 | 落到哪 | 改动量 | 风险 |
|---|---|---|---|---|---|
| 6 | **运行期经验库移出 git**（P0） | 见 §1.2 断点 1。`git rm --cached` 与 `.gitignore` **缺一不可**：只加 ignore 则 git 仍覆盖已跟踪文件；只 `rm --cached` 则下次提交又入库 | `.gitignore` + `git rm --cached` | 小 | 低 |
| 6b | （更彻底备选）经验库根目录迁出仓库 | 单点改动 `experience.js:49` 的 `EXPERIENCE_DIR` → `~/.codebuddy/experience/`；顺带修正 `metrics-aggregator.js:485` 那句输出与实际路径不符的提示 | `services/experience.js`、`audit/metrics-aggregator.js` | 小 | 中（影响安装快照与多项目共享语义） |
| 7 | **陈旧洞察退役 / 降权**（P1） | 见 §1.2 断点 3。需新增「本轮未再生成 → 标 `stale`（留档不删）」+ 注入侧过滤 | `experience.js` 的 `mergeInsightsToGlobal` / `getMetricsInsights` | 中 | 中（口径变更需与既有洞察对齐） |
| 7b | （止血版）修正 `kb_not_consumed` 触发条件 | 其触发条件是 `ru.kbCalls === 0`（`metrics-aggregator.js:378`），在**多 Story 聚合**口径下语义已失效 —— 单个 Story 为 0 会被聚合总量掩盖 | `audit/metrics-aggregator.js` | 小 | 低 |
| 8 | **非对称淘汰** | 文章实测：好经验强化 `+0.05`、坏经验淘汰 `-0.12`（淘汰是强化的 **2.4 倍**）。当前 `occurrences` 只增不减，**不能复用为淘汰依据**，须引入独立 `score` | `experience.js` 读写两侧 | 中 | 中（需定义衰减与归档规则） |
| 9 | **对策变更走 supersede** | `experience.js:129` 现为 `resolution = pattern.resolution` **静默覆盖**；同一 `failureType + rootCauseKey` 出现不同对策时，历史无从追溯，「新对策是否更好」无法判断 | `experience.js` | 小 | 低 |
| 10 | **注入 Token 预算（替代条数）** | 现为 `maxItems = 5 / 3`（`experience.js:167` / `:469`）。**条数限制 ≠ 体积限制** —— 一条 2000 字根因与一条 20 字的同样占一个名额 | `experience.js` | 小 | 低 |
| 11 | **来源标记（防上下文投毒）** | 错误记忆蔓延快于修复。每条需带 `source: gate / hook / evolve`；**`evolve` 来源未过门控前不得进注入池** | `experience.js` 写入侧 | 小 | 低 |
| 12 | **分层晋升落盘** | `evolutionLevel` 的 `lesson / pattern / instinct` 目前只是 `SKILL.md` 里的名词，无持久化字段 | `failure-patterns.json` 结构 | 中 | 低 |

**注入侧既有约束（勿破坏）**：`getLessonsForPhase` 的「读取侧归并同类项」（v3.1）与「写入侧按根因分条留档」是**有意为之的双口径**，
原因是模板化根因（消息里嵌绝对路径 / 文件名）每换一个文件就新开一条、`occurrences` 极高，会稳定霸占 Top N。
**归并只能在读取侧做。**

### 2.3 齿轮③ 落地（工程化）

| # | 改什么 | 为什么 | 落到哪 | 改动量 | 风险 |
|---|---|---|---|---|---|
| 13 | **通路 ④ 回流登记**（P0） | 见 §1.2 断点 2。提案 + **基线指标快照**落盘；下轮对比，劣化即标 `regression` 候选并优先回滚 | 新增 `experience/proposals/` + 落盘约定 | 中小 | 低 |
| 13b | **入库归属澄清**（关键） | **`proposals/` 属版本化留档（要入库）**，而 `failure-patterns.json` / `metrics-insights.json` 属运行期可变数据（**不入库**）—— 两者语义相反，不可混在同一 ignore 规则里 | `.gitignore` | 小 | 低（与 #6 联动，须一并定稿） |
| 14 | **五层安全门控脚本化** | L1 语法 → L2 回归冲突 → L3 证据充分性（≥2 Story，否则降级 `lesson`）→ L4 红线一致性 → L5 人工。前四层自动过滤低质变体，是对抗审核疲劳的第一层 | 新增 `audit/proposal-gate.js` | 中 | 中 |
| 15 | **三路信号汇聚** | 现只有「本轮诊断 + 历史 Playbook」，缺**外部知识**。平台期（连续 2 轮提案无效）必须引入 `kb-query` / `graphify` 外部参照，否则在旧知识里循环 | `SKILL.md` + 取证流程 | 小 | 低 |
| 16 | **Dreaming 异步通道** | 同步评测 = 「每次作业批改」，Dreaming = 「期中总结」。跨会话找慢变量（反复失败模式 / 低效模式 / 知识缺口） | 新增 `--dream` + automation | 中大 | 中 |
| 17 | **Diff 模式约束** | 提案必须是最小 `old_str → new_str`；多文件联动需附引用校验。判据：**人 30 秒读不完就是太大** | `SKILL.md` Step 3 | 小 | 无（纯文档） |

### 2.4 齿轮④ 控制（人机协作）

| # | 改什么 | 为什么 | 落到哪 | 改动量 | 风险 |
|---|---|---|---|---|---|
| 18 | **不可逆红线清单**（P0） | 五条**永久人工且永不作优化目标**：门控核心判定 / 状态机写权限 / hook 安全拦截 / AC 必查项完整度 / **任何降低校验强度的改动** | `SKILL.md` Step 3 | 小 | 无（纯文档） |
| 19 | **分级自主模型** | A0 建议 → A1 记忆自动 → A2 低危自动 → A3 流程自动，含升降级条件。**关键约束：回流能力（#13）未就位前，等级上限锁 A1** —— 无法检测回归时放权等于盲目加速 | `SKILL.md` | 小 | 无（纯文档） |
| 20 | **审核疲劳三层解法** | L1 门控自动过滤 → L2 报告改**选择题**（推荐结论 + 证据 + 备选）→ L3 渐进放权 + 回归自动降级。**报告条数上限 ≤5 本身就是一项控制机制** | `SKILL.md` 输出格式 | 小 | 无 |
| 21 | **对齐漂移三层防护**（P0） | ① 定期方向性审计（不看「有没有变好」，看「还在做正确的事吗」）② 方向性约束指标 ③ 决策显式回答「更接近目标 vs 数字更好看」 | `SKILL.md` + 指标表 | 小 | 无 |
| 22 | **五个人工节点显式化** | 规则级记忆写入前 / prompt-skill 更新确认 / 回归决策 / 冷启动种子 / 安全边界调整 | `SKILL.md` | 小 | 无 |

**方向性约束指标（红线指标，不可作为「提升」目标）**：

| 指标 | 约束方向 | 危险信号 |
|---|---|---|
| `gateFirstTryRate` | **不应被优化**，仅作健康度观察 | 持续上升且 `blockerCount` 同步下降 |
| `blockerCount` | 不应趋零（趋零说明门控失效或任务变简单） | 连续 3 轮为 0 |
| AC 数 / task 数 | 不应下降 | 新 Story 的 AC 显著少于历史均值 |
| 注入 token 体积 | 不应膨胀 | 教训注满 5 条且单条超长 |
| 平均改动文件数 | 不应超出 `task-dag.json` 声明范围 | `scope-amendments.json` 的 `outOfScope` 频发 |

---

## 三、飞轮咬合：四条数据通路

| # | 通路 | 本项目落点 | 状态 |
|---|---|---|---|
| 1 | 评测 → 记忆 | `metrics-aggregator.js` → `experience.mergeInsightsToGlobal()`；`recordFailurePattern()` | ✅ 已有（自动），但**结果是死路**（§1.2 断点 1） |
| 2 | 评测 → 落地 | Step 2 归因分流 → Step 3 提案 | ⚠️ 需 `/evolve` 手动触发 |
| 3 | 落地 → 控制 → 生效 | Step 3 门控 → Step 4 人工裁决 → 用户确认后执行 | ⚠️ 仅人工层具备 |
| 4 | **生效 → 下一轮评测（回流）** | `experience/proposals/` 版本化 + 下轮复评 | ❌ **待补（飞轮断点）** |

> 文章原话：「大多数团队的问题：每个组件内部做得还行，但组件之间的**箭头**没有自动化。」
> 本项目正是此形态 —— 通路 ① 自动了，但终点是死的；通路 ④ 根本不存在。

### 归因分流（Step 2 的核心产出，建议显式化）

```
问题 ─┬─ 跨 Story 复现且与输入无关 ────────→ systemic   → 改 Skill/Agent/policy（Step 3）
      ├─ 单次、绑定特定环境/输入 ──────────→ sporadic   → 只写记忆（不改流程）
      ├─ 缺工具/脚本/数据，非「做错」──────→ capability → 补工具（禁止用 prompt 弥补）
      └─ 本轮引入、此前更优 ──────────────→ regression → 立即回滚（跳过 Step 3）
```

**血泪教训（文章实证，建议写进 skill）**：连续 3 轮失败率 80%+ 不下降时，
应**先查工具实现层**（API 参数错误等），而非继续在 prompt / 配置层打转。
失败率「高位横盘」几乎总是 `capability` 类，不是 `systemic`。

---

## 四、落地顺序建议

| 阶段 | 内容 | 理由 |
|---|---|---|
| **Phase 1 · 最小闭环** | #6 经验库移出 git → #13 proposals 落盘 → #18/#21 红线与漂移防护写进 skill | 先让「记忆能存住、飞轮能回正」。这是唯一的前置条件 |
| **Phase 2 · 记忆治理** | #7 陈旧洞察退役 → #8 非对称淘汰 → #9 supersede → #17 Diff 约束 → #19/#20 分级与审核 | 记忆是当前最大短板，且改动集中在 `experience.js` 单文件 |
| **Phase 3 · 可信评测** | #1 口径修正 → #3 固定验证集 → #10 Token 预算 → #11 来源标记 → #14 门控脚本化 | 补齐「评测可信度 > 系统复杂度」的元原则 |
| **Phase 4 · 飞轮持续** | #15 三路信号 → #16 Dreaming → #5 阈值外置 → #4 元评测 | 长期演进，可延后 |

---

## 五、明确不建议做的事

按文章「一个能手动转一圈的粗糙飞轮，好过一个精美但静止的蓝图」，以下暂缓：

- ❌ **不上 L0-L3 完整分层** —— 本项目 L0 就是 `trace.jsonl`，靠 `debug-replay.js` 按需钻取已够。
- ❌ **不做 Auto-Research 自动引入外部知识** —— 第 3 路信号先手工触发即可。
- ❌ **不做 10% 流量灰度** —— Harness 改动是全局的，没有可分桶的流量；**按 Story 灰度**足够。
- ❌ **不为提升 `gateFirstTryRate` 动任何门控** —— 这是本项目最可能发生的对齐漂移。
- ❌ **不用 prompt 弥补能力缺失** —— `capability` 类问题改工具 / 脚本。

---

## 六、待决议项

| # | 事项 | 备选 |
|---|---|---|
| 1 | `plugins/harness/scripts/experience/proposals/` 目前**存在但为空**（上一轮 `/evolve` 的 `EVO-2026-09-18-01.md` / `.baseline.json` 已被清理） | 维持现状 / 恢复该轮产出 |
| 2 | P0 三项（#6 / #13 / #18+#21）是否立即实施 | 立即实施 / 先过方案 |
| 3 | 经验库归属：#6 的 `.gitignore` 方案，还是 #6b 的「迁出仓库」方案 | 前者轻、后者彻底 |

---

## 附：证据索引

| 结论 | 取证命令 / 位置 |
|---|---|
| 经验库被跟踪 | `git ls-files plugins/harness/scripts/experience/` |
| `.gitignore` 无 experience 条目 | `Get-Content .gitignore` |
| 经验库大小震荡（26 次提交） | `git log --format="%h %ad" --date=short -- .../failure-patterns.json` + 逐版本字符数统计 |
| HEAD 为空库 | `git show HEAD:plugins/harness/scripts/experience/failure-patterns.json` |
| `EXPERIENCE_DIR` 指向仓库内 | `services/experience.js:49` |
| 教训读取入口（恒空） | `services/experience.js:167-221`；注入点 `services/prompt-builder.js:735` |
| 洞察合并无退役分支 | `services/experience.js:404-459` |
| 洞察注入不过滤陈旧 | `services/experience.js:469-487` |
| 对策静默覆盖 | `services/experience.js:129` |
| 门控一次通过率口径 | `audit/metrics-aggregator.js:168-175` |
| `kb_not_consumed` 触发条件 | `audit/metrics-aggregator.js:378` |
| 阈值常量 | `audit/metrics-aggregator.js:65-70` |
| 输出路径与实际不符 | `audit/metrics-aggregator.js:485` |
| `proposals/` 此前不存在、`failures/` 为空 | 目录枚举 |
| 参考文章 | 《一篇讲透 Agent 自进化飞轮怎么搭：评测→记忆→落地→控制》腾讯技术工程，2026-08-26 |
