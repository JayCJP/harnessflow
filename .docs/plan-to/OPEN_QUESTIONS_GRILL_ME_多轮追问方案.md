# Open-Questions 引入 grill-me 式多轮追问 —— 复盘与最终方案（v2）

> 状态：v2 **已实现**（LLM 语义判定 + 扁平 Q 递增），测试 90/90 + 全量 14 文件全绿 + lint exit 0；版本 bump 待做
> 日期：2026-11-23
> 关联复盘 Story：`opt-offline-pool`、`STORY-20260927-01`
> 交叉核对文档：`code-review-open-questions-v4.md`（2026-10-20 门控重构审查报告）
> 版本沿革：v1 = 确定性词表 + followups 父子嵌套（已废弃）；**v2 = LLM 语义判定 + 扁平 Q 递增（用户 2026-11-23 裁定）**

## 0. 背景与目标

用户此前参考 `grill-me` skill 优化 open-questions，期望 AI **持续追问**直到共识达成。但两个真实 Story 的执行都出现同一问题：Phase 0 用户答复后**没有任何追问轮次**，8 秒内直接跃迁 Phase 1；且用户答复中带出的新疑问 / 新指令被当作"终局裁决"直接消费。

本文档记录两次复现的证据、当前 Phase 0→1 流程的 review、以及最终实现方案（v2）。

---

## 1. 两次复现证据

### 1.1 opt-offline-pool

路径：`D:\test-blanch\opt-offline-pool\CustomerServiceSystem\.codebuddy\plans\opt-offline-pool`

`trace.jsonl`：

```
02:55:23.773~.998  3 条 user_decision 同一秒批量写入
                   Q-1 verbatim（用户补充的交互意见）
                   Q-2 accept（直接采纳 AI 建议稿，answer = resolution 全文）
                   Q-3 verbatim（"bug已被后端解决，忽略"）
02:55:31           门控 pass（blockerCount: 0）→ Phase 0→1（确认后约 8 秒）
```

关键问题：Q-1 的 answer 结尾本身就是一个**未决疑问**——"当只有一个接待用户和只有一个离线会话时，选中离线会话再切回会话，无法正常打开会话的右侧?"——却被判为"已确认"，新分支静默丢失。

### 1.2 STORY-20260927-01

路径：`D:\test-blanch\supply-cs\CustomerServiceSystem\.codebuddy\plans\STORY-20260927-01`

`trace.jsonl`：

```
03:21:42.131~.816  5 条 user_decision 同一秒批量写入（全部 verbatim）
                   Q-01 "问题已修复，忽略"
                   Q-02 "在排查一下当前请求历史消息记录的逻辑…能否重新请求历史消息，再排查一下？"
                   Q-03 "需求调整，在供应商客服模式下 不支持上传视频，只支持上传图片。"
                   Q-04 "src\views\pc\data\DataVisual.vue supplierReceptionEnabled 改成计算属性 读取"
                   Q-05 "已经恢复上面三条，需要改的和排查的"
03:21:50.984       门控 pass → 03:21:51.004 Phase 0→1（确认后约 8 秒）
```

关键问题：Q-02 / Q-03 / Q-04 / Q-05 的 answer 是**新排查指令 / 新需求 / 恢复意见**，不是对原问题的单纯确认。系统处理方式：`context_refresh.sync_decisions` 把这些 verbatim 原样写入 `requirement-analysis.md:161,167,170`，Phase 1 的 `task-dag.json` 直接照着拆成 task-1/2/3。**新指令被当终局裁决消费，没有任何一轮回来确认"理解是否正确"。**

表面看"答案被消化了"，实际依赖 Phase 1 Agent 的自由文本理解，无结构化保证：
- 模糊疑问（如 opt Q-1）不会被拆成 task → 静默丢失；
- 相互矛盾的恢复意见（如 Q-05 "已经恢复上面三条"）无二次确认就按 AI 理解执行。

### 1.3 关于"grill-me 优化"的事实澄清

