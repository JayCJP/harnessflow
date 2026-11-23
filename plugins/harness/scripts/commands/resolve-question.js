#!/usr/bin/env node
/**
 * resolve-question.js — 用户确认 open-questions 待确认项的正规写入端
 *
 * 职责:
 *   - 把「用户确认」写进 open-questions.json 的 questions[i].confirmation 字段
 *   - 三种用法: --answer 用户原话 / --accept 采纳建议稿 / --accept-all 原子批量采纳
 *   - 自动补全 confirmedVia/confirmedAt，写 trace.jsonl（不落答案全文）+ debug.jsonl 留痕
 *   - 输出 pending 清单，主 Agent 据此判断是否还要继续向用户提问
 *
 * 用法:
 *   node resolve-question.js <storyId> --qid Q-1 --answer "<用户原话>" [--force]
 *   node resolve-question.js <storyId> --qid Q-1 --accept [--force]
 *   node resolve-question.js <storyId> --accept-all [--force]
 *
 * 使用场景:
 *   - Phase 0→1 门控产出 user_confirmation_required BLOCKER 后，主 Agent 把待确认项
 *     一次性列给用户（问题 + 建议稿 + 依据来源，blocking 项排前），拿到答复后先 spawn
 *     需求分析师做**答复语义判定**（产出 assessment），再逐条执行本命令落账；
 *     用户明确表达「全部采纳」时用 --accept-all 一次落账
 *
 * 说明:
 *   - 设计背景（2026-10-20 用户裁定）: 放行只看 confirmation 字段 —— 它代表用户本人的
 *     拍板。resolved/resolution/blocking 全部退出门控，AI 自己写任何结论都不构成放行依据。
 *   - 落账前置校验（2026-11-23 用户裁定 v2 追问口径）: 「当确定了再写入 confirmation」——
 *     未经需求分析师判定为终局（assessment.verdict=final）的答复拒绝落账；
 *     --answer 还须与 assessment.rawAnswer 逐字一致（用户原话保真，防判定环节改写原话）。
 *     校验的是字段事实（存在性/一致性），不是语义 —— 不违背「AI 不操作状态，只机械执行」。
 *   - 软约束边界: confirmation 不做 hook 硬拦截（AI 技术上可手写）。本命令是「正规路径」:
 *     字段必然写全（不会触发门控的格式 warning）、自动留 trace 审计痕、返回 pending 反馈。
 *     提示词纪律（prompt-builder / 需求分析师.md / SKILL.md）负责让 AI 不手写。
 *   - --accept-all 的前提（脚本无法验证，靠 SKILL.md 约束）: 主 Agent 必须先把全部待确认项
 *     清单展示给用户、用户明确表达「全部采纳」后才可调用。
 *   - --accept-all 忽略 --force：已有 confirmation 的项一律跳过（批量操作不得覆盖用户已拍板
 *     的裁决），改判必须逐条 --qid <Q-N> --force。
 *   - --accept-all 只采纳「已有终局判定」的项（assessment.verdict=final）；缺判定的项跳过
 *     并提示先 spawn 需求分析师判定 —— 与「当确定了再写入 confirmation」同口径。
 *   - --accept-all 幂等：全部已确认时重跑返回 ok:true + skipped，不当报错处理。
 *   - --accept-all 原子性: 全部写入在内存中完成后一次性落盘；落盘后 schema 校验失败则
 *     恢复原文件并以退出码 1 报错（不留半成品）。
 *   - 重复确认（同 qid 已有 confirmation）默认拒绝，--force 覆盖并把旧值留进
 *     confirmation.history[]，保证改判可追溯。改判同样走前置校验（新答复也须先判定）。
 *
 * 输出:
 *   成功 → stdout JSON { ok:true, storyId, confirmed, skipped, pending }，退出码 0
 *   失败 → stdout JSON { ok:false, error }，退出码 1
 *
 * @module resolve-question
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('../lib/paths')
const { ARTIFACT } = require('../lib/artifacts')
const { evaluateOpenQuestion } = require('../lib/contracts')
const { appendTrace } = require('../lib/trace')
const debugLog = require('../lib/debug-log')
const { validateArtifact } = require('../services/schema-validator')

/**
 * 摘取 `--flag=<value>` / `--flag <value>` 两种形式的 flag 值
 * @param {string[]} args - 原始 argv 片段
 * @param {string} flag - flag 名，含前导 `--`（如 '--answer'）
 * @returns {{ value: string|null, rest: string[] }} rest 已剔除 flag 及其值 token
 */
