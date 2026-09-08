#!/usr/bin/env node
/**
 * 流程回归测试 —— 覆盖 2026-08 的流程改造：
 *   1. fixloop 按失败源独立预算（code-review/test 各 2 次，不共享）
 *   2. unverifiable 不阻塞门控（需求4：无法验证就跳过）
 *   3. 目录级 glob 限域（需求2：files 支持目录 glob）
 *   4. Phase 1→2 门控：figma-frame-inventory 存在性与完整性
 *   5. advance-phase.js 输出契约（2026-09）：只给推进结果 + 怎么 Spawn，
 *      不再回吐 phaseSummaryContent / contractFilesToLoad / agentConstraints /
 *      lessonsFromHistory / metricsInsights（都是 agentPrompt 里已有内容的拷贝）
 *
 * 无外部依赖，用临时沙箱（同时覆盖 CODEBUDDY/CLAUDE_PROJECT_DIR），跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/flow-regression.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前建好，PLANS_DIR 是模块加载期求值的 ──
const sandbox = makeSandbox('harness-flow-')
const SANDBOX = sandbox.root
const storyDir = sandbox.storyDir

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { createWorkflow } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))
const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
const promptBuilder = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))

// ════════════════════════════════════════════════════════════
section('1. fixloop 修复轮次预算')

const c1 = createWorkflow('FL-1', 'fixloop 预算', false, false, 'run')
ok('createWorkflow 成功', c1.success !== false)
const st1 = state.readStateFile('FL-1')
ok('state 含 maxReviewFixRounds=2', st1.maxReviewFixRounds === 2, String(st1.maxReviewFixRounds))
ok('getMaxFixRounds=2', state.getMaxFixRounds('FL-1') === 2)
ok('getMaxFixRounds(缺省 sourcePhase)=review 预算', state.getMaxFixRounds('FL-1') === 2)

// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
section('2. 目录级 glob 判定（getTasksRequiringFigma）')

const dir3 = storyDir('GL-1')
fs.mkdirSync(dir3, { recursive: true })
fs.writeFileSync(path.join(dir3, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog', link: 'x' }] }))
fs.writeFileSync(path.join(dir3, 'task-dag.json'), JSON.stringify({
  tasks: [
    // 目录 glob files → 保守视为 UI 相关（目录下可能含 .vue）
    { id: 'task-1', title: '目录组件', files: ['src/views/pc/modules/**'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' },
    // 纯逻辑 task
    { id: 'task-2', title: 'API', files: ['src/api/index.js'], acceptanceCriteria: ['AC-2'], parallelizable: false }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1', 'task-2'] }]
}))
const tasks = state.getTasksRequiringFigma('GL-1')
ok('目录 glob 的 task-1 被识别为需 Figma', tasks.some(t => t.id === 'task-1'), JSON.stringify(tasks.map(t => t.id)))
ok('纯逻辑 task-2 不被识别', !tasks.some(t => t.id === 'task-2'), JSON.stringify(tasks.map(t => t.id)))

// ════════════════════════════════════════════════════════════
section('3. Phase 1→2 门控：figma-frame-inventory 存在性 & 完整性')

// 场景 A：hasFigmaDesign=true 但 frame-inventory 缺失 → BLOCKER（存在性门控，依赖 requiredWhen:'hasFigmaDesign'）
const dir4a = storyDir('FG1-MISS')
fs.mkdirSync(dir4a, { recursive: true })
fs.writeFileSync(path.join(dir4a, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4a, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-MISS', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4a, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4a, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4a, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
// 刻意不写 figma-frame-inventory.json
const g1 = policy.runGateCheck('FG1-MISS', 1, state.readStateFile('FG1-MISS'))
const missBlocked = g1.blockers.some(b => (b.type === 'artifact_missing') && /figma-frame-inventory\.json/.test(b.message))
ok('hasFigma=true 且 frame-inventory 缺失 -> BLOCKER(artifact_missing)', missBlocked,
  JSON.stringify(g1.blockers.map(b => b.type + ':' + b.message)))

// 场景 B：frame-inventory 存在但内容残缺（缺 link/type）→ BLOCKER（完整性门控 checkFigmaFrameInventory）
const dir4b = storyDir('FG1-BAD')
fs.mkdirSync(dir4b, { recursive: true })
fs.writeFileSync(path.join(dir4b, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4b, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-BAD', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4b, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4b, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4b, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
// frame 缺 link（不完整）
fs.writeFileSync(path.join(dir4b, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog' }] }))
const g2 = policy.runGateCheck('FG1-BAD', 1, state.readStateFile('FG1-BAD'))
const incompleteBlocked = g2.blockers.some(b => b.type === 'figma_frame_incomplete')
ok('frame-inventory 内容残缺（缺 link）-> BLOCKER(figma_frame_incomplete)', incompleteBlocked,
  JSON.stringify(g2.blockers.map(b => b.type + ':' + b.message)))

// 场景 C：frame-inventory 完整（有 id/name/type/link）→ 不再因 frame 内容报 BLOCKER
const dir4c = storyDir('FG1-OK')
fs.mkdirSync(dir4c, { recursive: true })
fs.writeFileSync(path.join(dir4c, 'story-input.json'), JSON.stringify({
  mode: 'run', sources: { figmaUrls: ['https://www.figma.com/design/abc/x'] }
}))
fs.writeFileSync(path.join(dir4c, 'e2e-state.json'), JSON.stringify({ storyId: 'FG1-OK', phase: 1, status: 'running', hasFigmaDesign: true }))
fs.writeFileSync(path.join(dir4c, 'task-dag.md'), '# DAG')
fs.writeFileSync(path.join(dir4c, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'T', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false, figmaNodeId: '3020:1' }
  ],
  batches: [{ batchId: 1, taskIds: ['task-1'] }]
}))
fs.writeFileSync(path.join(dir4c, 'acceptance-criteria.json'), JSON.stringify({
  featurePoints: [{ id: 'FP-1', source: '需求', coverage: 'covered', acIds: ['AC-1'] }],
  criteria: [{ id: 'AC-1', description: '验收', testType: 'ui' }]
}))
fs.writeFileSync(path.join(dir4c, 'figma-frame-inventory.json'), JSON.stringify({ frames: [{ id: '3020:1', name: 'A', type: 'dialog', link: 'https://figma.com/node/3020:1' }] }))
const g3 = policy.runGateCheck('FG1-OK', 1, state.readStateFile('FG1-OK'))
const hasFrameIncomplete = g3.blockers.some(b => b.type === 'figma_frame_incomplete')
ok('frame-inventory 完整（含 link）-> 无 figma_frame_incomplete BLOCKER', !hasFrameIncomplete,
  JSON.stringify(g3.blockers.map(b => b.type + ':' + b.message)))

// ════════════════════════════════════════════════════════════
section('4. advance-phase.js 输出契约（v4: 只含推进结果）')

// FG1-OK 的 Phase 1 产出物齐备且门控通过，直接推到 Phase 2 验真实输出。
// 契约: 推进结果归 advance-phase，「下一步怎么 Spawn」归 dispatch.js。
// 收敛前同一轮推进里 prompt 被生成三次（dispatch 分支 B 的残缺副本 → advance-phase →
// 回 Step 1 后分支 A 那份真正被用的），现在只剩分支 A 那一次。
const adv = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/advance-phase.js'), 'FG1-OK', '2'], {
  encoding: 'utf-8',
  env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
})
// stdout 现在只有 JSON（进度文本走 stderr），可直接解析
let out = null
try { out = JSON.parse(adv.stdout) } catch (e) { /* 下面断言会报 */ }
ok('advance-phase 1→2 输出可解析的 JSON', !!out, (adv.stdout || '').slice(-300) + (adv.stderr || ''))
ok('advance-phase 1→2 推进成功', out && out.success === true,
  out ? JSON.stringify(out.blockers || out.gateChecks) : '')

