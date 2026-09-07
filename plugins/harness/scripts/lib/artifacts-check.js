/**
 * artifacts-check.js — 产出物存在性检查与 Figma 链路校验
 *
 * 职责:
 *   - 产出物存在性: checkPhaseArtifact（按 PHASE_ARTIFACTS 判必需产出物是否齐全）、
 *     checkRequirementDoc / checkTaskDAGDoc / findBugAnalysisReports
 *   - Story 输入: readStoryInput 与 getStoryMode（run / fixbugs）
 *   - 条件产出物判定: isPrototypeRequired（要不要 prototype-analysis.md）
 *   - Figma 链路: detectFigmaSource → checkFigmaFrameInventory →
 *     validateTaskFigmaReferences / getTasksRequiringFigma
 *
 * 用法:
 *   const { checkPhaseArtifact, detectFigmaSource } = require('./artifacts-check')
 *
 * 使用场景:
 *   - 门控: services/policy.js 每次推进前调用
 *   - 人工诊断: audit/harness-audit.js 的「声明-消费一致性」检查（声明了 Figma
 *     却没产出 frame 清单 = 链路断裂）
 *
 * 说明:
 *   - 与 contracts.js 的分工: 本模块管「文件在不在 / 要不要」，contracts.js 管
 *     「文件内部结构对不对」。checkPhaseArtifact 只做存在性判定，不解析 JSON。
 *   - Figma 三道门控曾长期不触发：hasFigmaDesign 原本只来自 `--figma` CLI flag，
 *     而唯一入口 harness-workflow.js 传的是硬编码 false。现以 story-input.json 的
 *     sources.figmaUrls 为信源自动推导，`--figma` 降级为手工覆盖开关。
 *   - validateTaskFigmaReferences / getTasksRequiringFigma 都做了 figmaNodeId 归一化
 *     （figmaRefs 优先，其次数组 / 单值 string），因为历史数据三种写法都存在。
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir } = require('./paths')
const { ARTIFACT } = require('./artifacts')
const { PHASE_ARTIFACTS } = require('./phases')
const { readStateFile } = require('./story-state')
const {
  STORY_INPUT_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  TASK_DAG_JSON_FILE,
  readJsonArtifact,
  checkTaskDagJson
} = require('./contracts')

/**
 * 检查指定 Phase 的产出物文件是否存在
 * 新版支持每个 Phase 多个产出物（含契约 JSON），任意**必需** artifact 不存在即返回 exists=false。
 * `optional: true` 的产出物按条件产出（原型/Figma），不参与门控判定；
 * 但若同时声明了 `requiredWhen: 'hasFigmaDesign'` 且传入了 state，则该条件成立时升级为必需。
 * @param {string} storyId - Story ID
 * @param {number} phaseNum - Phase 编号
 * @param {Object} [state] - e2e-state 对象，用于判定 requiredWhen 条件；不传则条件产出物一律按可选处理
 * @returns {{ exists: boolean, missing: Array<{path:string, description:string}>, description: string }}
 */
function checkPhaseArtifact (storyId, phaseNum, state) {
  const phaseDef = PHASE_ARTIFACTS[phaseNum]
  if (!phaseDef || !phaseDef.artifacts) {
    return { exists: true, missing: [], description: '无' }
  }

  const required = phaseDef.artifacts.filter(a => {
    if (!a.fileName) return false
    if (!a.optional) return true
    // 条件必需：仅当传入 state 且条件成立时参与门控
    return Boolean(state) && a.requiredWhen === 'hasFigmaDesign' && hasFigmaDesign(state)
  })
  const missing = []
  for (const artifact of required) {
    const filePath = path.join(getStoryDir(storyId), artifact.fileName)
    if (!fs.existsSync(filePath)) {
      missing.push({ path: filePath, description: artifact.description, fileName: artifact.fileName })
    }
  }

  return {
    exists: missing.length === 0,
    missing,
    description: required.map(a => a.description).join(', ')
  }
}

/**
 * 读取 Story 原始输入契约（story-input.json）
 * @param {string} storyId - Story ID
 * @returns {Object|null} 解析后的对象；文件不存在返回 null，解析失败返回 { _parseError }
 */
function readStoryInput (storyId) {
  const filePath = path.join(getStoryDir(storyId), STORY_INPUT_FILE)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { _parseError: e.message }
  }
}

