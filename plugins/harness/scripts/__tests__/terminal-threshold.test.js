#!/usr/bin/env node
/**
 * terminal-threshold.test.js — 主流程终态阈值与 Phase 重排回归
 *
 * 覆盖 2.3.1 的阶段重排：主流程 = 审查 → 知识库更新 → Git 提交（含建 MR），
 * 走完 Git 提交即写 status='completed'，云端部署为可选阶段。
 *
 * 断言:
 *   1. phase=4 且 running → 非终态（知识库更新尚未完成后不得自动 end / 归档）
 *   2. phase=5 且 completed → 终态
 *   3. phase=6 且 completed → 终态（可选阶段不改变终态判定）
 *   4. 归档在 phase < 5 且不带 --force 时拒绝；phase=5 时可归档
 *   5. PHASE_SLUGS 顺序与 MAIN_FLOW_END_PHASE / OPTIONAL_PHASES 常量一致
 *
 * 环境变量必须在 require 之前设置：paths.js 的 PROJECT_ROOT / PLANS_DIR 是模块加载期求值。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-terminal-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX

const PLANS = path.join(SANDBOX, '.codebuddy', 'plans')
const SCRIPTS = path.join(__dirname, '..')

const phases = require('../lib/phases')
const storyState = require('../lib/story-state')

let pass = 0
const fails = []
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + name) } else { fails.push(name); console.log('  FAIL ' + name + (detail ? '  ->  ' + JSON.stringify(detail) : '')) }
}
function section (title) { console.log('\n-- ' + title + ' --') }

/**
 * 构造指定 phase / status 的 e2e-state.json
 * @param {string} id - Story ID
 * @param {number} phase - 当前 Phase
 * @param {string} status - running / completed
 * @returns {void}
 */
function writeState (id, phase, status) {
  const dir = path.join(PLANS, id)
  fs.mkdirSync(dir, { recursive: true })
  const phaseMap = {}
  phases.PHASE_SLUGS.forEach((slug, i) => {
    phaseMap[i + '_' + slug] = { status: i < phase ? 'completed' : (i === phase ? 'running' : 'pending') }
  })
  fs.writeFileSync(path.join(dir, 'e2e-state.json'), JSON.stringify({
    storyId: id, title: 't', phase, status, phases: phaseMap, gateChecks: {}
  }, null, 2))
}

// ════════════════════════════════════════════════════════════
section('1. 阶段表顺序与常量')

ok('7 Phase + 终态槽位', phases.PHASE_SLUGS.length === 8, phases.PHASE_SLUGS.length)
ok('Phase 4 = 知识库更新', phases.PHASE_SLUGS[4] === 'knowledge_base_update', phases.PHASE_SLUGS[4])
ok('Phase 5 = Git 提交', phases.PHASE_SLUGS[5] === 'git_submit', phases.PHASE_SLUGS[5])
ok('Phase 6 = 云端部署', phases.PHASE_SLUGS[6] === 'deployment', phases.PHASE_SLUGS[6])
ok('MAIN_FLOW_END_PHASE = 5', phases.MAIN_FLOW_END_PHASE === 5, phases.MAIN_FLOW_END_PHASE)
ok('OPTIONAL_PHASES = [6]', JSON.stringify(phases.OPTIONAL_PHASES) === '[6]', phases.OPTIONAL_PHASES)

// ════════════════════════════════════════════════════════════
section('2. 终态阈值提前到 Git 提交阶段')

writeState('TT-4', 4, 'running')
ok('phase=4 running → 非终态', storyState.isWorkflowTerminal(storyState.readStateFile('TT-4')) === false)

writeState('TT-5', 5, 'completed')
ok('phase=5 completed → 终态', storyState.isWorkflowTerminal(storyState.readStateFile('TT-5')) === true)

writeState('TT-6', 6, 'completed')
ok('phase=6 completed → 终态（可选阶段不改变判定）', storyState.isWorkflowTerminal(storyState.readStateFile('TT-6')) === true)

writeState('TT-3', 3, 'running')
ok('phase=3 running → 非终态', storyState.isWorkflowTerminal(storyState.readStateFile('TT-3')) === false)

// ════════════════════════════════════════════════════════════
section('3. 归档门槛跟随主流程终点')

const archiveScript = path.join(SCRIPTS, 'commands', 'archive-story.js')
/**
 * 执行归档并返回 { status, stdout }
 * @param {string} id - Story ID
 * @param {string[]} extra - 附加参数
 * @returns {{ status: number, stdout: string }}
 */
function runArchive (id, extra) {
  try {
    const stdout = execFileSync(process.execPath, [archiveScript, id, 'archive'].concat(extra || []), {
      encoding: 'utf-8',
      env: Object.assign({}, process.env, { CODEBUDDY_PROJECT_DIR: SANDBOX }),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, stdout }
  } catch (e) {
    return { status: e.status, stdout: (e.stdout || '').toString() }
  }
}

writeState('TT-ARCH-4', 4, 'running')
const beforeDone = runArchive('TT-ARCH-4', ['--dry-run'])
ok('phase=4 不带 --force 拒绝归档', beforeDone.status === 1, beforeDone.stdout.slice(0, 200))

const forced = runArchive('TT-ARCH-4', ['--dry-run', '--force'])
ok('phase=4 带 --force 可归档（dry-run 通过）', forced.status === 0, forced.stdout.slice(0, 200))

writeState('TT-ARCH-5', 5, 'completed')
const afterDone = runArchive('TT-ARCH-5', ['--dry-run'])
ok('phase=5 直接可归档（dry-run）', afterDone.status === 0, afterDone.stdout.slice(0, 200))

// ════════════════════════════════════════════════════════════
fs.rmSync(SANDBOX, { recursive: true, force: true })

console.log('\n' + '='.repeat(48))
console.log('通过 ' + pass + ' / ' + (pass + fails.length) + (fails.length === 0 ? '   [全绿]' : '   [有失败]'))
if (fails.length > 0) {
  fails.forEach(f => console.log('  - ' + f))
  process.exit(1)
}