- git 里唯一的提问机制优化是 `ae9342f v2.3.2 完善 P0 待确认项提问机制`（2026-11-20），方向**与 grill-me 相反**：把问题措辞改成「是否采纳 X？」让用户答"采纳/yes"即等价采纳、补全 `--accept` 一键落账 —— 这是为**单轮确认**设计的。
- grill-me 原版在 `mattpocock-skills/1.2.3/skills/productivity/grilling/SKILL.md`，harness 未引用，代码/文档/记忆里无 grill 字样。
- 结论：harness 的 open-questions 从来就不是多轮追问机制。

### 1.4 grill-me 的核心纪律（对照物）

> Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**... Work the tree in **rounds**... Ask the whole frontier in one round... wait for the user's answers before the next round... Recompute the frontier and ask the next round... **Do not act on it until the user confirms you have reached a shared understanding.**

当前 harness 缺失的正是：答复后重算 frontier + 无静默假设才行动。

---

## 2. 当前 Phase 0→1 流程 Review

### 2.1 设计概括

单轮确认流水线：Agent 产出建议稿 → 门控拦下 → dispatch 返回 `blocked/user_confirmation_required` → 主 Agent 一次性列清单 → 用户答 → `resolve-question.js` 写 `confirmation` → 再 dispatch → 门控只看 `confirmation` 存在即放行 → 跃迁 Phase 1。

### 2.2 做对了的部分（不动）

1. **放行使一信源**：`contracts.js:155-174` 的 `evaluateOpenQuestion` —— `confirmation` 是唯一放行依据，`resolved`/`resolution`/`blocking` 全部退出门控，解决"AI 自己写 resolved=true 就过"的历史病。
2. **软约束 + 正规写入端**：confirmation 不做硬 hook，靠 `resolve-question.js` 写全字段 + 格式 heuristic（缺 `confirmedVia`/`confirmedAt` 记 warning）留审计痕（`policy.js:505-514`）。
3. **区分"没干完"与"待确认"**：`dispatch.js:314-345` 的 `no_proposal` 让分析员补稿、`pending_confirmation` 交回用户，避免 Spawn 分析员重复自答。
4. **原子落盘 + 改判留 history**（`resolve-question.js:204-232`）。

### 2.3 核心缺陷

**缺陷 1（根因）：门控语义 = "字段存在"，不是"共识达成"。**
`evaluateOpenQuestion:159-169` 判 `confirmed` 只看 answer 非空 + 元数据齐全，**完全不读 answer 内容**。疑问、新指令、恢复意见一律被判 `confirmed`。

**缺陷 2：dispatch recovery 封死"追问"路径。**
`dispatch.js:336-342` 与 `start/SKILL.md:150-155` 写死"一次性列给用户 → 逐条落账 → 回 Step 1"，没有任何一步是"检查答复是否引出新分支，构造第二轮问题"。主 Agent 无判断权（铁律：AI 不操作状态），即便想追问也无脚本产出追问清单。

**缺陷 3：`question` 措辞铁律在制度上鼓励单轮闭环。**
`prompt-builder.js:901-902` + schema `question.description` 明写"让用户答采纳/yes 直接等价于采纳 resolution"，与 grill-me"把决策抛给用户并等待、不预设答案"相反。

**缺陷 4：answer 与下游契约之间无"解释/对齐"环节。**
`sync_decisions` 把 verbatim 原样塞进 `requirement-analysis.md`，Phase 1 直接拆 task，缺 grill-me 的 "Do not act until user confirms shared understanding"。

---

## 3. 最终方案 v2：LLM 语义判定 + 扁平 Q 递增

### 3.1 决策记录（2026-11-23 用户裁定）

