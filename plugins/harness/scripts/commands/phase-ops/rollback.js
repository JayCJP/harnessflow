#!/usr/bin/env node
/**
 * rollback.js — --rollback: 回退到更早的 Phase
 *
 * 职责:
 *   - 把 targetPhase+1 ~ currentPhase 的产出物归档到 story 目录的 archive/
 *     （重命名为 .archived 后缀，不删除，可追溯）
 *   - 回写 e2e-state.json：中间 Phase 标记 rolled_back、目标 Phase 置 running
 *   - dev-pass 处理：回到 Phase 2 重新签发，回到更早则撤销
 *   - 修复预算重置：回到 Phase 2 或更早时归档 fix-request.json，避免上一轮的
 *     轮次计数吃掉本轮预算（否则会直接撞 fix_loop_exhausted）
 *
 * 用法（由 advance-phase.js 按 flag 分派，不直接被主 Agent 调用）:
 *   const { runRollback } = require('./phase-ops/rollback')
 *   const r = runRollback({ storyId, state, currentPhase, currentPhaseName, targetPhase, ARCHIVE_CMD })
 *   emit(r.output); process.exit(r.exitCode)
 *
 * 使用场景:
 *   - 某 Phase 的产出物方向性错误，需要回到更早的 Phase 重做
 *   - 与 --fix-loop 的区别: rollback 是人工决策的任意回退；fix-loop 是 Phase 3/4
 *     失败后由脚本提取 BLOCKER 并固定回退到 Phase 2
 *
 * 说明:
 *   - 本模块只做「计算 + 落盘」，不 emit、不 process.exit：输出由主文件统一出口，
 *     保证 debug 留痕的 source 始终是 advance-phase.js
 *   - 进度文本走 console.error（stderr），主文件 stdout 只留末尾那份 JSON
 */

const fs = require('fs')
const path = require('path')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  PHASE_SLUGS,
  PHASE_ARTIFACTS,
  getPhaseName,
  issueDevPass,
  revokeDevPass,
  writeStateFile,
  DEV_PASS_TTL
} = require('../../lib/state')
const trace = require('../../lib/trace')

/**
 * 回退到更早的 Phase
 *
 * @param {Object} ctx - 上下文
 * @param {string} ctx.storyId - Story ID
 * @param {Object} ctx.state - e2e-state.json 解析对象（原地修改）
 * @param {number} ctx.currentPhase - 当前 Phase
 * @param {string} ctx.currentPhaseName - 当前 Phase 名
 * @param {number} ctx.targetPhase - 目标 Phase（必须 < currentPhase）
 * @param {string} ctx.ARCHIVE_CMD - archive-story.js 的绝对调用形式（错误提示里给出）
 * @returns {{ exitCode: number, output: Object }} 退出码与待输出对象（output 由调用方 emit）
 */
function runRollback ({ storyId, state, currentPhase, currentPhaseName, targetPhase, ARCHIVE_CMD }) {
  // 🛡️ 归档状态守卫：归档后产出物已移走，回退无意义
  if (state.status === 'archived') {
    return {
      exitCode: 1,
      output: {
        error: `Story 已归档 (round ${state.archiveRound || '?'})，禁止 --rollback`,
        hint: '归档后的 Story 不支持回退操作。如需恢复，请先执行: ' + ARCHIVE_CMD + ' ' + storyId + ' restore'
      }
    }
  }

  if (targetPhase >= currentPhase) {
    return {
      exitCode: 1,
      output: {
        error: `--rollback 必须回退到更早的 Phase: 当前 ${currentPhase}(${currentPhaseName}) → 目标 ${targetPhase}(${getPhaseName(targetPhase)})`,
        hint: '回退时 targetPhase 必须 < currentPhase'
      }
    }
  }

  const now = new Date()
  const archiveDir = path.join(PLANS_DIR, storyId, 'archive')
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true })
  }

  // 归档 targetPhase+1 ~ currentPhase 的产出物
  for (let p = targetPhase + 1; p <= currentPhase; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    // 标记 phase 状态为 rolled_back
    if (state.phases && state.phases[phaseKey]) {
      state.phases[phaseKey].status = 'rolled_back'
      state.phases[phaseKey].rolledBackAt = now.toISOString()
    }
    // 归档该 phase 的产出物文件（重命名为 .archived 后缀，不删除）
    const phaseArtifacts = PHASE_ARTIFACTS[p]
    if (phaseArtifacts && phaseArtifacts.artifacts) {
      for (const art of phaseArtifacts.artifacts) {
        if (!art.fileName) continue
        const filePath = path.join(PLANS_DIR, storyId, art.fileName)
        if (fs.existsSync(filePath)) {
          const archivedPath = path.join(archiveDir, `${art.fileName}.phase-${p}.archived`)
          fs.renameSync(filePath, archivedPath)
        }
      }
    }
  }

  // 更新 phase
  const targetPhaseKey = `${targetPhase}_${PHASE_SLUGS[targetPhase]}`
  if (!state.phases) state.phases = {}
  state.phases[targetPhaseKey] = { status: 'running', startedAt: now.toISOString() }
  state.phase = targetPhase
  state.status = 'running'
  state.updatedAt = now.toISOString()

  // Phase 2 特殊处理：回退到 Phase 2 → 重新签发 dev-pass
  if (targetPhase === 2) {
    issueDevPass(storyId, DEV_PASS_TTL)
    console.error('  ✓ dev-pass 已重新签发')
  } else {
    // 回退到非 Phase 2 → 撤销 dev-pass
    revokeDevPass(storyId)
  }

  // 修复预算重置：回退到 Phase 2 或更早 = 开发重来一遍，修复轮次不应继承上一轮的计数。
  // fix-request.json 的 round 是 fix-loop 的唯一计数源，手工 --rollback 后若不重置，
  // 剩余预算会被上一轮吃掉，甚至直接撞 fix_loop_exhausted。
  let fixBudgetReset = null
  if (targetPhase <= 2) {
    const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
    if (fs.existsSync(fixRequestPath)) {
      let prevRound = 0
      try {
        prevRound = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8')).round || 0
      } catch (e) { /* 解析失败按 0 处理 */ }
      fs.renameSync(fixRequestPath, path.join(archiveDir, `fix-request.json.rollback-${targetPhase}.archived`))
      fixBudgetReset = { previousRound: prevRound }
      trace.appendTrace(storyId, {
        type: 'fix_budget_reset',
        phase: String(targetPhase),
        from: String(currentPhase),
        to: String(targetPhase),
        previousRound: String(prevRound),
        reason: 'manual_rollback'
      })
      console.error(`  ✓ 修复预算已重置（上一轮 round=${prevRound}，fix-request.json 已归档）`)
    }
  }

  // 记录 trace
  trace.tracePhaseTransition(storyId, currentPhase, targetPhase)
  trace.appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(targetPhase),
    from: String(currentPhase),
    to: String(targetPhase),
    reason: 'rollback'
  })

  // 持久化
  writeStateFile(storyId, state)

  return {
    exitCode: 0,
    output: {
      success: true,
      storyId,
      fromPhase: currentPhase,
      toPhase: targetPhase,
      toPhaseName: getPhaseName(targetPhase),
      archivedPhases: `${targetPhase + 1}-${currentPhase}`,
      archiveDir: path.relative(PROJECT_ROOT, archiveDir),
      fixBudgetReset,
      note: '已归档产出物到 archive/ 目录，dev-pass 已处理'
    }
  }
}

module.exports = { runRollback }
