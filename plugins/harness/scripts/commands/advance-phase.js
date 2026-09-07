#!/usr/bin/env node
/**
 * advance-phase.js — Phase 门控裁定与状态跃迁的唯一执行者
 *
 * 职责:
 *   - 独立校验 targetPhase 入参合法性（范围 0~7、步长必须为 +1），越权一律拒绝
 *   - 委托 policy.js 执行门控校验，失败时只输出结构化 blockers（不含任何下一步命令）
 *   - 门控通过后在 e2e-state.json 中完成相位跃迁，并签发/撤销 dev-pass
 *   - 生成 phase-N-summary.md 上下文摘要（落盘，供 dispatch.js 构造 prompt 时读取）
 *   - 处理 --rollback 回退与 --fix-loop 修复回路两条特殊分支
 *
 * 不做什么（职责边界）:
 *   - 不构造、不输出 agentPrompt / nextAgent / expectedOutputs / batches / instruction
 *     ——「下一步怎么走」是 dispatch.js 的独占职责，本脚本只报推进结果。
 *
 * 用法:
 *   node plugins/harness/scripts/commands/advance-phase.js <storyId> <phase>
 *     推进到指定 Phase（必须等于 currentPhase + 1）
 *   node plugins/harness/scripts/commands/advance-phase.js <storyId> 2 --renew-pass
 *     Phase 2 续签 dev-pass，不推进相位
 *   node plugins/harness/scripts/commands/advance-phase.js <storyId> 3 --lint-fix
 *     Phase 2→3 时按 task-dag.json 涉及的仓库逐个执行 eslint --fix
 *   node plugins/harness/scripts/commands/advance-phase.js <storyId> <phase> --rollback
 *     回退到更早 Phase：归档中间产出物；targetPhase <= 2 时重置修复预算
 *   node plugins/harness/scripts/commands/advance-phase.js <storyId> 2 --fix-loop
 *     修复回路：提取 BLOCKER → 回退 Phase 2 → 签发限域 dev-pass → 输出 spawnPrompt
 *   参数解析：第一个纯数字视为 storyId，最后一个纯数字视为 targetPhase；
 *   非数字参数（可带 plans/ 或 .codebuddy/plans/ 前缀）优先作为 storyId。
 *
 * 输出:
 *   - stdout: **只有**一份 JSON 结果（推进结果 / 门控失败事实），
 *     调用方可直接 JSON.parse(stdout)，无需从混合文本里捞
 *     成功: success / fromPhase / toPhase / gateChecks / devPass
 *     失败: gatePassed=false / structuredBlockers / warnings / recoverySuggestions / hint
 *     两种结果都**不含命令串** —— 推进后一律回 Step 1 重新执行 dispatch.js
 *   - stderr: 人类可读的进度文本（门控逐项结果、dev-pass 收发、eslint、摘要生成等）
 *   - 退出码: 0 = 成功，1 = 参数非法 / 门控失败 / 状态异常
 *   注: 2026-09 之前进度文本与 JSON 混在 stdout，测试不得不用
 *       lastIndexOf('{\n  "success"') 从尾部捞 JSON，格式一动就假绿。
 *
 * 使用场景:
 *   - 某 Phase 的 Agent 汇报产出完成、且 dispatch.js 的 status=ready 给出 advanceCommand 后，
 *     主 Agent 执行本命令裁断门控并真正写入 phase
 *   - Phase 3 代码审查 / Phase 4 功能测试出现未修复 BLOCKER 时，主 Agent 执行 --fix-loop
 *     取回 spawnPrompt，交给前端开发工程师做限域修复
 *   - Phase 2 开发未完成但 dev-pass 已过期时，用 --renew-pass 续签，避免回退重来
 *   - 发现前一 Phase 方向错误（如任务拆解不合理）需要重做时，用 --rollback 归档中间产物并回退
 *   - 门控失败时无自动恢复通道：RECOVERY_SUGGESTIONS 里没有 autoFixable 条目，
 *     所有 blockers 都需 Agent 按 resolution 修好后重试（或 Phase 3/4 走 --fix-loop）
 *
 * 说明:
 *   - --renew-pass / --rollback / --fix-loop 三条分支的实现下沉在 phase-ops/ 下各自独立文件
 *     （renew-pass.js / rollback.js / fix-loop.js），本文件只做分派与出口。子模块只计算与落盘，
 *     不 emit、不 process.exit —— 输出契约与 debug 留痕（source=advance-phase.js）保持单一出口。
 *   - 三层解耦后的职责划分:
 *       本文件 = Stateful Workflow (确定性状态控制，不应被自主化接管)
 *       policy.js = Policy Runtime (门控校验，独立于编排)
 *       trace.js = Trace 记录 (全链路可观测性)
 *       experience.js = 经验沉淀 (失败模式记录)
 *       context-refresh.js = 上下文刷新 (Phase summary)
 *   - 相位跃迁唯一执行者：只有本文件能改写 state.phase。主 Agent 与 dispatch.js 只有"触发权"，
 *     没有"决定权"——命令可以由任何人敲，但是否合法由本脚本独立裁定。
 *   - targetPhase 入参独立校验：越界会写出 phase: 99 / phases["99_undefined"] 这类污染状态；
 *     跨 Phase 会跳过中间 Phase 的门控、dev-pass 签发/撤销与 phase-N-summary.md 生成；
 *     倒退会使已完成 Phase 的产出物与状态不一致（那是 --rollback 的职责）。
 *   - e2e-state 完整性校验：若 state.phases 中某 Phase 已标记 completed 但 state.phase 仍在其之前，
 *     判定为 Agent 绕过脚本直接改状态（历史教训 STORY-20260710-01），拒绝推进并输出人工修复指引，
 *     同时写入 phase_integrity_violation 事件到 trace。
 *   - 归档状态守卫：Story 已归档时禁止 --rollback / --fix-loop，需先执行 archive-story.js restore。
 *   - 持久化顺序：writeStateFile 先于 trace 写入，确保 trace 不会领先于 state；
 *     summary 生成、trace 记录、度量聚合失败均不阻塞推进。
 *   - 不 require services/prompt-builder: 本脚本不再构造 prompt。收敛前同一轮推进里
 *     prompt 被生成三次（dispatch 分支 B 的残缺副本 → 本脚本 → 回 Step 1 后 dispatch
 *     分支 A 那份真正被用的），prompt 唯一出口现在是 dispatch.js。
 *   - 命令串（完整性校验失败时的 fixCommand / fixSteps 等）由 lib/paths.js 的 ADVANCE_CMD
 *     统一提供，与 dispatch.js / policy.js 共用同一信源，不在此处二次拼装。
 *     门控失败（最常见的失败路径）不给命令 —— 那是 dispatch.js 的 recovery 职责。
 *   - Phase 7 完成时自动触发 audit/metrics-aggregator.js 聚合度量，并标记工作流为 completed 终态。
 *
 * @module advance-phase
 */

