#!/usr/bin/env node
/**
 * schema-validator.js — JSON Schema 校验服务
 *
 * 参考: 阿里 Harness 工程化实践 — state.json schema 前置校验
 *
 * 为每个 JSON 产出物提供 schema 校验，在门控推进前检测格式错误。
 * 设计: fail-closed — 校验失败 → BLOCKER，阻止推进。
 *
 * @module schema-validator
 */

const fs = require('fs')
const path = require('path')
const Ajv = require('ajv')

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
    removeAdditional: false // 不自动移除额外字段
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

  // 读取产出物文件
  const PLANS_DIR = path.resolve(process.env.CODEBUDDY_PROJECT_DIR || process.cwd(), '.codebuddy', 'plans')
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
      const field = err.instancePath || '(root)'
      return `${artifactFileName}${field}: ${err.message}`
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
