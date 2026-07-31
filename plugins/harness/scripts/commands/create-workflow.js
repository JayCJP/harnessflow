#!/usr/bin/env node
/**
 * create-workflow.js — 创建工作流统一入口
 *
 * 在创建 e2e-state.json 之前，强制检查原型分析文档是否存在。
 * 如果缺少原型文档 → 拒绝创建状态文件。
 *
 * 用法:
 *   node create-workflow.js <storyId> "<title>" [--bypass]
 *
 * 参数:
 *   storyId  - Story 唯一标识
 *   title    - 需求标题
 *   --bypass - 跳过 Phase 0-1，直接进入 Phase 2（用于 hotfix）
 *
 * 前置检查:
 *   1. 原型分析文档 .codebuddy/plans/<storyId>-prototype-analysis.md 必须存在
 *      (--bypass 模式下跳过此检查)
 *   2. 不能已有同名的状态文件
 *
 * 输出:
 *   成功 → 创建状态文件 + 输出 JSON 结果
 *   失败 → 输出错误信息 + 退出码 1
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  readStateFile,
  writeStateFile,
  checkPrototypeDoc,
  issueDevPass,
  ensureReposJson,
  getPhaseName,
  DEFAULT_MAX_FIX_ROUNDS
} = require('../lib/state')

/**
 * 执行工作流创建
 * @param {string} storyId - Story ID
 * @param {string} title - 需求标题
 * @param {boolean} bypass - 是否跳过 Phase 0-1（hotfix 模式）
 * @returns {{ success: boolean, storyId: string, message: string, errors?: string[] }}
 */
function createWorkflow (storyId, title, bypass, hasFigma) {
  const errors = []

  // 1. 检查是否已有状态文件
  const existingState = readStateFile(storyId)
  if (existingState) {
    errors.push(`工作流已存在: .codebuddy/plans/${storyId}/e2e-state.json (当前 phase=${existingState.phase})`)
    return { success: false, storyId, errors }
  }

  // 2. 检查原型分析文档（非 bypass 模式）
  if (!bypass) {
    const protoDoc = checkPrototypeDoc(storyId)
    if (!protoDoc.exists) {
      // Greenfield 项目：自动创建最小 stub 原型分析文档
      const stubContent = [
        '# 原型分析文档 — ' + title,
        '',
        '## 原型抓取方法',
        '',
        'Greenfield 项目，无现有原型可抓取。无需 Playwright MCP 抓取。',
        '',
        '> 此文件由 `create-workflow.js` 自动生成。如有原型链接，请替换为实际抓取内容。',
        ''
      ].join('\n')
      const protoDir = path.dirname(protoDoc.path)
      if (!fs.existsSync(protoDir)) {
        fs.mkdirSync(protoDir, { recursive: true })
      }
      fs.writeFileSync(protoDoc.path, stubContent, 'utf-8')
      console.log('  ℹ prototype-analysis.md 已自动创建（Greenfield stub）')
    }
  }

  // 3. 确保 story 级 repos.json 存在（单仓库自动生成默认，多仓库由 AI 预先写入覆盖）
  const reposConfig = ensureReposJson(storyId)

  // 4. 创建状态文件
  const now = new Date().toISOString()
  const initialPhase = bypass ? 2 : 0

  /** @type {Object} e2e 状态对象 */
  const state = {
    storyId,
    title,
    phase: initialPhase,
    status: 'running',
    createdAt: now,
    updatedAt: now,
    bypass: bypass || false,
    hasFigmaDesign: hasFigma || false, // 🌐 是否提供了 Figma 设计稿链接
    maxFixRounds: DEFAULT_MAX_FIX_ROUNDS, // 修复回路最大轮次（审查/测试失败后回退开发的最大修复次数，可按需修改）
    gateChecks: {
      prototypeConfirmed: bypass || false,
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
    stateFile: stateFilePath,
    message: bypass
      ? `✅ 工作流已创建（bypass 模式），直接进入 Phase 2 (代码开发)，dev-pass 已签发`
      : `✅ 工作流已创建，当前 Phase 0 (需求分析)，请 spawn 需求分析师 (agent 注册名: requirement-analyst)`
  }
}

// ─── 执行（CLI 模式） ──────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2)
  const cliStoryId = args[0]
  const cliTitle = args[1]
  const cliBypass = args.includes('--bypass')
  const cliHasFigma = args.includes('--figma')

  if (!cliStoryId || !cliTitle) {
    console.error('用法: node create-workflow.js <storyId> "<title>" [--bypass] [--figma]')
    console.error('示例: node create-workflow.js STORY-001 "1v1客服等级分配模式"')
    console.error('  --bypass  跳过 Phase 0-1')
    console.error('  --figma   标注有 Figma 设计稿，强制要求 Phase 2 前生成 figma-component-map.md')
    process.exit(1)
  }

  const result = createWorkflow(cliStoryId, cliTitle, cliBypass, cliHasFigma)
  if (result.success) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } else {
    console.error(JSON.stringify(result, null, 2))
    process.exit(1)
  }
}

module.exports = { createWorkflow }
