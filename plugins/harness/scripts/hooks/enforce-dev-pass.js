#!/usr/bin/env node
/**
 * enforce-dev-pass.js — /start 模式下按 dev-pass 凭证保护 src/ 编辑
 *
 * 职责:
 *   - /start 模式激活时，拦截对 src/ 文件的写入/编辑，校验 dev-pass.json 是否有效
 *   - 凭证有效且当前仍处于 Phase 2 即放行；拒绝时写入 trace 的 hook_rejection 并携带 recordFailure
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: PreToolUse
 *   输入: stdin JSON（{ tool_name, tool_input: { filePath | file_path | command } }）
 *   输出: stdout JSON（放行 { continue: true, hookSpecificOutput.additionalContext }；
 *                      拒绝 { continue: false, stopReason, hookSpecificOutput.permissionDecision: 'deny', recordFailure }）
 *   退出码: 0=放行，2=阻止
 *   手动调试: echo '{"tool_name":"Write","tool_input":{"filePath":"<repo>/src/views/Foo.vue"}}' | node enforce-dev-pass.js
 *
 * 使用场景:
 *   - Agent 在 Phase 2 未签发 dev-pass 时就动手改 src/（例如直接跳到写代码）：
 *     不拦截会让「先规划后编码」的流程约束失效，需求/DAG 未定稿就产生代码，后续返工面极大。
 *   - dev-pass 已随 Phase 2→3 撤销但 dev-pass.json 残留：
 *     过期凭证若仍被信任，等于任何时刻都能改 src/，整套限时写保护失效。
 *
 * 说明:
 *   - 本 Hook 是 PreToolUse 门控链的第 1 道（#2 为 enforce-artifact.js）。
 *   - stdin 读取、tool_input 归一化、apply_patch 路径解析、决策渲染与退出码统一由
 *     lib/hook-runner.js 承担；本文件只表达「拦不拦」的判断。
 *   - 只做**时间与凭证维度**的门控:
 *       Normal  → unrestricted（.harness-active 未激活，直接放行）
 *       Harness → dev-pass 无效 → deny(dev_pass_missing)
 *                dev-pass 有效但当前 phase > 2 → deny(dev_pass_expired)
 *                其余 → allow
 *   - 「能改哪些文件」**不在本 Hook 判定**。2026-09 前的版本会拿 task-dag.json 的 files[]
 *     逐个比对目标路径（failureType: dev_pass_scope_violation），现已取消，原因:
 *       1. Phase 1 规划无法穷尽依赖（新增文件 / 跨模块公共组件 / 类型定义 / 跨仓适配），
 *          开发中出现范围外文件是常态，硬拦只会逼 Agent 绕道
 *       2. 匹配依据?Agent 的写入意图，而 Bash / execute_command 写入不在本 Hook 的
 *          matcher 内 —— 守规矩的被卡、不守规矩的一跳就过，形成逆向淘汰
 *       3. 与,/;.git 实际变更相比，意图并不可靠
 *     替代机制: policy.js 在 Phase 2→3 门控用 git 实际变更比对 task-dag.json 声明范围
 *     （lib/scope.js），产出 scope-amendments.json，由 Phase 3 审查逐条核对必要性。
 *   - 拦截工具: write_to_file / replace_in_file / apply_patch / Write / Edit；非 src/ 目标直接放行。
 *   - dev-pass 撤销双保险: Phase 2→3（主）+ Phase 4→5（兜底）；currentPhase > 2 时即便 dev-pass 文件有效也拒绝。
 *   - 拒绝事件通过 hookSpecificOutput.recordFailure 携带结构化失败信息（failureType / rootCause / resolution），
 *     供 session-stop.js 从 trace.jsonl 读取并沉淀到经验库。
 *   - recordFailure.failureType 取值: dev_pass_missing / dev_pass_expired。
 */
const fs = require('fs')
const hookUtils = require('../lib/state')
const { isSrcFile, checkDevPass } = hookUtils
const { runHook, WRITE_TOOLS } = require('../lib/hook-runner')
const { ARTIFACT, HARNESS_ACTIVE_FLAG, readJson } = require('../lib/artifacts')
const trace = require('../lib/trace')
const debugLog = require('../lib/debug-log')

