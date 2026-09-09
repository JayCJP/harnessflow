#!/usr/bin/env node
/**
 * 优化回归测试 —— 覆盖 2026-09《REAL_RUN 门店工单 诊断与优化方案》落地项:
 *   P0-2/P0-3  动态绝对路径（产出目录 / advanceCommand / recovery.command 无未展开占位符）
 *   P1-1       Phase 2 batch 级 prompt（多 batch 时逐 batch 下发，含 files 白名单且不内联 task 正文）
 *   P1-2       scope=incremental 窄上下文 + buildFixLoopSpawnPrompt 收编（修复请求为绝对路径）
 *   P1-3       代码检索入口（只下发仓目录 + /graphify skill 指引；不再逐仓预判存在性/给样例）
 *   P2-1       dispatch 预检落盘 .dispatch-precheck.json → advance 成功对账补记 preGateBlocked
 *   P2-2      跨仓 task 校验 failureType 结构化（无 unknown）+ 行号引用门控
 *   P2-4       unverifiable ≥50% 强告警（不阻塞）
 *   P3-2       「检索失败必须上报」约束注入 agentPrompt
 *
 * 用户裁定（v3）: P0-1（D7 分支校验）与 P3-4（探测预算）不做，故无对应用例；
 *   evidence 门控（原 P2-3 强制 source 含 graphify）已移除，graphify 仅作 prompt 提示。
 *
 * 无外部依赖，用临时沙箱（同时覆盖 CODEBUDDY/CLAUDE_PROJECT_DIR），跑完自动清理。
 * P2-1 的端到端用例会写全局 failure-patterns.json（EXPERIENCE_DIR 固定在插件目录、
 * 不随沙箱重定向），测试前后做备份/还原，不污染真实经验库。
 *
 * 用法:
 *   node scripts/__tests__/optimization-regression.test.js
 *   npm test            （在 plugins/harness 下，run-all.js 自动发现）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前建好，PLANS_DIR 是模块加载期求值的 ──
const sandbox = makeSandbox('harness-opt-')
const SANDBOX = sandbox.root
const storyDir = sandbox.storyDir

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))
const promptBuilder = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
const experience = require(path.join(SCRIPTS_DIR, 'services/experience'))
const schemaInjector = require(path.join(SCRIPTS_DIR, 'services/schema-injector'))

/**
 * 写 e2e-state.json（Phase N running）
 * @param {string} id - Story ID
 * @param {number} phase - Phase 编号
 */
function writeState (id, phase) {
  fs.writeFileSync(path.join(storyDir(id), 'e2e-state.json'),
    JSON.stringify({ storyId: id, phase, status: 'running' }))
}

/**
 * 写合规格式的 acceptance-criteria.json
 * @param {string} id - Story ID
 */
function writeAC (id) {
  fs.writeFileSync(path.join(storyDir(id), 'acceptance-criteria.json'), JSON.stringify({
    featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
    criteria: [{ id: 'AC-1', description: '验收' }]
  }))
}

// ════════════════════════════════════════════════════════════
section('1. P0-2/P0-3: 动态绝对路径（无未展开占位符）')

fs.mkdirSync(storyDir('OPT-P0'), { recursive: true })
writeState('OPT-P0', 0)

