#!/usr/bin/env node
/**
 * kb-init.cjs — 知识库目录骨架初始化脚本（v2：项目画像 + 动态域扫描）
 *
 * 自包含于 kb-init Skill 目录中，可从任意项目调用。
 * "脚本负责执行" — 创建目录、复制模板等确定性操作。
 *
 * v2 改动：消除硬编码客服业务域，改为「项目画像 + 自动扫描」：
 *   1. 推断项目画像（project_type / source_root / domain_axis）
 *   2. 按 project_type 用通用启发式扫描真实域
 *   3. 文档模板按 project_type 选择（前端/插件/后端/库）
 *
 * 用法: node "<skill_dir>/kb-init.cjs" [--force] [--project-type <type>]
 */

const fs = require('fs')
const path = require('path')

// Skill 捆绑目录
const SKILL_DIR = __dirname
// v2：模板分套存放（common + 各 project_type）
const TMPL_COMMON = path.join(SKILL_DIR, 'templates', 'common')
const TMPL_BY_TYPE = path.join(SKILL_DIR, 'templates')
// 目标项目（调用时的 cwd）
const PROJECT_ROOT = process.cwd()
// v2：去掉 frontend 硬编码层，知识库根为 .docs/llm-knowledge/
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
const PROFILE_PATH = path.join(KB_ROOT, '.profile.yaml')

// ─── 项目画像 ──────────────────────────────────────────────────

/**
 * 推断项目类型
 * 依据：目录结构 + 关键文件，按优先级探测
 * @returns {'frontend'|'plugin'|'backend'|'library'}
 */
function inferProjectType () {
  // 插件：存在 plugin.json / .claude-plugin / skills 目录
  if (fs.existsSync(path.join(PROJECT_ROOT, 'plugin.json')) ||
      fs.existsSync(path.join(PROJECT_ROOT, '.claude-plugin'))) return 'plugin'

  // 前端：存在 src/ + package.json 且含 vue/react 依赖
  const pkg = readJson(path.join(PROJECT_ROOT, 'package.json'))
  if (fs.existsSync(path.join(PROJECT_ROOT, 'src')) && pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    if (deps.vue || deps.react) return 'frontend'
  }

  // 后端：有 server/ 或 src/ 含 service/controller（强信号，先于 library 判断）
  if (fs.existsSync(path.join(PROJECT_ROOT, 'server')) ||
      fs.existsSync(path.join(PROJECT_ROOT, 'src', 'service')) ||
      fs.existsSync(path.join(PROJECT_ROOT, 'src', 'controller'))) return 'backend'

  // 库：存在 src/ 但无前端框架，且 package.json 有 main/exports
  if (pkg && (pkg.main || pkg.exports) && !pkg.scripts?.dev) return 'library'

  // 兜底：有 src/ 就按 frontend 处理（兼容旧行为），否则 library
  return fs.existsSync(path.join(PROJECT_ROOT, 'src')) ? 'frontend' : 'library'
}

/**
 * 推断源码根目录
 * @param {string} projectType - 项目类型
 * @returns {string} 相对 PROJECT_ROOT 的源码根（统一前向斜杠，避免 YAML 转义问题）
 */
function inferSourceRoot (projectType) {
  let result
  switch (projectType) {
    case 'plugin':
      // 插件：找 plugins/ 下的第一个子目录，或 .claude-plugin 所在目录
      const pluginsDir = path.join(PROJECT_ROOT, 'plugins')
      if (fs.existsSync(pluginsDir)) {
        const subs = fs.readdirSync(pluginsDir).filter(d => fs.statSync(path.join(pluginsDir, d)).isDirectory())
        if (subs.length > 0) { result = path.join('plugins', subs[0]); break }
      }
      result = 'plugins'
      break
    case 'backend':
      result = fs.existsSync(path.join(PROJECT_ROOT, 'server')) ? 'server' : 'src'
      break
    case 'frontend':
    case 'library':
    default:
      result = 'src'
      break
  }
  // 统一前向斜杠（Windows path.join 会产生 \，YAML 里 \ 是转义符）
  return result.replace(/\\/g, '/')
}

/**
 * 读取 JSON 文件，失败返回 null
 * @param {string} p - 文件路径
 * @returns {Object|null}
 */
function readJson (p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch (e) { /* ignore */ }
  return null
}

// ─── 域扫描 ──────────────────────────────────────────────────

/** 非知识域的目录名（第三方依赖/样式/纯规则等，不应作为检索域） */
const NON_DOMAIN_DIRS = new Set([
  'vendor', 'node_modules', 'dist', 'output-styles', 'rules',
  'assets', 'public', 'static', 'test', 'tests', '__tests__', 'coverage'
])

