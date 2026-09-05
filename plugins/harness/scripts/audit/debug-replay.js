#!/usr/bin/env node
/**
 * debug-replay.js — 全流程调试日志回放工具（流程回顾分析入口）
 *
 * 职责:
 *   - 读取 story 的 debug.jsonl（载荷层），按时间线渲染全流程回顾报告
 *   - 自动按 state_change 的 phase 跃迁切分阶段段落
 *   - 支持按 kind / phase / since / limit / 归档轮次过滤
 *   - --card 重建任意历史时刻的 story 状态摘要（索引卡）
 *   - --verbose 展开完整 payload，--json 输出原始记录
 *
 * 用法:
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId>
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId> --phase 2 --kind script_output
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId> --round 1        # 读归档轮次
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId> --card           # 重建最新状态摘要
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId> --card 42        # 重建记录 #42 之前的状态
 *   node plugins/harness/scripts/audit/debug-replay.js <storyId> --verbose --out debug/replay.md
 *
 * 使用场景:
 *   - Story 卡住/失败后复盘：「每步 dispatch 说了什么」「门控为什么没过」「哪次编辑被 hook 拒了」
 *   - 查看某 Agent 当时收到的完整 prompt（script_output 的 agentPrompt 字段，--verbose 展开）
 *   - fix-loop 多轮回顾（--kind script_output 里 advance-phase 的 fixLoopContext）
 *
 * 说明:
 *   - 只读工具：不写任何文件（--out 除外），不进 Agent 上下文
 *   - 记录类型见 lib/debug-log.js: script_output / method_output / hook_decision / state_change / agent_report
 *   - 项目根解析与 harness-audit.js 相同：CODEBUDDY_PROJECT_DIR / CLAUDE_PROJECT_DIR / cwd
 *
 * @module debug-replay
 */

const fs = require('fs')
const path = require('path')
const debugLog = require('../lib/debug-log')
const { getPhaseName } = require('../lib/state')

// ─── 参数解析 ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const storyId = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || null

