/**
 * story-info.js — Story 身份卡（story-info.json）的写入与读取
 *
 * 职责:
 *   - 在新建 Story 时落一份 story-info.json: storyId / 标题 / 模式 / TAPD 需求与工作区 /
 *     仓库 / 工作区根路径 / 时间线
 *   - 该文件是 Story 的**长期身份卡**: 归档（archive-story.js）不移动它，
 *     归档后 root 只剩 archive/ 与它，因此「这个 Story 做过什么需求」不会随归档丢失
 *   - TAPD 相关字段由 story-input.json 的 sources 原样投影，不在此处重新解析 URL
 *
 * 用法:
 *   const { ensureStoryInfo, readStoryInfo, refreshStoryInfoSources } = require('./story-info')
 *
 * 使用场景:
 *   - commands/create-workflow.js 建流时调用 ensureStoryInfo 写入初始身份卡
 *   - create-workflow.js --refresh-input: story-input.json 在之后才写入时，用
 *     refreshStoryInfoSources 补全 TAPD / 原型 / Figma 等来源字段
 *   - commands/archive-story.js: 归档时跳过本文件；归档完成后回填 archivedAt / archiveRound
 *
 * 说明:
 *   - 只依赖 ./paths、./artifacts、./repos 与 node 内建，保持在循环依赖之外
 *   - 写入失败不抛异常给主流程以外的调用方以外的地方不需要关心 —— 本模块直接抛，
 *     由 create-workflow 的 try/catch 决定是否降级（身份卡缺失不应阻断建流）
 *
 * @module story-info
 */

const fs = require('fs')
const path = require('path')
const { PROJECT_ROOT, PLANS_DIR } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { loadRepos } = require('./repos')

/**
 * 把路径统一成正斜杠
 * UI 的 markdown 渲染层会把 \. 当转义吃掉，写进可读文件的路径必须走这里
 * @param {string} p - 原始路径
 * @returns {string} 正斜杠路径
 */
function toForwardSlashes (p) {
  return String(p || '').replace(/\\/g, '/')
}

/**
 * 获取 story-info.json 的绝对路径
 * @param {string} storyId - Story ID
 * @returns {string} 绝对路径
 */
function getStoryInfoPath (storyId) {
  return path.join(PLANS_DIR, storyId, ARTIFACT.STORY_INFO)
}

/**
 * 读取 story-info.json
 * @param {string} storyId - Story ID
 * @returns {Object|null} 解析结果；文件不存在返回 null，损坏返回 { _parseError }
 */