const p0pb = promptBuilder.buildAgentPrompt({ storyId: 'OPT-P0', targetPhase: 0 })
ok('产出目录为动态解析的绝对路径', /产出目录: [A-Za-z]:[\\/]/.test(p0pb.agentPrompt), p0pb.agentPrompt.match(/产出目录: .*/g))
ok('产出目录不再给相对路径', !/产出目录: \.codebuddy\//.test(p0pb.agentPrompt))
ok('注入路径为正斜杠形式（规避 markdown 渲染层吃 \\）', !p0pb.agentPrompt.includes('\\.codebuddy') && /:\/[^\\]*plans/.test(p0pb.agentPrompt),
  JSON.stringify(p0pb.agentPrompt.match(/产出目录: .*/g)))

const p0d = dispatch('OPT-P0')
ok('dispatch 正常返回（Phase 0 预检不通过走分支 A）', p0d.status === 'ready' && p0d.advanceCommand !== null)
ok('advanceCommand 不含未展开的 ${', !p0d.advanceCommand.includes('${'), p0d.advanceCommand)
ok('advanceCommand 为绝对路径', /[A-Za-z]:[\\/]/.test(p0d.advanceCommand), p0d.advanceCommand)
ok('advanceCommand 为正斜杠形式', p0d.advanceCommand.includes(':/') && !p0d.advanceCommand.includes('\\'), p0d.advanceCommand)

const cold = dispatch('OPT-NOEXIST')
ok('冷启动 recovery.command 不含未展开的 ${', !String(cold.recovery.command).includes('${'), cold.recovery.command)
ok('冷启动 recovery.command 为绝对路径', /[A-Za-z]:[\\/]/.test(cold.recovery.command), cold.recovery.command)

// ════════════════════════════════════════════════════════════
section('2. P1-1: Phase 2 batch 级 prompt（多 batch 逐批下发）')

fs.mkdirSync(storyDir('OPT-BA'), { recursive: true })
writeState('OPT-BA', 1)
writeAC('OPT-BA')
fs.writeFileSync(path.join(storyDir('OPT-BA'), 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(storyDir('OPT-BA'), 'task-dag.json'), JSON.stringify({
  tasks: [
    // description 里埋独特标记：batch 段只给 id/title/files 白名单，不应内联正文
    { id: 'task-1', title: '登录页', description: 'SECRETDESC-不应内联-L10-L20', files: ['src/views/login/**'], acceptanceCriteria: ['AC-1'], parallelizable: true },
    { id: 'task-2', title: '接口', description: 'L30-L40', files: ['src/api/x.js'], acceptanceCriteria: ['AC-1'], parallelizable: false }
  ],
  batches: [
    { batchId: 1, taskIds: ['task-1'] },
    { batchId: 2, taskIds: ['task-2'] }
  ]
}))

const tb = promptBuilder.readTaskBatches('OPT-BA')
ok('readTaskBatches 解析出 2 个 batch', tb.batches.length === 2, JSON.stringify(tb.batches.length))

const ba1 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-BA', targetPhase: 2, batchId: 1 })
ok('batch 1 prompt 含「本批次任务范围（batch 1/2）」', /本批次任务范围（batch 1\/2/.test(ba1.agentPrompt))
ok('batch 1 prompt 含 task 清单', ba1.agentPrompt.includes('task-1') && !/task清单.*task-2/.test(ba1.agentPrompt))
ok('batch 1 prompt 含 files 白名单', ba1.agentPrompt.includes('src/views/login/**'))
ok('batch 1 prompt 不内联 task 正文（description）', !ba1.agentPrompt.includes('SECRETDESC'))
ok('batchScope 元信息正确', ba1.batchScope && ba1.batchScope.taskIds.join() === 'task-1' && ba1.batchScope.totalBatches === 2,
  JSON.stringify(ba1.batchScope))

// 无 batches 字段 → 向后兼容（单批语义）
fs.mkdirSync(storyDir('OPT-NB'), { recursive: true })
fs.writeFileSync(path.join(storyDir('OPT-NB'), 'task-dag.json'), JSON.stringify({
  tasks: [{ id: 'task-1', title: 'T', files: ['src/a.js'], acceptanceCriteria: ['AC-1'], parallelizable: false }]
}))
ok('无 batches 字段时 readTaskBatches 返回空数组（单批兼容）', promptBuilder.readTaskBatches('OPT-NB').batches.length === 0)

// 端到端: 推进到 Phase 2 后，dispatch 输出 batch 级 spawn 序列（Phase 2 的唯一主通道）
const advBA = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'OPT-BA', '2'], {
  encoding: 'utf-8',
  env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
})
let outBA = null
try { outBA = JSON.parse(advBA.stdout) } catch (e) { /* 断言会报 */ }
ok('advance 1→2 推进成功', outBA && outBA.success === true,
  outBA ? JSON.stringify(outBA.blockers || outBA.gateChecks) : (advBA.stdout || '').slice(-300))
