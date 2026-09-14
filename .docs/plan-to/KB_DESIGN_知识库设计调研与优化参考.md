# 知识库（KB）设计调研与优化参考

> **目标**：把本项目知识库的现状摊开，与业界三个有代表性的方案对照，沉淀出「沉淀 / 更新 / 利用 / 注入 / 淘汰」五个维度的差距清单与优化方向，供后续决策参考。
> **约束**：本文为**参考读物**，不改任何代码。优化清单只列方向（改什么、为什么、落到哪、改动量、风险），不含实现细节与伪代码。
> **状态**：调研稿（未实现）。事实部分均带 file:line，代码可能随迭代变动，引用前请复核。

---

## 〇、结论摘要

本项目知识库在「沉淀 / 更新 / 利用 / 注入」四维已具备完整闭环（kb-init → gen-project-docs → kb-update → kb-query → agentPrompt 路径注入），
但**第五维「淘汰」基本缺失** —— 只有「hash 不等就报告一下」，没有时序有效性、没有覆盖语义、没有衰减、没有删除。

对照业界共识（记忆是**有生命周期的系统**，不是 append-only 存储），三个短板按优先级：

| 优先级 | 短板 | 影响 | 改动量 |
|--------|------|------|--------|
| P1 | 淘汰机制缺失（无 valid-to / supersede / 过期标记） | Agent 会**自信地复用过期事实**，且无从判断文档哪句还算数 | 中（kb-update Step 2/3 + meta.yaml 字段 + kb-query L2 判据） |
| P2 | 检索只有「域级关键词 + 图谱」两路，无向量语义路 | 换个说法的问题召回率低；缺 RRF 融合与结果去重 | 中大（引入 embedding 与索引） |
| P3 | 无评估闭环（无 ground truth 集） | 无法回答「kb-query 到底准不准」，kb-update 成功率也无度量 | 小（先建 golden set 跑 recall@K） |

**如果只做一件事**：做 P1。它是唯一直接影响「Agent 会不会用错信息」的缺陷，且改动可控、不动 Agent 间的契约。

---

## 一、本项目知识库现状

### 1.1 五个维度的实现现状

| 维度 | 实现 | 关键位置 | 评价 |
|------|------|---------|------|
| **沉淀** | kb-init 建骨架 + 项目画像 + meta.yaml；gen-project-docs 扫源码生成文档；Phase 0 的 prototype-analysis.md 迁入 design/ | `skills/kb-init/kb-init.cjs`、`skills/gen-project-docs/gen-docs.cjs`、`skills/kb-update/SKILL.md:85-105` | 完整，但「什么值得沉淀」无门槛 |
| **更新** | kb-update.cjs 读 meta.yaml 的 git.hash 作基线 → git diff → matchFileToDomain 映射受影响域 → AI 增量改文档 | `skills/kb-update/kb-update.cjs`、`skills/kb-update/SKILL.md:69` | 完整，粒度为「域」 |
| **利用** | kb-query 四层检索（L1 overview 域地图 → L2 meta.yaml → L3 按模式加载 → L4 search_content 兜底）+ 4 种模式 + 双源交叉验证（∥ graphify） | `skills/kb-query/SKILL.md:36-65` | 完整，但无双源融合打分 |
| **注入** | prompt 只给「用法约束 + 各仓路径」，不内联知识库正文 | `services/prompt-builder.js:104`、`:537-584` | 符合成本原则 |
| **淘汰** | `gen-docs.cjs --stale` 只输出 `{ stale, changedCount }`；Phase 6 `evidenceKbRefresh` 只陈述 hash 不一致 | `skills/gen-project-docs/gen-docs.cjs:65-73`、`services/context-refresh.js:432-464` | **缺失**，只有检测没有处置 |

### 1.2 目录结构与文档体系

知识库根为 `.docs/llm-knowledge/`（v2 去掉旧的 `frontend/` 硬编码层，`kb-init.cjs:27`）：

