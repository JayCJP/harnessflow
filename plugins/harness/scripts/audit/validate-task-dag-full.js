#!/usr/bin/env node
/**
 * validate-task-dag-full.js — task-dag.json 落盘前完整自检 CLI
 *
 * 职责:
 *   - 把门控层（policy.js）已有的校验前置到 task-planner 产出阶段
 *   - 同时跑 ajv schema 校验 + AC 全覆盖 + 交叉引用 + 跨项目规则，
 *     与 Phase 1→2 门控口径完全一致（复用 schema-validator + contracts.js）
 *   - 输出清晰的结果（哪些检查通过/失败 + 具体的 orphan AC 列表）
 *
 * 用法:
 *   node validate-task-dag-full.js <storyId>
 *   退出码: 0=全通过, 1=有问题
 *
 * 使用场景:
 *   - task-planner 产出 task-dag.json 后、汇报主 Agent 前自跑
 *   - 把 orphan_ac / invalid_ac_ref / ac_ref_format_drift 等问题
 *     拦在产出阶段，避免到 dispatch 预检才发现（减少一轮往返）
 *
 * 说明:
 *   - 不引入新逻辑：复用 schema-validator.js 的 validateArtifact +
 *     contracts.js 的 checkAcceptanceCriteria / checkTaskDagJson / validateContractReferences
 *   - 校验口径与 policy.js#checkPhase1Gate 完全一致，不出现"自检通过但门控失败"
 *   - STORY-opt2-r2 曾因 task-planner 手写一次性 validate-task-dag.cjs（路径硬编码、
 *     不可复用）来预检 orphan_ac；本脚本是该手写脚本的通用化沉淀
 *
 * @module validate-task-dag-full
 */

const schemaValidator = require('../services/schema-validator')
const {
  checkAcceptanceCriteria,
  checkTaskDagJson,
  validateContractReferences
} = require('../lib/contracts')

// ========================
// CLI 参数解析
// ========================

const storyId = process.argv[2]

if (!storyId) {
  console.error('用法: node validate-task-dag-full.js <storyId>')
  console.error('示例: node validate-task-dag-full.js STORY-opt2-r2')
  process.exit(1)
}

// ========================
// 校验执行
// ========================

/** @type {Array<{pass:boolean, name:string, details:string[]}>} */
const checks = []
let hasErrors = false

// --- 1. JSON Schema 校验（ajv，与门控第 1.5 步一致）---

const schemaResult = schemaValidator.validateArtifact(storyId, 'task-dag.json')
if (!schemaResult.valid) {
  hasErrors = true
  checks.push({
    pass: false,
    name: 'Schema 校验（ajv）',
    details: schemaResult.errors.map(e => `  ✗ ${e}`)
  })
} else {
  checks.push({ pass: true, name: 'Schema 校验（ajv）', details: [] })
}

// acceptance-criteria.json 的 schema 校验（Phase 0 产出，此处顺带核验）
const acSchemaResult = schemaValidator.validateArtifact(storyId, 'acceptance-criteria.json')
if (!acSchemaResult.valid) {
  hasErrors = true
  checks.push({
    pass: false,
    name: 'AC Schema 校验（ajv）',
    details: acSchemaResult.errors.map(e => `  ✗ ${e}`)
  })
} else {
  checks.push({ pass: true, name: 'AC Schema 校验（ajv）', details: [] })
}

// --- 2. AC 契约格式校验（与 checkPhase0Gate 一致）---

const acCheck = checkAcceptanceCriteria(storyId)
if (acCheck.exists && !acCheck.valid) {
  hasErrors = true
  checks.push({
    pass: false,
    name: 'AC 格式校验',
    details: acCheck.issues.map(i => `  ✗ [${i.type}] ${i.message}` + (i.resolution ? `\n    → ${i.resolution}` : ''))
  })
} else if (acCheck.exists) {
  checks.push({ pass: true, name: `AC 格式校验（${acCheck.count} 条）`, details: [] })
}

// --- 3. task-dag 结构校验（与 checkPhase1Gate 的 checkTaskDagJson 一致）---

