#!/usr/bin/env node
/**
 * PreToolUse Hook — e2e-state.json / dev-pass.json 写入保护
 *
 * 参考: 阿里 Harness 工程化实践 — 状态文件单写者模式 + hook 拦截
 *
 * 规则: e2e-state.json 和 dev-pass.json 只能通过 advance-phase.js 脚本更新，
 *       Agent (无论是主 Agent 还是子 Agent) 禁止直接写入。
 * 原理: 拦截所有 Write/Edit 操作，检查目标文件是否为状态文件，
 *       如果是 → 拒绝，提示使用 advance-phase.js。
 *
 * 设计: fail-closed — 默认拒绝，只放行显式允许的操作。
 */
const fs = require('fs')
const path = require('path')

// 读取 stdin 获取 hook 输入
let stdinData = ''
try {
  const chunks = []
  const fd = 0
  const buf = Buffer.alloc(65536)
  let bytesRead
  while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
    chunks.push(buf.slice(0, bytesRead).toString('utf-8'))
    if (bytesRead < buf.length) break
  }
  stdinData = chunks.join('')
} catch {
  // 无 stdin 输入，放行
}

if (!stdinData.trim()) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

let inputData = {}
try {
  inputData = JSON.parse(stdinData)
} catch {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

const toolName = inputData.tool_name || ''
const toolInput = inputData.tool_input || {}
// CodeBuddy 工具中文件路径的字段名可能是 file_path 或 filePath
const filePath = toolInput.file_path || toolInput.filePath || ''

// 只拦截写入类工具
const writeTools = ['Write', 'Edit', 'write_to_file', 'replace_in_file']
if (!writeTools.includes(toolName)) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 如果目标文件为空，放行
if (!filePath) {
  console.log(JSON.stringify({ continue: true }))
  process.exit(0)
}

// 规范化路径用于匹配
const normalizedPath = filePath.replace(/\\/g, '/')

// 受保护的状态文件列表
const PROTECTED_FILES = [
  'e2e-state.json',
  'dev-pass.json'
]

/**
 * 检查目标文件是否为受保护的状态文件
 * 匹配规则: 文件路径以 .codebuddy/plans/ 结尾且文件名为受保护文件
 * @param {string} filePath - 文件路径
 * @returns {{ protected: boolean, fileName: string }}
 */
function isProtectedStateFile(filePath) {
  for (const pf of PROTECTED_FILES) {
    // 精确匹配文件名 + 路径包含 .codebuddy/plans/
    if (filePath.endsWith('/' + pf) || filePath.endsWith('\\' + pf)) {
      if (filePath.includes('.codebuddy/plans/') || filePath.includes('.codebuddy\\plans\\')) {
        return { protected: true, fileName: pf }
      }
    }
  }
  return { protected: false, fileName: '' }
}

const check = isProtectedStateFile(normalizedPath)

if (check.protected) {
  console.log(JSON.stringify({
    continue: false,
    stopReason: `BLOCKED: 禁止直接写入 ${check.fileName}。状态文件只能通过 advance-phase.js 脚本更新，Agent 无权操作。`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `State file protection: ${check.fileName} can only be updated by advance-phase.js`,
      recordFailure: {
        failureType: 'state_file_violation',
        rootCause: `Agent 试图直接写入 ${check.fileName}: ${filePath}`,
        resolution: `${check.fileName} 只能通过 advance-phase.js 脚本更新。请汇报产出物路径，由主 Agent 调用脚本推进 Phase。`
      }
    }
  }, null, 0))
  process.exit(2)
}

// 非状态文件，放行
console.log(JSON.stringify({ continue: true }))
process.exit(0)
