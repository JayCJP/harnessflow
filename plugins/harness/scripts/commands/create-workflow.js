#!/usr/bin/env node
/**
 * create-workflow.js — 创建工作流状态文件并判定原型/Figma 门控
 *
 * 职责:
 *   - 创建 .codebuddy/plans/<storyId>/e2e-state.json，初始化 8 个 Phase 的状态与门控默认项
 *   - 判定并记录 prototypeRequired（是否要求 prototype-analysis.md）与 hasFigmaDesign（Figma 硬门控开关）
 *   - 确保 story 级 repos.json 存在；--bypass 时直接进入 Phase 2 并立即签发 dev-pass
 *   - --refresh-input: 在 story-input.json 写入后补算上述两项判定，不触碰 phase / status
 *
 * 用法:
 *   node plugins/harness/scripts/commands/create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs]
 *   node plugins/harness/scripts/commands/create-workflow.js <storyId> --refresh-input [--figma]
 *   --bypass         跳过 Phase 0-1，直接进入 Phase 2（hotfix 场景），并立即签发 dev-pass
 *   --figma          手工强制开启 Figma 硬门控，覆盖自动推导（任何模式生效）
 *   --mode=<m>       工作流模式: run（默认，新功能开发）/ fixbugs（Bug 修复，免除原型文档要求）
 *   --refresh-input  story-input.json 写入后补算原型/Figma 判定，只改这两项，不改 phase
 *
 * 使用场景:
 *   - 用户输入 /harness 后，由 harness-workflow.js start 内部调用 createWorkflow 创建状态文件；
 *     本命令是该调用的等价手工入口
 *   - harness-workflow.js 先建工作流、主 Agent 此后才写 story-input.json，导致原型/Figma 判定失真时，
 *     主 Agent 执行 --refresh-input 回填（createWorkflow 返回时会提示执行本命令）
 *   - hotfix 场景不需要需求分析与任务规划时，加 --bypass 让 Story 直接落到 Phase 2 并拿到 dev-pass
 *   - 不走 /harness 激活流程、需要单独为一个 Story 建流时，主 Agent 或用户手动执行本命令
 *
 * 说明:
 *   - 关于原型文档: 旧实现无条件检查 prototype-analysis.md，缺失即写入 Greenfield stub，
 *     导致 fixbugs 场景每个 Story 都留下一个空壳文件，还会被 context-refresh 当成 Phase 0 产出物收集。
 *     现改为按需判定 —— 只有 story-input.json 里真的给了原型/Figma 链接时才要求产出该文档，
 *     且由需求分析师产出，create-workflow 不再代写任何内容。
 *   - Figma 硬门控分模式处理: run 模式照设计稿从零搭 UI，需要完整 frame 清单 + 全量组件映射 → 按
 *     story-input.json 的 figmaUrls 自动推导开关；fixbugs 模式只碰个别页面，强制全量清单会卡死
 *     修复流程 → 默认关闭；--figma 是手工覆盖开关，无 story-input.json 时的兜底入口。
 *   - 门控开关不影响 prompt 注入。子 Agent 是否被提示解析 Figma 由 prompt-builder 直接读
 *     story-input.json 的 figmaUrls 决定，两种模式都注入。
 *   - --refresh-input 为何是显式命令而非惰性重算: 状态文件只能由授权脚本改写（enforce-state-file.js），
 *     在 dispatch 通道隐式改写会破坏"状态机单写者"这条铁律；且它只回填原型/Figma 两项，
 *     相位跃迁仍归 advance-phase.js 独有。
 *   - 工作流已存在（e2e-state.json 可读）时直接返回错误，不覆盖既有状态。
 *   - 输出: 成功 → 输出含 stateFile / message 的 JSON 并以退出码 0 结束；
 *     失败 → 输出 errors 数组并以退出码 1 结束。
 *   - module.exports = { createWorkflow, refreshStoryInput }，被同目录的 harness-workflow.js
 *     require，用于 start 时同步创建 e2e-state.json；CLI 分支由 require.main === module 守卫。
 *
 * @module create-workflow
 */

const path = require('path')
const {
  PLANS_DIR,
  readStateFile,
  writeStateFile,
  isPrototypeRequired,
  detectFigmaSource,
  issueDevPass,
  ensureReposJson,
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS
} = require('../lib/state')

