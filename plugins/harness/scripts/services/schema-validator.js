#!/usr/bin/env node
/**
 * schema-validator.js — JSON 产出物的 JSON Schema 校验服务
 *
 * 职责:
 *   - 用 Ajv 校验 8 类 JSON 产出物（e2e-state / acceptance-criteria / open-questions / task-dag /
 *     code-review / acceptance-verification / fix-request / fix-verification）是否符合 schemas/ 下的定义
 *   - 按 Phase 给出需校验的产出物清单（getPhaseArtifacts），供门控逐项校验
 *   - 把 Ajv 错误结构化成可读的 `文件 + 字段路径 + 原因` 错误列表
 *
 * 用法:
 *   作为模块引用:
 *     const { validateArtifact, getPhaseArtifacts } = require('./services/schema-validator')
 *   安装自检:
 *     node -e "const sv = require('<插件安装路径>/plugins/harness/scripts/services/schema-validator');
 *       console.log('schemas:', Object.keys(sv.SCHEMA_MAP).length)"
 *
 * 使用场景:
 *   - services/policy.js 门控流程第 1.5 步，产出物存在时先做 Schema 校验再走 Phase 契约检查
 *   - INSTALL.md:100 安装后自检依赖是否可用（本插件不依赖 node_modules）
 *
 * 说明:
 *   - 设计: fail-closed —— 校验失败即产出 BLOCKER 阻止 Phase 推进（参考阿里 Harness 工程化实践的
 *     state.json schema 前置校验），不做「跳过/降级放行」
 *   - Ajv 来自 vendor/ajv.bundle.js（6 系），不依赖 node_modules；错误位置字段是 dataPath，
 *     只读 Ajv 8 的 instancePath 会让所有错误退化成 (root)
 *   - logger 关闭 + 自注册 date-time/date/uri format：避免 unknown format 告警污染调用方 stdout
 *   - 文件不存在时不报错（视为 valid），存在性由 lib/state.js 的 checkPhaseArtifact 负责
 *
 * @module schema-validator
 */

const fs = require('fs')
const path = require('path')
const Ajv = require('../../vendor/ajv.bundle.js')
const { PLANS_DIR } = require('../lib/state')

/** Schema 文件目录 */
const SCHEMAS_DIR = path.join(__dirname, '..', 'schemas')

/** Schema 文件名到 JSON 产出物文件名的映射 */
const SCHEMA_MAP = {
  'e2e-state.schema.json': 'e2e-state.json',
  'acceptance-criteria.schema.json': 'acceptance-criteria.json',
  'open-questions.schema.json': 'open-questions.json',
  'task-dag.schema.json': 'task-dag.json',
  'code-review.schema.json': 'code-review.json',
  'acceptance-verification.schema.json': 'acceptance-verification.json',
  'fix-request.schema.json': 'fix-request.json',
  'fix-verification.schema.json': 'fix-verification.json'
}

/** 缓存已编译的 schema 校验器 */
const validatorCache = new Map()

/**
 * 初始化 Ajv 实例
 * @returns {Ajv}
 */
function createAjv () {
  const ajv = new Ajv({
    allErrors: true,     // 收集所有错误
    strict: false,       // 允许 unknown keywords
    coerceTypes: false,  // 不自动类型转换
    removeAdditional: false, // 不自动移除额外字段
    // schema 中使用了 format: date-time 等，但未引入 ajv-formats。
    // 不静默会向 stderr 打印 "unknown format ... ignored"，污染
    // dispatch.js / advance-phase.js 的输出，干扰调用方解析。
    logger: false
  })

  // 自注册常用 format，避免依赖 ajv-formats 包。
  // 未注册时 AJV 会「忽略」该 format（等于不校验），这里补上实际校验。
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (s) => !isNaN(Date.parse(s))
  })
  ajv.addFormat('date', {
    type: 'string',
    validate: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s))
  })
  ajv.addFormat('uri', {
    type: 'string',
    validate: (s) => /^[a-z][a-z0-9+.-]*:/i.test(s)
  })

  return ajv
}

/**
 * 加载并编译指定 schema
 * @param {string} schemaName - schema 文件名
 * @returns {{ valid: boolean, validate?: Function, error?: string }}
 */
