#!/usr/bin/env node
/**
 * policy.js — 风险门控层 (Policy Runtime)，产出物校验 + 契约一致性 + 恢复建议
 *
 * 职责:
 *   - runGateCheck: 按 Phase 执行门控（产出物存在性 → JSON Schema → Phase 特定契约 → 资源完整性）
 *   - 产出结构化 blocker（携带 failureType），供 experience.js 直接沉淀，无需从文本反推类型
 *   - matchRecoverySuggestion: 为 blocker 匹配分级恢复建议（level 决定主 Agent 的下一步）
 *   - checkContractRegression: 契约回归检查（增量 lint + build）
 *
 * 用法:
 *   作为模块引用:
 *     const { runGateCheck, matchRecoverySuggestion } = require('./services/policy')
 *
 * 使用场景:
 *   - commands/advance-phase.js 每次 Phase 推进前调用 runGateCheck 裁定能否推进
 *     （失败时为残余 blocker 取恢复建议，随 structuredBlockers 一并返回给主 Agent）
 *   - commands/dispatch.js 调度前的门控「预检」，仅用于决定该干活还是该修复，
 *     裁定权始终在 advance-phase.js，dispatch 不写状态
 *   - 内部依赖 services/schema-validator.js 做 JSON 产出物的 Schema 校验
 *   - 未登记 failureType 会命中 RECOVERY_SUGGESTIONS.unknown 并产生 warning，提示补录独立条目
 *
 * 说明:
 *   - 三层解耦中的「门控层」——独立于编排逻辑，是推理链条之外不受污染的检查点：
 *     门控层的价值正在于它是整条 agent 推理链条之外的决策节点，不参与推理、不受推理结果影响
 *   - v2.1 failureType 由 lib/contracts.js 在校验产生处标记（issues[].type），本模块不再
 *     用字符串关键词反推类型（2026-09 移除 4 段 includes() 猜谜：改文案即掉 unknown）
 *   - RECOVERY_SUGGESTIONS 分 4 级: Level 1 自动修复 / Level 2 提示修复 / Level 3 降级通过 /
 *     Level 4 阻止并人工介入。当前无 Level 1 条目 —— 历史上有 3 个 autoFix（name→title 等）
 *     但触发条件与修复条件互斥，永不执行，已连同 7 条死条目一并删除
 *   - 新增校验必须在 RECOVERY_SUGGESTIONS 登记 type，否则 blocker 落 unknown；
 *     __tests__/optimization-regression.test.js 第 9 节有静态扫描护栏
 *
 * @module policy
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  PLANS_DIR,
  checkPhaseArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  validateTaskFigmaReferences,
  checkFigmaFrameInventory,
  hasFigmaDesign,
  readJsonArtifact,
  getStoryDir,
  getPhaseName,
  loadRepos,
  getRepoRoot,
  structuredError,
  errorToString,
  errorToType,
  getStoryMode,
  findBugAnalysisReports
} = require('../lib/state')
const { ARTIFACT } = require('../lib/artifacts')

const schemaValidator = require('./schema-validator')
const debugLog = require('../lib/debug-log')

/**
 * advance-phase.js 的绝对调用形式 —— 复用 lib/paths.js 的公共出口。
 *
 * 此前本文件、dispatch.js、advance-phase.js 各拼过一份同一条命令（三份同物实现），
 * 改一处参数只会让其中一份生效。收敛后本文件是 resolution / fixLoopHint 里命令的
 * 唯一信源，dispatch.js 的 recovery.command 直接转发 fixLoopHint，不再二次拼装。
 */
const { ADVANCE_CMD } = require('../lib/paths')

// ─── 错误恢复建议表 ─────────────────────────────────────────────

/**
 * 已知错误模式的自动恢复建议
 * Level 1: 自动修复 (可程序化处理)
 * Level 2: 提示修复 (输出具体命令)
 * Level 3: 降级通过 (warning 化)
 * Level 4: 阻止 + 人工介入
 */
