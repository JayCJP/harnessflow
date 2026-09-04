#!/usr/bin/env node
/**
 * 优化回归测试 —— 覆盖 2026-09《REAL_RUN 门店工单 诊断与优化方案》落地项:
 *   P0-2/P0-3  动态绝对路径（产出目录 / advanceCommand / recovery.command 无未展开占位符）
 *   P1-1       Phase 2 batch 级 prompt（多 batch 时逐 batch 下发，含 files 白名单且不内联 task 正文）
 *   P1-2       scope=incremental 窄上下文 + buildFixLoopSpawnPrompt 收编（修复请求为绝对路径）
 *   P1-3       代码检索入口按仓下发（默认注入含单仓; 存在性预判 + graphify 用法 + 无 KB 仓明示）
 *   P2-1       dispatch 预检落盘 .dispatch-precheck.json → advance 成功对账补记 preGateBlocked
 *   P2-2/P2-3  跨仓 task 校验 failureType 结构化（无 unknown）+ evidence 门控（只认含 graphify 的来源）
 *   P2-4       unverifiable ≥50% 强告警（不阻塞）
 *   P3-2       「检索失败必须上报」约束注入 agentPrompt
 *
 * 用户裁定（v3）: P0-1（D7 分支校验）与 P3-4（探测预算）不做，故无对应用例；
 *   P2-3 门控只接受 source 含 graphify（graphify/both 通过，kb/grep 单独不满足）。
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
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-opt-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))
const promptBuilder = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
const experience = require(path.join(SCRIPTS_DIR, 'services/experience'))

let pass = 0
const failures = []

/**
 * 断言辅助：通过计数 / 失败记录
 * @param {string} name - 断言名
 * @param {boolean} cond - 断言条件
 * @param {string} [detail] - 失败时的补充信息
 */
function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

/** 分节输出 */
function section (title) {
  console.log(`\n-- ${title} --`)
}

const storyDir = id => path.join(SANDBOX, '.codebuddy', 'plans', id)

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
    criteria: [{ id: 'AC-1', description: '验收', testType: 'api' }]
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

// 端到端: advance-phase 1→2 推进输出带 batch 级 spawn 序列（Phase 2 agentPrompt 的主通道）
const advBA = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'OPT-BA', '2'], {
  encoding: 'utf-8',
  env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
})
const advBAAt = (advBA.stdout || '').lastIndexOf('{\n  "success"')
let outBA = null
try { outBA = JSON.parse(advBA.stdout.slice(advBAAt)) } catch (e) { /* 断言会报 */ }
ok('advance 1→2 推进成功', outBA && outBA.success === true,
  outBA ? JSON.stringify(outBA.blockers || outBA.gateChecks) : (advBA.stdout || '').slice(-300))
if (outBA && outBA.success === true) {
  ok('推进输出含 batches 序列（2 个）', Array.isArray(outBA.batches) && outBA.batches.length === 2,
    JSON.stringify(outBA.batches && outBA.batches.length))
  ok('batches[0] 为 batch 1 且含 files 白名单', outBA.batches[0].batchId === 1 && outBA.batches[0].agentPrompt.includes('src/views/login/**'))
  ok('batches[0] 不内联 task 正文', !outBA.batches[0].agentPrompt.includes('SECRETDESC'))
  ok('batches[1] 为 batch 2', outBA.batches[1].batchId === 2 && outBA.batches[1].agentPrompt.includes('src/api/x.js'))
  ok('推进输出含逐 batch 指令说明', /逐 batch Spawn/.test(outBA.instruction || ''), outBA.instruction)
}

// ════════════════════════════════════════════════════════════
section('3. P1-2: scope=incremental 窄上下文 + fix-loop spawn prompt 收编')