/**
 * 按项目类型扫描真实域（替代硬编码 DOMAINS）
 * @param {string} projectType - 项目类型
 * @param {string} sourceRoot - 源码根
 * @returns {string[]} 域 id 列表
 */
function discoverDomains (projectType, sourceRoot) {
  const root = path.join(PROJECT_ROOT, sourceRoot)

  // 通用：扫描一级子目录，过滤隐藏目录、非目录、噪音目录
  const scanSubDirs = (dir) => {
    if (!fs.existsSync(dir)) return []
    try {
      return fs.readdirSync(dir)
        .filter(d => !d.startsWith('.') && !d.startsWith('_'))
        .filter(d => !NON_DOMAIN_DIRS.has(d))
        .filter(d => fs.statSync(path.join(dir, d)).isDirectory())
    } catch (e) { return [] }
  }

  switch (projectType) {
    case 'plugin': {
      // 插件：功能模块 = 一级子目录（agents/commands/scripts/skills/hooks 等）
      const dirs = scanSubDirs(root)
      const result = []
      for (const d of dirs) {
        if (d === 'scripts') {
          // scripts 有子结构时拆分，但合并 lib+services 为 core，其余独立
          const sub = scanSubDirs(path.join(root, 'scripts'))
          if (sub.length > 0) {
            const coreParts = sub.filter(s => s === 'lib' || s === 'services')
            const others = sub.filter(s => s !== 'lib' && s !== 'services')
            if (coreParts.length > 0) result.push('scripts-core')
            for (const s of others) result.push(`scripts-${s}`)
          } else {
            result.push('scripts')
          }
        } else {
          result.push(d)
        }
      }
      return result.sort()
    }

    case 'backend': {
      // 后端：优先 service 下的二级目录（order/user/payment 等业务域）
      const serviceDirs = scanSubDirs(path.join(root, 'service'))
      if (serviceDirs.length > 0) return serviceDirs.sort()
      // 兜底：src 下的一级目录
      return scanSubDirs(root).sort()
    }

    case 'frontend': {
      // 前端：扫描 views/pages 下的一级目录 → 业务域
      for (const viewDir of ['views', 'pages']) {
        const dirs = scanSubDirs(path.join(root, viewDir))
        if (dirs.length > 0) return dirs.sort()
      }
      // 兜底：src 下的一级目录
      return scanSubDirs(root).sort()
    }

    case 'library': {
      // 库：扫描 src 下的一级目录（功能包）
      return scanSubDirs(root).sort()
    }

    default:
      return []
  }
}

/**
 * 按项目类型返回文档模板集（替代固定 8 类）
 * 5 类通用切面 + 项目类型特有切面
 * @param {string} projectType - 项目类型
 * @returns {string[]} 模板文件名列表
 */
function selectTemplates (projectType) {
  // 通用切面：所有项目类型共有
  const common = ['overview', 'architecture', 'config', 'pitfalls', 'log']

  // 项目类型特有切面
  const specific = {
    frontend: ['pages', 'api', 'store'],
    backend: ['routes', 'api', 'models'],
    plugin: ['entry-files', 'schemas', 'commands'],
    library: ['public-api', 'usage']
  }

  return [...common, ...(specific[projectType] || [])]
}

// ─── 主逻辑 ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const force = args.includes('--force')
const dryRun = args.includes('--dry-run')
const typeIdx = args.indexOf('--project-type')
const manualType = typeIdx >= 0 ? args[typeIdx + 1] : null

// 1. 项目画像（支持手动覆盖）
const projectType = manualType || inferProjectType()
const sourceRoot = inferSourceRoot(projectType)
const domainAxis = projectType === 'frontend' ? 'business' : 'feature'
const profile = { project_type: projectType, source_root: sourceRoot, domain_axis: domainAxis }

// 2. 扫描真实域
const domains = discoverDomains(projectType, sourceRoot)

let created = 0, skipped = 0
const errors = []

console.log('kb-init v2 — 知识库目录骨架初始化（项目画像 + 动态域扫描）')
console.log(`项目: ${PROJECT_ROOT}`)
console.log(`画像: project_type=${projectType}, source_root=${sourceRoot}, domain_axis=${domainAxis}`)
console.log(`识别到 ${domains.length} 个域: ${domains.join(', ') || '(空)'}\n`)

// dry-run 模式：只输出候选域清单，不落盘（供 AI/用户确认后正式初始化）
if (dryRun) {
  console.log(JSON.stringify({
    projectType,
    sourceRoot,
    domainAxis,
    domains,
    templates: selectTemplates(projectType),
    kbRoot: '.docs/llm-knowledge'
  }, null, 2))
  console.log('\n[DRY-RUN] 未落盘。确认域清单后去掉 --dry-run 正式初始化。')
  process.exit(0)
}