const RECOVERY_SUGGESTIONS = {
  // Phase 0→1: open-questions 有 blocking 未解决
  blocking_unresolved: {
    level: 4,
    action: '请用户逐项确认 open-questions 中的 blocking 项并更新 resolved 字段',
    autoFixable: false
  },
  // Phase 0→1: AC 格式错误
  ac_format_error: {
    level: 2,
    action: '检查 acceptance-criteria.json 格式: 顶层应为 {"criteria": [{"id":"AC-1","description":"..."}]}',
    autoFixable: false
  },
  // Phase 0→1: AC 缺少 id 字段
  ac_missing_id: {
    level: 2,
    action: '为每条验收标准添加唯一 id 字段（如 "AC-1"）',
    autoFixable: false
  },
  // Phase 0→1: AC 缺少 description 字段
  ac_missing_description: {
    level: 2,
    action: '为每条验收标准添加 description 字段',
    autoFixable: false
  },
  // Phase 0→1: AC criteria 数组为空
  ac_empty_criteria: {
    level: 2,
    action: 'acceptance-criteria.json 的 criteria 数组至少需要 1 条验收标准',
    autoFixable: false
  },
  // Phase 0→1: AC 重复 ID
  ac_duplicate_id: {
    level: 2,
    action: '验收标准 ID 必须唯一，请检查并修正重复 ID',
    autoFixable: false
  },
  // Phase 1→2: Figma frame 缺少 id/name/link/type
  figma_frame_incomplete: {
    level: 2,
    action: '每个 Figma frame 必须有 id、name、link 字段',
    autoFixable: false
  },
  // Phase 1→2: task 缺少 id
  task_missing_id: {
    level: 2,
    action: '为每个 task 添加唯一 id 字段',
    autoFixable: false
  },
  // Phase 1→2: task 缺少 title
  // 原为 level 1 + autoFix(name→title)，但触发条件是「task 既无 name 也无 title」，
  // autoFix 里的 `if (t.name && !t.title)` 恒 false —— 声称可自动修复实则永不执行，故降为 level 2
  task_missing_title: {
    level: 2,
    action: '为每个 task 添加 title 字段（使用 title 而非 name）',
    autoFixable: false
  },
  // Phase 1→2: 跨项目 task description 缺少行号引用
  task_missing_line_ref: {
    level: 2,
    action: '跨项目 task（有 project 字段）的 description 必须包含行号引用（如 L123 或 line 45），便于定位代码改动点。请检查 task-dag.json 中跨项目 task 的 description 并补充行号。',
    autoFixable: false
  },
  // Phase 1→2: 跨项目 task 缺少 repoPath（P2-2: 补齐 checkTaskDagJson 错误的结构化映射，杜绝 unknown）
  task_missing_repo_path: {
    level: 2,
    action: '跨项目 task（project ≠ 主仓）必须指定 repoPath，否则 dev-pass 无法把改动定位到正确仓库',
    autoFixable: false
  },
  // Phase 1→2: 跨项目 task 缺少 description 字段（P2-2）
  task_missing_description: {
    level: 2,
    action: '跨项目 task 必须有 description 字段（含行号引用），便于开发 Agent 定位改动点',
    autoFixable: false
  },
  // Phase 1→2: 跨项目 task 缺少 graphify 检索证据（P2-3: evidence 门控，只认含 graphify 的来源）
  task_missing_evidence: {
    level: 2,
    action: '跨项目 task 必须提供 evidence 字段（{ source, ref }），且 source 必须含 graphify（graphify 或 both；kb/grep 单独不满足）——证明已在目标仓真实执行过 graphify 检索。ref 填实际执行的 query 或命中的文档路径',
    autoFixable: false
  },
  // Phase 1→2: acceptanceCriteria 空数组
  empty_ac_ref: {
    level: 2,
    action: 'task-dag.json 中每个 task 的 acceptanceCriteria 不能为空数组，至少引用 1 条 AC',
    autoFixable: false
  },
  // Phase 1→2: task 重复 ID
  task_duplicate_id: {
    level: 2,
    action: 'Task ID 必须唯一，请检查并修正重复 ID',
    autoFixable: false
  },
  // Phase 1→2: AC↔Task 交叉引用 - 孤立 AC
  orphan_ac: {
    level: 2,
    action: '每条验收标准至少被 1 个 Task 引用，请检查 task-dag.json 的 acceptanceCriteria',
    autoFixable: false
  },
  // Phase 1→2: AC↔Task 交叉引用 - 引用不存在的 AC
  invalid_ac_ref: {
    level: 2,
    action: 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在',
    autoFixable: false
  },
  // Phase 1→2: AC↔Task 交叉引用 - 引用写成了 "AC-1: 描述" 而非纯 ID
  ac_ref_format_drift: {
    level: 3,
    action: 'task-dag.json 的 acceptanceCriteria 必须写纯 AC ID（如 "AC-1"），不能带描述文本（"AC-1: 描述"）',
    autoFixable: false
  },
  // Phase 0→1: PRD 功能点未全部落到 AC 上
  prd_coverage_missing: {
    level: 2,
    action: '在 acceptance-criteria.json 的 featurePoints 中逐条声明功能点覆盖情况（covered+acIds 或 deferred+deferredReason）',
    autoFixable: false
  },
  // Phase 1→2: Task 引用的 figmaNodeId 不在 figma-frame-inventory.json 中
  invalid_figma_ref: {
    level: 2,
    action: 'Task 的 figmaNodeId 必须存在于 figma-frame-inventory.json 的 frames 中',
    autoFixable: false
  },
  // Phase 4→5: UI 交互型 AC 仅凭代码审读判 passed
  static_evidence_for_ui_ac: {
    level: 2,
    action: '交互型 AC 必须有运行时证据（Playwright 实跑或人工点验），给不出就把 status 改为 unverifiable，不允许用代码审读冒充通过',
    autoFixable: false
  },
  // Phase 4→5: code-review 未修复项与验收结论自相矛盾
  review_acceptance_conflict: {
    level: 2,
    action: '修复该审查问题（status→fixed），或把对应 AC 从 passed 改为 failed 并走修复回路 —— 不允许"问题未修 + AC 通过"并存',
    autoFixable: false
  },
  // Phase 2→3: 变更文件存在 lint error
  lint_error: {
    level: 2,
    action: '修复本次变更文件的 lint error（门控只 lint 变更文件，不含存量问题）',
    autoFixable: false
  },
  // Phase 2→3: 本地编译失败
  build_failed: {
    level: 2,
    action: '本地复现并修复编译错误（SCSS/模板/语法），不要把编译问题留给云端构建',
    autoFixable: false
  },
  // Phase 3→4: code-review 含 BLOCKER 关键词
  code_review_blocker: {
    level: 2,
    action: '执行修复回路将问题回退给前端开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 4→5: AC 验收未通过
  ac_verification_failed: {
    level: 2,
    action: '验收标准未通过，执行修复回路将问题回退给前端开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // 产出物缺失
  artifact_missing: {
    level: 4,
    action: '请先完成对应 Phase 的产出物',
    autoFixable: false
  },
  // JSON 产出物解析失败（语法错误）
  json_parse_error: {
    level: 2,
    action: 'JSON 产出物语法错误，请检查括号/逗号/引号是否闭合，可用 node -e "JSON.parse(require(\'fs\').readFileSync(\'<file>\',\'utf-8\'))" 定位',
    autoFixable: false
  },
  // 兜底：未归类的失败模式
  // 注意：命中此项说明有 failureType 未登记，应分析后补充为独立条目
  unknown: {
    level: 3,
    action: '未归类的门控失败：请阅读 blocker message 手工处理，并将此错误模式补充到 policy.js 的 RECOVERY_SUGGESTIONS 中',
    autoFixable: false
  }
}

/**
 * 根据 blocker 的 failureType 匹配恢复建议
 * v2: 优先用结构化 blocker 的 type 字段精确匹配，兼容旧的纯字符串关键词匹配
 * @param {{ type: string, message: string }|string} blocker - 结构化 blocker 或纯字符串
 * @returns {{ level: number, action: string, autoFixable: boolean, autoFix?: Function }} 永不为 null，最差返回 RECOVERY_SUGGESTIONS.unknown
 */
function matchRecoverySuggestion (blocker) {
  // 结构化 blocker: 直接用 type 字段精确匹配
  const failureType = errorToType(blocker)
  if (failureType !== 'unknown' && RECOVERY_SUGGESTIONS[failureType]) {
    return RECOVERY_SUGGESTIONS[failureType]
  }

  // 兜底兼容: 纯字符串 blocker 的关键词匹配（保留旧逻辑）
  const lower = errorToString(blocker).toLowerCase()
  if (lower.includes('阻塞级待确认') || lower.includes('blocking')) return RECOVERY_SUGGESTIONS.blocking_unresolved
  if (lower.includes('acceptance-criteria') && lower.includes('缺少')) return RECOVERY_SUGGESTIONS.ac_format_error
  if (lower.includes('缺少 title') || lower.includes('"name"')) return RECOVERY_SUGGESTIONS.task_missing_title
  if (lower.includes('evidence')) return RECOVERY_SUGGESTIONS.task_missing_evidence
  if (lower.includes('blocker')) return RECOVERY_SUGGESTIONS.code_review_blocker
  if (lower.includes('acceptancecriteria') && lower.includes('空')) return RECOVERY_SUGGESTIONS.empty_ac_ref
  if (lower.includes('行号引用') || lower.includes('line 45') || lower.includes('l123')) return RECOVERY_SUGGESTIONS.task_missing_line_ref

  // 类型未登记且关键词未命中 → 返回显式 unknown 条目（而非 null），
  // 保证每个 blocker 都带 level-3 恢复建议，并提示将该模式补录为独立条目
  return RECOVERY_SUGGESTIONS.unknown
}

// ─── 门控校验主函数 ─────────────────────────────────────────────

/**
 * 执行指定 Phase 的门控校验
 * v2: blockers 为结构化对象数组，每个携带 failureType
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - 要检查的 Phase 编号
 * @param {Object} state - e2e-state.json 状态对象
 * @returns {{ passed: boolean, blockers: Array<{type:string,message:string,level:number,resolution:string}>, warnings: string[], recoveries: Array }}
 */
function runGateCheck (storyId, phaseNum, state) {
  const result = { passed: true, blockers: [], warnings: [], recoveries: [], _meta: {} }

  if (phaseNum < 0) return result // Phase 0 无前置

  // 1. 产出物存在性检查（传入 state 以启用条件必需产出物，如 hasFigmaDesign 时的 figma-frame-inventory.json）
  const artifact = checkPhaseArtifact(storyId, phaseNum, state)
  if (!artifact.exists) {
    for (const m of artifact.missing) {
      const blocker = structuredError(
        'artifact_missing',
        `Phase ${phaseNum}(${getPhaseName(phaseNum)}) 产出物缺失: ${m.description} (${m.fileName})`,
        4,
        `请先完成 Phase ${phaseNum} 的产出物 ${m.fileName}`
      )
      result.blockers.push(blocker)
      const suggestion = matchRecoverySuggestion(blocker)
      if (suggestion) result.recoveries.push({ blocker, suggestion })
    }
    result.passed = false
  }

  // 1.5. 🆕 JSON Schema 校验（产出物存在时，校验格式是否符合 schema）
  const jsonArtifacts = schemaValidator.getPhaseArtifacts(phaseNum)
  if (jsonArtifacts.length > 0) {
    for (const fileName of jsonArtifacts) {
      const schemaResult = schemaValidator.validateArtifact(storyId, fileName)
      if (!schemaResult.valid) {
        for (const err of schemaResult.errors) {
          result.blockers.push(structuredError(
            'schema_validation_failed',
            `Schema 校验失败: ${err}`,
            2,
            `请检查 ${fileName} 格式是否符合规范，参考 schemas/ 目录下的 schema 定义`
          ))
        }
        result.passed = false
      }
    }
  }

  // 2. Phase 特定契约检查
  if (phaseNum === 0) {
    checkPhase0Gate(storyId, state, result)
  } else if (phaseNum === 1) {
    checkPhase1Gate(storyId, state, result)
  } else if (phaseNum === 2) {
    checkPhase2Gate(storyId, state, result)
  } else if (phaseNum === 3) {
    checkPhase3Gate(storyId, result)
  }

  // 2.5. 🆕 资源完整性检查（声明了外部依赖但未有效消费）
  // 检查时机：Phase 2 开发完成后（进入 Phase 3 审查前），验证开发阶段是否真的消费了
  // 声明的 Figma 设计稿 / 知识库等资源。这是「声明-消费一致性」在门控层的落地。
  checkResourceIntegrity(storyId, phaseNum, state, result)

  // 3. 为未匹配恢复建议的 blocker 补充兜底 recoveries
  for (const blocker of result.blockers) {
    const existingRecovery = result.recoveries.find(r =>
      (typeof r.blocker === 'object' && r.blocker === blocker) ||
      (typeof r.blocker === 'string' && r.blocker === errorToString(blocker))
    )
    if (!existingRecovery) {
      // matchRecoverySuggestion 永不返回 null（未登记类型 → RECOVERY_SUGGESTIONS.unknown，level 3）
      const suggestion = matchRecoverySuggestion(blocker)
      result.recoveries.push({ blocker, suggestion })
      if (suggestion === RECOVERY_SUGGESTIONS.unknown) {
        // 显式告警：出现未登记的 failureType，应补录为独立条目
        result.warnings.push(`未归类的失败模式 (failureType: ${errorToType(blocker)})，建议补充到 policy.js 的 RECOVERY_SUGGESTIONS`)
      }
    }
  }

  return result
}

/**
 * 资源完整性检查 —— 声明了外部依赖但未有效消费
 *
 * 这是「声明-消费一致性」在门控层的落地。
 *
 * 注意：Figma MCP 消费检查已移除 —— 由于 Figma 由子 Agent 调用，
 * 其 tool_call 不会写入主流程的 trace.jsonl，无法据此判定是否真实消费，
 * 因此不再拦截（Figma 设计还原仍由 Phase 0/1 的 frame inventory 与
 * figmaNodeId 契约门控兜底）。
 *
 * 判定依据（v2 证据链）：
 *   - kb-query / graphify 调用为 0 → WARNING（放行但记 debt，Evo Score 扣分）
 *
 * 检查时机：仅在 phaseNum === 3（即 Phase 3→4 门控，代码审查完成、准备进入 Git 提试前）时执行。
 * 此时 Phase 2 开发阶段已全部结束，trace.jsonl 的开发 tool_call 记录最完整，判定最可靠。
 * 早期阶段（phaseNum < 3）开发尚未完成，trace 不完整；后期阶段（phaseNum > 3）已过功能测试，无需重复。
 *
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - 要推进到的 Phase 编号（来源 phase）
 * @param {Object} state - e2e-state.json 状态对象
 * @param {Object} result - 门控结果对象（会原地写入 blockers / warnings）
 * @returns {void}
 */
function checkResourceIntegrity (storyId, phaseNum, state, result) {
  // 仅在 Phase 3→4 门控时检查（此时 Phase 2 开发 trace 完整；phaseNum 是来源 phase）
  if (phaseNum !== 3) return

  // 读 trace.jsonl 里的 tool_call 事件
  const traceFile = path.join(getStoryDir(storyId), ARTIFACT.TRACE)
  const toolCalls = []
  if (fs.existsSync(traceFile)) {
    try {
      const lines = fs.readFileSync(traceFile, 'utf-8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line)
          if (e.type === 'tool_call') toolCalls.push(e)
        } catch (_) { /* 单行损坏，跳过 */ }
      }
    } catch (_) { /* 读取失败按无记录处理 */ }
  }

  // 知识库消费检查（软性资源 → WARNING，放行但记 debt）
  // 前提: 仅跨仓场景提示。单仓时检索需求随 Story 而异（在空目录新建一个静态页这类 Story
  // 本就没有既有代码可查），对每条单仓 Story 都提示「未做知识库检索」属于无差别噪音 ——
  // 脚本只检测「有没有调用」，判断不了「该不该调用」（2026-09 修正）。
  // 跨仓场景不需要这条告警兜底: contracts.js 对跨仓 task 有 evidence 硬门控
  // （source 必须含 graphify），缺检索会直接卡门控，而不是只扣 Evo Score。
  const kbCalls = toolCalls.filter(e => e.skill === 'kb-query' || e.skill === 'graphify')
  const isMultiRepo = Object.keys(loadRepos(storyId).repos || {}).length > 1
  if (kbCalls.length === 0 && isMultiRepo) {
    result.warnings.push('本 Story 开发阶段未调用 kb-query / graphify 做知识库检索，注入的历史教训可能未被查证（记 debt，Evo Score 扣分）')
  }
}

/**
 * Phase 0→1 门控: AC + open-questions + PRD 覆盖率
 * （Figma frame-inventory 不在此校验 —— frame-inventory 由 Phase 1 任务规划师拆 task 时产出，
 *   完整性与 nodeId 引用在 Phase 1→2 门控 checkPhase1Gate 校验）
 */
function checkPhase0Gate (storyId, state, result) {
  // 验收标准 — issues 由 contracts.js 在产生处标记 type/level/resolution，此处直接转 blocker
  // 注意：acceptance-criteria.json 的文件存在性已由 checkPhaseArtifact 覆盖，
  //       此处 checkAcceptanceCriteria 返回 exists=false 时不重复记录，只处理内容错误
  const acCheck = checkAcceptanceCriteria(storyId)
  if (acCheck.exists && !acCheck.valid) {
    for (const issue of acCheck.issues) {
      result.blockers.push(structuredError(issue.type, issue.message, issue.level, issue.resolution))
      result.passed = false
    }
  }

  // 待确认项 — 单一数据源：open-questions.json
  const oqCheck = checkOpenQuestions(storyId)
  const oqUnresolved = oqCheck.exists ? oqCheck.unresolved.length : 0
  const oqBlocking = oqCheck.exists ? oqCheck.unresolved.filter(q => q.blocking).length : 0

  if (oqBlocking > 0) {
    const blocker = structuredError(
      'blocking_unresolved',
      `${oqBlocking} 项阻塞级待确认问题未解决 (open-questions: ${oqBlocking})`,
      4,
      '请用户逐项确认 open-questions 中的 blocking 项'
    )
    result.blockers.push(blocker)
    result.passed = false
  } else if (oqUnresolved > 0) {
    result.warnings.push(`${oqUnresolved} 项待确认问题未解决但无阻塞级`)
  }

  // Figma frame inventory 不在 Phase 0→1 校验 —— frame-inventory 由 Phase 1 任务规划师拆 task 时产出，
  // 完整性在 Phase 1→2 门控（checkPhase1Gate 的 validateTaskFigmaReferences + 产出物存在性）校验。

  // PRD 功能点 → AC 覆盖率校验（run 模式）
  checkPrdCoverage(storyId, result)

  // Bug 分析报告越界章节扫描（fixbugs 模式，warning 级；存在性不设门控）
  checkBugReportScope(storyId, result)
}

/**
 * Phase 0→1: PRD 功能点覆盖率校验
 *
 * 历史缺陷: 门控只能校验"已写下的 AC 是否格式合规"，无法发现"整条功能压根没进 AC"。
 *   TrainWeChatStore 有 3 个交付文档里的功能点从未变成 AC，14 条 AC 全绿而功能缺失。
 *
 * 解法: 让需求分析师在 acceptance-criteria.json 里额外枚举 featurePoints
 *   （功能点 → covered+acIds / deferred+deferredReason）。
 *   枚举是 LLM 的活，校验映射完整性是程序的活 —— 程序不去猜 PRD 里有什么，
 *   只保证"凡是被枚举出来的功能点，都必须明确落到 AC 或明确写下不做的原因"。
 *   fixbugs 模式不要求（Bug 修复没有 PRD 功能点可枚举）。
 */
function checkPrdCoverage (storyId, result) {
  const input = readJsonArtifact(storyId, ARTIFACT.STORY_INPUT)
  // 读不到 input 时不阻塞（老 Story 或输入缺失，另有门控覆盖）
  if (!input || input._parseError || input.mode !== 'run') return

  const ac = readJsonArtifact(storyId, ARTIFACT.ACCEPTANCE_CRITERIA)
  if (!ac || ac._parseError) return

  const fps = ac.featurePoints
  if (!Array.isArray(fps) || fps.length === 0) {
    result.blockers.push(structuredError(
      'prd_coverage_missing',
      'acceptance-criteria.json 缺少 featurePoints：run 模式必须枚举需求文档/原型中的功能点并逐条声明 AC 覆盖情况',
      2,
      '在 acceptance-criteria.json 增加 featurePoints 数组，每项 { id: "FP-N", source, coverage: "covered"|"deferred", acIds | deferredReason }'
    ))
    result.passed = false
    return
  }

  const acIds = new Set((ac.criteria || []).map(c => c.id).filter(Boolean))
  for (const fp of fps) {
    const tag = fp.id || '(缺少 id)'
    if (fp.coverage === 'deferred') {
      if (!fp.deferredReason || !String(fp.deferredReason).trim()) {
        result.blockers.push(structuredError(
          'prd_coverage_missing',
          `功能点 ${tag} 标记为 deferred 但未写 deferredReason: ${fp.source || ''}`,
          2,
          '本次不做的功能点必须写明原因，便于后续追踪'
        ))
        result.passed = false
      }
      continue
    }
    // covered（含 coverage 字段缺失/非法，一并按 covered 严格要求）
    const refs = Array.isArray(fp.acIds) ? fp.acIds : []
    if (refs.length === 0) {
      result.blockers.push(structuredError(
        'prd_coverage_missing',
        `功能点 ${tag} 未关联任何 AC: ${fp.source || ''}`,
        2,
        '为该功能点补充 acIds，或改为 coverage:"deferred" 并写明 deferredReason'
      ))
      result.passed = false
      continue
    }
    const dangling = refs.filter(id => !acIds.has(id))
    if (dangling.length > 0) {
      result.blockers.push(structuredError(
        'prd_coverage_missing',
        `功能点 ${tag} 引用的 AC 不存在: ${dangling.join(', ')}`,
        2,
        'featurePoints[].acIds 必须引用 criteria 中真实存在的 AC ID'
      ))
      result.passed = false
    }
  }
}

/**
 * Phase 0→1（fixbugs 模式）: Bug 分析报告越界章节扫描（warning 级）
 *
 * 设计边界（见 references/phases/phase-0.md「Bug 分析报告没有门控」）:
 *   - 报告**存在性不设门控** —— 缺报告的后果是后续 Phase 拿不到 Bug 事实，
 *     由 prompt-builder 的 expectedOutputs 要求 Agent 产出，而非程序阻断。
 *   - 仅当报告存在时，扫描**标题行**是否含修复方案类章节 —— 修复设计属于
 *     Phase 2 开发工程师，报告只记录事实。
 *   - 关键词匹配是启发式的（根因段落出现"建议"类措辞会误报），只警告不阻断；
 *     正文不扫描，"该 Bug 在 xx 版本已修复"这类正常表述不会命中。
 *
 * 2026-09 自已删除的废弃脚本 validate-phase-gate.js 迁入（该脚本曾对报告
 * 存在性设 blocker，与文档化行为矛盾，清理时一并纠正）。
 *
 * @param {string} storyId - Story ID
 * @param {Object} result - runGateCheck 的累积结果，warning 写入 result.warnings
 * @returns {void}
 */
function checkBugReportScope (storyId, result) {
  if (getStoryMode(storyId) !== 'fixbugs') return

  const found = findBugAnalysisReports(storyId)
  if (!found.exists) return

  // 只扫标题行 —— 独立的「修复建议 / 解决方案」章节才是越界信号
  const SOLUTION_HEADINGS = /^#{1,6}\s*.*(修复建议|修复方案|解决方案|改造建议|优化建议|测试验证)/
  const hints = []
  for (const p of found.paths) {
    let raw
    try {
      raw = fs.readFileSync(p, 'utf-8')
    } catch (e) {
      continue
    }
    const name = path.basename(p)
    for (const line of raw.split(/\r?\n/)) {
      if (SOLUTION_HEADINGS.test(line.trim())) {
        hints.push(`${name}: ${line.trim()}`)
      }
    }
  }

  if (hints.length > 0) {
    result.warnings.push(
      'Bug 分析报告疑似包含修复方案章节（应只记录事实，修复设计属于开发工程师）:\n' +
      hints.map(h => `  - ${h}`).join('\n')
    )
  }
}

/**
 * Phase 1→2 门控: task-dag + AC↔Task 交叉引用 + Figma frame-inventory 完整性 & nodeId 引用（条件性，仅 hasFigmaDesign）
 */
function checkPhase1Gate (storyId, state, result) {
  // task-dag — issues 由 contracts.js 在产生处标记 type/level/resolution
  // 不设 exists 守卫: 文件不存在/解析失败的 blocker（artifact_missing / json_parse_error）
  // 正是从这里产出的，加守卫会让它们消失
  const taskCheck = checkTaskDagJson(storyId)
  if (!taskCheck.valid) {
    for (const issue of taskCheck.issues) {
      result.blockers.push(structuredError(issue.type, issue.message, issue.level, issue.resolution))
      result.passed = false
    }
  }

  const refCheck = validateContractReferences(storyId)

  // 传递交叉引用校验的 warnings（格式漂移等诊断信息）
  if (refCheck.warnings && refCheck.warnings.length > 0) {
    result.warnings.push(...refCheck.warnings)
  }

  if (!refCheck.valid) {
    for (const issue of refCheck.issues) {
      result.blockers.push(structuredError(issue.type, issue.message, issue.level, issue.resolution))
      result.passed = false
    }
  }

  // Figma nodeId 引用校验（条件性：仅当 hasFigmaDesign=true）
  // 从 validate-phase-gate.js 迁入 —— run.md 声称的"task 需带 figmaNodeId"硬门控此前从未在生效路径执行。
  // 取舍：引用了不存在的 frame → BLOCKER（明确错误）；Vue task 未绑 nodeId → WARNING（可能是纯逻辑改动）
  if (hasFigmaDesign(state)) {
    // 先校验 frame-inventory 内容完整性（id/name/link/type 等），残缺即 BLOCKER。
    // 存在性已由 checkPhaseArtifact 的 requiredWhen:'hasFigmaDesign' 覆盖，这里管内容。
    const ffiCheck = checkFigmaFrameInventory(storyId)
    if (ffiCheck.exists && !ffiCheck.valid) {
      for (const e of ffiCheck.errors) {
        result.blockers.push(structuredError(
          'figma_frame_incomplete',
          `figma-frame-inventory.json 不完整: ${e}`,
          2,
          'figma-frame-inventory.json 的每个 frame 必须包含 id/name/link/type 字段，缺一不可'
        ))
        result.passed = false
      }
    }

    const figmaRef = validateTaskFigmaReferences(storyId)
    for (const r of figmaRef.invalidRefs || []) {
      result.blockers.push(structuredError(
        'invalid_figma_ref',
        `Task ${r.taskId || ''} 引用的 figmaNodeId 无效: ${r.reason || JSON.stringify(r)}`,
        2,
        'task-dag.json 的 figmaNodeId 必须存在于 figma-frame-inventory.json 的 frames 中'
      ))
      result.passed = false
    }
    if ((figmaRef.unmatched || []).length > 0) {
      result.warnings.push(
        `${figmaRef.unmatched.length} 个含 .vue 文件的 Task 未绑定 figmaNodeId: ` +
        figmaRef.unmatched.map(u => `${u.taskId}(${u.title})`).join(', ')
      )
    }
  }
}

/**
 * Phase 2→3 门控: 增量 lint（编译校验默认关闭）
 *
 * 历史缺陷: Phase 2 此前无任何专项检查（PHASE_ARTIFACTS[2].fileName 为 null，
 *   产出物存在性检查被跳过），Phase 2→3 等价于无条件通过。结果是 SCSS
 *   `/deep/ ... ::after` 编译错误逃过全部本地门控，直到 Phase 7 云端构建才暴露。
 *
 * 设计取舍:
 *   - lint 只跑**本次变更文件**，避免仓库存量问题导致门控永久阻塞
 *   - 编译校验默认关闭: 构建无法增量，大项目/多项目单次耗时不可控（上限 900s），
 *     且 fix-loop 每轮回退 Phase 2 都会再触发一次全量构建，是流程阻塞的主因。
 *     需要时设 `HARNESS_RUN_BUILD=1` 显式启用。
 *   - 代价: 关闭后 SCSS/模板编译错误失去本地拦截，只能到 Phase 7 云端构建暴露
 *   - 未检测到变更时降级为 warning（可能代码已提交或本 Story 无代码改动），不误阻塞
 */
function checkPhase2Gate (storyId, state, result) {
  const repos = loadRepos(storyId)
  const repoNames = Object.keys(repos.repos || {})
  const targets = repoNames.length > 0 ? repoNames : [null]
  let anyChange = false
  let anyBuildScript = false

  for (const name of targets) {
    const repoRoot = getRepoRoot(name, repos)
    const label = name ? `[${name}] ` : ''
    if (!repoRoot || !fs.existsSync(repoRoot)) {
      // 不静默跳过：仓库路径配置错误会让门控失效，必须留痕
      result.warnings.push(`${label}仓库路径不存在，无法执行 lint/编译校验: ${repoRoot}（请检查 repos.json）`)
      continue
    }

    if (findBuildScript(repoRoot)) anyBuildScript = true

    const changed = getChangedFiles(repoRoot)
    if (changed.length === 0) continue
    anyChange = true

    // 1. 增量 lint
    const lintTargets = changed.filter(f => /\.(js|jsx|ts|tsx|vue)$/i.test(f))
    if (lintTargets.length > 0) {
      const lint = runIncrementalLint(repoRoot, lintTargets)
      // debug 载荷层：lint 原始结果留痕（命令输出只携带前 10 行 error，此处保留全量细节）
      debugLog.record(storyId, 'method_output', {
        method: 'runIncrementalLint',
        repo: name || 'primary',
        repoRoot,
        files: lintTargets,
        result: lint
      }, { source: 'policy.js', phase: 2 })
      if (lint.skipped) {
        result.warnings.push(`${label}未找到可用的 lint 工具，已跳过增量 lint 校验`)
      } else if (lint.hasErrors) {
        result.blockers.push(structuredError(
          'lint_error',
          `${label}本次变更文件存在 lint error:\n${lint.details}`,
          2,
          `在 ${repoRoot} 修复上述 lint error 后重新执行 ${ADVANCE_CMD} ${storyId} 3`
        ))
        result.passed = false
      }
    }

    // 2. 编译校验: 默认关闭，仅当显式设 HARNESS_RUN_BUILD=1 时执行
    if (process.env.HARNESS_RUN_BUILD === '1') {
      const build = runBuildCheck(repoRoot)
      // debug 载荷层：编译结果留痕（含 command 与末尾错误细节）
      debugLog.record(storyId, 'method_output', {
        method: 'runBuildCheck',
        repo: name || 'primary',
        repoRoot,
        result: build
      }, { source: 'policy.js', phase: 2 })
      if (build.skipped) {
        result.warnings.push(`${label}package.json 未找到可用的 build script，已跳过编译校验`)
      } else if (!build.ok) {
        result.blockers.push(structuredError(
          'build_failed',
          `${label}本地编译失败（${build.command}）:\n${build.details}`,
          2,
          `在 ${repoRoot} 执行 ${build.command} 复现并修复编译错误后重新执行 ${ADVANCE_CMD} ${storyId} 3`
        ))
        result.passed = false
      }
    }
  }

  if (!anyChange) {
    result.warnings.push('Phase 2 未检测到未提交的代码变更（可能已提交或本 Story 无代码改动），已跳过 lint 校验')
  }

  // 编译校验关闭是全局默认行为，与是否检测到变更无关，故在循环外只提示一次 ——
  // 放在循环内会随仓库数重复出现，淹没真正的 warning。
  // 前提：仓库确实有构建脚本。纯静态 / 无构建步骤的项目（如单个 HTML 页）根本不会触发
  // 编译错误，对它提示「SCSS/模板编译错误将只能在 Phase 7 暴露」是无差别噪音（2026-09 修正）。
  if (process.env.HARNESS_RUN_BUILD !== '1' && anyBuildScript) {
    result.warnings.push('编译校验默认关闭（设 HARNESS_RUN_BUILD=1 启用），SCSS/模板编译错误将只能在 Phase 7 云端构建暴露')
  }
}

/**
 * Phase 3→4 门控: code-review.json + 无 BLOCKER + fixLoop 提示
 * 注意：code-review.json 的文件存在性已由 runGateCheck 中的 checkPhaseArtifact 覆盖，
 *       此函数只负责内容检查（BLOCKER 数量等），避免重复采集。
 *       当检测到 BLOCKER 时，附加 fixLoopAvailable 标记供主 Agent 触发修复回路。
 */
function checkPhase3Gate (storyId, result) {
  const crJsonPath = path.join(PLANS_DIR, storyId, ARTIFACT.CODE_REVIEW)

  // 读取 code-review.json（唯一信源）
  if (!fs.existsSync(crJsonPath)) return

  try {
    const crData = JSON.parse(fs.readFileSync(crJsonPath, 'utf-8'))
    const openBlockers = (crData.issues || []).filter(
      i => i.severity === 'BLOCKER' && i.status === 'open'
    )
    if (openBlockers.length > 0) {
      for (const b of openBlockers) {
        result.blockers.push(structuredError(
          'code_review_blocker',
          `BLOCKER ${b.id}: ${b.title} (${b.file}${b.line ? ':' + b.line : ''})`,
          2,
          `执行修复回路: ${ADVANCE_CMD} ${storyId} 2 --fix-loop`
        ))
      }
      result.passed = false
    }

    // 修复回路上下文检查
    const fixRequestPath = path.join(PLANS_DIR, storyId, ARTIFACT.FIX_REQUEST)
    if (fs.existsSync(fixRequestPath)) {
      const fixVerificationPath = path.join(PLANS_DIR, storyId, ARTIFACT.FIX_VERIFICATION)
      if (!fs.existsSync(fixVerificationPath)) {
        result.warnings.push('修复回路复查: 缺少 fix-verification.json，开发者未产出修复核对报告')
      } else {
        try {
          const fv = JSON.parse(fs.readFileSync(fixVerificationPath, 'utf-8'))
          if (Array.isArray(fv.fixes)) {
            const skipped = fv.fixes.filter(f => f.status === 'skipped')
            if (skipped.length > 0) {
              result.warnings.push(`修复回路复查: ${skipped.length} 个问题被标记为 skipped，请审查师确认`)
            }
          }
        } catch (e) {
          result.warnings.push('修复回路复查: fix-verification.json 解析失败')
        }
      }
    }

    // 附加 fixLoopAvailable 标记
    if (!result.passed) {
      result._meta = result._meta || {}
      result._meta.fixLoopAvailable = true
      result._meta.fixLoopSource = 'phase3'
      result._meta.fixLoopHint = `${ADVANCE_CMD} ${storyId} 2 --fix-loop`
    }
  } catch (e) {
    result.blockers.push(structuredError(
      'code_review_blocker',
      `code-review.json 解析失败: ${e.message}`,
      4,
      '请检查 code-review.json 格式是否正确'
    ))
    result.passed = false
  }
}

/**
 * Spec-Anchored 契约回归检查
 * 验证 task-dag.json 声称的 files 是否都有对应的代码变更
 * @param {string} storyId
 * @returns {{ valid: boolean, errors: string[] }}
 */
function checkContractRegression (storyId) {
  const result = { valid: true, errors: [] }
  const taskData = readJsonArtifact(storyId, 'task-dag.json')
  if (!taskData || !Array.isArray(taskData.tasks)) return result
  const repos = loadRepos(storyId)

  // 检查每个 task 的 files 是否存在（优先用 task.repoPath，其次 task.repo/project 解析对应仓库根，缺省 primary）
  for (const task of taskData.tasks) {
    if (!Array.isArray(task.files)) continue
    // 跨项目 task 优先使用 repoPath（绝对路径），其次从 repos.json 解析
    const repoName = task.project || task.repo || repos.primary
    const repoRoot = task.repoPath || getRepoRoot(repoName, repos)
    for (const f of task.files) {
      const fullPath = path.join(repoRoot, f)
      if (!fs.existsSync(fullPath)) {
        result.errors.push(`Task ${task.id} 声明的文件 ${repoName}:${f} 不存在`)
        result.valid = false
      }
    }
  }

  return result
}

// ─── Phase 2 门控辅助: 变更采集 / lint / build ──────────────────

/**
 * 采集仓库内未提交的变更文件（相对仓库根的路径）
 * @param {string} repoRoot
 * @returns {string[]} 变更文件列表；非 git 仓库或异常时返回空数组
 */
function getChangedFiles (repoRoot) {
  try {
    const out = execSync('git status --porcelain', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      // maxBuffer 必须显式放大：Node 默认 1MB。正常仓库远达不到，但 .gitignore 一旦失效
      // 就会被轻易打满（本项目实测发生过两次：构建产物未忽略、.eslintrc-auto-import.json 被跟踪）。
      // 溢出抛 ENOBUFS → 旧实现静默 return [] → 门控认为「没有变更文件」从而完全跳过增量 lint，
      // 这是比误报更危险的静默放行。
      maxBuffer: 64 * 1024 * 1024
    })
    return out.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const p = l.replace(/^\S+\s+/, '')
        // 重命名 "old -> new" 取新路径
        return p.includes(' -> ') ? p.split(' -> ')[1] : p
      })
      .map(p => p.replace(/^"|"$/g, ''))
      .filter(p => !p.endsWith('/'))
  } catch (e) {
    // 「非 git 仓库」是预期情况，静默即可；其余异常必须可见 ——
    // 否则采集失败与「确实没有变更」不可区分，门控会静默退化为放行。
    const msg = String((e && e.message) || '')
    if (!/not a git repository/i.test(msg)) {
      console.error(`[policy] getChangedFiles 失败，增量 lint 将被跳过 (${repoRoot}): ${msg.split('\n')[0]}`)
    }
    return []
  }
}