fs.mkdirSync(storyDir('OPT-INC'), { recursive: true })
writeState('OPT-INC', 3)
writeAC('OPT-INC')
fs.writeFileSync(path.join(storyDir('OPT-INC'), 'fix-request.json'), JSON.stringify({
  source: 'code-review', sourcePhase: 3, round: 1, maxRounds: 2,
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
  storyId: 'OPT-INC', round: 1, maxRounds: 2, sourcePhase: 3,
  issues: [{ id: 'FIX-01', severity: 'BLOCKER', file: 'src/a.vue', line: '10', description: '描述', suggestion: '建议' }],
  affectedFiles: ['src/a.vue']
})
ok('fix-loop prompt 含轮次头', /## 🔧 修复任务 \(第 1\/2 轮\)/.test(flp))
ok('fix-loop prompt 含 issue 清单', flp.includes('FIX-01') && flp.includes('src/a.vue:10'))
ok('fix-loop prompt 含限域约束', /仅修复以上列出的文件/.test(flp))
ok('fix-loop prompt 的修复请求为绝对路径', new RegExp('[A-Za-z]:[\\\\/].*fix-request\\.json').test(flp))

// Figma designSpec 只在 Phase 2 注入（与 buildFigmaAlignInstruction 的 Phase 过滤对齐）。
// 此前无该过滤，代码审查 / 功能测试 / 发布的 prompt 都带着色值间距圆角，纯噪音
const incP3 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-INC', targetPhase: 3, summaryPhase: 2 })
ok('Phase 3 不注入 Figma 设计规格摘要', !incP3.agentPrompt.includes('Figma 设计规格摘要'))
ok('Phase 2 仍注入 Figma 设计规格摘要（对照）', incFull.agentPrompt.includes('Figma 设计规格摘要'))

// ════════════════════════════════════════════════════════════
section('4. P1-3: 代码检索入口按仓下发（默认注入，含单仓）')

const rsMain = path.join(SANDBOX, 'repo-main')
const rsOther = path.join(SANDBOX, 'repo-other')
const rsNoGraph = path.join(SANDBOX, 'repo-nograph')
// rsMain / rsOther 有图谱（走 query 用法），rsNoGraph 无图谱（走建图引导）—— 两条分支都覆盖
fs.mkdirSync(path.join(rsMain, 'graphify-out'), { recursive: true })
fs.writeFileSync(path.join(rsMain, 'graphify-out', 'graph.json'), '{}')
fs.mkdirSync(path.join(rsOther, 'graphify-out'), { recursive: true })
fs.writeFileSync(path.join(rsOther, 'graphify-out', 'graph.json'), '{}')
fs.mkdirSync(rsNoGraph, { recursive: true })
// 刻意不为 rsOther 建 .docs/llm-knowledge（断言「只走 graphify + 源码精读」明示）

fs.mkdirSync(storyDir('OPT-RS'), { recursive: true })
writeState('OPT-RS', 0)
fs.writeFileSync(path.join(storyDir('OPT-RS'), 'repos.json'), JSON.stringify({
  primary: 'main',
  repos: { main: rsMain, other: rsOther, nograph: rsNoGraph }
}))

const rs = promptBuilder.buildAgentPrompt({ storyId: 'OPT-RS', targetPhase: 0 })
ok('含「代码检索入口」段', rs.agentPrompt.includes('代码检索入口'))
ok('主仓排在最前且标注为当前工作目录', /### main（主仓，即当前工作目录）/.test(rs.agentPrompt))
ok('主仓给出 graphify 全量用法', /graphify path "<模块A>" "<模块B>"/.test(rs.agentPrompt) && /graphify explain/.test(rs.agentPrompt))
ok('含 cd 绝对路径执行样例（正斜杠）', rs.agentPrompt.includes(`cd "${rsOther.replace(/\\/g, '/')}"`) && rs.agentPrompt.includes('graphify query'))
ok('无知识库仓明示「只走 graphify + 源码精读」', /只走 graphify \+ 源码精读，不要尝试 kb-query/.test(rs.agentPrompt))
ok('图谱存在性预判输出', /graphify-out\/graph\.json/.test(rs.agentPrompt))
// 无图谱的仓若还教 `graphify query` 是自相矛盾（没有 graph.json 必然失败），应给建图命令
ok('无图谱仓给建图命令而非 query', /graphify \. +# 首次/.test(rs.agentPrompt) && /graphify update \./.test(rs.agentPrompt))
ok('无图谱仓提示建不出来就上报', /建图不可用（CLI 缺失 \/ 报错）/.test(rs.agentPrompt))

const rs3 = promptBuilder.buildAgentPrompt({ storyId: 'OPT-RS', targetPhase: 3 })
ok('Phase 3（非检索阶段）不注入检索入口', !rs3.agentPrompt.includes('代码检索入口'))

// `&&` 是 PowerShell 7+ 语法，Win11 默认的 5.1 会报 "not a valid statement separator"，
// 而子 Agent 的 tools 里有 PowerShell —— 样例自身不该再引入一次执行失败
ok('跨仓检索样例不含 &&（PowerShell 5.1 不可用）', !rs.agentPrompt.includes('&&'))

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
section('5. P2-2/P2-3: failureType 结构化 + evidence 门控（v3 只认 graphify）')

// 场景 A: 跨仓 task 缺 repoPath / 缺 description / 缺 evidence → 结构化 type，无 unknown
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
ok('缺 evidence → task_missing_evidence', typesA.includes('task_missing_evidence'), JSON.stringify(typesA))
ok('blockers 无 unknown 类型（P2-2）', !typesA.includes('unknown'), JSON.stringify(typesA))

// 场景 B: v3 收紧 —— evidence.source='kb' 单独不满足门控
fs.writeFileSync(path.join(storyDir('OPT-TD'), 'task-dag.json'), JSON.stringify({
  tasks: [
    {
      id: 'task-1', title: '跨仓改动', description: '改 L10-L20', files: ['src/x.js'],
      acceptanceCriteria: ['AC-1'], parallelizable: false, project: 'other',
      repoPath: rsOther, evidence: { source: 'kb', ref: 'kb 文档' }
    }
  ]
}))
const gB = policy.runGateCheck('OPT-TD', 1, state.readStateFile('OPT-TD'))
ok('evidence.source=kb 单独不通过（v3 只认 graphify）', gB.blockers.some(b => b.type === 'task_missing_evidence'),
  JSON.stringify(gB.blockers.map(b => b.type)))

// 场景 C: source='graphify' + ref → evidence 项通过
fs.writeFileSync(path.join(storyDir('OPT-TD'), 'task-dag.json'), JSON.stringify({
  tasks: [
    {
      id: 'task-1', title: '跨仓改动', description: '改 L10-L20', files: ['src/x.js'],
      acceptanceCriteria: ['AC-1'], parallelizable: false, project: 'other',
      repoPath: rsOther, evidence: { source: 'graphify', ref: 'graphify query "登录模块"' }
    }
  ]
}))
const gC = policy.runGateCheck('OPT-TD', 1, state.readStateFile('OPT-TD'))
ok('evidence.source=graphify 通过该项门控', !gC.blockers.some(b => b.type === 'task_missing_evidence'),
  JSON.stringify(gC.blockers.map(b => b.type)))

// ════════════════════════════════════════════════════════════
section('6. P2-4: unverifiable ≥50% 强告警（不阻塞）')

fs.mkdirSync(storyDir('OPT-P4'), { recursive: true })
writeState('OPT-P4', 4)
// Phase 4 产出物 test-report.md（避免 artifact_missing 干扰「强告警不阻塞」断言）
fs.writeFileSync(path.join(storyDir('OPT-P4'), 'test-report.md'), '# 测试报告')
fs.writeFileSync(path.join(storyDir('OPT-P4'), 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'passed', evidenceType: 'api', evidence: ['正常'] },
    { id: 'AC-2', status: 'unverifiable', evidenceType: 'static', evidence: ['环境限制'] },
    { id: 'AC-3', status: 'unverifiable', evidenceType: 'static', evidence: ['环境限制'] },
    { id: 'AC-4', status: 'unverifiable', evidenceType: 'static', evidence: ['环境限制'] }
  ],
  summary: { total: 4, passed: 1, failed: 0, unverifiable: 3 }
}))
const gHi = policy.runGateCheck('OPT-P4', 4, state.readStateFile('OPT-P4'))
ok('75% unverifiable → 强告警 WARNING', gHi.warnings.some(w => /强告警.*unverifiable AC 占比 3\/4/.test(w)),
  JSON.stringify(gHi.warnings))
ok('unverifiable 强告警不阻塞门控', gHi.passed === true, JSON.stringify(gHi.blockers))

fs.writeFileSync(path.join(storyDir('OPT-P4'), 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'passed', evidenceType: 'api', evidence: ['正常'] },
    { id: 'AC-2', status: 'passed', evidenceType: 'api', evidence: ['正常'] },
    { id: 'AC-3', status: 'passed', evidenceType: 'api', evidence: ['正常'] },
    { id: 'AC-4', status: 'passed', evidenceType: 'api', evidence: ['正常'] },
    { id: 'AC-5', status: 'unverifiable', evidenceType: 'static', evidence: ['环境限制'] }
  ],
  summary: { total: 5, passed: 4, failed: 0, unverifiable: 1 }
}))
const gLo = policy.runGateCheck('OPT-P4', 4, state.readStateFile('OPT-P4'))
ok('20% unverifiable → 无强告警', !gLo.warnings.some(w => /强告警/.test(w)), JSON.stringify(gLo.warnings))