```
.docs/llm-knowledge/
├── .profile.yaml          # 项目画像（project_type / source_root / domain_axis）
├── overview.md            # 全局总览 + 域地图（L1 检索入口）
├── meta.yaml              # 域索引（domains[] / git.hash / doc_stats）
├── common/                # 跨域通用切面（编码规范等）
├── templates/             # 模板副本
└── business/<domain>/     # 各业务域文档
    ├── overview.md / architecture.md / config.md / pitfalls.md / log.md
    ├── <项目类型特有切面>  # pages/api/store 等，由 project_type 决定
    └── custom/README.md   # 人工批注区（CUSTOM:START/END）
```

文档类型**不固定 8 类**，由 `.profile.yaml` 的 `project_type` 动态决定（`gen-project-docs/SKILL.md:42-57`）：

- 通用 5 类（overview / architecture / config / pitfalls / log）所有类型都生成
- 特有切面：frontend→pages/api/store；plugin→entry-files/commands/schemas；backend→routes/api/models；library→public-api/usage

### 1.3 检索机制（kb-query 四层）

| 层 | 动作 | 依据 |
|----|------|------|
| L1 | 读 overview.md 域地图，关键词匹配收敛到 1~2 个域 | `kb-query/SKILL.md:38-44` |
| L2 | 读 meta.yaml，按域取 `entry_files` / `files` / `stores` / `apis` 等字段 | `kb-query/SKILL.md:46-51` |
| L3 | 按 4 种模式加载文档正文（A 需求拆解 / B 技术方案 / C 接口搜索 / D 知识问答） | `kb-query/SKILL.md:53-60` |
| L4 | `search_content` / `search_file` 兜底 | `kb-query/SKILL.md:62-65` |

核心设计是**双源交叉验证**（`kb-query/SKILL.md:13-32`）：kb-query（业务语义层）∥ graphify（结构层）。
收敛规则：两者指向同一文件=最高置信度；仅一路命中=另一路补查；两边冲突=以源码为准并标注知识库过期。

### 1.4 增量更新链路

脚本部分（`kb-update.cjs`）：
1. `git rev-parse HEAD` 取当前 hash → 与 meta.yaml 的 `git.hash` 作基线
2. `git diff --name-only lastHash..currentHash` 取变更文件
3. 遍历 meta.yaml 所有域，`matchFileToDomain`（前缀匹配 + 去 `*` 通配）映射受影响域
4. 扫描 `.codebuddy/plans/*/prototype-analysis.md`，输出待迁移的原型文档

AI 部分（`kb-update/SKILL.md:71-105`）：
1. 保留 `CUSTOM:START/END` 手工批注，增量改文档
2. 刷新 meta.yaml 的 `git.hash` / `doc_stats`，追加 log.md
3. 把原型文档迁入 `business/<domain>/design/`，并写 `design_docs` 索引

### 1.5 与工作流的衔接

**写入**只有一个点：Phase 5 知识库更新，由 release-assistant 调 `use_skill("kb-update")`。
注意该 Phase **无门控**、产出物校验为空（`lib/phases.js:58,95,138-141`）—— 即更新失败不会阻断流程，
`kb-update/SKILL.md:121-126` 的容错策略正是「更新失败不阻断后续流程、下次增量自动补齐」。

**读取**覆盖 Phase 0 / 1 / 2 / 3（需求分析、任务规划、代码开发、代码审查）。
注入方式：`prompt-builder.js:104` 写死一条约束「必须 kb-query + graphify 双源交叉验证」；
`:537-584` 的 `buildRepoSearchEntries` 在 Phase 0/1/2 注入各仓绝对路径与图谱实测状态。
graphify 未建时降级为 `kb-query + Grep`。

---

## 二、业界方案拆解

### 2.1 agentmemory：把记忆做成工程系统

链路：`开发事件 → Hook 捕获 → 隐私清洗 → 压缩成 observation → BM25/Vector/Graph 检索 → 按 token budget 注入 → 访问记录 / 版本覆盖 / 反思 / 遗忘`