| 决策点 | 裁定 |
|---|---|
| 识别方式 | **LLM 语义判定**（需求分析师 spawn），不用确定性词表 —— 覆盖词表漏检面（语义级理解） |
| 新问题载体 | **扁平 `Q + 递增数字`**（Q-4/Q-5 追加进顶层 `questions[]`），不要父子嵌套 |
| 落账时机 | **判定为终局（verdict=final）才写入 confirmation** —— 未判定/未终局的答复不得落账 |
| 强制程度 | 落账前置校验为**机器硬校验**（字段事实：assessment 存在 + verdict=final + rawAnswer 一致），非语义校验 |

### 3.2 两个转变带来的架构红利

| 维度 | v1（词表+嵌套，已废弃） | v2（LLM+扁平） |
|---|---|---|
| 识别 | `detectFollowupSignals` 词表 | 需求分析师语义判定 → 结构化 `assessment` |
| 新问题载体 | `Q-2.1` 挂父项 `followups[]` | `Q-4` 追加进顶层 `questions[]` |
| 闭环判定 | 递归遍历树（第五态 needs_followup） | **退化为现有 `allResolved`——所有 Q 有 confirmation 即放行，`evaluateOpenQuestion` 放行语义零改动** |
| 裁决投影 | `sync_decisions` 要过滤未闭环主项（最难一处） | **零改动**——落账的 confirmation 必然是干净裁决，新分支在各自新 Q 的 confirmation 里 |
| schema id pattern | 需放宽 `^Q-\d+(\.\d+)*$` | **零改动**（`Q-4` 天然匹配 `^Q-\d+$`） |

### 3.3 数据契约

`open-questions.schema.json` 给 question 增加可选字段 `assessment`（分析员写，与 `resolution` 同为建议性质；`confirmation` 仍只由 `resolve-question.js` 写入）：

```json
{
  "id": "Q-2",
  "question": "是否采纳「本轮先不排前端任务，由测试补抓包再定责」？",
  "resolution": "建议采纳。……",
  "assessment": {
    "verdict": "final",              // final=终局裁决可落账 | not_answered=未有效回答原问题
    "rawAnswer": "在排查一下当前请求历史消息记录的逻辑……再排查一下？",  // 用户原话逐字保真（落账锚点）
    "decisionExtract": "用户否决「只等抓包」，改为主动排查转接消息触发历史重拉",  // 人读摘录，审计用
    "newQuestionIds": ["Q-4"]
  },
  "confirmation": { "answer": "...", "confirmedVia": "verbatim", "confirmedAt": "..." }
}
```

新 Q（扁平递增，编号 = 现有最大 Q 编号 + 1，由分析员按规则生成）：

```json
{ "id": "Q-4", "question": "转接系统消息触发当前会话历史重拉，是否采纳此实现方向？", "resolution": "分析员建议稿……", "resolutionSource": "code-evidence" }
```

### 3.4 判定机制：谁判、判什么、结论落在哪

**判定执行者是 spawn 的需求分析师**（主 Agent 无判断权，语义判定是需求分析本职）。流程：

```
用户答复到达（主 Agent 会话内）
→ 主 Agent spawn requirement-analyst 做「答复语义判定」
   prompt = dispatch A0 提供的判定模板，<USER_REPLIES> 占位符由主 Agent
   原样填入用户答复（同 story-input.json 参数搬运模式，非拼接加工）
→ 分析员判定并直接编辑 open-questions.json（其本职产出物）：写 assessment + 追加新 Q
```

**判定口径**（写进需求分析师.md）：
- **final**：答复是对原问题的明确裁决（含"否决建议稿改为 X"式答复）——即使同时带出新分支（supply Q-02 = final + newQuestions）
- **not_answered**：答非所问 / 只抛回新疑问没回答原问题 → 原 Q 保持 pending，下轮重问
- **新分支识别**：答复中的新疑问、新需求、新指令、需求变更 → 逐条转成新 Q（question 引用用户原话改写成可确认的问题 + 分析员建议稿）
- **rawAnswer 铁律**：逐字摘录用户原话，禁止改写 —— 它是落账与审计的保真锚点
- 未落账的 pending Q（含 not_answered 的）分析员可在判定时改写 question/resolution（grill-me 的"答复重塑问题集"）