// 3. 创建目录
const DIRS = [
  ...domains.map(d => path.join(KB_ROOT, 'business', d)),
  ...domains.map(d => path.join(KB_ROOT, 'business', d, 'custom')),
  path.join(KB_ROOT, 'common'),
  path.join(KB_ROOT, 'templates')
]

for (const dir of DIRS) {
  if (fs.existsSync(dir)) { skipped++; continue }
  try { fs.mkdirSync(dir, { recursive: true }); created++; console.log(`  ✅ ${path.relative(PROJECT_ROOT, dir)}`) }
  catch (e) { errors.push(`创建失败: ${dir}`) }
}

// 4. 写项目画像 .profile.yaml
if (!fs.existsSync(PROFILE_PATH) || force) {
  const profileYaml = [
    '# 项目画像 — 知识库动态生成的输入',
    '# 由 kb-init 自动推断，可手动修改后重建',
    `project_type: "${profile.project_type}"`,
    `source_root: "${profile.source_root}"`,
    `domain_axis: "${profile.domain_axis}"`,
    ''
  ].join('\n')
  try { fs.writeFileSync(PROFILE_PATH, profileYaml, 'utf-8'); created++; console.log(`  ✅ .profile.yaml`) }
  catch (e) { errors.push(`写入失败: ${PROFILE_PATH}`) }
}

// 5. custom/README.md
const CUSTOM_README = (d) =>
  `# ${d} 域 — 手工文档索引\n\n<!-- CUSTOM:START -->\n后续开发中由人工补充。\n<!-- CUSTOM:END -->\n`
for (const d of domains) {
  const f = path.join(KB_ROOT, 'business', d, 'custom', 'README.md')
  if (fs.existsSync(f) && !force) { skipped++; continue }
  try { fs.writeFileSync(f, CUSTOM_README(d), 'utf-8'); created++; console.log(`  ✅ business/${d}/custom/README.md`) }
  catch (e) { errors.push(`写入失败: ${f}`) }
}

// 6. common/README.md（通用切面索引）
const COMMON_README = `# 通用知识\n\n<!-- CUSTOM:START -->\n跨域共享的开发规范、常用库指南、技术专题。\n<!-- CUSTOM:END -->\n`
const commonReadme = path.join(KB_ROOT, 'common', 'README.md')
if (!fs.existsSync(commonReadme) || force) {
  try { fs.writeFileSync(commonReadme, COMMON_README, 'utf-8'); created++; console.log(`  ✅ common/README.md`) }
  catch (e) { errors.push(`写入失败: ${commonReadme}`) }
}

// 7. 复制模板（common + 本项目类型的特有模板，Skill 捆绑 → 项目）
const selectedTemplates = selectTemplates(projectType)
const commonTemplates = ['overview', 'architecture', 'config', 'pitfalls', 'log']
// 先复制 common 通用模板
if (fs.existsSync(TMPL_COMMON)) {
  for (const f of fs.readdirSync(TMPL_COMMON).filter(f => f.endsWith('.template.md'))) {
    const dst = path.join(KB_ROOT, 'templates', f)
    if (fs.existsSync(dst) && !force) { skipped++; continue }
    fs.copyFileSync(path.join(TMPL_COMMON, f), dst)
    created++; console.log(`  ✅ templates/${f}`)
  }
}
// 再复制本项目类型的特有模板
const typeTplDir = path.join(TMPL_BY_TYPE, projectType)
if (fs.existsSync(typeTplDir)) {
  for (const f of fs.readdirSync(typeTplDir).filter(f => f.endsWith('.template.md'))) {
    const base = f.replace('.template.md', '')
    if (!selectedTemplates.includes(base)) continue
    const dst = path.join(KB_ROOT, 'templates', f)
    if (fs.existsSync(dst) && !force) { skipped++; continue }
    fs.copyFileSync(path.join(typeTplDir, f), dst)
    created++; console.log(`  ✅ templates/${f}`)
  }
}

console.log(`\n完成: 创建 ${created}, 跳过 ${skipped}, 错误 ${errors.length}`)
if (errors.length) errors.forEach(e => console.error(`  ❌ ${e}`))

// 8. 输出 JSON 供 kb-init SKILL (AI) 消费
console.log('\n' + JSON.stringify({
  projectType,
  sourceRoot,
  domainAxis,
  domains,
  templates: selectedTemplates,
  kbRoot: '.docs/llm-knowledge'
}, null, 2))