const fs = require('fs')
const path = require('path')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  readStateFile,
  writeStateFile,
  getDevPassAllowedPaths,
  issueDevPass,
  revokeDevPass,
  readJsonArtifact,
  loadRepos,
  getRepoRoot,
  DEV_PASS_TTL,
  PHASE_SLUGS,
  PHASE_ARTIFACTS,
  getPhaseName,
  errorToString,
  errorToType
} = require('../lib/state')

const policy = require('../services/policy')
const trace = require('../lib/trace')
const debugLog = require('../lib/debug-log')
const experience = require('../services/experience')
const contextRefresh = require('../services/context-refresh')
// 命令路径与 Phase 常量收敛到 lib 公共出口（此前三处各拼一份 ADVANCE_CMD）
const { ADVANCE_CMD, commandPath } = require('../lib/paths')
const { MAX_PHASE } = require('../lib/phases')

// 三个 --flag 子命令的实现（各自独立、都以 exit 收尾），主文件只做分派与出口
const { runRenewPass } = require('./phase-ops/renew-pass')
const { runRollback } = require('./phase-ops/rollback')
const { runFixLoop } = require('./phase-ops/fix-loop')

/** 脚本启动时刻（emit 计算 command 总耗时用） */
const T0 = Date.now()

/**
 * 统一输出口：console.log JSON + debug 载荷层全量留痕（供流程回顾分析）。
 * debug 记录失败静默吞掉，绝不影响命令输出与退出码。
 * @param {Object} o - 输出对象（phase 取 o.toPhase ?? o.phase）
 */
function emit (o) {
  try {
    const p = o && o.toPhase != null ? o.toPhase : (o && o.phase != null ? o.phase : null)
    debugLog.record(storyId, 'script_output', o, {
      source: 'advance-phase.js',
      phase: p,
      durationMs: Date.now() - T0
    })
  } catch (e) { /* debug 记录失败不影响输出 */ }
  console.log(JSON.stringify(o, null, 2))
}

/**
 * 本脚本与 archive-story.js 的绝对调用形式（运行时由脚本位置动态推导，
 * 输出给主 Agent 的 fixCommand / nextSteps / hint 在任何 cwd、任何 shell 下可直接执行，
 * 消除「文档统一用 ${CLAUDE_PLUGIN_ROOT} 但 PowerShell 下不可执行」的缺陷 D9）。
 * 实现下沉在 lib/paths.js，与 dispatch.js / policy.js 共用同一信源。
 * 正斜杠形式：规避 markdown 渲染层吃 `\.` 造成显示缺分隔符（2026-09 实跑反馈）
 */
const ARCHIVE_CMD = commandPath('archive-story.js')

/**
 * 无门控的 Phase 列表
 *
 * 这些 Phase 的 PHASE_ARTIFACTS 产出物是 `fileName: null`（代码变更 / commit+push / 知识库 / 部署），
 * 导致 runGateCheck 的三道通用检查全部空转：
 *   1. 产出物存在性   — artifacts-check.js 里 `if (!a.fileName) return false`，直接被过滤
 *   2. JSON Schema    — schema-validator.js 的 getPhaseArtifacts(5/6/7) 返回 []
 *   3. Phase 专属契约 — policy.js 的分支只处理 phaseNum 0-4
 * 因此它们恒返回 passed:true。提交/部署的安全性依赖 Agent prompt 指令，不依赖程序拦截。
 */
const NO_GATE_PHASES = [5, 6, 7]

// ========================
// CLI 参数解析
// ========================

const args = process.argv.slice(2)
let storyId = null
let targetPhase = null
let renewFlag = false
let lintFixFlag = false
let rollbackFlag = false
let fixLoopFlag = false

