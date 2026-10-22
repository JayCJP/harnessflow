# Code Review 报告 — open-questions 门控重构（v4）

> 审查时间：2026-10-20
> 审查对象：工作区未提交改动（`git diff HEAD`，17 改 2 增）
> 依据文档：《open-questions 门控重构方案 v4》+ 落地计划 `plan.md`
> 审查方式：逐文件读实现 + 全仓交叉检索 + 实跑测试/lint

---

## 一、结论摘要

| 维度 | 结论 |
|---|---|
| 核心目标达成 | ✅ 放行判定已收敛到 `confirmation`，`resolved`/`resolution`/`blocking` 全部退出门控 |
| 旧概念清理 | ✅ `isTrulyResolved` / `pseudoResolved` / `blocking_unresolved` / `pseudo_resolved` 全仓 grep **0 命中** |
| 测试 | ✅ 新增用例 59/59 全绿；`npm test` 仅存既有 5 条失败，无新增 |
| Lint | ✅ exit 0 |
| 合入建议 | ⚠️ **先修 P1 的 4 项**（2 处口径残留 + 2 处无关改动混入），P2 可随本批或下批处理 |

**一句话结论**：判定层与写入端主干实现是对的、可用的；问题集中在「改了一个信源、漏了另一个」和「提交内容不干净」，不涉及架构返工。

---

## 二、实跑验证数据

| 检查项 | 命令 | 结果 |
|---|---|---|
| 新增用例 | `node scripts/__tests__/open-questions-confirmation.test.js` | **通过 59 / 59 全绿** |
| 全量测试 | `npm test` | 10/11 文件通过；2 文件失败，失败项为既有 5 条 |
| Lint | `npm run lint` | exit 0 |

全量测试的失败明细（与本次改动**无关**，属仓库已知状态）：

```
优化回归  FAIL AGENT_CONSTRAINTS 含「检索失败必须上报」
优化回归  FAIL agentPrompt 约束段含检索失败上报
fixbugs   FAIL 约束段为 4 条（v3 精简 2 条 + P3-2 检索失败上报 + Bash 失败交代）
fixbugs   FAIL P3-2 检索失败上报约束已注入
fixbugs   FAIL Bash 失败交代约束已注入
```

→ 满足验收口径「不新增失败 + 新用例全过」。

---

## 三、问题清单总表

| # | 级别 | 文件:行 | 问题 |
|---|---|---|---|
| 1 | **P1** | `context-refresh.js:274` | 仍裸读 `q.resolved` 统计摘要，恒显示「0 已解决」 |
| 2 | **P1** | `session-start.js:58` | 强制规则第 1 条仍是 `resolved=false` 旧口径，每次会话注入 |
| 3 | **P1** | 4 个 `agents/*.md` | `model` 字段被改（含 `enableThinking: true`），与本次重构无关 |
| 4 | **P1** | `experience/failure-patterns.json` | 混入一次 e2e 跑批生成的运行期数据（`storyId: E2E-1`） |
| 5 | P2 | `agents/任务规划师.md:86` | 「无 blocking 未 resolved 项」旧口径漏改 |
| 6 | P2 | `README.md:322` | 用户文档仍说「不自行置 `resolved=true`」 |
| 7 | P2 | `schema-injector.js:99-109` | `confirmation` 被当白名单字段渲染，与「严禁填写」冲突 |
| 8 | P2 | `dispatch.js:282-286` | A0 recovery 未附清单/路径；且吞掉 noProposal blocker |
| 9 | P2 | `resolve-question.js:113-221` | `main()` 无 try/catch，异常时破坏 stdout-JSON 契约 |
| 10 | P2 | `resolve-question.js:167` | `--accept-all --force` 可无差别覆盖用户 verbatim 裁决 |
| 11 | P2 | `optimization-regression.test.js:387` | failureType 静态护栏只扫 `contracts.js`，新 type 在 policy 未被覆盖 |
| 12 | P2 | `plugin.json` / 两份 marketplace | 破坏性门控变更但版本号未 bump |
| 13 | P2 | 方案文档 §5.1 | `confirmation.required` 与实现不一致（实现对、文档旧） |
| 14 | P2 | `open-questions-confirmation.test.js` | `--accept-all` 回滚路径零覆盖（方案 9b 明确要求） |
| 15-21 | P3 | 见 §6 | trim / 对象同一性 / 幂等返回码 / 枚举校验等 7 项 |