if (outBA && outBA.success === true) {
  // 推进结果本身不再带 spawn 序列（职责归 dispatch）
  ok('推进输出不再含 batches', !('batches' in outBA), JSON.stringify(Object.keys(outBA)))
  ok('推进输出不再含 agentPrompt', !('agentPrompt' in outBA), JSON.stringify(Object.keys(outBA)))

  // 回 Step 1 后 dispatch 是批次序列的唯一出口。沙箱无 git 变更时 Phase 2 门控空转
  // （走分支 B，按契约不产出 batches），故批次内容用同一信源直调验证。
  // 空值守卫: 字段缺失时只判失败，不让 TypeError 中断后续用例（此前会中断第 8、9 段）
  const seqBA = dispatch('OPT-BA')
  const bs = Array.isArray(seqBA.batches) ? seqBA.batches : []
  const seq = promptBuilder.buildBatchSequence({ storyId: 'OPT-BA', summaryPhase: 1 })
  const sb = seq.batches
  const b0 = sb[0] || {}
  const b1 = sb[1] || {}
  const p0 = String(b0.agentPrompt || '')
  const p1 = String(b1.agentPrompt || '')
  ok('buildBatchSequence 产出 2 个 batch', sb.length === 2, JSON.stringify(sb.length))
  ok('batches[0] 为 batch 1 且含 files 白名单', b0.batchId === 1 && p0.includes('src/views/login/**'),
    JSON.stringify({ id: b0.batchId, has: p0.includes('src/views/login/**') }))
  ok('batches[0] 不内联 task 正文', !p0.includes('SECRETDESC'))
  ok('batches[1] 为 batch 2', b1.batchId === 2 && p1.includes('src/api/x.js'),
    JSON.stringify({ id: b1.batchId, has: p1.includes('src/api/x.js') }))
  ok('含逐 batch 指令说明', /逐 batch Spawn/.test(seq.instruction || ''), seq.instruction)
  // 单批/无 batches 时不产出序列（避免给主 Agent 一层无意义的批次包装）
  ok('单批 Story 不产出 batch 序列', promptBuilder.buildBatchSequence({ storyId: 'OPT-NB', summaryPhase: 1 }).batches.length === 0)
  // 分支 B 按契约不产出 spawn 序列（prompt 归推进后的分支 A）
  ok('分支 B 不产出 batches', bs.length === 0, JSON.stringify({ readyToAdvance: seqBA.readyToAdvance, n: bs.length }))
}

// ════════════════════════════════════════════════════════════
section('3. P1-2: scope=incremental 窄上下文 + fix-loop spawn prompt 收编')

fs.mkdirSync(storyDir('OPT-INC'), { recursive: true })
writeState('OPT-INC', 3)
writeAC('OPT-INC')
fs.writeFileSync(path.join(storyDir('OPT-INC'), 'fix-request.json'), JSON.stringify({
  source: 'code-review',
  sourcePhase: 3,
  round: 1,
  maxRounds: 2,
  issues: [{ id: 'FIX-01', severity: 'BLOCKER', file: 'src/a.vue', line: '10', description: '描述', suggestion: '建议' }],
  affectedFiles: ['src/a.vue']
}))
// 构造会膨胀 full prompt 的素材：Figma designSpec（frame-inventory）
fs.writeFileSync(path.join(storyDir('OPT-INC'), 'figma-frame-inventory.json'), JSON.stringify({
  frames: [{ id: '3020:1', name: 'A', type: 'dialog', link: 'x', designSpec: '红色按钮 8px 圆角' }]
}))

const incFull = promptBuilder.buildAgentPrompt({ storyId: 'OPT-INC', targetPhase: 2, summaryPhase: 3 })
ok('full 模式（对照）含 Figma 设计规格摘要', incFull.agentPrompt.includes('Figma 设计规格摘要'))