// 纯数字参数可能同时包含 storyId（TAPD 需求 ID 为纯数字）与 phase 数字。
// 解析规则：第一个纯数字视为 storyId，最后一个纯数字视为 targetPhase。
// 非数字参数（含路径前缀）优先作为 storyId。
const numericArgs = []
const nonNumericArgs = []

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--renew-pass') renewFlag = true
  else if (arg === '--lint-fix') lintFixFlag = true
  else if (arg === '--rollback') rollbackFlag = true
  else if (arg === '--fix-loop') fixLoopFlag = true
  else if (/^\d+$/.test(arg)) numericArgs.push(arg)
  else nonNumericArgs.push(arg)
}

// 非数字参数优先作为 storyId（兼容 plans/xxx 前缀）
if (nonNumericArgs.length > 0) {
  storyId = nonNumericArgs[0].replace(/^(plans\/|\.codebuddy\/plans\/)/i, '')
}
// 纯数字：第一个为 storyId，最后一个为 targetPhase
if (numericArgs.length > 0) {
  if (!storyId) storyId = numericArgs[0]
  targetPhase = parseInt(numericArgs[numericArgs.length - 1], 10)
}

if (!storyId || targetPhase === null) {
  emit({
    error: '用法: node advance-phase.js <storyId> <phase> [--renew-pass] [--lint-fix] [--rollback] [--fix-loop]',
    example: '  node advance-phase.js STORY-002 2\n  node advance-phase.js STORY-002 1 --rollback\n  node advance-phase.js STORY-002 2 --fix-loop'
  })
  process.exit(1)
}

// ========================
// 加载 e2e-state.json
// ========================

const state = readStateFile(storyId)
if (!state || state._parseError) {
  emit({ error: state?._parseError || 'e2e-state.json 不存在', storyId })
  process.exit(1)
}

// ========================
// Phase 2 dev-pass 续签（--renew-pass）
// 实现见 phase-ops/renew-pass.js：targetPhase 非 2 时返回 null，继续走正常推进
// ========================

if (renewFlag) {
  const renewed = runRenewPass({ storyId, targetPhase })
  if (renewed) {
    emit(renewed.output)
    process.exit(renewed.exitCode)
  }
}

// ========================
// Phase 推进逻辑
// ========================

const currentPhase = (state.phase !== undefined && state.phase !== null) ? state.phase : -1
const currentPhaseName = getPhaseName(currentPhase)

// ========================
// 🛡️ targetPhase 入参独立校验
// 原则: 不信任调用方传入的 targetPhase。主 Agent / dispatch.js 只有"触发权"，
//       没有"决定权"——命令可以由任何人敲，但是否合法由本脚本独立裁定。
// 校验 1: 范围。越界会导致 PHASE_SLUGS[targetPhase] 为 undefined，
//         写出 phase: 99 / phases["99_undefined"] 这类污染状态。
// ========================

if (targetPhase < 0 || targetPhase > MAX_PHASE) {
  emit({
    error: `targetPhase 越界: ${targetPhase}，合法范围 0~${MAX_PHASE}`,
    storyId,
    currentPhase,
    hint: `Phase 定义: ${PHASE_SLUGS.map((s, i) => `${i}=${getPhaseName(i)}`).join(', ')}`
  })
  process.exit(1)
}

// ========================
// 🛡️ e2e-state 完整性校验: 检测 Agent 是否绕过脚本直接修改了 phase
// 历史教训: STORY-20260710-01 中 task-planner Agent 直接修改 phase 导致门控被跳过
// 策略: 检测到篡改 → 拒绝推进 + 输出明确修复指引（不自动修复，要求人工确认）
// ========================

/**
 * 校验 state.phases 中每个 phase 的状态与实际 phase 值是否一致
 * 如果某个 phase 标记为 completed 但 state.phase 仍在该 phase 之前 → 发现篡改
 * @param {Object} state - e2e-state.json 解析对象
 * @returns {{ valid: boolean, actualPhase: number, declaredPhase: number }}
 */
function validatePhaseIntegrity (state) {
  const declaredPhase = state.phase
  let maxCompletedPhase = -1
  if (state.phases) {
    for (const [key, val] of Object.entries(state.phases)) {
      if (val.status === 'completed') {
        const phaseMatch = key.match(/^(\d+)_/)
        if (phaseMatch) {
          const p = parseInt(phaseMatch[1], 10)
          if (p > maxCompletedPhase) maxCompletedPhase = p
        }
      }
    }
  }
  if (maxCompletedPhase > declaredPhase) {
    return { valid: false, actualPhase: maxCompletedPhase, declaredPhase }
  }
  return { valid: true, actualPhase: declaredPhase, declaredPhase }
}

const integrityCheck = validatePhaseIntegrity(state)

/**
 * 对账 dispatch 预检留痕（P2-1: 修复「预检失败不入库」的飞轮盲区，D3）
 *
 * dispatch.js 预检报出 blocker 时会落盘 .dispatch-precheck.json（诊断类文件）。
 * 此前这些 blocker 被子 Agent 修复后直接 advance 成功，失败从未进入经验库 ——
 * 预检越好用，飞轮越饿。本函数在推进成功路径对账：上次预检有 blocker 且本次
 * 门控通过 → 补记一条 preGateBlocked 教训并清除留痕文件。
 * 失败路径不阻塞推进（对账是经验沉淀，不是门控）。
 *
 * @param {string} storyId - Story ID
 * @param {number} completedPhase - 刚完成门控的 Phase（currentPhase）
 * @returns {void}
 */