---

## 四、P1 详情（必须修，建议合入前处理）

### P1-1　`context-refresh.js:274` 仍裸读 `q.resolved`

```272:276:plugins/harness/scripts/services/context-refresh.js
          } else if (f === 'open-questions.json' && data.questions) {
            const resolved = data.questions.filter(q => q.resolved).length
            summary = `${data.questions.length} 项 (${resolved} 已解决)`
```

`syncDecisionsToRequirementDoc` 和 §5.6b 的摘要段都改好了，但 `getPhaseArtifacts` 这处漏改。现在没有任何代码写 `resolved`，Phase 0 摘要永远显示「3 项 (0 已解决)」，即使全部已确认。

**性质**：正是方案 §1.5-A 点名的「摘要用裸 `q.resolved` 统计，与门控口径不一致」——改了一个信源、漏了第二个，属本仓库最敏感的同物两信源问题。

**建议**：改走 `checkOpenQuestions(storyId)`，输出 `${total} 项 (${confirmed.length + confirmedInformal.length} 已确认 / ${pendingConfirmation.length} 待确认)`。

---

### P1-2　`session-start.js:58` 强制规则第 1 条仍是旧口径

```56:61:plugins/harness/scripts/hooks/session-start.js
  // 固定规则前置：稳定文本在前命中 KV cache，且约束 skill 加载前的行为边界
  lines.push('⛔ 强制规则（不可违反）:')
  lines.push('1. open-questions.json 中存在 resolved=false → 禁止推进到 Phase 1')
```

这条排在**所有约束最前面**、每次会话注入，且位于 skill 加载之前。现在 `resolved` 已废弃、门控完全不读，它造成的后果是：

1. 给 AI 错误心理模型——以为 `resolved=true` 是通关钥匙，诱导它手写 `resolved` 而非提示用户走 `confirmation`；
2. 与同文件第 82 行「用 resolve-question.js 写入 confirmation」自相矛盾。

**性质**：与方案 §1.2 批评的「四条互相矛盾指令」同类，只是位置从 prompt-builder 换到了 session-start。

**建议**：改为「open-questions.json 中存在未写入 `confirmation` 的项 → 禁止推进到 Phase 1（不分 blocking）」。

---

### P1-3　四个 agent 文件的 `model` 字段被改（与需求无关）

```
agents/代码审查师.md      model: hy4-preview → glm-5.3-flash
agents/任务规划师.md      model: hy4-preview → glm-5.3-flash
agents/前端开发工程师.md  model: deepseek-v4.1-flash → glm-5.3  +  enableThinking: true
```

这是本地环境调试残留，应 `git checkout` 还原后另起改动。

**风险**：`enableThinking: true` 会实际改变 Phase 2 开发工程师的推理行为，与门控重构捆在同一 commit 里，出问题无法单独回滚；且评审时会遮盖真正的 13 个文件改动。

---

### P1-4　`failure-patterns.json` 混入运行期数据

新增 pattern 的 `storyId: "E2E-1"`、`firstSeen: 2026-10-20T07:50:16` 表明是一次 e2e 跑批自动写入的（`rootCause` 里还留着「3 项待确认问题必须经用户确认（建议稿已就位）: Q-1, Q-2, Q-3」这种一次性运行细节）。

`optimization-regression.test.js:371-375` 专门写了 backup/restore，注释就是「测试产生的 preGateBlocked 记录不进入生产库」。经验库会被 `getLessonsAsChecklist` 注入下游 `mustCheck`，固化一次性细节会污染后续 Story。

**建议**：还原该文件（若想登记新 failureType，应在 `RECOVERY_SUGGESTIONS` + 护栏层面做，而不是塞一条跑批记录）。

---

## 五、P2 详情（建议修）

### P2-5　`agents/任务规划师.md:86` 漏改

```86:86:plugins/harness/agents/任务规划师.md
- 接收 Phase 0 产出物前确认 `open-questions.json` 无 blocking 未 resolved 项，有则暂停等用户确认。
```

方案的文件清单（13 个）没有覆盖此文件，但它明确写着旧口径（blocking + resolved）。任务规划师读到会做出错误判断。应改为「确认 `open-questions.json` 的每条 question 均有 `confirmation`，有缺失则暂停等用户确认」。

