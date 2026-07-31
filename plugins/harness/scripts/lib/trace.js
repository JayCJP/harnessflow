#!/usr/bin/env node
/**
 * trace.js — 全链路 Trace 记录模块
 *
 * 记录 Agent 间消息、工具调用、门控决策、协调事件到 trace.jsonl
 * 供调试、审计、经验沉淀使用。
 *
 * @module trace
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir } = require('./state')

/**
 * 追加一条 trace 记录到 story 的 trace.jsonl
 * @param {string} storyId - Story ID
 * @param {Object} entry - trace 条目
 * @param {string} entry.type - 事件类型: agent_spawn|tool_call|gate_decision|agent_message|phase_transition|error_recovery|experience
 * @param {string} [entry.agent] - 涉及的 Agent 名称
 * @param {string} [entry.tool] - 工具名称
 * @param {string} [entry.phase] - Phase 编号
 * @param {string} [entry.result] - 结果: pass|fail|block|allow|deny
 * @param {string} [entry.reason] - 原因说明
 * @param {Object} [entry.details] - 附加详情
 */
function appendTrace (storyId, entry) {
  if (!storyId) return
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) return

  const traceFile = path.join(storyDir, 'trace.jsonl')
  const record = {
    ts: new Date().toISOString(),
    storyId,
    ...entry
  }
  fs.appendFileSync(traceFile, JSON.stringify(record) + '\n', 'utf-8')
}

/**
 * 记录 Agent spawn 事件
 * @param {string} storyId
 * @param {string} agentName - Agent 名称
 * @param {string} taskId - 任务 ID
 * @param {Object} [details] - 附加详情
 */
function traceAgentSpawn (storyId, agentName, taskId, details = {}) {
  appendTrace(storyId, {
    type: 'agent_spawn',
    agent: agentName,
    taskId,
    result: 'spawned',
    details
  })
}

/**
 * 记录 Agent 完成/失败结果
 * @param {string} storyId
 * @param {string} agentName - Agent 名称
 * @param {'completed'|'failed'} status - 结果状态
 * @param {Object} [details] - 附加详情（failed 时建议包含 error 字段）
 */
function traceAgentResult (storyId, agentName, status, details = {}) {
  appendTrace(storyId, {
    type: 'agent_result',
    agent: agentName,
    result: status,
    details
  })
}

/**
 * 记录门控决策
 * @param {string} storyId
 * @param {number} phase - Phase 编号
 * @param {boolean} passed - 是否通过
 * @param {string[]} blockers - 阻塞项
 * @param {string[]} warnings - 警告项
 */
function traceGateDecision (storyId, phase, passed, blockers = [], warnings = []) {
  appendTrace(storyId, {
    type: 'gate_decision',
    phase: String(phase),
    result: passed ? 'pass' : 'block',
    reason: blockers.length > 0 ? blockers.join('; ') : (warnings.length > 0 ? warnings.join('; ') : 'all passed'),
    details: { blockerCount: blockers.length, warningCount: warnings.length }
  })
}

/**
 * 记录 Phase 转换
 * @param {string} storyId
 * @param {number} fromPhase - 起 Phase
 * @param {number} toPhase - 目 Phase
 */
function tracePhaseTransition (storyId, fromPhase, toPhase) {
  appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(toPhase),
    result: 'transitioned',
    details: { fromPhase, toPhase }
  })
}

/**
 * 记录错误恢复
 * @param {string} storyId
 * @param {number} phase - Phase 编号
 * @param {string} errorType - 错误类型
 * @param {string} recoveryAction - 恢复动作
 * @param {boolean} recovered - 是否成功恢复
 */
function traceErrorRecovery (storyId, phase, errorType, recoveryAction, recovered) {
  appendTrace(storyId, {
    type: 'error_recovery',
    phase: String(phase),
    result: recovered ? 'recovered' : 'failed',
    reason: errorType,
    details: { recoveryAction }
  })
}

/**
 * 记录 Git 操作事件（commit、push、MR 等）
 * @param {string} storyId
 * @param {string} action - 操作: init|add|commit|push|mr
 * @param {string} result - 结果: success|failed
 * @param {Object} [details] - 附加详情（commit 时建议包含 hash、message）
 */
function traceGitEvent (storyId, action, result, details = {}) {
  appendTrace(storyId, {
    type: 'git',
    action,
    result,
    details
  })
}

/**
 * 记录经验事件（失败模式捕获）
 * @param {string} storyId
 * @param {string} phase - Phase 编号
 * @param {string} failureType - 失败类型
 * @param {string} rootCause - 根因
 * @param {string} resolution - 解决方案
 */
function traceExperience (storyId, phase, failureType, rootCause, resolution) {
  appendTrace(storyId, {
    type: 'experience',
    phase: String(phase),
    result: 'captured',
    reason: failureType,
    details: { rootCause, resolution }
  })
}

module.exports = {
  appendTrace,
  traceAgentSpawn,
  traceAgentResult,
  traceGitEvent,
  traceGateDecision,
  tracePhaseTransition,
  traceErrorRecovery,
  traceExperience
}

// ─── CLI 入口（供 AI 手动调用记录 Agent 事件） ─────────────────

if (require.main === module) {
  const args = process.argv.slice(2)
  const cmd = args[0]
  const storyId = args[1]

  if (cmd === 'agent-result' && storyId && args[2]) {
    const agentName = args[2]
    const status = args[3] === 'failed' ? 'failed' : 'completed'
    const detailStr = args.slice(4).join(' ')
    let details = {}
    try { details = JSON.parse(detailStr) } catch { details = { summary: detailStr } }
    traceAgentResult(storyId, agentName, status, details)
    console.log(JSON.stringify({ ok: true, storyId, agent: agentName, status }))
  } else if (cmd === 'agent-spawn' && storyId && args[2]) {
    const agentName = args[2]
    const taskId = args[3] || ''
    traceAgentSpawn(storyId, agentName, taskId, { phase: args[4] || '?' })
    console.log(JSON.stringify({ ok: true, storyId, agent: agentName, taskId }))
  } else if (cmd === 'git' && storyId && args[2]) {
    const action = args[2]
    const result = args[3] === 'failed' ? 'failed' : 'success'
    const detailStr = args.slice(4).join(' ')
    let details = {}
    try { details = JSON.parse(detailStr) } catch { details = { message: detailStr } }
    traceGitEvent(storyId, action, result, details)
    console.log(JSON.stringify({ ok: true, storyId, action, result }))
  } else {
    console.log(JSON.stringify({
      usage: {
        'agent-spawn': 'node trace.js agent-spawn <storyId> <agentName> [taskId] [phase]',
        'agent-result': 'node trace.js agent-result <storyId> <agentName> <completed|failed> [detailsJSON]',
        'git': 'node trace.js git <storyId> <init|add|commit|push|mr> [success|failed] [detailsJSON]'
      }
    }, null, 2))
  }
}
