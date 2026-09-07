# Harness 插件优化总结

> 基于 STORY-20260710-01 流程复盘 + 阿里 Harness 工程化实践文章 + Self-Harness 论文

---

## 一、问题修复 (6项)

### 问题1: Agent篡改e2e-state.json

**原因**: Agent完成任务后自行修改phase字段(1→2)，跳过advance-phase.js门控校验

**解决方案**:
- `advance-phase.js`: 新增`validatePhaseIntegrity()`函数，推进前检测phase是否被篡改，检测到→拒绝推进+输出修复指引
- 6个Agent配置文件: 增加"禁止操作状态文件"约束
- 新增Hook: `enforce-state-file.js`拦截所有对e2e-state.json/dev-pass.json的Write/Edit操作

**效果**: 三层防线→Hook实时拦截 + 脚本拒绝推进 + Agent配置约束

### 问题2: BLOCKER表格行残留导致门控误判

**原因**: 增量审查Agent覆盖code-review.md后旧表格行(| B1 | ... |)未清除，门控正则误判为未修复BLOCKER

**解决方案**:
- 废弃code-review.md，改为code-review.json(status字段唯一信源)
- `policy.js` checkPhase3Gate改为读取JSON的`status === "open"`检测
- 代码审查师Agent产出物改为唯一JSON

**效果**: 不再依赖Markdown正则解析，status字段精确控制门控

### 问题4: ESLint配置缺失

**原因**: `.eslintrc-auto-import.json`由vite build生成但`eslintrc.enabled=false`导致文件缺失

**解决方案**:
- `.eslintrc.cjs`改为`existsSync`条件引用，文件缺失不阻断ESLint
- 临时启用`eslintrc.enabled=true` + `vite build`生成文件后恢复

**效果**: ESLint配置问题不再阻断pre-commit hook

### 问题5: Phase 0复用未提示

**原因**: 工作流回退后Phase 0产出物仍有效，但无复用指引

**解决方案**:
- `advance-phase.js`推进时检测产出物已存在→输出`phase0Reuse`提示字段

**效果**: 主Agent根据提示判断是否跳过Phase 0重新生成

### 问题6: open-questions始终未resolve

**原因**: Q-1(roleName需后端)和Q-2(getSelfTakeStoreList参数)贯穿全流程，Phase 5提交前未检查

**解决方案**:
- `policy.js` checkPhase4Gate增加`checkOpenQuestions()`检查
- 有未resolve项→输出warning提醒用户确认

**效果**: Phase 5前强制提醒，不再遗漏待确认项

### 问题7: Agent prompt缺少上下文

**原因**: 主Agent Spawn子Agent时未注入phaseSummaryContent和contractFilesToLoad

**解决方案**:
- `scripts/services/prompt-builder.js`: Agent prompt 构造的唯一出口，`dispatch.js`与
  `advance-phase.js`均调用它，不各自拼接
- prompt含: Story背景资料(约定式自动发现) + 上一Phase摘要 + 历史教训 + 度量洞察 +
  修复回路上下文 + 契约文件内容 + 产出要求 + 约束
- `harness-conductor` Skill规定: 主Agent原样透传`agentPrompt`，禁止改写或拼接

**效果**: 子Agent从干净上下文启动也能获得完整背景信息；prompt只有一个信源，
主Agent不再需要判断"该注入哪些上下文"

---

## 二、新增方案设计 (3项)

### 新增1: JSON Schema校验体系

**参考**: 阿里Harness文章 — state.json schema前置校验

**内容**:
- 8个Schema文件: acceptance-criteria / open-questions / task-dag / code-review / acceptance-verification / fix-request / fix-verification / e2e-state
- `schema-validator.js`: ajv封装，编译缓存
- `policy.js` runGateCheck集成: 每个Phase推进前校验JSON格式

**效果**: 所有JSON产出物写入前格式校验，非法格式→BLOCKER→阻止推进，错误信息精确到字段级

### 新增2: dispatch.js(只读调度脚本)

**参考**: 阿里Harness文章 — dispatcher状态机+文件交接，主会话退化纯执行器

