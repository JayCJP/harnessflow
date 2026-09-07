#!/usr/bin/env node
/**
 * advance-phase.js CLI 契约测试 —— 参数解析与 targetPhase 独立校验
 *
 * 覆盖此前完全无测试的一层: advance-phase.js 是相位跃迁的唯一执行者，
 * 它对入参的独立裁定（范围、步长、storyId 解析歧义）此前只有注释、没有断言。
 *
 * 覆盖:
 *   1. 缺参 / 只给 storyId → 用法提示 + exit 1
 *   2. e2e-state.json 不存在 → exit 1
 *   3. targetPhase 越界（> MAX_PHASE）→ 拒绝，不写状态
 *   4. 步长非 +1: 倒退 / 跨 Phase → 分别给出 --rollback 与逐 Phase 指引
 *   5. 参数解析歧义: 纯数字 storyId（TAPD 需求 ID）+ phase、plans/ 前缀剥离
 *   6. stdout 输出契约: 只含一份 JSON（进度文本走 stderr），可直接 JSON.parse
 *
 * 用法:
 *   node scripts/__tests__/advance-phase.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前建好（原因见 _helpers.js 头注释）──
const sandbox = makeSandbox('harness-advance-')
const SANDBOX = sandbox.root
const storyDir = sandbox.storyDir

const ADVANCE = path.join(SCRIPTS_DIR, 'commands/advance-phase.js')

/**
 * 跑一次 advance-phase.js
 * @param {...string} args - CLI 参数
 * @returns {{ status: number, json: Object|null, stdout: string, stderr: string }}
 */
function run (...args) {
  const r = spawnSync(process.execPath, [ADVANCE, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }
  })
  let json = null
  try { json = JSON.parse(r.stdout) } catch (e) { /* 断言会报 */ }
  return { status: r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/** 写一个最小可用的 e2e-state.json */
function writeState (id, phase) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(
    path.join(storyDir(id), 'e2e-state.json'),
    JSON.stringify({ storyId: id, phase, status: 'running', phases: {} }, null, 2)
  )
}

// ════════════════════════════════════════════════════════════
section('1. 缺参与用法提示')

const noArgs = run()
ok('无参数 exit 1', noArgs.status === 1, String(noArgs.status))
ok('无参数输出可解析 JSON', !!noArgs.json, noArgs.stdout.slice(0, 120))
ok('无参数给出用法', noArgs.json && /用法/.test(noArgs.json.error), noArgs.json && noArgs.json.error)

const onlyStory = run('AP-1')
ok('只给 storyId exit 1', onlyStory.status === 1, String(onlyStory.status))

// ════════════════════════════════════════════════════════════
section('2. 状态文件缺失')

const noState = run('AP-NONE', '2')
ok('state 不存在 exit 1', noState.status === 1, String(noState.status))
ok('state 不存在给出原因', noState.json && /e2e-state\.json/.test(noState.json.error),
  noState.json && noState.json.error)

// ════════════════════════════════════════════════════════════
section('3. targetPhase 越界')

writeState('AP-1', 0)
const over = run('AP-1', '99')
ok('越界 exit 1', over.status === 1, String(over.status))
ok('越界报越界原因', over.json && /越界/.test(over.json.error), over.json && over.json.error)
ok('越界不写状态', JSON.parse(fs.readFileSync(path.join(storyDir('AP-1'), 'e2e-state.json'), 'utf-8')).phase === 0)

// ════════════════════════════════════════════════════════════
section('4. 步长必须为 +1')

writeState('AP-2', 2)
const backward = run('AP-2', '1')
ok('倒退 exit 1', backward.status === 1, String(backward.status))
ok('倒退提示禁止倒退', backward.json && /禁止倒退推进/.test(backward.json.error),
  backward.json && backward.json.error)
ok('倒退给出 --rollback 指引', backward.json && /--rollback/.test(backward.json.fixCommand || ''),
  backward.json && backward.json.fixCommand)

writeState('AP-3', 0)
const skip = run('AP-3', '3')
ok('跨 Phase exit 1', skip.status === 1, String(skip.status))
ok('跨 Phase 提示禁止跨越', skip.json && /禁止跨 Phase 推进/.test(skip.json.error),
  skip.json && skip.json.error)
ok('跨 Phase 列出被跳过的环节', skip.json && Array.isArray(skip.json.whyBlocked) && skip.json.whyBlocked.length > 0)
ok('跨 Phase 的 fixCommand 指向下一个 Phase', skip.json && / 1$/.test(skip.json.fixCommand || ''),
  skip.json && skip.json.fixCommand)

// ════════════════════════════════════════════════════════════
section('5. 参数解析歧义')

// 纯数字 storyId（TAPD 需求 ID）: 第一个纯数字为 storyId，最后一个为 targetPhase
writeState('888888', 0)
const numeric = run('888888', '3')
ok('纯数字 storyId 被正确识别', numeric.json && numeric.json.storyId === '888888',
  numeric.json && String(numeric.json.storyId))
ok('纯数字场景仍走步长校验', numeric.json && /禁止跨 Phase 推进/.test(numeric.json.error || ''))

// plans/ 前缀应被剥离
const prefixed = run('plans/AP-2', '1')
ok('plans/ 前缀被剥离', prefixed.json && prefixed.json.storyId === 'AP-2',
  prefixed.json && String(prefixed.json.storyId))

// ════════════════════════════════════════════════════════════
section('6. stdout 输出契约')

ok('stdout 只含 JSON（无进度文本混排）', skip.stdout.trim().startsWith('{') && skip.stdout.trim().endsWith('}'),
  skip.stdout.slice(0, 80))

// ════════════════════════════════════════════════════════════
summarize(sandbox)
