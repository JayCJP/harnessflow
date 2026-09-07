/**
 * hook-runner.js — Hook 输入解析与决策输出的统一运行器
 *
 * 职责:
 *   - 读 stdin（Windows 兼容）、解析 hook 事件 JSON，异常一律降级为放行
 *   - 归一化工具调用信息: tool_name / tool_input / apply_patch 补丁内的文件路径
 *   - 把 handler 返回的决策渲染成宿主要求的 JSON 并设置退出码
 *
 * 用法:
 *   const { runHook } = require('../lib/hook-runner')
 *
 *   runHook('PreToolUse', ctx => {
 *     if (!WRITE_TOOLS.includes(ctx.toolName)) return { decision: 'allow' }
 *     if (违规) {
 *       return {
 *         decision: 'deny',
 *         stopReason: '给 Agent 看的完整说明',
 *         reason: '一行原因',
 *         failure: { failureType, rootCause, resolution }
 *       }
 *     }
 *     return { decision: 'allow', additionalContext: 'dev-pass valid' }
 *   })
 *
 * 说明:
 *   - **放行是默认与兜底**: 空 stdin、非 JSON stdin、handler 抛异常，全部输出
 *     { continue: true } 并 exit 0。Hook 的失效必须是"不拦"而不是"卡住主流程"。
 *   - **退出码是宿主契约**: 放行 exit 0，拒绝 exit 2（不是 1）。改动会让拦截静默失效。
 *   - deny 的 stopReason / failure 均为可选，与改造前逐个 hook 的输出形态保持一致:
 *     enforce-dev-pass 三种拒绝都带 stopReason + recordFailure，
 *     enforce-state-file 的补丁通道拒绝只有 permissionDecisionReason。
 *     不要为了"统一"给原本没有这些字段的分支补上——那是行为变更。
 *   - additionalContext 缺省时输出纯 { continue: true }，不塞空的 hookSpecificOutput，
 *     保证与改造前逐字节一致。
 *   - 只依赖 node 内建与零依赖底座（stdin.js），可被任何 hook 安全引用。
 *
 * @module hook-runner
 */

const { readStdin } = require('./stdin')

/** apply_patch 补丁文本里的文件路径行 */
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

/** 会写文件的工具名（含 CodeBuddy 与 Claude Code 两套命名） */
const WRITE_TOOLS = ['write_to_file', 'replace_in_file', 'apply_patch', 'Write', 'Edit']

/** 走 shell 通道的工具名 */
const SHELL_TOOLS = ['Bash', 'execute_command']

/**
 * 从 apply_patch 的 command 文本里提取涉及的文件路径
 * @param {Object} toolInput - 工具入参
 * @param {string} toolName - 工具名，非 apply_patch 时返回空数组
 * @returns {string[]} 补丁涉及的文件路径
 */
function extractPatchPaths (toolInput, toolName) {
  if (toolName !== 'apply_patch') return []
  const text = String((toolInput && toolInput.command) || '')
  if (!text) return []
  return [...text.matchAll(PATCH_FILE_RE)].map(m => m[1].trim())
}

/** 输出放行决策并退出 */
function emitAllow (eventName, additionalContext) {
  if (additionalContext) {
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: { hookEventName: eventName, additionalContext }
    }))
  } else {
    console.log(JSON.stringify({ continue: true }))
  }
  process.exit(0)
}

/** 输出拒绝决策并退出（exit 2 是宿主约定的拦截码） */
function emitDeny (eventName, d) {
  const hookSpecificOutput = {
    hookEventName: eventName,
    permissionDecision: 'deny',
    permissionDecisionReason: d.reason || 'denied by harness hook'
  }
  if (d.failure) hookSpecificOutput.recordFailure = d.failure

  const out = { continue: false }
  if (d.stopReason) out.stopReason = d.stopReason
  out.hookSpecificOutput = hookSpecificOutput

  console.log(JSON.stringify(out))
  process.exit(2)
}

/**
 * 运行一个 hook：解析输入 → 交给 handler → 渲染决策 → 退出
 *
 * @param {string} eventName - hook 事件名（PreToolUse / PostToolUse / SessionStart / Stop）
 * @param {(ctx: {
 *   event: string, raw: Object, toolName: string, toolInput: Object,
 *   patchPaths: string[], filePath: string, filePaths: string[]
 * }) => ({ decision: 'allow'|'deny', additionalContext?: string,
 *          reason?: string, stopReason?: string, failure?: Object }|void)} handler
 *   返回决策；返回 undefined 视为放行。抛异常同样视为放行。
 * @returns {never}
 */
function runHook (eventName, handler) {
  const stdinData = readStdin()
  if (!stdinData.trim()) emitAllow(eventName)

  let raw = {}
  try {
    raw = JSON.parse(stdinData)
  } catch (e) {
    emitAllow(eventName)
  }

  const toolName = raw.tool_name || ''
  const toolInput = raw.tool_input || {}
  const patchPaths = extractPatchPaths(toolInput, toolName)
  // CodeBuddy 与 Claude Code 的路径字段名不同，两者都要认
  const single = toolInput.filePath || toolInput.file_path || ''
  const filePaths = patchPaths.length > 0 ? patchPaths : [single].filter(Boolean)

  let decision
  try {
    decision = handler({
      event: eventName,
      raw,
      toolName,
      toolInput,
      patchPaths,
      filePath: single,
      filePaths
    })
  } catch (e) {
    // handler 异常：放行。Hook 失效必须是"不拦"而不是"卡住主流程"
    emitAllow(eventName)
  }

  if (decision && decision.decision === 'deny') emitDeny(eventName, decision)
  emitAllow(eventName, decision && decision.additionalContext)
}

module.exports = {
  runHook,
  readStdin,
  extractPatchPaths,
  PATCH_FILE_RE,
  WRITE_TOOLS,
  SHELL_TOOLS
}