function takeFlagValue (args, flag) {
  const rest = []
  let value = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === flag) {
      value = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : null
      if (value !== null) i++
      continue
    }
    if (a.startsWith(flag + '=')) {
      value = a.slice(flag.length + 1)
      continue
    }
    rest.push(a)
  }
  return { value, rest }
}

/**
 * 构造一条 confirmation 记录
 * @param {string} answer - 用户答复（原话或建议稿快照）
 * @param {'verbatim'|'accept'} via - 确认来源: 用户原话 / 采纳建议稿
 * @param {Object|null} [previous] - 已有 confirmation（--force 覆盖时留 history）
 * @returns {Object} confirmation 对象
 */
function buildConfirmation (answer, via, previous) {
  const confirmation = {
    answer,
    confirmedVia: via,
    confirmedAt: new Date().toISOString()
  }
  if (previous) {
    confirmation.history = [...(Array.isArray(previous.history) ? previous.history : []), previous]
      .map(h => ({ answer: h.answer, confirmedVia: h.confirmedVia, confirmedAt: h.confirmedAt }))
  }
  return confirmation
}

/**
 * 计算仍未确认的 qid 清单（供主 Agent 判断是否还要继续问用户）
 * 含 assessed_final（已判定终局待落账）—— 落账也是未闭环，漏掉会让主 Agent 误判「全部完成」
 * @param {Array} questions - open-questions.json 的 questions 数组
 * @returns {string[]} 未确认项的 id 列表
 */
function pendingQids (questions) {
  return questions
    .filter(q => {
      const s = evaluateOpenQuestion(q).state
      return s === 'pending_confirmation' || s === 'assessed_final' || s === 'no_proposal'
    })
    .map(q => q.id)
}

/**
 * 判定一条待确认项是否已具备落账前置条件（v2 追问口径，2026-11-23 用户裁定）
 * 「当确定了再写入 confirmation」—— 只有需求分析师判定为终局（assessment.verdict=final）
 * 的答复才允许落账。校验的是字段事实，不是语义。
 * @param {Object} q - questions[] 元素
 * @returns {boolean} 是否已有终局判定
 */
function hasFinalAssessment (q) {
  return !!(q.assessment && q.assessment.verdict === 'final' &&
    typeof q.assessment.rawAnswer === 'string' && q.assessment.rawAnswer.trim().length > 0)
}

/**
 * 主流程
 * @returns {number} 退出码: 0 成功 / 1 失败
 */
