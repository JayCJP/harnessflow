#!/usr/bin/env node
/**
 * session-start.js — 会话启动时注入活跃工作流索引卡
 *
 * 职责:
 *   - 扫描 .codebuddy/plans/ 下所有 Story 的 e2e-state.json，找出活跃工作流
 *   - 注入「索引卡」: 每个活跃 Story 一行（ID/标题/Phase/待确认数）+ 续跑命令提示
 *   - 让新会话无需回放对话历史即可发现并续跑工作流
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: SessionStart
 *   输入: stdin JSON（SessionStart 事件数据；为空或非法 JSON 时按空输入降级）
 *   输出: stdout JSON（{ continue: true, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }）
 *   手动调试: echo '{}' | node session-start.js
 *
 * 使用场景:
 *   - 新会话/断点续跑时 Agent 不知道有哪些活跃 Story、停在哪个 Phase：
 *     不注入会让 Agent 凭猜测继续，或需要用户手动报 storyId。
 *   - 上一轮遗留了未确认的 open-questions：索引用 ⛔ 标记，防止被无视直接推进。
 *
 * 说明:
 *   - 索引卡原则（2026-09 瘦身）: 此处只做「无感发现」。上轮摘要 / 历史教训 /
 *     度量洞察 / 契约清单等重内容不再注入 —— 它们由 prompt-builder.js 的
 *     agentPrompt 在 spawn 时按单一信源注入给子 Agent；在会话启动时注入属于
 *     重复计费且受众错位（教训面向开发 Agent，主 Agent 不写代码）。
 *   - 首部附带强制规则（固定文本前置命中 KV cache），约束 skill 加载前的行为边界；
 *     硬防线不依赖此处 —— enforce-* hooks 在工具层拦截。
 *   - 门控预检不在此做 —— 权威预检在 dispatch.js（pendingBlockers），权威裁定在
 *     advance-phase.js（policy.js）。
 *   - 最多列最近更新的 5 个 Story，其余汇总一行，避免残留工作流撑爆上下文。
 *   - 无活跃工作流时 additionalContext 只输出一行提示，保持低成本。
 *   - @module session-start-hook
 */

const fs = require('fs')
const path = require('path')

// ─── 引入公共模块 ──────────────────────────────────────────────

const hookUtils = require(path.join(__dirname, '..', 'lib', 'state'))

/**
 * 构建注入到 Agent 上下文的 additionalContext 索引卡
 * @param {Array<{storyId: string, state: Object, unresolved: Array}>} workflowResults
 * @returns {string} 上下文文本
 */
function buildAdditionalContext (workflowResults) {
  if (workflowResults.length === 0) {
    return '✅ 无活跃工作流。正常服务用户请求。'
  }

  const MAX_LISTED = 5
  const lines = []

  // 固定规则前置：稳定文本在前命中 KV cache，且约束 skill 加载前的行为边界
  lines.push('⛔ 强制规则（不可违反）:')
  lines.push('1. open-questions.json 中存在 resolved=false → 禁止推进到 Phase 1')
  lines.push('2. 主 Agent 不亲自编写代码 → 必须 spawn 专用 Agent 执行')
  lines.push('3. 禁止直接写/改 e2e-state.json 和 dev-pass.json → 状态机由 advance-phase.js 独占维护')
  lines.push('4. 推进 Phase → 必须执行 node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/advance-phase.js <storyId> <targetPhase>')
  lines.push('')

  // 最近更新的排前面，陈旧工作流沉底
  const sorted = [...workflowResults].sort((a, b) =>
    String(b.state.updatedAt || '').localeCompare(String(a.state.updatedAt || '')))

  lines.push(`⚡ 活跃工作流（${workflowResults.length} 个，按最近更新排序）:`)
  for (let i = 0; i < Math.min(sorted.length, MAX_LISTED); i++) {
    const { storyId, state, unresolved } = sorted[i]
    const bits = [`${storyId} 「${state.title || '未知'}」`, `Phase ${state.phase}(${hookUtils.getPhaseName(state.phase)})`]
    if (state.status && state.status !== 'running') bits.push(state.status)
    if (state.updatedAt) bits.push(`${String(state.updatedAt).slice(5, 10)} 更新`)
    if (unresolved.length > 0) bits.push(`⛔ 待确认 ${unresolved.length} 项`)
    lines.push(`${i + 1}. ${bits.join(' · ')}`)
    if (unresolved.length > 0) {
      lines.push(`   → 待确认详情: read_file .codebuddy/plans/${storyId}/open-questions.json`)
    }
  }
  if (sorted.length > MAX_LISTED) {
    lines.push('… 另有 ' + (sorted.length - MAX_LISTED) + ' 个未列出（node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/harness-workflow.js status 查看全部）')
  }

  lines.push('')
  lines.push('→ 续跑任一工作流: node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/dispatch.js <storyId>')
  lines.push('  （输出四态 ready/fix_loop/blocked/terminal 与 agentPrompt，按其指示执行）')

  return lines.join('\n')
}

/**
 * 读取 stdin 全部内容（Windows 兼容）
 * @returns {string} stdin 内容
 */
function readStdin () {
  try {
    const buf = Buffer.alloc(65536)
    const fd = fs.openSync(process.stdin.fd, 'r')
    const bytesRead = fs.readSync(fd, buf, 0, 65536, null)
    fs.closeSync(fd)
    if (bytesRead > 0) {
      return buf.toString('utf-8', 0, bytesRead)
    }
    return ''
  } catch (e) {
    return ''
  }
}

// ─── Hook 入口 ──────────────────────────────────────────────────────

/**
 * 从 stdin 读取输入数据并执行 SessionStart Hook 逻辑
 * 输出 JSON 格式的 HookOutput 到 stdout
 */
function main () {
  let inputData = {}
  try {
    const stdinData = readStdin()
    if (stdinData.trim()) {
      inputData = JSON.parse(stdinData)
    }
  } catch (e) {
    // stdin 为空或 JSON 解析失败，忽略
  }

  // 扫描活跃工作流（复用 hook-utils 的新版路径逻辑）
  const activeWorkflows = hookUtils.findActiveWorkflows()

  // 对每个活跃工作流提取未解决确认项（门控预检不在此做，权威预检在 dispatch.js）
  const workflowResults = activeWorkflows.map(wf => {
    // 从 open-questions.json 读取未解决确认项（单一数据源）
    const oqCheck = hookUtils.checkOpenQuestions(wf.storyId)
    const unresolved = (oqCheck.exists && !oqCheck.allResolved)
      ? oqCheck.unresolved.map(q => ({ question: q.question, source: 'open-questions.json' }))
      : []

    return {
      storyId: wf.storyId,
      state: wf.state,
      unresolved
    }
  })

  // 构建 additionalContext 索引卡
  const additionalContext = buildAdditionalContext(workflowResults)

  // 输出 HookOutput
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext
    }
  }

  console.log(JSON.stringify(output, null, 0))
  return 0
}

main()
