#!/usr/bin/env node
/**
 * PreToolUse Hook #2 — 防止跳 Phase（写入状态文件时检查产出物）
 *
 * 在写入 e2e-state.json 推进 phase 时，检查前置 Phase 的产出物是否存在。
 * 如果缺少产出物 → 阻止写入，防止跳过关键步骤。
 *
 * 拦截条件:
 *   - 工具: write_to_file, replace_in_file
 *   - 目标: .codebuddy/plans/*-e2e-state.json
 *
 * 检查规则:
 *   写入内容中 phase=N → 检查 Phase 0..N-1 的产出物是否存在
 *   例如 phase=2 → 检查 requirement-analysis.md 和 task-dag.md
 *
 * 输入：stdin JSON（PreToolUse 事件数据）
 * 输出：stdout JSON（allow/deny 决策）
 * 退出码：0=允许，2=阻止
 */

const fs = require('fs')
const path = require('path')
const {
  readStdin,
  isStateFile,
  PLANS_DIR,
  PHASE_SLUGS,
  getPhaseName,
  checkPhaseArtifact
} = require('../lib/state')

const trace = require('../lib/trace')

// ─── Hook 主逻辑 ─────────────────────────────────────────────────

const stdinData = readStdin()

if (!stdinData.trim()) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

let inputData = {}
try {
  inputData = JSON.parse(stdinData)
} catch (e) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

const toolName = inputData.tool_name || ''
const toolInput = inputData.tool_input || {}
const filePath = toolInput.filePath || toolInput.file_path || ''
const fileContent = toolInput.content || toolInput.new_str || ''

// 只处理文件写入/编辑工具
const writeTools = ['write_to_file', 'replace_in_file', 'Write', 'Edit']
if (!writeTools.includes(toolName)) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 检查文件路径是否为 e2e-state.json
if (!isStateFile(filePath)) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 从文件路径提取 storyId（新版: plans/<storyId>/e2e-state.json）
const storyId = path.basename(path.dirname(filePath))

// 尝试从写入内容中解析 phase 值
let targetPhase = null

// 策略1: 直接解析 JSON content（write_to_file 场景）
if (fileContent) {
  try {
    // 对于 replace_in_file，content 可能不是完整 JSON
    // 尝试提取 phase 字段
    const phaseMatch = fileContent.match(/"phase"\s*:\s*(\d+)/)
    if (phaseMatch) {
      targetPhase = parseInt(phaseMatch[1])
    } else {
      // 尝试完整 JSON 解析
      const parsed = JSON.parse(fileContent)
      if (typeof parsed.phase === 'number') {
        targetPhase = parsed.phase
      }
    }
  } catch (e) {
    // 内容不是完整 JSON（可能是 replace_in_file 的 new_str），尝试从文件读取当前 phase
  }
}

// 策略2: 如果无法从内容中解析，读取现有文件的 phase 值
if (targetPhase === null) {
  try {
    const existingPath = path.join(PLANS_DIR, fileName)
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf-8'))
      // 如果内容中包含 "phase" 字样，说明在修改 phase
      if (fileContent && fileContent.includes('"phase"')) {
        // 无法确定新值，保守策略：读取现有 phase + 1 作为检查目标
        targetPhase = existing.phase + 1
      } else {
        // 没有修改 phase，放行
        console.log(JSON.stringify({ continue: true }))
        process.exit(0)
      }
    } else {
      // 文件不存在，是新建，phase 应该是 0
      targetPhase = 0
    }
  } catch (e) {
    // 无法判断，放行（不阻断正常操作）
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }
}

// ── Phase 0: 新建状态文件，无前置检查 ──
if (targetPhase === 0) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// ── 检查前置 Phase 的产出物 ──
const blockers = []

for (let p = 0; p < targetPhase; p++) {
  const artifact = checkPhaseArtifact(storyId, p)

  if (!artifact.exists) {
    // CCHF v2: 每个 Phase 可能有多个产出物，逐个报告缺失项
    for (const m of artifact.missing) {
      blockers.push(
        `Phase ${p} (${getPhaseName(p)}) 产出物缺失: ${m.description}` +
        (m.fileName ? ` → ${m.fileName}` : '')
      )
    }
  }
}

if (blockers.length > 0) {
  // 写入 trace 记录 Hook 拒绝事件
  trace.appendTrace(storyId, {
    type: 'hook_rejection',
    result: 'deny',
    reason: 'phase_skip_attempt',
    phase: String(targetPhase),
    recordFailure: {
      failureType: 'phase_skip_attempt',
      rootCause: `Agent 试图跳 Phase 将状态推进到 Phase ${targetPhase}，但前置产出物缺失: ${blockers.join('; ')}`,
      resolution: `请先完成前置 Phase 的产出物，或使用 advance-phase.cjs ${storyId} ${targetPhase} 统一推进`
    }
  })

  const output = {
    continue: false,
    stopReason: [
      `⛔ 无法将状态推进到 Phase ${targetPhase} (${getPhaseName(targetPhase)})`,
      '',
      '以下前置产出物缺失:',
      ...blockers.map((b, i) => `  ${i + 1}. ${b}`),
      '',
      '请先完成对应 Phase 的产出物，或使用 advance-phase.cjs 统一推进:',
      `  node .codebuddy/scripts/advance-phase.cjs ${storyId} ${targetPhase}`
    ].join('\n'),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `前置 Phase 产出物检查失败: ${blockers.length} 项缺失`,
      recordFailure: {
        failureType: 'phase_skip_attempt',
        rootCause: `Agent 试图跳 Phase 将状态推进到 Phase ${targetPhase}，但前置产出物缺失: ${blockers.join('; ')}`,
        resolution: `请先完成前置 Phase 的产出物，或使用 advance-phase.cjs ${storyId} ${targetPhase} 统一推进`
      }
    }
  }

  console.log(JSON.stringify(output, null, 0))
  process.exit(2)
}

// ✅ 所有前置产出物存在 → 放行
console.log(JSON.stringify({ continue: true }))
process.exit(0)