---

### P2-6　`README.md:322` 用户文档漏改

```322:322:README.md
- 🚫 **AI 不自行将 `open-questions.json` 的 `resolved` 设为 `true`**。待确认项必须由用户确认。
```

README 是面向用户的门控说明信源，仍停在 v3 之前。应改为「`confirmation` 字段只经 `resolve-question.js` 在用户答复后写入」。

---

### P2-7　schema 骨架把 `confirmation` 当普通白名单字段注入

`schema-injector` 只渲染 key + type（不渲染 description）：

```99:109:plugins/harness/scripts/services/schema-injector.js
  const lines = [`### \`${fileName}\``]
  lines.push(...describeLevel('顶层', schema))
```

于是 Phase 0 prompt 里现在会出现：

```
- `questions[]` 元素 字段白名单: `id`(string), ..., `resolved`(boolean), `confirmation`({answer, confirmedVia, confirmedAt, history})
- `questions[]` 元素 必填: `id`, `question`
```

紧接着口径段又说「`confirmation` 不得自行填写」。**白名单本身就在暗示「这是合法输出」**——这是软约束方案最脆的部位。

**建议**：骨架对 `confirmation` / `resolved` 追加一行注解（如「`confirmation`：仅 resolve-question.js 写入，Agent 不得填」），成本低、直接削减 R4 风险。

---

### P2-8　`dispatch.js` A0 的 recovery 信息不足

```282:286:plugins/harness/scripts/commands/dispatch.js
        description: '以下待确认项必须经用户确认（AI 建议稿不构成放行依据）:\n' + pending.join('\n') +
          '\n操作: 把待确认项一次性列给用户（问题 + 建议稿 + 依据来源，blocking 项排前），拿到答复后逐条执行 ' +
```

三个不足：

1. 方案 §5.5 要求「附清单：问题 + 建议稿 + 依据来源，blocking 项排前」，实际只拼了 blocker message（内容是 id 列表），**没有 question 原文 / resolution / resolutionSource**；
2. **没有给 `open-questions.json` 路径**——对比 `session-start.js:81` 是显式给了 `read_file .codebuddy/plans/<id>/open-questions.json` 的，两处信源不一致，主 Agent 得自己猜；
3. pending 与 noProposal 并存时 A0 提前 return，**吞掉 `open_questions_unresolved` blocker**，主 Agent 只看到「待确认」，确认完再 dispatch 才发现还有缺建议稿项，多一次往返。

**建议**：description 带路径 + 完整清单；并补一句「另有 N 项缺建议稿，需分析员先补稿」。

---

### P2-9　`resolve-question.js` 顶层无 try/catch

`main()` 里 `fs.readFileSync` / `fs.writeFileSync` / `validateArtifact` 全裸调，`process.exit(main())` 下未捕获异常 → 退出码 1、**stdout 为空**，宿主拿到堆栈而非 `{ok:false, error}`。主 Agent 按契约分支时会静默拿到 `out=null`。

**建议**：顶层包一层

```js
try { process.exit(main()) } catch (e) { process.exit(fail(e.message)) }
```

---

### P2-10　`--accept-all --force` 能清掉用户的 verbatim 裁决

```167:167:plugins/harness/scripts/commands/resolve-question.js
      q.confirmation = buildConfirmation(q.resolution, 'accept', hasConfirmation ? q.confirmation : null)