### 3.5 "当确定了再写入 confirmation"：机器可校验的前置条件

`resolve-question.js --answer` 落账前新增两项**硬校验**（校验字段事实，不是语义，不违背"机械执行"）：

1. 该 Q 必须已有 `assessment.verdict === 'final'`，否则报错："该答复未经语义判定（或判定为未终局），先 spawn 需求分析师生成 assessment"
2. `--answer` 的值必须与 `assessment.rawAnswer` **逐字一致**（脚本字符串比对；实现为 trim 后严格相等——容忍命令行传参的首尾空白，中段字符仍逐字，2026-11-23 实现裁定）——分析员篡改原话的路径被堵死，用户原话保真成为机器保证

这正是两次复现病根的相反面：旧流程主 Agent 拿到答复直接落账；新流程**没有判定结论就落不了账**。紧急人工场景手改文件仍是软约束边界（v4 同款，留 confirmedVia/confirmedAt 启发式 + 审计）。

### 3.6 运行时改动（8 个文件 + 零改动确认）

#### (1) `open-questions.schema.json`

- question 加 `assessment`（`verdict` enum: final/not_answered + `rawAnswer` + `decisionExtract` + `newQuestionIds[]`），additionalProperties 约束同步
- **无 followups、id pattern 不动**
- `question.description` 措辞铁律更新（见 (6)）

#### (2) `contracts.js`

- `evaluateOpenQuestion` 新增动作态 **`assessed_final`**（有 `assessment.verdict=final`、无 confirmation）——**不影响放行语义**（无 confirmation 就不放行，仍归 unresolved）；作用是让 dispatch 区分"待问用户"vs"待落账"
- `checkOpenQuestions` 暴露 `assessedFinal[]` 桶

#### (3) `resolve-question.js`

- `--answer` 前置校验（§3.5 两项）
- `pendingQids` 补 `assessed_final`（否则 pending 清单漏掉待落账项，主 Agent 误判"全部完成"）
- `--accept` 采纳建议稿路径同样校验（建议稿采纳无需 rawAnswer 比对，但需 verdict=final？——否：`--accept` 的语义是"用户明确说采纳建议稿"，判定环节对"采纳"式答复也应产出 assessment；校验口径：accept 需 assessment 存在且 verdict=final）

#### (4) `dispatch.js`

- A0 recovery 按 `checkOpenQuestions` 的桶动态给指令（主 Agent 全程机械）：

| 文件状态 | dispatch 指令 |
|---|---|
| pending（无 assessment） | 列清单给用户（现状不变） |
| 用户答复已在会话 | 先按模板 spawn 分析员判定（模板含 `<USER_REPLIES>` 占位） |
| `assessed_final` | 逐条执行 `resolve-question --qid --answer "<assessment.rawAnswer>"` 落账 |
| 新 Q pending | 并入下轮清单（blocking 项排前） |

- `openQuestionWarnings` 补 assessed 状态提示

#### (5) `agents/需求分析师.md`

- 新增"答复语义判定"职责段（§3.4 判定口径 + rawAnswer 铁律 + 新 Q 编号规则：现有最大编号 + 1）
- `:122` 字段白名单表补 `assessment`；"答采纳/yes 即等价采纳"措辞铁律弱化为"问题清晰 + 建议稿"（答复语义交判定环节解读）

#### (6) 提示词与文档

- `prompt-builder.js:901-902`：措辞铁律改写（不再要求是/否式提问；补"答复语义判定"流程说明）
- `prompt-builder.js` 的 `oqReworkNote`（:843-848）：补"assessment 可按新判定更新，confirmation 不得改动"
- `skills/start/SKILL.md:150-155`：blocked 分支改写（列清单 → 答复 → **spawn 判定** → 按判定落账/新 Q 再问 → 全部 confirmation 才回 Step 1）
- `skills/start/references/phases/phase-0.md`：门控表补 `assessment` 说明 + 判定环节描述

