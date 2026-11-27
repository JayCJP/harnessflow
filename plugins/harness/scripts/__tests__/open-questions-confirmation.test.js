#!/usr/bin/env node
/**
 * open-questions 用户确认门控回归测试（v4 口径 + v2 追问口径）
 *
 * 覆盖 2026-10-20 裁定的门控重构：
 *   - 放行只看 confirmation 字段（用户确认记录），resolved/resolution/blocking 全部退出门控
 *   - 四态分类: confirmed / confirmed_informal / pending_confirmation / no_proposal
 *   - confirmation 软约束: 格式不规范（缺 confirmedVia/confirmedAt）的确认放行但记 warning
 *   - resolve-question.js 三种用法: --answer 用户原话 / --accept 采纳建议稿 / --accept-all 原子批量
 *
 * 覆盖 2026-11-23 裁定的 v2 追问口径（LLM 语义判定 + 扁平 Q 递增）：
 *   - 第五态 assessed_final（有 assessment.verdict=final、无 confirmation）→ 待落账、不放行
 *   - 落账前置校验: 无终局判定拒绝；--answer 与 assessment.rawAnswer 逐字不一致拒绝
 *   - --accept-all 只采纳有终局判定的项
 *   - 判定带出的新 Q（扁平递增）走同一确认循环，全部 confirmation 才放行
 *   - 落账留痕 trace answer_assessed 事件
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
  // v2 追问口径: --accept 同样要求终局判定（assessment.verdict=final）已就位
  writePhase0Story('OQ-7', [
    {
      id: 'Q-1',
      question: '导出是否含附件？',
      resolution: '建议含附件',
      resolutionSource: 'prototype',
      assessment: { verdict: 'final', rawAnswer: '采纳建议稿', decisionExtract: '用户采纳建议稿' }
    },
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
  // v2 追问口径: rawAnswer 逐字一致是落账前置条件
  writePhase0Story('OQ-8', [
    {
      id: 'Q-1',
      question: '导出是否含附件？',
      resolution: '建议含附件',
      assessment: { verdict: 'final', rawAnswer: '不含附件', decisionExtract: '用户拍板不含附件' }
    }
  ])
  const r1 = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '   ')
  ok('--answer 纯空白拒绝', r1.code === 1 && r1.out && r1.out.ok === false, JSON.stringify(r1.out))

  const r1b = runResolve('OQ-8', '--qid', 'Q-1', '--answer', '不含附件，格式按之前')
  ok('--answer 与 rawAnswer 不一致拒绝（原话保真校验）', r1b.code === 1 && r1b.out && r1b.out.ok === false &&
    r1b.out.error.includes('rawAnswer'), JSON.stringify(r1b.out))

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

  // v2 追问口径: 改判的新答复同样须先判定 —— 模拟判定环节更新 assessment 后 --force 覆盖
  const oq8 = readOq('OQ-8')
  oq8.questions.find(q => q.id === 'Q-1').assessment = { verdict: 'final', rawAnswer: '改判：含附件', decisionExtract: '用户改判为含附件' }
  fs.writeFileSync(path.join(storyDir('OQ-8'), 'open-questions.json'), JSON.stringify(oq8, null, 2))

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
  // v2 追问口径: 批量采纳只收「已判定终局」的项；Q-3 无判定 → skipped 提示先判定
  writePhase0Story('OQ-9', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', confirmation: { answer: '不含附件', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } },
    {
      id: 'Q-2',
      question: '列表默认排序？',
      resolution: '按更新时间倒序',
      assessment: { verdict: 'final', rawAnswer: '全部采纳', decisionExtract: '用户全部采纳' }
    },
    { id: 'Q-3', question: '并发上限？', resolution: '建议 10', resolutionSource: 'inference' }, // 有建议稿但未经判定
    { id: 'Q-4', question: '缺建议稿的项' }
  ])
  const r = runResolve('OQ-9', '--accept-all')
  ok('--accept-all 成功', r.code === 0 && r.out && r.out.ok === true, JSON.stringify(r.out))
  ok('confirmed = [Q-2]（只采纳已判定终局项）', Array.isArray(r.out.confirmed) && r.out.confirmed.join(',') === 'Q-2', JSON.stringify(r.out.confirmed))
  ok('skipped 含已确认项 / 未经判定项 / 缺建议稿项（注明原因）',
    Array.isArray(r.out.skipped) && r.out.skipped.length === 3 &&
    r.out.skipped.some(s => s.qid === 'Q-1') && r.out.skipped.some(s => s.qid === 'Q-3') && r.out.skipped.some(s => s.qid === 'Q-4'),
    JSON.stringify(r.out.skipped))
  ok('pending 剩 Q-3 与 Q-4', r.out.pending.join(',') === 'Q-3,Q-4', JSON.stringify(r.out.pending))

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

  // 批量采纳后门控放行（OQ-9 补齐 Q-3/Q-4 的判定与建议稿后再 accept-all）
  const oq9 = readOq('OQ-9')
  const q3 = oq9.questions.find(q => q.id === 'Q-3')
  q3.assessment = { verdict: 'final', rawAnswer: '全部采纳', decisionExtract: '用户全部采纳' }
  const q4 = oq9.questions.find(q => q.id === 'Q-4')
  q4.resolution = '补充建议稿'
  q4.assessment = { verdict: 'final', rawAnswer: '全部采纳', decisionExtract: '用户全部采纳' }
  fs.writeFileSync(path.join(storyDir('OQ-9'), 'open-questions.json'), JSON.stringify(oq9, null, 2))
  const r3 = runResolve('OQ-9', '--accept-all')
  ok('二次 --accept-all 收掉剩余项', r3.code === 0 && r3.out.confirmed.join(',') === 'Q-3,Q-4' && r3.out.pending.length === 0, JSON.stringify(r3.out))
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
    // v2 追问口径: 需带终局判定才会进入写入路径（否则 accept-all 直接 skip，测不到回滚）
    {
      id: 'Q-1',
      question: '导出是否含附件？',
      resolution: '建议含附件',
      assessment: { verdict: 'final', rawAnswer: '采纳', decisionExtract: '用户采纳' }
    }
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

  // Phase 0 摘要的契约清单 = Phase 1 的输入（需求文档 + AC），不得列 Phase 1 的产出物 task-dag.json
  ok('Phase 0 摘要契约清单含需求文档', summary.includes('requirement-analysis.md'))
  ok('Phase 0 摘要契约清单不含尚未生成的 task-dag', !summary.includes('task-dag.json'), summary.slice(-300))
}

// ────────────────────────────────────────────────────────────────
// v2 追问口径（2026-11-23 裁定）: LLM 语义判定 + 扁平 Q 递增
// ────────────────────────────────────────────────────────────────
section('12. assessed_final 第五态：已判定终局、待落账、不放行')
{
  // 模拟判定环节产出: Q-1 已判 final（待落账）、Q-2 判 not_answered（下轮重问）
  writePhase0Story('OQ-12', [
    {
      id: 'Q-1',
      question: '导出是否含附件？',
      resolution: '建议含附件',
      assessment: { verdict: 'final', rawAnswer: '不含附件', decisionExtract: '用户拍板不含附件', newQuestionIds: [] }
    },
    {
      id: 'Q-2',
      question: '列表默认排序？',
      resolution: '按更新时间倒序',
      assessment: { verdict: 'not_answered', rawAnswer: '顺便问下导出格式？', decisionExtract: '答非所问，带出新疑问' }
    }
  ])
  const c = checkOpenQuestions('OQ-12')
  ok('assessedFinal 长度 = 1', c.assessedFinal.length === 1 && c.assessedFinal[0].id === 'Q-1',
    JSON.stringify(c.assessedFinal.map(q => q.id)))
  ok('not_answered 判定不改状态（仍归 pendingConfirmation）',
    c.pendingConfirmation.length === 1 && c.pendingConfirmation[0].id === 'Q-2')
  ok('assessed_final 计入 unresolved（不放行）', c.unresolved.length === 2 && c.allResolved === false)
  ok('evaluateOpenQuestion: assessed_final',
    evaluateOpenQuestion({ resolution: 'x', assessment: { verdict: 'final', rawAnswer: 'a' } }).state === 'assessed_final')
  ok('evaluateOpenQuestion: not_answered 不产生新态',
    evaluateOpenQuestion({ resolution: 'x', assessment: { verdict: 'not_answered', rawAnswer: 'a' } }).state === 'pending_confirmation')

  const g = gate('OQ-12')
  ok('门控 passed=false（assessed_final 同样拦截）', g.passed === false, JSON.stringify(g.blockers))
  ok('failureType=user_confirmation_required（assessedFinal 并入 pending 口径）',
    g.blockers.some(b => b.type === 'user_confirmation_required'),
    JSON.stringify(g.blockers.map(b => b.type)))

  // dispatch A0: 待落账项单独分组给落账指令，不再抛回用户
  const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
  const d = dispatch('OQ-12')
  ok('dispatch status=blocked', d.status === 'blocked', d.status)
  ok('recovery 含待落账指令（🔵 + 勿再重复提问）',
    d.recovery && d.recovery.description.includes('🔵') && d.recovery.description.includes('勿再向用户重复提问'),
    d.recovery ? d.recovery.description.slice(0, 300) : 'null')
  ok('recovery 含判定环节模板（spawn 需求分析师）',
    d.recovery && d.recovery.description.includes('Spawn 需求分析师做答复语义判定'),
    d.recovery ? 'has template' : 'null')
  ok('recovery 判定模板含 <USER_REPLIES> 占位符（主 Agent 机械替换点）',
    d.recovery && d.recovery.description.includes('<USER_REPLIES>'),
    d.recovery ? 'has placeholder' : 'null')
}

// ────────────────────────────────────────────────────────────────
section('12b. A0 空 items 边界：只剩待落账项时不输出「待用户确认」引导头')
{
  writePhase0Story('OQ-12B', [
    {
      id: 'Q-1',
      question: '导出是否含附件？',
      resolution: '建议含附件',
      assessment: { verdict: 'final', rawAnswer: '不含附件', decisionExtract: '用户拍板不含附件', newQuestionIds: [] }
    }
  ])
  const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))
  const d = dispatch('OQ-12B')
  ok('dispatch status=blocked', d.status === 'blocked', d.status)
  ok('只含待落账项: 有 🔵 落账指令、无「必须经用户确认」引导头',
    d.recovery && d.recovery.description.includes('🔵') &&
    !d.recovery.description.includes('以下待确认项必须经用户确认'),
    d.recovery ? d.recovery.description.slice(0, 150) : 'null')
}

// ────────────────────────────────────────────────────────────────
section('13. 落账前置校验：无终局判定 / 原话不一致一律拒绝')
{
  writePhase0Story('OQ-13', [
    { id: 'Q-1', question: '无判定项？', resolution: '建议稿' },
    {
      id: 'Q-2',
      question: 'not_answered 项？',
      resolution: '建议稿',
      assessment: { verdict: 'not_answered', rawAnswer: '再看看', decisionExtract: '未有效回答' }
    }
  ])
  const r1 = runResolve('OQ-13', '--qid', 'Q-1', '--answer', '用户原话')
  ok('无 assessment 落账被拒', r1.code === 1 && r1.out.ok === false && r1.out.error.includes('终局判定'), JSON.stringify(r1.out))
  const r1b = runResolve('OQ-13', '--qid', 'Q-1', '--accept')
  ok('--accept 无 assessment 同样被拒', r1b.code === 1 && r1b.out.ok === false && r1b.out.error.includes('终局判定'), JSON.stringify(r1b.out))
  const r2 = runResolve('OQ-13', '--qid', 'Q-2', '--answer', '再看看')
  ok('verdict=not_answered 落账被拒', r2.code === 1 && r2.out.ok === false && r2.out.error.includes('终局判定'), JSON.stringify(r2.out))
  ok('失败输出附 pending 清单（供主 Agent 判断下一步）',
    Array.isArray(r1.out.pending) && r1.out.pending.includes('Q-1') && r1.out.pending.includes('Q-2'),
    JSON.stringify(r1.out.pending))
}

// ────────────────────────────────────────────────────────────────
section('14. v2 全链路：判定 final 落账 + 新分支扁平追加 + 全部确认后放行')
{
  // 首轮: 两项建议稿待确认
  writePhase0Story('OQ-14', [
    { id: 'Q-1', question: '导出是否含附件？', resolution: '建议含附件', resolutionSource: 'prototype' },
    { id: 'Q-2', question: '转接后历史消息如何装载？', resolution: '建议先抓包再定责', resolutionSource: 'code-evidence' }
  ])
  const g1 = gate('OQ-14')
  ok('首轮门控拦截（2 项待确认）', g1.passed === false, JSON.stringify(g1.blockers))

  // 用户答复带出新指令（复刻 supply-cs Q-02 形态）→ 判定环节写 assessment + 追加新 Q（扁平 Q-3）
  const oq14 = readOq('OQ-14')
  oq14.questions.find(q => q.id === 'Q-1').assessment =
    { verdict: 'final', rawAnswer: '问题已修复，忽略', decisionExtract: '已修复，无需处理', newQuestionIds: [] }
  oq14.questions.find(q => q.id === 'Q-2').assessment =
    { verdict: 'final', rawAnswer: '在排查一下当前请求历史消息记录的逻辑，能否重新请求历史消息？', decisionExtract: '否决只等抓包，改为主动排查重拉', newQuestionIds: ['Q-3'] }
  oq14.questions.push({
    id: 'Q-3',
    question: '转接系统消息触发当前会话历史重拉，是否采纳此实现方向？',
    resolution: '参考 H5 handleGroupIdByTalk 的 resetSession + getHistoryMsg 实现',
    resolutionSource: 'code-evidence'
  })
  fs.writeFileSync(path.join(storyDir('OQ-14'), 'open-questions.json'), JSON.stringify(oq14, null, 2))

  // 中间态: Q-1/Q-2 待落账、Q-3 待问 → 仍不放行
  const c1 = checkOpenQuestions('OQ-14')
  ok('中间态: assessedFinal=2 且新 Q-3 在 pendingConfirmation',
    c1.assessedFinal.length === 2 && c1.pendingConfirmation.length === 1 && c1.pendingConfirmation[0].id === 'Q-3',
    JSON.stringify({ a: c1.assessedFinal.map(q => q.id), p: c1.pendingConfirmation.map(q => q.id) }))
  const g2 = gate('OQ-14')
  ok('中间态门控仍拦截（新 Q 未确认）', g2.passed === false, JSON.stringify(g2.blockers))

  // 落账 Q-1/Q-2（--answer 逐字复制 assessment.rawAnswer）
  const ra1 = runResolve('OQ-14', '--qid', 'Q-1', '--answer', '问题已修复，忽略')
  const ra2 = runResolve('OQ-14', '--qid', 'Q-2', '--answer', '在排查一下当前请求历史消息记录的逻辑，能否重新请求历史消息？')
  ok('Q-1/Q-2 按判定落账成功', ra1.code === 0 && ra2.code === 0, JSON.stringify([ra1.out, ra2.out]))

  // 第二轮: 用户确认新 Q-3 → 判定 final → 落账
  const oq14b = readOq('OQ-14')
  oq14b.questions.find(q => q.id === 'Q-3').assessment =
    { verdict: 'final', rawAnswer: '确认，按建议稿实现', decisionExtract: '采纳建议稿', newQuestionIds: [] }
  fs.writeFileSync(path.join(storyDir('OQ-14'), 'open-questions.json'), JSON.stringify(oq14b, null, 2))
  const ra3 = runResolve('OQ-14', '--qid', 'Q-3', '--answer', '确认，按建议稿实现')
  ok('新 Q 落账成功（闭环）', ra3.code === 0 && ra3.out.pending.length === 0, JSON.stringify(ra3.out))

  const g3 = gate('OQ-14')
  ok('全部 confirmation 后门控放行', g3.passed === true, JSON.stringify(g3.blockers))

  // trace: answer_assessed 留痕（判定结论随落账生成，可审计回放）
  const tracePath = path.join(storyDir('OQ-14'), 'trace.jsonl')
  const traces = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
  const aa = traces.filter(t => t.type === 'answer_assessed')
  ok('trace 落 answer_assessed 事件（3 条，含 verdict/newQuestionIds）',
    aa.length === 3 && aa.some(t => t.qid === 'Q-2' && Array.isArray(t.newQuestionIds) && t.newQuestionIds.includes('Q-3')),
    JSON.stringify(aa.map(t => ({ qid: t.qid, verdict: t.verdict }))))
  const ud = traces.filter(t => t.type === 'user_decision')
  ok('user_decision 与 answer_assessed 一一对应', ud.length === 3, JSON.stringify(ud.map(t => t.qid)))

  // sync_decisions 投影: 新 Q-3 的裁决也进「用户已确认裁决」段（扁平设计的零改动红利）
  const { syncDecisionsToRequirementDoc } = require(path.join(SCRIPTS_DIR, 'services/context-refresh'))
  syncDecisionsToRequirementDoc('OQ-14')
  const doc = fs.readFileSync(path.join(storyDir('OQ-14'), 'requirement-analysis.md'), 'utf-8')
  ok('裁决段含全部 3 条（含追加的新 Q-3）',
    doc.includes('Q-1') && doc.includes('Q-2') && doc.includes('Q-3') && doc.includes('确认，按建议稿实现'),
    doc.slice(doc.indexOf('## 用户已确认裁决'), doc.indexOf('## 用户已确认裁决') + 400))
}

// ────────────────────────────────────────────────────────────────
section('15. Phase 0 推进前裁决回写指令（dispatch 分支 B）')
{
  const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))

  // 15a. 全部确认 → 推进前要求先 spawn 需求分析师做裁决回写（否则 AC 仍是旧口径）
  writePhase0Story('OQ-15A', [
    { id: 'Q-1', question: '角标数据由谁下发？', resolution: '前端本地合成', confirmation: { answer: '后端下发，前端只渲染', confirmedVia: 'verbatim', confirmedAt: CONFIRMED_AT } }
  ])
  const d = dispatch('OQ-15A')
  ok('门控通过 → 分支 B', d.readyToAdvance === true && d.status === 'ready',
    JSON.stringify({ status: d.status, blockers: d.pendingBlockers }))
  // 关键：动作必须由顶层字段驱动 —— SKILL.md 的 ready 分支只认 preAdvanceAgent，
  // instruction 是人读说明、无机器消费方，光写在那里等于死指令
  ok('给出 preAdvanceAgent（机器消费字段）', d.preAdvanceAgent === 'requirement-analyst', String(d.preAdvanceAgent))
  ok('给出 preAdvancePrompt', typeof d.preAdvancePrompt === 'string' && d.preAdvancePrompt.length > 0)
  ok('prompt 要求更新 AC', /acceptance-criteria\.json/.test(d.preAdvancePrompt || ''))
  ok('prompt 要求更新需求文档', /requirement-analysis\.md/.test(d.preAdvancePrompt || ''))
  ok('prompt 不改 open-questions.json', /不改 open-questions\.json/.test(d.preAdvancePrompt || ''))
  ok('prompt 明确不自行推进', /不要执行推进命令/.test(d.preAdvancePrompt || ''))
  ok('advanceCommand 仍在', /advance-phase\.js/.test(d.advanceCommand || ''), d.advanceCommand)

  // 15b. 无待确认项（questions 为空）→ 不需要回写，走常规推进指令
  writePhase0Story('OQ-15B', [])
  const d2 = dispatch('OQ-15B')
  ok('无待确认项时不给前置动作', d2.readyToAdvance === true && d2.preAdvanceAgent === null && d2.preAdvancePrompt === null,
    JSON.stringify({ agent: d2.preAdvanceAgent, prompt: d2.preAdvancePrompt }))

  // 15c. 仍有未确认项 → 走 A0 blocked，不出现回写指令
  writePhase0Story('OQ-15C', [
    { id: 'Q-1', question: '未确认项', resolution: '建议稿' }
  ])
  const d3 = dispatch('OQ-15C')
  ok('未全部确认 → blocked', d3.status === 'blocked', d3.status)
  ok('blocked 输出不含前置动作', d3.preAdvanceAgent === null && d3.preAdvancePrompt === null,
    JSON.stringify({ agent: d3.preAdvanceAgent, prompt: d3.preAdvancePrompt }))
}

summarize(sandbox)
