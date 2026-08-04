#!/usr/bin/env node
/**
 * prompt-builder.js — Agent Prompt 构造服务
 *
 * 职责: 把"下一个 Phase 的 Agent 需要知道的一切"组装成一段完整 prompt。
 *
 * 设计原则 — 单一信源:
 *   历史上 prompt 有两个来源（advance-phase.js 的 suggestedAgentPrompt 与
 *   dispatcher Agent 的 instruction/inputFiles），主 Agent 面对两个都自称权威的
 *   来源只能自行拼接，而"拼接"就是判断——判断权回到主 Agent 手里，正是流程失控的成因。
 *   本模块是 prompt 的唯一出口: advance-phase.js 与 dispatch.js 都调用它，
 *   主 Agent 只做原样注入，不做任何拼装。
 *
 * 本模块为纯只读: 只读产出物文件，不写任何文件、不改状态。
 */

const fs = require('fs')
const path = require('path')

const {
  PLANS_DIR,
  PHASE_ARTIFACTS,
  getPhaseName,
  getPhaseAgent,
  STORY_INPUT_FILE,
  readStoryInput,
  getStoryMode
} = require('../lib/state')

const contextRefresh = require('./context-refresh')
const experience = require('./experience')

/** 单个契约文件注入 prompt 时的最大字符数，超出则截断 */
const CONTRACT_TRUNCATE_LIMIT = 3000

/** 单份 Story 背景资料（如 bug 分析报告）注入 prompt 时的最大字符数 */
const STORY_CONTEXT_TRUNCATE_LIMIT = 6000

/**
 * Agent 通用约束（所有 Phase 的 Agent 都必须遵守）
 * 与 session-start.js 注入的铁律保持一致。
 */
const AGENT_CONSTRAINTS = [
  '禁止修改 e2e-state.json 和 dev-pass.json，状态机由 advance-phase.js 独占维护',
  '禁止通过 shell 命令绕过上述限制写状态文件（hook 会拦截并记录违规）',
  '只产出本 Phase 的产出物，完成后汇报产出物路径',
  '由主 Agent 调用 advance-phase.js 推进 Phase，禁止自行修改 phase',
  '查找/定位代码时必须使用 kb-query + graphify 双源交叉验证，禁止仅用 Explore agent 或仅文本搜索'
]

/**
 * 读取契约文件内容并格式化为 prompt 片段
 * @param {string} storyId - Story ID
 * @param {string[]} contractFiles - 契约文件路径列表（形如 .codebuddy/plans/<id>/xxx.json）
 * @returns {string[]} 已格式化的 markdown 片段
 */
