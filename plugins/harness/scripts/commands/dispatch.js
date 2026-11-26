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
 *     fix_loop  Phase 3 存在 BLOCKER，执行 recovery.command 回退 Phase 2 修复
 *     terminal  冷启动未建流 / 已归档 / 主流程已完成，recovery 给出创建、复档或归档命令
 *
 *   终态下若还有可选阶段（云端部署）未做，输出 optionalNext 作为「还能做什么」的提示；
 *   它不是第五种 status，主 Agent 只在用户明确要求时转述，不据此改分支。
 *
 * 使用场景:
 *   - harness 三步循环的 Step 1 每一次都执行它，主 Agent 只按 status 分支执行，
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
 *   - agentPrompt 由 services/prompt-builder.js 构造，而本脚本是它的**唯一出口**：
 *     advance-phase.js 自 v4 起不再构造/输出 prompt，此前同一轮推进里 prompt 被生成三次
 *     （分支 B 的残缺副本 → advance-phase → 回 Step 1 后分支 A 那份真正被用的）。
 *     分支 B 刻意不构造 prompt —— 那时摘要尚未生成，构造出的必然是残缺副本。
 *   - 冷启动处理: 状态文件不存在时不再静默失败，而是返回 terminal + 创建工作流的 recovery 命令，
 *     避免 Phase 0 之前无法调度的死锁。
 *   - 三态互斥且穷尽（ready / blocked / fix_loop / terminal），主 Agent 按 status 分支，不做任何自行判断。
 *   - module.exports = { dispatch }: 当前无其他脚本 require，主要作为 CLI 被 harness skill
 *     三步循环的 Step 1 调用；导出保留供后续编排层复用。
 *
 * @module dispatch
 */

const fs = require('fs')
const path = require('path')

const {
  PLANS_DIR,
  readStateFile,
  getPhaseName,
  getPhaseAgent,
  checkOpenQuestions,
  isWorkflowTerminal,
  errorToString,
  errorToType
} = require('../lib/state')

const policy = require('../services/policy')
const promptBuilder = require('../services/prompt-builder')
const debugLog = require('../lib/debug-log')
// 命令路径与 Phase 常量收敛到 lib 公共出口（此前 policy.js / advance-phase.js 各拼一份）
const { ADVANCE_CMD, commandPath } = require('../lib/paths')
const { MAX_PHASE, MAIN_FLOW_END_PHASE } = require('../lib/phases')

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
    // 推进前置动作（仅 Phase 0 裁决回写时给出）：主 Agent 必须先 Spawn preAdvanceAgent 并注入
    // preAdvancePrompt，完成后才执行 advanceCommand。instruction 只是人读说明，不是机器消费字段。
    preAdvanceAgent: null,
    preAdvancePrompt: null,
    warnings: [],
    recovery: null,
    // 可选阶段提示（仅终态下可能出现）：{ phase, phaseName, optional, command, description }
    optionalNext: null
  }
}

/**
 * open-questions.json 未确认项告警
 *
 * 2026-10-20 重构（v4 口径）: 放行只看 confirmation 字段（用户确认记录），
 * 不分 blocking。旧文案「由需求分析师回填 resolution、不再需要用户逐项答复」
 * 正是"AI 自答就能过门"的病根，已删除。现按三类分别提示:
 *   待用户确认（建议稿已就位）/ 缺建议稿 / confirmation 格式不规范（疑似手写）。
 *
 * 判定逻辑统一由 contracts.js 的 checkOpenQuestions 提供（单一数据源）。
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} 告警列表；文件不存在或全部已确认时为空
 */