/**
 * 获取 Story 的工作流模式
 *
 * 优先取 story-input.json 的 mode；缺失时回退到 e2e-state.json 的 mode
 * （create-workflow.js 会把 --mode 落到状态文件，供 story-input.json
 * 尚未写入或已被清理的场景使用）。都没有则默认 'run'。
 *
 * @param {string} storyId - Story ID
 * @returns {'run'|'fixbugs'}
 */
function getStoryMode (storyId) {
  const input = readStoryInput(storyId)
  if (input && !input._parseError && (input.mode === 'run' || input.mode === 'fixbugs')) {
    return input.mode
  }
  const state = readStateFile(storyId)
  if (state && (state.mode === 'run' || state.mode === 'fixbugs')) {
    return state.mode
  }
  return 'run'
}

/**
 * 探测 story-input.json 里是否提供了 Figma 设计稿链接
 *
 * 历史问题: `hasFigmaDesign` 只来自 `--figma` CLI flag，而唯一入口
 * `harness-workflow.js` 调 createWorkflow 时该参数硬编码 false，导致三道
 * Figma 门控（frame 清单完整性 / figma 映射 / task figmaNodeId 校验 ——
 * 时在 validate-phase-gate.js，现由 policy.js 承担）在正常流程下永远不触发。
 *
 * 现以 story-input.json 的 `sources.figmaUrls` 为信源自动推导，`--figma`
 * 降级为手工覆盖开关（无 story-input.json 时仍可强制开启）。
 *
 * @param {string} storyId - Story ID
 * @returns {{ hasFigma: boolean, urls: string[], reason: string }}
 */
function detectFigmaSource (storyId) {
  const input = readStoryInput(storyId)
  if (!input || input._parseError) {
    return { hasFigma: false, urls: [], reason: 'story-input.json 不存在或解析失败' }
  }

  const urls = Array.isArray(input.sources?.figmaUrls)
    ? input.sources.figmaUrls.filter(u => typeof u === 'string' && u.trim())
    : []

  return {
    hasFigma: urls.length > 0,
    urls,
    reason: urls.length > 0
      ? `story-input.json 提供了 ${urls.length} 个 Figma 链接`
      : 'story-input.json 未提供 Figma 链接'
  }
}

/**
 * 判断本 Story 是否需要原型分析文档
 *
 * 历史问题: create-workflow.js 曾无条件检查 prototype-analysis.md，缺失即写入
 * Greenfield stub。fixbugs 场景本无原型，于是每个 Bug 修复 Story 都留下一个
 * 空壳文件，还会被 context-refresh 当成 Phase 0 产出物收集。
 *
 * 现在改为按需判定: 只有 story-input.json 里真的给了原型/Figma 链接，
 * 才要求产出 prototype-analysis.md。
 *
 * @param {string} storyId - Story ID
 * @returns {{ required: boolean, reason: string }}
 */
function isPrototypeRequired (storyId) {
  const input = readStoryInput(storyId)

  // 无 story-input.json → 无法判定，沿用旧行为（要求原型文档）以免漏检 run 模式
  if (!input || input._parseError) {
    return { required: true, reason: 'story-input.json 不存在或解析失败，保守要求原型文档' }
  }

  if (input.mode === 'fixbugs') {
    return { required: false, reason: 'fixbugs 模式，Bug 修复无原型依赖' }
  }

  const sources = input.sources || {}
  const protoCount = Array.isArray(sources.prototypeUrls) ? sources.prototypeUrls.length : 0
  const figmaCount = Array.isArray(sources.figmaUrls) ? sources.figmaUrls.length : 0

  if (protoCount + figmaCount > 0) {
    return {
      required: true,
      reason: `提供了 ${protoCount} 个原型链接 + ${figmaCount} 个 Figma 链接`
    }
  }

  return { required: false, reason: '未提供原型或 Figma 链接' }
}

/**
 * 查找 Story 目录下的 Bug 分析报告
 *
 * 文件名含动态需求标题（`{storyTitle}_bug分析报告.md`），无法进 PHASE_ARTIFACTS
 * 的固定文件名表，故用后缀匹配单独检查。
 *
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, files: string[], paths: string[] }}
 */
function findBugAnalysisReports (storyId) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) return { exists: false, files: [], paths: [] }

  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    return { exists: false, files: [], paths: [] }
  }

  const files = names.filter(n => /bug分析报告\.md$/.test(n)).sort()
  return {
    exists: files.length > 0,
    files,
    paths: files.map(f => path.join(dir, f))
  }
}

/**
 * 检查需求分析文档是否存在
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, path: string }}
 */
function checkRequirementDoc (storyId) {
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.REQUIREMENT_ANALYSIS)
  return {
    exists: fs.existsSync(filePath),
    path: filePath
  }
}

