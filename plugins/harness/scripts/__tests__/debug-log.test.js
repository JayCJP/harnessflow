#!/usr/bin/env node
/**
 * debug-log 单元测试
 *
 * 覆盖：record 基础写入 / seq 递增 / read 过滤（kind/phase/since/limit）/
 *       64KB 截断+指纹 / 静默失败（空 storyId、目录不存在、开关关闭）/
 *       state_change 重建（rebuildStateAt）
 *
 * 无外部依赖，用临时 CLAUDE_PROJECT_DIR 沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/debug-log.test.js
 *   npm test            （在 plugins/harness 下，由 run-all.js 自动发现）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-debuglog-'))
process.env.CODEBUDDY_PROJECT_DIR = SANDBOX
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const debugLog = require(path.join(SCRIPTS_DIR, 'lib/debug-log'))

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
section('1. 开关判定')

ok('默认启用', debugLog.isEnabled() === true)
process.env.HARNESS_DEBUG = '0'
ok('HARNESS_DEBUG=0 关闭', debugLog.isEnabled() === false)
delete process.env.HARNESS_DEBUG
ok('删除环境变量后恢复启用', debugLog.isEnabled() === true)

// ════════════════════════════════════════════════════════════
section('2. record 基础写入与 seq 递增')

state.ensureStoryDir('DBG-1')
ok('record 返回 true', debugLog.record('DBG-1', 'script_output', { status: 'ready' }, { source: 'dispatch.js', phase: 0, durationMs: 12 }))
ok('record 第二条返回 true', debugLog.record('DBG-1', 'hook_decision', { decision: 'deny', reason: 'x' }, { source: 'enforce-dev-pass.js' }))
ok('record 第三条返回 true', debugLog.record('DBG-1', 'method_output', { lint: 'clean' }, { source: 'policy.js', phase: 2 }))

const all = debugLog.read('DBG-1')
ok('read 返回 3 条', all.length === 3, String(all.length))
ok('seq 单调递增 1/2/3', all.map(r => r.seq).join(',') === '1,2,3', all.map(r => r.seq).join(','))
ok('首条字段齐全', all[0].ts && all[0].storyId === 'DBG-1' && all[0].kind === 'script_output' &&
  all[0].source === 'dispatch.js' && all[0].phase === 0 && all[0].durationMs === 12 && all[0].data.status === 'ready')
ok('未提供的可选字段为 null', all[1].phase === null && all[1].durationMs === null)

// ════════════════════════════════════════════════════════════
section('3. read 过滤')

ok('kind 过滤', debugLog.read('DBG-1', { kind: 'hook_decision' }).length === 1)
ok('phase 过滤', debugLog.read('DBG-1', { phase: 2 }).length === 1)
ok('limit 取末尾', debugLog.read('DBG-1', { limit: 2 }).length === 2 &&
  debugLog.read('DBG-1', { limit: 2 })[0].seq === 2)
const since = all[1].ts
ok('since 过滤（含边界）', debugLog.read('DBG-1', { since }).length === 2)
ok('不存在的 story 返回空数组', debugLog.read('NOT-EXIST').length === 0)

// ════════════════════════════════════════════════════════════
section('4. 64KB 截断与指纹')

const bigPayload = { blob: 'x'.repeat(debugLog.MAX_PAYLOAD_CHARS + 1000) }
debugLog.record('DBG-1', 'method_output', bigPayload, { source: 'test' })
const big = debugLog.read('DBG-1', { kind: 'method_output' })
const truncatedRec = big.find(r => r.truncated === true)
ok('超限记录标记 truncated', truncatedRec != null)
ok('截断记录带 sha1 指纹', /^sha1:[0-9a-f]{40}$/.test(truncatedRec.hash), truncatedRec.hash)
ok('指纹可对账（与原文 sha1 一致）',
  truncatedRec.hash === 'sha1:' + crypto.createHash('sha1').update(JSON.stringify(bigPayload)).digest('hex'))
ok('截断记录保留 preview 与原始长度',
  truncatedRec.data._truncated === true && truncatedRec.data._preview.length >= debugLog.MAX_PAYLOAD_CHARS &&
  truncatedRec.data._originalLength > debugLog.MAX_PAYLOAD_CHARS)
ok('未超限记录不截断', all[0].truncated === false && all[0].hash === null)

// ════════════════════════════════════════════════════════════
section('5. 静默失败（绝不抛错）')

ok('空 storyId 返回 false', debugLog.record(null, 'script_output', {}) === false)
ok('目录不存在的 story 返回 false', debugLog.record('NOT-EXIST', 'script_output', {}) === false)
process.env.HARNESS_DEBUG = '0'
ok('开关关闭时 record 返回 false', debugLog.record('DBG-1', 'script_output', {}) === false)
delete process.env.HARNESS_DEBUG
ok('关闭期间未写入新记录', debugLog.read('DBG-1').length === 4)

// ════════════════════════════════════════════════════════════
section('6. state_change 重建（rebuildStateAt）')

state.ensureStoryDir('DBG-2')
debugLog.record('DBG-2', 'state_change', {
  diff: { phase: { from: null, to: 0 } },
  after: { phase: 0, status: 'running', title: '重建测试' }
})
debugLog.record('DBG-2', 'state_change', {
  diff: { phase: { from: 0, to: 1 } },
  after: { phase: 1, status: 'running', title: '重建测试' }
})
debugLog.record('DBG-2', 'state_change', {
  diff: { phase: { from: 1, to: 2 } },
  after: { phase: 2, status: 'running', title: '重建测试' }
})

const latest = debugLog.rebuildStateAt('DBG-2')
ok('省略 uptoSeq 返回最新状态', latest && latest.phase === 2)
const changes = debugLog.read('DBG-2', { kind: 'state_change' })
const mid = debugLog.rebuildStateAt('DBG-2', changes[2].seq)
ok('uptoSeq 重建到历史时刻', mid && mid.phase === 1, JSON.stringify(mid))
ok('无 state_change 的 story 返回 null', debugLog.rebuildStateAt('DBG-1') === null)

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