function reconcileDispatchPrecheck (storyId, completedPhase) {
  const precheckPath = path.join(PLANS_DIR, storyId, '.dispatch-precheck.json')
  if (!fs.existsSync(precheckPath)) return
  try {
    const precheck = JSON.parse(fs.readFileSync(precheckPath, 'utf-8'))
    if (Array.isArray(precheck.blockers) && precheck.blockers.length > 0) {
      // artifact_missing 不计入失败经验: dispatch 首次派单到某 Phase 时，该 Phase 的产出物
      // 必然尚未落盘 —— 这是「还没做」而不是「做了但没过门控」。不过滤的话每个 Story 的
      // Phase 0 都会平白沉淀一条 preGateBlocked 假失败经验，并作为历史教训注入后续 Story。
      const realBlockers = precheck.blockers.filter(b => (b.type || 'unknown') !== 'artifact_missing')
      if (realBlockers.length > 0) {
        const blockerTypes = [...new Set(realBlockers.map(b => b.type || 'unknown'))]
        experience.recordFailurePattern({
          phase: completedPhase,
          failureType: 'preGateBlocked',
          rootCause: `dispatch 预检曾报 ${realBlockers.length} 个 blocker（类型: ${blockerTypes.join(', ')}，示例: ${String(realBlockers[0].message || '').slice(0, 150)}），修复后被门控放行`,
          resolution: '预检 blocker 需修复对应产出物后才能推进；高频出现的类型应补录到 policy.js RECOVERY_SUGGESTIONS',
          storyId,
          blockers: realBlockers.map(b => String(b.message || b))
        })
        trace.appendTrace(storyId, {
          type: 'experience',
          phase: String(completedPhase),
          result: 'captured',
          reason: 'preGateBlocked',
          details: { blockerCount: realBlockers.length, blockerTypes }
        })
      }
    }
  } catch (e) {
    // 对账失败不阻塞推进（留痕文件损坏时按无记录处理）
  }
  try {
    fs.unlinkSync(precheckPath)
  } catch (e) {
    // 清除失败不影响（下次推进会重新对账）
  }
}
if (!integrityCheck.valid) {
  const errorOutput = {
    error: 'e2e-state.json 完整性校验失败: 检测到 Agent 越权修改状态文件',
    storyId,
    details: {
      declaredPhase: integrityCheck.declaredPhase,
      actualPhase: integrityCheck.actualPhase,
      rootCause: `Agent 在 Phase ${integrityCheck.declaredPhase} 完成后直接修改了 state.phase，将 phases.${integrityCheck.actualPhase}_* 标记为 completed，但未通过 advance-phase.js 推进`,
      whyBlocked: [
        '1. 跳过 advance-phase.js 的门控校验（产出物完整性、AC 格式、open-questions 等）',
        '2. 跳过 dev-pass 的签发/撤销逻辑（Phase 1→2 签发、Phase 2→3 撤销）',
        '3. 跳过上下文摘要（phase-N-summary.md）生成',
        '4. trace.jsonl 缺失关键事件记录，审计链断裂'
      ]
    },
    fixCommand: `${ADVANCE_CMD} ${storyId} ${integrityCheck.actualPhase}`,
    fixSteps: [
      `1. 确认 Phases ${integrityCheck.declaredPhase + 1}~${integrityCheck.actualPhase} 的产出物是否已由 Agent 生成`,
      `2. 手动将 e2e-state.json 的 phase 改回 ${integrityCheck.declaredPhase}`,
      `3. 逐 Phase 执行 advance-phase.js 推进（从 ${integrityCheck.declaredPhase} 到 ${integrityCheck.actualPhase}），让脚本重新执行门控`,
      `4. 或者直接执行: ${ADVANCE_CMD} ${storyId} ${integrityCheck.actualPhase}（跳过的 Phase 门控将无法追溯）`
    ],
    prevention: [
      'Agent prompt 中必须包含: "禁止修改 e2e-state.json，Phase 推进由主 Agent 调用 advance-phase.js 完成"',
      'Agent 完成任务后只汇报产出物路径，不操作状态文件'
    ]
  }

  // 记录 trace（篡改事件）
  trace.appendTrace(storyId, {
    type: 'phase_integrity_violation',
    phase: String(integrityCheck.declaredPhase),
    actualPhase: String(integrityCheck.actualPhase),
    result: 'blocked',
    reason: 'agent_direct_state_mutation_detected'
  })

  emit(errorOutput)
  process.exit(1)
}

// ========================
// --rollback: 回退 Phase（归档中间产出物，更新 phase）
// 实现见 phase-ops/rollback.js
// ========================

if (rollbackFlag) {
  const rolled = runRollback({ storyId, state, currentPhase, currentPhaseName, targetPhase, ARCHIVE_CMD })
  emit(rolled.output)
  process.exit(rolled.exitCode)
}

// ========================
// --fix-loop: 修复回路（Phase 3/4 失败 → 提取 BLOCKER → 回退 Phase 2 → 签发限域 dev-pass）
// 实现见 phase-ops/fix-loop.js
// ========================