/**
 * 检查任务 DAG 文档是否存在
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, path: string }}
 */
function checkTaskDAGDoc (storyId) {
  const filePath = path.join(getStoryDir(storyId), ARTIFACT.TASK_DAG_DOC)
  return {
    exists: fs.existsSync(filePath),
    path: filePath
  }
}

/**
 * 🌐 检查工作流是否指定了 Figma 设计稿
 * @param {Object} state - 状态对象
 * @returns {boolean}
 */
function hasFigmaDesign (state) {
  return state?.hasFigmaDesign === true
}

/**
 * 🌐 检查 Figma Frame 清单 (figma-frame-inventory.json) 是否完整
 * Phase 1 任务规划师拆 task 时的产出（需求分析师不拉设计稿）。每个 frame 必须有 id、name、link。
 * @param {string} storyId - Story ID
 * @returns {{ exists: boolean, valid: boolean, frames: Array, errors: string[] }}
 */
function checkFigmaFrameInventory (storyId) {
  const result = { exists: false, valid: false, frames: [], errors: [] }
  const data = readJsonArtifact(storyId, FIGMA_FRAME_INVENTORY_FILE)

  if (!data) {
    result.errors.push(FIGMA_FRAME_INVENTORY_FILE + ' 不存在（如有 Figma 设计稿，Phase 1 任务规划师必须产出此文件）')
    return result
  }
  if (data._parseError) {
    result.errors.push('JSON 解析失败: ' + data._parseError)
    return result
  }

  result.exists = true

  if (!Array.isArray(data.frames)) {
    result.errors.push('缺少 frames 数组')
    return result
  }

  result.frames = data.frames
  if (data.frames.length === 0) {
    result.errors.push('frames 数组为空，至少需要 1 个 frame')
  }

  // 按类型统计
  const types = { page: 0, dialog: 0, drawer: 0, component: 0, unknown: 0 }
  for (let i = 0; i < data.frames.length; i++) {
    const f = data.frames[i]
    const prefix = 'Frame[' + i + ']'
    if (!f.id) result.errors.push(prefix + ': 缺少 id（Figma node ID，如 "3020:83533"）')
    if (!f.name) result.errors.push(prefix + ': 缺少 name')
    if (!f.link) result.errors.push(prefix + ': 缺少 link（完整 Figma node URL）')
    if (f.type) {
      types[f.type] = (types[f.type] || 0) + 1
    } else {
      types.unknown++
      result.errors.push(prefix + ': 缺少 type（page/dialog/drawer/component）')
    }
  }

  // 所有 frame 必须有完整的 Figma link
  const missingLinks = data.frames.filter(f => !f.link)
  if (missingLinks.length > 0) {
    result.errors.push(missingLinks.length + ' 个 frame 缺少完整 Figma node 链接')
  }

  result.types = types
  result.valid = result.errors.length === 0
  return result
}

/**
 * 🌐 验证 task-dag.json 中每个 UI task 是否引用了有效的 Figma frame
 * 仅当 hasFigmaDesign=true 时强制执行。验证 vs 猜测 — 精确匹配变成简单验证。
 * @param {string} storyId - Story ID
 * @returns {{ valid: boolean, unmatched: Array, invalidRefs: Array, errors: string[] }}
 */
