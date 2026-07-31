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

// 受保护的状态文件列表
const PROTECTED_FILES = [
  'e2e-state.json',
  'dev-pass.json'
]

// 唯一被授权改写状态文件的脚本（相位跃迁 / 创建 / 归档）
const AUTHORIZED_SCRIPTS = [
  'advance-phase.js',
  'create-workflow.js',
  'archive-story.js',
  'harness-workflow.js' // 内部 require create-workflow.js
]

// ─── Bash / execute_command 通道 ─────────────────────────────
// 文件工具之外，shell 也能写状态文件（node -e fs.writeFileSync / 重定向 / sed -i 等）。
// 若不拦截，"状态文件单写者" 只在文件工具这一条通道上成立，等于形同虚设。
const bashTools = ['Bash', 'execute_command']
if (bashTools.includes(toolName)) {
  const command = toolInput.command || ''

  // 命令未提及受保护文件 → 放行
  const mentioned = PROTECTED_FILES.find(pf => command.includes(pf))
  if (!mentioned) {
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }

  // 命令是在调用授权脚本 → 放行（这是推进 Phase 的正常路径）
  if (AUTHORIZED_SCRIPTS.some(s => command.includes(s))) {
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }

  // 只读命令 → 放行（cat / type / node -e JSON.parse 读取等）
  // 说明: 采用白名单判定写意图的反面——命中任一写模式即拒绝，
  //       其余（读取、grep、jq 查询）放行，避免误伤正常的状态查看。
  const WRITE_PATTERNS = [
    />\s*[^|]*(?:e2e-state|dev-pass)/i,        // 重定向: echo x > e2e-state.json
    /writeFileSync|appendFileSync|createWriteStream/i, // node fs 写入
    /\bsed\b[^|]*-i/i,                          // sed -i 原地编辑
    /\b(?:rm|mv|cp|del|move|copy)\b/i,          // 删除/移动/覆盖
    /\btee\b/i,                                 // tee 写入
    /Set-Content|Add-Content|Out-File/i         // PowerShell 写入
  ]

  const hitPattern = WRITE_PATTERNS.find(p => p.test(command))
  if (!hitPattern) {
    console.log(JSON.stringify({ continue: true }))
    process.exit(0)
  }

  console.log(JSON.stringify({
    continue: false,
    stopReason: `BLOCKED: 禁止通过 shell 命令写入 ${mentioned}。状态文件的相位跃迁只能通过 advance-phase.js 完成。`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `State file protection (shell channel): ${mentioned} can only be mutated by ${AUTHORIZED_SCRIPTS.join(' / ')}`,
      recordFailure: {
        failureType: 'state_file_violation',
        rootCause: `Agent 试图通过 shell 命令写入 ${mentioned}: ${command}`,
        resolution: `${mentioned} 只能通过 advance-phase.js 脚本更新。请汇报产出物路径，由主 Agent 执行 advance-phase.js 推进 Phase。`
      }
    }
  }, null, 0))
  process.exit(2)
}

// ─── 文件工具通道 ────────────────────────────────────────────
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