if (fixLoopFlag) {
  // 修复回路只服务于 Phase 3/4（代码审查 / 功能测试失败 → 回退 Phase 2 重做）。
  // 依据: dispatch.js 的 isReviewOrTest = phase === 3 || phase === 4；
  //       policy.js 的 _meta.fixLoopAvailable 也只在这两个 Phase 设置。
  // 越界的后果比一般边界严重: Phase 5 之后代码已 commit+push，此处放行会让
  // fix-loop 把 3..currentPhase 标 rolled_back、回退到 Phase 2 并重新签发 dev-pass，
  // 等于给已发布代码重新发一张写权限通行证。
  if (currentPhase < 3 || currentPhase > 4) {
    emit({
      error: `修复回路仅支持 Phase 3/4（当前 Phase ${currentPhase}(${currentPhaseName})）。` +
        'Phase 5 之后代码已提交/部署，回退重发 dev-pass 会覆盖已发布代码。' +
        '需要返工请新建 Story，或用 --rollback 显式回滚',
      storyId,
      currentPhase
    })
    process.exit(1)
  }
  const looped = runFixLoop({ storyId, state, currentPhase, ADVANCE_CMD, ARCHIVE_CMD })
  emit(looped.output)
  process.exit(looped.exitCode)
}

if (targetPhase === currentPhase) {
  // Phase 0 复用检测: 如果推进到 Phase 1 时 Phase 0 产出物已存在，输出提示
  if (currentPhase === 0 && targetPhase === 0) {
    const storyDir = path.join(PLANS_DIR, storyId)
    const raPath = path.join(storyDir, 'requirement-analysis.md')
    const acPath = path.join(storyDir, 'acceptance-criteria.json')
    const hasPhase0Artifacts = fs.existsSync(raPath) && fs.existsSync(acPath)
    if (hasPhase0Artifacts) {
      emit({
        success: true,
        storyId,
        phase: currentPhase,
        name: currentPhaseName,
        note: '已在目标 Phase，无需推进',
        phase0Reuse: {
          detected: true,
          message: 'Phase 0 产出物已存在，可直接复用。如 bug 分析报告有更新但 AC 未反映，请手动更新 acceptance-criteria.json 后推进到 Phase 1'
        }
      })
      process.exit(0)
    }
  }
  emit({ success: true, storyId, phase: currentPhase, name: currentPhaseName, note: '已在目标 Phase，无需推进' })
  process.exit(0)
}

// ========================
// 🛡️ targetPhase 入参独立校验 — 校验 2: 步长
// 到此处说明是正常推进路径（--rollback / --fix-loop 已在上方 exit）。
// 相位跃迁必须严格 +1：既不允许倒退（那是 --rollback 的职责），
// 也不允许跨越（跨 Phase 会跳过中间 Phase 的产出物门控与 dev-pass 签发/撤销）。
// ========================

if (targetPhase !== currentPhase + 1) {
  const isBackward = targetPhase < currentPhase
  emit({
    error: isBackward
      ? `禁止倒退推进: 当前 Phase ${currentPhase}(${currentPhaseName}) → 目标 Phase ${targetPhase}(${getPhaseName(targetPhase)})`
      : `禁止跨 Phase 推进: 当前 Phase ${currentPhase}(${currentPhaseName}) → 目标 Phase ${targetPhase}(${getPhaseName(targetPhase)})，一次只能推进一个 Phase`,
    storyId,
    currentPhase,
    targetPhase,
    whyBlocked: isBackward
      ? ['倒退会使已完成 Phase 的产出物与状态不一致', '回退请使用 --rollback，它会归档中间产出物']
      : [
          `跳过了 Phase ${currentPhase + 1}~${targetPhase - 1} 的门控校验（产出物完整性、AC 格式、open-questions）`,
          '跳过了 dev-pass 的签发/撤销时机（Phase 1→2 签发、Phase 2→3 撤销）',
          '跳过了中间 Phase 的 phase-N-summary.md 生成，上下文链断裂'
        ],
    fixCommand: isBackward
      ? `${ADVANCE_CMD} ${storyId} ${targetPhase} --rollback`
      : `${ADVANCE_CMD} ${storyId} ${currentPhase + 1}`,
    hint: isBackward
      ? '如需回退，请加 --rollback'
      : `请逐 Phase 推进：先执行到 Phase ${currentPhase + 1}，完成产出物后再推进下一个`
  })

  trace.appendTrace(storyId, {
    type: 'phase_transition',
    phase: String(currentPhase),
    to: String(targetPhase),
    result: 'blocked',
    reason: isBackward ? 'backward_transition_without_rollback' : 'phase_skip_attempt'
  })

  process.exit(1)
}

// ========================
// 门控校验 (委托给 policy.js)
// ========================

/** @type {{ passed: boolean, blockers: Array<{type:string,message:string,level:number,resolution:string}>, warnings: string[], recoveries: Array, _meta: Object }} */
const combinedResult = { passed: true, blockers: [], warnings: [], recoveries: [], _meta: {} }