function openQuestionWarnings (storyId) {
  const check = checkOpenQuestions(storyId)
  const warnings = []

  if (check.pendingConfirmation.length > 0) {
    const ids = check.pendingConfirmation.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    warnings.push(
      `⛔ open-questions.json 有 ${check.pendingConfirmation.length} 项待确认项必须经用户确认（含 AI 已给建议稿的项）: ${ids} —— ` +
      'Phase 0→1 门控会拦截。用户答复先经需求分析师语义判定（assessment），再用 resolve-question.js 写入 confirmation（--answer 用户原话 / --accept 采纳建议稿）'
    )
  }
  if (check.assessedFinal.length > 0) {
    const ids = check.assessedFinal.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    warnings.push(
      `🔵 open-questions.json 有 ${check.assessedFinal.length} 项答复已判定为终局、待落账: ${ids} —— ` +
      '逐条执行 resolve-question.js --qid <Q-N> --answer "<该条 assessment.rawAnswer 逐字复制>"'
    )
  }
  if (check.noProposal.length > 0) {
    const ids = check.noProposal.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    warnings.push(
      `⚠️ open-questions.json 有 ${check.noProposal.length} 项待确认项尚无建议稿（resolution 为空）: ${ids} —— 需需求分析师补写后再交用户确认`
    )
  }
  if (check.confirmedInformal.length > 0) {
    const ids = check.confirmedInformal.map(q => q.id || q.question || '?').slice(0, 5).join(', ')
    warnings.push(
      `⚠️ open-questions.json 有 ${check.confirmedInformal.length} 项 confirmation 缺 confirmedVia/confirmedAt: ${ids} —— 疑似未经 resolve-question.js 写入，请人工核对`
    )
  }

  if (warnings.length > 0) return warnings
  // 文件不存在不告警（Phase 0 完成前属正常状态）；解析失败仍要提示
  const parseErr = (check.errors || []).find(e => e.includes('解析失败'))
  return parseErr ? [`open-questions.json ${parseErr}`] : []
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
        command: commandPath('harness-workflow.js') + ' start ' + storyId + ' "<标题>"',
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
      command: commandPath('archive-story.js') + ' ' + storyId + ' restore',
      description: '如需继续该 Story，先执行复档'
    }
    return result
  }

  // ── 终态: 主流程完成 ──────────────────────────────────────
  // 终态判定走 story-state 的 isWorkflowTerminal（唯一信源），此处不复写条件。
  // 主流程 = 审查 → 知识库更新 → Git 提交 + 建 MR；云端部署是可选阶段，做没做都算结束。
  if (isWorkflowTerminal(state)) {
    result.status = 'terminal'
    result.warnings.push('主流程已完成（代码审查 → 知识库更新 → Git 提交 + 建 MR）。')
    result.recovery = {
      type: 'completed',
      command: commandPath('archive-story.js') + ' ' + storyId + ' archive',
      description: '可执行归档收尾'
    }
    // 可选阶段提示：只给「还能做什么」，不进四态分支 —— 主 Agent 仅在用户明确要求时
    // 才把它转述给用户并按其中的命令推进，不得自行执行（终态下没有「该干活」这回事）。
    const deploymentPhase = MAX_PHASE - 1
    const deploymentDone = state.phases?.[`${deploymentPhase}_deployment`]?.status === 'completed'
    if (Number(state.phase) <= deploymentPhase && !deploymentDone) {
      result.optionalNext = {
        phase: deploymentPhase,
        phaseName: getPhaseName(deploymentPhase),
        optional: true,
        command: `${ADVANCE_CMD} ${storyId} ${deploymentPhase}`,
        description:
          '云端部署是可选阶段：如需部署，先确认 Git 提交阶段的 MR 已合并进 dev，' +
          `再执行 command 推进到 Phase ${deploymentPhase}（${getPhaseName(deploymentPhase)}）；` +
          '不需要部署则直接归档收尾。本提示不构成必须执行的动作。'
      }
    }
    return result
  }

  // ── open-questions 告警（不阻塞，仅提示用户确认） ─────────
  result.warnings.push(...openQuestionWarnings(storyId))

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

  // ── 分支 A-1: fixbugs 本轮无缺陷 → 结束工作流 ────────────────
  // 触发: Phase 0 的 bug-list.json 结构完好但 bugs 为空（TAPD 一条都没命中）。
  // 为什么不派单: fixbugs 的唯一输入就是 TAPD 查询结果 —— 0 条时没有任何分析可做，
  //   再 Spawn 需求分析师只会重跑同样查询、再落同一个空清单，形成无限空转。
  // 为什么必须在这里: 主 Agent 只按 status 机械分支，不会自行判断「0 条该不该收工」；
  //   这个判断属于编排，只能在唯一出口给出。
  // 注: 清单缺失 / 解析失败 / 字段缺失走别的 failureType，照常走分支 A 让 Agent 重做。
  if (phase === 0 && state.mode === 'fixbugs' && gate.blockers.some(b => policy.isNoBugsOutcome(b))) {
    result.status = 'terminal'
    result.nextAgent = null
    result.agentPrompt = null
    result.advanceCommand = null
    result.recovery = {
      type: 'no_bugs_matched',
      command: commandPath('harness-workflow.js') + ' end',
      description:
        '本轮 TAPD 查询没有符合筛选条件的缺陷（bug-list.json 的 bugs 为空），工作流直接结束，不进入开发。\n' +
        '操作: 执行 recovery.command 解除 harness 激活状态（幂等），然后告诉用户「本轮无符合条件的缺陷，已结束」。\n' +
        '不要 Spawn 任何 Agent、不要推进到 Phase 1、不要删除 Story 目录（保留记录备查）。'
    }
    return result
  }

  const fixLoop = detectFixLoop(storyId)

  // ── 分支 A: 当前 Phase 产出物未就绪 → 该 Phase 的 Agent 干活 ──
  if (!gate.passed) {
    // ── 分支 A0: 待确认项等待用户拍板 ──────────────────────────
    // 与分支 A（让 Agent 干活）的区别: 这不是"Agent 还没干完"，
    // 而是"建议稿已就位、缺用户确认" —— 重新 Spawn 分析员没有意义，
    // 会让它再自答一遍（这正是要根治的病）。故单独走 blocked 态，
    // 把确认动作交回主 Agent → 用户。
    if (gate.blockers.some(b => errorToType(b) === 'user_confirmation_required')) {
      // 清单从 checkOpenQuestions 取完整字段（问题原文 + 建议稿 + 依据来源，blocking 排前），
      // 而不是只转述 blocker message（只有 id 列表，主 Agent 还得自己去读文件猜内容）
      const oq = checkOpenQuestions(storyId)
      const sorted = [...oq.pendingConfirmation].sort((a, b) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0))
      const items = sorted.map(q =>
        `  ❓ ${q.id}${q.blocking ? ' [建议优先]' : ''} ${q.question}\n` +
        `    ➡️ 建议稿: ${(q.resolution || '').trim()}（依据: ${q.resolutionSource || '未标注'}）`
      )
      // v2 追问口径: 已判定终局的项单独分组 —— 指令是「落账」而非「再问用户」，
      // 避免同一问题被重复抛给用户（判定已确认它是终局裁决）
      const assessed = oq.assessedFinal || []
      const assessedItems = assessed.map(q =>
        `  🔵 ${q.id} 判定结论: ${q.assessment.decisionExtract || '(见 assessment)'}\n` +
        `    原话: ${q.assessment.rawAnswer}`
      )
      const assessedNote = assessed.length > 0
        ? '\n\n以下项答复已经需求分析师判定为终局（assessment.verdict=final），**勿再向用户重复提问**，直接落账:\n' +
          assessedItems.join('\n') +
          '\n操作: 逐条执行 ' + commandPath('resolve-question.js') + ` ${storyId} --qid <Q-N> --answer "<该条 assessment.rawAnswer 逐字复制>"`
        : ''
      // 空 items 边界: 只剩待落账项时不输出「必须经用户确认」引导头（避免语义断裂）
      const pendingHead = sorted.length > 0
        ? '以下待确认项必须经用户确认（AI 建议稿不构成放行依据）:\n' + items.join('\n')
        : ''
      // 缺建议稿的项一并提示，避免用户确认完再 dispatch 才发现还有 noProposal，多一次往返
      const noProposalNote = oq.noProposal.length > 0
        ? `\n另有 ${oq.noProposal.length} 项缺建议稿（${oq.noProposal.map(q => q.id).join(', ')}），需需求分析师先补稿`
        : ''
      result.status = 'blocked'
      result.recovery = {
        type: 'user_confirmation_required',
        command: null,
        description: pendingHead +
          assessedNote +
          '\n回复方式: 按编号答复，如「Q-1 采纳，Q-2 改为 <你的答案>」；答「采纳」即采纳该条建议稿（➡️ 行）。\n' +
          '判定环节（用户答复后、落账前必须执行，防止答复带出的新疑问/新指令被当终局裁决消费）: Spawn 需求分析师做答复语义判定 —— ' +
          '读取 open-questions.json 的全部未确认项与用户答复原话，为每条被答复的 Q 写 assessment ' +
          '{ verdict: "final"（终局裁决，可含同时带出的新分支）| "not_answered"（答非所问，下轮重问）, ' +
          'rawAnswer: <用户原话逐字摘录，禁止改写>, decisionExtract: <裁决要点摘录>, newQuestionIds: [] }；' +
          '答复带出的新疑问/新指令/需求变更逐条追加为新 Q（id = 现有最大编号+1，question 引用用户原话改写为可确认的问题，附 resolution 建议稿与 resolutionSource）；' +
          '未落账的 pending 项（含 not_answered）可按新判定改写 question/resolution。判定完成后回 Step 1 重新 dispatch，按其分组指令落账或继续问用户。\n' +
          'Spawn 时把以下占位符逐字替换为用户答复原文（其余任务描述原样保留，不加工）:\n<USER_REPLIES>\n' +
          `详情: read_file .codebuddy/plans/${storyId}/open-questions.json` +
          '\n操作: 按判定结论逐条执行 ' +
          commandPath('resolve-question.js') + ` ${storyId} --qid <Q-N> --answer "<用户原话>"` +
          '（校验: 无 assessment.verdict=final 或 --answer 与 rawAnswer 不一致会被拒绝）；用户答"采纳"改用 --accept，明确说"全部采纳"用 --accept-all，然后重新执行 dispatch.js' +
          noProposalNote
      }
      return result
    }

    const agentInfo = getPhaseAgent(phase)

    // 修复回路已激活且卡在 Phase 3（代码审查）→ 回退开发修复
    if (phase === 3 && gate.blockers.length > 0 && gate._meta && gate._meta.fixLoopAvailable) {
      result.status = 'fix_loop'
      result.recovery = {
        type: 'fix_loop',
        // 命令信源唯一: 这条 --fix-loop 命令由 policy.js 的 _meta.fixLoopHint 生成，
        // 此处原样转发，不二次拼装（此前两处各拼一遍，是本插件唯一的「同命令两信源」）
        command: gate._meta.fixLoopHint,
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
      // 序列构造收在 prompt-builder.buildBatchSequence（批次划分口径的唯一信源）。
      if (phase === 2) {
        const seq = promptBuilder.buildBatchSequence({ storyId, summaryPhase: phase - 1 })
        if (seq.batches.length > 0) {
          result.batches = seq.batches
          result.instruction = seq.instruction
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
  //
  // 此处**不构造** agentPrompt: 摘要（phase-N-summary.md）要等 advance-phase.js 推进时才生成，
  // 此刻构造出的 prompt 摘要段必然是「(无摘要)」的残缺副本 —— 主 Agent 若按本分支的
  // instruction 直接 Spawn，注入的就是这份残缺 prompt。推进完成后回 Step 1 重新执行
  // dispatch.js（走分支 A），那份才带新摘要、才是真正被 Spawn 用的。
  const nextPhase = phase + 1

  result.status = 'ready'
  result.advanceCommand = `${ADVANCE_CMD} ${storyId} ${nextPhase}`
  result.readyToAdvance = true

  // Phase 0 且已确认过待确认项 → 推进前先由需求分析师做「裁决回写」。
  // 触发点必须在本分支：A0（user_confirmation_required）只在「还有待确认项」时输出，
  // 最后一条落账后主 Agent 回到 dispatch 看到的正是这里，挂在 A0 的指令不会再被看到。
  // 必须通过 preAdvanceAgent / preAdvancePrompt 顶层字段驱动：SKILL.md 的 ready 分支只读字段，
  // 不读 instruction —— 写在 instruction 里的动作等于死指令（2026-11 review 实证）。
  // 判定只读字段事实（全部已确认 + 已确认项数 > 0），不判语义；幂等由分析员自行核对。
  if (phase === 0 && hasConfirmedDecisions(storyId)) {
    result.preAdvanceAgent = 'requirement-analyst'
    result.preAdvancePrompt =
      '你是需求分析师。执行「裁决回写」：全部待确认项已由用户确认，需在推进到 Phase 1 前把裁决落到需求文档与 AC。\n' +
      '否则裁决只留在 open-questions.json，下游开发/审查只认未同步过的 AC，用户裁决被架空。\n' +
      `步骤:\n  1. 读 .codebuddy/plans/${storyId}/open-questions.json 全部 confirmation 与 assessment.decisionExtract;\n` +
      '  2. 读 requirement-analysis.md 与 acceptance-criteria.json，逐条核对用户裁决与现有 AC / 文档描述;\n' +
      '  3. 裁决与 AC 冲突或 AC 缺失 → 直接更新 acceptance-criteria.json（保持 schema 合规；\n' +
      '     run 模式同步 featurePoints 的 acIds 引用，避免引用不存在的 AC）;\n' +
      '  4. 同步更新 requirement-analysis.md 正文的范围 / 设计描述（「用户已确认裁决」镜像块由脚本维护，不要手改）;\n' +
      '  5. 不改 open-questions.json（confirmation 是已落账事实）；文档与 AC 已与裁决一致时跳过写入。\n' +
      '完成后回报改动文件清单。不要执行推进命令 —— 推进由主 Agent 在收到回报后执行 advanceCommand。'
  }

  result.instruction = nextPhase > MAIN_FLOW_END_PHASE
    ? `执行 advanceCommand 推进到 Phase ${nextPhase}（${getPhaseName(nextPhase)}）；主流程在此结束，` +
      '之后云端部署为可选阶段，dispatch 会以 optionalNext 给出提示'
    : `先执行 advanceCommand 推进到 Phase ${nextPhase}，完成后回 Step 1 重新执行 dispatch.js 取新 Phase 指令`

  return result
}

/**
 * Phase 0 是否已确认过待确认项（决定推进前要不要做裁决回写）
 * 只读 checkOpenQuestions 的字段事实：open-questions 存在、全部已确认、且确有确认记录。
 * 无待确认项（questions 为空）时不需要回写，返回 false。
 * @param {string} storyId - Story ID
 * @returns {boolean} true = 需要执行裁决回写
 */
function hasConfirmedDecisions (storyId) {
  try {
    const oq = checkOpenQuestions(storyId)
    return oq.exists && oq.allResolved && (oq.confirmed.length + oq.confirmedInformal.length) > 0
  } catch (_) {
    // 读取失败不改变推进路径（回写是软前置，不阻断推进）
    return false
  }
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
    const t0 = Date.now()
    const out = dispatch(storyId)
    // debug 载荷层：全量记录调度输出（含 agentPrompt / pendingBlockers / batches），供流程回顾
    debugLog.record(storyId, 'script_output', out, {
      source: 'dispatch.js',
      phase: out.phase,
      durationMs: Date.now() - t0
    })
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
