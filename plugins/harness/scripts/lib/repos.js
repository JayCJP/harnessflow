/**
 * repos.js — 仓库注册表（repos.json，Story 级独立）
 *
 * 职责:
 *   - 读写每个 Story 自己的 repos.json（primary 仓库名 + 仓库名→根路径映射）
 *   - 仓库名 → 根路径解析；文件路径 → 所属仓库反查（最长前缀匹配）
 *   - isSrcFile: 判断路径是否落在已注册仓库的 src/ 下（dev-pass 保护的代码区域）
 *
 * 用法:
 *   const { loadRepos, getRepoRoot, isSrcFile } = require('./repos')
 *
 * 使用场景:
 *   - dev-pass 限域: task 的 files[] 要按 task.project / task.repo 归到正确仓库
 *   - hooks/enforce-dev-pass.js: 判断被编辑的文件是否属于受保护的 src/
 *   - 跨仓 Story 的产出物路径解析
 *
 * 说明:
 *   - 统一模式：无论单仓库还是多仓库，loadRepos() 永远返回有效对象，不返回 null。
 *     单仓库默认值 = { primary: 项目根 basename, repos: { <name>: PROJECT_ROOT } }。
 *   - isSrcFile 需要 getRepoForFile（依赖仓库注册表），所以放在本模块而不是零依赖的
 *     paths.js —— paths.js 只做纯路径推导，不能依赖 repos.json。
 */

const fs = require('fs')
const path = require('path')
const { PROJECT_ROOT, PLANS_DIR, getStoryDir } = require('./paths')
const { ARTIFACT } = require('./artifacts')

/**
 * 获取指定 Story 的 repos.json 路径（每个 story 独立配置）
 * @param {string} storyId - Story ID
 * @returns {string} 该 Story 的 repos.json 绝对路径
 */
function getReposFilePath (storyId) {
  return path.join(PLANS_DIR, storyId, ARTIFACT.REPOS)
}

/**
 * 获取项目根目录的 basename 作为默认仓库名
 * @returns {string} 默认仓库名（如 "userlive"）
 */
function getDefaultRepoName () {
  return path.basename(PROJECT_ROOT)
}

/**
 * 加载仓库注册表（repos.json，story 级独立）
 * 统一模式：无论单仓库还是多仓库，永远返回有效对象，不返回 null。
 * - storyId 指定且 repos.json 存在且合法 → 读取返回
 * - storyId 指定但 repos.json 不存在 → 返回单仓库默认（不写入文件）
 * - storyId 未指定（null/undefined）→ 返回单仓库默认（向后兼容）
 * @param {string} [storyId] - Story ID（story 级独立配置）
 * @returns {{ primary: string, repos: Object<string, string>, updatedAt?: string }}
 *   primary: 主仓库名；repos: 仓库名→绝对根路径映射
 */
function loadRepos (storyId) {
  // story 级配置优先
  if (storyId) {
    const storyReposFile = getReposFilePath(storyId)
    if (fs.existsSync(storyReposFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(storyReposFile, 'utf-8'))
        if (data && data.primary && data.repos && data.repos[data.primary]) {
          return data
        }
      } catch (e) { /* 解析失败，降级为单仓库默认 */ }
    }
  }
  // 单仓库默认（story 未配置或 storyId 未传）
  const name = getDefaultRepoName()
  return { primary: name, repos: { [name]: PROJECT_ROOT } }
}

/**
 * 确保 repos.json 存在（不存在则生成单仓库默认，story 级独立）
 * 在 /harness start 和 create-workflow 时调用。
 * 多仓库场景由 AI 预先写入 repos.json，此函数检测到已存在则跳过（不覆盖）。
 * @param {string} storyId - Story ID（必填，story 级独立配置）
 * @param {Object} [overrideConfig] - 可选，强制写入的配置（{ primary, repos }），会覆盖已有文件
 * @returns {Object} 最终的 repos 配置
 */
