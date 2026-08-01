#!/usr/bin/env node
/**
 * PostToolUse Hook — 命令执行后自动记录 trace.jsonl
 *
 * 输入：stdin JSON（PostToolUse 事件数据）
 * 输出：stdout JSON（不阻塞执行，始终 continue: true）
 *
 * @module trace-command-hook
 */
const fs = require('fs')
const path = require('path')

// 读取 stdin 数据
const chunks = []
process.stdin.on('readable', () => {
  let chunk
  while ((chunk = process.stdin.read()) !== null) chunks.push(chunk)
})

process.stdin.on('end', () => {
  const input = Buffer.concat(chunks).toString('utf8').trim()
  if (!input) {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  let event
  try { event = JSON.parse(input) } catch {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  // 只追踪 harness 相关命令
  const cmd = event.tool_input?.command || ''
  if (!cmd.includes('advance-phase') && !cmd.includes('harness-workflow') && !cmd.includes('archive-story')) {
    console.log(JSON.stringify({ continue: true }))
    return
  }

  // 记录 trace
  try {
    // 归一化 Git Bash / MSYS 风格盘符路径（"/d/xxx" → "d:/xxx"），仅 Windows
    const rawRoot = process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()
    const winDrive = process.platform === 'win32' ? /^\/([a-zA-Z])\/(.*)$/.exec(rawRoot) : null
    const PROJECT_ROOT = winDrive ? `${winDrive[1]}:/${winDrive[2]}` : rawRoot
    const plansDir = path.join(PROJECT_ROOT, '.codebuddy', 'plans')
    const storyDirs = fs.existsSync(plansDir)
      ? fs.readdirSync(plansDir).filter(d => fs.statSync(path.join(plansDir, d)).isDirectory())
      : []

    for (const storyId of storyDirs) {
      const e2ePath = path.join(plansDir, storyId, 'e2e-state.json')
      if (!fs.existsSync(e2ePath)) continue
      const state = JSON.parse(fs.readFileSync(e2ePath, 'utf-8'))
      if (state.status === 'running') {
        const tracePath = path.join(plansDir, storyId, 'trace.jsonl')
        const entry = JSON.stringify({
          timestamp: new Date().toISOString(),
          type: 'tool_executed',
          tool: event.tool_name,
          command: cmd.substring(0, 200),
          storyId
        })
        fs.appendFileSync(tracePath, entry + '\n')
        break
      }
    }
  } catch {
    // 静默失败，不阻塞主流程
  }

  console.log(JSON.stringify({ continue: true }))
})
