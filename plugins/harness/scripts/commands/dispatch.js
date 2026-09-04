#!/usr/bin/env node
/**
 * dispatch.js — 工作流调度器（只读，零写权限）
 *
 * 职责:
 *   - 读取 e2e-state.json，只读地给出「下一步做什么」: status / nextAgent / agentPrompt / advanceCommand / recovery
 *   - 预跑 policy.js 门控，用于决定「该干活还是该推进」，但不写任何状态
 *   - 识别终态（未建流 / 状态解析失败 / 已归档 / 已完成）并给出对应的 recovery 命令
 *   - 汇总 open-questions.json 未确认项与 fix-request.json 修复回路状态，作为不阻塞的告警输出
 *
 * 用法:
 *   node plugins/harness/scripts/commands/dispatch.js <storyId>
 *     storyId 可带 plans/ 或 .codebuddy/plans/ 前缀，脚本会自动剥离
 *   输出为纯 JSON，主 Agent 按 status 分支机械执行:
 *     ready     Spawn nextAgent 注入 agentPrompt 干活，或执行 advanceCommand 推进
 *     blocked   状态异常，按 recovery.command / description 修复
 *     fix_loop  Phase 3/4 存在 BLOCKER，执行 recovery.command 回退 Phase 2 修复
 *     terminal  冷启动未建流 / 已归档 / 已完成，recovery 给出创建、复档或归档命令
 *
 * 使用场景:
 *   - harness-conductor 三步循环的 Step 1 每一次都执行它，主 Agent 只按 status 分支执行，
 *     不自行判断当前 Phase，也不直接读 e2e-state.json
 *   - 某 Phase 的 Agent 汇报完成后，重新执行 dispatch.js 取新 Phase 的指令与 advanceCommand，
 *     而不是自己算 targetPhase
 *   - 不确定 Story 停在哪个 Phase、该 Spawn 哪个 Agent 时，用它查表（Phase→Agent 映射的唯一出口）
 *   - 冷启动（e2e-state.json 尚不存在）时，用它的 recovery.command 拿到创建工作流的命令
 *
 * 说明:
 *   - ┌─ 职责边界（本插件控制流的核心约定）────────────────────────────┐
 *     │  dispatch.js      = 读状态 + 说下一步   （只读，零写权限）      │
 *     │  advance-phase.js = 判门控 + 写状态     （相位跃迁唯一执行者）  │
 *     │  主 Agent         = 触发                （无判断权，机械执行）  │
 *     └───────────────────────────────────────────────────────────────┘
 *   - 为什么用脚本取代原 dispatcher Agent:
 *     1. dispatcher.md 自己承认 "Phase→Agent 映射是确定的，不需要判断，只需要查表"
 *        —— 查表不该花一次 LLM 往返，更不该承担幻觉风险。
 *     2. dispatcher.md 声称"只读"却持有 Bash 工具，是状态文件保护的唯一无人看守通道。
 *        脚本的只读性由代码本身保证，可审计。
 *     3. 输出里混有自然语言 TODO（如 "从 task-dag.json 提取并行任务列表"），
 *        迫使主 Agent 自己去读文件、自己判断——判断权回流即失控。
 *   - 门控预检只是"预读"，真正的裁定权在 advance-phase.js。dispatch.js 的门控结论仅用于
 *     决定"该干活还是该修复"，绝不代替 advance-phase.js 写状态。
 *   - P2-1（2026-09）: 预检报出 blocker 时会落盘诊断类文件 .dispatch-precheck.json（仅记录
 *     预检快照，不是状态）。这是对"零写权限"的唯一且有意的例外 —— 状态机文件
 *     (e2e-state.json / dev-pass.json) 仍然零写；该文件供 advance-phase.js 推进成功时
 *     对账补记 preGateBlocked 教训，否则「预检越好用，飞轮越饿」(D3)。
 *   - fix_loop 分支会一并给出回退后要 Spawn 的 Phase 2 Agent 与 prompt，否则主 Agent 执行完
 *     --fix-loop 只能自行判断该 Spawn 谁 —— 判断权回流即失控。
 *   - agentPrompt 统一由 services/prompt-builder.js 构造，与 advance-phase.js 共用同一信源。
 *   - 冷启动处理: 状态文件不存在时不再静默失败，而是返回 terminal + 创建工作流的 recovery 命令，
 *     避免 Phase 0 之前无法调度的死锁。
 *   - 三态互斥且穷尽（ready / blocked / fix_loop / terminal），主 Agent 按 status 分支，不做任何自行判断。
 *   - module.exports = { dispatch }: 当前无其他脚本 require，主要作为 CLI 被 harness-conductor
 *     三步循环的 Step 1 调用；导出保留供后续编排层复用。
 *
 * @module dispatch
 */

