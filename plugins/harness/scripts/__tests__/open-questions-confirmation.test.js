#!/usr/bin/env node
/**
 * open-questions 用户确认门控回归测试（v4 口径）
 *
 * 覆盖 2026-10-20 裁定的门控重构：
 *   - 放行只看 confirmation 字段（用户确认记录），resolved/resolution/blocking 全部退出门控
 *   - 四态分类: confirmed / confirmed_informal / pending_confirmation / no_proposal
 *   - confirmation 软约束: 格式不规范（缺 confirmedVia/confirmedAt）的确认放行但记 warning
 *   - resolve-question.js 三种用法: --answer 用户原话 / --accept 采纳建议稿 / --accept-all 原子批量
 *
 * 无外部依赖，用临时 CLAUDE_PROJECT_DIR 沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/open-questions-confirmation.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require 被测模块之前建好，两个环境变量都要覆盖（原因见 _helpers.js 头注释）──
const sandbox = makeSandbox('harness-oq-confirm-')
const storyDir = sandbox.storyDir

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { checkOpenQuestions, evaluateOpenQuestion } = require(path.join(SCRIPTS_DIR, 'lib/contracts'))
const { runGateCheck } = require(path.join(SCRIPTS_DIR, 'services/policy'))

/**
 * 准备一个 Phase 0 产出物齐全的 Story（除 open-questions 内容由参数决定）
 * @param {string} id - Story ID
 * @param {Array} questions - open-questions.json 的 questions 数组
 * @returns {void}
 */
function writePhase0Story (id, questions) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'e2e-state.json'), JSON.stringify({
    storyId: id, title: '测试需求', phase: 0, status: 'running'
  }, null, 2))
  fs.writeFileSync(path.join(storyDir(id), 'requirement-analysis.md'), '# 需求分析\n')
  fs.writeFileSync(path.join(storyDir(id), 'acceptance-criteria.json'), JSON.stringify({
    criteria: [{ id: 'AC-1', description: '验收标准一' }]
  }, null, 2))
  fs.writeFileSync(path.join(storyDir(id), 'open-questions.json'), JSON.stringify({ questions }, null, 2))
}

/**
 * 跑 Phase 0→1 门控（policy.js runGateCheck，与 advance-phase.js 调用同一入口）
 * @param {string} id - Story ID
 * @returns {Object} { passed, blockers, warnings, recoveries, _meta }
 */
function gate (id) {
  return runGateCheck(id, 0, state.readStateFile(id))
}

const CONFIRMED_AT = '2026-10-20T15:30:00+08:00'

// ────────────────────────────────────────────────────────────────
section('1. 待用户确认（有建议稿 + 无 confirmation）')
{
  writePhase0Story('OQ-1', [
    { id: 'Q-1', question: '导出是否含附件？', blocking: true, source: '原型 P3', resolution: '建议含附件', resolutionSource: 'prototype' },
    { id: 'Q-2', question: '列表默认排序？', blocking: false, source: '原型 P4', resolution: '按更新时间倒序', resolutionSource: 'prototype' }
  ])
  const c = checkOpenQuestions('OQ-1')
  ok('pendingConfirmation 长度 = 2', c.pendingConfirmation.length === 2, JSON.stringify(c.pendingConfirmation.map(q => q.id)))
  ok('noProposal 长度 = 0', c.noProposal.length === 0)
  ok('unresolved = 2（向后兼容字段 = 未确认项并集）', c.unresolved.length === 2)
  const g = gate('OQ-1')
  ok('门控 passed=false', g.passed === false, JSON.stringify(g.blockers))
  ok('failureType=user_confirmation_required',
    g.blockers.some(b => b.type === 'user_confirmation_required'),
    JSON.stringify(g.blockers.map(b => b.type)))

  // dispatch 分支 A0: 待用户确认走 blocked 态转人工，而非重新 Spawn 分析员
  const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
  const d = dispatch('OQ-1')
  ok('dispatch status=blocked', d.status === 'blocked', d.status)
  ok('recovery.type=user_confirmation_required 且 command=null',
    d.recovery && d.recovery.type === 'user_confirmation_required' && d.recovery.command === null,
    JSON.stringify(d.recovery))
}

// ────────────────────────────────────────────────────────────────
section('2. 全部已确认 → 放行')
{
  writePhase0Story('OQ-2', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', confirmation: { answer: '不含附件', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } },
    { id: 'Q-2', question: '列表默认排序？', resolution: '按更新时间倒序', confirmation: { answer: '按更新时间倒序', confirmedVia: 'accept', confirmedAt: CONFIRMED_AT } }
  ])
  const c = checkOpenQuestions('OQ-2')
  ok('confirmed 长度 = 2', c.confirmed.length === 2)
  ok('allResolved = true', c.allResolved === true)
  const g = gate('OQ-2')
  ok('门控 passed=true', g.passed === true, JSON.stringify(g.blockers))
}

