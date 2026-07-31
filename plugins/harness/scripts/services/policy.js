#!/usr/bin/env node
/**
 * policy.js — 风险门控层 (Policy Runtime)
 *
 * 三层解耦中的"门控层"——独立于编排逻辑，是推理链条之外不受污染的检查点。
 * 职责: 产出物校验 + 契约一致性 + 权限边界 + 错误恢复建议
 *
 * v2.0: 结构化 blocker — 每个 blocker 携带 failureType，
 *       直接用于经验沉淀，无需从文本关键词反推类型。
 *       兜底: 无匹配类型 → 'unknown' → 自动沉淀 + 人工补录。
 *
 * 设计原则 (来自腾讯云 MAS Harness 文章):
 *   - 门控层的价值在于它是整条 agent 推理链条之外不受链条污染的决策节点
 *   - 硬性规则不可绕过 (数据访问边界、操作黑名单)
 *   - 软性规则触发审批/降级 (风险评分、低置信度二次确认)
 *   - 动态规则来自经验沉淀 (历史失败模式)
 *
 * @module policy
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  checkPhaseArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  checkAcceptanceVerification,
  validateContractReferences,
  checkFigmaFrameInventory,
  hasFigmaDesign,
  readJsonArtifact,
  getStoryDir,
  getPhaseName,
  loadRepos,
  getRepoRoot,
  structuredError,
  errorToString,
  errorToType
} = require('../lib/state')

const schemaValidator = require('./schema-validator')

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
  // Phase 0→1: open-questions 有未解决项
  open_questions_unresolved: {
    level: 3,
    action: '逐项确认 open-questions 中的问题并更新 resolved 字段',
    autoFixable: false
  },
  // Phase 0→1: Figma frame 缺少 id/name/link
  figma_frame_incomplete: {
    level: 2,
    action: '每个 Figma frame 必须有 id、name、link 字段',
    autoFixable: false
  },
  // Phase 1→2: task-dag 字段名错误 (name→title)
  task_field_name: {
    level: 1,
    action: 'task-dag.json 中应使用 "title" 而非 "name"',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'task-dag.json')
      if (!data || !Array.isArray(data.tasks)) return false
      let fixed = false
      for (const t of data.tasks) {
        if (t.name && !t.title) { t.title = t.name; delete t.name; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'task-dag.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
  },
  // Phase 1→2: task 缺少 id
  task_missing_id: {
    level: 2,
    action: '为每个 task 添加唯一 id 字段',
    autoFixable: false
  },
  // Phase 1→2: task 缺少 title
  task_missing_title: {
    level: 1,
    action: '为每个 task 添加 title 字段（使用 title 而非 name）',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'task-dag.json')
      if (!data || !Array.isArray(data.tasks)) return false
      let fixed = false
      for (const t of data.tasks) {
        if (t.name && !t.title) { t.title = t.name; delete t.name; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'task-dag.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
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
  // Phase 3→4: code-review 含 BLOCKER 关键词
  code_review_blocker: {
    level: 2,
    action: '执行修复回路将问题回退给前端开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 3→4: code-review.json 不存在
  code_review_missing: {
    level: 4,
    action: '需先 spawn 代码审查师 (code-reviewer) 产出 code-review.json',
    autoFixable: false
  },
  // Phase 4→5: evidence 字符串→数组
  evidence_not_array: {
    level: 1,
    action: 'acceptance-verification.json 中 evidence 应为字符串数组',
    autoFixable: true,
    autoFix: function (storyId) {
      const data = readJsonArtifact(storyId, 'acceptance-verification.json')
      if (!data || !Array.isArray(data.results)) return false
      let fixed = false
      // 修复字段名: verificationResults → results, acId → id
      if (data.verificationResults && !data.results) {
        data.results = data.verificationResults; delete data.verificationResults; fixed = true
      }
      if (!Array.isArray(data.results)) return false
      for (const r of data.results) {
        if (r.acId && !r.id) { r.id = r.acId; delete r.acId; fixed = true }
        if (typeof r.evidence === 'string') { r.evidence = [r.evidence]; fixed = true }
      }
      if (fixed) {
        const filePath = path.join(getStoryDir(storyId), 'acceptance-verification.json')
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
      }
      return fixed
    }
  },
  // Phase 4→5: AC 验收未通过
  ac_verification_failed: {
    level: 2,
    action: '验收标准未通过，执行修复回路将问题回退给前端开发工程师修复',
    autoFixable: false,
    resolution: 'advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 4→5: AC 缺少验收结果
  ac_missing_verification: {
    level: 4,
    action: '每条验收标准必须有对应的验收结果',
    autoFixable: false
  },
  // Phase 4→5: AV 缺少 id 字段
  av_missing_id: {
    level: 2,
    action: 'acceptance-verification.json 每条 result 必须有 id 字段',
    autoFixable: false
  },
  // Phase 4→5: AV 缺少 evidence
  av_missing_evidence: {
    level: 2,
    action: 'acceptance-verification.json 每条 result 必须有 evidence 数组',
    autoFixable: false
  },
  // 产出物缺失
  artifact_missing: {
    level: 4,
    action: '请先完成对应 Phase 的产出物',
    autoFixable: false
  },
  // Phase 3/4 修复回路：代码审查发现 BLOCKER → 回退 Phase 2
  fix_loop_code_review: {
    level: 2,
    action: '代码审查发现 BLOCKER，执行修复回路回退到 Phase 2 由前端开发工程师修复',
    autoFixable: false,
    resolution: 'node advance-phase.js <storyId> 2 --fix-loop'
  },
  // Phase 3/4 修复回路：功能测试失败 → 回退 Phase 2
  fix_loop_test_failed: {
    level: 2,
    action: '功能测试未通过，执行修复回路回退到 Phase 2 由前端开发工程师修复',
    autoFixable: false,
    resolution: 'node advance-phase.js <storyId> 2 --fix-loop'
  },
  // 修复回路耗尽：已达最大轮次
  fix_loop_exhausted: {
    level: 4,
    action: '已达最大修复轮次 (2)，需人工介入：1)人工评审剩余BLOCKER 2)联系需求分析师确认AC 3)联系任务规划师重新拆解',
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
  if (lower.includes('缺少 title') || lower.includes('"name"')) return RECOVERY_SUGGESTIONS.task_field_name
  if (lower.includes('evidence')) return RECOVERY_SUGGESTIONS.evidence_not_array
  if (lower.includes('blocker')) return RECOVERY_SUGGESTIONS.code_review_blocker
  if (lower.includes('acceptancecriteria') && lower.includes('空')) return RECOVERY_SUGGESTIONS.empty_ac_ref

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

  // 1. 产出物存在性检查
  const artifact = checkPhaseArtifact(storyId, phaseNum)
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
    checkPhase1Gate(storyId, result)
  } else if (phaseNum === 3) {
    checkPhase3Gate(storyId, result)
  } else if (phaseNum === 4) {
    checkPhase4Gate(storyId, result)
  }

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
 * Phase 0→1 门控: AC + 双源 open-questions + Figma
 */