if (out && out.success === true) {
  // 推进结果本体仍在
  ok('保留推进结果 fromPhase/toPhase', out.fromPhase === 1 && out.toPhase === 2,
    JSON.stringify({ from: out.fromPhase, to: out.toPhase }))
  // 「下一步怎么 Spawn」整组移交 dispatch.js（含 v3 已删的 prompt 素材拷贝）
  for (const dropped of ['nextAgent', 'nextAgentLabel', 'agentPrompt', 'expectedOutputs',
    'fixLoopContext', 'batches', 'instruction',
    'phaseSummaryContent', 'phaseSummaryPhase', 'contractFilesToLoad',
    'agentConstraints', 'lessonsFromHistory', 'metricsInsights']) {
    ok(`不再输出 ${dropped}`, !(dropped in out), JSON.stringify(Object.keys(out)))
  }
  // 摘要仍落盘 —— 回 Step 1 后 dispatch 构造 prompt 时要读它
  ok('摘要正文落盘为 phase-1-summary.md', fs.existsSync(path.join(dir4c, 'phase-1-summary.md')))

  // 推进后回 Step 1: dispatch 是 prompt 的唯一出口。走哪个分支取决于 Phase 2 门控
  // （沙箱无 git 变更时门控空转 → 分支 B），故按分支分别断言契约
  const d2 = dispatch('FG1-OK')
  if (d2.readyToAdvance) {
    // 分支 B: 只给推进命令，不构造 prompt —— 此时摘要虽已生成，但 prompt 该由
    // 推进后再回 Step 1 的分支 A 给出，避免同一轮两份
    // 骨架里这些键恒存在（值为 null），故判定「没有可用内容」而非键不存在
    ok('分支 B 不给出 agentPrompt', !d2.agentPrompt, String(d2.agentPrompt).slice(0, 80))
    ok('分支 B 不给出 nextAgent', !d2.nextAgent, String(d2.nextAgent))
    ok('分支 B 指令要求回 Step 1', /回 Step 1/.test(d2.instruction || ''), d2.instruction)
  } else {
    ok('分支 A 输出 nextAgent', d2.nextAgent === 'frontend-developer', String(d2.nextAgent))
    ok('分支 A 输出 agentPrompt', typeof d2.agentPrompt === 'string' && d2.agentPrompt.length > 0)
  }

  // prompt 内容三要素（dispatch 分支 A 用的就是这个函数与这组参数）
  const pb2 = promptBuilder.buildAgentPrompt({ storyId: 'FG1-OK', targetPhase: 2, summaryPhase: 1 })
  ok('agentPrompt 给出摘要文件路径', /phase-1-summary\.md/.test(pb2.agentPrompt),
    (pb2.agentPrompt.match(/上一 Phase 摘要[\s\S]{0,120}/) || [''])[0])
  ok('agentPrompt 展开契约文件清单', /task-dag\.json/.test(pb2.agentPrompt))
  ok('agentPrompt 展开约束段', /## 约束/.test(pb2.agentPrompt))
}

// ════════════════════════════════════════════════════════════
summarize(sandbox)