function main () {
  const argv = process.argv.slice(2)

  // ── 参数解析 ──────────────────────────────────────────────
  const answerFlag = takeFlagValue(argv, '--answer')
  const qidFlag = takeFlagValue(answerFlag.rest, '--qid')
  const positional = qidFlag.rest.filter(a => !a.startsWith('--'))
  const storyId = positional[0]
  const qid = qidFlag.value
  const answer = answerFlag.value
  const acceptAll = argv.includes('--accept-all')
  const accept = argv.includes('--accept') || acceptAll
  const force = argv.includes('--force')

  const fail = (msg, extra = {}) => {
    console.log(JSON.stringify({ ok: false, error: msg, ...extra }))
    return 1
  }

  if (!storyId) return fail('用法: node resolve-question.js <storyId> --qid <Q-N> (--answer "<用户原话>" | --accept) | --accept-all [--force]')
  // 互斥组合显式拒绝（静默丢弃用户原话会把 verbatim 裁决降级成 accept）
  if (acceptAll && (qid || answer !== null)) return fail('--accept-all 与 --qid/--answer 互斥：批量采纳不接受单条参数')
  if (argv.includes('--answer') && answer === null) return fail('--answer 缺少值（值不能以 -- 开头）')
  if (!acceptAll && !qid) return fail('缺少 --qid <Q-N>（或使用 --accept-all 批量采纳）')
  if (!acceptAll && !accept && answer === null) return fail('缺少确认方式: --answer "<用户原话>" 或 --accept')
  if (answer !== null && answer.trim().length === 0) return fail('--answer 不能为空或纯空白 —— 用户原话必须落账，空答复等于没有确认')

  // ── 读取契约文件 ──────────────────────────────────────────
  const storyDir = getStoryDir(storyId)
  const oqPath = path.join(storyDir, ARTIFACT.OPEN_QUESTIONS)
  if (!fs.existsSync(oqPath)) return fail(`open-questions.json 不存在: ${oqPath}`)

  const raw = fs.readFileSync(oqPath, 'utf-8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return fail(`open-questions.json 解析失败: ${e.message}`)
  }
  if (!Array.isArray(data.questions)) return fail('open-questions.json 缺少 questions 数组')

  // ── 应用确认 ──────────────────────────────────────────────
  const confirmed = []
  const skipped = []

  if (acceptAll) {
    for (const q of data.questions) {
      const hasConfirmation = !!(q.confirmation && typeof q.confirmation.answer === 'string' && q.confirmation.answer.trim().length > 0)
      // --accept-all 一律跳过已有确认（忽略 --force）：批量操作不得覆盖用户已拍板的裁决
      // —— 否则用户明确推翻建议稿写下的 verbatim 答案会被降级成「采纳建议稿」塞进 history。
      // 改判必须逐条 --qid <Q-N> --force，让每条改判都是一次显式动作。
      if (hasConfirmation) {
        skipped.push({ qid: q.id, reason: '已有 confirmation（改判需逐条 --qid <Q-N> --force）' })
        continue
      }
      const proposal = typeof q.resolution === 'string' ? q.resolution.trim() : ''
      if (!proposal) {
        skipped.push({ qid: q.id, reason: '缺建议稿（resolution 为空），需需求分析师先补稿' })
        continue
      }
      // v2 追问口径: 批量采纳同样只接受「已判定终局」的项 —— 与单条落账同口径，
      // 未经判定的项跳过并提示（不静默丢弃，让主 Agent 知道还差判定环节）
      if (!hasFinalAssessment(q)) {
        skipped.push({ qid: q.id, reason: '缺终局判定（assessment.verdict=final），需先 spawn 需求分析师对用户答复做语义判定' })
        continue
      }
      q.confirmation = buildConfirmation(proposal, 'accept', null)
      confirmed.push(q.id)
    }
    // 全部已确认时的幂等重跑不算错误（ok:true + skipped）；只有「连可采纳的建议稿/终局判定
    // 都没有」（skipped 里含缺建议稿或缺判定项）才报错 —— 那是真的没活干
    if (confirmed.length === 0) {
      const blocked = skipped.some(s => s.reason.includes('缺建议稿') || s.reason.includes('缺终局判定'))
      if (blocked) return fail('没有可采纳的待确认项', { skipped })
      console.log(JSON.stringify({ ok: true, storyId, confirmed, skipped, pending: pendingQids(data.questions) }, null, 2))
      return 0
    }
  } else {
    const q = data.questions.find(x => x && x.id === qid)
    if (!q) return fail(`open-questions.json 中不存在 ${qid}`, { pending: pendingQids(data.questions) })
    const hasConfirmation = !!(q.confirmation && typeof q.confirmation.answer === 'string' && q.confirmation.answer.trim().length > 0)
    if (hasConfirmation && !force) return fail(`${qid} 已有 confirmation，重复确认需 --force（旧值留 history）`)

    // ── 落账前置校验（v2 追问口径）─────────────────────────────
    // 未经判定为终局的答复不得落账（改判同样适用：新答复也须先判定）
    if (!hasFinalAssessment(q)) {
      return fail(
        `${qid} 缺少终局判定（assessment.verdict=final）—— 用户答复须先 spawn 需求分析师做语义判定并写入 assessment，再落账`,
        { pending: pendingQids(data.questions) }
      )
    }
    // --answer 与判定时摘录的原话逐字一致（用户原话保真，防判定环节改写）
    if (answer !== null && answer.trim() !== q.assessment.rawAnswer.trim()) {
      return fail(
        `${qid} --answer 与 assessment.rawAnswer 不一致 —— 落账必须逐字使用判定时摘录的用户原话`,
        { pending: pendingQids(data.questions) }
      )
    }

    if (answer !== null) {
      // --answer 优先于 --accept（用户给了原话就以原话为准）
      q.confirmation = buildConfirmation(answer, 'verbatim', hasConfirmation ? q.confirmation : null)
    } else {
      const proposal = typeof q.resolution === 'string' ? q.resolution.trim() : ''
      if (!proposal) return fail(`${qid} 缺建议稿（resolution 为空），没有可采纳的内容 —— 需需求分析师先补稿`)
      q.confirmation = buildConfirmation(proposal, 'accept', hasConfirmation ? q.confirmation : null)
    }
    confirmed.push(qid)
  }

  // ── 原子落盘: 先写后校验，校验失败恢复原文件 ────────────────
  fs.writeFileSync(oqPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  const schemaCheck = validateArtifact(storyId, ARTIFACT.OPEN_QUESTIONS)
  if (!schemaCheck.valid) {
    fs.writeFileSync(oqPath, raw, 'utf-8')
    return fail(`写入后 schema 校验失败，已回滚: ${schemaCheck.errors.join('; ')}`)
  }

  // ── 留痕: trace 索引层（不落答案全文）+ debug 载荷层 ─────────
  for (const cid of confirmed) {
    const q = data.questions.find(x => x && x.id === cid)
    // v2 追问口径: 判定结论随落账生成 answer_assessed 事件（判定由分析员会话写入 assessment，
    // 无独立脚本入口 —— 落账是判定的必然后继，此处留痕保证审计链完整可回放）
    if (q.assessment) {
      appendTrace(storyId, {
        type: 'answer_assessed',
        qid: cid,
        verdict: q.assessment.verdict,
        newQuestionIds: Array.isArray(q.assessment.newQuestionIds) ? q.assessment.newQuestionIds : [],
        decisionExtract: q.assessment.decisionExtract || ''
      })
    }
    appendTrace(storyId, {
      type: 'user_decision',
      qid: cid,
      confirmedVia: q.confirmation.confirmedVia,
      answerLength: q.confirmation.answer.length,
      confirmedAt: q.confirmation.confirmedAt
    })
  }
  if (acceptAll) {
    appendTrace(storyId, { type: 'user_decision_batch', count: confirmed.length, skipped: skipped.length })
  }
  debugLog.record(storyId, 'user_decision', {
    command: 'resolve-question.js',
    mode: acceptAll ? 'accept-all' : (answer !== null ? 'answer' : 'accept'),
    confirmed,
    skipped,
    force
  })

  const pending = pendingQids(data.questions)
  console.log(JSON.stringify({ ok: true, storyId, confirmed, skipped, pending }, null, 2))
  return 0
}

if (require.main === module) {
  // 顶层兜底: stdout-JSON 是本命令对宿主的契约，未捕获异常也必须落成 { ok:false, error }，
  // 否则主 Agent 拿到的是空 stdout + 堆栈，按契约分支时会静默拿到 out=null
  try {
    process.exit(main())
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `未捕获异常: ${e.message}` }))
    process.exit(1)
  }
}

module.exports = { buildConfirmation, pendingQids, takeFlagValue, hasFinalAssessment }
