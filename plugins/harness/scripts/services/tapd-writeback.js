#!/usr/bin/env node
/**
 * tapd-writeback.js — fixbugs 模式的 TAPD 回写端（评论模板 + 状态流转）
 *
 * 职责:
 *   - 产出四类评论正文（fixed / to_backend / to_collab / manual），供 Agent 直接透传给
 *     TAPD MCP 的 create_comments
 *   - 判定是否允许改 TAPD 状态（只有「前端缺陷 + 验收通过」才置 in_progress）
 *   - 把回写凭证写进 bug-list.json 的 writeback 字段，作为跨轮去重依据
 *   - 校验状态 key 是否与工作流状态映射一致（避免猜错 key 误关单）
 *
 * 用法:
 *   作为模块引用:
 *     const { buildComment, canChangeStatus, recordWriteback, TARGET_STATUS } = require('./tapd-writeback')
 *   作为 CLI（校验状态映射）:
 *     node tapd-writeback.js <storyId> --check-status-map '<get_workflows_status_map 返回的 JSON>'
 *   作为 CLI（生成评论正文，输出 JSON 的 text 字段直接给 create_comments）:
 *     node tapd-writeback.js <storyId> --compose to_backend --symptom "..." --frontend-checked "..." \
 *       --backend-service "..." --api-endpoint "..." --fields "..." --expected-behavior "..."
 *   作为 CLI（登记回写凭证，写盘前做 schema 校验）:
 *     node tapd-writeback.js <storyId> --record <bugId> --kind fixed [--status-changed]
 *
 * 使用场景:
 *   - Phase 0 分类为 backend / collab 后，需求分析师调 buildComment 拿正文，写评论后 --record 落凭证
 *   - Phase 3 验收通过（无 BLOCKER）后，代码审查师用 fixed 模板写评论，再落凭证 + 改状态
 *
 * 说明:
 *   - **本模块不直接调 TAPD MCP**。MCP 工具只存在于 Agent 会话里，脚本拿不到；
 *     脚本负责「说什么」和「记什么」，Agent 负责「发出去」。这样评论模板与去重逻辑集中在
 *     单处，改了模板两处调用点同时生效。
 *   - 评论模板硬约束: 写协议契约（后端服务 / 接口 / 字段 / 预期值），不写实现（代码块、
 *     git diff、源码路径、函数名）—— 后者对后端定位问题没有价值。目标是 500 字内说清楚，
 *     不设硬上限，以结构分段承载信息。
 *   - 目标状态固定 in_progress（中文「接受/处理」）。写成 resolved 会直接关单，属事故。
 *   - 只有「category=frontend 且验收通过」才改状态；backend / collab 只评论不流转 ——
 *     抢后端的状态流转权会导致后端无法按自己的节奏接单。
 *
 * @module tapd-writeback
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('../lib/paths')
const { ARTIFACT } = require('../lib/artifacts')
const { appendTrace } = require('../lib/trace')
const debugLog = require('../lib/debug-log')
const { validateArtifact } = require('./schema-validator')

/** 验收通过后写入的目标状态。写 resolved 会直接关单，禁止。 */
const TARGET_STATUS = 'in_progress'

/** 目标状态期望的中文名，用于状态映射校验 */
const TARGET_STATUS_LABEL = '接受/处理'

/** 评论类型枚举 —— 与 bug-list.schema.json 的 writeback.commentKind 保持一致 */
const COMMENT_KINDS = ['fixed', 'to_backend', 'to_collab', 'manual']

/**
 * 生成 TAPD 评论正文
 *
 * 输出协议契约（现象 / 结论 / 后端服务 / 接口 / 字段 / 预期行为），不贴代码实现细节。
 * 调用方拿到字符串后直接传给 create_comments 的 description 字段。目标 500 字内说清楚。
 *
 * @param {'fixed'|'to_backend'|'to_collab'|'manual'} kind - 评论类型
 * @param {Object} detail - 填充模板的字段（缺失字段用「未提供」占位）
 * @param {string} [detail.symptom] - 现象（用户视角）
 * @param {string} [detail.frontendChecked] - 前端已排除的部分（前端侧排查结论）
 * @param {string} [detail.backendService] - 后端服务名（协议契约）
 * @param {string} [detail.apiEndpoint] - 相关接口路径，如 GET /api/tickets（协议契约）
 * @param {string} [detail.fields] - 涉及字段及预期值，如 draftFlag 应为 true（协议契约）
 * @param {string} [detail.expectedBehavior] - 后端应返回/修正的预期行为
 * @param {string} [detail.pendingItems] - 待确认项（联调场景）
 * @param {string} [detail.fixSummary] - 改动摘要（前端已修复场景）
 * @param {string} [detail.reason] - 转人工原因
 * @returns {string} 评论正文；kind 非法时抛错
 * @throws {Error} kind 不在 COMMENT_KINDS 内
 */
