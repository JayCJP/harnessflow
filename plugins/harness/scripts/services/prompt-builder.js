#!/usr/bin/env node
/**
 * prompt-builder.js — Agent Prompt 构造服务，prompt 的唯一出口
 *
 * 职责:
 *   - buildAgentPrompt: 把「下一个 Phase 的 Agent 需要知道的一切」组装成一段完整 prompt
 *     （角色与约束 / 上一 Phase 摘要 / 契约文件路径 / Story 背景 / 历史教训 / 修复回路上下文）
 *   - buildFixLoopContext: 修复回路场景追加 BLOCKER 清单与回退轮次上下文
 *   - 提供 Figma 对齐指令与任务规划 Figma 指令等 Phase 专属片段
 *
 * 用法:
 *   作为模块引用:
 *     const { buildAgentPrompt } = require('./services/prompt-builder')
 *
 * 使用场景:
 *   - commands/dispatch.js 决定该 Spawn 哪个 Agent 时，一并产出 agentPrompt，
 *     使主 Agent 只需原样注入，无需自行判断该拼什么
 *   - commands/advance-phase.js Phase 推进成功后构造下一 Phase 的 Agent prompt
 *   - 内部依赖 services/context-refresh.js 取摘要与契约清单、services/experience.js 取历史教训
 *   - 回归测试 __tests__/fixbugs-regression.test.js、figma-detection.test.js 直接断言其输出
 *
 * 说明:
 *   - 设计原则 — 单一信源: 历史上 prompt 有两个来源（advance-phase.js 的 suggestedAgentPrompt 与
 *     dispatcher Agent 的 instruction/inputFiles），主 Agent 面对两个都自称权威的来源只能自行拼接，
 *     而「拼接」就是判断——判断权回到主 Agent 手里，正是流程失控的成因。
 *     本模块是 prompt 的唯一出口: advance-phase.js 与 dispatch.js 都调用它，
 *     主 Agent 只做原样注入，不做任何拼装
 *   - 本模块为纯只读: 只读产出物文件，不写任何文件、不改状态
 *   - v2（需求10）: 不再内联截断契约内容——截断会导致关键信息（AC 全表、task-dag 全量文件、
 *     跨仓字段）丢失，让下游 Agent 基于残缺信息越做越错。改为只给完整文件路径，
 *     token 由「内联截断」让位给「按需读取」，信息完整性不再受注入上限约束
 *   - v3 token 优化（2026-09）: v2 把成本从 prompt 挪到了工具调用，于是「让谁去读什么」
 *     成了新的成本项。三处收敛，判据都是「这个 Phase 到底用不用得上」:
 *       1. Story 背景资料（bug 分析报告，实测真实项目 10.5~27.5 KB）只在 Phase 0-1 注入。
 *          原实现无 Phase 过滤，Phase 5/6/7 的发布助手也被要求去读它 —— 做 git commit /
 *          知识库更新 / 云端部署根本用不上。报告在 Phase 0-1 已消化进契约文件。
 *       2. AGENT_CONSTRAINTS 从 5 条减到 2 条，删掉的 3 条已在 6/6 个 agent .md 里写明
 *          （agent .md 是子 Agent 的 system prompt，重复一遍不会更被遵守，只是重复计费）。
 *       3. 契约文件路径只打一次（原来相对 + 绝对各打一遍）。
 *     实测口径: agentPrompt 本身只占单次 spawn payload 的 7~17%（agent .md 是它的 6~13 倍），
 *     所以真正的收益来自「少一次大文件读」，不是「prompt 少几个字」。
 *
 * @module prompt-builder
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
  readStateFile,
  getMaxFixRounds,
  getTasksRequiringFigma,
  readJsonArtifact,
  TASK_DAG_JSON_FILE,
  loadRepos
} = require('../lib/state')

const contextRefresh = require('./context-refresh')
const experience = require('./experience')

/**
 * 把 Windows 反斜杠路径转为正斜杠形式（仅用于**注入 prompt / 输出给人与 LLM 看**的路径）
 *
 * 为什么：会话 UI 的 markdown 渲染层会把 `\.` 当转义序列吃掉
 * （`D:\repo\.codebuddy` 渲染成 `D:\repo.codebuddy`），实跑中曾让用户误判
 * 「脚本拼接的路径错了」并中断流程。正斜杠路径在任何渲染层都原样保留，
 * 且 Node / PowerShell / Windows API 均兼容正斜杠 —— 一次性消除歧义。
 * 注意：仅用于输出文本；fs 实际读写仍可用原始反斜杠路径（两者等价）。
 *
 * @param {string} p - 任意路径
 * @returns {string} 正斜杠形式的路径
 */