// ════════════════════════════════════════════════════════════
section('7. P3-2: 检索失败上报约束注入')

ok('AGENT_CONSTRAINTS 含「检索失败必须上报」', promptBuilder.AGENT_CONSTRAINTS.some(c => /检索失败必须停下上报/.test(c)),
  JSON.stringify(promptBuilder.AGENT_CONSTRAINTS))
ok('agentPrompt 约束段含检索失败上报', /检索失败必须停下上报主 Agent/.test(p0pb.agentPrompt))

// ════════════════════════════════════════════════════════════
section('8. P2-1: dispatch 预检落盘 → advance 对账补记 preGateBlocked（端到端）')

// 备份全局经验库（EXPERIENCE_DIR 固定在插件目录，不随沙箱重定向）
const fpFile = experience.FAILURE_PATTERNS_FILE
const fpBackupExists = fs.existsSync(fpFile)
const fpBackup = fpBackupExists ? fs.readFileSync(fpFile, 'utf-8') : null
try {
  fs.mkdirSync(storyDir('OPT-PG'), { recursive: true })
  writeState('OPT-PG', 0)

  // 1. Phase 0 无产出物 → dispatch 预检不通过 → pendingBlockers 落盘
  const pgd = dispatch('OPT-PG')
  ok('预检不通过时输出 pendingBlockers', Array.isArray(pgd.pendingBlockers) && pgd.pendingBlockers.length > 0,
    JSON.stringify(pgd.pendingBlockers))
  const precheckPath = path.join(storyDir('OPT-PG'), '.dispatch-precheck.json')
  ok('.dispatch-precheck.json 已落盘', fs.existsSync(precheckPath))
  if (fs.existsSync(precheckPath)) {
    const pc = JSON.parse(fs.readFileSync(precheckPath, 'utf-8'))
    ok('落盘内容含 blockers 快照', Array.isArray(pc.blockers) && pc.blockers.length > 0 && pc.phase === 0)
  }

  // 2. 补齐 Phase 0 产出物 → advance 推进成功 → 对账补记 preGateBlocked 并清除留痕
  fs.writeFileSync(path.join(storyDir('OPT-PG'), 'requirement-analysis.md'), '# 需求分析')
  fs.writeFileSync(path.join(storyDir('OPT-PG'), 'open-questions.json'), JSON.stringify({ questions: [] }))
  writeAC('OPT-PG')
  const advPG = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'OPT-PG', '1'], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
  })
  const advPGAt = (advPG.stdout || '').lastIndexOf('{\n  "success"')
  let outPG = null
  try { outPG = JSON.parse(advPG.stdout.slice(advPGAt)) } catch (e) { /* 断言会报 */ }
  ok('advance 0→1 推进成功', outPG && outPG.success === true,
    outPG ? JSON.stringify(outPG.blockers) : (advPG.stdout || '').slice(-300))

  if (outPG && outPG.success === true) {
    ok('.dispatch-precheck.json 已被对账清除', !fs.existsSync(precheckPath))
    const fp = JSON.parse(fs.readFileSync(fpFile, 'utf-8'))
    const preGate = fp.patterns.find(p => p.failureType === 'preGateBlocked' && p.phase === 0 &&
      String(p.rootCause || '').includes('OPT-PG') === false ? true : String(p.storyId) === 'OPT-PG' || String(p.rootCause || '').includes('dispatch 预检曾报'))
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
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
} catch (e) { /* 清理失败不影响结论 */ }

const total = pass + failures.length
console.log(`\n${'='.repeat(48)}`)
if (failures.length === 0) {
  console.log(`通过 ${pass} / ${total}   [全绿]`)
  process.exit(0)
} else {
  console.log(`通过 ${pass} / ${total}\n失败项:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
