/**
 * contracts.js — 契约 JSON 的读取与结构校验
 *
 * 职责:
 *   - 契约文件名常量（值取自 lib/artifacts.js 的 ARTIFACT 表，此处保留同名常量
 *     只为让既有 import 一行不动）
 *   - readJsonArtifact: Story 目录下任意 JSON 契约的统一读取
 *   - check*: acceptance-criteria / open-questions / task-dag /
 *     acceptance-verification 的结构校验，以及 AC↔Task 交叉引用校验
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
 *   - checkTaskDagJson 里的跨项目 task 校验（repoPath / 行号引用 / graphify evidence）
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
const ACCEPTANCE_VERIFICATION_FILE = ARTIFACT.ACCEPTANCE_VERIFICATION

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
 * 检查验收标准契约 (acceptance-criteria.json) 是否完整
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, count: number, errors: string[] }}
 */
function checkAcceptanceCriteria (storyId) {
  const result = { exists: false, valid: false, count: 0, errors: [] }
  const data = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)

  if (!data) {
    result.errors.push(`${ACCEPTANCE_CRITERIA_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  // 检查 criteria 数组
  if (!Array.isArray(data.criteria)) {
    result.errors.push('缺少 criteria 数组')
  } else {
    result.count = data.criteria.length
    if (result.count === 0) {
      result.errors.push('criteria 数组为空，至少需要 1 条验收标准')
    }
    // 检查每条 AC 的必填字段
    for (let i = 0; i < data.criteria.length; i++) {
      const ac = data.criteria[i]
      if (!ac.id) result.errors.push(`AC[${i}]: 缺少 id`)
      if (!ac.description) result.errors.push(`AC[${i}]: 缺少 description`)
    }
    // 检查 ID 唯一性
    const ids = data.criteria.map(c => c.id).filter(Boolean)
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
    if (dupes.length > 0) {
      result.errors.push(`重复的 AC ID: ${[...new Set(dupes)].join(', ')}`)
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
  const result = { exists: false, valid: false, tasks: [], errors: [], warnings: [] }
  const data = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!data) {
    result.errors.push(`${TASK_DAG_JSON_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.tasks)) {
    result.errors.push('缺少 tasks 数组')
    return result
  }

  result.tasks = data.tasks
  if (data.tasks.length === 0) {
    result.errors.push('tasks 数组为空')
  }

  for (let i = 0; i < data.tasks.length; i++) {
    const task = data.tasks[i]
    const prefix = `Task[${task.id || i}]`

    // 检查必填字段
    if (!task.id) result.errors.push(`${prefix}: 缺少 id`)
    if (!task.title) result.errors.push(`${prefix}: 缺少 title`)

    // 检查 acceptanceCriteria 引用
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
      result.errors.push(`${prefix}: 缺少 acceptanceCriteria 引用（至少需关联 1 条验收标准）`)
    }

    // 检查 files 范围（用于 dev-pass 限域）
    if (!Array.isArray(task.files) || task.files.length === 0) {
      result.warnings.push(`${prefix}: files 为空，dev-pass 将降级为 src/** 全局授权（高风险）`)
    }

    // 跨项目 task 校验：有 project 字段时必须有 repoPath
    if (task.project && task.project !== repos.primary && !task.repoPath) {
      result.errors.push(`${prefix}: 跨项目 task (project=${task.project}) 必须指定 repoPath`)
    }

    // 跨项目 task 强制细化：description 必须包含行号引用
    if (task.project && task.project !== repos.primary) {
      // 检查是否有 description 字段且包含行号格式（如 L123 或 L12-L45）
      const desc = task.description || ''
      if (!desc) {
        result.errors.push(`${prefix}: 跨项目 task 必须有 description 字段`)
      } else if (!/L\d+/i.test(desc) && !/\bline\s*\d+/i.test(desc)) {
        result.errors.push(`${prefix}: 跨项目 task description 必须包含行号引用（如 L123 或 line 45）`)
      }
    }

    // P2-3（2026-09）: 跨项目 task 强制检索证据 —— evidence.source 必须含 graphify。
    // 门控「查产出物、不查过程」：只有真实在目标仓执行过 graphify 检索才拿得到 evidence，
    // 对标行号引用门控；kb/grep 单独不满足（v3 裁定：只用 graphify 倒逼真执行）
    if (task.project && task.project !== repos.primary) {
      const ev = task.evidence
      const sourceOk = ev && typeof ev.source === 'string' && ev.source.includes('graphify')
      if (!sourceOk) {
        result.errors.push(`${prefix}: 跨项目 task 必须提供 evidence 字段（{ source: 'graphify'|'both', ref: '<实际 query 或文档路径>' }），source 必须含 graphify（kb/grep 单独不满足）—— 证明已在目标仓执行过 graphify 检索`)
      } else if (!ev.ref || typeof ev.ref !== 'string') {
        result.errors.push(`${prefix}: 跨项目 task 的 evidence.ref 不能为空（填实际执行的 graphify query 或命中的文档路径）`)
      }
    }
  }

  // 检查 ID 唯一性
  const ids = data.tasks.map(t => t.id).filter(Boolean)
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupes.length > 0) {
    result.errors.push(`重复的 Task ID: ${[...new Set(dupes)].join(', ')}`)
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
  const result = { valid: false, orphanACs: [], invalidRefs: [], errors: [], warnings: [] }

  const acData = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)

  // 两个契约文件都不存在 → 无法验证
  if (!acData && !taskData) {
    result.errors.push('acceptance-criteria.json 和 task-dag.json 均不存在，无法验证交叉引用')
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
      result.errors.push(
        `检测到 ${formatDrifts.length} 处 AC 引用格式漂移（Task: ${driftedTaskIds.join(', ')}），` +
        'acceptanceCriteria 必须使用纯 ID（如 "AC-1"）而非 "AC-1: 描述"。请修复 task-dag.json 后重新提交。' +
        `（示例: 将 "${formatDrifts[0].rawValue}" 改为 "${formatDrifts[0].normalizedId}"）`
      )
    }

    // 找出未被任何 Task 引用的孤立 AC
    result.orphanACs = allACIds.filter(id => !referencedACIds.has(id))
    if (result.orphanACs.length > 0) {
      result.errors.push(`${result.orphanACs.length} 条验收标准未被任何 Task 引用: ${result.orphanACs.join(', ')}`)
    }
  }

  if (result.invalidRefs.length > 0) {
    result.errors.push(
      ...result.invalidRefs.map(r => `Task ${r.taskId} 引用了不存在的 AC: ${r.referencedAC}`)
    )
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 检查验收对账契约 (acceptance-verification.json) 是否全量通过
 * 所有 AC 都必须有 status=passed 且至少 1 条 evidence
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, allPassed: boolean, results: Array, failed: Array, errors: string[] }}
 */
