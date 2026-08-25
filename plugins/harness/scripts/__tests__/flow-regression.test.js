#!/usr/bin/env node
/**
 * 流程回归测试 —— 覆盖 2026-08 的流程改造：
 *   1. fixloop 按失败源独立预算（code-review/test 各 2 次，不共享）
 *   2. unverifiable 不阻塞门控（需求4：无法验证就跳过）
 *   3. 目录级 glob 限域（需求2：files 支持目录 glob）
 *
 * 无外部依赖，用临时沙箱（同时覆盖 CODEBUDDY/CLAUDE_PROJECT_DIR），跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/flow-regression.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-flow-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { createWorkflow } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))

let pass = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

const storyDir = id => path.join(SANDBOX, '.codebuddy', 'plans', id)

// ════════════════════════════════════════════════════════════
section('1. fixloop 独立预算（review/test 各 2 次）')

const c1 = createWorkflow('FL-1', 'fixloop 预算', false, false, 'run')
ok('createWorkflow 成功', c1.success !== false)
const st1 = state.readStateFile('FL-1')
ok('state 含 maxReviewFixRounds=2', st1.maxReviewFixRounds === 2, String(st1.maxReviewFixRounds))
ok('state 含 maxTestFixRounds=2', st1.maxTestFixRounds === 2, String(st1.maxTestFixRounds))
ok('getMaxFixRounds(review)=2', state.getMaxFixRounds('FL-1', 3) === 2)
ok('getMaxFixRounds(test)=2', state.getMaxFixRounds('FL-1', 4) === 2)
ok('getMaxFixRounds(缺省 sourcePhase)=review 预算', state.getMaxFixRounds('FL-1') === 2)

// ════════════════════════════════════════════════════════════
section('2. unverifiable 不阻塞门控')

const dir2 = storyDir('UV-1')
fs.mkdirSync(dir2, { recursive: true })
// 全部 unverifiable 的验收对账（需求4：不阻塞，跳过）
fs.writeFileSync(path.join(dir2, 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'unverifiable', evidenceType: 'static', evidence: ['代码逻辑已验证，需联调环境'] },
    { id: 'AC-2', status: 'unverifiable', evidenceType: 'static', evidence: ['接口参数已适配，待联调'] }
  ],
  summary: { total: 2, passed: 0, failed: 0, unverifiable: 2 }
}))
fs.writeFileSync(path.join(dir2, 'e2e-state.json'), JSON.stringify({ storyId: 'UV-1', phase: 4, status: 'running' }))
const av = state.checkAcceptanceVerification('UV-1')
ok('100% unverifiable -> allPassed=true（不阻塞）', av.allPassed === true, JSON.stringify(av.errors))
ok('unverifiable 被正确归入 unverifiable 列表', av.unverifiable.length === 2)
ok('无 failed', av.failed.length === 0)

// 有 failed 才应阻塞
fs.writeFileSync(path.join(dir2, 'acceptance-verification.json'), JSON.stringify({
  results: [
    { id: 'AC-1', status: 'failed', evidenceType: 'api', evidence: ['接口返回异常'] },
    { id: 'AC-2', status: 'passed', evidenceType: 'api', evidence: ['正常'] }
  ],
  summary: { total: 2, passed: 1, failed: 1, unverifiable: 0 }
}))
const av2 = state.checkAcceptanceVerification('UV-1')
ok('有 failed -> allPassed=false（阻塞）', av2.allPassed === false)

// ════════════════════════════════════════════════════════════
section('3. 目录级 glob 判定（getTasksRequiringFigma）')

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
section('4. Phase 1→2 门控：figma-frame-inventory 存在性 & 完整性')

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