| 环节 | 做法 | 对本项目的启示 |
|------|------|---------------|
| 捕获 | Hook 自动监听 session_start / prompt_submit / pre-post_tool_use / post_tool_failure / stop 等；落库前**去重**（避免反复读同一文件的噪音） | 本项目靠「Phase 5 一次性批量更新」，粒度粗、时效滞后 |
| 压缩 | observation 结构化字段：`facts` / `concepts` / `files` / `narrative` / `importance(1-10)`。其中 `files` 保留精确路径（代码场景里路径比模糊总结更有价值） | 本项目文档是「模块文档」而非「事件流」，但 `files` 显式化、`importance` 分级可借鉴 |
| 检索 | 三路融合，RRF 打分：`BM25 0.4 + Vector 0.6 + Graph 0.3`，缺路时权重重新归一化。另有 **session diversify**（每会话最多回 3 条，防止同一段历史的碎片刷满结果） | 本项目只有「域级关键词 + 图谱」，无向量路、无 RRF、无结果去重 |
| 分层 | 三类：① 可检索记忆（observations/memories）② **强制注入记忆（pinned slots）**：用户偏好 / 工具禁令 / 项目硬约束，每轮必带 ③ 高阶抽象记忆（reflect 产出的 insight） | 第 ② 类对应本项目的 AGENT_CONSTRAINTS，但缺「项目级 pinned」；第 ③ 类本项目完全缺失 |
| 写策略 | 写入前用 **Jaccard 相似度 > 0.7** 判「新记忆覆盖旧记忆」，形成**版本链**：旧 `isLatest=false`，新 `version+1` / `parentId` / `supersedes=[old.id]` | 本项目是「就地覆盖或残留」，无版本链、无覆盖关系 |
| 遗忘 | insight 重复出现则 `reinforcements++`、confidence 升；长期未强化由 `insight-decay-sweep` 按周衰减 confidence，低到阈值且从未强化过 → **soft delete** | 本项目零衰减机制 |

成效数据：tokens/query 从 22,610（CLAUDE.md + grep）降到 3,142；BM25-only R@5 86.2%，加向量后 95.2%。

### 2.2 Atlan 五层架构：生产级知识库的治理要求

五层：**摄取 → 混合检索 → 重排 → 评估 → 语义层**。

| 层 | 关键要求 |
|----|---------|
| 摄取 | 四阶段（提取/清洗/分块/增强）。**在索引前（而非索引后）标记过期、草稿、冲突文档**；每 chunk 带 `last_modified` + `freshness_threshold_days` |
| 检索 | 向量 + 稀疏（BM25/SPLADE）混合，RRF 融合（相比单一方法提升 15~30% 准确率）；cross-encoder 重排；访问控制元数据在**查询时**过滤 |
| 语义层 | 结构化业务上下文**不走向量检索**（精确查找）。受治理定义带 `owner` / `certification_date` / `deprecated_versions` / `freshness_signal` |
| 评估 | ground truth 集（≥50 条 query-doc 对）；检索质量（precision@K / recall@K / MRR）与答案质量（LLM-as-judge + 人工）**分开度量**；部署阈值前置 |

核心洞察一句话：**相似性 ≠ 正确性** —— Agent 可能检索到与查询高度相关但内容已过期的文本。

### 2.3 AppScale 失效架构：三种衰减模式与对策

| 衰减模式 | 现象 | 对策 |
|---------|------|------|
| **Context rot** | 塞的 token 越多，找到正确事实的能力反而下降 | 精选少数相关，而非累积全部 |
| **Memory staleness** | 存储的事实变了但旧记忆没失效，被自信地复用 | **时序有效性 + 覆盖** |
| **无界增长** | 记忆无限膨胀，噪音淹没信号，检索变慢 | 遗忘策略（合并、按龄与相关性衰减、剪枝） |
| Identity bleed | 跨用户/会话记忆串味 | 作用域分区 + 召回前校验 |

**时序有效性（本项目最缺的一条）**：把每条记忆当作「**有生命周期的断言**」，带 `valid-from` / `valid-to`。
事实变化时**不是新增而是 supersede**（设旧记忆 `valid-to`、链到新版本），保证检索不会把过期断言当现行。
配套还需：**写策略**（不是每条观察都值得成为长期记忆）与**遗忘策略**（合并、衰减、剪枝）。