const inc = promptBuilder.buildAgentPrompt({ storyId: 'OPT-INC', targetPhase: 2, summaryPhase: 3, scope: 'incremental' })
ok('incremental 模式注入「增量修复上下文（窄范围）」', inc.agentPrompt.includes('增量修复上下文（窄范围）'))
ok('incremental 模式给 fix-request.json 绝对路径', /增量修复上下文[\s\S]*[A-Za-z]:[\\/] .*fix-request\.json|fix-request\.json/.test(inc.agentPrompt) && inc.agentPrompt.includes('fix-request.json'))
ok('incremental 模式跳过 Figma 设计规格摘要', !inc.agentPrompt.includes('Figma 设计规格摘要'))

const flp = promptBuilder.buildFixLoopSpawnPrompt({
  storyId: 'OPT-INC',
  round: 1,
  maxRounds: 2,
  sourcePhase: 3,
  issues: [{ id: 'FIX-01', severity: 'BLOCKER', file: 'src/a.vue', line: '10', description: '描述', suggestion: '建议' }],
  affectedFiles: ['src/a.vue']
})
ok('fix-loop prompt 含轮次头', /## 🔧 修复任务 \(第 1\/2 轮\)/.test(flp))
ok('fix-loop prompt 含 issue 清单', flp.includes('FIX-01') && flp.includes('src/a.vue:10'))
ok('fix-loop prompt 含限域约束', /仅修复以上列出的文件/.test(flp))
ok('fix-loop prompt 的修复请求为绝对路径', /[A-Za-z]:[\\/].*fix-request\.json/.test(flp))

// Figma designSpec 只在 Phase 2 注入（与 buildFigmaAlignInstruction 的 Phase 过滤对齐）。
// 此前无该过滤，代码审查 / 功能测试 / 发布的 prompt 都带着色值间距圆角，纯噪音
const incP3 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-INC', targetPhase: 3, summaryPhase: 2 })
ok('Phase 3 不注入 Figma 设计规格摘要', !incP3.agentPrompt.includes('Figma 设计规格摘要'))
ok('Phase 2 仍注入 Figma 设计规格摘要（对照）', incFull.agentPrompt.includes('Figma 设计规格摘要'))

// ════════════════════════════════════════════════════════════
section('4. 代码检索入口（只下发仓目录 + /graphify skill 指引）')

const rsMain = path.join(SANDBOX, 'repo-main')
const rsOther = path.join(SANDBOX, 'repo-other')
const rsNoGraph = path.join(SANDBOX, 'repo-nograph')
// 图谱/知识库仍造出来，是为了断言「**即使存在**也不再逐仓展开」——
// 存在性预判与命令样例已移交给 /graphify skill，脚本只留脚本才知道的事实（目录 + cwd 规则）
fs.mkdirSync(path.join(rsMain, 'graphify-out'), { recursive: true })
fs.writeFileSync(path.join(rsMain, 'graphify-out', 'graph.json'), '{}')
fs.mkdirSync(path.join(rsOther, 'graphify-out'), { recursive: true })
fs.writeFileSync(path.join(rsOther, 'graphify-out', 'graph.json'), '{}')
fs.mkdirSync(rsNoGraph, { recursive: true })

fs.mkdirSync(storyDir('OPT-RS'), { recursive: true })
writeState('OPT-RS', 0)
fs.writeFileSync(path.join(storyDir('OPT-RS'), 'repos.json'), JSON.stringify({
  primary: 'main',
  repos: { main: rsMain, other: rsOther, nograph: rsNoGraph }
}))

const rs = promptBuilder.buildAgentPrompt({ storyId: 'OPT-RS', targetPhase: 0 })
const rsPosix = p => p.replace(/\\/g, '/')
ok('含「代码检索入口」段', rs.agentPrompt.includes('代码检索入口'))
ok('主仓排在最前',
  rs.agentPrompt.indexOf('- main（主仓，即当前工作目录）') < rs.agentPrompt.indexOf('- other →'))
ok('每个仓各占一行（正斜杠绝对路径）',
  [`- main（主仓，即当前工作目录） → \`${rsPosix(rsMain)}\``,
    `- other → \`${rsPosix(rsOther)}\``,
    `- nograph → \`${rsPosix(rsNoGraph)}\``].every(s => rs.agentPrompt.includes(s)))
ok('注明走 /graphify skill', rs.agentPrompt.includes('/graphify') && rs.agentPrompt.includes('graphify query'))
ok('保留 cwd 解析提示（跨仓须先 cd，48% 空转根因）', /按 \*\*cwd\*\* 解析/.test(rs.agentPrompt))
// 精简核心：逐仓的存在性预判 / 建图引导 / bash 样例全部移除
ok('不再逐仓输出图谱存在性预判', !/graphify 图谱:/.test(rs.agentPrompt))
ok('不再输出知识库存在性分支', !/只走 graphify \+ 源码精读/.test(rs.agentPrompt))
ok('不再输出建图命令样例', !/graphify \. +# 首次/.test(rs.agentPrompt) && !/graphify update \./.test(rs.agentPrompt))
ok('不再输出逐仓 cd 执行样例', !rs.agentPrompt.includes(`cd "${rsPosix(rsOther)}"`))

const rs3 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-RS', targetPhase: 3 })
ok('Phase 3（非检索阶段）不注入检索入口', !rs3.agentPrompt.includes('代码检索入口'))

// `&&` 是 PowerShell 7+ 语法，Win11 默认的 5.1 会报 "not a valid statement separator"，
// 而子 Agent 的 tools 里有 PowerShell —— 任何注入的命令样例都不该引入一次执行失败
ok('检索入口不含 &&（PowerShell 5.1 不可用）', !rs.agentPrompt.includes('&&'))

// batch 段的主仓名取 repos.json 的真实 primary，不是「主仓(primary)」占位符 ——
// 占位符在 repos.json 里查不到对应键，等于给了子 Agent 一个假名字
fs.writeFileSync(path.join(storyDir('OPT-RS'), 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: '主仓改动', files: ['src/a.ts'] },
    { id: 'task-2', title: '跨仓改动', files: ['src/b.ts'], project: 'other', repoPath: rsOther }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }, { batchId: 2, taskIds: ['task-2'] }]
}))
const rsBatch1 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-RS', targetPhase: 2, summaryPhase: 1, batchId: 1 })
ok('batch 目标仓用 repos.json 真实 primary 名', /本批次目标仓: main/.test(rsBatch1.agentPrompt) && !/主仓\(primary\)/.test(rsBatch1.agentPrompt))
ok('batchScope.repos 用真实 primary 名', rsBatch1.batchScope.repos.includes('main'))