function readContractContents (storyId, contractFiles) {
  const contents = []
  for (const cf of contractFiles || []) {
    const cfPath = path.join(PLANS_DIR, storyId, cf.replace(/^\.codebuddy\/plans\/[^/]+\//, ''))
    if (!fs.existsSync(cfPath)) continue
    try {
      const content = fs.readFileSync(cfPath, 'utf-8')
      const truncated = content.length > CONTRACT_TRUNCATE_LIMIT
        ? content.slice(0, CONTRACT_TRUNCATE_LIMIT) + '\n... (内容已截断，完整内容请读取源文件)'
        : content
      contents.push(`### ${cf}\n\`\`\`\n${truncated}\n\`\`\``)
    } catch (e) {
      contents.push(`### ${cf}\n(读取失败: ${e.message})`)
    }
  }
  return contents
}

/**
 * 读取 Story 级背景资料，注入到每个 Phase 的 prompt。
 *
 * 用途: /harness fixbugs 会先产出 `<标题>_bug分析报告.md`，Phase 0→8 的 Agent 都需要它。
 * 若交由主 Agent 逐个 Phase 手动注入，就又回到了"主 Agent 拼 prompt"的老路，
 * 因此改为约定式自动发现: 放进 Story 目录即全程可见，主 Agent 不需要感知。
 *
 * 约定文件名: `*bug分析报告.md` 或 `story-context.md`
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} 已格式化的 markdown 片段
 */
function readStoryContext (storyId) {
  const storyDir = path.join(PLANS_DIR, storyId)
  if (!fs.existsSync(storyDir)) return []

  let names
  try {
    names = fs.readdirSync(storyDir)
  } catch (e) {
    return []
  }

  const matched = names
    .filter(n => /bug分析报告\.md$/.test(n) || n === 'story-context.md')
    .sort()

  const contents = []
  for (const name of matched) {
    try {
      const raw = fs.readFileSync(path.join(storyDir, name), 'utf-8')
      const truncated = raw.length > STORY_CONTEXT_TRUNCATE_LIMIT
        ? raw.slice(0, STORY_CONTEXT_TRUNCATE_LIMIT) + '\n... (内容已截断，完整内容请读取源文件)'
        : raw
      contents.push(`### ${name}\n${truncated}`)
    } catch (e) {
      contents.push(`### ${name}\n(读取失败: ${e.message})`)
    }
  }
  return contents
}

/**
 * 构造「本 Story 原始输入」prompt 片段。
 *
 * 设计意图: 主 Agent 只把用户消息里的参数搬运进 story-input.json 就结束职责，
 * 不做任何分析。分析由需求分析师在 Phase 0 自行完成（fixbugs 模式下由它自己
 * 调用 tapd-bug-analyzer skill），这样中间推理始终留在同一个上下文里，
 * 不会因跨 Agent 传递而丢失。
 *
 * 只在 Phase 0 注入完整内容 —— 后续 Phase 需要的是分析结论（bug 分析报告 /
 * requirement-analysis.md），不是原始链接，注入全文只会挤占上下文。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string} markdown 片段，无内容时返回空串
 */
function buildStoryInputSection (storyId, targetPhase) {
  if (targetPhase !== 0) return ''

  const input = readStoryInput(storyId)
  if (!input) return ''

  if (input._parseError) {
    return `## 本 Story 原始输入\n⚠️ ${STORY_INPUT_FILE} 解析失败: ${input._parseError}\n请读取源文件 .codebuddy/plans/${storyId}/${STORY_INPUT_FILE} 自行确认，或向主 Agent 索要参数。\n`
  }

  const mode = input.mode === 'fixbugs' ? 'fixbugs' : 'run'
  const lines = [
    '## 本 Story 原始输入',
    `文件: .codebuddy/plans/${storyId}/${STORY_INPUT_FILE}`,
    '',
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    ''
  ]

  if (mode === 'fixbugs') {
    lines.push(
      '**模式: fixbugs（Bug 修复）**',
      '',
      '- 上述参数由主 Agent 原样搬运，**未经任何分析** —— Bug 分析是你的职责，不是主 Agent 的。',
      '- 你需要自行 `use_skill("tapd-bug-analyzer")`，用 sources 里的 tapdUrl / workspaceId / owner / statusFilter 拉取并分析缺陷。',
      '- Bug 分析报告**只记录事实**: 问题复述、复现步骤、代码定位、根因、责任方分类。',
      '  🚫 **不要写修复方案**（不写"应该怎么改"、不给伪代码/diff）—— 修复设计属于开发工程师。',
      '- 产出 `{标题}_bug分析报告.md` 后，再写 `requirement-analysis.md`：只引用 Bug 编号，不复制 Bug 正文。',
      ''
    )
  } else {
    lines.push(
      '**模式: run（新功能开发）**',
      '',
      '- 上述参数由主 Agent 原样搬运，未经分析。请按 sources 里实际存在的字段决定检索策略。',
      ''
    )
  }

  return lines.join('\n')
}

/**
 * 探测修复回路上下文（推进/调度到 Phase 3 时使用）
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {Object|null} fixLoopContext，无修复回路时返回 null
 */
function buildFixLoopContext (storyId, targetPhase) {
  if (targetPhase !== 3) return null

  const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
  if (!fs.existsSync(fixRequestPath)) return null

  try {
    const fixRequest = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8'))
    const fixVerificationPath = path.join(PLANS_DIR, storyId, 'fix-verification.json')
    const hasFixVerification = fs.existsSync(fixVerificationPath)
    return {
      active: true,
      round: fixRequest.round,
      maxRounds: fixRequest.maxRounds,
      sourcePhase: fixRequest.sourcePhase,
      issueCount: fixRequest.issues ? fixRequest.issues.length : 0,
      affectedFiles: fixRequest.affectedFiles || [],
      fixVerificationExists: hasFixVerification,
      fixContextFile: '.codebuddy/plans/' + storyId + '/fix-context.md',
      instruction: '本次审查为修复回路后的复查。请加载 fix-context.md + fix-request.json' +
        (hasFixVerification ? ' + fix-verification.json' : '') +
        '，逐项核对每个 FIX-XX 是否真正修复，聚焦复查 affectedFiles 的改动，确认未引入新问题。'
    }
  } catch (e) {
    // fix-request.json 解析失败 → 视为无修复回路上下文
    return null
  }
}

/**
 * 构造下一个 Phase 的 Agent Prompt 及其配套元信息。
 *
 * @param {Object} opts
 * @param {string} opts.storyId - Story ID
 * @param {number} opts.targetPhase - 即将进入的 Phase（Agent 要干活的那个 Phase）
 * @param {number} opts.summaryPhase - 用于取摘要的 Phase（通常是 targetPhase - 1）
 * @param {Object} [opts.summaryInfo] - 已加载的摘要对象；不传则自行加载
 * @returns {{
 *   agent: string|null,
 *   agentLabel: string|null,
 *   phaseInstruction: string|null,
 *   agentPrompt: string,
 *   contractFilesToLoad: string[],
 *   agentConstraints: string[],
 *   lessonsFromHistory?: string,
 *   metricsInsights?: string,
 *   fixLoopContext?: Object,
 *   expectedOutputs: string[]
 * }}
 */
function buildAgentPrompt (opts) {
  const { storyId, targetPhase } = opts
  const summaryPhase = opts.summaryPhase !== undefined ? opts.summaryPhase : targetPhase - 1

  const agentInfo = getPhaseAgent(targetPhase)

  // 上一 Phase 摘要
  const summaryInfo = opts.summaryInfo !== undefined
    ? opts.summaryInfo
    : contextRefresh.loadLatestSummary(storyId, summaryPhase)

  // 契约文件（下个 Phase 需要读的）
  const contractFilesToLoad = contextRefresh.getContractFiles(storyId, summaryPhase) || []
  const contractContents = readContractContents(storyId, contractFilesToLoad)

  // 历史教训 + 度量洞察
  const lessons = experience.getLessonsForPhase(targetPhase)
  const metricsInsights = experience.getMetricsInsights(targetPhase)

  // Story 级背景资料（如 bug 分析报告）
  const storyContext = readStoryContext(storyId)

  // 本 Story 原始输入（仅 Phase 0 注入完整内容）
  const storyInputSection = buildStoryInputSection(storyId, targetPhase)
  const storyMode = getStoryMode(storyId)

  // 修复回路上下文
  const fixLoopContext = buildFixLoopContext(storyId, targetPhase)

  // 本 Phase 应产出的文件（来自 PHASE_ARTIFACTS，Phase 2/5/6/7 无文件产出）
  const phaseArtifacts = PHASE_ARTIFACTS[targetPhase]
  const expectedOutputs = phaseArtifacts
    ? phaseArtifacts.artifacts.filter(a => a.fileName).map(a => a.fileName)
    : []
  const expectedDescriptions = phaseArtifacts
    ? phaseArtifacts.artifacts.map(a => a.fileName ? `${a.fileName} — ${a.description}` : a.description)
    : []

  // fixbugs 模式下 Phase 0 额外要求 Bug 分析报告（文件名含动态标题，无法进 PHASE_ARTIFACTS 固定表）
  // 同时进 expectedOutputs —— 主 Agent 靠它校验子 Agent 的产出物汇报，只写 descriptions 会漏检
  if (targetPhase === 0 && storyMode === 'fixbugs') {
    expectedOutputs.unshift('*bug分析报告.md')
    expectedDescriptions.unshift('{需求标题}_bug分析报告.md — Bug 事实记录（问题复述 + 复现步骤 + 代码定位 + 根因 + 责任方分类，不含修复方案）')
  }

  const promptLines = [
    `## Story: ${storyId} | Phase: ${targetPhase} (${getPhaseName(targetPhase)})`,
    '',
    agentInfo ? `## 你的角色\n${agentInfo.label} (注册名: ${agentInfo.agent})` : '',
    agentInfo ? `\n## 你的任务\n${agentInfo.instruction}` : '',
    '',
    storyInputSection,
    storyContext.length > 0 ? `## Story 背景资料\n${storyContext.join('\n\n')}\n` : '',
    '## 上一 Phase 摘要',
    summaryInfo ? summaryInfo.content : '(无摘要)',
    '',
    lessons ? `## 历史教训\n${lessons.trim()}\n` : '',
    metricsInsights ? `## 度量洞察\n${metricsInsights.trim()}\n` : '',
    fixLoopContext ? `## 修复回路上下文 (第 ${fixLoopContext.round}/${fixLoopContext.maxRounds} 轮)\n${fixLoopContext.instruction}\n受影响文件: ${fixLoopContext.affectedFiles.join(', ') || '(见 fix-request.json)'}\n` : '',
    '## 契约文件内容',
    contractContents.length > 0 ? contractContents.join('\n\n') : '(无契约文件)',
    '',
    expectedDescriptions.length > 0
      ? `## 产出要求\n${expectedDescriptions.map(d => `- ${d}`).join('\n')}\n产出目录: .codebuddy/plans/${storyId}/`
      : '',
    '',
    (storyMode === 'fixbugs' && targetPhase === 2)
      ? '## Bug 修复说明\nBug 分析报告只提供**事实**（问题复述 / 复现步骤 / 代码定位 / 根因），**不含修复方案**。\n修复怎么做由你设计: 先按报告的「代码定位」用 kb-query ∥ graphify 双源交叉验证确认真实改动点，再自行给出修复实现。\n'
      : '',
    '## 约束',
    ...AGENT_CONSTRAINTS.map(c => `- 🚫 ${c}`),
    '',
    '## 完成后',
    '汇报产出物的完整路径，不要自行推进 Phase。'
  ]

  const result = {
    agent: agentInfo ? agentInfo.agent : null,
    agentLabel: agentInfo ? agentInfo.label : null,
    phaseInstruction: agentInfo ? agentInfo.instruction : null,
    agentPrompt: promptLines.filter(Boolean).join('\n'),
    contractFilesToLoad,
    agentConstraints: AGENT_CONSTRAINTS,
    expectedOutputs,
    storyMode
  }

  if (lessons) result.lessonsFromHistory = lessons.trim()
  if (metricsInsights) result.metricsInsights = metricsInsights.trim()
  if (fixLoopContext) result.fixLoopContext = fixLoopContext

  return result
}

module.exports = {
  buildAgentPrompt,
  buildFixLoopContext,
  buildStoryInputSection,
  readContractContents,
  readStoryContext,
  AGENT_CONSTRAINTS,
  CONTRACT_TRUNCATE_LIMIT,
  STORY_CONTEXT_TRUNCATE_LIMIT
}