function buildComment (kind, detail = {}) {
  if (!COMMENT_KINDS.includes(kind)) {
    throw new Error(`未知评论类型: ${kind}，合法值 ${COMMENT_KINDS.join(' / ')}`)
  }
  // 缺失字段用「未提供」占位，避免生成残缺句子诱导下游猜
  const v = (s) => (s && String(s).trim()) ? String(s).trim() : '未提供'

  switch (kind) {
    case 'to_backend':
      return [
        '【前端排查结论】需后端处理',
        '',
        `现象：${v(detail.symptom)}`,
        `前端已排除：${v(detail.frontendChecked)}`,
        `后端服务：${v(detail.backendService)}`,
        `相关接口：${v(detail.apiEndpoint)}`,
        `涉及字段：${v(detail.fields)}`,
        `预期行为：${v(detail.expectedBehavior)}`
      ].join('\n')

    case 'to_collab':
      return [
        '【前端排查结论】需前后端确认',
        '',
        `问题：${v(detail.symptom)}`,
        `待确认：${v(detail.pendingItems)}`,
        `相关接口（已知）：${v(detail.apiEndpoint)}`,
        `涉及字段（已知）：${v(detail.fields)}`
      ].join('\n')

    case 'fixed':
      return `【前端已修复】${v(detail.fixSummary)}，待测试验证。`

    case 'manual':
      return `【未自动修复】${v(detail.reason)}，已转人工处理。`

    default:
      throw new Error(`未实现的评论类型: ${kind}`)
  }
}

/**
 * 判断某个缺陷是否允许改 TAPD 状态
 *
 * 唯一放行条件: 分类为 frontend 且本轮验收通过。其余一律只评论不改状态。
 *
 * @param {Object} bug - bug-list.json 中的一条缺陷记录
 * @param {Object} ctx - 上下文
 * @param {boolean} ctx.accepted - 本轮验收是否通过（Phase 3 无 BLOCKER）
 * @returns {{ allowed: boolean, reason: string }} allowed=false 时 reason 说明为何不改
 */
function canChangeStatus (bug, ctx = {}) {
  if (!bug || typeof bug !== 'object') {
    return { allowed: false, reason: '缺陷记录无效' }
  }
  if (bug.category !== 'frontend') {
    return { allowed: false, reason: `分类为 ${bug.category || '未分诊'}，不改状态（避免抢夺后端的流转权）` }
  }
  if (!ctx.accepted) {
    return { allowed: false, reason: '本轮验收未通过，不改状态' }
  }
  return { allowed: true, reason: `验收通过，置为 ${TARGET_STATUS}` }
}

/**
 * 校验 TAPD 状态映射是否包含目标状态
 *
 * 首次调用 get_workflows_status_map 后把返回值传进来校验一次，避免猜 key 导致误关单。
 *
 * @param {Object} statusMap - get_workflows_status_map 的返回（形如 { new: '新', in_progress: '接受/处理', ... }）
 * @returns {{ ok: boolean, message: string }} ok=false 时本轮所有改状态动作都应跳过
 */
function verifyStatusMap (statusMap) {
  if (!statusMap || typeof statusMap !== 'object') {
    return { ok: false, message: '状态映射为空或格式不符，本轮跳过所有改状态动作' }
  }
  const label = statusMap[TARGET_STATUS]
  if (!label) {
    return { ok: false, message: `状态映射中不存在 '${TARGET_STATUS}'，本轮跳过所有改状态动作` }
  }
  if (String(label).trim() !== TARGET_STATUS_LABEL) {
    return {
      ok: false,
      message: `'${TARGET_STATUS}' 的中文名为「${label}」，与预期的「${TARGET_STATUS_LABEL}」不符，本轮跳过改状态`
    }
  }
  return { ok: true, message: `状态映射校验通过: ${TARGET_STATUS} = ${label}` }
}

/**
 * 检查某缺陷是否已写过同类评论（跨轮去重）
 *
 * @param {Object} bug - bug-list.json 中的一条缺陷记录
 * @param {string} kind - 拟写入的评论类型
 * @returns {{ duplicated: boolean, reason: string }}
 */
