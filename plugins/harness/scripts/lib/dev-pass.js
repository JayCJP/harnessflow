/**
 * dev-pass.js — 开发通行证（dev-pass）生命周期 + 修复回路轮次预算
 *
 * 职责:
 *   - dev-pass: Phase 2 的 src/ 写权限凭证 —— 签发（issueDevPass）、撤销（revokeDevPass）、
 *     有效性检查（checkDevPass，顺带清理过期文件）、续签（renewDevPass）
 *   - 限域来源: getDevPassAllowedPaths 从 task-dag.json 的 files[] 提取允许编辑的
 *     文件清单（按 task.project / task.repo 归仓），取不到时降级为 src/** 并给 warning
 *   - 修复轮次预算: getMaxFixRounds 按失败源（Phase 3 审查 / Phase 4 测试）独立计数
 *
 * 用法:
 *   const { issueDevPass, revokeDevPass, getMaxFixRounds } = require('./dev-pass')
 *
 * 使用场景:
 *   - Phase 1→2 签发、Phase 2→3 撤销、Phase 4→5 兜底撤销（commands/advance-phase.js）
 *   - hooks/enforce-dev-pass.js 读 dev-pass 判断 src/ 编辑是否放行
 *   - Phase 2 开发超时后用 `--renew-pass` 续签，不必回退重来
 *
 * 说明:
 *   - dev-pass 是「写权限」而非「门控」：门控在 policy.js，这里只管凭证本身。
 *     限域精度直接决定拦截有效性 —— 降级为 src/** 等于放行整个源码目录，
 *     所以 getDevPassAllowedPaths 拿不到 files 时必须显式给出 warning。
 *   - checkDevPass 扫描全部 Story 目录、返回第一个有效凭证，并**顺手删除过期/损坏的
 *     dev-pass.json**（幂等清理，避免审计时被历史文件干扰）。
 *   - 修复轮次按失败源独立预算是 2026-09 的修正：旧实现单一 maxFixRounds，
 *     code-review 耗尽的次数会吃掉 test 的额度，反之亦然。
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir, ensureStoryDir, listStoryDirs } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { TASK_DAG_JSON_FILE, readJsonArtifact } = require('./contracts')
const { loadRepos } = require('./repos')
const { readStateFile } = require('./story-state')

/**
 * 从 task-dag.json 中提取 dev-pass 允许编辑的文件路径
 * 用于 Phase 2 开发通行证的精确限域。
 * 统一模式：输出 { repo, path } 对象数组，repo 缺省为 primary 仓库。
 * @param {string} storyId - Story ID
 * @returns {{ paths: Array<{repo:string,path:string}>, source: string, warnings: string[] }}
 *   paths: 允许编辑的文件列表（对象数组）；source: 'task-dag.json' | 'fallback-src-glob' | 'none'
 */
function getDevPassAllowedPaths (storyId) {
  const result = { paths: [], source: 'none', warnings: [] }
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!taskData || taskData._parseError) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push(`${TASK_DAG_JSON_FILE} 不存在或解析失败，dev-pass 降级为 ${repos.primary}:src/** 授权`)
    return result
  }

  if (!Array.isArray(taskData.tasks) || taskData.tasks.length === 0) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push('task-dag.json 中无任务，dev-pass 降级为 ' + repos.primary + ':src/** 全局授权')
    return result
  }

  // 收集所有 task 的 files，统一为 { repo, path } 对象格式（去重）
  const allFiles = new Set()
  for (const task of taskData.tasks) {
    if (!Array.isArray(task.files)) continue
    // 优先使用 task.project，其次 task.repo，缺省为 primary
    const repoName = task.project || task.repo || repos.primary
    // 验证 repo 是否已注册，未注册则回退到 primary
    const validRepo = repos.repos[repoName] ? repoName : repos.primary
    for (const f of task.files) {
      if (typeof f === 'string' && f.trim()) {
        allFiles.add(JSON.stringify({ repo: validRepo, path: f.trim() }))
      }
    }
  }

  if (allFiles.size === 0) {
    result.source = 'fallback-src-glob'
    result.paths = [{ repo: repos.primary, path: 'src/**' }]
    result.warnings.push('task-dag.json 中所有 task 的 files 均为空，dev-pass 降级为 ' + repos.primary + ':src/** 全局授权')
  } else {
    result.source = TASK_DAG_JSON_FILE
    result.paths = [...allFiles].map(s => JSON.parse(s))
  }

  return result
}

/** dev-pass 默认有效期（毫秒）：2 小时 */
const DEV_PASS_TTL = 2 * 60 * 60 * 1000

/**
 * 签发 dev-pass（开发通行证）
 * 在 Phase 2 开始时调用，允许 src/ 目录的文件编辑。
 * CCHF 升级：支持从 task-dag.json 读取精确限域，替代全局 src/** 授权。
 * @param {string} storyId - Story ID
 * @param {number} ttl - 有效期（毫秒），默认 2 小时
 * @param {string[]} allowedPaths - 允许编辑的文件路径列表，不传则用 getDevPassAllowedPaths() 自动获取
 * @returns {Object} dev-pass 对象
 */