// 单仓 Story 同样注入 —— 约束说了「必须用双源」却不给用法时，子 Agent 依旧退回文本搜索。
// 此前该段只在 repos.json 有非 primary 条目时才输出，等于单仓 Story 完全没有检索引导
fs.mkdirSync(storyDir('OPT-SG'), { recursive: true })
writeState('OPT-SG', 0)
fs.writeFileSync(path.join(storyDir('OPT-SG'), 'repos.json'), JSON.stringify({
  primary: 'main',
  repos: { main: rsMain }
}))
const single = promptBuilder.buildAgentPrompt({ storyId: 'OPT-SG', targetPhase: 0 })
ok('单仓 Story 也注入检索入口（默认引导）', single.agentPrompt.includes('代码检索入口'))
ok('单仓检索入口含 graphify query 用法', /graphify query "<模块\/关键词>"/.test(single.agentPrompt))
ok('单仓不出现 cd 样例（cwd 已在主仓）', !single.agentPrompt.includes('cd "'))

// ════════════════════════════════════════════════════════════
section('5. P2-2: failureType 结构化 + 跨仓行号引用门控')

// 场景 A: 跨仓 task 缺 repoPath / 缺 description → 结构化 type，无 unknown
fs.mkdirSync(storyDir('OPT-TD'), { recursive: true })
writeState('OPT-TD', 1)
writeAC('OPT-TD')
fs.writeFileSync(path.join(storyDir('OPT-TD'), 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(storyDir('OPT-TD'), 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: '跨仓改动', files: ['src/x.js'], acceptanceCriteria: ['AC-1'], parallelizable: false, project: 'other' }
  ]
}))
const gA = policy.runGateCheck('OPT-TD', 1, state.readStateFile('OPT-TD'))
const typesA = gA.blockers.map(b => b.type)
ok('缺 repoPath → task_missing_repo_path', typesA.includes('task_missing_repo_path'), JSON.stringify(typesA))
ok('缺 description → task_missing_description', typesA.includes('task_missing_description'), JSON.stringify(typesA))
ok('缺 evidence 不再卡门控（graphify 仅作 prompt 提示）', !typesA.includes('task_missing_evidence'), JSON.stringify(typesA))
ok('blockers 无 unknown 类型（P2-2）', !typesA.includes('unknown'), JSON.stringify(typesA))

// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
section('6. P3-2: 检索失败上报约束注入')

ok('AGENT_CONSTRAINTS 含「检索失败必须上报」', promptBuilder.AGENT_CONSTRAINTS.some(c => /检索失败必须停下上报/.test(c)),
  JSON.stringify(promptBuilder.AGENT_CONSTRAINTS))
ok('agentPrompt 约束段含检索失败上报', /检索失败必须停下上报主 Agent/.test(p0pb.agentPrompt))

// ════════════════════════════════════════════════════════════
section('7. P2-1: dispatch 预检落盘 → advance 对账补记 preGateBlocked（端到端）')

// 备份全局经验库（EXPERIENCE_DIR 固定在插件目录，不随沙箱重定向）
const fpFile = experience.FAILURE_PATTERNS_FILE
const fpBackupExists = fs.existsSync(fpFile)
const fpBackup = fpBackupExists ? fs.readFileSync(fpFile, 'utf-8') : null
try {
  fs.mkdirSync(storyDir('OPT-PG'), { recursive: true })
  writeState('OPT-PG', 0)

  // 产出物齐全，但 open-questions 含阻塞级待确认项 → dispatch 预检失败于 blocking_unresolved。
  // 必须用真实 blocker（非 artifact_missing）：reconcile 有意排除 artifact_missing —— 首次派单产出物
  // 未落盘是「还没做」而非「做了但没过门控」，不该沉淀 preGateBlocked；只有真实 blocker 修复后才补记。
  fs.writeFileSync(path.join(storyDir('OPT-PG'), 'requirement-analysis.md'), '# 需求分析')
  fs.writeFileSync(path.join(storyDir('OPT-PG'), 'open-questions.json'),
    JSON.stringify({ questions: [{ id: 'Q-1', question: '阻塞级待确认项', resolved: false, blocking: true }] }))
  writeAC('OPT-PG')

  // 1. dispatch 预检：因阻塞级待确认项失败 → pendingBlockers 落盘 .dispatch-precheck.json
  const pgd = dispatch('OPT-PG')
  ok('预检因真实 blocker 失败并输出 pendingBlockers',
    Array.isArray(pgd.pendingBlockers) && pgd.pendingBlockers.length > 0,
    JSON.stringify(pgd.pendingBlockers))
  const precheckPath = path.join(storyDir('OPT-PG'), '.dispatch-precheck.json')
  ok('.dispatch-precheck.json 已落盘', fs.existsSync(precheckPath))
  if (fs.existsSync(precheckPath)) {
    const pc = JSON.parse(fs.readFileSync(precheckPath, 'utf-8'))
    ok('落盘 blockers 为非 artifact_missing 的真实类型',
      Array.isArray(pc.blockers) && pc.blockers.length > 0 && pc.phase === 0 &&
      pc.blockers.every(b => (b.type || 'unknown') !== 'artifact_missing'),
      JSON.stringify((pc.blockers || []).map(b => b.type || 'unknown')))
  }

  // 2. 修复阻塞项（清空 open-questions）→ advance 推进成功 → 对账补记 preGateBlocked 并清除留痕
  fs.writeFileSync(path.join(storyDir('OPT-PG'), 'open-questions.json'), JSON.stringify({ questions: [] }))
  const advPG = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'OPT-PG', '1'], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
  })
  let outPG = null
  try { outPG = JSON.parse(advPG.stdout) } catch (e) { /* 断言会报 */ }
  ok('advance 0→1 推进成功', outPG && outPG.success === true,
    outPG ? JSON.stringify(outPG.blockers) : (advPG.stdout || '').slice(-300))

  if (outPG && outPG.success === true) {
    ok('.dispatch-precheck.json 已被对账清除', !fs.existsSync(precheckPath))
    const fp = JSON.parse(fs.readFileSync(fpFile, 'utf-8'))
    const preGate = fp.patterns.find(p =>
      p.failureType === 'preGateBlocked' && p.phase === 0 &&
      (String(p.storyId) === 'OPT-PG' || String(p.rootCause || '').includes('OPT-PG')))
    ok('failure-patterns.json 补记 preGateBlocked', !!preGate,
      JSON.stringify(fp.patterns.filter(p => p.failureType === 'preGateBlocked').map(p => p.phase)))
  }
} finally {
  // 还原全局经验库，测试产生的 preGateBlocked 记录不进入生产库
  try {
    if (fpBackupExists) {
      fs.writeFileSync(fpFile, fpBackup, 'utf-8')
    } else if (fs.existsSync(fpFile)) {
      fs.unlinkSync(fpFile)
    }
  } catch (e) { /* 还原失败不影响结论输出 */ }
}