const taskCheck = checkTaskDagJson(storyId)
if (!taskCheck.valid) {
  hasErrors = true
  checks.push({
    pass: false,
    name: 'task-dag 结构校验',
    details: taskCheck.issues.map(i => `  ✗ [${i.type}] ${i.message}` + (i.resolution ? `\n    → ${i.resolution}` : ''))
  })
} else if (taskCheck.exists) {
  checks.push({ pass: true, name: `task-dag 结构校验（${taskCheck.tasks.length} 个 task）`, details: [] })
}

// files[] 非空提示（warning 不阻断，但提示范围审计摩擦）
if (taskCheck.exists && Array.isArray(taskCheck.tasks)) {
  const emptyFilesTasks = taskCheck.tasks.filter(t => !Array.isArray(t.files) || t.files.length === 0)
  if (emptyFilesTasks.length > 0) {
    checks.push({
      pass: true,
      name: 'files[] 非空提示',
      details: emptyFilesTasks.map(t => `  ⚠ [${t.id}] files 为空，Phase 2→3 范围审计会把全部改动判为范围外`)
    })
  }
}

// --- 4. AC ↔ Task 交叉引用（与 checkPhase1Gate 的 validateContractReferences 一致）---

const refCheck = validateContractReferences(storyId)
if (!refCheck.valid) {
  hasErrors = true
  const details = refCheck.issues.map(i => `  ✗ [${i.type}] ${i.message}` + (i.resolution ? `\n    → ${i.resolution}` : ''))
  // 额外输出 orphan AC 的具体 ID 列表（已在 message 里，但单独列出更醒目）
  if (refCheck.orphanACs && refCheck.orphanACs.length > 0) {
    details.push(`  📋 未被引用的 AC: ${refCheck.orphanACs.join(', ')}`)
    details.push('     请在 task-dag.json 的 tasks[].acceptanceCriteria 中补充引用上述 AC')
  }
  if (refCheck.invalidRefs && refCheck.invalidRefs.length > 0) {
    details.push(`  📋 引用了不存在的 AC: ${refCheck.invalidRefs.map(r => `${r.taskId}→${r.referencedAC}`).join(', ')}`)
  }
  checks.push({ pass: false, name: 'AC ↔ Task 交叉引用', details })
} else {
  checks.push({ pass: true, name: 'AC ↔ Task 交叉引用（全覆盖）', details: [] })
}

// --- 5. AC 覆盖清单输出（逐 AC 归属，方便人工核对）---

if (taskCheck.exists && taskCheck.tasks.length > 0) {
  // 重新读取原始 JSON 构建覆盖映射（check 函数不返回原始引用）
  const { readJsonArtifact } = require('../lib/contracts')
  const dag = readJsonArtifact(storyId, 'task-dag.json')
  const ac = readJsonArtifact(storyId, 'acceptance-criteria.json')
  if (dag && !dag._parseError && ac && !ac._parseError) {
    const owner = {}
    for (const t of dag.tasks) {
      for (const a of (t.acceptanceCriteria || [])) {
        const id = typeof a === 'string' ? a.split(':')[0].trim() : String(a)
        ;(owner[id] = owner[id] || []).push(t.id)
      }
    }
    const acIds = (ac.criteria || []).map(c => c.id).filter(Boolean)
    const map = acIds.map(id => `${id}[${(owner[id] || ['!!UNREFERENCED!!']).join('/')}]`).join(' ')
    checks.push({ pass: true, name: 'AC 覆盖清单', details: [`  ${map}`] })
  }
}

// ========================
// 输出结果
// ========================

console.log(`\n🔍 task-dag.json 完整自检 — ${storyId}\n`)

for (const c of checks) {
  const icon = c.pass ? '✅' : '❌'
  console.log(`${icon} ${c.name}`)
  for (const d of c.details) {
    console.log(d)
  }
}

if (hasErrors) {
  console.log('\n❌ 自检未通过，请修复上述问题后重跑')
  console.log('   校验口径与 Phase 1→2 门控（policy.js#checkPhase1Gate）完全一致')
  process.exit(1)
} else {
  console.log('\n✅ 自检通过（Schema + AC 格式 + task-dag 结构 + AC 交叉引用全覆盖）')
  console.log('   与 Phase 1→2 门控口径一致，可汇报主 Agent')
  process.exit(0)
}