#### (7) 审计与度量

- trace 新增 `answer_assessed` 事件（qid / verdict / 新 Q 数），`appendTrace` 无类型白名单，直接写
- `/evolve` 体检候选统计项：`unassessed_confirmation`（落账却无判定，软约束违规信号）、追问轮数分布（判定质量观察）

#### (8) 实际改动与零改动确认（实现后修订）

- `schema-injector.js`：**有一处必要改动**——assessment 嵌套 object 进骨架导致 Phase 0 骨架超 2KB
  成本护栏（2097 > 2048），精简 FIELD_NOTES（resolved 的废弃注解移除、由 prompt-builder 口径段承载，
  confirmation 注解精简保留）保住护栏。原方案"零改动确认"预判有误差。
- `policy.js`：**有一处必要聚合改动**（见 §4 实现记录）——assessedFinal 并入 pending blocker 构成，
  消息文案区分"待确认 N 项 + 已判定待落账 M 项"。
- `context-refresh.js` 裁决投影与摘要（落账的 confirmation 必然干净；放行时全部闭环，投影全部 Q）✅ 零改动
- `session-start.js` 规则 1（"未写入 confirmation 禁止推进"仍成立）✅ 零改动
- `harness-audit.js`（桶结构不变）✅ 零改动

### 3.7 与 grill-me 的对照（定位）

| grill-me 要素 | v2 对应物 | 继承度 |
|---|---|---|
| rounds until frontier empty | 追问轮直到所有 Q 有 confirmation（BLOCKER 保证） | ✅ |
| 整轮问 frontier | A0 一次列 pending 清单 → 答复 → 判定 → 重列 | ✅ |
| 答复重塑问题集 | LLM 判定 → final 落账 / not_answered 重问 / 新 Q 追加 / pending Q 可改写 | ✅ |
| Facts are your job | v2.3.2 既有（能查的先自查） | ✅ |
| Decisions are the user's | confirmation 只经 resolve-question.js 用户答复写入 | ✅ |
| Do not act until shared understanding | 所有 Q 有 confirmation 才放行（机器化，更强） | ✅+ |
| **design tree（显式依赖）** | 扁平列表 + 建议稿"依赖显式化"（软） | ❌ 弱化 |

**v2 强于 grill-me**：终止是机器保证（grill-me 靠 LLM 自觉维护树，会漏问；v2 门控数数，漏一项就 BLOCKER）；判定留痕可审计（assessment + rawAnswer 一致性校验 = 原话保真机器验证）；写入端唯一。
**v2 弱于 grill-me**：无显式依赖树（提问顺序不保证依赖后置）；每轮多一次判定 spawn（判断权不给主 Agent 的必要代价）。
**依赖错排的轻量补法（暂不做，观察两个真实 Story 后决定）**：新 Q 可带 `dependsOn: ["Q-2"]`，dispatch 列清单时依赖未落账的排后并标注。

### 3.8 查漏补缺（与 v4 review 报告交叉核对，2026-11-23）

对 `code-review-open-questions-v4.md` 的 P1/P2/P3 逐项核对当前代码，结论：**v4 的债已全部还清**——

| v4 问题 | 现状 |
|---|---|
| P1-1 context-refresh 裸读 q.resolved | ✅ 已改走 checkOpenQuestions（:274-276） |
| P1-2 session-start 旧口径强制规则 | ✅ 已改为 confirmation 口径（:58） |
| P1-3 agents model 字段混入 | ✅ 后续版本演进已消化 |
| P1-4 failure-patterns 混入 E2E 数据 | ✅ 0 残留 |
| P2-5/6 任务规划师.md / README 旧口径 | ✅ 均已改为 confirmation 口径 |
| P2-7 schema-injector 白名单暗示合法输出 | ✅ 已加 FIELD_NOTES 注解机制 |
| P2-8 dispatch A0 recovery 信息不足 | ✅ 已带完整清单 + 路径 + noProposal 提示 |
| P2-9 resolve-question 顶层无 try/catch | ✅ 已补 |
| P2-10 --accept-all --force 覆盖 verbatim | ✅ 已改为一律跳过、改判逐条 --force |
| P2-11 护栏只扫 contracts.js | ✅ 已扩扫 policy.js structuredError 并与 RECOVERY_SUGGESTIONS 做差集 |
| P2-14 --accept-all 回滚零覆盖 | ✅ 已补 9c 用例（逐字节比对） |