/**
 * 对指定文件跑 eslint（只读，绝不带 --fix，避免门控层改动代码）
 * @param {string} repoRoot
 * @param {string[]} files - 相对仓库根的文件路径
 * @returns {{ hasErrors: boolean, details: string, skipped: boolean }}
 */
function runIncrementalLint (repoRoot, files) {
  if (!fs.existsSync(path.join(repoRoot, 'node_modules', 'eslint'))) {
    return { hasErrors: false, details: '', skipped: true }
  }
  const args = files.map(f => `"${f}"`).join(' ')
  let output = ''
  try {
    output = execSync(`npx eslint ${args} --format compact`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000,
      // maxBuffer 必须显式放大，且此处比 build 更隐蔽：eslint 有 error 时以非 0 退出，
      // 所以下方 catch 是「正常路径」，1MB 溢出不会引起任何怀疑 —— e.stdout 只剩被截断的
      // 前 1MB，超出部分的 Error 被静默丢弃，门控就会放行带 lint error 的代码。
      // compact 格式约 80~150 B/行，1MB ≈ 7000~12000 条消息。
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (e) {
    output = String(e.stdout || e.stderr || e.message || '')
    // ENOBUFS 表示输出被截断，此时「没扫到 Error」的结论不成立（缺证据，而非有反证）。
    // 与 runBuildCheck 相反，这里必须 fail-closed：build 的溢出有 exit 0 作为成功证据，
    // lint 的溢出什么证据都没有，静默放行的代价远高于让人手动复核一次。
    if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || '')))) {
      return {
        hasErrors: true,
        details: `eslint 输出超过 maxBuffer(64MB)，结果不完整，无法确认是否存在 error。\n仓库: ${repoRoot}\n请手动复核: npx eslint <变更文件> --format compact`,
        skipped: false
      }
    }
  }
  const errorLines = output.split('\n').filter(l => /:\s*line\s+\d+,\s*col\s+\d+,\s*Error\s+-/i.test(l))
  return {
    hasErrors: errorLines.length > 0,
    details: errorLines.slice(0, 10).join('\n'),
    skipped: false
  }
}

