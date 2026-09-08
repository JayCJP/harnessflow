/**
 * schema-injector.js — 把契约 JSON Schema 压成可注入 agentPrompt 的「骨架」
 *
 * 职责:
 *   - 读 schemas/<契约名>.schema.json，抽取**能防住校验失败的最小信息集**
 *   - 输出 markdown 片段，由 prompt-builder 在「产出要求」段后注入
 *
 * 用法:
 *   const { buildContractSchemaSection } = require('./schema-injector')
 *   const md = buildContractSchemaSection(1)   // Phase 1 → task-dag.json 骨架
 *
 * 使用场景:
 *   - 子 Agent 在**生成前**就知道契约的字段白名单与类型，而不是写完被门控打回
 *   - 修复「3 次派单实质是改 JSON 字段」这类纯填表返工
 *
 * 说明:
 *   - 为什么是「骨架」而不是全文注入: 9 个 schema 全文进 prompt 与成本优化原则冲突，
 *     且 fix-loop 多轮会重复计费。实测本次 3 次违规全栽在 `additionalProperties: false`
 *     （多写了白名单外的键）与字段类型（estimate 应为 integer），
 *     这些**骨架就能覆盖**，不需要完整 schema。
 *   - 为什么不是「只给路径」: 本次已证明 Agent 不会主动读（派单写了 schema 路径仍改错）。
 *   - 下探深度固定为 2 层（顶层 + 一层）。违规高发区就在这两层:
 *     `tasks[].estimate`（第 2 层类型）、`summary.notes`（第 2 层白名单外）。
 *     再深会成倍膨胀且收益递减 —— 深层结构由 Agent 按第 2 层键名自行组织。
 *   - 无对应 schema 文件的契约（如 figma-frame-inventory.json）自动跳过，不报错、不占位。
 *
 * @module schema-injector
 */

const fs = require('fs')
const path = require('path')

const { PHASE_ARTIFACTS } = require('../lib/phases')

const SCHEMA_DIR = path.join(__dirname, '..', 'schemas')

/**
 * 取字段的可读类型串
 *
 * @param {Object} prop - JSON Schema 的属性定义节点
 * @returns {string} `string` / `integer` / `enum: a|b` / `{子键...}` / `any`
 */
function typeLabel (prop) {
  if (!prop) return 'any'
  if (Array.isArray(prop.enum)) return `enum: ${prop.enum.join('|')}`
  if (prop.type === 'object' && prop.properties) {
    return `{${Object.keys(prop.properties).join(', ')}}`
  }
  return prop.type || 'any'
}

/**
 * 把一层 object 定义压成 2~3 行要点（键白名单 / 必填 / 封闭性警告）
 *
 * @param {string} label - 该层的人类可读前缀，如「顶层」或「`tasks[]` 元素」
 * @param {Object} node - JSON Schema 的 object 节点
 * @returns {string[]} markdown 行数组
 */
function describeLevel (label, node) {
  if (!node) return []
  const props = node.properties || {}
  const keys = Object.keys(props)
  // label 后统一补空格: 嵌套层的 label 以反引号结尾（如 `summary`），
  // 直接拼接会让 `summary``additionalProperties` 两个代码段粘连，markdown 渲染错乱
  const prefix = label ? `${label} ` : ''
  const lines = []

  if (keys.length > 0) {
    const list = keys.map(k => `\`${k}\`(${typeLabel(props[k])})`).join(', ')
    lines.push(`- ${prefix}字段白名单: ${list}`)
  }
  if (Array.isArray(node.required) && node.required.length > 0) {
    lines.push(`- ${prefix}必填: ${node.required.map(r => `\`${r}\``).join(', ')}`)
  }
  // 封闭性是本次 3 次违规的共同根因，单独成行强调，不混在白名单里
  if (node.additionalProperties === false) {
    lines.push(`- ⚠️ ${prefix}\`additionalProperties: false\` —— **出现白名单外的键即校验失败**（不要自造字段）`)
  }
  return lines
}

/**
 * 构造单个契约文件的 schema 骨架
 *
 * @param {string} fileName - 契约文件名，如 `task-dag.json`
 * @returns {string[]|null} markdown 行数组；无对应 schema 或解析失败时返回 null
 */
function buildSchemaSkeleton (fileName) {
  const schemaPath = path.join(SCHEMA_DIR, fileName.replace(/\.json$/, '') + '.schema.json')
  if (!fs.existsSync(schemaPath)) return null

  let schema
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'))
  } catch (e) {
    return null
  }

  const lines = [`### \`${fileName}\``]
  lines.push(...describeLevel('顶层', schema))

  // 下探一层：数组元素与嵌套对象 —— 违规高发区（`tasks[].estimate` / `summary.notes`）
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    if (prop.type === 'array' && prop.items && prop.items.type === 'object') {
      lines.push(...describeLevel(`\`${key}[]\` 元素`, prop.items))
    } else if (prop.type === 'object' && prop.properties) {
      lines.push(...describeLevel(`\`${key}\``, prop))
    }
  }

  return lines
}

/**
 * 构造某 Phase 全部契约产出物的 schema 骨架段
 *
 * 契约清单取自 PHASE_ARTIFACTS 的 `contract: true` 标记 —— 与门控校验同一信源，
 * 不在本模块另立一份 Phase→契约映射。
 *
 * @param {number} targetPhase - 目标 Phase
 * @returns {string} markdown 片段字符串；该 Phase 无契约产出物时返回空串
 */
function buildContractSchemaSection (targetPhase) {
  const artifacts = (PHASE_ARTIFACTS[targetPhase] && PHASE_ARTIFACTS[targetPhase].artifacts) || []
  const contracts = artifacts.filter(a => a.contract && a.fileName)

  const body = []
  for (const a of contracts) {
    const skeleton = buildSchemaSkeleton(a.fileName)
    if (skeleton && skeleton.length > 0) body.push(...skeleton, '')
  }
  if (body.length === 0) return ''

  return [
    '## 📐 产出物 JSON Schema（门控按此校验，逐字段对齐后再落盘）',
    '',
    ...body
  ].join('\n')
}

module.exports = { buildContractSchemaSection, buildSchemaSkeleton }