// ────────────────────────────────────────────────────────────────
section('3. 缺建议稿（空 resolution + 无 confirmation）')
{
  writePhase0Story('OQ-3', [
    { id: 'Q-1', question: '并发上限？', blocking: false }
  ])
  const c = checkOpenQuestions('OQ-3')
  ok('noProposal 长度 = 1', c.noProposal.length === 1)
  ok('pendingConfirmation 长度 = 0', c.pendingConfirmation.length === 0)
  const g = gate('OQ-3')
  ok('门控 passed=false', g.passed === false, JSON.stringify(g.blockers))
  ok('failureType=open_questions_unresolved（缺建议稿，与待用户确认分开）',
    g.blockers.some(b => b.type === 'open_questions_unresolved') &&
    !g.blockers.some(b => b.type === 'user_confirmation_required'),
    JSON.stringify(g.blockers.map(b => b.type)))
}

// ────────────────────────────────────────────────────────────────
section('4. 存量兼容：resolved:true 不能绕过确认')
{
  // 存量形态：AI 自答 resolved:true + resolution 非空，但无 confirmation → 仍判待确认
  writePhase0Story('OQ-4', [
    { id: 'Q-1', question: '导出是否含附件？', blocking: true, resolved: true, resolution: '按导出全部字段处理' }
  ])
  const c = checkOpenQuestions('OQ-4')
  ok('判为 pendingConfirmation（不被 resolved 字段绕过）', c.pendingConfirmation.length === 1 && c.confirmed.length === 0)
  const g = gate('OQ-4')
  ok('门控 passed=false', g.passed === false, JSON.stringify(g.blockers))
}

// ────────────────────────────────────────────────────────────────
section('5. 不分 blocking：非阻塞项未确认同样拦截')
{
  writePhase0Story('OQ-5', [
    { id: 'Q-1', question: '列表默认排序？', blocking: false, resolution: '按更新时间倒序', resolutionSource: 'prototype' }
  ])
  const g = gate('OQ-5')
  ok('blocking:false 未确认 → 门控 passed=false', g.passed === false, JSON.stringify(g.blockers))
}

// ────────────────────────────────────────────────────────────────
section('6. confirmedInformal：格式不规范的确认放行 + warning')
{
  writePhase0Story('OQ-6', [
    // 有 answer 但缺 confirmedVia/confirmedAt —— 脚本写入必然字段齐全，缺斤短两疑似手写
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', confirmation: { answer: '不含附件' } },
    { id: 'Q-2', question: '列表默认排序？', resolution: '按更新时间倒序', confirmation: { answer: '按更新时间倒序', confirmedVia: 'accept', confirmedAt: CONFIRMED_AT } }
  ])
  const c = checkOpenQuestions('OQ-6')
  ok('confirmedInformal 长度 = 1', c.confirmedInformal.length === 1, JSON.stringify(c.confirmedInformal.map(q => q.id)))
  ok('confirmedInformal 不计入 unresolved', c.unresolved.length === 0 && c.allResolved === true)
  const g = gate('OQ-6')
  ok('门控 passed=true（放行）', g.passed === true, JSON.stringify(g.blockers))
  ok('门控产出格式 warning（疑似未经 resolve-question.js 写入）',
    g.warnings.some(w => w.includes('confirmedVia') && w.includes('Q-1')),
    JSON.stringify(g.warnings))

  // evaluateOpenQuestion 四态直测
  ok('evaluateOpenQuestion: confirmed', evaluateOpenQuestion({ resolution: 'x', confirmation: { answer: 'a', confirmedVia: 'accept', confirmedAt: CONFIRMED_AT } }).state === 'confirmed')
  ok('evaluateOpenQuestion: confirmed_informal', evaluateOpenQuestion({ resolution: 'x', confirmation: { answer: 'a' } }).state === 'confirmed_informal')
  ok('evaluateOpenQuestion: pending_confirmation', evaluateOpenQuestion({ resolution: 'x' }).state === 'pending_confirmation')
  ok('evaluateOpenQuestion: no_proposal', evaluateOpenQuestion({}).state === 'no_proposal')
  ok('evaluateOpenQuestion: confirmation.answer 纯空白视同未确认', evaluateOpenQuestion({ resolution: 'x', confirmation: { answer: '   ', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } }).state === 'pending_confirmation')
}