```

按方案 §5.2-6「`--accept-all` 与 `--force` 组合时覆盖全部已有项」这是照做，但语义上很危险：用户说「全部采纳」时主 Agent 只要多带一个 `--force`，**用户明确推翻建议稿写下的 `verbatim` 答案就会被降级成「采纳建议稿」塞进 history**，等于静默改写历史裁决。

**建议**：`--accept-all` 忽略 `--force`（已有确认一律跳过）；改判必须逐条 `--qid <Q-N> --force`。

---

### P2-11　failureType 静态护栏没覆盖 policy.js

```387:391:plugins/harness/scripts/__tests__/optimization-regression.test.js
const contractsSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib/contracts.js'), 'utf-8')
const pushedTypes = [...contractsSrc.matchAll(/pushIssue\(\s*result\s*,\s*'([a-z_]+)'/g)].map(m => m[1])
```

护栏只扫 `contracts.js` 的 `pushIssue(`，而本次新增的 `user_confirmation_required` / `open_questions_unresolved` 都由 policy.js 的 `structuredError(` 产出——**这次新增的两个 type 恰好都不在护栏覆盖范围内**。方案 §5.4 要求「新增 type 必须按静态扫描护栏登记」。

**建议**：把扫描目标扩到 `policy.js` 的 `structuredError(\s*'([a-z_]+)'`，与 `RECOVERY_SUGGESTIONS` 的 key 做差集比对。

---

### P2-12　版本号未 bump

`plugin.json` 与两份 marketplace 都是 `2.0.0`（三处一致 ✓），但这次是**门控语义破坏性变更**：所有停在 phase 0 的存量 Story 都会被新门控拦下。按仓库「版本号两处（含 marketplace）同步」惯例，建议 bump 至 `2.1.0` 并在 CHANGELOG/README 说明存量影响。

---

### P2-13　方案文档与实现不一致（实现对，文档要改）

方案 §5.1 写 `confirmation.required = ["answer", "confirmedAt"]`，实现是 `["answer"]`。

**实现是对的**：若按方案写，第 1b 类（缺 `confirmedAt`）会在门控第 1.5 步被 schema 校验拦成 `schema_validation_failed`，与 §4「1b 放行 + warning」直接冲突。但方案是本次的唯一信源，需回写文档，否则下次读方案的人会「修正」回错的版本。

---

### P2-14　`--accept-all` 回滚路径零覆盖

方案 §8 用例 9b 明确要求「任一写入失败时整体回滚（文件保持原样）」。实际测试覆盖了成功路径与「无可采纳项」，但 `resolve-question.js:191-194` 的回滚分支**没有测试**——这是整套改动里唯一会破坏用户数据的代码路径。

**建议**：构造一个写入后 schema 必然失败的夹具（如塞入非白名单字段），断言文件内容与写入前逐字节一致。

---

## 六、P3 小问题

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| 15 | `resolve-question.js:167,183` | `--accept` 传的是**未 trim** 的 `q.resolution`，而判空用的是 trim 后的 `proposal` | 统一传 `proposal` |
| 16 | `session-start.js:139` | `oqCheck.noProposal.some(p => p === q)` 依赖对象同一性，contracts 一旦改深拷贝即静默失效 | 改按 `id` 比对 |
| 17 | `resolve-question.js:170` | `--accept-all` 在「全部已确认」时返回 `ok:false`，幂等重跑被当报错 | 返回 `ok:true` + skipped |
| 18 | `contracts.js:162` | `evaluateOpenQuestion` 不校验 `confirmedVia` 枚举，`'admin'` 判 confirmed（不进 1b），只在 schema 层变成无指向性的 `schema_validation_failed` | 枚举不在白名单亦归入 `confirmed_informal` |
| 19 | `session-start.js:137` | `blocking` 字段已无消费者（原 `blockingCount` 逻辑已删） | 清理或在注释说明保留原因 |
| 20 | `policy.js:278` | `lower.includes('阻塞级待确认')` 已是死关键词（无产出方） | 删除 |
| 21 | `resolve-question.js:124,182` | `--accept-all` 与 `--answer` 同时给时静默丢弃用户原话；`--answer` 值以 `--` 开头会被判缺失（报错文案误导） | 显式拒绝互斥组合 |

---

## 七、方案清单 vs 实际改动核对

| 方案 §5 清单 | 实际状态 |
|---|---|
| 5.1 schema 加字段 | ✅ 完成（`required` 去掉 `resolved`、`confirmation.required` 简化为 `["answer"]`，见 P2-13） |
| 5.2 `resolve-question.js` | ✅ 新增，三种用法齐备（三条边角见 P2-9/10、P3-15/17/21） |
| 5.3 contracts 四态判定 | ✅ 完成，删除 `isTrulyResolved`/`pseudoResolved`，`unresolved` 兼容并集 |
| 5.4 policy 门控重写 | ✅ 完成，`RECOVERY_SUGGESTIONS` 增删到位，:278 兜底已改指向 |
| 5.5 dispatch A0 + 文案 | ⚠️ 分支已加、文案已改；A0 清单内容不足（P2-8） |
| 5.6 context-refresh 投影 + 摘要 | ⚠️ 投影已改；摘要段已改，但 `:274` 漏改（P1-1） |
| 5.7 prompt-builder 口径段 + 返工例外 | ✅ 完成（`oqReworkNote` 逻辑正确，仅 Phase 0 且已产出 open-questions 时生效） |
| 5.8 需求分析师.md | ✅ 完成（白名单、澄清条款、新增「待确认项的处置」小节） |
| 5.9 SKILL.md 铁律 + blocked 分支 | ✅ 完成 |
| 5.10 phase-0.md 门控表 | ✅ 完成（2 BLOCKER + 1 WARNING） |
| 5.11 session-start / harness-audit | ⚠️ 判定已改；`session-start.js:58` 旧口径残留（P1-2） |
| 5.x 未列入清单但应改 | ❌ `任务规划师.md:86`（P2-5）、`README.md:322`（P2-6） |

**改动面**：方案 13 文件，实际 19 项（17 改 + 2 增），多出的 4 项为 `state.js`（re-export，合理）、`failure-patterns.json`（P1-4）、3 个 agent 的 model（P1-3）。

---

## 八、亮点（建议保留的设计）

1. **单判定函数 + 四态桶 + 兼容并集**：`evaluateOpenQuestion` 作为唯一口径，`checkOpenQuestions` 保留 `exists/allResolved/unresolved/errors` 旧字段，5 个调用方零改动即可切换——向后兼容做得干净。
2. **`confirmed_informal` 作为软约束的启发式补偿**：判断依据（脚本写入必然齐全 vs 手写缺斤短两）站得住，测试对「不计入 unresolved / 放行 / 出 warning」三点都有断言。
3. **`--accept-all` 的落盘策略**：内存内改完一次落盘 + 落盘后校验回滚，比逐条 I/O 正确，也符合 G6 吞吐要求。
4. **污染路径修复彻底**：标题改「用户已确认裁决」、段内区分 `verbatim`/`accept`、并有「AI 自答项不得进段」的专门回归断言——这是本次最核心的病根，修得准确。
5. **注释质量**：普遍写清「修的是什么病、为什么不用直觉方案」。`OPT-PG` 用例改写处还专门解释了为何不能用 `user_confirmation_required`（会被 A0 截获、不产生 `pendingBlockers`），这类说明对后续维护价值很高。

---

## 九、建议的处理顺序

```
第一步（合入前，必须）
  1. git checkout 还原 4 个 agents/*.md 的 model 字段           [P1-3]
  2. git checkout 还原 failure-patterns.json                    [P1-4]
  3. 修 context-refresh.js:274 改走 checkOpenQuestions          [P1-1]
  4. 修 session-start.js:58 强制规则第 1 条                     [P1-2]

第二步（同批可做，成本低收益高）
  5. 任务规划师.md:86 / README.md:322 口径对齐                  [P2-5/6]
  6. dispatch A0 description 带路径与清单                       [P2-8]
  7. resolve-question.js 顶层 try/catch                         [P2-9]
  8. schema-injector 给 confirmation 加注解                     [P2-7]

第三步（下批或独立提交）
  9. --accept-all 与 --force 解耦                               [P2-10]
  10. 静态护栏扫 policy.js 的 structuredError                   [P2-11]
  11. 补 --accept-all 回滚测试                                  [P2-14]
  12. 版本 bump 2.1.0 + 方案 §5.1 回写                          [P2-12/13]
  13. P3 七项清理（可随手带上）
```

---

## 十、附：本次审查覆盖的文件

**已逐行审查**
`contracts.js` / `policy.js` / `dispatch.js` / `context-refresh.js` / `prompt-builder.js` / `session-start.js` / `harness-audit.js` / `state.js` / `open-questions.schema.json` / `resolve-question.js`（新）/ `open-questions-confirmation.test.js`（新）/ `optimization-regression.test.js` / `failure-patterns.json` / `需求分析师.md` / `SKILL.md` / `phase-0.md`

**交叉检索确认无残留**
`isTrulyResolved` / `pseudoResolved` / `pseudo_resolved` / `blocking_unresolved` / `.blocking` / `.resolved` / `blocking`（门控语义）——均已在脚本层清除，仅剩文档与摘要统计两处残留（P1-1、P2-5、P2-6）。