function ensureReposJson (storyId, overrideConfig) {
  if (!storyId) throw new Error('ensureReposJson: storyId is required')
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) {
    fs.mkdirSync(storyDir, { recursive: true })
  }
  const reposFile = getReposFilePath(storyId)
  // 强制覆盖模式（AI 检测到多仓库后主动写入）
  if (overrideConfig && overrideConfig.primary && overrideConfig.repos) {
    const config = { ...overrideConfig, updatedAt: new Date().toISOString() }
    fs.writeFileSync(reposFile, JSON.stringify(config, null, 2), 'utf-8')
    return config
  }
  // 已存在则不覆盖（保留用户/AI 预配置）
  if (!fs.existsSync(reposFile)) {
    const name = getDefaultRepoName()
    const config = {
      primary: name,
      repos: { [name]: PROJECT_ROOT },
      updatedAt: new Date().toISOString()
    }
    fs.writeFileSync(reposFile, JSON.stringify(config, null, 2), 'utf-8')
    return config
  }
  return loadRepos(storyId)
}

/**
 * 根据仓库名获取仓库根路径
 * @param {string} [repoName] - 仓库名，缺省或未注册时回退到 primary
 * @param {Object} [repos] - 已加载的 repos 配置，不传则自动 loadRepos()
 * @returns {string} 仓库根绝对路径
 */
function getRepoRoot (repoName, repos) {
  const r = repos || loadRepos()
  const name = repoName || r.primary
  return r.repos[name] || r.repos[r.primary] || PROJECT_ROOT
}

/**
 * 根据文件绝对路径反查所属仓库（支持嵌套目录最长前缀匹配）
 * @param {string} absPath - 文件绝对路径
 * @param {Object|string} [reposOrStoryId] - 已加载的 repos 配置 或 storyId（string）
 *   传入 Object → 直接使用
 *   传入 string → 调用 loadRepos(storyId)
 *   不传 → 单仓库默认（向后兼容）
 * @returns {{ name: string, root: string, relPath: string }|null}
 *   匹配成功返回 { name, root, relPath }；不属于任何已注册仓库返回 null
 */
function getRepoForFile (absPath, reposOrStoryId) {
  let r
  if (typeof reposOrStoryId === 'string') {
    r = loadRepos(reposOrStoryId)
  } else if (reposOrStoryId && typeof reposOrStoryId === 'object') {
    r = reposOrStoryId
  } else {
    r = loadRepos()
  }
  if (!absPath) return null
  const norm = path.resolve(absPath).replace(/\\/g, '/')
  let bestMatch = null
  let bestLen = 0
  for (const [name, root] of Object.entries(r.repos)) {
    const rootNorm = path.resolve(root).replace(/\\/g, '/') + '/'
    if (norm.startsWith(rootNorm) && rootNorm.length > bestLen) {
      bestMatch = { name, root, relPath: norm.slice(rootNorm.length) }
      bestLen = rootNorm.length
    }
  }
  return bestMatch
}

/**
 * 检查文件路径是否在某个已注册仓库的 src/ 目录下（需要保护的代码区域）
 * 统一模式：基于 repos.json 判断，单仓库时 repos.json 缺省即 primary 仓库。
 * @param {string} filePath - 文件路径（相对或绝对）
 * @returns {boolean} 是否属于已注册仓库的 src/
 */
function isSrcFile (filePath) {
  if (!filePath) return false
  const normalized = path.normalize(filePath).replace(/\\/g, '/')
  // 快速过滤：不含 /src/ 的路径直接排除
  if (!normalized.includes('/src/') && !normalized.startsWith('src/')) return false
  // 统一模式：确认属于某个已注册仓库（单仓库时自动匹配 primary）
  const repoInfo = getRepoForFile(filePath)
  return repoInfo !== null
}

module.exports = {
  getReposFilePath,
  getDefaultRepoName,
  loadRepos,
  ensureReposJson,
  getRepoRoot,
  getRepoForFile,
  isSrcFile
}