const fs = require('fs')
const path = require('path')

const {
  PLANS_DIR,
  PHASE_SLUGS,
  readStateFile,
  getPhaseName,
  getPhaseAgent,
  errorToString,
  errorToType
} = require('../lib/state')

const policy = require('../services/policy')
const promptBuilder = require('../services/prompt-builder')

const MAX_PHASE = PHASE_SLUGS.length - 1

/**
 * 插件根目录（P0-3: 运行时由脚本自身位置动态推导，不依赖 ${CLAUDE_PLUGIN_ROOT} 占位符展开，
 * 主 Agent 在任何 cwd 下拿到的命令都可直接执行，PowerShell 不再需要手工改写绝对路径）
 */
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..')

/**
 * 生成插件内命令脚本的绝对调用形式
 * 动态解析插件根后拼接脚本路径；Windows 路径含空格时由双引号保护；
 * 用正斜杠形式输出 —— markdown 渲染层会把 `\.` 当转义吃掉导致显示缺分隔符（2026-09 实跑反馈），
 * 正斜杠在任何渲染层原样保留，且 PowerShell / node 均兼容
 * @param {string} scriptName - scripts/commands/ 下的脚本文件名
 * @returns {string} 形如 node "<绝对路径>" 的可执行命令
 */
function pluginCmd (scriptName) {
  return `node "${path.join(PLUGIN_ROOT, 'scripts', 'commands', scriptName).replace(/\\/g, '/')}"`
}

/** advance-phase.js 的绝对调用形式（动态解析，无未展开占位符） */
const ADVANCE_CMD = pluginCmd('advance-phase.js')

/**
 * 构造调度结果骨架
 * @param {string} storyId - Story ID
 * @param {Object|null} state - 状态对象
 * @returns {Object} 调度结果骨架
 */
function baseResult (storyId, state) {
  const phase = state && typeof state.phase === 'number' ? state.phase : null
  return {
    storyId,
    phase,
    phaseName: phase !== null ? getPhaseName(phase) : null,
    status: 'ready',
    nextAgent: null,
    agentLabel: null,
    agentPrompt: null,
    advanceCommand: null,
    warnings: [],
    recovery: null
  }
}

/**
 * 检查 open-questions.json 中是否有未确认项
 * @param {string} storyId - Story ID
 * @returns {string[]} 告警列表
 */
function checkOpenQuestions (storyId) {
  const p = path.join(PLANS_DIR, storyId, 'open-questions.json')
  if (!fs.existsSync(p)) return []
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
    const list = Array.isArray(data.questions) ? data.questions : (Array.isArray(data) ? data : [])
    const unresolved = list.filter(q => q && q.resolved !== true)
    if (unresolved.length === 0) return []
    const ids = unresolved.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    return [`open-questions.json 中有 ${unresolved.length} 个未确认问题: ${ids}。请与用户确认后再继续。`]
  } catch (e) {
    return [`open-questions.json 解析失败: ${e.message}`]
  }
}

/**
 * 检测修复回路状态
 * @param {string} storyId - Story ID
 * @returns {{ active: boolean, round?: number, maxRounds?: number, issueCount?: number }}
 */
function detectFixLoop (storyId) {
  const p = path.join(PLANS_DIR, storyId, 'fix-request.json')
  if (!fs.existsSync(p)) return { active: false }
  try {
    const fr = JSON.parse(fs.readFileSync(p, 'utf-8'))
    return {
      active: true,
      round: fr.round,
      maxRounds: fr.maxRounds,
      issueCount: Array.isArray(fr.issues) ? fr.issues.length : 0,
      affectedFiles: fr.affectedFiles || []
    }
  } catch (e) {
    return { active: false }
  }
}

/**
 * 主调度逻辑
 * @param {string} storyId - Story ID
 * @returns {Object} 调度指令
 */