// ────────────────────────────────────────────────────────────────
// resolve-question.js 用例通过 spawnSync 跑真实 CLI（与主 Agent 调用路径一致）
const { spawnSync } = require('child_process')
const RESOLVE_CMD = path.join(SCRIPTS_DIR, 'commands', 'resolve-question.js')

/**
 * 调用 resolve-question.js CLI
 * @param {string[]} args - 命令参数（不含脚本路径）
 * @returns {{ code: number, out: Object|null }} 退出码与解析后的 stdout JSON
 */
function runResolve (...args) {
  const r = spawnSync(process.execPath, [RESOLVE_CMD, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, CODEBUDDY_PROJECT_DIR: sandbox.root, CLAUDE_PROJECT_DIR: sandbox.root }
  })
  let out = null
  try { out = JSON.parse(r.stdout) } catch (e) { /* 断言会报 */ }
  return { code: r.status, out }
}

/**
 * 读取沙箱内某 Story 的 open-questions.json
 * @param {string} id - Story ID
 * @returns {Object} 解析后的 JSON
 */
function readOq (id) {
  return JSON.parse(fs.readFileSync(path.join(storyDir(id), 'open-questions.json'), 'utf-8'))
}

section('7. resolve-question.js --accept（采纳建议稿）')
{
  writePhase0Story('OQ-7', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', resolutionSource: 'prototype' },
    { id: 'Q-2', question: '并发上限？' } // 无建议稿
  ])
  const r1 = runResolve('OQ-7', '--qid', 'Q-1', '--accept')
  ok('--accept 成功', r1.code === 0 && r1.out && r1.out.ok === true, JSON.stringify(r1.out))
  const q1 = readOq('OQ-7').questions.find(q => q.id === 'Q-1')
  ok('confirmation.answer = 建议稿快照', q1.confirmation && q1.confirmation.answer === '建议含附件', JSON.stringify(q1.confirmation))
  ok('confirmedVia=accept 且 confirmedAt 齐全', q1.confirmation.confirmedVia === 'accept' && !!q1.confirmation.confirmedAt)
  ok('pending 列出剩余未确认项', Array.isArray(r1.out.pending) && r1.out.pending.includes('Q-2'), JSON.stringify(r1.out.pending))

  const r2 = runResolve('OQ-7', '--qid', 'Q-2', '--accept')
  ok('无建议稿时 --accept 拒绝', r2.code === 1 && r2.out && r2.out.ok === false, JSON.stringify(r2.out))

  // trace 留痕（不落答案全文）
  const tracePath = path.join(storyDir('OQ-7'), 'trace.jsonl')
  const traces = fs.existsSync(tracePath)
    ? fs.readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    : []
  const ud = traces.filter(t => t.type === 'user_decision')
  ok('trace 落 user_decision 事件', ud.length >= 1 && ud[0].qid === 'Q-1', JSON.stringify(traces.map(t => t.type)))
  ok('trace 不落答案全文', ud.every(t => typeof t.answerLength === 'number' && !t.answer), JSON.stringify(ud))
}

// ────────────────────────────────────────────────────────────────
section('8. resolve-question.js --answer 校验')
{
  writePhase0Story('OQ-8', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件' }
  ])
  const r1 = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '   ')
  ok('--answer 纯空白拒绝', r1.code === 1 && r1.out && r1.out.ok === false, JSON.stringify(r1.out))

  const r2 = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '不含附件')
  ok('--answer 用户原话成功', r2.code === 0 && r2.out.ok === true, JSON.stringify(r2.out))
  const q1 = readOq('OQ-8').questions.find(q => q.id === 'Q-1')
  ok('confirmation 为用户原话 + verbatim', q1.confirmation.answer === '不含附件' && q1.confirmation.confirmedVia === 'verbatim')
}

// ────────────────────────────────────────────────────────────────
section('9. resolve-question.js 重复确认与不存在的 qid')
{
  const r1 = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '改判：含附件')
  ok('重复确认默认拒绝', r1.code === 1 && r1.out.ok === false, JSON.stringify(r1.out))

  const r2 = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '改判：含附件', '--force')
  ok('--force 覆盖成功', r2.code === 0 && r2.out.ok === true, JSON.stringify(r2.out))
  const q1 = readOq('OQ-8').questions.find(q => q.id === 'Q-1')
  ok('旧值留 history', q1.confirmation.answer === '改判：含附件' &&
    Array.isArray(q1.confirmation.history) && q1.confirmation.history.length === 1 &&
    q1.confirmation.history[0].answer === '不含附件',
  JSON.stringify(q1.confirmation))

  const r3 = runResolve('OQ-8', '--qid', 'Q-99', '--answer', 'x')
  ok('不存在的 qid 拒绝', r3.code === 1 && r3.out.ok === false, JSON.stringify(r3.out))
}

