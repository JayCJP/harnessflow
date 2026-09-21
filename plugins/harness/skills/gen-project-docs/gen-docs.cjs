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
 *
 * 说明:
 *   - 知识库根探测与 meta.yaml 解析由 `scripts/lib/kb-root.js` 统一提供
 *     （此前与 kb-update.cjs 各有一份副本且签名漂移，2026-09 收敛）。**纯迁移，行为不变**：
 *     项目根仍按历史约定取 `process.cwd()`，域过滤保留「必须有 path」的历史条件。
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
// 知识库根探测与 meta.yaml 解析的唯一信源（此前与 kb-update.cjs 各有一份漂移副本）
const { resolveKbRoot, parseMetaYaml } = require('../../scripts/lib/kb-root')

const PROJECT_ROOT = process.cwd()

// 知识库根自动探测：前端项目带端层 frontend/，其它无端层
const { kbRoot: KB_ROOT, metaPath: META_PATH } = resolveKbRoot('', PROJECT_ROOT)

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
// 保留历史的「域必须有 path」过滤：旧版本内联解析器只在 `d.id && d.path` 时才收集域，
// 共用解析器不再做此判断 —— 这里显式补回，保证迁移后 gen-docs 的输出与迁移前逐字一致。
meta.domains = meta.domains.filter(d => d.id && d.path)

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
