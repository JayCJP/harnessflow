#!/usr/bin/env node
/**
 * create-workflow.js — 创建工作流统一入口
 *
 * 用法:
 *   node create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs]
 *
 * 参数:
 *   storyId       - Story 唯一标识
 *   title         - 需求标题
 *   --bypass      - 跳过 Phase 0-1，直接进入 Phase 2（用于 hotfix）
 *   --figma       - 标注有 Figma 设计稿
 *   --mode=<m>    - 工作流模式: run（默认，新功能开发）/ fixbugs（Bug 修复）
 *
 * 关于原型文档:
 *   旧实现无条件检查 prototype-analysis.md，缺失即写入 Greenfield stub，
 *   导致 fixbugs 场景每个 Story 都留下一个空壳文件，还会被 context-refresh
 *   当成 Phase 0 产出物收集。
 *   现改为按需判定 —— 只有 story-input.json 里真的给了原型/Figma 链接时才要求
 *   产出该文档，且由需求分析师产出，create-workflow 不再代写任何内容。
 *
 * 输出:
 *   成功 → 创建状态文件 + 输出 JSON 结果
 *   失败 → 输出错误信息 + 退出码 1
 */

const path = require('path')
const {
  PLANS_DIR,
  readStateFile,
  writeStateFile,
  isPrototypeRequired,
  issueDevPass,
  ensureReposJson,
  DEFAULT_MAX_FIX_ROUNDS
} = require('../lib/state')

/**
 * 执行工作流创建
 * @param {string} storyId - Story ID
 * @param {string} title - 需求标题
 * @param {boolean} bypass - 是否跳过 Phase 0-1（hotfix 模式）
 * @param {boolean} hasFigma - 是否提供了 Figma 设计稿
 * @param {'run'|'fixbugs'} [mode='run'] - 工作流模式
 * @returns {{ success: boolean, storyId: string, message: string, errors?: string[] }}
 */
