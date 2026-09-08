/**
 * story-state.js — e2e-state.json 的读写与工作流查询
 *
 * 职责:
 *   - e2e-state.json 的 CRUD（readStateFile / writeStateFile）
 *   - 活跃工作流查询（findActiveWorkflows / hasActiveWorkflow）
 *   - Phase 完成状态判定（isPhaseCompleted）
 *   - 工作流终态判定（isWorkflowTerminal，唯一信源）
 *   - Story 目录清理（cleanStoryDir）
 *
 * 用法:
 *   const { readStateFile, writeStateFile } = require('./story-state')
 *
 * 使用场景:
 *   - 相位跃迁: commands/advance-phase.js 是唯一改写 state.phase 的地方
 *   - 断点恢复: hooks/session-start.js 扫描活跃工作流并注入续跑指引
 *   - 人工诊断: audit/harness-audit.js 校验 .harness-active 与 e2e-state 一致性
 *
 * 说明:
 *   - writeStateFile 会把「变更前后 diff + 变更后全量快照」写进 debug 载荷层，
 *     供 debug-replay 重建任意时刻状态；updatedAt 每次写入必变、无信息量，不进 diff。
 *     debug 记录静默失败，绝不影响状态写入。
 *   - readStateFile 解析失败时返回 `{ _parseError }` 而非 null：调用方据此区分
 *     「文件不存在」与「文件损坏」，前者可创建、后者必须人工介入。
 *   - 状态文件只有 advance-phase.js / create-workflow.js / archive-story.js /
 *     harness-workflow.js 可写，由 hooks/enforce-state-file.js 强制。
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir, ensureStoryDir, listStoryDirs } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { PHASE_SLUGS, MAX_PHASE } = require('./phases')
const debugLog = require('./debug-log')

/**
 * 读取并解析 e2e-state.json
 * @param {string} storyId - Story ID
 * @returns {Object|null} 状态对象，文件不存在时返回 null，解析失败返回 { _parseError }
 */
function readStateFile (storyId) {
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.E2E_STATE)
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 写入 e2e-state.json
 * @param {string} storyId - Story ID
 * @param {Object} state - 状态对象
 * @returns {void}
 */
function writeStateFile (storyId, state) {
  ensureStoryDir(storyId)
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.E2E_STATE)

  // debug 载荷层：记录变更前后 diff + 变更后全量快照（供 debug-replay 重建任意时刻状态）。
  // updatedAt 每次写入必变、无信息量，不进 diff。record 静默失败不影响状态写入。
  let before = null
  try {
    if (fs.existsSync(filePath)) before = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) { before = null }
  const diff = {}
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(state || {})])
  for (const k of keys) {
    if (k === 'updatedAt') continue
    if (JSON.stringify(before ? before[k] : undefined) !== JSON.stringify(state ? state[k] : undefined)) {
      diff[k] = { from: before ? before[k] : undefined, to: state ? state[k] : undefined }
    }
  }
  debugLog.record(storyId, 'state_change', { diff, after: state }, {
    source: 'state.js',
    phase: state && typeof state.phase === 'number' ? state.phase : null
  })

  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * 查找所有活跃的工作流（status 为 running 或 paused）
 * @returns {Array<{storyId: string, state: Object}>} 活跃的工作流列表
 */
function findActiveWorkflows () {
  const dirs = listStoryDirs()
  const workflows = []

  for (const dir of dirs) {
    const stateFile = path.join(PLANS_DIR, dir, ARTIFACT.E2E_STATE)
    if (!fs.existsSync(stateFile)) continue

    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      if (state.status === 'running' || state.status === 'paused') {
        workflows.push({ storyId: dir, state })
      }
    } catch (e) {
      // JSON 解析失败，忽略
    }
  }

  return workflows
}

/**
 * 检查是否有活跃的 e2e 工作流
 * @returns {boolean}
 */
function hasActiveWorkflow () {
  return findActiveWorkflows().length > 0
}

/**
 * 检查指定 Phase 是否已完成
 * @param {Object} state - 状态对象
 * @param {number} phaseNum - Phase 编号
 * @returns {boolean}
 */
function isPhaseCompleted (state, phaseNum) {
  const phaseKey = `${phaseNum}_${PHASE_SLUGS[phaseNum]}`
  const phaseState = state?.phases?.[phaseKey]
  return phaseState?.status === 'completed'
}

/**
 * 判断工作流是否已走到最后一步（终态）
 *
 * 「最后一步」的唯一信源 = MAX_PHASE（由 PHASE_SLUGS 推导），Phase 表增删时自动适配，
 * 调用方禁止自行硬编码 Phase 编号 —— session-stop.js 曾硬编码 `phase >= 8`，
 * 而终态实为 7，导致自动 end 永不触发。
 *
 * status === 'completed' 一并视为终态：advance-phase 推进到 MAX_PHASE 时会写下它，
 * 直接改状态文件的场景（复档 / 人工收尾）也靠这一支判定。
 *
 * @param {Object} state - e2e-state.json 状态对象
 * @returns {boolean} 已到终态为 true
 */
function isWorkflowTerminal (state) {
  if (!state) return false
  return Number(state.phase) >= MAX_PHASE || state.status === 'completed'
}

/**
 * 清理 Story 目录（删除空目录或整个目录）
 * @param {string} storyId - Story ID
 * @param {boolean} force - 是否强制删除（即使目录非空）
 * @returns {void}
 */
function cleanStoryDir (storyId, force = false) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) return

  if (force) {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  }

  // 非强制：仅删除空目录
  const files = fs.readdirSync(dir)
  if (files.length === 0) {
    fs.rmdirSync(dir)
  }
}

module.exports = {
  readStateFile,
  writeStateFile,
  findActiveWorkflows,
  hasActiveWorkflow,
  isPhaseCompleted,
  isWorkflowTerminal,
  cleanStoryDir
}
