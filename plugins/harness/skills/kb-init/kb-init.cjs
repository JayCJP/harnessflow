#!/usr/bin/env node
/**
 * kb-init.cjs — 知识库目录骨架初始化脚本
 *
 * 自包含于 kb-init Skill 目录中，可从任意项目调用。
 * "脚本负责执行" — 创建目录、复制模板等确定性操作。
 *
 * 用法: node "<skill_dir>/kb-init.cjs" [--force]
 */

const fs = require('fs')
const path = require('path')

// Skill 捆绑目录
const SKILL_DIR = __dirname
const TMPL_SRC = path.join(SKILL_DIR, 'templates')
// 目标项目（调用时的 cwd）
const PROJECT_ROOT = process.cwd()
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge', 'frontend')

const DOMAINS = ['chat', 'group-chat', 'ticket', 'settings', 'voice', 'permission', 'data']

const DIRS = [
  ...DOMAINS.map(d => path.join(KB_ROOT, 'business', d)),
  ...DOMAINS.map(d => path.join(KB_ROOT, 'business', d, 'custom')),
  path.join(KB_ROOT, 'common', 'conventions'),
  path.join(KB_ROOT, 'common', 'lib_usage'),
  path.join(KB_ROOT, 'common', 'tech'),
  path.join(KB_ROOT, 'templates')
]

const CUSTOM_README = (d) =>
  `# ${d} 域 — 手工文档索引\n\n<!-- CUSTOM:START -->\n后续开发中由人工补充。\n<!-- CUSTOM:END -->\n`

const COMMON_READMES = {
  conventions: '# 开发规范\n\n<!-- CUSTOM:START -->\n| 规范 | 文件 |\n|--|--|\n| 编码规范 | .codebuddy/rules/ |\n<!-- CUSTOM:END -->\n',
  lib_usage:   '# 常用库指南\n\n<!-- CUSTOM:START -->\n<!-- CUSTOM:END -->\n',
  tech:        '# 技术专题\n\n<!-- CUSTOM:START -->\n<!-- CUSTOM:END -->\n'
}

const args = process.argv.slice(2)
const force = args.includes('--force')
let created = 0, skipped = 0
const errors = []

console.log('kb-init — 知识库目录骨架初始化')
console.log(`Skill: ${SKILL_DIR}`)
console.log(`项目: ${PROJECT_ROOT}\n`)

// 1. 创建目录
for (const dir of DIRS) {
  if (fs.existsSync(dir)) { skipped++; continue }
  try { fs.mkdirSync(dir, { recursive: true }); created++; console.log(`  ✅ ${path.relative(PROJECT_ROOT, dir)}`) }
  catch (e) { errors.push(`创建失败: ${dir}`) }
}

// 2. custom/README.md
for (const d of DOMAINS) {
  const f = path.join(KB_ROOT, 'business', d, 'custom', 'README.md')
  if (fs.existsSync(f) && !force) { skipped++; continue }
  try { fs.writeFileSync(f, CUSTOM_README(d), 'utf-8'); created++; console.log(`  ✅ business/${d}/custom/README.md`) }
  catch (e) { errors.push(`写入失败: ${f}`) }
}

// 3. common/README.md
for (const [n, c] of Object.entries(COMMON_READMES)) {
  const f = path.join(KB_ROOT, 'common', n, 'README.md')
  if (fs.existsSync(f) && !force) { skipped++; continue }
  fs.writeFileSync(f, c, 'utf-8'); created++; console.log(`  ✅ common/${n}/README.md`)
}

// 4. 复制模板（Skill 捆绑 → 项目）
if (fs.existsSync(TMPL_SRC)) {
  const files = fs.readdirSync(TMPL_SRC).filter(f => f.endsWith('.template.md'))
  for (const f of files) {
    const dst = path.join(path.join(KB_ROOT, 'templates'), f)
    if (fs.existsSync(dst) && !force) { skipped++; continue }
    fs.copyFileSync(path.join(TMPL_SRC, f), dst)
    created++; console.log(`  ✅ templates/${f}`)
  }
}

console.log(`\n完成: 创建 ${created}, 跳过 ${skipped}, 错误 ${errors.length}`)
if (errors.length) errors.forEach(e => console.error(`  ❌ ${e}`))