// ════════════════════════════════════════════════════════════
section('8. 结构化 issues: type 必须已登记在 RECOVERY_SUGGESTIONS')

// 护栏: contracts.js 现在在产生处用 pushIssue 标记 failureType，policy.js 不再做
// 字符串关键词反推。新增校验时若写了一个未登记的 type，blocker 会静默落 unknown，
// 经验库就只能进「待人工补录」—— 与 P2-2 要消灭的 D4 是同一个问题。
// 这里静态扫描 contracts.js 的 pushIssue 调用，把漏登记挡在提交前。
const contractsSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib/contracts.js'), 'utf-8')
const pushedTypes = [...contractsSrc.matchAll(/pushIssue\(\s*result\s*,\s*'([a-z_]+)'/g)].map(m => m[1])
ok('contracts.js 至少提取到 15 个 pushIssue type', pushedTypes.length >= 15, `实际 ${pushedTypes.length}`)

const registeredTypes = Object.keys(policy.RECOVERY_SUGGESTIONS)
const unregistered = [...new Set(pushedTypes)].filter(t => !registeredTypes.includes(t))
ok('所有 pushIssue type 均已登记 RECOVERY_SUGGESTIONS', unregistered.length === 0,
  `未登记: ${unregistered.join(', ')}`)

// errors 必须与 issues 一一对应 —— 否则外部消费者（dispatch/audit/validate-contracts）
// 读到的字符串视图会与结构化数据漂移
fs.mkdirSync(storyDir('OPT-IS'), { recursive: true })
writeState('OPT-IS', 1)
fs.writeFileSync(path.join(storyDir('OPT-IS'), 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 't', files: ['src/x.js'], acceptanceCriteria: [], parallelizable: false },
    { title: '无 id', files: ['src/y.js'], acceptanceCriteria: ['AC-1'], parallelizable: false }
  ]
}))
const isAc = state.checkAcceptanceCriteria('OPT-IS')
const isTd = state.checkTaskDagJson('OPT-IS')
for (const [name, chk] of [['checkTaskDagJson', isTd], ['checkAcceptanceCriteria', isAc]]) {
  ok(`${name} 同时返回 issues 与 errors`, Array.isArray(chk.issues) && Array.isArray(chk.errors))
  ok(`${name} 的 errors 与 issues 一一对应`,
    chk.errors.length === chk.issues.length && chk.issues.every(i => chk.errors.includes(i.message)),
    `errors=${JSON.stringify(chk.errors)} issues=${JSON.stringify(chk.issues.map(i => i.type))}`)
}
ok('errors 仍是纯字符串（未破坏外部消费者）',
  isTd.errors.every(e => typeof e === 'string'), JSON.stringify(isTd.errors))