function issueDevPass (storyId, ttl = DEV_PASS_TTL, allowedPaths = null) {
  const now = new Date()

  // CCHF: 统一路径格式 — 支持数组直接传入或从 task-dag.json 获取
  let paths
  if (Array.isArray(allowedPaths)) {
    // 外部已传入路径数组，包装为统一格式
    paths = { paths: allowedPaths, source: 'external', warnings: [] }
  } else {
    // 从 task-dag.json 自动获取
    paths = getDevPassAllowedPaths(storyId)
  }

  const devPass = {
    storyId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    phase: 2,
    reason: 'Phase 2 development',
    allowedPaths: paths.paths,
    pathSource: paths.source,
    pathWarnings: paths.warnings
  }

  ensureStoryDir(storyId)
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.DEV_PASS)
  fs.writeFileSync(filePath, JSON.stringify(devPass, null, 2), 'utf-8')

  return devPass
}

/**
 * 撤销 dev-pass
 * 在 Phase 2 结束或 Phase 3 开始时调用，阻止后续 src/ 编辑。
 * @param {string} storyId - Story ID
 * @returns {void}
 */
function revokeDevPass (storyId) {
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.DEV_PASS)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

/**
 * 检查是否存在有效的 dev-pass
 * 扫描所有 Story 子目录下的 dev-pass.json，返回第一个有效的。
 * @returns {{ valid: boolean, storyId: string|null, reason: string }}
 */
function checkDevPass () {
  const dirs = listStoryDirs()
  const now = new Date()

  for (const dir of dirs) {
    const filePath = path.join(PLANS_DIR, dir, ARTIFACT.DEV_PASS)
    if (!fs.existsSync(filePath)) continue

    try {
      const pass = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const expiresAt = new Date(pass.expiresAt)

      if (now < expiresAt) {
        return {
          valid: true,
          storyId: dir,
          reason: `有效 (storyId: ${dir}, 过期时间: ${pass.expiresAt})`
        }
      } else {
        // 已过期，自动清理
        fs.unlinkSync(filePath)
      }
    } catch (e) {
      // 解析失败，删除无效文件
      try { fs.unlinkSync(filePath) } catch {}
    }
  }

  return { valid: false, storyId: null, reason: '无有效的开发通行证' }
}

/**
 * 续签 dev-pass
 * 当开发时间超过有效期时，可续签。
 * @param {string} storyId - Story ID
 * @param {number} ttl - 新有效期（毫秒），默认 2 小时
 * @returns {Object|null} 续签后的 dev-pass，状态文件不存在或非 Phase 2 时返回 null
 */
function renewDevPass (storyId, ttl = DEV_PASS_TTL) {
  const state = readStateFile(storyId)
  if (!state || state.phase !== 2) {
    return null
  }
  return issueDevPass(storyId, ttl)
}

/**
 * 默认最大修复轮次 —— 按失败源（Phase 3 代码审查 / Phase 4 功能测试）独立预算。
 *
 * 历史缺陷: 旧实现单一 `maxFixRounds`，Phase 3 与 Phase 4 发起的 fix-loop
 * 共享同一轮次预算，code-review 耗尽的次数会吃掉 test 的额度，反之亦然。
 * 现拆分为各 2 次独立计数，用尽各自转人工。
 */
const DEFAULT_MAX_REVIEW_FIX_ROUNDS = 2
const DEFAULT_MAX_TEST_FIX_ROUNDS = 2

/**
 * 获取指定失败源的最大修复轮次配置
 * 统一从 e2e-state.json 读取（在 create-workflow.js 创建 state 时写入）：
 *   - sourcePhase 3（代码审查）→ maxReviewFixRounds
 *   - sourcePhase 4（功能测试）→ maxTestFixRounds
 * 缺省用各自默认值。如需调整，直接修改 e2e-state.json 对应字段即可，单一信源无歧义。
 * @param {string} storyId - Story ID
 * @param {number} [sourcePhase] - 失败源 Phase（3=code-review / 4=test），缺省或非 3/4 回退到 review 预算
 * @returns {number} 最大修复轮次
 */
function getMaxFixRounds (storyId, sourcePhase) {
  const state = readStateFile(storyId)
  if (state && sourcePhase === 4) {
    if (typeof state.maxTestFixRounds === 'number' && state.maxTestFixRounds > 0) {
      return state.maxTestFixRounds
    }
    return DEFAULT_MAX_TEST_FIX_ROUNDS
  }
  if (state && typeof state.maxReviewFixRounds === 'number' && state.maxReviewFixRounds > 0) {
    return state.maxReviewFixRounds
  }
  return DEFAULT_MAX_REVIEW_FIX_ROUNDS
}

module.exports = {
  DEV_PASS_TTL,
  getDevPassAllowedPaths,
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  renewDevPass,
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS,
  getMaxFixRounds
}