function flagValue (name) {
  const i = args.indexOf(name)
  if (i !== -1 && args[i + 1] != null && !args[i + 1].startsWith('--')) return args[i + 1]
  const prefix = `--${name}=`
  const hit = args.find(a => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : null
}

const opts = {
  kind: flagValue('kind'),
  phase: flagValue('phase') != null ? parseInt(flagValue('phase'), 10) : null,
  since: flagValue('since'),
  limit: flagValue('limit') != null ? parseInt(flagValue('limit'), 10) : null,
  round: flagValue('round') != null ? parseInt(flagValue('round'), 10) : null,
  verbose: args.includes('--verbose'),
  json: args.includes('--json'),
  out: flagValue('out'),
  card: args.includes('--card')
    ? (args[args.indexOf('--card') + 1] != null && /^\d+$/.test(args[args.indexOf('--card') + 1])
        ? parseInt(args[args.indexOf('--card') + 1], 10) : null)
    : (flagValue('card') != null ? parseInt(flagValue('card'), 10) : undefined)
}

if (!storyId) {
  console.error(JSON.stringify({
    error: '用法: node debug-replay.js <storyId> [--phase N] [--kind X] [--since ISO] [--limit N] [--round N] [--verbose] [--json] [--card [seq]] [--out <file>]',
    example: '  node debug-replay.js STORY-001 --phase 2\n  node debug-replay.js STORY-001 --card'
  }, null, 2))
  process.exit(1)
}

// ─── --card：重建任意历史时刻的状态摘要 ────────────────────────

if (opts.card !== undefined) {
  const state = debugLog.rebuildStateAt(storyId, opts.card == null ? undefined : opts.card)
  if (!state) {
    console.error(JSON.stringify({ error: `无 state_change 记录可重建（story=${storyId}）` }, null, 2))
    process.exit(1)
  }
  const lines = [
    `⚡ Story ${storyId}${state.title ? ` 「${state.title}」` : ''}`,
    `   Phase: ${state.phase != null ? `${state.phase} (${getPhaseName(state.phase)})` : '?'} · 状态: ${state.status || '?'}`,
    `   模式: ${state.mode || 'run'} · 更新: ${state.updatedAt || '?'}`,
    state.archivedAt ? `   已归档: round ${state.archiveRound || '?'} @ ${state.archivedAt}` : null
  ].filter(Boolean)
  console.log(lines.join('\n'))
  process.exit(0)
}

// ─── 读取与过滤 ─────────────────────────────────────────────────

const records = debugLog.read(storyId, {
  kind: opts.kind || undefined,
  phase: opts.phase != null ? opts.phase : undefined,
  since: opts.since || undefined,
  limit: opts.limit != null ? opts.limit : undefined,
  round: opts.round != null ? opts.round : undefined
})

if (records.length === 0) {
  console.error(JSON.stringify({
    error: `无调试记录（story=${storyId}${opts.round != null ? ` round=${opts.round}` : ''}）`,
    hint: '确认 storyId 正确；debug.jsonl 在流程运行时自动生成，HARNESS_DEBUG=0 时不会记录'
  }, null, 2))
  process.exit(1)
}

// ─── --json：原始记录直出 ──────────────────────────────────────

if (opts.json) {
  console.log(JSON.stringify(records, null, 2))
  process.exit(0)
}

// ─── 记录摘要（单行） ──────────────────────────────────────────

/**
 * 生成一条记录的单行摘要
 * @param {Object} r - debug 记录
 * @returns {string} 摘要行
 */
function summarize (r) {
  const d = r.data || {}
  const head = []
  switch (r.kind) {
    case 'script_output':
      head.push(r.source || '?', r.durationMs != null ? `${r.durationMs}ms` : '')
      if (d.status != null) head.push(`status=${d.status}`)
      if (d.success === true) head.push('success=true')
      if (d.success === false) head.push('success=false')
      if (d.action) head.push(`action=${d.action}`)
      if (d.nextAgent) head.push(`nextAgent=${d.nextAgent}`)
      if (d.ok != null) head.push(`ok=${d.ok}`)
      if (d.error) head.push(`error=${String(d.error).slice(0, 80)}`)
      break
    case 'hook_decision':
      head.push(`${r.source || d.hook || '?'} · DENY ${d.reason || '?'}`)
      if (d.deniedFile) head.push(`file=${d.deniedFile}`)
      if (d.targetFile) head.push(`target=${d.targetFile}`)
      if (d.filePath) head.push(`file=${String(d.filePath).slice(-60)}`)
      if (d.currentPhase != null) head.push(`phase=${d.currentPhase}`)
      break
    case 'state_change': {
      const pd = d.diff && d.diff.phase
      head.push(pd ? `phase: ${pd.from != null ? pd.from : '∅'} → ${pd.to}` : '字段更新')
      const otherKeys = Object.keys((d && d.diff) || {}).filter(k => k !== 'phase')
      if (otherKeys.length > 0) head.push(`另 ${otherKeys.length} 项字段: ${otherKeys.slice(0, 6).join(',')}${otherKeys.length > 6 ? '…' : ''}`)
      break
    }
    case 'method_output':
      head.push(d.method || r.source || '?')
      if (d.result && typeof d.result === 'object') {
        if (d.result.hasErrors != null) head.push(`hasErrors=${d.result.hasErrors}`)
        if (d.result.skipped != null) head.push(`skipped=${d.result.skipped}`)
        if (d.result.fixed != null) head.push(`fixed=${d.result.fixed}(${d.result.fixedCount})`)
        if (d.result.ok != null) head.push(`ok=${d.result.ok}`)
      }
      break
    case 'agent_report':
      head.push(`${d.tool || '?'} (${d.toolClass || '?'})`)
      head.push(d.responseAvailable ? 'response=✓' : 'response=✗ 未提供')
      break
    default:
      head.push(r.kind)
  }
  return head.filter(Boolean).join(' · ')
}

// ─── 渲染 markdown 时间线 ────────────────────────────────────────

const lines = []
const filters = [
  opts.phase != null ? `phase=${opts.phase}` : null,
  opts.kind ? `kind=${opts.kind}` : null,
  opts.since ? `since=${opts.since}` : null,
  opts.limit != null ? `limit=${opts.limit}` : null,
  opts.round != null ? `round=${opts.round}（归档）` : null
].filter(Boolean)

lines.push(`# Debug 回放 — ${storyId}`)
lines.push('')
lines.push(`> 记录数: ${records.length} · 生成: ${new Date().toISOString()}${filters.length > 0 ? ` · 过滤: ${filters.join(' ')}` : ''}`)
lines.push('')

let lastPhase = null
for (const r of records) {
  // 相位跃迁切分：state_change 的 phase diff 作为段落分隔
  if (r.kind === 'state_change' && r.data && r.data.diff && r.data.diff.phase &&
      r.data.diff.phase.to != null && r.data.diff.phase.to !== lastPhase) {
    const from = r.data.diff.phase.from
    const to = r.data.diff.phase.to
    lines.push('')
    lines.push(`━━━━━━ Phase ${from != null ? from : '∅'} → ${to}（${getPhaseName(to)}） ━━━━━━`)
    lastPhase = to
  }
  const ts = String(r.ts || '').slice(11, 19)
  lines.push(`#${r.seq} ${ts} [${r.kind}] ${summarize(r)}`)
  if (opts.verbose) {
    lines.push('```json')
    lines.push(JSON.stringify(r.data, null, 2))
    lines.push('```')
  }
}

lines.push('')
lines.push(`— 共 ${records.length} 条记录${opts.verbose ? '' : '（--verbose 展开完整 payload）'} —`)

const output = lines.join('\n')

if (opts.out) {
  const outPath = path.resolve(opts.out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, output, 'utf-8')
  console.log(JSON.stringify({ ok: true, storyId, records: records.length, written: outPath }, null, 2))
} else {
  console.log(output)
}
process.exit(0)