function checkPhase0Gate (storyId, state, result) {
  // 验收标准 — 将 errors 字符串转为结构化 blocker
  // 注意：acceptance-criteria.json 的文件存在性已由 checkPhaseArtifact 覆盖，
  //       此处 checkAcceptanceCriteria 返回 exists=false 时不重复记录，只处理内容错误
  const acCheck = checkAcceptanceCriteria(storyId)
  if (acCheck.exists && !acCheck.valid) {
    for (const e of acCheck.errors) {
      // 从 error 文本推断 failureType
      const lower = String(e).toLowerCase()
      let type = 'ac_format_error'
      let level = 2
      let resolution = '检查 acceptance-criteria.json 格式'

      if (lower.includes('缺少 id') || lower.includes('缺少id')) {
        type = 'ac_missing_id'
        resolution = '为每条验收标准添加唯一 id 字段'
      } else if (lower.includes('缺少 description') || lower.includes('缺少description')) {
        type = 'ac_missing_description'
        resolution = '为每条验收标准添加 description 字段'
      } else if (lower.includes('为空') || lower.includes('至少')) {
        type = 'ac_empty_criteria'
        resolution = 'criteria 数组至少需要 1 条验收标准'
      } else if (lower.includes('重复') && lower.includes('id')) {
        type = 'ac_duplicate_id'
        resolution = '验收标准 ID 必须唯一，请检查并修正重复 ID'
      } else if (lower.includes('不存在')) {
        type = 'ac_format_error'
        level = 4
        resolution = 'acceptance-criteria.json 文件不存在，请先产出此文件'
      } else if (lower.includes('解析失败')) {
        type = 'ac_format_error'
        resolution = 'JSON 格式错误，请检查文件内容'
      }

      const blocker = structuredError(type, String(e), level, resolution)
      result.blockers.push(blocker)
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

  // Figma frame inventory — 将 errors 转为结构化 blocker
  if (hasFigmaDesign(state)) {
    const figmaCheck = checkFigmaFrameInventory(storyId)
    if (!figmaCheck.valid) {
      for (const e of figmaCheck.errors) {
        const lower = String(e).toLowerCase()
        let type = 'figma_frame_incomplete'
        let level = 2
        let resolution = '每个 Figma frame 必须有 id、name、link 字段'

        if (lower.includes('不存在') || lower.includes('缺少')) {
          type = 'figma_frame_incomplete'
          level = 4
          resolution = '如有 Figma 设计稿，Phase 0 必须产出 figma-frame-inventory.json'
        } else if (lower.includes('缺少 id')) {
          type = 'figma_frame_incomplete'
          resolution = '每个 frame 必须有 Figma node ID（如 "3020:83533"）'
        } else if (lower.includes('缺少 link')) {
          type = 'figma_frame_incomplete'
          resolution = '每个 frame 必须有完整 Figma node URL'
        }

        result.blockers.push(structuredError(type, String(e), level, resolution))
        result.passed = false
      }
    }
  }
}

/**
 * Phase 1→2 门控: task-dag + AC↔Task 交叉引用
 */
function checkPhase1Gate (storyId, result) {
  const taskCheck = checkTaskDagJson(storyId)
  if (!taskCheck.valid) {
    for (const e of taskCheck.errors) {
      const lower = String(e).toLowerCase()
      let type = 'unknown'
      let level = 2
      let resolution = '需人工分析此错误模式'

      if (lower.includes('缺少 id') && lower.includes('task')) {
        type = 'task_missing_id'
        resolution = '为每个 task 添加唯一 id 字段'
      } else if (lower.includes('缺少 title') || lower.includes('"name"')) {
        type = 'task_missing_title'
        level = 1
        resolution = '为每个 task 添加 title 字段（使用 title 而非 name）'
      } else if (lower.includes('acceptancecriteria') && lower.includes('空') || lower.includes('缺少')) {
        type = 'empty_ac_ref'
        resolution = '每个 task 的 acceptanceCriteria 至少引用 1 条 AC'
      } else if (lower.includes('重复') && lower.includes('task') && lower.includes('id')) {
        type = 'task_duplicate_id'
        resolution = 'Task ID 必须唯一'
      } else if (lower.includes('不存在')) {
        type = 'artifact_missing'
        level = 4
        resolution = 'task-dag.json 文件不存在，请先产出此文件'
      } else if (lower.includes('解析失败')) {
        type = 'json_parse_error'
        resolution = 'JSON 格式错误，请检查 task-dag.json'
      } else if (lower.includes('为空') && lower.includes('tasks')) {
        type = 'empty_ac_ref'
        resolution = 'tasks 数组不能为空'
      }

      result.blockers.push(structuredError(type, String(e), level, resolution))
      result.passed = false
    }
  }

  const refCheck = validateContractReferences(storyId)

  // 传递交叉引用校验的 warnings（格式漂移等诊断信息）
  if (refCheck.warnings && refCheck.warnings.length > 0) {
    result.warnings.push(...refCheck.warnings)
  }

  if (!refCheck.valid) {
    for (const e of refCheck.errors) {
      const lower = String(e).toLowerCase()
      let type = 'unknown'
      let level = 2
      let resolution = '需人工分析此错误模式'

      if (lower.includes('未被') && lower.includes('引用') && lower.includes('验收')) {
        type = 'orphan_ac'
        resolution = '每条验收标准至少被 1 个 Task 引用'
      } else if (lower.includes('不存在') && lower.includes('ac')) {
        type = 'invalid_ac_ref'
        resolution = 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在'
      } else if (lower.includes('均不存在')) {
        type = 'invalid_ac_ref'
        level = 4
        resolution = 'acceptance-criteria.json 和 task-dag.json 均不存在'
      }

      result.blockers.push(structuredError(type, String(e), level, resolution))
      result.passed = false
    }
  }
}

/**
 * Phase 3→4 门控: code-review.json + 无 BLOCKER + fixLoop 提示
 * 注意：code-review.json 的文件存在性已由 runGateCheck 中的 checkPhaseArtifact 覆盖，
 *       此函数只负责内容检查（BLOCKER 数量等），避免重复采集。
 *       当检测到 BLOCKER 时，附加 fixLoopAvailable 标记供主 Agent 触发修复回路。
 */
function checkPhase3Gate (storyId, result) {
  const crJsonPath = path.join(PLANS_DIR, storyId, 'code-review.json')

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
          `执行修复回路: advance-phase.js ${storyId} 2 --fix-loop`
        ))
      }
      result.passed = false
    }

    // 修复回路上下文检查
    const fixRequestPath = path.join(PLANS_DIR, storyId, 'fix-request.json')
    if (fs.existsSync(fixRequestPath)) {
      const fixVerificationPath = path.join(PLANS_DIR, storyId, 'fix-verification.json')
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
      result._meta.fixLoopHint = `advance-phase.js ${storyId} 2 --fix-loop`
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
 * Phase 4→5 门控: acceptance-verification + Spec-Anchored 契约回归检查 + fixLoop 提示
 * 注意：acceptance-verification.json 的文件存在性已由 runGateCheck 中的 checkPhaseArtifact 覆盖，
 *       此函数只负责内容检查（AC 通过率、evidence 等），避免重复采集。
 *       当检测到 failed 时，附加 fixLoopAvailable 标记供主 Agent 触发修复回路。
 */
function checkPhase4Gate (storyId, result) {
  const avCheck = checkAcceptanceVerification(storyId)
  // 文件不存在时由 checkPhaseArtifact 统一记录 artifact_missing，此处跳过避免重复
  if (!avCheck.exists) return

  let hasFailure = false

  // failed 状态 → BLOCKER (L2: 触发修复回路)
  for (const f of avCheck.failed) {
    result.blockers.push(structuredError(
      'ac_verification_failed',
      `AC ${f.id}: ${f.status}`,
      2,
      `验收标准 ${f.id} 未通过，执行修复回路: advance-phase.js ${storyId} 2 --fix-loop`
    ))
    result.passed = false
    hasFailure = true
  }

  // unverifiable 状态 → WARNING（不阻塞，降级通过）
  for (const u of avCheck.unverifiable) {
    result.warnings.push(`AC ${u.id}: unverifiable（跨项目或环境限制，代码逻辑已验证）`)
  }

  // AV 内部校验错误 → 结构化
  for (const e of avCheck.errors) {
    const lower = String(e).toLowerCase()
    let type = 'unknown'
    let level = 2
    let resolution = '需人工分析'

    if (lower.includes('缺少 id') || lower.includes('缺少id')) {
      type = 'av_missing_id'
      resolution = '每条 result 必须有 id 字段（对应 AC ID）'
    } else if (lower.includes('缺少 evidence') || lower.includes('缺少evidence')) {
      type = 'av_missing_evidence'
      resolution = '每条 result 必须有 evidence 数组（至少 1 条）'
    } else if (lower.includes('缺少验收结果') || lower.includes('缺少')) {
      type = 'ac_missing_verification'
      level = 4
      resolution = '每条验收标准必须有对应的验收结果'
    } else if (lower.includes('缺少 results')) {
      type = 'ac_verification_failed'
      level = 4
      resolution = 'acceptance-verification.json 必须有 results 数组'
    } else if (lower.includes('unverifiable 比例')) {
      type = 'ac_verification_failed'
      level = 4
      resolution = 'unverifiable 比例超过 50%，需补充跨项目验证'
    }

    result.blockers.push(structuredError(type, String(e), level, resolution))
    result.passed = false
  }

  // Spec-Anchored: 契约回归检查
  const contractCheck = checkContractRegression(storyId)
  if (!contractCheck.valid) {
    for (const e of contractCheck.errors) {
      result.warnings.push(`Spec-Anchored: ${e}`)
    }
  }

  // 附加 fixLoopAvailable 标记（供主 Agent 判断是否需要修复回路）
  if (hasFailure) {
    result._meta = result._meta || {}
    result._meta.fixLoopAvailable = true
    result._meta.fixLoopSource = 'phase4'
    result._meta.fixLoopHint = `advance-phase.js ${storyId} 2 --fix-loop`
  }

  // open-questions 检查: Phase 4→5 提交前提醒未 resolve 的问题
  const oqCheck = checkOpenQuestions(storyId)
  if (oqCheck.exists && oqCheck.unresolvedCount > 0) {
    const unresolvedList = oqCheck.unresolved.map(q => `${q.id}: ${q.question}`).join('; ')
    result.warnings.push(
      `open-questions.json 中有 ${oqCheck.unresolvedCount} 个未 resolve 的问题: ${unresolvedList}。` +
      '需后端配合的问题请标记 resolved:true + resolution:"前端已预留，待后端配合"；前端可确认的问题请在开发过程中确认并标记 resolved'
    )
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

// ─── 错误恢复执行 ───────────────────────────────────────────────

/**
 * 尝试自动修复门控失败
 * @param {string} storyId
 * @param {Array} recoveries - 恢复建议列表
 * @returns {{ fixed: boolean, fixedCount: number, details: string[] }}
 */
function attemptAutoRecovery (storyId, recoveries) {
  const details = []
  let fixedCount = 0

  for (const r of recoveries) {
    if (!r.suggestion || !r.suggestion.autoFixable || !r.suggestion.autoFix) continue

    try {
      const fixed = r.suggestion.autoFix(storyId)
      if (fixed) {
        fixedCount++
        details.push(`✅ 自动修复: ${r.suggestion.action}`)
      }
    } catch (e) {
      details.push(`❌ 自动修复失败: ${r.suggestion.action} - ${e.message}`)
    }
  }

  return { fixed: fixedCount > 0, fixedCount, details }
}

module.exports = {
  RECOVERY_SUGGESTIONS,
  runGateCheck,
  checkPhase0Gate,
  checkPhase1Gate,
  checkPhase3Gate,
  checkPhase4Gate,
  checkContractRegression,
  matchRecoverySuggestion,
  attemptAutoRecovery
}
