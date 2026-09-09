/**
 * contracts.js — 契约 JSON 的读取与结构校验
 *
 * 职责:
 *   - 契约文件名常量（值取自 lib/artifacts.js 的 ARTIFACT 表，此处保留同名常量
 *     只为让既有 import 一行不动）
 *   - readJsonArtifact: Story 目录下任意 JSON 契约的统一读取
 *   - check*: acceptance-criteria / open-questions / task-dag /
 *     AC↔Task 交叉引用校验
 *
 * 用法:
 *   const { checkTaskDagJson, readJsonArtifact } = require('./contracts')
 *
 * 使用场景:
 *   - 门控: services/policy.js 在每次 Phase 推进前调用这套 check 裁定能否推进
 *   - 人工诊断: audit/harness-audit.js 复用同一套校验，保证诊断与门控口径一致
 *   - dev-pass 限域: task-dag.json 的 files[] 是限域的唯一来源
 *
 * 说明:
 *   - 所有 check* 都返回结构化结果（不抛异常），由调用方决定是阻塞还是告警：
 *     这是「门控只裁定、不写状态」的前提。
 *   - 读不到文件返回 null、解析失败返回 `{ _parseError }`，调用方按此区分。
 *   - checkTaskDagJson 里的跨项目 task 校验（repoPath / 行号引用）
 *     是 2026-09 陆续补上的门控，起因是跨仓改动多次落到错误的仓库。
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { loadRepos } = require('./repos')

/**
 * 契约 JSON 文件名 —— 值统一取自 lib/artifacts.js 的 ARTIFACT 表。
 * 这里保留同名常量并继续导出，是为了让现有调用方的 import 一行不动。
 */
const ACCEPTANCE_CRITERIA_FILE = ARTIFACT.ACCEPTANCE_CRITERIA
const OPEN_QUESTIONS_FILE = ARTIFACT.OPEN_QUESTIONS
const TASK_DAG_JSON_FILE = ARTIFACT.TASK_DAG_JSON

/**
 * Story 原始输入契约文件名
 *
 * 主 Agent 从用户消息提取参数写入此文件后即完成职责，不做任何分析。
 * 需求分析师在 Phase 0 读取它，自行决定检索策略（含 fixbugs 模式下调用
 * tapd-bug-analyzer skill）。这样「分析」始终发生在需求分析师上下文内，
 * 不会因跨 Agent 传递而丢失中间推理。
 */
const STORY_INPUT_FILE = ARTIFACT.STORY_INPUT

/** 🌐 Figma 设计稿清单文件名 */
const FIGMA_FRAME_INVENTORY_FILE = ARTIFACT.FIGMA_FRAME_INVENTORY

/**
 * 读取 Story 目录下的 JSON 契约文件
 * @param {string} storyId - Story ID
 * @param {string} fileName - JSON 文件名（如 'acceptance-criteria.json'）
 * @returns {Object|null} 解析后的 JSON，文件不存在或解析失败返回 null
 */
function readJsonArtifact (storyId, fileName) {
  const filePath = path.join(getStoryDir(storyId), fileName)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 记录一条结构化校验问题
 *
 * 双写设计: issues 带 type/level/resolution 供 policy.js 直接转成 blocker，
 * errors 同步写入纯字符串供既有外部消费者（harness-audit.js / validate-contracts.js /
 * dispatch.js / __tests__）读取 —— 这些消费者只读字符串，改结构会波及它们。
 * 双写保证两者永不漂移，且省去在每个 return 前做 errors = issues.map(i => i.message)。
 *
 * @param {Object} result - check* 函数的累积结果对象（须含 issues[] 与 errors[]）
 * @param {string} type - failureType，必须与 policy.js 的 RECOVERY_SUGGESTIONS key 对齐
 * @param {string} message - 中文人读描述
 * @param {number} [level=2] - 恢复等级: 1=自动修复 2=提示修复 3=降级通过 4=阻止并人工介入
 * @param {string} [resolution=''] - 给 Agent 的修复建议
 * @returns {void}
 */
function pushIssue (result, type, message, level = 2, resolution = '') {
  result.issues.push({ type, message, level, resolution })
  result.errors.push(message)
}

/**
 * 检查验收标准契约 (acceptance-criteria.json) 是否完整
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, count: number, issues: Array, errors: string[] }}
 */
function checkAcceptanceCriteria (storyId) {
  const result = { exists: false, valid: false, count: 0, issues: [], errors: [] }
  const data = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)

  if (!data) {
    // 不可达: policy.js 有 exists 守卫前置，此处仅为函数被独立调用时保持语义完整
    pushIssue(result, 'ac_format_error', `${ACCEPTANCE_CRITERIA_FILE} 不存在`, 4, 'acceptance-criteria.json 文件不存在，请先产出此文件')
    return result
  }
  if (data._parseError) {
    pushIssue(result, 'ac_format_error', `JSON 解析失败: ${data._parseError}`, 2, 'JSON 格式错误，请检查文件内容')
    return result
  }

  result.exists = true

  // 检查 criteria 数组
  if (!Array.isArray(data.criteria)) {
    pushIssue(result, 'ac_format_error', '缺少 criteria 数组', 2, '检查 acceptance-criteria.json 格式')
  } else {
    result.count = data.criteria.length
    if (result.count === 0) {
      pushIssue(result, 'ac_empty_criteria', 'criteria 数组为空，至少需要 1 条验收标准', 2, 'criteria 数组至少需要 1 条验收标准')
    }
    // 检查每条 AC 的必填字段
    for (let i = 0; i < data.criteria.length; i++) {
      const ac = data.criteria[i]
      if (!ac.id) pushIssue(result, 'ac_missing_id', `AC[${i}]: 缺少 id`, 2, '为每条验收标准添加唯一 id 字段')
      if (!ac.description) pushIssue(result, 'ac_missing_description', `AC[${i}]: 缺少 description`, 2, '为每条验收标准添加 description 字段')
    }
    // 检查 ID 唯一性
    const ids = data.criteria.map(c => c.id).filter(Boolean)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dupes.length > 0) {
      pushIssue(result, 'ac_duplicate_id', `重复的 AC ID: ${[...new Set(dupes)].join(', ')}`, 2, '验收标准 ID 必须唯一，请检查并修正重复 ID')
    }
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 检查待确认项契约 (open-questions.json) 是否全部已解决
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, allResolved: boolean, unresolved: Array, errors: string[] }}
 */