/**
 * 判定本 Story 是否开启 Figma 硬门控（hasFigmaDesign）
 *
 * 分模式处理 —— run 与 fixbugs 对设计稿的用法本质不同:
 *   - run: 照设计稿从零搭 UI，需要完整 frame 清单 + 全量组件映射 → 开门控
 *   - fixbugs: 只碰个别页面，强制全量清单会卡死修复流程 → 关门控
 *   - --figma: 手工覆盖，任何模式下强制开启（无 story-input.json 时的兜底入口）
 *
 * ⚠️ 门控开关不影响 prompt 注入。子 Agent 是否被提示解析 Figma 由
 * prompt-builder 直接读 story-input.json 的 figmaUrls 决定，两种模式都注入。
 *
 * @param {string} storyId - Story ID
 * @param {boolean} hasFigmaFlag - CLI `--figma` 手工开关
 * @param {'run'|'fixbugs'} workflowMode - 工作流模式
 * @param {boolean} bypass - 是否跳过 Phase 0-1
 * @returns {{ enabled: boolean, reason: string, detectedUrls: number }}
 */
function resolveFigmaDesign (storyId, hasFigmaFlag, workflowMode, bypass) {
  const detected = detectFigmaSource(storyId)

  if (hasFigmaFlag) {
    return { enabled: true, reason: '--figma 手工指定', detectedUrls: detected.urls.length }
  }
  if (bypass) {
    return { enabled: false, reason: 'bypass 模式跳过 Phase 0-1，Figma 门控无意义', detectedUrls: detected.urls.length }
  }
  if (workflowMode === 'fixbugs') {
    return {
      enabled: false,
      reason: 'fixbugs 模式不做全量设计稿还原（如需强制开启用 --figma）',
      detectedUrls: detected.urls.length
    }
  }
  return { enabled: detected.hasFigma, reason: detected.reason, detectedUrls: detected.urls.length }
}

/**
 * 执行工作流创建
 * @param {string} storyId - Story ID
 * @param {string} title - 需求标题
 * @param {boolean} bypass - 是否跳过 Phase 0-1（hotfix 模式）
 * @param {boolean} hasFigma - 是否提供了 Figma 设计稿（CLI --figma 手工开关）
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

  // 2b. 判定 Figma 硬门控开关（run 开 / fixbugs 关 / --figma 强制开）
  const figma = resolveFigmaDesign(storyId, hasFigma, workflowMode, bypass)

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
    hasFigmaDesign: figma.enabled, // 🌐 是否开启 Figma 硬门控（信源: story-input.json figmaUrls / --figma）
    hasFigmaDesignReason: figma.reason, // 判定依据，便于排查门控为何未触发
    // 修复回路最大轮次 —— 按失败源（Phase 3 代码审查 / Phase 4 功能测试）独立预算，各 2 次，用尽转人工
    maxReviewFixRounds: DEFAULT_MAX_REVIEW_FIX_ROUNDS,
    maxTestFixRounds: DEFAULT_MAX_TEST_FIX_ROUNDS,
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
    hasFigmaDesign: figma.enabled,
    stateFile: stateFilePath,
    message: bypass
      ? `✅ 工作流已创建（bypass 模式），直接进入 Phase 2 (代码开发)，dev-pass 已签发`
      : `✅ 工作流已创建（mode=${workflowMode}），当前 Phase 0 (需求分析)，请 spawn 需求分析师 (agent 注册名: requirement-analyst)` +
        (protoRequired.required
          ? `\n   原型文档: 必需 — ${protoRequired.reason}，由需求分析师产出 prototype-analysis.md`
          : `\n   原型文档: 免除 — ${protoRequired.reason}`) +
        `\n   Figma 门控: ${figma.enabled ? '开启' : '关闭'} — ${figma.reason}` +
        `\n   ⚠️ 若 story-input.json 是在本命令之后才写入的，请执行:` +
        `\n      node ${path.basename(__filename)} ${storyId} --refresh-input`
  }
}

/**
 * 补算 story-input.json 派生的判定结果（--refresh-input）
 *
 * 为何需要这条命令: harness-workflow.js 的 Step 1A 先创建工作流，主 Agent 的
 * Step 1B 才写 story-input.json。createWorkflow 执行时该文件尚不存在，
 * prototypeRequired 走「保守要求」分支、hasFigmaDesign 恒为 false。
 * 主 Agent 写完 story-input.json 后执行本命令回填，让两项判定与实际输入一致。
 *
 * 显式命令而非惰性重算 —— 状态文件只能由授权脚本改写（enforce-state-file.js），
 * 在 dispatch 通道隐式改写会破坏「状态机单写者」这条铁律。
 *
 * 只回填这两项，不触碰 phase / status —— 相位跃迁仍归 advance-phase.js 独有。
 *
 * @param {string} storyId - Story ID
 * @param {boolean} [hasFigmaFlag=false] - 是否附带 --figma 手工开关
 * @returns {{ success: boolean, storyId: string, message?: string, errors?: string[] }}
 */