for (let p = currentPhase; p < targetPhase; p++) {
  console.error(`\n--- Phase ${p}(${getPhaseName(p)}) → Phase ${p + 1}(${getPhaseName(p + 1)}) 门控检查 ---`)

  const gateResult = policy.runGateCheck(storyId, p, state)

  // 输出检查结果
  if (gateResult.blockers.length === 0) {
    console.error(`  ✓ Phase ${p} 门控通过`)
  }
  for (const w of gateResult.warnings) {
    console.error(`  ⚠ ${w}`)
  }
  for (const b of gateResult.blockers) {
    console.error(`  ✗ ${errorToString(b)}`)
  }

  // 记录 trace — blockers 为结构化对象，转为字符串供 trace
  trace.traceGateDecision(storyId, p, gateResult.passed, gateResult.blockers.map(b => errorToString(b)), gateResult.warnings)

  // 合并结果（去重：同类型 blocker 只保留一条 + count 信息）
  combinedResult.passed = combinedResult.passed && gateResult.passed
  for (const b of gateResult.blockers) {
    const bType = errorToType(b)
    const existing = combinedResult.blockers.find(cb => errorToType(cb) === bType)
    if (!existing) {
      combinedResult.blockers.push(b)
    }
    // 如果已存在同类型 blocker，合并 count 信息（不在 message 层面重复）
  }
  combinedResult.warnings.push(...gateResult.warnings)
  combinedResult.recoveries.push(...gateResult.recoveries)
  // 合并 _meta（fixLoopAvailable 等标记）
  if (gateResult._meta) {
    combinedResult._meta = { ...combinedResult._meta, ...gateResult._meta }
  }

  if (!gateResult.passed) break // 遇到阻塞就停止
}

// ========================
// 错误恢复站点 (#4)
// ========================

if (!combinedResult.passed) {
  // 仍然失败: 记录经验 — 按 failureType 聚合，避免同根因产生大量重复记录
  if (!combinedResult.passed) {
    // 1. 按 failureType 聚合 blockers
    /** @type {Map<string, {count:number, sampleRootCause:string, sampleResolution:string, levels:Set<number>}>} */
    const aggregated = new Map()
    for (const b of combinedResult.blockers) {
      const failureType = errorToType(b)
      const suggestion = policy.matchRecoverySuggestion(b)
      const key = failureType !== 'unknown'
        ? failureType
        : (suggestion ? suggestion.action.split(' ')[0] || 'unknown' : 'unknown')

      if (aggregated.has(key)) {
        const entry = aggregated.get(key)
        entry.count++
        entry.levels.add(b.level || 2)
      } else {
        aggregated.set(key, {
          count: 1,
          sampleRootCause: errorToString(b),
          sampleResolution: b.resolution || (suggestion ? suggestion.action : '需人工分析并补充到 RECOVERY_SUGGESTIONS'),
          levels: new Set([b.level || 2])
        })
      }
    }

    // 2. 按聚合后的类型逐条记录
    for (const [failureType, agg] of aggregated) {
      experience.recordFailurePattern({
        phase: currentPhase,
        failureType,
        rootCause: `${agg.count} 个 ${failureType} 问题 (示例: ${agg.sampleRootCause.slice(0, 200)})`,
        resolution: agg.sampleResolution,
        storyId,
        blockers: combinedResult.blockers.map(b => errorToString(b))
      })

      trace.appendTrace(storyId, {
        type: 'experience',
        phase: String(currentPhase),
        result: 'captured',
        reason: failureType,
        details: {
          count: agg.count,
          maxLevel: Math.max(...agg.levels),
          sampleRootCause: agg.sampleRootCause.slice(0, 300),
          resolution: agg.sampleResolution
        }
      })
    }

    // 输出恢复建议
    const recoveryHints = combinedResult.recoveries
      .filter(r => r.suggestion)
      .map(r => `  → ${r.suggestion.action} (Level ${r.suggestion.level})`)

    // 职责分离: 本脚本只报「门控没过」这一事实，不输出任何下一步命令。
    // 此前这里输出 nextAction.command / fixLoopHint（一条 --fix-loop 命令），
    // 与 dispatch.js 的 recovery.command 是两个信源拼出的同一条命令 —— 主 Agent
    // 面对两个都自称权威的命令串只能自行挑一个（判断权回流）。
    // 现在一律回 Step 1: dispatch.js 会按 status 给出 recovery.command（唯一信源）。
    emit({
      success: false,
      storyId,
      targetPhase,
      targetPhaseName: getPhaseName(targetPhase),
      gatePassed: false,
      // 只留结构化形态（含 type / message / level / resolution），
      // 旧的 blockers 字符串数组是它的 map 派生，同一份数据两种形态无意义
      structuredBlockers: combinedResult.blockers,
      warnings: combinedResult.warnings,
      recoverySuggestions: recoveryHints.length > 0 ? recoveryHints : undefined,
      hint: '推进被门控阻断。修复 structuredBlockers 后重新执行 dispatch.js 取下一步指令（本脚本不输出任何命令）'
    })
    process.exit(1)
  }
}

// ========================
// 推进 Phase
// ========================

const now = new Date()
const phaseKey = `${targetPhase}_${PHASE_SLUGS[targetPhase]}`
const currentPhaseKey = `${currentPhase}_${PHASE_SLUGS[currentPhase]}`

// 完成当前 Phase
if (state.phases && state.phases[currentPhaseKey]) {
  state.phases[currentPhaseKey].status = 'completed'
  state.phases[currentPhaseKey].completedAt = now.toISOString()
}

