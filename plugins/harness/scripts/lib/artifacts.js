/**
 * artifacts.js — Story 目录下产出物的文件名唯一信源与统一读取入口
 *
 * 职责:
 *   - ARTIFACT: story 目录内全部产出物的文件名常量表（契约 JSON / 文档 md / 日志 jsonl）
 *   - 动态命名的产出物由函数生成（phaseSummary / archiveRoundDir）
 *   - 统一读取: readJson / readText / readJsonl，容错口径一处定义
 *
 * 用法:
 *   const { ARTIFACT, readJson } = require('./artifacts')
 *   const dag = readJson(storyId, ARTIFACT.TASK_DAG_JSON)
 *
 * 说明:
 *   - 存在的意义: 改前这些文件名以裸字符串散在 8 个文件共 34 处（'trace.jsonl' 有 5 处
 *     各自拼路径、'fix-request.json' 有 3 处），改一个文件名要 grep 全仓。
 *   - readJson 的容错语义与原 state.js readJsonArtifact 完全一致，不可改动:
 *     文件不存在返回 null，解析失败返回 { _parseError }。调用方靠这个区别做分支。
 *   - HARNESS_ACTIVE_FLAG 在 PLANS_DIR 根、不在 story 目录内，故不提供 storyId 版路径。
 *   - 只依赖 ./paths 与 node 内建，保持在循环依赖之外。
 *
 * @module artifacts
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir } = require('./paths')

/**
 * Story 目录内产出物文件名。
 * contract 类进 schema 校验，doc 类是人读文档，log 类是追加型日志，state 类由脚本独占写入。
 */
const ARTIFACT = {
  // ── 契约 JSON（受 schema-validator 校验）──
  STORY_INPUT: 'story-input.json',
  ACCEPTANCE_CRITERIA: 'acceptance-criteria.json',
  OPEN_QUESTIONS: 'open-questions.json',
  TASK_DAG_JSON: 'task-dag.json',
  FIGMA_FRAME_INVENTORY: 'figma-frame-inventory.json',
  CODE_REVIEW: 'code-review.json',
  ACCEPTANCE_VERIFICATION: 'acceptance-verification.json',
  FIX_REQUEST: 'fix-request.json',
  FIX_VERIFICATION: 'fix-verification.json',

  // ── 文档（md）──
  REQUIREMENT_ANALYSIS: 'requirement-analysis.md',
  PROTOTYPE_ANALYSIS: 'prototype-analysis.md',
  TASK_DAG_DOC: 'task-dag.md',
  TEST_REPORT: 'test-report.md',
  FIX_CONTEXT: 'fix-context.md',

  // ── 状态（仅授权脚本可写）──
  E2E_STATE: 'e2e-state.json',
  REPOS: 'repos.json',
  DEV_PASS: 'dev-pass.json',

  // ── 日志（追加型）──
  TRACE: 'trace.jsonl',
  DEBUG: 'debug.jsonl'
}

/** 工作流激活标记，位于 PLANS_DIR 根而非 story 目录 */
const HARNESS_ACTIVE_FLAG = path.join(PLANS_DIR, '.harness-active')

/** 归档子目录名 */
const ARCHIVE_DIR = 'archive'

/**
 * Phase 摘要文件名（动态编号）
 * @param {number} phase - Phase 序号
 * @returns {string} 形如 phase-2-summary.md
 */
function phaseSummary (phase) {
  return `phase-${phase}-summary.md`
}

/**
 * 归档轮次目录的绝对路径
 * @param {string} storyId - Story ID
 * @param {number} round - 归档轮次
 * @returns {string} 形如 <storyDir>/archive/round-1
 */
function archiveRoundDir (storyId, round) {
  return path.join(getStoryDir(storyId), ARCHIVE_DIR, `round-${round}`)
}

/**
 * 产出物绝对路径
 * @param {string} storyId - Story ID
 * @param {string} fileName - 文件名，取自 ARTIFACT 或 phaseSummary()
 * @param {number} [round] - 归档轮次；传入时指向归档副本而非当前文件
 * @returns {string} 绝对路径
 */
function artifactPath (storyId, fileName, round) {
  if (round != null) return path.join(archiveRoundDir(storyId, round), fileName)
  return path.join(getStoryDir(storyId), fileName)
}

/**
 * 读取 JSON 产出物
 *
 * 容错语义与原 readJsonArtifact 一致，调用方依赖此区别做分支，不可改动。
 *
 * @param {string} storyId - Story ID
 * @param {string} fileName - 文件名（取自 ARTIFACT）
 * @param {number} [round] - 归档轮次
 * @returns {Object|null} 成功返回对象；文件不存在返回 null；解析失败返回 { _parseError }
 */
function readJson (storyId, fileName, round) {
  const filePath = artifactPath(storyId, fileName, round)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 读取文本产出物（md 等）
 * @param {string} storyId - Story ID
 * @param {string} fileName - 文件名
 * @param {number} [round] - 归档轮次
 * @returns {string|null} 文件内容；不存在或读取失败返回 null
 */
function readText (storyId, fileName, round) {
  const filePath = artifactPath(storyId, fileName, round)
  if (!fs.existsSync(filePath)) return null
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return null
  }
}

/**
 * 读取 jsonl 日志，逐行解析并跳过坏行
 * @param {string} storyId - Story ID
 * @param {string} fileName - 文件名（ARTIFACT.TRACE / ARTIFACT.DEBUG）
 * @param {number} [round] - 归档轮次
 * @returns {Object[]} 解析成功的记录数组；文件不存在返回空数组
 */
function readJsonl (storyId, fileName, round) {
  const filePath = artifactPath(storyId, fileName, round)
  if (!fs.existsSync(filePath)) return []
  let raw = ''
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s))
    } catch (e) { /* 坏行跳过：日志为追加型，尾部可能是写入中断的半行 */ }
  }
  return out
}

module.exports = {
  ARTIFACT,
  HARNESS_ACTIVE_FLAG,
  ARCHIVE_DIR,
  phaseSummary,
  archiveRoundDir,
  artifactPath,
  readJson,
  readText,
  readJsonl
}
