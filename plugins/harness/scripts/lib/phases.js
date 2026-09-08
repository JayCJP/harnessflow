/**
 * phases.js — Phase 定义与 Phase→Agent 映射
 *
 * 职责:
 *   - PHASE_SLUGS / PHASE_NAMES: Phase 编号 → slug / 中文名的唯一信源
 *   - PHASE_ARTIFACTS: 每个 Phase 的产出物清单（**产出物唯一信源**）
 *   - PHASE_AGENTS: Phase → Agent 注册名 + 该 Agent 的任务指令
 *   - getPhaseAgent / getPhaseSlug / getPhaseName: 三个确定性查表
 *
 * 用法:
 *   const { PHASE_ARTIFACTS, getPhaseName } = require('./phases')
 *
 * 使用场景:
 *   - 门控校验: checkPhaseArtifact 按 PHASE_ARTIFACTS 判产出物是否齐全
 *   - prompt 产出要求: prompt-builder 从这里读每个 Phase 该产出什么
 *   - 上下文摘要: context-refresh 收集已完成 Phase 的产出物
 *   - Phase→Agent 是确定性查表，不经过 LLM 推理
 *
 * 说明:
 *   - PHASE_AGENTS 的 `agent` 是 Agent **注册名**（agent 文件 frontmatter 的 name，英文）。
 *     Agent 文件名与正文标题是中文，但注册键是英文 name —— 传中文名无法解析到 Agent。
 *     `label` 仅供人类阅读（日志/文档），禁止用于 Spawn。
 *   - `optional: true` 的产出物按条件产出（原型 / Figma），门控不因其缺失而失败；
 *     若同时声明 `requiredWhen: 'hasFigmaDesign'` 且条件成立则升级为必需。
 *   - Phase 8 是工作流终态，无产出物、无 Agent。
 *   - 本模块只依赖零依赖的 artifacts.js（文件名常量表），可安全被任意层引用。
 */

const { ARTIFACT } = require('./artifacts')

/** Phase slug 映射 (0-8) */
const PHASE_SLUGS = [
  'requirement_analysis',    // 0
  'task_planning',           // 1
  'development',             // 2
  'code_review',             // 3
  'git_submit',              // 4
  'knowledge_base_update',   // 5
  'deployment',              // 6
  'completed'                // 7 — 工作流终态
]

/**
 * 最大合法 Phase 编号（终态 = 7）
 *
 * 此前 dispatch.js 与 advance-phase.js 各自定义了一份 `PHASE_SLUGS.length - 1`，
 * 两处硬编码同一事实。收敛到定义 PHASE_SLUGS 的模块里，数组增删时不会漏改。
 */
const MAX_PHASE = PHASE_SLUGS.length - 1

/** Phase 中文名称 */
const PHASE_NAMES = [
  '需求分析',       // 0
  '任务规划',       // 1
  '代码开发',       // 2
  '代码审查',       // 3
  'Git提交',        // 4
  '知识库更新',     // 5
  '云端部署',       // 6
  '工作流完成'      // 7 — 工作流终态
]

/**
 * 每个 Phase 的产出物文件名模式（新版：无 storyId 前缀）
 *
 * 本表是产出物清单的**唯一信源**: 门控校验（checkPhaseArtifact）、
 * prompt 产出要求（prompt-builder）、上下文摘要（context-refresh）都从此读取。
 *
 * `optional: true` 的产出物按条件产出（如原型/Figma 视 Story 输入而定），
 * 门控不因其缺失而失败，但存在时会进摘要与 prompt。判定逻辑各自独立:
 *   - prototype-analysis.md   → gateChecks.prototypeRequired
 *   - figma-frame-inventory.json → state.hasFigmaDesign
 */