function checkOpenQuestions (storyId) {
  const result = { exists: false, allResolved: false, unresolved: [], errors: [] }
  const data = readJsonArtifact(storyId, OPEN_QUESTIONS_FILE)

  if (!data) {
    result.errors.push(`${OPEN_QUESTIONS_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.questions)) {
    result.errors.push('缺少 questions 数组')
    return result
  }

  // resolved 的契约类型是 boolean（见 schemas/open-questions.schema.json）。
  // 用 !== true 而非 !q.resolved: resolved: 1 / "yes" 这类非法值不该被当作已解决。
  result.unresolved = data.questions.filter(q => q && q.resolved !== true)
  result.allResolved = result.unresolved.length === 0

  if (!result.allResolved) {
    result.errors.push(`${result.unresolved.length} 项待确认问题未解决`)
  }

  return result
}

/**
 * 检查任务 DAG 契约 (task-dag.json) 是否完整
 * 验证: 每个 task 必须有 acceptanceCriteria 引用 + files 非空
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, tasks: Array, errors: string[], warnings: string[] }}
 */
function checkTaskDagJson (storyId) {
  const result = { exists: false, valid: false, tasks: [], issues: [], errors: [], warnings: [] }
  const data = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!data) {
    pushIssue(result, 'artifact_missing', `${TASK_DAG_JSON_FILE} 不存在`, 4, 'task-dag.json 文件不存在，请先产出此文件')
    return result
  }
  if (data._parseError) {
    pushIssue(result, 'json_parse_error', `JSON 解析失败: ${data._parseError}`, 2, 'JSON 格式错误，请检查 task-dag.json')
    return result
  }

  result.exists = true

  if (!Array.isArray(data.tasks)) {
    pushIssue(result, 'empty_ac_ref', '缺少 tasks 数组', 2, '每个 task 的 acceptanceCriteria 至少引用 1 条 AC')
    return result
  }

  result.tasks = data.tasks
  if (data.tasks.length === 0) {
    pushIssue(result, 'empty_ac_ref', 'tasks 数组为空', 2, 'tasks 数组不能为空')
  }

  for (let i = 0; i < data.tasks.length; i++) {
    const task = data.tasks[i]
    const prefix = `Task[${task.id || i}]`

    // 检查必填字段
    if (!task.id) pushIssue(result, 'task_missing_id', `${prefix}: 缺少 id`, 2, '为每个 task 添加唯一 id 字段')
    if (!task.title) pushIssue(result, 'task_missing_title', `${prefix}: 缺少 title`, 2, '为每个 task 添加 title 字段（使用 title 而非 name）')

    // 检查 acceptanceCriteria 引用
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      pushIssue(result, 'empty_ac_ref', `${prefix}: 缺少 acceptanceCriteria 引用（至少需关联 1 条验收标准）`, 2, '每个 task 的 acceptanceCriteria 至少引用 1 条 AC')
    }

    // 检查 files 范围（用于 dev-pass 限域）
    if (!Array.isArray(task.files) || task.files.length === 0) {
      result.warnings.push(`${prefix}: files 为空，dev-pass 将降级为 src/** 全局授权（高风险）`)
    }

    // 跨项目 task 校验：有 project 字段时必须有 repoPath
    if (task.project && task.project !== repos.primary && !task.repoPath) {
      pushIssue(result, 'task_missing_repo_path', `${prefix}: 跨项目 task (project=${task.project}) 必须指定 repoPath`, 2, '跨项目 task（project ≠ 主仓）必须指定 repoPath，否则 dev-pass 无法把改动定位到正确仓库')
    }

    // 跨项目 task 强制细化：description 必须包含行号引用
    if (task.project && task.project !== repos.primary) {
      // 检查是否有 description 字段且包含行号格式（如 L123 或 L12-L45）
      const desc = task.description || ''
      if (!desc) {
        pushIssue(result, 'task_missing_description', `${prefix}: 跨项目 task 必须有 description 字段`, 2, '跨项目 task 必须有 description 字段（含行号引用）')
      } else if (!/L\d+/i.test(desc) && !/\bline\s*\d+/i.test(desc)) {
        pushIssue(result, 'task_missing_line_ref', `${prefix}: 跨项目 task description 必须包含行号引用（如 L123 或 line 45）`, 2, '跨项目 task 的 description 必须包含行号引用（如 L123 或 line 45）')
      }
    }
  }

  // 检查 ID 唯一性
  const ids = data.tasks.map(t => t.id).filter(Boolean)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) {
    pushIssue(result, 'task_duplicate_id', `重复的 Task ID: ${[...new Set(dupes)].join(', ')}`, 2, 'Task ID 必须唯一')
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 验证 AC↔Task 交叉引用完整性
 * 每条 AC 至少被 1 个 Task 引用；每个 Task 引用的 AC 都存在
 * @param {string} storyId - Story ID
 * @returns {{ valid: boolean, orphanACs: string[], invalidRefs: Array, errors: string[] }}
 */
function validateContractReferences (storyId) {
  const result = { valid: false, orphanACs: [], invalidRefs: [], issues: [], errors: [], warnings: [] }

  const acData = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)

  // 两个契约文件都不存在 → 无法验证
  if (!acData && !taskData) {
    pushIssue(result, 'invalid_ac_ref', 'acceptance-criteria.json 和 task-dag.json 均不存在，无法验证交叉引用', 2, 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在')
    return result
  }

  if (acData && !acData._parseError && Array.isArray(acData.criteria)) {
    const allACIds = acData.criteria.map(c => c.id).filter(Boolean)
    const referencedACIds = new Set()
    /** @type {Array<{taskId:string, rawValue:string, normalizedId:string}>} */
    const formatDrifts = [] // 追踪 AC 引用格式漂移（如 "AC-1: 描述" 而非 "AC-1"）

    if (taskData && !taskData._parseError && Array.isArray(taskData.tasks)) {
      for (const task of taskData.tasks) {
        if (Array.isArray(task.acceptanceCriteria)) {
          for (const rawAcId of task.acceptanceCriteria) {
            // 容错：从 "AC-1: 描述文本" 格式中提取纯 ID
            const normalizedId = typeof rawAcId === 'string'
              ? rawAcId.split(':')[0].trim()
              : String(rawAcId)
            const hasFormatDrift = normalizedId !== rawAcId

            if (hasFormatDrift) {
              formatDrifts.push({ taskId: task.id, rawValue: rawAcId, normalizedId })
            }

            referencedACIds.add(normalizedId)
            // 检查引用的 AC 是否存在（使用归一化后的 ID）
            if (!allACIds.includes(normalizedId)) {
              result.invalidRefs.push({ taskId: task.id, referencedAC: rawAcId, reason: '引用的 AC ID 不存在' })
            }
          }
        }
      }
    }

    // 格式漂移：从 warning 升级为 error（blocker），强制 Agent 修复 task-dag.json
    // 避免格式问题传播到下游，减少后续 Story 重复出现
    if (formatDrifts.length > 0) {
      const driftedTaskIds = [...new Set(formatDrifts.map(d => d.taskId))]
      pushIssue(
        result,
        'ac_ref_format_drift',
        `检测到 ${formatDrifts.length} 处 AC 引用格式漂移（Task: ${driftedTaskIds.join(', ')}），` +
        'acceptanceCriteria 必须使用纯 ID（如 "AC-1"）而非 "AC-1: 描述"。请修复 task-dag.json 后重新提交。' +
        `（示例: 将 "${formatDrifts[0].rawValue}" 改为 "${formatDrifts[0].normalizedId}"）`,
        3,
        'acceptanceCriteria 必须使用纯 AC ID（如 "AC-1"），不能写成 "AC-1: 描述文本"'
      )
    }

    // 找出未被任何 Task 引用的孤立 AC
    result.orphanACs = allACIds.filter(id => !referencedACIds.has(id))
    if (result.orphanACs.length > 0) {
      pushIssue(result, 'orphan_ac', `${result.orphanACs.length} 条验收标准未被任何 Task 引用: ${result.orphanACs.join(', ')}`, 2, '每条验收标准至少被 1 个 Task 引用，请检查 task-dag.json 的 acceptanceCriteria')
    }
  }

  if (result.invalidRefs.length > 0) {
    for (const r of result.invalidRefs) {
      pushIssue(result, 'invalid_ac_ref', `Task ${r.taskId} 引用了不存在的 AC: ${r.referencedAC}`, 2, 'Task 引用的 AC ID 必须在 acceptance-criteria.json 中存在')
    }
  }

  result.valid = result.errors.length === 0
  return result
}

module.exports = {
  ACCEPTANCE_CRITERIA_FILE,
  OPEN_QUESTIONS_FILE,
  TASK_DAG_JSON_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  STORY_INPUT_FILE,
  readJsonArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
}
