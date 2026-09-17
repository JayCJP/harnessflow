/**
 * dev-pass.js — 开发通行证（dev-pass）生命周期 + 修复回路轮次预算
 *
 * 职责:
 *   - dev-pass: Phase 2 的 src/ 写权限凭证 —— 签发（issueDevPass）、撤销（revokeDevPass）、
 *     有效性检查（checkDevPass，顺带清理过期文件）、续签（renewDevPass）
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
 *   - dev-pass 只回答「能不能写 src/」，不回答「能写哪些文件」。
 *     文件级限域已改为事后审计：policy.js 在 Phase 2→3 用 git 实际变更比对
 *     task-dag.json 的声明范围（lib/scope.js），把范围外改动落 scope-amendments.json，
 *     交 Phase 3 审查逐条核对。凭证里不再存 allowedPaths —— 那份快照只是 task-dag.json
 *     的副本，留着会在两处给出可能不一致的答案。
 *   - checkDevPass 扫描全部 Story 目录、返回第一个有效凭证，并**顺手删除过期/损坏的
 *     dev-pass.json**（幂等清理，避免审计时被历史文件干扰）。
 *   - 修复轮次按失败源独立预算是 2026-09 的修正：旧实现单一 maxFixRounds，
 *     code-review 耗尽的次数会吃掉 test 的额度，反之亦然。
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR, getStoryDir, ensureStoryDir, listStoryDirs } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { readStateFile } = require('./story-state')

/** dev-pass 默认有效期（毫秒）：2 小时 */
const DEV_PASS_TTL = 2 * 60 * 60 * 1000

/**
 * 签发 dev-pass（开发通行证）
 *
 * 在 Phase 2 开始时调用，允许 src/ 目录的文件编辑。
 * 2026-09 起不再携带 allowedPaths/pathSource/pathWarnings —— 文件级判定移到 lib/scope.js
 * 并以 git 实际变更为准（详见文件头说明）。
 *
 * @param {string} storyId - Story ID
 * @param {number} [ttl] - 有效期（毫秒），默认 2 小时
 * @param {string} [reason] - 签发原因（写进凭证 reason 字段，供放行文案与审计回溯），
 *   默认 'Phase 2 development'；fix-loop 重签时传入轮次信息以便区分
 * @returns {Object} dev-pass 对象（storyId / issuedAt / expiresAt / phase / reason）
 */
function issueDevPass (storyId, ttl = DEV_PASS_TTL, reason = 'Phase 2 development') {
  const now = new Date()

  const devPass = {
    storyId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    phase: 2,
    reason
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
 * 默认最大修复轮次。
 *
 * 历史缺陷: 旧实现单一 `maxFixRounds`，Phase 3 与 Phase 4 发起的 fix-loop
 * 共享同一轮次预算，code-review 耗尽的次数会吃掉 test 的额度，反之亦然。
 * 后拆分为 review / test 各 2 次独立计数。
 *
 * Phase 4（功能测试）移除后修复回路只服务 Phase 3 代码审查，test 预算与
 * `maxTestFixRounds` 一并删除 —— 保留一个永不生效的分支就是假门控。
 */
const DEFAULT_MAX_REVIEW_FIX_ROUNDS = 2

/**
 * 获取最大修复轮次配置
 * 统一从 e2e-state.json 读取（在 create-workflow.js 创建 state 时写入 maxReviewFixRounds）。
 * 缺省用默认值。如需调整，直接修改 e2e-state.json 对应字段即可，单一信源无歧义。
 * @param {string} storyId - Story ID
 * @returns {number} 最大修复轮次
 */
function getMaxFixRounds (storyId) {
  const state = readStateFile(storyId)
  if (state && typeof state.maxReviewFixRounds === 'number' && state.maxReviewFixRounds > 0) {
    return state.maxReviewFixRounds
  }
  return DEFAULT_MAX_REVIEW_FIX_ROUNDS
}

module.exports = {
  DEV_PASS_TTL,
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  renewDevPass,
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  getMaxFixRounds
}