function loadSchema (schemaName) {
  if (validatorCache.has(schemaName)) {
    return { valid: true, validate: validatorCache.get(schemaName) }
  }

  const schemaPath = path.join(SCHEMAS_DIR, schemaName)
  if (!fs.existsSync(schemaPath)) {
    return { valid: false, error: `Schema 文件不存在: ${schemaName}` }
  }

  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'))
    const ajv = createAjv()
    const validate = ajv.compile(schema)
    validatorCache.set(schemaName, validate)
    return { valid: true, validate }
  } catch (e) {
    return { valid: false, error: `Schema 编译失败: ${e.message}` }
  }
}

/**
 * 校验 JSON 产出物是否符合 schema
 * @param {string} storyId - Story ID
 * @param {string} artifactFileName - JSON 产出物文件名（如 'acceptance-criteria.json'）
 * @param {string} storyDir - Story 目录路径（可选，自动推断）
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateArtifact (storyId, artifactFileName, storyDir) {
  // 找到对应的 schema 文件名
  const schemaName = Object.keys(SCHEMA_MAP).find(k => SCHEMA_MAP[k] === artifactFileName)
  if (!schemaName) {
    return { valid: true, errors: [] } // 无 schema 的产出物，跳过校验
  }

  // 加载 schema
  const schemaResult = loadSchema(schemaName)
  if (!schemaResult.valid) {
    return { valid: false, errors: [`Schema 加载失败: ${schemaResult.error}`] }
  }

  // 读取产出物文件（PLANS_DIR 单一信源: lib/state.js）
  const dir = storyDir || path.join(PLANS_DIR, storyId)
  const filePath = path.join(dir, artifactFileName)

  if (!fs.existsSync(filePath)) {
    return { valid: true, errors: [] } // 文件不存在时不报错，由 checkPhaseArtifact 处理
  }

  let data
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch (e) {
    return { valid: false, errors: [`${artifactFileName} JSON 解析失败: ${e.message}`] }
  }

  // 执行校验
  const valid = schemaResult.validate(data)
  if (!valid) {
    const errors = (schemaResult.validate.errors || []).map(err => {
      // vendor/ajv.bundle.js 是 Ajv 6 系（错误位置字段为 dataPath）；
      // instancePath 是 Ajv 8 的字段名，只读它会让所有错误都退化成 (root)，定位不到具体条目。
      const field = err.instancePath || err.dataPath || '(root)'
      const missing = err.params && err.params.missingProperty ? ` [${err.params.missingProperty}]` : ''
      return `${artifactFileName}${field}: ${err.message}${missing}`
    })
    return { valid: false, errors }
  }

  return { valid: true, errors: [] }
}

/**
 * 校验多个 JSON 产出物
 * @param {string} storyId - Story ID
 * @param {string[]} artifactFileNames - JSON 产出物文件名列表
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateArtifacts (storyId, artifactFileNames) {
  const allErrors = []
  for (const fileName of artifactFileNames) {
    const result = validateArtifact(storyId, fileName)
    if (!result.valid) {
      allErrors.push(...result.errors)
    }
  }
  return { valid: allErrors.length === 0, errors: allErrors }
}

/**
 * 获取指定 Phase 需要校验的 JSON 产出物列表
 * @param {number} phaseNum - Phase 编号
 * @returns {string[]}
 */
function getPhaseArtifacts (phaseNum) {
  const phaseArtifacts = {
    0: ['acceptance-criteria.json', 'open-questions.json'],
    1: ['task-dag.json'],
    2: [],
    3: ['code-review.json'],
    4: ['acceptance-verification.json'],
    5: [],
    6: [],
    7: []
  }
  return phaseArtifacts[phaseNum] || []
}

/**
 * 获取所有已注册的 schema 名称列表
 * @returns {string[]}
 */
function getRegisteredSchemas () {
  return Object.keys(SCHEMA_MAP)
}

module.exports = {
  SCHEMA_MAP,
  validateArtifact,
  validateArtifacts,
  getPhaseArtifacts,
  getRegisteredSchemas
}
