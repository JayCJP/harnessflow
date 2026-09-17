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

/**
 * 探测知识库根与 meta.yaml 路径
 *
 * 兼容两种 KB 布局（与 kb-update.cjs 的 resolveKbRoot 同款逻辑）：
 *   - 前端项目端层布局：`.docs/llm-knowledge/frontend/meta.yaml`
 *   - 其它项目无端层：`.docs/llm-knowledge/meta.yaml`
 *
 * 多候选时按「更像真正知识库根」打分择优：
 *   含 `business/` 子目录 +2、含 `overview.md` +1；同分时保持候选顺序（扁平优先）。
 *
 * @returns {{kbRoot: string, metaPath: string|null}}
 *   kbRoot 为最终采用的知识库根（未命中时为扁平兜底目录）；metaPath 为 null 表示未找到
 */
function resolveKbRoot () {
  const docsRoot = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
  const candidates = [docsRoot]
  let entries = []
  try {
    entries = fs.readdirSync(docsRoot, { withFileTypes: true })
  } catch (e) {
    entries = []
  }
  for (const ent of entries) {
    if (ent.isDirectory()) candidates.push(path.join(docsRoot, ent.name))
  }

  const withMeta = candidates.filter(dir => fs.existsSync(path.join(dir, 'meta.yaml')))
  if (withMeta.length === 0) {
    return { kbRoot: docsRoot, metaPath: null }
  }

  const scored = withMeta.map(dir => {
    let score = 0
    if (fs.existsSync(path.join(dir, 'business'))) score += 2
    if (fs.existsSync(path.join(dir, 'overview.md'))) score += 1
    return { dir, score }
  })
  scored.sort((a, b) => b.score - a.score)

  return { kbRoot: scored[0].dir, metaPath: path.join(scored[0].dir, 'meta.yaml') }
}

// 知识库根自动探测：前端项目带端层 frontend/，其它无端层
const { kbRoot: KB_ROOT, metaPath: META_PATH } = resolveKbRoot()

function parseMetaYaml (content) {
  const result = { git: {}, domains: [] }
  const hm = content.match(/hash:\s*"([^"]+)"/)
  if (hm) result.git.hash = hm[1]

  // 逐个提取 domain 块（v2：文件字段通用化，不再假设 stores/apis/components）
  const domainRegex = /\n {2}- id:\s*"([^"]+)"([\s\S]*?)(?=\n {2}- id:\s*"|\n\S|$)/g
  let match
  while ((match = domainRegex.exec(content)) !== null) {
    const id = match[1]
    const block = match[2]
    const d = { id, path: '', files: [] }
    const pm = block.match(/path:\s*"([^"]+)"/)
    if (pm) d.path = pm[1]

    // 通用：提取所有文件类字段的值（entry_files/stores/apis/components/files/...）
    // 内联数组: field: ["a", "b"]
    const inlineRe = /(\w*(?:files|stores|apis|components|entries))\s*:\s*\[([^\]]*)\]/g
    let im
    while ((im = inlineRe.exec(block)) !== null) {
      d.files.push(...im[2].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean))
    }
    // 多行数组: field:\n  - "a"\n  - "b"
    const mlRe = /(\w*(?:files|stores|apis|components|entries))\s*:\s*\n([\s\S]*?)(?=\n\s{4}\w|\n {2}-|\n\s*$)/g
    let mm
    while ((mm = mlRe.exec(block)) !== null) {
      const items = mm[2].match(/- "([^"]+)"/g)
      if (items) d.files.push(...items.map(s => s.replace(/-?\s*"([^"]+)"/, '$1')))
    }
    d.files = [...new Set(d.files)]

    if (d.id && d.path) result.domains.push(d)
  }
  return result
}

const args = process.argv.slice(2)
const mode = args.includes('--all') ? 'all' : args.includes('--stale') ? 'stale' : args[0] ? 'single' : null
const targetId = mode === 'single' ? args[0] : null

if (!mode) {
  console.error(JSON.stringify({
    error: '未指定模式。全量生成用 --all，单域重生成用 <domain_id>，新鲜度检测用 --stale；增量更新请用 kb-update（基于 git diff 定位受影响域，不在本 skill 职责内）'
  }))
  process.exit(1)
}

if (!META_PATH || !fs.existsSync(META_PATH)) { console.error(JSON.stringify({ error: 'meta.yaml 不存在，请先运行 kb-init', kbRoot: KB_ROOT })); process.exit(1) }
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
  // v2：文件路径统一解析。meta.yaml 里的文件字段可能是：
  //   - 绝对相对路径（相对 PROJECT_ROOT），如 "plugins/harness/agents/*.md"
  //   - 相对 src 的文件名，如 "pc.request.js"（旧前端约定，靠 src 前缀兜底）
  const files = { all: [] }
  for (const f of (domain.files || [])) {
    // 展开通配符
    const expanded = expandGlob(f)
    for (const fp of expanded) {
      if (fs.existsSync(fp)) files.all.push(fp)
    }
  }
  const customDir = path.join(KB_ROOT, domain.path, 'custom')
  const hasCustom = fs.existsSync(customDir) && fs.readdirSync(customDir).filter(f => f.endsWith('.md')).length > 0
  result.domains.push({ id: domain.id, path: domain.path, files, hasCustom })
}

/**
 * 展开文件路径（支持通配符 *）
 * @param {string} pattern - 文件路径模式（可含 * 通配符）
 * @returns {string[]} 匹配到的绝对路径列表
 */
function expandGlob (pattern) {
  // 先尝试相对 PROJECT_ROOT 的绝对路径
  const abs = path.isAbsolute(pattern) ? pattern : path.join(PROJECT_ROOT, pattern)
  if (!pattern.includes('*')) {
    return fs.existsSync(abs) ? [abs] : []
  }
  // 含通配符：拆目录 + 文件名模式，扫描匹配
  const dir = path.dirname(abs)
  const base = path.basename(abs)
  const regex = new RegExp('^' + base.replace(/\*/g, '.*') + '$')
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir)
      .filter(f => regex.test(f))
      .map(f => path.join(dir, f))
  } catch (e) { return [] }
}

console.log(JSON.stringify(result, null, 2))