function readStoryInfo (storyId) {
  const filePath = getStoryInfoPath(storyId)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 写入 story-info.json（覆盖）
 * @param {string} storyId - Story ID
 * @param {Object} info - 身份卡对象
 * @returns {string} 写入的文件绝对路径
 */
function writeStoryInfo (storyId, info) {
  const filePath = getStoryInfoPath(storyId)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  info.updatedAt = new Date().toISOString()
  fs.writeFileSync(filePath, JSON.stringify(info, null, 2) + '\n', 'utf-8')
  return filePath
}

/**
 * 把 story-input.json 的 sources 投影成身份卡的 sources
 *
 * 只搬运，不解析：tapdUrl / workspaceId / storyIdInTapd 等由主 Agent 在建流前写入
 * story-input.json，这里原样保留，避免出现「URL 解析出一份、原始输入又一份」的双信源。
 *
 * @param {Object|null} sources - story-input.json 的 sources
 * @returns {Object} 身份卡 sources（缺省为空对象）
 */
function projectSources (sources) {
  if (!sources || typeof sources !== 'object') return {}
  const keys = ['tapdUrl', 'workspaceId', 'storyIdInTapd', 'owner', 'statusFilter',
    'terminal', 'prototypeUrls', 'figmaUrls', 'docs']
  const out = {}
  for (const k of keys) {
    const v = sources[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'string' && v === '') continue
    out[k] = v
  }
  return out
}

/**
 * 读取仓库注册表并投影成身份卡的 repos 段
 * 只记录仓库名与主仓库名，不记录绝对路径（路径随机器变化，跨机器复用会失效）
 * @param {string} storyId - Story ID
 * @returns {{ primary: string, names: string[] }}
 */
function projectRepos (storyId) {
  const repos = loadRepos(storyId)
  const names = Object.keys(repos.repos || {})
  return { primary: repos.primary, names }
}

/**
 * 新建 Story 时写入身份卡（已存在则保留，不覆盖）
 *
 * @param {string} storyId - Story ID
 * @param {Object} opts - 建流参数
 * @param {string} opts.title - 需求标题
 * @param {'run'|'fixbugs'} opts.mode - 工作流模式
 * @param {Object} [opts.sources] - story-input.json 的 sources（可为空）
 * @param {number} opts.phase - 初始 Phase（bypass 时为 2）
 * @returns {Object} 写入的身份卡；若已存在则返回既有内容
 */
function ensureStoryInfo (storyId, opts) {
  const existing = readStoryInfo(storyId)
  if (existing && !existing._parseError) return existing

  const now = new Date().toISOString()
  const info = {
    version: 1,
    storyId,
    title: opts.title || '',
    mode: opts.mode === 'fixbugs' ? 'fixbugs' : 'run',
    createdAt: now,
    initialPhase: opts.phase,
    sources: projectSources(opts.sources),
    repos: projectRepos(storyId),
    workflowRoot: toForwardSlashes(PROJECT_ROOT)
  }
  writeStoryInfo(storyId, info)
  return info
}

/**
 * 补全身份卡的来源字段（--refresh-input 时调用）
 *
 * 场景: start 流程里 createWorkflow 先执行、story-input.json 之后才由主 Agent 写入。
 * 此时 ensureStoryInfo 拿不到 sources，只能写空对象。写完 story-input.json 后
 * 执行 --refresh-input 即可把 TAPD 需求 / 工作区 / 设计稿链接补进身份卡。
 *
 * @param {string} storyId - Story ID
 * @param {Object|null} sources - story-input.json 的 sources
 * @returns {{ updated: boolean, sources: Object }} 是否发生变化
 */
function refreshStoryInfoSources (storyId, sources) {
  const info = readStoryInfo(storyId)
  if (!info || info._parseError) return { updated: false, sources: {} }

  const next = projectSources(sources)
  const before = JSON.stringify(info.sources || {})
  const after = JSON.stringify(next)
  if (before === after) return { updated: false, sources: next }

  info.sources = next
  info.repos = info.repos || projectRepos(storyId)
  writeStoryInfo(storyId, info)
  return { updated: true, sources: next }
}

/**
 * 归档后回填归档元信息（身份卡本身不被归档移动，就地更新）
 * @param {string} storyId - Story ID
 * @param {{ archivedAt: string, archiveRound: number, archiveDir: string, phaseReached: number }} meta - 归档元信息
 * @returns {boolean} 是否写入成功（身份卡缺失时返回 false，不抛错）
 */
function markArchived (storyId, meta) {
  const info = readStoryInfo(storyId)
  if (!info || info._parseError) return false
  info.status = 'archived'
  info.archivedAt = meta.archivedAt
  info.archiveRound = meta.archiveRound
  info.archiveDir = meta.archiveDir
  info.phaseReached = meta.phaseReached
  writeStoryInfo(storyId, info)
  return true
}

/**
 * 复档后回填恢复信息
 * @param {string} storyId - Story ID
 * @param {{ restoredAt: string, restoredFromRound: number }} meta - 复档元信息
 * @returns {boolean} 是否写入成功
 */
function markRestored (storyId, meta) {
  const info = readStoryInfo(storyId)
  if (!info || info._parseError) return false
  info.status = 'running'
  info.restoredAt = meta.restoredAt
  info.restoredFromRound = meta.restoredFromRound
  writeStoryInfo(storyId, info)
  return true
}

module.exports = {
  getStoryInfoPath,
  readStoryInfo,
  writeStoryInfo,
  ensureStoryInfo,
  refreshStoryInfoSources,
  markArchived,
  markRestored,
  projectSources,
  projectRepos
}