function isDuplicateWriteback (bug, kind) {
  const wb = bug && bug.writeback
  if (!wb || !wb.commentedAt) {
    return { duplicated: false, reason: '未写过评论' }
  }
  if (wb.commentKind !== kind) {
    return { duplicated: false, reason: `上次评论类型为 ${wb.commentKind}，本次为 ${kind}，结论已变化` }
  }
  return { duplicated: true, reason: `已于 ${wb.commentedAt} 写过同类评论（${kind}），跳过重复写入` }
}

/**
 * 把回写凭证写进 bug-list.json
 *
 * 只改内存对象并由调用方落盘，本函数不直接写文件 —— 保持「谁读谁写」的边界，
 * 避免与调用方的 schema 校验、原子写盘竞争。
 *
 * @param {Object} bugList - bug-list.json 的完整对象（原地修改）
 * @param {string} bugId - 缺陷 ID
 * @param {Object} record - 回写记录
 * @param {'fixed'|'to_backend'|'to_collab'|'manual'} record.kind - 评论类型
 * @param {boolean} [record.statusChanged] - 是否同时改了状态
 * @param {string} [record.at] - 时间戳，缺省取当前时间
 * @returns {{ ok: boolean, error?: string }} 失败时不修改任何字段
 */
function recordWriteback (bugList, bugId, record = {}) {
  if (!bugList || !Array.isArray(bugList.bugs)) {
    return { ok: false, error: 'bug-list.json 结构无效' }
  }
  if (!COMMENT_KINDS.includes(record.kind)) {
    return { ok: false, error: `未知评论类型: ${record.kind}` }
  }
  const bug = bugList.bugs.find(b => String(b.bugId) === String(bugId))
  if (!bug) return { ok: false, error: `bug-list.json 中不存在缺陷 ${bugId}` }

  const at = record.at || new Date().toISOString()
  const next = { commentedAt: at, commentKind: record.kind }
  if (record.statusChanged) next.statusChangedAt = at

  // 保留已有的另一个时间戳：只改状态不写评论、或只写评论不改状态都合法
  if (bug.writeback) {
    if (!record.statusChanged && bug.writeback.statusChangedAt) {
      next.statusChangedAt = bug.writeback.statusChangedAt
    }
  }
  bug.writeback = next
  return { ok: true }
}

/**
 * 列出需要回写的缺陷（按分类与验收结果分组）
 *
 * 供 Phase 0 / Phase 3 的 Agent 一次性拿到「该给谁写什么评论」，避免它自己按分类
 * 逐个判断（那等于把分诊逻辑复制到 prompt 里，改一处漏一处）。
 *
 * @param {Object} bugList - bug-list.json 的完整对象
 * @param {Object} ctx - 上下文
 * @param {boolean} ctx.accepted - 本轮验收是否通过
 * @returns {Array<{bugId: string, kind: string, changeStatus: boolean, reason: string}>} 待回写清单
 */
function planWritebacks (bugList, ctx = {}) {
  const bugs = (bugList && Array.isArray(bugList.bugs)) ? bugList.bugs : []
  const plan = []
  for (const bug of bugs) {
    if (!bug || !bug.bugId) continue
    let kind = null
    if (bug.category === 'backend') kind = 'to_backend'
    else if (bug.category === 'collab') kind = 'to_collab'
    else if (bug.category === 'frontend' && ctx.accepted) kind = 'fixed'
    if (!kind) continue

    const dup = isDuplicateWriteback(bug, kind)
    const status = canChangeStatus(bug, ctx)
    plan.push({
      bugId: String(bug.bugId),
      kind,
      changeStatus: status.allowed,
      reason: dup.duplicated ? dup.reason : status.reason
    })
  }
  return plan
}