// 启动目标 Phase
if (!state.phases) state.phases = {}
state.phases[phaseKey] = { status: 'running', startedAt: now.toISOString() }
state.phase = targetPhase
state.status = 'running'
state.updatedAt = now.toISOString()

// 记录门控结果
if (!state.gateChecks) state.gateChecks = {}
if (!Array.isArray(state.gateChecks.gateValidationResults)) {
  state.gateChecks.gateValidationResults = []
}
state.gateChecks.gateValidationResults.push({
  targetPhase,
  // 走到此处说明门控已通过（失败分支早已 exit），pass/blockers 直接从结果取，不再硬编码。
  // gateImplemented=false 表示本 Phase 的产出物是 fileName:null（git diff / commit / 部署），
  // 三道通用检查全部空转 —— 是「没查」而非「查了通过」。
  // 下游 context-refresh.js（上下文摘要）与 metrics-aggregator.js（BLOCKER 统计）
  // 据此区分两者，避免把零检查当成全绿。
  gateImplemented: !NO_GATE_PHASES.includes(currentPhase),
  pass: combinedResult.passed,
  timestamp: now.toISOString(),
  blockers: combinedResult.blockers,
  warnings: combinedResult.warnings
})

// 空转检测：当前 Phase 完成时无产出物 → 标记为 noop
// 放在 state 写入之前，信息注入到 state 中
const phaseArtifacts = PHASE_ARTIFACTS
const completedPhaseArtifacts = phaseArtifacts && phaseArtifacts[currentPhase]
if (completedPhaseArtifacts && Array.isArray(completedPhaseArtifacts.artifacts)) {
  const allMissing = completedPhaseArtifacts.artifacts.every(art => {
    // Phase 2/5/6/7 产出物不是文件（git diff / commit / 部署），跳过
    if (!art.fileName) return false
    try {
      const artPath = path.join(PLANS_DIR, storyId, art.fileName)
      return !fs.existsSync(artPath)
    } catch (_) { return false }
  })
  if (allMissing && completedPhaseArtifacts.artifacts.length > 0) {
    trace.appendTrace(storyId, {
      type: 'phase_noop',
      phase: String(currentPhase),
      result: 'noop',
      details: { reason: 'no artifacts produced', artifactCount: completedPhaseArtifacts.artifacts.length }
    })
  }
}

// ========================
// Phase 2 特殊逻辑: 签发 dev-pass
// ========================

let devPass = null
if (targetPhase === 2) {
  const allowedInfo = getDevPassAllowedPaths(storyId)
  devPass = issueDevPass(storyId, DEV_PASS_TTL, allowedInfo.paths)
  state.devPass = devPass.storyId + '-' + now.toISOString().slice(0, 10).replace(/-/g, '')
  trace.appendTrace(storyId, {
    type: 'dev_pass',
    phase: '2',
    result: 'issued',
    reason: 'phase_1_to_2',
    details: {
      expiresAt: devPass.expiresAt,
      allowedPathsCount: devPass.allowedPaths.length,
      source: devPass.pathSource
    }
  })
}

// ========================
// Phase 2→3 特殊逻辑: 撤销 dev-pass + lint fix
// ========================

if (targetPhase === 3) {
  revokeDevPass(storyId)
  console.error('  ✓ dev-pass 已撤销 (Phase 2→3)')
  trace.appendTrace(storyId, { type: 'dev_pass', phase: String(targetPhase), result: 'revoked', reason: 'phase_2_to_3' })

  if (state.devPass) delete state.devPass

  if (lintFixFlag) {
    const { execSync } = require('child_process')
    const repos = loadRepos(storyId)
    // 从 task-dag.json 提取涉及的仓库（缺省 primary），逐仓库执行 eslint --fix
    const taskData = readJsonArtifact(storyId, 'task-dag.json')
    const involvedRepos = new Set()
    if (taskData && Array.isArray(taskData.tasks)) {
      for (const t of taskData.tasks) involvedRepos.add(t.repo || repos.primary)
    } else {
      involvedRepos.add(repos.primary)
    }
    let allSuccess = true
    for (const repoName of involvedRepos) {
      const repoRoot = getRepoRoot(repoName, repos)
      try {
        execSync('npx eslint src/ --fix --format compact 2>&1', {
          cwd: repoRoot, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe']
        })
        console.error(`  ✓ eslint --fix 完成 (${repoName})`)
      } catch (e) {
        allSuccess = false
        console.error(`  ⚠ eslint --fix 异常 (${repoName}): ` + (e.stderr || e.message || '').slice(0, 200))
        combinedResult.warnings.push(`eslint --fix 异常 (${repoName})（非阻塞）`)
      }
    }
    trace.appendTrace(storyId, { type: 'lint_fix', result: allSuccess ? 'success' : 'partial' })
  }
}

// ========================
// Phase 4→5 特殊逻辑: 兜底撤销 dev-pass（双保险）
// 正常流程下 Phase 2→3 已撤销，此处防止 fix-loop 重新签发后残留
// revokeDevPass 幂等，文件不存在时安全跳过
// ========================

