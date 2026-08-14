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
  getStoryMode,
  detectFigmaSource,
  readStateFile
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
 * 读取 Phase 1 产出的 Figma 组件映射文档（figma-component-map.md），在 Phase 2 注入 prompt。
 *
 * 历史教训: 仅向前端 agent 注入 figmaLink 链接不足以让它对齐设计稿 —— 链接存在 ≠ 样式对齐。
 * 必须同时提供: ①「按设计稿实现」显式指令 ② 设计稿的视觉规范（色值/间距/字体，即组件映射）。
 * 本函数把 Phase 1 产出的组件映射（若有）注入 Phase 2 前端 agent 的 prompt，补齐第②项。
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} 已格式化的 markdown 片段，无组件映射时返回空数组
 */
function readFigmaDesignMap (storyId) {
  const mapPath = path.join(PLANS_DIR, storyId, 'figma-component-map.md')
  if (!fs.existsSync(mapPath)) return []
  try {
    const content = fs.readFileSync(mapPath, 'utf-8')
    const truncated = content.length > CONTRACT_TRUNCATE_LIMIT
      ? content.slice(0, CONTRACT_TRUNCATE_LIMIT) + '\n... (内容已截断，完整内容请读取源文件)'
      : content
    return [
      '## Figma 组件映射（Phase 1 产出，开发必须遵循）',
      '',
      '> 以下映射把 Figma 设计稿的视觉规范翻译为开发规范，**严格按此实现样式**，不要使用默认/直觉样式。',
      '```',
      truncated,
      '```',
      ''
    ]
  } catch (e) {
    return [`## Figma 组件映射\n(读取失败: ${e.message})\n`]
  }
}

/**
 * 构造「有 Figma 设计稿时必须对齐」的开发阶段指令片段。
 *
 * 仅在 Phase 2（前端开发）注入。核心诉求: 有 Figma 链接时，前端 agent 必须亲自
 * 用 Figma MCP 拉取完整设计内容实现，而不是吃 Phase 0/1 转译的二手 token 摘要
 * （色值/间距/字体只是设计稿的极小部分，会丢失大量细节）。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string[]} markdown 行，无 Figma 或非 Phase 2 时返回空数组
 */
function buildFigmaAlignInstruction (storyId, targetPhase) {
  if (targetPhase !== 2) return []
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []

  return [
    '## 🎨 Figma 设计稿对齐（强制 — 必须用 Figma MCP 拉取完整设计内容）',
    '',
    '**本 Story 已注入 Figma 设计稿链接，UI 必须严格对齐设计稿，禁止使用 ElementUI/组件库默认样式或自行发挥。**',
    '',
    '**硬性要求：每个 UI 任务都必须亲自调用 Figma MCP 拉取该节点的完整设计内容，不得依赖二手摘要/截图/组件映射推测。**',
    '',
    '对每个 UI 任务，必须：',
    '1. 从 task 的 `figmaLink` 提取 node-id，调用 Figma MCP 拉取该节点的**完整设计上下文**：',
    '   - `get_design_context` → 拿完整的布局/层级/样式/文案（不要只看截图）',
    '   - `get_screenshot` → 作为视觉核对基准',
    '   - 设计稿中的嵌套组件、状态变体（hover/disabled/空态/加载态）、交互细节，一律以 `get_design_context` 返回为准',
    '2. **100% 还原** — 尺寸、颜色、字号、字重、间距、圆角、边框、文案、层级、状态变体与设计稿一致',
    '3. 样式使用 CSS class（禁用内联 style），动态样式用 `:class`；深度选择器统一用 `::v-deep`（禁止 /deep/，避免 SCSS 编译失败）',
    '4. 完成后再输出「Figma 设计稿确认」清单，逐条核对对齐项（必须附上已调用的 node-id）',
    '',
    '> `figma-component-map.md`（若存在）仅作辅助参考，**不能替代** Figma MCP 的完整拉取；',
    '> 与 MCP 返回不一致时，以 MCP 完整设计上下文为准。',
    ''
  ]
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

  // Figma 解析指令 —— 不分模式注入。
  // 门控开关（state.hasFigmaDesign）只管「是否强制校验清单完整性」，run 开 fixbugs 关；
  // 而「有 Figma 链接就要去解析」两种模式都成立，所以这里直接看 figmaUrls 而非门控开关。
  lines.push(...buildFigmaInstruction(storyId, input))

  return lines.join('\n')
}

/**
 * 构造 Figma 解析指令片段
 *
 * 与 fixbugs 注入 `tapd-bug-analyzer` 对称: 检测到设计稿链接就显式点名要调用的
 * skill，避免子 Agent 拿到链接却不知道该走哪条解析路径。
 *
 * @param {string} storyId - Story ID
 * @param {Object} input - 已解析的 story-input.json
 * @returns {string[]} markdown 行，无 Figma 链接时返回空数组
 */
function buildFigmaInstruction (storyId, input) {
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []

  const state = readStateFile(storyId)
  const gateEnabled = state?.hasFigmaDesign === true

  return [
    `**🌐 检测到 ${detected.urls.length} 个 Figma 设计稿链接**`,
    '',
    '- 必须调用 `use_skill("figma-to-component-map")` 解析设计稿，**禁止凭链接猜测 UI 结构**。',
    '- 前置条件: Figma 桌面端需处于运行状态并已打开该文件；未运行则如实告知用户并停止，不要退回缓存数据。',
    `- 产出 \`figma-frame-inventory.json\`：覆盖每个 page / dialog / drawer 的完整 node 链接。`,
    gateEnabled
      ? '- ⚠️ 本 Story 已开启 Figma 门控，Phase 0→1 会校验该清单完整性，缺失或不完整将阻断推进。'
      : '- 本 Story 未开启 Figma 强制门控（fixbugs 模式），但涉及 UI 的改动仍应按清单核对设计规范。',
    ...detected.urls.map(u => `  - ${u}`),
    ''
  ]
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

  // Figma 组件映射（Phase 2 前端开发时注入 Phase 1 产出的设计规范）
  const figmaDesignMap = readFigmaDesignMap(storyId)
  // Figma 对齐指令（Phase 2 前端开发时强制要求按设计稿实现）
  const figmaAlignInstruction = buildFigmaAlignInstruction(storyId, targetPhase)

  // 修复回路上下文
  const fixLoopContext = buildFixLoopContext(storyId, targetPhase)

  // 本 Phase 应产出的文件（来自 PHASE_ARTIFACTS，Phase 2/5/6/7 无文件产出）
  // optional 产出物（原型/Figma）按条件产出，不列入 expectedOutputs——主 Agent 靠该
  // 列表校验子 Agent 汇报，列进去会让「按条件不产出」被误判为漏产。
  const phaseArtifacts = PHASE_ARTIFACTS[targetPhase]
  const requiredArtifacts = phaseArtifacts
    ? phaseArtifacts.artifacts.filter(a => !a.optional)
    : []
  const expectedOutputs = requiredArtifacts.filter(a => a.fileName).map(a => a.fileName)
  const expectedDescriptions = requiredArtifacts
    .map(a => a.fileName ? `${a.fileName} — ${a.description}` : a.description)

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
    figmaAlignInstruction.length > 0 ? figmaAlignInstruction.join('\n') : '',
    figmaDesignMap.length > 0 ? figmaDesignMap.join('\n') : '',
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
  readFigmaDesignMap,
  buildFigmaAlignInstruction,
  AGENT_CONSTRAINTS,
  CONTRACT_TRUNCATE_LIMIT,
  STORY_CONTEXT_TRUNCATE_LIMIT
}