function validateTaskFigmaReferences (storyId) {
  const result = { valid: false, unmatched: [], invalidRefs: [], errors: [] }

  const tdjCheck = checkTaskDagJson(storyId)
  if (!tdjCheck.exists) {
    result.errors.push('task-dag.json 不存在，跳过 Figma 引用验证')
    return result
  }

  const figmaCheck = checkFigmaFrameInventory(storyId)
  const figmaFrameIds = figmaCheck.exists && Array.isArray(figmaCheck.frames)
    ? new Set(figmaCheck.frames.map(f => f.id))
    : new Set()

  // 检查每个 task 是否引用了 figmaNodeId（单值 string / 多值 array / figmaRefs 精确配对）
  for (const task of tdjCheck.tasks) {
    // 归一化 figmaNodeId 为数组：null/undefined/空数组 → 未绑定；string → 单元素
    let nodeIds = []
    if (Array.isArray(task.figmaRefs)) {
      // 优先用精确配对 figmaRefs（nodeId + link），nodeIds 取自其 nodeId
      nodeIds = task.figmaRefs.map(r => r && r.nodeId).filter(Boolean)
    } else if (Array.isArray(task.figmaNodeId)) {
      nodeIds = task.figmaNodeId.filter(Boolean)
    } else if (typeof task.figmaNodeId === 'string' && task.figmaNodeId.trim()) {
      nodeIds = [task.figmaNodeId.trim()]
    }

    if (nodeIds.length === 0) {
      // 如果是纯逻辑 task（如 API 层），允许没有 Figma 引用
      if (task.files && task.files.some(f => f.includes('.vue'))) {
        result.unmatched.push({
          taskId: task.id,
          title: task.title,
          reason: 'Vue 组件缺少 figmaNodeId/figmaRefs 引用，请在 task-dag.json 中为 ' + (task.title || task.id) + ' 添加 figmaNodeId 或 figmaRefs 字段'
        })
      }
    } else if (figmaFrameIds.size > 0) {
      for (const nodeId of nodeIds) {
        if (!figmaFrameIds.has(nodeId)) {
          result.invalidRefs.push({
            taskId: task.id,
            figmaNodeId: nodeId,
            reason: 'figmaNodeId "' + nodeId + '" 不在 figma-frame-inventory.json 中'
          })
        }
      }
    }
  }

  if (result.unmatched.length > 0) {
    result.errors.push(result.unmatched.length + ' 个 Vue 组件未绑定 Figma frame: ' +
      result.unmatched.map(u => u.taskId + '(' + u.title + ')').join(', '))
  }
  if (result.invalidRefs.length > 0) {
    result.errors.push(...result.invalidRefs.map(r => r.reason))
  }

  result.valid = result.errors.length === 0
  return result
}

/**
 * 获取本 Story 中「需要 Figma」的 task 列表（开发阶段判断是否要求校验 Figma MCP）
 *
 * 判定：task 声明了 figmaNodeId（单值或数组）或 files 含 .vue 文件，即视为涉及 UI、
 * 需要对照设计稿。当需求要求 Figma（story-input 有 figmaUrls）且存在这类 task 时，
 * 开发 Agent 开工前必须先校验 Figma MCP 可用性，不可用则停下流程。
 *
 * @param {string} storyId - Story ID
 * @returns {Array<{id: string, title: string, figmaNodeIds: string[]}>} 需要 Figma 的 task 列表
 */
function getTasksRequiringFigma (storyId) {
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  if (!taskData || taskData._parseError || !Array.isArray(taskData.tasks)) return []

  const result = []
  for (const task of taskData.tasks) {
    // 归一化 figmaRefs / figmaNodeId（figmaRefs 优先，其次单值 string 或多值 array）
    let nodeIds = []
    if (Array.isArray(task.figmaRefs)) {
      nodeIds = task.figmaRefs.map(r => r && r.nodeId).filter(Boolean)
    } else if (Array.isArray(task.figmaNodeId)) {
      nodeIds = task.figmaNodeId.filter(Boolean)
    } else if (typeof task.figmaNodeId === 'string' && task.figmaNodeId.trim()) {
      nodeIds = [task.figmaNodeId.trim()]
    }

    // 涉及 UI 的判定：
    //   1) 显式声明了 figmaNodeId/figmaRefs
    //   2) files 含 .vue 文件
    //   3) files 是目录级 glob（如 src/views/pc/modules/** 或纯目录）——可能涵盖 .vue 组件，保守视为需 Figma
    const hasVueFile = Array.isArray(task.files) && task.files.some(f => {
      if (f.includes('.vue')) return true
      // 目录 glob / 目录路径 → 该目录下可能含 .vue 组件，保守视为 UI 相关
      return /\*\*|\*/.test(f) || /\/$/.test(f)
    })
    if (nodeIds.length > 0 || hasVueFile) {
      result.push({ id: task.id, title: task.title || task.id, figmaNodeIds: nodeIds })
    }
  }
  return result
}

/**
 * 判断本 Story 是否有 task 需要 Figma（供开发阶段 prompt 决定是否要求 Figma MCP 校验）
 * @param {string} storyId - Story ID
 * @returns {boolean} 是否存在需要 Figma 的 task
 */
function hasTaskRequiringFigma (storyId) {
  return getTasksRequiringFigma(storyId).length > 0
}

module.exports = {
  checkPhaseArtifact,
  readStoryInput,
  getStoryMode,
  detectFigmaSource,
  isPrototypeRequired,
  findBugAnalysisReports,
  checkRequirementDoc,
  checkTaskDAGDoc,
  hasFigmaDesign,
  checkFigmaFrameInventory,
  validateTaskFigmaReferences,
  getTasksRequiringFigma,
  hasTaskRequiringFigma
}