if (targetPhase === 5) {
  const devPassPath = path.join(PLANS_DIR, storyId, 'dev-pass.json')
  if (fs.existsSync(devPassPath)) {
    revokeDevPass(storyId)
    console.error('  ✓ dev-pass 兜底撤销 (Phase 4→5，审查+测试双通过，开发窗口关闭)')
    trace.appendTrace(storyId, { type: 'dev_pass', phase: String(targetPhase), result: 'revoked', reason: 'phase_4_to_5_safety_net' })
    if (state.devPass) delete state.devPass
  }
  // 标记 Git 提交阶段开始（后续 git 操作应通过 trace.js CLI 逐条记录）
  trace.appendTrace(storyId, {
    type: 'git',
    action: 'phase_start',
    result: 'pending',
    details: { note: 'Phase 5 Git 提交阶段开始，使用 node trace.js git <storyId> <action> success <details> 逐条记录' }
  })
}

// ========================
// 上下文刷新: 生成 Phase summary + 加载内容注入 (#2)
// ========================

// 摘要仍要生成并落盘（供回 Step 1 后 dispatch.js 构造 prompt 时读取），
// 但本脚本不再把它加载进 stdout —— 那是 prompt 的事，不是推进结果的事
try {
  const summaryPath = contextRefresh.generatePhaseSummary(storyId, currentPhase)
  if (summaryPath) {
    console.error(`  ✓ 上下文摘要已生成: ${path.basename(summaryPath)}`)
    trace.appendTrace(storyId, { type: 'context_refresh', phase: String(currentPhase), result: 'success', details: { file: path.basename(summaryPath) } })
  }
} catch (e) {
  // summary 生成失败不阻塞推进
  console.error(`  ⚠ 上下文摘要生成失败: ${e.message}`)
}

// 持久化 — 最关键的步骤，必须在 trace 之前完成
writeStateFile(storyId, state)

// P2-1: dispatch 预检对账补记 —— 上次预检报过 blocker 且本次门控通过，
// 补记 preGateBlocked 教训并清除留痕（见 reconcileDispatchPrecheck 说明）
reconcileDispatchPrecheck(storyId, currentPhase)

// 记录 trace（state 写入成功后才记录，确保 trace 不会领先于 state）
try {
  trace.tracePhaseTransition(storyId, currentPhase, targetPhase)
} catch (_) {
  // trace 失败不阻塞主流程
}

// ========================
// 输出结果
// ========================

const result = {
  success: true,
  storyId,
  fromPhase: currentPhase,
  fromPhaseName: currentPhaseName,
  toPhase: targetPhase,
  toPhaseName: getPhaseName(targetPhase),
  gateChecks: {
    passed: true,
    checks: combinedResult.warnings.length > 0 ? ['warnings: ' + combinedResult.warnings.join('; ')] : ['all passed']
  }
}

if (devPass) {
  result.devPass = { expiresAt: devPass.expiresAt, allowedFiles: devPass.allowedPaths.length, source: devPass.pathSource }
}

// 输出契约（v4，2026-09 收敛）: 只回「本次推进的结果」，不含任何 Spawn 信息。
//
// v3 曾在此构造下一 Phase 的 agentPrompt / nextAgent / expectedOutputs，
// 与 dispatch.js 构成两个 prompt 出口: 同一轮推进里 prompt 被生成三次
// （dispatch 分支 B 的残缺副本 → 本脚本 → 回 Step 1 后 dispatch 分支 A 那份真正被用的），
// 主 Agent 上下文里同一段话出现两遍，且分支 B 那份连摘要都没有。
// 职责收敛后: 推进归本脚本，「下一步怎么走」归 dispatch.js 独占。

// Phase 2 的逐 batch spawn 序列同样只在 dispatch.js 输出（buildBatchSequence）。
// 推进完成后主 Agent 回 Step 1 重新执行 dispatch.js 取新 Phase 指令。

// Phase 7 完成时自动触发度量聚合 + 标记工作流为 completed（终态）
if (currentPhase === 7 && targetPhase > 7) {
  // 度量聚合
  try {
    const { execSync } = require('child_process')
    const aggregatorPath = path.join(__dirname, '..', 'audit', 'metrics-aggregator.js')
    if (fs.existsSync(aggregatorPath)) {
      execSync(`node "${aggregatorPath}"`, { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT_ROOT })
      console.error('  ✓ 度量聚合已完成，洞察已合并到全局经验库')
      trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'success' })
    } else {
      // 路径不存在时显式告警，避免 existsSync 静默跳过导致度量永不聚合
      console.error('  ⚠ 度量聚合脚本不存在（非阻塞）: ' + aggregatorPath)
      trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'skipped', reason: 'aggregator_not_found: ' + aggregatorPath })
    }
  } catch (e) {
    console.error('  ⚠ 度量聚合失败（非阻塞）: ' + (e.message || '').slice(0, 100))
    trace.appendTrace(storyId, { type: 'metrics_aggregation', phase: '7', result: 'failed', reason: (e.message || '').slice(0, 200) })
  }

  // 标记工作流为终态（completed）
  state.status = 'completed'
  state.completedAt = now.toISOString()
  state.updatedAt = now.toISOString()
  writeStateFile(storyId, state)
  trace.appendTrace(storyId, { type: 'workflow', action: 'completed', result: 'success' })
  console.error('  ✓ 工作流已标记为 completed')
}

emit(result)
process.exit(0)
