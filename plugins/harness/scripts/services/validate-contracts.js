#!/usr/bin/env node
/**
 * validate-contracts.js — 契约文件完整性校验
 *
 * 职责:
 *   - 按目标 Phase 逐级校验契约文件：Phase 0→1 验收标准与待确认项、Phase 1→2 任务契约与
 *     AC↔Task 交叉引用、Phase 4→5 验收对账
 *   - 汇总 blockers / warnings / details，输出 JSON 结果并以退出码表达成败
 *
 * 用法:
 *   独立执行:
 *     node plugins/harness/scripts/services/validate-contracts.js <storyId> <targetPhase>
 *     退出码 0 = pass，1 = 存在 blocker 或状态文件不存在
 *   作为模块引用:
 *     const { validateContracts } = require('./services/validate-contracts')
 *     const r = validateContracts('STORY-002', 2)   // 纯函数，不写文件、不 exit
 *
 * 使用场景:
 *   - 人工诊断：想在不触发 Phase 推进的前提下，单独看某个 Story 的契约是否自洽
 *   - 与生效门控对照：日常推进的门控走 commands/advance-phase.js → policy.runGateCheck，
 *     本脚本不参与生效路径，结果仅作人工参考
 *
 * 说明:
 *   - 校验逻辑在 validateContracts() 内、不含任何 process.exit，CLI 分支由
 *     require.main === module 守卫，因此可被 require 复用与单测（原实现是顶层过程式代码，
 *     require 即执行并 exit，无法测试）
 *   - 参数 targetPhase 是「目标」phase，与 policy.runGateCheck 的「来源」phase 语义不同，切勿混用
 *   - 校验能力全部委托 lib/state.js（checkAcceptanceCriteria / checkOpenQuestions /
 *     checkTaskDagJson / validateContractReferences / checkAcceptanceVerification）
 *
 * @module validate-contracts
 */

const {
  readStateFile,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  getPhaseName
} = require('../lib/state')

/**
 * 校验指定 Story 推进到 targetPhase 所需的全部契约
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase（不是来源 Phase）
 * @returns {{ pass: boolean, storyId?: string, targetPhase?: number, phaseName?: string,
 *             blockers: string[], warnings?: string[], details?: Object, summary?: string }}
 *   状态文件不存在时只返回 { pass: false, blockers: ['状态文件不存在'] }（保持原输出契约）
 */
function validateContracts (storyId, targetPhase) {
  const blockers = []
  const warnings = []
  const details = {}

  const state = readStateFile(storyId)
  if (!state) return { pass: false, blockers: ['状态文件不存在'] }

  /**
   * 收集单项校验结果到 blockers / warnings / details
   * @param {number} phase - 该项归属的 Phase
   * @param {string} desc - 校验项名称
   * @param {{ errors?: string[], warnings?: string[] }} result - 校验结果
   */
  function logPhaseCheck (phase, desc, result) {
    details['phase' + phase + '_' + desc] = result
    if (result.errors) for (const e of result.errors) blockers.push('[Phase ' + phase + ' ' + desc + '] ' + e)
    if (result.warnings) for (const w of result.warnings) warnings.push('[Phase ' + phase + ' ' + desc + '] ' + w)
  }

  // Phase 0->1: 验收标准 + 待确认项
  if (targetPhase >= 1) {
    logPhaseCheck(0, 'acceptance-criteria', checkAcceptanceCriteria(storyId))
    logPhaseCheck(0, 'open-questions', checkOpenQuestions(storyId))
  }

  // Phase 1->2: 任务契约 + 交叉引用
  if (targetPhase >= 2) {
    logPhaseCheck(1, 'task-dag-json', checkTaskDagJson(storyId))
    logPhaseCheck(1, 'contract-references', validateContractReferences(storyId))
  }

  return {
    pass: blockers.length === 0,
    storyId,
    targetPhase,
    phaseName: getPhaseName(targetPhase),
    blockers,
    warnings,
    details,
    summary: blockers.length > 0
      ? 'FAIL: ' + blockers.length + ' blockers, ' + warnings.length + ' warnings'
      : warnings.length > 0
        ? 'PASS (with warnings): ' + warnings.length + ' warnings'
        : 'PASS: All contracts valid'
  }
}

// ─── CLI ────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2)
  const storyId = args[0]
  const targetPhase = parseInt(args[1])

  if (!storyId || isNaN(targetPhase)) {
    console.error('Usage: node validate-contracts.js <storyId> <targetPhase>')
    process.exit(1)
  }

  const result = validateContracts(storyId, targetPhase)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.pass ? 0 : 1)
}

module.exports = { validateContracts }