function toPosix (p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * Agent 通用约束（所有 Phase 的 Agent 都必须遵守）
 *
 * 只保留 agent 定义文件里**没有**覆盖到的条目 —— 逐条核对 agents/*.md 的结果:
 *   - 禁止改 e2e-state.json / dev-pass.json → 6/6 个 agent .md 都已写明 → 已删
 *   - 由主 Agent 调 advance-phase.js 推进 phase → 6/6 都已写明 → 已删
 *   - 只产出本 Phase 产出物 + 汇报路径 → 本 prompt 末尾「## 完成后」段已单独写 → 已删
 *   - 禁止 shell 绕过写状态文件 → 只有 1/6（前端开发工程师）写了 → **保留**
 *   - kb-query + graphify 双源交叉验证 → 5/6 写了，发布助手 0 处 → **保留**（补它的缺口）
 *
 * 每条约束都会在 8 次 spawn 里各计费一次，而重复一遍并不会让已经写在 system prompt
 * 里的规则更被遵守 —— 所以这里的判据是「agent .md 有没有」，不是「重要不重要」。
 */
const AGENT_CONSTRAINTS = [
  '禁止通过 shell 命令绕过限制写 e2e-state.json / dev-pass.json（hook 会拦截并记录违规）',
  '查找/定位代码时必须使用 kb-query + graphify 双源交叉验证，禁止仅用 Explore agent 或仅文本搜索',
  // P3-2（2026-09）: 对齐 buildFigmaAlignInstruction 对 Figma MCP 的「停下上报」语义 ——
  // 实跑中 Bash/graphify 失败率约 35%，子 Agent 静默降级到文本搜索摸黑穷举（48% 零命中），
  // 失败被掩盖而非暴露。必须上报主 Agent，由主 Agent 决定替代路径
  'graphify / Bash 检索失败必须停下上报主 Agent，禁止静默降级到纯文本搜索硬做'
]

/**
 * 读取契约文件清单并格式化为 prompt 片段。
 *
 * v2（需求10）：不再内联截断契约内容 —— 截断会导致关键信息丢失（AC 全表、
 * task-dag 全量文件、跨仓字段等被砍掉），让下游 Agent 基于残缺信息越做越错。
 * 改为只给出**完整文件路径**，由 Agent 自行读取完整内容。token 由「内联截断」
 * 让位给「按需读取」，信息完整性不再受注入上限约束。
 *
 * v3：只打印一次路径。原实现相对路径 + 绝对路径各打一遍，同一个位置说两次，
 * 既不增加信息也让 Agent 需要判断该用哪个。统一给绝对路径（Agent 直接可用，
 * 不依赖它的当前工作目录）。
 *
 * @param {string} storyId - Story ID
 * @param {string[]} contractFiles - 契约文件路径列表（形如 .codebuddy/plans/<id>/xxx.json）
 * @returns {string[]} 已格式化的 markdown 片段（每个文件一条路径提示）
 */
function readContractContents (storyId, contractFiles) {
  const lines = []
  for (const cf of contractFiles || []) {
    const cfPath = path.join(PLANS_DIR, storyId, cf.replace(/^\.codebuddy\/plans\/[^/]+\//, ''))
    if (!fs.existsSync(cfPath)) continue
    lines.push(`- \`${toPosix(cfPath)}\``)
  }
  return lines
}

/**
 * 读取 Story 级背景资料文件清单（bug 分析报告 / story-context.md），注入到 prompt。
 *
 * v2（需求10）：不再内联截断背景资料（如 bug 分析报告可能很长，截断后丢失
 * 代码定位/根因等关键事实），改为只给文件路径，Agent 自行读取完整内容。
 *
 * v3：**只在 Phase 0-1 注入**。原实现无 Phase 过滤，Phase 1~7 全都被要求去读同一份
 * 报告 —— 实测真实项目里 bug 分析报告 10.5~27.5 KB（约 3.5~9.2K token），
 * 而 Phase 5/6/7 的发布助手在做 git commit / 知识库更新 / 云端部署，压根用不上它。
 * 报告的价值在 Phase 0（产出事实）与 Phase 1（据此拆 task）就已经被消化进
 * requirement-analysis.md / acceptance-criteria.json / task-dag.json，
 * 后续 Phase 读这些产出物即可，不必回头读原始报告。
 * （Phase 0 通常还没有报告，返回空数组；重试/修复回路场景下报告已存在则仍注入。）
 *
 * 约定文件名: `*bug分析报告.md` 或 `story-context.md`
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase；> 1 时返回空数组
 * @returns {string[]} 已格式化的 markdown 片段（每个文件一条路径提示）
 */
function readStoryContext (storyId, targetPhase) {
  if (typeof targetPhase === 'number' && targetPhase > 1) return []

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
    contents.push(`- \`${toPosix(path.join(storyDir, name))}\``)
  }
  return contents
}

/**
 * 读取 Figma Frame 清单中的 designSpec（每个 frame 的设计规格摘要），在 Phase 2 注入 prompt。
 *
 * 合并后（figma-component-map.md 已删除）：frame-inventory.json 的每个 frame 含可选 designSpec
 * 字段（色值/间距/字体/布局等设计规格摘要）。开发 agent 以 Figma MCP 完整拉取为准，
 * designSpec 仅作辅助参考，避免全量探索设计稿。
 *
 * 只在 Phase 2 注入 —— 与 buildFigmaAlignInstruction 的 Phase 过滤对齐。此前无该过滤，
 * 导致代码审查（看 git diff）、功能测试（跑 AC）、发布（commit / 部署）的 prompt
 * 也都带着色值/间距/圆角这类设计规格，纯属噪音（v3 原则：这个 Phase 到底用不用得上）。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase；非 2 时返回空数组
 * @returns {string[]} 已格式化的 markdown 片段，无 designSpec 或非 Phase 2 时返回空数组
 */
function readFigmaDesignSpec (storyId, targetPhase) {
  if (targetPhase !== 2) return []

  const invPath = path.join(PLANS_DIR, storyId, 'figma-frame-inventory.json')
  if (!fs.existsSync(invPath)) return []
  try {
    const inv = JSON.parse(fs.readFileSync(invPath, 'utf-8'))
    const withSpec = (inv.frames || []).filter(f => f.designSpec)
    if (withSpec.length === 0) return []
    const lines = [
      '## Figma 设计规格摘要（frame-inventory 中的 designSpec，辅助参考）',
      '',
      '> 设计稿完整内容以你通过 Figma MCP 拉取为准；以下仅列出 Phase 1 任务规划阶段已提取的关键规格，减少全量探索。',
      ''
    ]
    for (const f of withSpec) {
      lines.push(`- **${f.name}** (node ${f.id}): ${f.designSpec}`)
    }
    lines.push('')
    return lines
  } catch (e) {
    return [`## Figma 设计规格摘要\n(读取失败: ${e.message})\n`]
  }
}

/**
 * 构造「有 Figma 设计稿时必须对齐」的开发阶段指令片段。
 *
 * 仅在 Phase 2（前端开发）注入。核心诉求: 有 Figma 链接时，前端 agent 必须亲自
 * 用 Figma MCP 拉取完整设计内容实现（设计稿内容由 agent 自行获取，不在 prompt 转译）。
 * 因此 prompt 只保留**关键指令**（对齐设计稿 + MCP 不可用停下），删去冗长的样式还原
 * 细节（CSS class / ::v-deep / 逐条核对等）——那些 agent 自会从 Figma MCP 获取，
 * 写在 prompt 里只会常驻占用上下文（原为 924 字符固定文案，多轮 fix-loop 反复计费）。
 *
 * v3（2026-09）: 逐 task 的 node-id 清单也不再内联。task-dag.json 是 Phase 2 的契约文件
 * （`context-refresh.js:getContractFiles` 对 nextPhase=2 必列），prompt 里已强制要求
 * 「逐个读取契约文件、不要依赖摘要」，因此 node 清单是 agent 无论如何都会读到的数据的
 * 第二份拷贝 —— UI task 多时（每 task 一行含完整链接）反而是 fix-loop 里最贵的重复段。
 * 保留的是**行为要求**（按 task 精准拉取、不做全量探索）与字段指路。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string[]} markdown 行，无 Figma 或非 Phase 2 时返回空数组
 */
function buildFigmaAlignInstruction (storyId, targetPhase) {
  if (targetPhase !== 2) return []
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []
  // 需求要求 Figma，但本 Story 没有任何需要 Figma 的 task（纯逻辑改动，无 UI）→ 不强求对齐
  const figmaTasks = getTasksRequiringFigma(storyId)
  if (figmaTasks.length === 0) return []

  return [
    '## 🎨 Figma 设计稿对齐（强制）',
    '',
    '- UI 必须严格对齐设计稿，禁止使用默认/直觉样式。',
    '- 每个 UI 任务**自行调用 Figma MCP** 拉取该节点的完整设计上下文（`get_design_context` 为主，`get_screenshot` 为辅）——设计稿内容以 MCP 返回为准，不要凭截图/摘要推测。',
    '- **开工前先校验 Figma MCP 可用性**；若无法使用（工具不可用 / Figma 桌面端未运行 / 返回错误）——**立即停下当前任务并上报主 Agent，禁止硬做**（设计稿未对齐就开发会导致大量返工）。',
    `- **精确节点清单在 \`task-dag.json\` 里**: 本 Story 有 ${figmaTasks.length} 个 task 需要 Figma，逐个读 task 的 \`figmaRefs[]\`（\`nodeId\` + \`link\`，旧数据回落 \`figmaNodeId\`），按 task 精准拉取对应 node，**不要全量探索整个设计稿文件**。`,
    ...(detected.urls.length > 0 ? ['- 设计稿文件链接：', ...detected.urls.map(u => `  - ${u}`)] : []),
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
    return `## 本 Story 原始输入\n⚠️ ${STORY_INPUT_FILE} 解析失败: ${input._parseError}\n请读取源文件 ${toPosix(path.join(PLANS_DIR, storyId, STORY_INPUT_FILE))} 自行确认，或向主 Agent 索要参数。\n`
  }

  const mode = input.mode === 'fixbugs' ? 'fixbugs' : 'run'
  const lines = [
    '## 本 Story 原始输入',
    `请读取 ${toPosix(path.join(PLANS_DIR, storyId, STORY_INPUT_FILE))} 获取完整参数（含 TAPD/原型/Figma 链接等）——此处不内联全文，避免占上下文。`,
    '',
  ]

  if (mode === 'fixbugs') {
    lines.push(
      '**模式: fixbugs（Bug 修复）**',
      '',
      '- 上述参数由主 Agent 原样搬运，**未经任何分析** —— Bug 分析是你的职责，不是主 Agent 的。',
      '- 你需要自行 `use_skill("tapd-bug-analyzer")`，用 sources 里的 tapdUrl / workspaceId / owner / statusFilter 拉取并分析缺陷。',
      '- Bug 分析报告**只记录事实**: 问题复述、复现步骤、代码定位、根因、责任方分类。',
      '  **不要写修复方案**（不写"应该怎么改"、不给伪代码/diff）—— 修复设计属于开发工程师。',
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

  // Figma 处理不在 Phase 0（需求分析阶段）——frame-inventory 由 Phase 1 任务规划师拆 task 时产出。
  // 见 buildTaskPlannerFigmaInstruction（Phase 1 注入）。

  return lines.join('\n')
}

/**
 * 构造「任务规划阶段处理 Figma」指令片段（Phase 1 注入）。
 *
 * Figma 处理从 Phase 0 移到 Phase 1：需求分析师只做需求分析（不拉设计稿），
 * 任务规划师拆 task 时才处理 Figma——只针对要拆的组件精确拉取，产出
 * figma-frame-inventory.json，并为每个 UI task 绑定 figmaRefs。这样真正"按需拉稿"，
 * 避免需求阶段猜测性全量/半量拉取（省 token + 更精确）。
 *
 * @param {string} storyId - Story ID
 * @returns {string[]} markdown 行，无 Figma 链接时返回空数组
 */
function buildTaskPlannerFigmaInstruction (storyId) {
  const detected = detectFigmaSource(storyId)
  if (!detected.hasFigma) return []

  const state = readStateFile(storyId)
  const gateEnabled = state?.hasFigmaDesign === true

  return [
    `**🌐 检测到 ${detected.urls.length} 个 Figma 设计稿链接（任务规划阶段处理）**`,
    '',
    '- 拆 task 前调用 `use_skill("figma-to-component-map")` 处理设计稿，**禁止凭链接猜测 UI 结构**。',
    '- 前置条件: Figma 桌面端需处于运行状态并已打开该文件；未运行则如实告知用户并停止，不要退回缓存数据。',
    `- 只针对**要拆分的 task 涉及的文件/组件**产出 \`figma-frame-inventory.json\`（覆盖每个相关 page / dialog / drawer 的完整 node 链接），**不要全量扫描所有页面**——拆到哪些组件就拉哪些，避免重复分析浪费 token。`,
    '- **只用 `get_metadata` 扫帧结构（id/name/type/link/rect），禁止调用 `get_design_context` / `get_screenshot`**——设计稿完整内容（色值/间距/字体/布局/交互）由开发工程师 Phase 2 拉取，你不拉，避免重复调用浪费 token。',
    '- 为每个 UI task 绑定 `figmaRefs: [{ nodeId, link }]` 精确配对（nodeId 用 `:`，link 用 `-`），前端开发工程师据此一次精准拉取设计稿。',
    gateEnabled
      ? '- ⚠️ 本 Story 已开启 Figma 门控，Phase 1→2 会校验 frame-inventory 完整性及 task 的 figmaNodeId 命中清单，缺失或不完整将阻断推进。'
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
    // 修复预算按失败源独立计数（code-review / test 各 2 次），maxRounds 取对应预算
    const sourcePhase = fixRequest.sourcePhase === 4 ? 4 : 3
    const maxRounds = getMaxFixRounds(storyId, sourcePhase)
    return {
      active: true,
      round: fixRequest.round,
      maxRounds,
      sourcePhase: fixRequest.sourcePhase,
      issueCount: fixRequest.issues ? fixRequest.issues.length : 0,
      affectedFiles: fixRequest.affectedFiles || [],
      fixVerificationExists: hasFixVerification,
      fixContextFile: toPosix(path.join(PLANS_DIR, storyId, 'fix-context.md')),
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
 * 读取 task-dag.json 的 batch 分组与任务列表（P1-1）
 *
 * schema 中 batches 为可选数组: [{ batchId: number, taskIds: string[], description?: string }]。
 * 缺省（无 batches 字段）= 单批，全部 tasks 作为一个批次 —— 与旧数据完全向后兼容。
 *
 * @param {string} storyId - Story ID
 * @returns {{ batches: Array<{batchId:number, taskIds:string[], description?:string}>, tasks: Array<Object> }}
 *   解析结果；task-dag 不存在或解析失败时返回 { batches: [], tasks: [] }
 */
function readTaskBatches (storyId) {
  const empty = { batches: [], tasks: [] }
  try {
    const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
    if (!taskData || taskData._parseError || !Array.isArray(taskData.tasks)) return empty
    const batches = Array.isArray(taskData.batches) ? taskData.batches : []
    return { batches, tasks: taskData.tasks }
  } catch (e) {
    return empty
  }
}

/**
 * 构造 Phase 2 batch 级任务范围片段（P1-1: 消除主 Agent 手写 batch prompt 的动机）
 *
 * 输出「本批次目标仓 + task id 清单 + files[] 白名单」。契约文件仍只给路径 ——
 * task 的 description / acceptanceCriteria 等正文以 task-dag.json 为唯一信源，
 * 本片段不内联（遵守 v2「不再内联截断契约内容」的决定）。
 *
 * @param {string} storyId - Story ID
 * @param {number} batchId - 批次 ID（task-dag.json 的 batches[].batchId）
 * @returns {{ lines: string[], taskIds: string[], repos: string[], totalBatches: number }|null}
 *   无该批次或 task-dag 不可读时返回 null
 */
function buildBatchScopeSection (storyId, batchId) {
  const { batches, tasks } = readTaskBatches(storyId)
  if (batches.length === 0) return null
  const batch = batches.find(b => b.batchId === batchId)
  if (!batch) return null

  const batchTasks = (batch.taskIds || [])
    .map(id => tasks.find(t => t.id === id))
    .filter(Boolean)

  // 目标仓归并（project 缺省为主仓；跨仓 task 带 project/repoPath）。
  // 主仓用 repos.json 里的**真实名称**而非占位符 —— 子 Agent 会拿这个名称去 repos.json
  // 查路径，占位符（如「主仓(primary)」）在 repos.json 里查不到对应键，等于给了个假名字
  let primaryName = 'primary'
  try {
    const repos = loadRepos(storyId)
    if (repos && repos.primary) primaryName = repos.primary
  } catch (e) { /* repos 不可读时回落字面量 */ }

  const repoSet = new Set()
  for (const t of batchTasks) {
    repoSet.add(t.project || primaryName)
  }

  const lines = [
    `## 本批次任务范围（batch ${batchId}/${batches.length}${batch.description ? `: ${batch.description}` : ''}）`,
    '',
    `- 本批次目标仓: ${[...repoSet].join(', ')}`,
    `- 本批次 task 清单: ${batchTasks.map(t => `${t.id}(${t.title})`).join('、')}`,
    '- 本批次 files 白名单（只允许修改以下范围，dev-pass 据此限域）:'
  ]
  for (const t of batchTasks) {
    for (const f of (t.files || [])) {
      lines.push(`  - ${t.id}: ${f}${t.project ? ` (仓: ${t.project}${t.repoPath ? `: ${toPosix(t.repoPath)}` : ''})` : ''}`)
    }
  }
  lines.push('- 其余批次与本批次无交集，不要实现别的批次的 task；task 详情（description / AC 关联）以 task-dag.json 契约文件为准。')
  lines.push('')

  return { lines, taskIds: batchTasks.map(t => t.id), repos: [...repoSet], totalBatches: batches.length }
}

/**
 * 构造增量修复的窄上下文段（P1-2: scope=incremental 时注入）
 *
 * 只列被点名的修复契约文件（fix-request.json / fix-context.md / fix-verification.json），
 * 不注入 Story 背景资料与 Figma 设计摘要 —— 修复场景需要的是「改哪里、为什么、怎么核对」，
 * 不需要重新消化整份需求（D5: 改 2 行 description 曾耗约 40 次工具调用重读 688 行报告）。
 *
 * @param {string} storyId - Story ID
 * @returns {string} markdown 片段，无可读文件时返回空串
 */
function buildIncrementalFixSection (storyId) {
  const storyDir = path.join(PLANS_DIR, storyId)
  const candidates = [
    { file: 'fix-request.json', desc: '本轮修复请求（affectedFiles + issue 清单）' },
    { file: 'fix-context.md', desc: '修复回路上下文（上轮问题与修复核对指引）' },
    { file: 'fix-verification.json', desc: '上一轮修复核对结果（若存在，先看上轮改了什么）' }
  ]
  const lines = ['## 增量修复上下文（窄范围）', '', '本次为限域修复，只处理被点名的问题，不要重新全量消化需求文档：']
  let found = false
  for (const c of candidates) {
    const p = path.join(storyDir, c.file)
    if (fs.existsSync(p)) {
      lines.push(`- \`${toPosix(p)}\` — ${c.desc}`)
      found = true
    }
  }
  if (!found) return ''
  lines.push('')
  return lines.join('\n')
}

/**
 * 构造跨仓检索入口片段（P1-3: 修复跨仓检索三重失效，D2）
 *
 * 实跑诊断: graphify-out/ 与 .docs/llm-knowledge/ 均按子 Agent cwd 解析，而 cwd 停在主仓，
 * 目标仓的图谱/知识库永远查不到；无知识库的仓还会被摸黑穷举关键词（48% 检索空转）。
 * 本片段把「正确的检索姿势」由脚本逐仓下发:
 *   - 绝对仓路径（不依赖子 Agent cwd）
 *   - 该仓 graphify-out/graph.json 与 .docs/llm-knowledge/ 的存在性（脚本侧预判，
 *     子 Agent 不必再探测 —— 主 Agent 本来就在跑的 Test-Path 固化到 prompt）
 *   - graphify 的标准用法（主仓给全量命令，跨仓给 `cd` + query 的最小样例）
 *   - 无知识库的仓明写「只走 graphify + 源码精读，不要尝试 kb-query」
 *
 * 默认在所有检索相关阶段（Phase 0 需求分析 / 1 任务规划 / 2 开发）注入，**含单仓 Story** ——
 * 约束里写了「必须用 kb-query + graphify 双源交叉验证」，但只讲要求不给用法时，
 * 子 Agent 依旧会退回自己熟悉的文本搜索。主仓排在最前: 它是子 Agent 的 cwd，
 * 也是绝大多数检索目标所在。
 *
 * @param {string} storyId - Story ID
 * @param {number} targetPhase - 目标 Phase
 * @returns {string[]} markdown 行，无需注入时返回空数组
 */
function buildRepoSearchEntries (storyId, targetPhase) {
  if (![0, 1, 2].includes(targetPhase)) return []
  let repos
  try {
    repos = loadRepos(storyId)
  } catch (e) {
    return []
  }
  if (!repos || !repos.repos) return []

  // 主仓在前（子 Agent 的 cwd），其余非 primary 仓按 repos.json 声明顺序在后
  const primary = repos.primary
  const names = [primary, ...Object.keys(repos.repos).filter(n => n !== primary)]
    .filter(n => repos.repos[n])

  const lines = [
    '## 🔎 代码检索入口（按仓下发，图谱/知识库存在性已由脚本预判）',
    '',
    '> graphify 与知识库均按 **cwd** 解析：检索非主仓必须先 `cd` 到该仓的绝对路径，',
    '> 在主仓直接跑永远查不到目标仓的图谱/知识库（实跑 48% 检索空转的根因）。',
    ''
  ]
  for (const name of names) {
    const absPath = repos.repos[name]
    const isPrimary = name === primary
    const repoPath = toPosix(absPath)
    const graphOk = fs.existsSync(path.join(absPath, 'graphify-out', 'graph.json'))
    const kbOk = fs.existsSync(path.join(absPath, '.docs', 'llm-knowledge'))

    lines.push(`### ${name}${isPrimary ? '（主仓，即当前工作目录）' : ''} → \`${repoPath}\``)
    lines.push(`- graphify 图谱: ${graphOk ? '✅ 存在 (graphify-out/graph.json)' : '❌ 不存在（先用下方命令建图；建不出来就退回源码精读并上报，不要硬 query）'}`)
    if (kbOk) {
      lines.push('- 知识库: ✅ 存在 (.docs/llm-knowledge/)，可用 kb-query 检索业务域文档')
    } else {
      lines.push('- 知识库: ❌ 不存在 —— **该仓只走 graphify + 源码精读，不要尝试 kb-query**')
    }

    // 命令分行给出，不写成 `cd ... && graphify ...`:
    // `&&` 是 PowerShell 7+ 语法，Windows 默认的 PowerShell 5.1 会直接报
    // "The token '&&' is not a valid statement separator" —— 而子 Agent 的 tools 里就有 PowerShell。
    // 这段样例本就是为了修「检索失败率 ~35%」，样例自身不该再引入一次失败
    if (!graphOk) {
      // 图谱不存在时还教 `graphify query` 是自相矛盾 —— 没有 graph.json 必然失败。
      // 先给建图命令；建不出来就按约束停下上报，而不是退回关键词穷举
      lines.push('- 建图命令（Bash；图谱生成后才能 query）:')
      lines.push('  ```bash')
      if (!isPrimary) lines.push(`  cd "${repoPath}"`)
      lines.push('  graphify .           # 首次: 全量抽取建图')
      lines.push('  graphify update .    # 已有图谱: 增量更新')
      lines.push('  ```')
      lines.push('- 建图不可用（CLI 缺失 / 报错）→ **停下上报主 Agent**，不要退回纯文本搜索硬做')
    } else if (isPrimary) {
      // 主仓给全量命令：子 Agent 在这干活最多，一次说清能力边界比让它自己试更省调用
      lines.push('- 标准用法（Bash）:')
      lines.push('  ```bash')
      lines.push('  graphify query "<模块/关键词>"')
      lines.push('  ```')
      lines.push('- 其他命令: `graphify path "<模块A>" "<模块B>"`（两者关联路径）、`graphify explain "<概念>"`（单节点详解）、`graphify query "..." --budget 1500`（限制返回 token）')
    } else {
      lines.push('- 标准执行样例（在**同一次** Bash 调用中依次执行）:')
      lines.push('  ```bash')
      lines.push(`  cd "${repoPath}"`)
      lines.push('  graphify query "<模块/关键词>"')
      lines.push('  ```')
    }
    lines.push('')
  }
  return lines
}

/**
 * 构造修复回路的 spawn prompt（P1-2: 收编 advance-phase.js --fix-loop 的手写 prompt 体）
 *
 * 原先该 prompt 在 advance-phase.js 内手写拼装，是「主 Agent 手写 prompt」缺陷（D1/D5）的
 * 脚本侧变体。收编到 prompt-builder 维持「prompt 单一信源」。
 * 输出与原手写体语义等价：待修复问题清单 + 受影响文件 + 约束 + 产出要求，
 * 修复请求文件路径为动态解析的绝对路径（P0-2 原则）。
 *
 * @param {Object} opts
 * @param {string} opts.storyId - Story ID
 * @param {number} opts.round - 当前修复轮次
 * @param {number} opts.maxRounds - 最大修复轮次
 * @param {number} opts.sourcePhase - 失败来源 Phase（3=代码审查 / 4=功能测试）
 * @param {Array<{id:string,severity:string,file?:string,line?:string,description:string,suggestion?:string}>} opts.issues - 待修复问题清单
 * @param {string[]} opts.affectedFiles - 受影响文件（dev-pass 限域范围）
 * @returns {string} 完整可注入的修复任务 prompt
 */
function buildFixLoopSpawnPrompt (opts) {
  const { storyId, round, maxRounds, sourcePhase, issues, affectedFiles } = opts
  const fixRequestPath = toPosix(path.join(PLANS_DIR, storyId, 'fix-request.json'))

  const issueList = issues.map(i =>
    `\n**${i.id}** [${i.severity}]${i.file ? ` \`${i.file}${i.line ? ':' + i.line : ''}\`` : ''}\n` +
    `- 问题: ${i.description}\n` +
    `- 建议: ${i.suggestion || '请根据上下文分析并修复'}\n`
  ).join('\n')

  return [
    `## 🔧 修复任务 (第 ${round}/${maxRounds} 轮)`,
    '',
    `你正在接收来自 **${sourcePhase === 3 ? '代码审查 (Phase 3)' : '功能测试 (Phase 4)'}** 的修复请求。`,
    '',
    `### 待修复问题 (共 ${issues.length} 个)`,
    issueList,
    `### 受影响文件`,
    affectedFiles.length > 0
      ? affectedFiles.map(f => `- \`${f}\``).join('\n')
      : '- 未明确（从 fix-request.json 获取）',
    '',
    '### 约束',
    '- ⛔ 仅修复以上列出的文件，禁止修改其他文件',
    '- ⛔ 禁止顺手重构不相关的代码',
    '- ✅ 每修复一个问题后输出 `✅ [问题ID] 已修复: <实际改动说明>`',
    '- ✅ 修复完成后执行 `npx eslint --fix <修改的文件路径>`（执行前询问用户）',
    `- ✅ 修复完成后生成 \`fix-report-round${round}.md\`（记录实际改动）`,
    '',
    '### 修复请求详情文件',
    `- 完整修复请求: \`${fixRequestPath}\``,
    '- 请先读取该文件了解完整上下文',
    '',
    '### 修复完成后',
    '- 产出 `fix-verification.json`（逐项核对修复结果），格式:',
    `  \`{"round": ${round}, "source": "${sourcePhase === 3 ? 'code-review' : 'acceptance-test'}", "fixes": [{"id":"FIX-01","status":"fixed|partially|skipped","actualChange":"改动说明","filesModified":["src/xxx"]}], "summary":{"total":N,"fixed":N,"partially":N,"skipped":N}}\``,
    '- 通知主 Agent 修复完成；后续推进命令以 dispatch.js 输出的 advanceCommand 为准，不要手写',
    ''
  ].join('\n')
}

/**
 * 构造下一个 Phase 的 Agent Prompt 及其配套元信息。
 *
 * @param {Object} opts
 * @param {string} opts.storyId - Story ID
 * @param {number} opts.targetPhase - 即将进入的 Phase（Agent 要干活的那个 Phase）
 * @param {number} opts.summaryPhase - 用于取摘要的 Phase（通常是 targetPhase - 1）
 * @param {Object} [opts.summaryInfo] - 已加载的摘要对象；不传则自行加载
 * @param {number} [opts.batchId] - P1-1: 批次 ID（仅 Phase 2 生效）。传入时注入
 *   「本批次目标仓 + task id 清单 + files[] 白名单」段，task 正文仍以 task-dag.json 为唯一信源
 * @param {string} [opts.scope] - P1-2: 'incremental' 时为增量修复窄上下文 —— 跳过
 *   Story 背景资料 / Figma 设计摘要，改注入修复契约文件（fix-request 等）；缺省 'full'
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
 *   batchScope?: { batchId: number, taskIds: string[], repos: string[], totalBatches: number },
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

  // P1-2: scope=incremental（增量修复场景）跳过大块背景注入，只保留修复必需信息，
  // 消除「改 2 行 description 却重读 688 行背景」的上下文浪费（D5）
  const incremental = opts.scope === 'incremental'

  // Story 级背景资料（如 bug 分析报告）—— 只在 Phase 0-1 注入，见 readStoryContext 说明
  const storyContext = incremental ? [] : readStoryContext(storyId, targetPhase)

  // 本 Story 原始输入（仅 Phase 0 注入完整内容）
  const storyInputSection = buildStoryInputSection(storyId, targetPhase)
  const storyMode = getStoryMode(storyId)

  // Figma 设计规格摘要（frame-inventory 的 designSpec，Phase 2 前端开发注入，辅助参考）
  // P1-2: 增量修复场景跳过（修复 BLOCKER 不需要重新消化设计规格摘要）
  const figmaDesignSpec = incremental ? [] : readFigmaDesignSpec(storyId, targetPhase)
  // Figma 对齐指令（Phase 2 前端开发时强制要求按设计稿实现）
  const figmaAlignInstruction = buildFigmaAlignInstruction(storyId, targetPhase)
  // Figma 任务规划指令（Phase 1 任务规划师拆 task 时处理 Figma，产出 frame-inventory + 绑定 figmaRefs）
  const taskPlannerFigmaInstruction = buildTaskPlannerFigmaInstruction(storyId)

  // 修复回路上下文
  const fixLoopContext = buildFixLoopContext(storyId, targetPhase)

  // P1-1: batch 级任务范围（仅 Phase 2 且指定 batchId 时注入）——
  // 输出「目标仓 + task id 清单 + files[] 白名单」，task 正文仍以 task-dag.json 契约为唯一信源，
  // 消除主 Agent 在多批次开发时手写 prompt 的动机（D1）
  const batchScope = (targetPhase === 2 && opts.batchId !== undefined && opts.batchId !== null)
    ? buildBatchScopeSection(storyId, opts.batchId)
    : null

  // P1-2: 增量修复的窄上下文 —— 只列被点名的修复契约文件（fix-request / fix-context / fix-verification）
  const incrementalFixSection = incremental ? buildIncrementalFixSection(storyId) : ''

  // P1-3: 跨仓检索入口（repos.json 有非 primary 条目时逐仓下发，修复 D2 三重失效）
  const repoSearchEntries = buildRepoSearchEntries(storyId, targetPhase)

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
    storyContext.length > 0 ? `## Story 背景资料\n请读取以下文件获取完整内容：\n${storyContext.join('\n')}\n` : '',
    (targetPhase === 1 && taskPlannerFigmaInstruction.length > 0) ? taskPlannerFigmaInstruction.join('\n') : '',
    figmaAlignInstruction.length > 0 ? figmaAlignInstruction.join('\n') : '',
    figmaDesignSpec.length > 0 ? figmaDesignSpec.join('\n') : '',
    '## 上一 Phase 摘要',
    summaryInfo ? `请读取上轮摘要文件获取完整信息（路径: ${toPosix(summaryInfo.path)}）` : '(无摘要)',
    '',
    lessons ? `## 历史教训\n${lessons.trim()}\n` : '',
    metricsInsights ? `## 度量洞察\n${metricsInsights.trim()}\n` : '',
    fixLoopContext ? `## 修复回路上下文 (第 ${fixLoopContext.round}/${fixLoopContext.maxRounds} 轮)\n${fixLoopContext.instruction}\n受影响文件: ${fixLoopContext.affectedFiles.join(', ') || '(见 fix-request.json)'}\n` : '',
    incrementalFixSection,
    batchScope ? batchScope.lines.join('\n') : '',
    '## 契约文件内容',
    contractContents.length > 0 ? '请逐个读取以下契约文件获取完整内容（不要依赖摘要）：\n' + contractContents.join('\n') : '(无契约文件)',
    '',
    expectedDescriptions.length > 0
      // P0-2: 产出目录给主仓动态解析的绝对路径（PLANS_DIR 来自 state.js 的 PROJECT_ROOT 推导），
      // 相对路径会被子 Agent 按自己的 cwd 解析，跨仓场景产出物会写错仓（D8）；
      // 用正斜杠形式注入 —— markdown 渲染层会把 `\.` 当转义吃掉，反斜杠路径显示会缺分隔符
      ? `## 产出要求\n${expectedDescriptions.map(d => `- ${d}`).join('\n')}\n产出目录: ${toPosix(path.join(PLANS_DIR, storyId))}`
      : '',
    '',
    (storyMode === 'fixbugs' && targetPhase === 2)
      ? '## Bug 修复说明\nBug 事实（问题复述 / 复现步骤 / 代码定位 / 根因）已在 Phase 0 分析完毕、并在 Phase 1 消化进 `task-dag.json` 与 `acceptance-criteria.json`。\n**以契约文件为准动手**: `task-dag.json` 的 `files[]` 就是改动范围，`acceptanceCriteria` 关联的 AC 描述里带 Bug 编号。\n修复怎么改由你设计: 先用 kb-query ∥ graphify 双源交叉验证确认真实改动点，再给出实现。\n'
      : '',
    repoSearchEntries.length > 0 ? repoSearchEntries.join('\n') : '',
    '## 约束',
    ...AGENT_CONSTRAINTS.map(c => `- ${c}`),
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
  // P1-1: batch 范围元信息（编排层据此生成逐 batch spawn 序列）
  if (batchScope) {
    result.batchScope = {
      batchId: opts.batchId,
      taskIds: batchScope.taskIds,
      repos: batchScope.repos,
      totalBatches: batchScope.totalBatches
    }
  }

  return result
}

module.exports = {
  buildAgentPrompt,
  buildFixLoopContext,
  buildStoryInputSection,
  readContractContents,
  readStoryContext,
  readFigmaDesignSpec,
  buildFigmaAlignInstruction,
  buildTaskPlannerFigmaInstruction,
  // P1-1 / P1-2 / P1-3（2026-09 REAL_RUN 诊断优化）
  readTaskBatches,
  buildBatchScopeSection,
  buildIncrementalFixSection,
  buildFixLoopSpawnPrompt,
  buildRepoSearchEntries,
  AGENT_CONSTRAINTS
}
