#!/usr/bin/env node
/**
 * dump-agent-prompt.js — 测试脚本：打印 buildAgentPrompt 产出的 agentPrompt 内容结构
 *
 * 用法:
 *   node dump-agent-prompt.js <storyId> [targetPhase] [--batch=<id>] [--scope=incremental]
 *
 * 行为:
 *   - 调用 services/prompt-builder 的 buildAgentPrompt，把一个 Phase 的 agentPrompt 组装出来
 *   - 把 agentPrompt 按「## 一级标题」切成章节，打印每个章节的结构（标题 / 行数 / 行预览）
 *   - 同时打印返回对象的元信息字段（agent / expectedOutputs / contractFilesToLoad 等）
 *
 * 说明:
 *   - 不写任何文件，纯只读；story 目录不存在时也能跑（缺失的契约/摘要段会显示为空或缺省值）
 *   - 默认 targetPhase=2（前端开发，章节最丰富，含 Figma 段、batch 段、契约文件段等）
 *
 * @module dump-agent-prompt
 */

const path = require('path')

// 解析命令行参数
const argv = process.argv.slice(2)
const positional = argv.filter(a => !a.startsWith('--'))
const storyId = positional[0] || 'STORY-DEMO'
const targetPhase = positional[1] !== undefined ? Number(positional[1]) : 2

const batchArg = argv.find(a => a.startsWith('--batch='))
const scopeArg = argv.find(a => a.startsWith('--scope='))
const opts = { storyId, targetPhase }
if (batchArg) opts.batchId = Number(batchArg.split('=')[1])
if (scopeArg) opts.scope = scopeArg.split('=')[1]

// 把脚本所在 scripts 目录加入 require 路径（兼容从任意 cwd 运行）
const scriptsDir = __dirname
const promptBuilder = require(path.join(scriptsDir, 'services', 'prompt-builder'))

/**
 * 把一段 markdown 按「## 一级标题」切成章节数组
 * @param {string} text - 完整 agentPrompt
 * @returns {Array<{ heading: string, lineCount: number, preview: string[] }>}
 */
function splitSections (text) {
  const lines = text.split('\n')
  const sections = []
  let cur = null
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (cur) sections.push(cur)
      cur = { heading: line.replace(/^##\s+/, '').trim(), lines: [], preview: [] }
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  if (cur) sections.push(cur)
  return sections.map(s => ({
    heading: s.heading,
    lineCount: s.lines.filter(l => l.trim() !== '').length,
    preview: s.lines.slice(0, 4)
  }))
}

// ─── 执行 ──────────────────────────────────────────────────────
console.log('='.repeat(72))
console.log(`buildAgentPrompt({ storyId: ${storyId}, targetPhase: ${targetPhase}` +
  `${opts.batchId !== undefined ? `, batchId: ${opts.batchId}` : ''}` +
  `${opts.scope ? `, scope: ${opts.scope}` : ''} })`)
console.log('='.repeat(72))

const result = promptBuilder.buildAgentPrompt(opts)

console.log('\n── 返回对象元信息字段 ──')
console.log('agent              :', result.agent)
console.log('agentLabel         :', result.agentLabel)
console.log('storyMode          :', result.storyMode)
console.log('phaseInstruction    :', result.phaseInstruction ? '(已设置，见下方章节)' : null)
console.log('contractFilesToLoad :', JSON.stringify(result.contractFilesToLoad, null, 0))
console.log('agentConstraints    :', `(${result.agentConstraints.length} 条)`)
result.agentConstraints.forEach((c, i) => console.log(`   [${i + 1}] ${c}`))
console.log('expectedOutputs     :', JSON.stringify(result.expectedOutputs))
if (result.lessonsFromHistory) console.log('lessonsFromHistory   : (已设置)')
if (result.metricsInsights) console.log('metricsInsights      : (已设置)')
if (result.fixLoopContext) console.log('fixLoopContext       :', JSON.stringify(result.fixLoopContext))
if (result.batchScope) console.log('batchScope           :', JSON.stringify(result.batchScope))

console.log('\n── agentPrompt 章节结构 ──')
const sections = splitSections(result.agentPrompt)
console.log(`共 ${sections.length} 个一级章节：\n`)
for (const s of sections) {
  console.log(`### ${s.heading}`)
  console.log(`    (非空行数: ${s.lineCount})`)
  for (const p of s.preview) {
    if (p.trim() !== '') console.log(`    | ${p}`)
  }
  if (s.preview.length === 4) console.log('    | …')
  console.log('')
}

console.log('─'.repeat(72))
console.log(`agentPrompt 总长度: ${result.agentPrompt.length} 字符 / ${result.agentPrompt.split('\n').length} 行`)
console.log('─'.repeat(72))