// ────────────────────────────────────────────────────────────────
section('9b. resolve-question.js --accept-all（原子批量采纳）')
{
  writePhase0Story('OQ-9', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', confirmation: { answer: '不含附件', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } },
    { id: 'Q-2', question: '列表默认排序？', resolution: '按更新时间倒序' },
    { id: 'Q-3', question: '并发上限？', resolution: '建议 10', resolutionSource: 'inference' },
    { id: 'Q-4', question: '缺建议稿的项' }
  ])
  const r = runResolve('OQ-9', '--accept-all')
  ok('--accept-all 成功', r.code === 0 && r.out && r.out.ok === true, JSON.stringify(r.out))
  ok('confirmed = [Q-2, Q-3]', Array.isArray(r.out.confirmed) && r.out.confirmed.join(',') === 'Q-2,Q-3', JSON.stringify(r.out.confirmed))
  ok('skipped 含已确认项与缺建议稿项（注明原因）',
    Array.isArray(r.out.skipped) && r.out.skipped.length === 2 &&
    r.out.skipped.some(s => s.qid === 'Q-1') && r.out.skipped.some(s => s.qid === 'Q-4'),
    JSON.stringify(r.out.skipped))
  ok('pending 仅剩缺建议稿项 Q-4', r.out.pending.join(',') === 'Q-4', JSON.stringify(r.out.pending))

  const data = readOq('OQ-9')
  const q1 = data.questions.find(q => q.id === 'Q-1')
  ok('已确认项不被 --accept-all 覆盖', q1.confirmation.answer === '不含附件' && q1.confirmation.confirmedVia === 'verbatim')
  const q2 = data.questions.find(q => q.id === 'Q-2')
  ok('采纳项落 accept 快照', q2.confirmation.answer === '按更新时间倒序' && q2.confirmation.confirmedVia === 'accept')

  // 无可采纳项时整体拒绝
  writePhase0Story('OQ-9B', [
    { id: 'Q-1', question: '缺建议稿的项' }
  ])
  const r2 = runResolve('OQ-9B', '--accept-all')
  ok('无可采纳项时拒绝', r2.code === 1 && r2.out.ok === false, JSON.stringify(r2.out))

  // 批量采纳后门控放行（OQ-9 补 Q-4 建议稿后再 accept-all）
  const oq9 = readOq('OQ-9')
  oq9.questions.find(q => q.id === 'Q-4').resolution = '补充建议稿'
  fs.writeFileSync(path.join(storyDir('OQ-9'), 'open-questions.json'), JSON.stringify(oq9, null, 2))
  const r3 = runResolve('OQ-9', '--accept-all')
  ok('二次 --accept-all 收掉剩余项', r3.code === 0 && r3.out.confirmed.join(',') === 'Q-4' && r3.out.pending.length === 0, JSON.stringify(r3.out))
  const g = gate('OQ-9')
  ok('门控 passed=true', g.passed === true, JSON.stringify(g.blockers))

  // --accept-all 幂等: 全部已确认时重跑返回 ok:true（不当报错）
  const r4 = runResolve('OQ-9', '--accept-all')
  ok('--accept-all 幂等重跑 ok:true', r4.code === 0 && r4.out && r4.out.ok === true && r4.out.confirmed.length === 0 && r4.out.skipped.length === 4, JSON.stringify(r4.out))

  // --accept-all 忽略 --force：已有 verbatim 裁决不被批量覆盖
  const r5 = runResolve('OQ-9', '--accept-all', '--force')
  ok('--accept-all --force 不覆盖已有裁决', r5.code === 0 && r5.out.confirmed.length === 0, JSON.stringify(r5.out))
  const q1After = readOq('OQ-9').questions.find(q => q.id === 'Q-1')
  ok('verbatim 裁决保持原样', q1After.confirmation.answer === '不含附件' && q1After.confirmation.confirmedVia === 'verbatim', JSON.stringify(q1After.confirmation))
}