function createWorkflow (storyId, title, bypass, hasFigma, mode) {
  const errors = []
  const workflowMode = mode === 'fixbugs' ? 'fixbugs' : 'run'

  // 1. 检查是否已有状态文件
  const existingState = readStateFile(storyId)
  if (existingState) {
    errors.push(`工作流已存在: .codebuddy/plans/${storyId}/e2e-state.json (当前 phase=${existingState.phase})`)
    return { success: false, storyId, errors }
  }

  // 2. 判定本 Story 是否需要原型分析文档
  //    bypass 跳过 Phase 0，fixbugs 无原型依赖，两者都直接免除
  //    ⚠️ 不在此处写任何 stub —— 需要时由需求分析师在 Phase 0 产出
  let protoRequired
  if (bypass) {
    protoRequired = { required: false, reason: 'bypass 模式跳过 Phase 0' }
  } else if (workflowMode === 'fixbugs') {
    protoRequired = { required: false, reason: 'fixbugs 模式，Bug 修复无原型依赖' }
  } else {
    protoRequired = isPrototypeRequired(storyId)
  }

  // 3. 确保 story 级 repos.json 存在（单仓库自动生成默认，多仓库由 AI 预先写入覆盖）
  ensureReposJson(storyId)

  // 4. 创建状态文件
  const now = new Date().toISOString()
  const initialPhase = bypass ? 2 : 0

  /** @type {Object} e2e 状态对象 */
  const state = {
    storyId,
    title,
    phase: initialPhase,
    status: 'running',
    mode: workflowMode, // run | fixbugs —— story-input.json 缺失时的模式回退信源
    createdAt: now,
    updatedAt: now,
    bypass: bypass || false,
    hasFigmaDesign: hasFigma || false, // 🌐 是否提供了 Figma 设计稿链接
    maxFixRounds: DEFAULT_MAX_FIX_ROUNDS, // 修复回路最大轮次（审查/测试失败后回退开发的最大修复次数，可按需修改）
    gateChecks: {
      // 本 Story 是否要求 prototype-analysis.md（false 时 Phase 0→1 门控跳过原型检查）
      prototypeRequired: protoRequired.required,
      prototypeRequiredReason: protoRequired.reason,
      // 不需要原型时视同已确认，避免门控卡住
      prototypeConfirmed: !protoRequired.required,
      documentConfirmed: false,
      apiSpecConfirmed: false,
      gateValidationResults: []
    },
    phases: {}
  }

  // 初始化所有 Phase 的状态
  const phaseKeys = [
    '0_requirement_analysis',
    '1_task_planning',
    '2_development',
    '3_code_review',
    '4_e2e_verification',
    '5_git_submit',
    '6_knowledge_base_update',
    '7_deployment'
  ]

  for (let i = 0; i < phaseKeys.length; i++) {
    if (bypass && i < initialPhase) {
      // bypass 模式下，跳过的 Phase 标记为 skipped
      state.phases[phaseKeys[i]] = {
        status: 'skipped',
        assignedTo: 'bypass',
        output: 'bypass 模式跳过'
      }
    } else if (i === initialPhase) {
      state.phases[phaseKeys[i]] = {
        status: bypass ? 'running' : 'pending'
      }
    } else {
      state.phases[phaseKeys[i]] = { status: 'pending' }
    }
  }

  // bypass 模式下，Phase 2 标记为 running
  if (bypass) {
    state.phases['2_development'] = {
      status: 'running',
      assignedTo: '前端开发工程师',
      startedAt: now
    }
  }

  // 5. 写入状态文件（通过 hook-utils 写入 Story 子目录）
  writeStateFile(storyId, state)
  const stateFilePath = path.join(PLANS_DIR, storyId, 'e2e-state.json')

  // 6. bypass 模式下签发 dev-pass
  if (bypass) {
    issueDevPass(storyId)
  }

  return {
    success: true,
    storyId,
    title,
    phase: initialPhase,
    bypass,
    mode: workflowMode,
    prototypeRequired: protoRequired.required,
    stateFile: stateFilePath,
    message: bypass
      ? `✅ 工作流已创建（bypass 模式），直接进入 Phase 2 (代码开发)，dev-pass 已签发`
      : `✅ 工作流已创建（mode=${workflowMode}），当前 Phase 0 (需求分析)，请 spawn 需求分析师 (agent 注册名: requirement-analyst)` +
        (protoRequired.required
          ? `\n   原型文档: 必需 — ${protoRequired.reason}，由需求分析师产出 prototype-analysis.md`
          : `\n   原型文档: 免除 — ${protoRequired.reason}`)
  }
}

// ─── 执行（CLI 模式） ──────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2)
  const cliStoryId = args[0]
  const cliTitle = args[1]
  const cliBypass = args.includes('--bypass')
  const cliHasFigma = args.includes('--figma')
  const modeArg = args.find(a => a.startsWith('--mode='))
  const cliMode = modeArg ? modeArg.slice('--mode='.length) : 'run'

  if (!cliStoryId || !cliTitle) {
    console.error('用法: node create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs]')
    console.error('示例: node create-workflow.js STORY-001 "1v1客服等级分配模式"')
    console.error('  --bypass          跳过 Phase 0-1')
    console.error('  --figma           标注有 Figma 设计稿，强制要求 Phase 2 前生成 figma-component-map.md')
    console.error('  --mode=fixbugs    Bug 修复模式，免除原型文档要求，Phase 0 需产出 Bug 分析报告')
    process.exit(1)
  }

  if (cliMode !== 'run' && cliMode !== 'fixbugs') {
    console.error(`❌ 无效的 --mode 值: ${cliMode}（仅支持 run / fixbugs）`)
    process.exit(1)
  }

  const result = createWorkflow(cliStoryId, cliTitle, cliBypass, cliHasFigma, cliMode)
  if (result.success) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } else {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
}

module.exports = { createWorkflow }