// ─── CLI ────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2)
  const storyId = args[0] ? args[0].replace(/^(plans\/|\.codebuddy\/plans\/)/i, '') : null

  if (!storyId) {
    console.error(JSON.stringify({
      error: '用法: node tapd-writeback.js <storyId> [--check-status-map <JSON>] | [--compose <kind> --symptom ... --backend-service ... --api-endpoint ... --fields ... --expected-behavior ...] | [--record <bugId> --kind <kind> [--status-changed]]',
      kinds: COMMENT_KINDS
    }, null, 2))
    process.exit(1)
  }

  /**
   * 取 flag 值（--flag value 形式）
   * @param {string} flag - flag 名
   * @returns {string|null}
   */
  const takeValue = (flag) => {
    const i = args.indexOf(flag)
    return (i >= 0 && args[i + 1]) ? args[i + 1] : null
  }

  try {
    const statusMapRaw = takeValue('--check-status-map')
    const recordBugId = takeValue('--record')

    // 模式 1: 只校验状态映射
    if (statusMapRaw) {
      let parsed
      try {
        parsed = JSON.parse(statusMapRaw)
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: `状态映射 JSON 解析失败: ${e.message}` }, null, 2))
        process.exit(1)
      }
      const r = verifyStatusMap(parsed)
      appendTrace(storyId, { type: 'tapd_status_map_check', result: r.ok ? 'ok' : 'skip', message: r.message })
      console.log(JSON.stringify({ ok: r.ok, message: r.message, targetStatus: TARGET_STATUS }, null, 2))
      process.exit(r.ok ? 0 : 1)
    }

    // 模式 2: 生成评论正文（Agent 拿到后透传给 create_comments）
    const composeKind = takeValue('--compose')
    if (composeKind) {
      let text
      try {
        text = buildComment(composeKind, {
          symptom: takeValue('--symptom'),
          frontendChecked: takeValue('--frontend-checked'),
          backendService: takeValue('--backend-service'),
          apiEndpoint: takeValue('--api-endpoint'),
          fields: takeValue('--fields'),
          expectedBehavior: takeValue('--expected-behavior'),
          pendingItems: takeValue('--pending-items'),
          fixSummary: takeValue('--fix-summary'),
          reason: takeValue('--reason')
        })
      } catch (e) {
        console.log(JSON.stringify({ ok: false, error: e.message, kinds: COMMENT_KINDS }, null, 2))
        process.exit(1)
      }
      console.log(JSON.stringify({
        ok: true,
        kind: composeKind,
        text,
        length: text.length,
        hint: '把 text 原样作为 create_comments 的 description，写完再执行 --record 登记凭证'
      }, null, 2))
      process.exit(0)
    }

    // 模式 3: 登记回写凭证
    if (recordBugId) {
      const kind = takeValue('--kind')
      const listPath = path.join(getStoryDir(storyId), ARTIFACT.BUG_LIST)
      if (!fs.existsSync(listPath)) {
        console.log(JSON.stringify({ ok: false, error: `bug-list.json 不存在: ${listPath}` }, null, 2))
        process.exit(1)
      }
      const bugList = JSON.parse(fs.readFileSync(listPath, 'utf-8'))
      const r = recordWriteback(bugList, recordBugId, {
        kind,
        statusChanged: args.includes('--status-changed')
      })
      if (!r.ok) {
        console.log(JSON.stringify({ ok: false, error: r.error }, null, 2))
        process.exit(1)
      }
      // 落盘前用同一份 schema 校验：bug-list 是 Phase 0→1 门控依据，
      // 写坏了等于把门控的输入改成非法状态，比不写更糟
      const check = validateArtifact(storyId, ARTIFACT.BUG_LIST, getStoryDir(storyId))
      if (!check.valid) {
        console.log(JSON.stringify({
          ok: false,
          error: '回写后的 bug-list.json 未通过 schema 校验，已放弃本次写入',
          errors: check.errors
        }, null, 2))
        process.exit(1)
      }
      fs.writeFileSync(listPath, JSON.stringify(bugList, null, 2) + '\n', 'utf-8')
      appendTrace(storyId, { type: 'tapd_writeback_recorded', bugId: recordBugId, kind, statusChanged: args.includes('--status-changed') })
      console.log(JSON.stringify({ ok: true, bugId: recordBugId, kind, writeback: bugList.bugs.find(b => String(b.bugId) === String(recordBugId)).writeback }, null, 2))
      process.exit(0)
    }

    console.error(JSON.stringify({ error: '未指定操作：需要 --check-status-map 或 --record' }, null, 2))
    process.exit(1)
  } catch (e) {
    debugLog.record(storyId, 'script_error', { error: e.message }, { source: 'tapd-writeback.js' })
    console.error(JSON.stringify({ error: 'tapd-writeback 执行异常', message: e.message }, null, 2))
    process.exit(1)
  }
}

module.exports = {
  TARGET_STATUS,
  TARGET_STATUS_LABEL,
  COMMENT_KINDS,
  buildComment,
  canChangeStatus,
  verifyStatusMap,
  isDuplicateWriteback,
  recordWriteback,
  planWritebacks
}