成熟度路径 Stage 0 → 4：

| Stage | 特征 |
|-------|------|
| 0 | append-only 向量库，写一切、按相似度召回；演示惊艳，随事实变化静默劣化 |
| 1 | 记忆带元数据（来源 / 时间戳 / 作用域），检索按作用域与新鲜度过滤 |
| 2 | **时序有效性上线**：事实带 valid-from/valid-to，更新用 supersede 而非复制，写策略挡住琐碎内容 |
| 3 | 工作记忆与受治理长期记忆分离（经 identity/scope/freshness/certification 四道闸）；遗忘策略合并剪枝；图记忆表达事实如何演变 |
| 4 | 记忆成为受治理、可监控的能力：用 golden set 跑记忆 benchmark，记忆衰减像模型漂移一样告警 |

判语：**「多数团队处在 Stage 0，把『记忆在增长』误认为『Agent 在学习』；没有治理的增长就是衰减。」**

---

## 三、六维度对照表

| 维度 | 业界要求（Stage 2~4） | 本项目现状 | 差距 |
|------|---------------------|-----------|------|
| **沉淀** | Hook 自动捕获 + 写策略筛选 + observation 结构化 | Phase 5 批量更新 + 人工/LLM 生成模块文档；无「什么值得沉淀」门槛；pitfalls.md 靠人写 | 🟡 中 |
| **更新** | 增量 + supersede 语义 + 冲突解决 | git diff 增量；就覆盖，无覆盖关系记录；无冲突解决步骤 | 🔴 大 |
| **利用** | 混合检索 + RRF + 重排 + 结果去重 | 域级关键词（L1/L2）+ 图谱；无向量路、无 RRF、无 diversify | 🔴 大 |
| **注入** | 分层：必带 slots + 按需检索 | 只给约束 + 路径，不内联正文（成本上正确）；缺「项目级 pinned」层 | 🟢 小 |
| **淘汰** | 时序有效性 + 衰减 + soft delete + 陈旧阈值 | 仅 `--stale` 输出计数；Phase 6 仅陈述 hash 不一致；**零处置** | 🔴 大（最严重） |
| **评估** | golden set + 检索/答案质量分开度量 + 阈值前置 | 无任何评估数据集；kb-update 容错策略是「失败不阻断」 | 🔴 大 |

---

## 四、优化方向清单（按优先级）

### P1 — 时序有效性 + 过期标记（建议先做）

**改什么**
1. kb-update 的文档写入增加**时序元数据**：文档头维护「最后校验 hash + 日期」，被取代的段落**就地标记**而非静默删除（如 `<!-- DEPRECATED: 由 xxx 取代 @hash -->`）
2. meta.yaml 每个 domain 增加 `last_verified_at` / `last_verified_hash`
3. kb-query 的 L2 增加**新鲜度判据**：域的最后校验 hash 与当前 HEAD 差距过大时，明确提示「该域可能已过期，以源码为准」

**为什么**：这是唯一直接影响「Agent 会不会自信地用错信息」的缺陷。当前 agent 读到半新半旧的 architecture.md，无从判断哪句还算数。

**落到哪**：`skills/kb-update/SKILL.md`（Step 2/3 的 AI 指引）、`skills/kb-query/SKILL.md`（L2 判据）、meta.yaml 字段约定。
**改动量**：中。不动 Agent 间契约、不动检索入口文件路径。
**风险**：低。纯增量字段；已在 `context-refresh.js:455-457` 有「陈述式比对」的先例，可沿用「只陈述不判失败」的口径。

### P2 — 检索补第三路（向量语义）+ 融合

**改什么**
1. 增加向量检索作为 kb-query 的补充路（对文档 chunk 做 embedding）
2. 引入 RRF 融合取代现在的「冲突以源码为准」（保留源码为准作为最终仲裁）
3. 增加结果去重（同一域反复检索返回同一批文档的问题）

**为什么**：agentmemory 的 benchmark 显示 BM25-only → BM25+Vector 约有 9 个百分点的 R@5 提升；「换个说法问同一个问题」是目前召回的主要失分场景。