// ────────────────────────────────────────────────────────────────
section('9c. --accept-all 写入后校验失败 → 整体回滚（文件逐字节不变）')
{
  // 夹具: 文件本身含一个白名单外字段（additionalProperties:false 会抓），
  // resolve-question 写入 confirmation 后整文件 schema 校验必失败 → 触发回滚分支。
  // 这是整套改动里唯一可能破坏用户数据的路径，必须有回归覆盖。
  writePhase0Story('OQ-9C', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件' }
  ])
  const oqPath = path.join(storyDir('OQ-9C'), 'open-questions.json')
  const tampered = JSON.parse(fs.readFileSync(oqPath, 'utf-8'))
  tampered.questions[0].bogusField = '非白名单字段'
  fs.writeFileSync(oqPath, JSON.stringify(tampered, null, 2))
  const before = fs.readFileSync(oqPath, 'utf-8')

  const r = runResolve('OQ-9C', '--accept-all')
  ok('校验失败返回 ok:false', r.code === 1 && r.out && r.out.ok === false, JSON.stringify(r.out))
  ok('报错信息含回滚说明', !!(r.out && r.out.error && r.out.error.includes('已回滚')), JSON.stringify(r.out))
  const after = fs.readFileSync(oqPath, 'utf-8')
  ok('文件内容与写入前逐字节一致（回滚成功）', after === before)
  ok('confirmation 未残留', !readOq('OQ-9C').questions[0].confirmation)
}

// ────────────────────────────────────────────────────────────────
section('10. syncDecisionsToRequirementDoc 只投影已确认项')
{
  const { syncDecisionsToRequirementDoc } = require(path.join(SCRIPTS_DIR, 'services/context-refresh'))
  writePhase0Story('OQ-10', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', confirmation: { answer: '不含附件', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } },
    { id: 'Q-2', question: '列表默认排序？', resolution: '按更新时间倒序', confirmation: { answer: '按更新时间倒序', confirmedVia: 'accept', confirmedAt: CONFIRMED_AT } },
    // AI 自答但未经用户确认 —— 不得出现在「用户已确认裁决」段（v1.3 污染路径回归）
    { id: 'Q-3', question: 'AI 自答项', resolved: true, resolution: 'AI 编造的答案' }
  ])
  const changed = syncDecisionsToRequirementDoc('OQ-10')
  ok('文档被实际改动', changed === true)
  const doc = fs.readFileSync(path.join(storyDir('OQ-10'), 'requirement-analysis.md'), 'utf-8')
  ok('含「用户已确认裁决」段', doc.includes('## 用户已确认裁决'))
  ok('AI 自答项不在裁决段内', !doc.includes('AI 自答项') && !doc.includes('AI 编造的答案'))
  ok('verbatim 项标注用户原话', doc.includes('不含附件') && doc.includes('用户原话'), doc.slice(0, 400))
  ok('accept 项标注采纳建议稿', doc.includes('采纳建议稿'))

  // 幂等: 再跑一次不重复追加
  syncDecisionsToRequirementDoc('OQ-10')
  const doc2 = fs.readFileSync(path.join(storyDir('OQ-10'), 'requirement-analysis.md'), 'utf-8')
  ok('幂等（裁决段只出现一次）', (doc2.match(/## 用户已确认裁决/g) || []).length === 1)

  // 确认项清空 → 移除整段
  fs.writeFileSync(path.join(storyDir('OQ-10'), 'open-questions.json'), JSON.stringify({ questions: [] }, null, 2))
  syncDecisionsToRequirementDoc('OQ-10')
  const doc3 = fs.readFileSync(path.join(storyDir('OQ-10'), 'requirement-analysis.md'), 'utf-8')
  ok('无已确认项时移除裁决段', !doc3.includes('用户已确认裁决'))
}

// ────────────────────────────────────────────────────────────────
section('11. 摘要口径与 checkOpenQuestions 一致（消除同物两信源）')
{
  const { generatePhaseSummary } = require(path.join(SCRIPTS_DIR, 'services/context-refresh'))
  writePhase0Story('OQ-11', [
    { id: 'Q-1', question: '已确认项', resolution: 'x', confirmation: { answer: '用户答', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } },
    { id: 'Q-2', question: '待确认项', resolution: '建议稿' }
  ])
  const summaryPath = generatePhaseSummary('OQ-11', 0)
  ok('摘要文件已生成', !!summaryPath && fs.existsSync(summaryPath))
  const summary = fs.readFileSync(summaryPath, 'utf-8')
  const c = checkOpenQuestions('OQ-11')
  ok('摘要「用户已确认」计数与 checkOpenQuestions 一致',
    summary.includes(`- 用户已确认: ${c.confirmed.length + c.confirmedInformal.length} 项`),
    summary.split('\n').filter(l => l.includes('确认')).join(' | '))
  ok('摘要「待用户确认」计数与 checkOpenQuestions 一致',
    summary.includes(`- 待用户确认: ${c.pendingConfirmation.length} 项`) && summary.includes('Q-2'))
}

summarize(sandbox)