v1 方案查漏时发现的 8 个遗漏，**扁平化后大部分自动消解**：

| v1 遗漏 | v2 状态 |
|---|---|
| context-refresh 裁决投影过滤（最难一处） | ✅ **自动消解**（零改动，见 §3.6-8） |
| schema id pattern 放宽 | ✅ **自动消解**（Q-4 匹配现有 pattern） |
| resolve-question qid 递归定位 | ✅ **自动消解**（扁平顶层查找即可） |
| dispatch A0b 分支 | ✅ 转化为 A0 按桶细分（§3.6-4） |
| 需求分析师.md:122 字段白名单 | 仍需改（补 assessment 字段） |
| RECOVERY_SUGGESTIONS 登记新 type | ✅ **自动消解**（不新增 failureType） |
| prompt-builder oqReworkNote | 仍需改（补 assessment 指引） |
| **【v4 漏网，顺带修复】metrics-aggregator.js:326,371,403** 三处"open-questions 全部 resolved"旧口径 | 仍需改（v4 清理时只改了 README 漏了这里） |

### 3.9 数据流全景（实现后）

```
Phase 0 分析员产出 Q-1..Q-N（含建议稿）
→ dispatch A0 blocked → 主 Agent 列清单给用户
→ 用户答复（第一轮原话，会话内）
→ 主 Agent spawn 需求分析师做语义判定（prompt = A0 模板 + <USER_REPLIES> 原样搬运）
→ 分析员写 assessment（verdict/rawAnswer/decisionExtract）+ 追加新 Q（扁平递增，含建议稿）
→ 主 Agent 回 Step 1 → dispatch 按桶给指令：
     assessed_final → resolve-question --answer "<rawAnswer>" 落账（前置校验：verdict=final + 原话一致）
     新 Q / not_answered → A0 列入下轮清单（第二轮问题）
→ 用户再答 → 再判定 → …… 直到所有 Q 有 confirmation
→ 门控放行（allResolved，现有判定零改动）→ sync_decisions 投影全部裁决 → Phase 1
```

终止靠 LLM 语义判 final（比词表可靠：用户说"确认，就这样"时 LLM 能理解语态，无词表死循环问题）；每轮 trace 留痕（`answer_assessed` / `user_decision`），审计可回放。

### 3.10 两次复现的落地效果

| 场景 | 现在 | v2 后 |
|---|---|---|
| opt Q-1 "右侧打不开?" | 静默丢失，直接放账 | 判定识别为新疑问 → 追加 Q-4（含建议稿）→ 列入下轮 → 用户确认 → 闭环才进 Phase 1 |
| supply Q-02 "再排查…能否重新请求？" | verbatim 塞进需求文档，Phase 1 自由理解拆 task | 判定 final（否决只等抓板）+ 新 Q-4（重拉方案确认）→ Q-2 落账 + Q-4 二次确认 → Phase 1 拿到已确认的理解 |
| supply Q-04 "改成计算属性" | 同上 | 判定 final + 新 Q 承接实现细节确认 → 落账的是干净裁决 |
| supply Q-05 "已经恢复上面三条" | 矛盾意见直接消费 | 判定环节要求分析员梳理"恢复了哪三条"→ newQuestions 或 not_answered → 用户二次澄清 |

---

## 4. 实现记录（2026-11-23 已完成，测试 90/90 + 全量 14 文件全绿 + lint exit 0）