**落到哪**：新增向量索引构建脚本 + `kb-query/SKILL.md` 检索流程。
**改动量**：中大（引入 embedding 依赖与索引维护）。
**风险**：中。本项目知识库是「模块文档」而非海量事件流，规模小、域边界清晰，向量路收益可能低于 agentmemory 场景。
**建议**：先做 P3 拿到 baseline 数据，再决定是否值得投。

### P3 — 评估闭环（golden set）

**改什么**
1. 建最小 golden set（20~30 条「业务问题 → 应命中的文档/域」）
2. 每次 kb-update 后跑一次，输出 recall@K
3. 失败样例回灌为新的 query-doc 对
4. kb-update 的成功率/失败率纳入度量（当前连成功率都没记录）

**为什么**：现在无法回答「kb-query 准不准」。Atlan 要求 ≥50 条，本项目规模下 20~30 条即可起步。性价比高于加向量索引。

**落到哪**：新增评估脚本 + 一个 golden set 数据文件；可挂在 harness-evolve 的度量环节。
**改动量**：小。
**风险**：低。

### P4 — 沉淀环节升级

**改什么**
1. 把「Phase 3 审查中确认的根因 / 踩坑」自动进 pitfalls.md —— 这是 agentmemory 里 observation → insight 的沉淀路径
2. 给 kb-update 增加「什么值得沉淀」的写策略（当前是「git diff 命中的域全改」）
3. 提取「项目级 pinned」约束（不该碰的文件 / 构建命令 / 提交规范），使其不可被裁掉

**为什么**：pitfalls.md 目前靠人写，是最容易空转的一环；项目硬约束散落在各 agent .md 里，无统一信源。

**落到哪**：`skills/kb-update/SKILL.md`、Phase 3 审查 agent 定义、`services/prompt-builder.js` 的约束装配段。
**改动量**：中。
**风险**：中 —— 第 3 条涉及 prompt 装配，需注意不改变既有注入契约。

### 明确不建议做的

- **照搬 Hook 全量捕获**：本项目知识库是「模块文档 + 域索引」，不是「事件流 + 向量库」，照搬 observation 体系属于形态错配。
- **照搬 51 个 MCP tools / 多路检索权重调参**：规模不匹配，收益无法验证。
- **在没有 golden set 之前引入向量库**：无法判断是变好还是变坏。

---

## 五、可复用的设计原则（供以后参考）

1. **记忆是生命周期，不是存储** —— 决定价值的不是「存了什么」，而是「何时写、什么可信、何时过期、如何被覆盖、遗忘什么」。
2. **相似性 ≠ 正确性** —— 相关性高但已过期的内容是最危险的检索结果，因为 Agent 不会怀疑它。
3. **淘汰必须有落点** —— 只检测不处置（本项目 `--stale` 的现状）等于没有淘汰；过期必须有可见标记 + 检索侧判据。
4. **更新用覆盖而非追加** —— 同一事实的两份记录会让下游「自行挑一份」，判断权回流。这与本项目「同物多信源必须彻底收敛」的原则同源。
5. **评估先于优化** —— 没有 ground truth，任何检索改造都是盲改。
6. **分层而非统一** —— 必带约束（slots）与按需检索的内容走不同通道；混在一起必然失控。
7. **成本与信息完整性换位** —— 本项目已验证「不内联、给路径」的原则；下一步是把同样的取舍用到检索侧（按需召回少数，而非全量加载）。

---

## 六、参考出处

- agentmemory 技术拆解：<https://zhuanlan.zhihu.com/p/2037691128422649981>（GitHub: rohitg00/agentmemory）
- Atlan — How to Build a Knowledge Base for AI Agents (2026)：<https://atlan.com/know/ai-agent/data-for-ai/how-to-build-knowledge-base-for-ai-agents/>
- AppScale — AI Agent Memory Staleness & Context Rot: The Fix (2026)：<https://appscale.blog/zh/blog/agent-memory-staleness-context-rot-invalidation-temporal-validity-2026>
- 相关参考：Graphiti（时序知识图谱记忆）、mem0、LongMemEval / LoCoMo benchmark