**内容**:
- `scripts/commands/dispatch.js`: 只读脚本，输出纯JSON调度指令
- Phase→Agent映射表收口到`scripts/lib/state.js`的`PHASE_AGENTS`
- 四态互斥且穷尽: ready / blocked / fix_loop / terminal，无"其他情况自行处理"
- 异常恢复: 冷启动 / fix-loop / open-questions / 归档 / 完成，均由脚本输出`recovery`
- `harness-conductor` Skill改为三步循环: dispatch.js → 按status分支 → 回Step 1

**为什么用脚本而非Agent**: 早期方案是`agents/dispatcher.md`(只读Agent)，已废弃。原因:
查表不该花一次LLM往返，更不该承担幻觉风险；该Agent声称"只读"却持有Bash工具，
是状态文件保护的唯一无人看守通道；其输出混有自然语言TODO，迫使主Agent自己读文件、
自己判断——判断权回流即失控。脚本的只读性由代码本身保证，可审计。

**效果**: 主Agent从"读+决策+执行"退化到"只按指令执行"，消除自主决策导致的流程错误

### 新增3: harness-evolve 自进化Skill

**参考**: Self-Harness论文(上海AI Lab, 2026) + harness-audit.js + metrics-aggregator.js

**内容**:
- 五步闭环: 体检(audit) → 度量(metrics) → 诊断(mining) → 治疗(proposal) → 验证(validation)
- 三级经验进化: lesson(单次记录) → pattern(跨Story归纳) → instinct(自动注入Agent prompt)
- 接受规则: fix-loop↓或BLOCKER↓→采纳，性能退化→拒绝，无变化→inconclusive
- 采纳后自动重新audit评分验证效果

**效果**: 数据驱动的Harness自我改进，不靠感觉改规则，每次改动都有数据支撑

---

## 三、修改文件清单

### Harness插件脚本
| 文件 | 修改内容 |
|------|---------|
| `scripts/commands/advance-phase.js` | 完整性校验 + phase0Reuse + 调用prompt-builder + extractFixIssuesFromReview(JSON信源) |
| `scripts/services/policy.js` | checkPhase3Gate(JSON信源) + checkPhase4Gate(open-questions) + schema校验 |
| `scripts/lib/state.js` | Phase 3产出物改为code-review.json |
| `hooks/hooks.json` | 新增enforce-state-file.js Hook |

### 新增文件
| 文件 | 用途 |
|------|------|
| `scripts/hooks/enforce-state-file.js` | 状态文件写保护Hook |
| `scripts/services/schema-validator.js` | ajv Schema校验服务 |
| `scripts/schemas/*.schema.json` (8个) | JSON产出物Schema定义 |
| `scripts/commands/dispatch.js` | 只读调度脚本(取代dispatcher Agent) |
| `scripts/services/prompt-builder.js` | Agent prompt构造唯一出口 |
| `skills/harness-evolve/SKILL.md` | 自进化Skill |
| `commands/evolve.md` | /harness-evolve 命令 |

### Agent配置文件 (6个全部更新)
- 需求分析师: 新增状态文件约束
- 任务规划师: 产出物要求+状态文件约束
- 前端开发工程师: 状态文件约束
- 代码审查师: 产出物改为code-review.json + 状态文件约束
- 测试工程师: FIX_DATA改为JSON + 状态文件约束
- 发布助手: 状态文件约束

### Skill
- `harness-conductor`: 三步循环(dispatch.js → 按status分支 → 回Step 1) + agentPrompt原样透传规范

### 项目文件
- `CODEBUDDY.md`: Agent行为约束 + Phase 0复用规则 + Phase 3门控注意事项 + open-questions处理 + Agent Prompt注入规范 + ESLint修复说明
- `.docs/llm-knowledge/frontend/meta.yaml`: API定义章节(13个文件200+接口) + settings/chat/group-chat域更新
- `.docs/llm-knowledge/frontend/business/settings/overview.md`: v1.5.0更新
- `.docs/llm-knowledge/frontend/business/chat/overview.md`: v1.2.0更新
- `.eslintrc.cjs`: existsSync条件引用

---

## 四、验证结果

- 语法校验: 所有JS文件通过 `node --check`
- Schema校验: 7项测试全部通过(合法通过+非法拦截)
- 模拟测试: 8项验证全部通过(完整性校验+Hook拦截+Agent约束+schema等)
- JSON格式: 8个schema文件全部通过 `JSON.parse` 验证
