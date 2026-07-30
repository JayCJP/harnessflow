#!/usr/bin/env node
/**
 * gen-docs.cjs — 文档生成扫描脚本
 *
 * 自包含于 gen-project-docs Skill。读取 meta.yaml，输出需扫描的文件清单。
 *
 * 用法:
 *   node "<skill_dir>/gen-docs.cjs" [domain_id]   # 单域
 *   node "<skill_dir>/gen-docs.cjs" --all          # 全量
 *   node "<skill_dir>/gen-docs.cjs" --stale        # 新鲜度检测
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PROJECT_ROOT = process.cwd()
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge', 'frontend')
const META_PATH = path.join(KB_ROOT, 'meta.yaml')
const SRC_ROOT = path.join(PROJECT_ROOT, 'src')

function parseMetaYaml(content) {
  const result = { git: {}, domains: [] }
  const hm = content.match(/hash:\s*"([^"]+)"/)
  if (hm) result.git.hash = hm[1]

  // 逐个提取 domain 块
  const domainRegex = /\n  - id:\s*"([^"]+)"([\s\S]*?)(?=\n  - id:\s*"|\n\S|$)/g
  let match
  while ((match = domainRegex.exec(content)) !== null) {
    const id = match[1]
    const block = match[2]
    const d = { id, path: '', entry_files: [], stores: [], apis: [], components: [] }
    const pm = block.match(/path:\s*"([^"]+)"/)
    if (pm) d.path = pm[1]
    for (const field of ['entry_files', 'stores', 'apis', 'components']) {
      // 内联数组: field: ["a", "b"]
      const inl = block.match(new RegExp(field + ':\\s*\\[(.+?)\\]', 's'))
      if (inl) { d[field] = inl[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean); continue }
      // 多行数组: field:\n  - "a"\n  - "b"
      const ml = block.match(new RegExp(field + ':\\s*\\n([\\s\\S]*?)(?=\\n\\s{4}\\w|\\n  -|\\n\\s*$)', 's'))
      if (ml) {
        const items = ml[1].match(/- "([^"]+)"/g)
        if (items) d[field] = items.map(s => s.replace(/-?\s*"([^"]+)"/, '$1'))
      }
    }
    if (d.id && d.path) result.domains.push(d)
  }
  return result
}

const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--stale') ? 'stale' : args[0] ? 'single' : 'incremental'
const targetId = mode === 'single' ? args[0] : null

if (!fs.existsSync(META_PATH)) { console.error(JSON.stringify({ error: 'meta.yaml 不存在，请先运行 kb-init' })); process.exit(1) }
const meta = parseMetaYaml(fs.readFileSync(META_PATH, 'utf-8'))

if (mode === 'stale') {
  try {
    const cur = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 5000 }).trim()
    const diff = execSync(`git diff --name-only ${meta.git.hash || cur}..${cur}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 10000 }).trim()
    const changed = diff ? diff.split('\n').filter(Boolean).length : 0
    console.log(JSON.stringify({ mode: 'stale', stale: changed > 0, changedCount: changed }))
  } catch (e) { console.log(JSON.stringify({ mode: 'stale', stale: false })) }
  process.exit(0)
}

const domains = mode === 'single' ? meta.domains.filter(d => d.id === targetId) : meta.domains
const result = { mode, domains: [] }

for (const domain of domains) {
  const files = { entry: [], stores: [], apis: [], components: [] }
  for (const f of domain.entry_files) { const fp = path.join(PROJECT_ROOT, f); if (fs.existsSync(fp)) files.entry.push(fp) }
  for (const f of domain.stores) { const fp = path.join(SRC_ROOT, 'store', f); if (fs.existsSync(fp)) files.stores.push(fp) }
  for (const f of domain.apis) { const fp = path.join(SRC_ROOT, 'api', f); if (fs.existsSync(fp)) files.apis.push(fp) }
  for (const f of domain.components) { const fp = path.join(SRC_ROOT, f); if (fs.existsSync(fp)) files.components.push(fp) }
  const customDir = path.join(KB_ROOT, domain.path, 'custom')
  const hasCustom = fs.existsSync(customDir) && fs.readdirSync(customDir).filter(f => f.endsWith('.md')).length > 0
  result.domains.push({ id: domain.id, path: domain.path, files, hasCustom })
}

console.log(JSON.stringify(result, null, 2))