runHook('PreToolUse', ctx => {
  const toolName = ctx.toolName
  if (!WRITE_TOOLS.includes(toolName)) return { decision: 'allow' }

  const srcFilePaths = ctx.filePaths.filter(isSrcFile)
  if (srcFilePaths.length === 0) return { decision: 'allow' }
  const filePath = srcFilePaths[0]

  /** 激活标记里的 storyId（dev-pass 缺失时用它给 debug 拒绝记录归属 story） */
  let flagStoryId = null
  let harnessActive = false
  if (fs.existsSync(HARNESS_ACTIVE_FLAG)) {
    try {
      const flag = JSON.parse(fs.readFileSync(HARNESS_ACTIVE_FLAG, 'utf-8'))
      harnessActive = flag.active === true
      flagStoryId = flag.storyId || null
    } catch (e) { /* 标记文件损坏按未激活处理 */ }
  }

  if (!harnessActive) return { decision: 'allow', additionalContext: 'Normal mode' }

  const devPass = checkDevPass()

  if (!devPass.valid) {
    const failure = {
      failureType: 'dev_pass_missing',
      rootCause: 'Agent 试图在无 dev-pass 时编辑 src/ 文件: ' + filePath,
      resolution: '必须在 Phase 2 通过 advance-phase.js 签发 dev-pass 后才能编辑 src/'
    }
    trace.appendTrace(null, {
      type: 'hook_rejection',
      result: 'deny',
      reason: 'dev_pass_missing',
      phase: '-1',
      recordFailure: {
        ...failure,
        resolution: '必须在 Phase 2 通过 advance-phase.js 签发 dev-pass 后才能编辑 src/。dev-pass 撤销点：Phase 2→3（主）+ Phase 4→5（兜底）'
      }
    })
    // debug 载荷层：拒绝详情留痕（storyId 取激活标记，无 dev-pass 可读）
    debugLog.record(flagStoryId, 'hook_decision', {
      hook: 'enforce-dev-pass.js',
      decision: 'deny',
      reason: 'dev_pass_missing',
      tool: toolName,
      filePath
    })
    return {
      decision: 'deny',
      stopReason: 'HARNESS MODE - no valid dev-pass. Must advance to Phase 2. dev-pass revoked at Phase 2→3 (primary) and Phase 4→5 (safety net).',
      reason: 'No valid dev-pass',
      failure
    }
  }

  // 🔴 CCHF v5: 即使 dev-pass 文件有效，也需校验当前 phase 是否仍是 Phase 2
  // dev-pass 撤销双保险：Phase 2→3（主） + Phase 4→5（兜底）
  // Phase 3+ 时 dev-pass 应已失效，但防止过期 dev-pass.json 残留导致非法编辑
  let currentPhase = -1
  if (devPass.storyId) {
    const state = readJson(devPass.storyId, ARTIFACT.E2E_STATE)
    if (state && !state._parseError && state.phase !== undefined && state.phase !== null) {
      currentPhase = state.phase
    }
  }

  if (currentPhase > 2) {
    const failure = {
      failureType: 'dev_pass_expired',
      rootCause: `Agent 在 Phase ${currentPhase} 试图编辑 src/，dev-pass 仅在 Phase 2 有效`,
      resolution: 'dev-pass 撤销点：Phase 2→3（主）+ Phase 4→5（兜底）。如需编辑请先回到 Phase 2'
    }
    trace.appendTrace(devPass.storyId || null, {
      type: 'hook_rejection',
      result: 'deny',
      reason: 'dev_pass_expired',
      phase: String(currentPhase),
      recordFailure: failure
    })
    debugLog.record(devPass.storyId || flagStoryId, 'hook_decision', {
      hook: 'enforce-dev-pass.js',
      decision: 'deny',
      reason: 'dev_pass_expired',
      tool: toolName,
      filePath,
      currentPhase
    })
    return {
      decision: 'deny',
      stopReason: `HARNESS MODE - dev-pass expired (current phase=${currentPhase}, dev-pass only valid in Phase 2). Revoked at Phase 2→3 (primary) + Phase 4→5 (safety net).`,
      reason: 'dev-pass expired - not in Phase 2',
      failure
    }
  }

  return { decision: 'allow', additionalContext: 'dev-pass valid: ' + devPass.reason }
})
