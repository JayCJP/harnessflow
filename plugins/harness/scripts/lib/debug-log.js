#!/usr/bin/env node
/**
 * debug-log.js — 全流程调试日志（载荷层）的单一信源
 *
 * 职责:
 *   - 在 story 目录下维护 debug.jsonl：全量记录命令输出 / 方法输出 / 钩子拒绝 / 状态变更
 *   - 与 trace.jsonl（索引层）分工：trace 记「发生了什么事件」（紧凑），
 *     debug 记「事件输出了什么内容」（全量 payload），供流程回顾分析
 *   - 提供 read() 读取端供 audit/debug-replay.js 回放
 *
 * 用法:
 *   作为模块引用（commands / hooks / services 在输出或决策点显式调用）:
 *     const debugLog = require('../lib/debug-log')
 *     debugLog.record(storyId, 'script_output', out, { source: 'dispatch.js', durationMs: 87 })
 *
 * 设计约束（见 docs/DEBUG_LOG_全流程调试日志_设计方案.md）:
 *   - 零运行时行为变更：纯追加旁路，写失败静默吞掉（与 trace.js 同哲学），绝不阻塞主流程
 *   - 不进 Agent 上下文：debug.jsonl 只被回放工具离线读取，不注入任何 prompt
 *   - 单条 payload 超 64KB 截断并记 sha1 指纹，保证可对账
 *   - 默认开启，HARNESS_DEBUG=0 关闭（逃生门）
 *   - 零写权限于状态机：只写自己的 debug.jsonl，不碰 e2e-state.json / dev-pass.json
 *
 * 说明:
 *   - 对 lib/state.js 的依赖采用**惰性 require**：state.js 的 writeStateFile 会调用本模块
 *     记录 state_change，顶层互 require 会形成加载期循环依赖（state 加载到一半时
 *     debug-log 反过来 require state 拿到不完整的 exports）。record() 只在运行期被调用，
 *     那时 state.js 早已加载完成，惰性 require 拿到的是完整缓存模块。
 *   - seq 为 story 内单调递增序号：追加前从文件尾部读上一条的 seq（文件为追加型，
 *     尾读 8KB 足够；读不到按 0 起步）。回放时按文件顺序渲染，seq 供引用（「记录 #42」）。
 *
 * @module debug-log
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/** 单条 payload 的截断上限（字符数）。超出截断并记指纹，防止巨型输出撑爆日志 */
const MAX_PAYLOAD_CHARS = 64 * 1024

/** debug-log 对 lib/state.js 的惰性引用（避免与 writeStateFile 的加载期循环依赖） */
let _state = null
function stateModule () {
  if (!_state) _state = require('./state')
  return _state
}

/**
 * 判断 debug 日志是否启用
 * 默认开启；HARNESS_DEBUG=0（仅精确的 '0'）时关闭
 * @returns {boolean}
 */
function isEnabled () {
  return process.env.HARNESS_DEBUG !== '0'
}

/**
 * 计算 debug.jsonl 的路径
 * @param {string} storyId - Story ID
 * @param {number} [round] - 归档轮次；传入时读归档目录（回放历史 Story 用）
 * @returns {string} debug.jsonl 绝对路径
 */
function debugFilePath (storyId, round) {
  const storyDir = stateModule().getStoryDir(storyId)
  if (round != null) {
    return path.join(storyDir, 'archive', `round-${round}`, 'debug.jsonl')
  }
  return path.join(storyDir, 'debug.jsonl')
}

/**
 * 从文件尾部读取最后一条记录的 seq（文件为追加型，尾读 8KB 足够）
 * @param {string} filePath - debug.jsonl 路径
 * @returns {number} 最后一条的 seq，无记录时返回 0
 */
function lastSeq (filePath) {
  try {
    const size = fs.statSync(filePath).size
    if (size === 0) return 0
    const readLen = Math.min(size, 8192)
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(readLen)
    fs.readSync(fd, buf, 0, readLen, size - readLen, null)
    fs.closeSync(fd)
    const lines = buf.toString('utf-8').split('\n').filter(Boolean)
    const last = lines[lines.length - 1]
    const seq = JSON.parse(last).seq
    return Number.isFinite(seq) ? seq : 0
  } catch (e) {
    return 0
  }
}