ok('issues 带 type/level/resolution',
  isTd.issues.length > 0 && isTd.issues.every(i => i.type && typeof i.level === 'number' && i.resolution),
  JSON.stringify(isTd.issues))

// ════════════════════════════════════════════════════════════
section('9. ③ 方案 B: agentPrompt 注入契约 schema 骨架')

const sk = schemaInjector.buildContractSchemaSection
// 骨架必须覆盖本次 3 次违规的根因：字段类型、嵌套白名单、顶层封闭性
const skTd = sk(1)
ok('Phase 1 注入 task-dag.json 骨架', skTd.includes('`task-dag.json`'))
ok('含顶层字段白名单 + 必填', /顶层 字段白名单/.test(skTd) && /顶层 必填: `tasks`/.test(skTd))
ok('含 tasks[] 元素字段白名单', /`tasks\[\]` 元素 字段白名单/.test(skTd))
ok('estimate 类型明示为 integer（本次 estimate: should be integer 违规）',
  /`estimate`\(integer\)/.test(skTd), skTd.split('\n').find(l => l.includes('estimate')))
ok('顶层与元素层都标注 additionalProperties: false',
  (skTd.match(/additionalProperties: false/g) || []).length >= 2)

const skCr = sk(3)
ok('Phase 3 注入 code-review.json 骨架', skCr.includes('`code-review.json`'))
ok('下探嵌套对象 summary（覆盖 summary.notes 白名单外违规）',
  /`summary` 字段白名单/.test(skCr) && /`summary` `additionalProperties: false`/.test(skCr))
ok('枚举取值一并给出（severity / status）',
  /`severity`\(enum: BLOCKER\|WARNING\|SUGGESTION\)/.test(skCr) &&
  /`status`\(enum: open\|fixed\|skipped\)/.test(skCr))

ok('Phase 0 注入两个契约骨架（acceptance-criteria + open-questions）',
  sk(0).includes('`acceptance-criteria.json`') && sk(0).includes('`open-questions.json`'))
// Phase 2 只产出 git diff，无契约 → 不该注入，否则是噪音
ok('Phase 2（无契约产出物）不注入骨架', sk(2) === '')
// 无对应 schema 文件的契约（figma-frame-inventory.json）静默跳过，不占位数
ok('无 schema 文件的契约静默跳过', !skTd.includes('figma-frame-inventory'))

// 体积护栏：骨架定位是「比全文省、比只给路径有效」，单 Phase 不应失控
ok('单 Phase 骨架不超过 2KB（成本护栏）',
  [0, 1, 3].every(p => sk(p).length <= 2048), JSON.stringify([0, 1, 3].map(p => sk(p).length)))

// 端到端：骨架确实进了 agentPrompt，且排在产出要求之后
fs.mkdirSync(storyDir('OPT-SK'), { recursive: true })
writeState('OPT-SK', 1)
const skPb = promptBuilder.buildAgentPrompt({ storyId: 'OPT-SK', targetPhase: 1 })
ok('agentPrompt 含 schema 骨架段', skPb.agentPrompt.includes('产出物 JSON Schema'))
ok('骨架排在「产出要求」之后（先说产出什么，再说格式）',
  skPb.agentPrompt.indexOf('## 产出要求') < skPb.agentPrompt.indexOf('产出物 JSON Schema'))

// ════════════════════════════════════════════════════════════
summarize(sandbox)