function refreshStoryInput (storyId, hasFigmaFlag = false) {
  const state = readStateFile(storyId)
  if (!state) {
    return { success: false, storyId, errors: [`工作流不存在: 未找到 .codebuddy/plans/${storyId}/e2e-state.json`] }
  }

  const workflowMode = state.mode === 'fixbugs' ? 'fixbugs' : 'run'
  const bypass = state.bypass || false

  const protoRequired = (bypass || workflowMode === 'fixbugs')
    ? { required: false, reason: bypass ? 'bypass 模式跳过 Phase 0' : 'fixbugs 模式，Bug 修复无原型依赖' }
    : isPrototypeRequired(storyId)
  const figma = resolveFigmaDesign(storyId, hasFigmaFlag || state.hasFigmaDesign, workflowMode, bypass)

  const before = { proto: state.gateChecks.prototypeRequired, figma: state.hasFigmaDesign }

  state.hasFigmaDesign = figma.enabled
  state.hasFigmaDesignReason = figma.reason
  state.gateChecks.prototypeRequired = protoRequired.required
  state.gateChecks.prototypeRequiredReason = protoRequired.reason
  state.gateChecks.prototypeConfirmed = !protoRequired.required
  state.updatedAt = new Date().toISOString()
  writeStateFile(storyId, state)

  const changed = before.proto !== protoRequired.required || before.figma !== figma.enabled
  return {
    success: true,
    storyId,
    prototypeRequired: protoRequired.required,
    hasFigmaDesign: figma.enabled,
    message: `${changed ? '✅ 判定已更新' : 'ℹ️ 判定无变化'}（mode=${workflowMode}）` +
      `\n   原型文档: ${protoRequired.required ? '必需' : '免除'} — ${protoRequired.reason}` +
      `\n   Figma 门控: ${figma.enabled ? '开启' : '关闭'} — ${figma.reason}`
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
  const cliRefreshInput = args.includes('--refresh-input')

  // --refresh-input 只需 storyId（模式/bypass 从既有状态文件读取）
  if (cliRefreshInput) {
    if (!cliStoryId) {
      console.error('用法: node create-workflow.js <storyId> --refresh-input [--figma]')
      process.exit(1)
    }
    const refreshResult = refreshStoryInput(cliStoryId, cliHasFigma)
    console.log(JSON.stringify(refreshResult, null, 2))
    process.exit(refreshResult.success ? 0 : 1)
  }

  if (!cliStoryId || !cliTitle) {
    console.error('用法: node create-workflow.js <storyId> "<title>" [--bypass] [--figma] [--mode=run|fixbugs]')
    console.error('      node create-workflow.js <storyId> --refresh-input [--figma]')
    console.error('示例: node create-workflow.js STORY-001 "1v1客服等级分配模式"')
    console.error('  --bypass          跳过 Phase 0-1')
    console.error('  --figma           手工强制开启 Figma 硬门控（任何模式生效，覆盖自动推导）')
    console.error('  --mode=fixbugs    Bug 修复模式，免除原型文档要求，Phase 0 需产出 Bug 分析报告')
    console.error('  --refresh-input   story-input.json 写入后补算原型/Figma 判定（不改 phase）')
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

module.exports = { createWorkflow, refreshStoryInput }