function dispatch (storyId) {
  // ── 冷启动: 状态文件不存在 ────────────────────────────────
  // 原 dispatcher Agent 要求先读 e2e-state.json 才能输出下一步，
  // 导致 Phase 0 之前无法调度（冷启动死锁）。此处显式处理。
  const state = readStateFile(storyId)
  if (!state) {
    return {
      storyId,
      phase: null,
      phaseName: null,
      status: 'terminal',
      nextAgent: null,
      agentLabel: null,
      agentPrompt: null,
      advanceCommand: null,
      warnings: [`工作流尚未创建: .codebuddy/plans/${storyId}/e2e-state.json 不存在`],
      recovery: {
        type: 'not_started',
        command: pluginCmd('harness-workflow.js') + ' start ' + storyId + ' "<标题>"',
        description: '先创建工作流，再重新执行 dispatch.js'
      }
    }
  }

  if (state._parseError) {
    return {
      storyId,
      phase: null,
      phaseName: null,
      status: 'blocked',
      nextAgent: null,
      agentLabel: null,
      agentPrompt: null,
      advanceCommand: null,
      warnings: [],
      recovery: {
        type: 'state_parse_error',
        command: null,
        description: `e2e-state.json 解析失败: ${state._parseError}。需人工修复 JSON 语法后重试。`
      }
    }
  }

  const result = baseResult(storyId, state)
  const phase = result.phase

  // ── 终态: 已归档 ──────────────────────────────────────────
  if (state.status === 'archived') {
    result.status = 'terminal'
    result.warnings.push(
      state.archiveRound
        ? `Story 已归档 (round ${state.archiveRound})，工作流结束。`
        : 'Story 已归档，工作流结束。'
    )
    result.recovery = {
      type: 'archived',
      command: pluginCmd('archive-story.js') + ' ' + storyId + ' restore',
      description: '如需继续该 Story，先执行复档'
    }
    return result
  }

  // ── 终态: 流程完成 ────────────────────────────────────────
  if (phase > MAX_PHASE - 1 || state.status === 'completed') {
    result.status = 'terminal'
    result.warnings.push('工作流已完成全部 Phase。')
    result.recovery = {
      type: 'completed',
      command: pluginCmd('archive-story.js') + ' ' + storyId + ' archive',
      description: '可执行归档收尾'
    }
    return result
  }

  // ── open-questions 告警（不阻塞，仅提示用户确认） ─────────
  result.warnings.push(...checkOpenQuestions(storyId))

  // ── 门控预检: 判断当前 Phase 的产出物是否已就绪 ───────────
  // 注意: 这里只是"预读"，真正的裁定权在 advance-phase.js。
  //       dispatch.js 的门控结论仅用于决定"该干活还是该修复"，
  //       绝不代替 advance-phase.js 写状态。
  let gate = { passed: true, blockers: [], warnings: [], recoveries: [] }
  try {
    gate = policy.runGateCheck(storyId, phase, state)
  } catch (e) {
    result.warnings.push(`门控预检异常（不阻塞调度）: ${e.message}`)
  }
  result.warnings.push(...(gate.warnings || []))

  const fixLoop = detectFixLoop(storyId)

  // ── 分支 A: 当前 Phase 产出物未就绪 → 该 Phase 的 Agent 干活 ──
  if (!gate.passed) {
    const agentInfo = getPhaseAgent(phase)

    // 修复回路已激活且卡在 Phase 3/4 → 回退开发修复
    const isReviewOrTest = phase === 3 || phase === 4
    if (isReviewOrTest && gate.blockers.length > 0 && gate._meta && gate._meta.fixLoopAvailable) {
      result.status = 'fix_loop'
      result.recovery = {
        type: 'fix_loop',
        command: `${ADVANCE_CMD} ${storyId} 2 --fix-loop`,
        description: `Phase ${phase} 存在 BLOCKER，执行修复回路回退到 Phase 2 修复` +
          (fixLoop.active ? `（当前第 ${fixLoop.round}/${fixLoop.maxRounds} 轮）` : ''),
        blockers: gate.blockers.map(b => ({ type: errorToType(b), message: errorToString(b) }))
      }

      // 回退后要干活的是 Phase 2 的开发者。此处一并给出 Agent 与 prompt，
      // 否则主 Agent 执行完 --fix-loop 只能自行判断该 Spawn 谁 —— 判断权回流即失控。
      // P1-2: scope=incremental —— 修复场景用窄上下文（只列 fix-request 等被点名契约，
      // 跳过 Story 背景资料与 Figma 摘要），避免重读大文件空转（D5）
      const fixAgentInfo = getPhaseAgent(2)
      if (fixAgentInfo) {
        const pb = promptBuilder.buildAgentPrompt({
          storyId,
          targetPhase: 2,
          summaryPhase: phase,
          scope: 'incremental'
        })
        result.nextAgent = pb.agent
        result.agentLabel = pb.agentLabel
        result.agentPrompt = pb.agentPrompt
        result.expectedOutputs = pb.expectedOutputs
        result.instruction = `先执行 recovery.command 回退到 Phase 2，成功后 Spawn ${pb.agent} 并注入 agentPrompt 修复 BLOCKER`
      }
      return result
    }

    // 常规情况: 本 Phase 的 Agent 尚未产出，让它干活
    if (agentInfo) {
      const pb = promptBuilder.buildAgentPrompt({
        storyId,
        targetPhase: phase,
        summaryPhase: phase - 1
      })
      result.status = 'ready'
      result.nextAgent = pb.agent
      result.agentLabel = pb.agentLabel
      result.agentPrompt = pb.agentPrompt
      result.expectedOutputs = pb.expectedOutputs
      result.advanceCommand = `${ADVANCE_CMD} ${storyId} ${phase + 1}`
      result.pendingBlockers = gate.blockers.map(b => ({
        type: errorToType(b),
        message: errorToString(b)
      }))
      if (pb.fixLoopContext) result.fixLoopContext = pb.fixLoopContext

      // P1-1: Phase 2 且 task-dag 声明了多个 batch 时，逐 batch 输出 spawn 指令 ——
      // 主 Agent 无需再从整份 Phase 2 prompt 里自行裁剪批次范围、手写 batch prompt（D1）。
      // 每个 batch 的 agentPrompt 已含「目标仓 + task id 清单 + files[] 白名单」。
      if (phase === 2) {
        const { batches } = promptBuilder.readTaskBatches(storyId)
        if (batches.length > 1) {
          result.batches = batches.map(b => {
            const bpb = promptBuilder.buildAgentPrompt({
              storyId,
              targetPhase: 2,
              summaryPhase: phase - 1,
              batchId: b.batchId
            })
            return {
              batchId: b.batchId,
              taskIds: b.taskIds,
              agent: bpb.agent,
              agentLabel: bpb.agentLabel,
              agentPrompt: bpb.agentPrompt,
              expectedOutputs: bpb.expectedOutputs
            }
          })
          result.instruction = `task-dag 声明了 ${batches.length} 个 batch，逐 batch Spawn ${result.nextAgent} 并注入该 batch 的 agentPrompt（files 白名单已注入各 batch prompt），全部 batch 完成后再执行 advanceCommand`
        }
      }

      // P2-1: 预检失败留痕 —— dispatch 预检报出的 blocker 修复后直接 advance 成功，
      // 失败从未进入经验库（预检越好用，飞轮越饿，D3）。此处落盘诊断类文件
      // （非状态机文件），供 advance-phase.js 推进成功时对账补记 preGateBlocked
      if (result.pendingBlockers.length > 0) {
        try {
          fs.writeFileSync(
            path.join(PLANS_DIR, storyId, '.dispatch-precheck.json'),
            JSON.stringify({
              storyId,
              phase,
              blockers: result.pendingBlockers,
              recordedAt: new Date().toISOString()
            }, null, 2),
            'utf-8'
          )
        } catch (e) {
          // 落盘失败不影响调度（对账退化为无记录，不补记教训）
        }
      }
      return result
    }

    // 无对应 Agent（不应发生，Phase 0-7 均有 Agent）
    result.status = 'blocked'
    result.recovery = {
      type: 'no_agent_for_phase',
      command: null,
      description: `Phase ${phase} 未在 PHASE_AGENTS 中登记 Agent，需补充 scripts/lib/state.js 的映射表`
    }
    return result
  }

  // ── 分支 B: 当前 Phase 已就绪 → 推进到下一 Phase ──────────
  // 门控已通过，说明本 Phase 的活干完了，下一步是执行推进命令。
  // 推进后主 Agent 应再次执行 dispatch.js 获取新 Phase 的指令。
  const nextPhase = phase + 1
  const nextAgentInfo = getPhaseAgent(nextPhase)

  result.status = 'ready'
  result.advanceCommand = `${ADVANCE_CMD} ${storyId} ${nextPhase}`
  result.readyToAdvance = true

  if (nextAgentInfo) {
    const pb = promptBuilder.buildAgentPrompt({
      storyId,
      targetPhase: nextPhase,
      summaryPhase: phase
    })
    result.nextAgent = pb.agent
    result.agentLabel = pb.agentLabel
    result.agentPrompt = pb.agentPrompt
    result.expectedOutputs = pb.expectedOutputs
    if (pb.fixLoopContext) result.fixLoopContext = pb.fixLoopContext
    result.instruction = `先执行 advanceCommand 推进到 Phase ${nextPhase}，成功后 Spawn ${pb.agent} 并注入 agentPrompt`
  } else {
    // nextPhase 为终态 8
    result.instruction = `执行 advanceCommand 完成工作流（Phase ${nextPhase} 为终态）`
  }

  return result
}

// ─── CLI ────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2)
  const storyId = args[0] ? args[0].replace(/^(plans\/|\.codebuddy\/plans\/)/i, '') : null

  if (!storyId) {
    console.error(JSON.stringify({
      error: '用法: node dispatch.js <storyId>',
      example: '  node dispatch.js STORY-001'
    }, null, 2))
    process.exit(1)
  }

  try {
    const out = dispatch(storyId)
    console.log(JSON.stringify(out, null, 2))
    process.exit(0)
  } catch (e) {
    console.error(JSON.stringify({
      error: 'dispatch 执行异常',
      storyId,
      message: e.message,
      stack: (e.stack || '').split('\n').slice(0, 5).join('\n')
    }, null, 2))
    process.exit(1)
  }
}

module.exports = { dispatch }