function checkAcceptanceVerification (storyId) {
  const result = { exists: false, allPassed: false, results: [], failed: [], unverifiable: [], errors: [] }
  const data = readJsonArtifact(storyId, ACCEPTANCE_VERIFICATION_FILE)

  if (!data) {
    result.errors.push(`${ACCEPTANCE_VERIFICATION_FILE} 不存在`)
    return result
  }
  if (data._parseError) {
    result.errors.push(`JSON 解析失败: ${data._parseError}`)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.results)) {
    result.errors.push('缺少 results 数组')
    return result
  }

  result.results = data.results

  // 同时读取 AC 契约，确保覆盖率 100%
  const acData = readJsonArtifact(storyId, ACCEPTANCE_CRITERIA_FILE)
  const expectedACIds = (acData && !acData._parseError && Array.isArray(acData.criteria))
    ? new Set(acData.criteria.map(c => c.id).filter(Boolean))
    : null

  const verifiedACIds = new Set()

  for (let i = 0; i < data.results.length; i++) {
    const r = data.results[i]
    const prefix = `Result[${r.id || i}]`

    if (!r.id) {
      result.errors.push(`${prefix}: 缺少 id`)
      continue
    }
    verifiedACIds.add(r.id)

    if (r.status === 'failed') {
      result.failed.push({ id: r.id, status: r.status })
    } else if (r.status === 'unverifiable') {
      result.unverifiable.push({ id: r.id, status: r.status })
    }

    if (!Array.isArray(r.evidence) || r.evidence.length === 0) {
      result.errors.push(`${prefix}: 缺少 evidence（需提供验收证据）`)
    }
  }

  // 检查覆盖率：AC 契约中的所有条目是否都有验收结果
  if (expectedACIds) {
    for (const acId of expectedACIds) {
      if (!verifiedACIds.has(acId)) {
        result.errors.push(`AC ${acId}: 缺少验收结果`)
      }
    }
  }

  // 门控通过条件：failed=0 且 errors=0（unverifiable 不阻塞，跳过即可，降级为 warning）
  // 历史缺陷: 旧实现有 unverifiable 比例阈值（run 0.5 / fixbugs 1.0），超过即阻塞推进，
  //   导致大量依赖授权态/联调环境的 UI 型 AC 无法验证时被卡死流程。
  //   既然无法验证就跳过，不阻塞 —— unverifiable 结果由 policy 层降级为 warning 提示即可。
  result.allPassed = result.failed.length === 0 && result.errors.length === 0
  return result
}

module.exports = {
  ACCEPTANCE_CRITERIA_FILE,
  OPEN_QUESTIONS_FILE,
  TASK_DAG_JSON_FILE,
  ACCEPTANCE_VERIFICATION_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  STORY_INPUT_FILE,
  readJsonArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  checkAcceptanceVerification
}
