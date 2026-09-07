#!/usr/bin/env node
/**
 * renew-pass.js — --renew-pass: Phase 2 dev-pass 续签
 *
 * 职责:
 *   - dev-pass 过期后无需回退 Phase，直接续签一张新的（TTL 与推进时一致）
 *   - dev-pass 是 Phase 2 的写权限凭证，过期后前端开发工程师的写操作会被
 *     hooks/enforce-dev-pass.js 拦截，续签是唯一的合规恢复手段
 *
 * 用法（由 advance-phase.js 按 flag 分派，不直接被主 Agent 调用）:
 *   const { runRenewPass } = require('./phase-ops/renew-pass')
 *   const r = runRenewPass({ storyId, targetPhase })
 *   if (r) { emit(r.output); process.exit(r.exitCode) }
 *
 * 使用场景:
 *   - Phase 2 开发中 dev-pass 超时（默认 TTL 见 lib/state.js DEV_PASS_TTL）
 *
 * 说明:
 *   - targetPhase 不为 2 时返回 null（不接管），由 advance-phase.js 继续走正常推进路径
 *     —— 与切分前 `if (renewFlag && targetPhase === 2)` 的语义完全一致
 *   - 本模块只做「计算 + 落盘」，不 emit、不 process.exit：输出由主文件统一出口，
 *     保证 debug 留痕的 source 始终是 advance-phase.js
 */

const { issueDevPass, DEV_PASS_TTL } = require('../../lib/state')
const trace = require('../../lib/trace')

/**
 * 续签 Phase 2 的 dev-pass
 *
 * @param {Object} ctx - 上下文
 * @param {string} ctx.storyId - Story ID
 * @param {number} ctx.targetPhase - 调用方传入的目标 Phase
 * @returns {{ exitCode: number, output: Object }|null} 非 Phase 2 返回 null；否则返回
 *   退出码与待输出对象（output 由调用方 emit）
 */
function runRenewPass ({ storyId, targetPhase }) {
  if (targetPhase !== 2) return null

  const pass = issueDevPass(storyId, DEV_PASS_TTL)
  if (!pass) {
    return { exitCode: 1, output: { error: '签发 dev-pass 失败' } }
  }

  trace.tracePhaseTransition(storyId, 2, 2)

  return {
    exitCode: 0,
    output: {
      success: true,
      storyId,
      phase: 2,
      pass: {
        expiresAt: pass.expiresAt,
        allowedPaths: pass.allowedPaths.length + ' files',
        source: pass.pathSource
      }
    }
  }
}

module.exports = { runRenewPass }