**契约与判定层**
- [x] `open-questions.schema.json`：assessment 字段定义 + question.description 措辞更新
- [x] `contracts.js`：`assessed_final` 第五态 + `checkOpenQuestions` 的 assessedFinal 桶（计入 unresolved，放行语义不变）

**门控聚合**
- [x] `policy.js`：checkPhase0Gate 的 pending 构成并入 assessedFinal（方案文档原判"零改动"有误差——
  不并入则"只剩待落账项"时门控误放行，一行聚合修正，语义仍是"无 confirmation 不放行"）

**写入端（硬校验）**
- [x] `resolve-question.js`：`--answer`/`--accept` 前置校验（verdict=final；`--answer` 加 rawAnswer 逐字一致比对）+ `--accept-all` 只采纳已判定项 + `pendingQids` 补态 + 落账后 trace `answer_assessed`

**调度**
- [x] `dispatch.js`：A0 recovery 按桶分组（❓ 待问 / 🔵 待落账勿重问）+ 判定环节 spawn 模板内嵌 + openQuestionWarnings 补待落账提示

**提示词与文档**
- [x] `agents/需求分析师.md`：新增 §6「答复语义判定」职责段（判定口径 + rawAnswer 铁律 + 新 Q 编号规则）+ 字段白名单补 assessment + 措辞铁律弱化 + "最多 3 轮"与判定轮解耦
- [x] `prompt-builder.js`：Phase 0 口径段改写（判定职责 + 新 Q 追加纪律）+ oqReworkNote 扩 assessment 指引
- [x] `skills/start/SKILL.md`：blocked 分支流程改写（判定环节步骤）+ 铁律新增"不得跳过判定直接落账"
- [x] `skills/start/references/phases/phase-0.md`：门控表更新 + 判定环节说明段

**审计**
- [x] trace `answer_assessed` 事件落址：resolve-question 落账时从 assessment 生成（判定无独立脚本入口，落账是判定的必然后继，审计链完整可回放）

**顺带修复（v4 漏网）**
- [x] `metrics-aggregator.js:326,371,403`：三处 "open-questions 全部 resolved" 旧口径改 confirmation 口径

**验证**
- [x] `open-questions-confirmation.test.js`：新增 section 12/12b/13/14（第五态与 dispatch 分组 / A0 空 items 边界 / 落账三重拒绝 / 全链路闭环含 trace 与裁决投影）+ 既有 7/8/9/9b/9c 夹具补 assessment；93/93 全绿
- [x] 存量兼容：无 assessment 的历史已确认项不回溯（校验只作用于落账时点）；`resolved` 字段存量兼容保留
- [x] `npm test` 14 文件全绿 + `npm run lint` exit 0
- [x] 骨架成本护栏保住 2KB：open-questions 骨架注解精简（resolved 注解移至口径段承载，confirmation 注解保留）
- [x] `graphify update .` 完成（2708 节点）

**实现后 review 修正（2026-11-23，diff 逐文件对照方案）**
- [x] dispatch 判定模板补 `<USER_REPLIES>` 占位符（方案 §3.4 设计的占位符机制，实现初版漏了——主 Agent 的机械替换点）
- [x] dispatch A0 空 items 边界（只剩待落账项时不再输出「必须经用户确认」引导头，section 12b 回归覆盖）
- [x] policy blocker message 区分「N 项待确认 + M 项已判定待落账」
- [x] 方案文档 §3.5 补 trim 语义说明（--answer 一致性 = trim 后严格相等，容忍命令行首尾空白）、§3.6-8 改为「实际改动与零改动确认」

**遗留（下一批）**
- [ ] 版本号 `npm run version:bump -- 2.3.3`（落账语义变更：存量 story 的 pending 项在新流程下需先判定才能落账）
- [ ] `/evolve` 体检候选统计：`unassessed_confirmation`（软约束违规信号）、追问轮数分布
- [ ] 真实 Story 实测一轮（判定环节 spawn 的 token 成本与判定质量观察）