/**
 * 本地编译校验。优先使用 build:dev / build:test（比生产构建快），回退 build。
 * @param {string} repoRoot
 * @returns {{ ok: boolean, details: string, command: string, skipped: boolean }}
 */
/**
 * 探测仓库是否配置了可执行构建脚本（只探测，不执行构建）
 *
 * 供 runBuildCheck 执行前与 checkPhase2Gate 判断「是否值得提示编译校验关闭」共用 ——
 * 两处若各自维护脚本名优先级列表，一旦不同步就会出现「提示说有关闭的校验、实际执行时却跳过」的矛盾。
 *
 * @param {string} repoRoot - 仓库根目录绝对路径
 * @returns {string|null} 构建脚本名（build:dev / build:test / build 中首个存在的），无则 null
 */
function findBuildScript (repoRoot) {
  const pkgPath = path.join(repoRoot, 'package.json')
  if (!fs.existsSync(pkgPath)) return null

  let scripts = {}
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts || {}
  } catch (e) {
    return null
  }
  return ['build:dev', 'build:test', 'build'].find(s => scripts[s]) || null
}

function runBuildCheck (repoRoot) {
  const name = findBuildScript(repoRoot)
  if (!name) return { ok: true, details: '', command: '', skipped: true }

  const command = `npm run ${name}`
  try {
    execSync(command, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 900000,
      // maxBuffer 必须显式放大：Node 默认 1MB，而中大型前端项目的构建日志轻易超过它
      // （实测 userlive `vue-cli-service build --mode production` 输出 5.33MB / 35487 行，
      //   其中 7778 条是 mini-css-extract-plugin 的 chunk order 警告 —— 构建 exit 0 完全成功）。
      // 溢出时 execSync 抛 ENOBUFS 被下方 catch 捕获，会把「构建成功」误判成「编译失败」，
      // 且 details 只取末尾 25 行，呈现出的是无害警告，导致排查方向被完全带偏。
      maxBuffer: 64 * 1024 * 1024
    })
    return { ok: true, details: '', command, skipped: false }
  } catch (e) {
    // ENOBUFS 单独识别：它表示输出超限而非编译失败，不应判定为 build 失败
    if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message || '')))) {
      return {
        ok: true,
        details: '',
        command,
        skipped: false,
        bufferOverflow: true
      }
    }
    const output = String(e.stdout || '') + '\n' + String(e.stderr || e.message || '')
    const lines = output.split('\n').filter(l => l.trim())
    return { ok: false, details: lines.slice(-25).join('\n'), command, skipped: false }
  }
}

module.exports = {
  RECOVERY_SUGGESTIONS,
  runGateCheck,
  checkPhase0Gate,
  checkPhase1Gate,
  checkPhase3Gate,
  checkContractRegression,
  matchRecoverySuggestion
}
