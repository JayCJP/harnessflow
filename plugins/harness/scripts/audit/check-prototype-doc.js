#!/usr/bin/env node
/**
 * check-prototype-doc.cjs — 原型文档完整性检查
 *
 * 检查原型分析文档是否存在且包含必要章节。
 * 在创建工作流前由主 Agent 调用，确保原型已充分分析。
 *
 * 用法:
 *   node .codebuddy/scripts/check-prototype-doc.cjs <storyId>
 *
 * 检查项:
 *   1. 文件 .codebuddy/plans/<storyId>/prototype-analysis.md 存在
 *   2. 文档包含必要章节:
 *      - ## 原型概述
 *      - ## 页面与交互
 *      - ## 字段定义
 *      - ## 业务规则
 *      - ## 待确认项
 *   3. 待确认项不为空时，列出清单供用户确认
 *
 * 输出:
 *   JSON 格式: { complete: boolean, missingSections: string[], pendingItems: string[] }
 */

const fs = require('fs')
const path = require('path')
const { PLANS_DIR } = require('../lib/state')

// ─── 必要章节定义 ───────────────────────────────────────────────

/** 原型文档必须包含的章节 */
const REQUIRED_SECTIONS = [
  { pattern: /##\s*原型抓取方法/, name: '原型抓取方法', description: '使用 Playwright MCP 抓取原型的工具、策略和抓取内容摘要' },
  { pattern: /##\s*原型概述/, name: '原型概述', description: '原型的整体说明和背景' },
  { pattern: /##\s*页面与交互/, name: '页面与交互', description: '页面布局、交互流程、UI 元素描述' },
  { pattern: /##\s*字段定义/, name: '字段定义', description: '涉及的数据字段、类型、默认值' },
  { pattern: /##\s*业务规则/, name: '业务规则', description: '业务逻辑、分配规则、条件判断等' },
  { pattern: /##\s*待确认项/, name: '待确认项', description: '需要与产品/后端确认的疑问点' }
]

// ─── 参数解析 ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const storyId = args[0]

if (!storyId) {
  console.error('用法: node check-prototype-doc.cjs <storyId>')
  console.error('示例: node check-prototype-doc.cjs STORY-001')
  process.exit(1)
}

/**
 * 检查原型文档的完整性
 * @param {string} storyId - Story ID
 * @returns {{ complete: boolean, exists: boolean, missingSections: string[], pendingItems: string[], docPath: string }}
 */
function checkPrototypeDoc (storyId) {
  const docPath = path.join(PLANS_DIR, storyId, 'prototype-analysis.md')
  const result = {
    complete: false,
    exists: false,
    missingSections: [],
    pendingItems: [],
    docPath
  }

  // 1. 检查文件存在
  if (!fs.existsSync(docPath)) {
    result.missingSections = REQUIRED_SECTIONS.map(s => s.name)
    return result
  }

  result.exists = true

  // 2. 读取文件内容
  const content = fs.readFileSync(docPath, 'utf-8')

  // 3. 检查必要章节
  for (const section of REQUIRED_SECTIONS) {
    if (!section.pattern.test(content)) {
      result.missingSections.push(section.name)
    }
  }

  // 4. 提取待确认项
  const pendingSectionMatch = content.match(/##\s*待确认项[\s\S]*?(?=\n##\s|$)/)
  if (pendingSectionMatch) {
    const pendingSection = pendingSectionMatch[0]
    // 提取列表项
    const itemMatches = pendingSection.match(/^\s*[-*]\s+.+$/gm)
    if (itemMatches) {
      result.pendingItems = itemMatches.map(item =>
        item.trim().replace(/^[-*]\s+/, '')
      )
    }
  }

  // 5. 判断完整性
  result.complete = result.missingSections.length === 0

  return result
}

// ─── 执行 ───────────────────────────────────────────────────────

const result = checkPrototypeDoc(storyId)

// 输出人类可读的检查结果
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`原型文档检查: ${storyId}`)
console.log(`路径: ${result.docPath}`)
console.log(`文件存在: ${result.exists ? '✅' : '❌'}`)
console.log(`完整性: ${result.complete ? '✅ 完整' : '❌ 不完整'}`)

if (result.missingSections.length > 0) {
  console.log('')
  console.log('缺失章节:')
  for (const section of result.missingSections) {
    console.log(`  ❌ ## ${section}`)
  }
}

if (result.pendingItems.length > 0) {
  console.log('')
  console.log(`待确认项 (${result.pendingItems.length} 项):`)
  for (let i = 0; i < result.pendingItems.length; i++) {
    console.log(`  ${i + 1}. ${result.pendingItems[i]}`)
  }
  console.log('')
  console.log('⚠️ 待确认项必须在 Phase 0 → 1 推进前全部解决')
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

// 同时输出 JSON 格式（供脚本调用方解析）
console.log('')
console.log(JSON.stringify(result, null, 2))

process.exit(result.complete ? 0 : 1)