/**
 * 追加一条调试记录到 story 的 debug.jsonl（静默失败，绝不抛错）
 *
 * @param {string} storyId - Story ID（为空或 Story 目录不存在时静默跳过）
 * @param {string} kind - 记录类型: script_output | method_output | hook_decision | state_change | agent_report
 * @param {*} data - 原始 payload（对象或任意可 JSON 序列化内容），超 64KB 截断并记指纹
 * @param {Object} [opts] - 附加信息
 * @param {string} [opts.source] - 产生记录的文件（如 'dispatch.js' / 'enforce-dev-pass.js'）
 * @param {number} [opts.phase] - 相关 Phase 编号
 * @param {number} [opts.durationMs] - 命令/方法耗时（毫秒）
 * @param {number} [opts.round] - 归档轮次：写入 archive/round-N/ 而非 root（归档动作自身的结果
 *                                 用此参数，避免在已清空的 root 重新创建 debug.jsonl）
 * @returns {boolean} 是否成功写入
 */
function record (storyId, kind, data, opts = {}) {
  try {
    if (!isEnabled() || !storyId) return false
    const storyDir = stateModule().getStoryDir(storyId)
    if (!fs.existsSync(storyDir)) return false

    // 截断保护：巨型 payload（如全量 build 日志）截断并记 sha1 指纹供对账
    let payload = data
    let truncated = false
    let hash = null
    const serialized = JSON.stringify(data)
    if (serialized && serialized.length > MAX_PAYLOAD_CHARS) {
      hash = 'sha1:' + crypto.createHash('sha1').update(serialized).digest('hex')
      payload = {
        _truncated: true,
        _hash: hash,
        _originalLength: serialized.length,
        _preview: serialized.slice(0, MAX_PAYLOAD_CHARS)
      }
      truncated = true
    }

    const filePath = debugFilePath(storyId, opts.round)
    const recordObj = {
      ts: new Date().toISOString(),
      seq: lastSeq(filePath) + 1,
      storyId,
      phase: opts.phase != null ? opts.phase : null,
      kind,
      source: opts.source || null,
      durationMs: opts.durationMs != null ? opts.durationMs : null,
      truncated,
      hash,
      data: payload
    }
    fs.appendFileSync(filePath, JSON.stringify(recordObj) + '\n', 'utf-8')
    return true
  } catch (e) {
    // 静默失败：debug 日志绝不阻塞主流程
    return false
  }
}

/**
 * 读取调试记录（回放工具用）
 *
 * @param {string} storyId - Story ID
 * @param {Object} [opts] - 过滤条件
 * @param {string} [opts.kind] - 只保留该类型
 * @param {number} [opts.phase] - 只保留该 Phase
 * @param {string} [opts.since] - 只保留 ts >= 该 ISO 时间戳的记录
 * @param {number} [opts.limit] - 最多返回条数（取末尾 N 条）
 * @param {number} [opts.round] - 读归档轮次目录而非当前目录
 * @returns {Array<Object>} 按写入顺序排列的记录数组；文件不存在返回 []
 */
function read (storyId, opts = {}) {
  try {
    const filePath = debugFilePath(storyId, opts.round)
    if (!fs.existsSync(filePath)) return []
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean)
    let records = lines
      .map(l => {
        try { return JSON.parse(l) } catch { return null }
      })
      .filter(Boolean)
    if (opts.kind) records = records.filter(r => r.kind === opts.kind)
    if (opts.phase != null) records = records.filter(r => r.phase === opts.phase)
    if (opts.since) records = records.filter(r => r.ts >= opts.since)
    if (opts.limit != null && records.length > opts.limit) {
      records = records.slice(records.length - opts.limit)
    }
    return records
  } catch (e) {
    return []
  }
}

/**
 * 重建某一时刻的 story 状态（索引卡重算的依据）
 * 从 state_change 记录序列重放：初值取第一条记录的 before（无前态即全量新写），
 * 之后逐条应用 diff，返回指定 seq（不含该条）之前的状态快照
 *
 * @param {string} storyId - Story ID
 * @param {number} [uptoSeq] - 重建到该 seq 之前（省略时取最新状态）
 * @returns {Object|null} 状态快照；无 state_change 记录时返回 null
 */
function rebuildStateAt (storyId, uptoSeq) {
  const changes = read(storyId, { kind: 'state_change' })
  const applicable = uptoSeq == null ? changes : changes.filter(c => c.seq < uptoSeq)
  if (applicable.length === 0) return null
  let state = null
  for (const c of applicable) {
    const after = c.data && c.data.after
    if (after) state = after
  }
  return state
}

module.exports = { record, read, isEnabled, rebuildStateAt, MAX_PAYLOAD_CHARS, debugFilePath }