const PHASE_ARTIFACTS = {
  0: {
    artifacts: [
      { fileName: ARTIFACT.REQUIREMENT_ANALYSIS, description: '需求分析文档', contract: false },
      { fileName: ARTIFACT.ACCEPTANCE_CRITERIA, description: '验收标准契约', contract: true },
      { fileName: ARTIFACT.OPEN_QUESTIONS, description: '待确认项契约', contract: true },
      { fileName: ARTIFACT.PROTOTYPE_ANALYSIS, description: '原型分析文档（有原型链接时产出）', contract: false, optional: true }
    ]
  },
  1: {
    artifacts: [
      { fileName: ARTIFACT.TASK_DAG_DOC, description: '任务 DAG 文档', contract: false },
      { fileName: ARTIFACT.TASK_DAG_JSON, description: '任务 DAG 契约', contract: true },
      { fileName: ARTIFACT.FIGMA_FRAME_INVENTORY, description: 'Figma Frame 清单（有 Figma 设计稿时产出，任务规划师拆 task 时只针对相关组件拉取，每个 frame 含 id/name/link/type/rect 及可选 designSpec 设计规格摘要）', contract: true, optional: true, requiredWhen: 'hasFigmaDesign' }
    ]
  },
  2: { artifacts: [{ fileName: null, description: '代码变更（git diff）', contract: false }] },
  // Phase 4（功能测试）已移除：AC 逐条核对并入本 Phase 由 code-reviewer 顺带完成，
  // 未通过的 AC 记入 issues[] 的 BLOCKER —— 因此 code-review.json 是本 Story 唯一的验收对账产物
  3: { artifacts: [{ fileName: ARTIFACT.CODE_REVIEW, description: '代码审查结构化数据(JSON格式，唯一产出物；AC 逐条核对结论一并记入 issues[])', contract: true }] },
  4: { artifacts: [{ fileName: null, description: 'Git commit + push', contract: false }] },
  5: { artifacts: [{ fileName: null, description: '知识库文档更新（meta.yaml hash 变化）', contract: false }] },
  6: { artifacts: [{ fileName: null, description: '部署 URL + 构建号', contract: false }] }
}

/**
 * 每个 Phase 应由哪个 Agent 承担 + 该 Agent 的任务指令。
 *
 * 设计说明:
 *   - `agent` 是 Agent 的**注册名**（agent 文件 frontmatter 的 `name` 字段，英文）。
 *     Agent 文件名和正文标题是中文，但注册键是英文 name——传中文名无法解析到 Agent。
 *   - `label` 仅供人类阅读（日志/文档），禁止用于 Spawn。
 *   - Phase→Agent 是确定性查表，不需要 LLM 推理。
 *     此表取代了原 agents/dispatcher.md 中的映射表。
 *   - Phase 7 为终态，无 Agent。
 */
const PHASE_AGENTS = {
  0: {
    agent: 'requirement-analyst',
    label: '需求分析师',
    instruction: '读取需求输入（PRD / bug 分析报告 / 用户补充说明），产出需求分析文档、可测试的验收标准和待确认问题'
  },
  1: {
    agent: 'task-planner',
    label: '任务规划师',
    instruction: '基于 Phase 0 产出物，将需求拆解为可并行的任务 DAG，并在 task-dag.json 的 files[] 中列全所有待修改文件（该字段决定 Phase 2 的写入范围）'
  },
  2: {
    agent: 'frontend-developer',
    label: '前端开发工程师',
    instruction: '按 task-dag.json 的批次执行开发任务。同一 batch 内的任务可并行 Spawn 多个开发者 Agent，batch 之间串行'
  },
  3: {
    agent: 'code-reviewer',
    label: '代码审查师',
    // 原 Phase 4 的 AC 验收并入此处：审查时逐条核对 acceptance-criteria.json，
    // 未通过的按 BLOCKER 记入 issues[]（title 带 AC 编号），从而复用既有修复回路
    instruction: '审查本 Story 的代码变更（git diff），并逐条核对 acceptance-criteria.json 的每条 AC，未通过的 AC 以 BLOCKER 记入 issues[]（title 注明 AC 编号）。若存在 fix-request.json 说明是修复回路复查，需做增量审查'
  },
  4: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '执行 git add + commit + push，并创建 MR。禁止使用 --no-verify'
  },
  5: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '调用 kb-update Skill 增量更新知识库文档'
  },
  6: {
    agent: 'release-assistant',
    label: '发布助手',
    instruction: '通过 devops MCP 触发云端构建和部署，回报部署 URL + 构建号'
  }
}

/**
 * 获取指定 Phase 的 Agent 信息
 * @param {number} phase - Phase 编号
 * @returns {{ agent: string, label: string, instruction: string }|null} 终态(7)或越界返回 null
 */
function getPhaseAgent (phase) {
  return PHASE_AGENTS[phase] || null
}

/**
 * 获取 Phase 的 slug 名称
 * @param {number} phaseNum - Phase 编号
 * @returns {string} slug；越界返回 'unknown'
 */
function getPhaseSlug (phaseNum) {
  return PHASE_SLUGS[phaseNum] || 'unknown'
}

/**
 * 获取 Phase 的中文名称
 * @param {number} phaseNum - Phase 编号
 * @returns {string} 中文名；越界返回 '未知'
 */
function getPhaseName (phaseNum) {
  return PHASE_NAMES[phaseNum] || '未知'
}

module.exports = {
  PHASE_SLUGS,
  MAX_PHASE,
  PHASE_NAMES,
  PHASE_ARTIFACTS,
  PHASE_AGENTS,
  getPhaseAgent,
  getPhaseSlug,
  getPhaseName
}
