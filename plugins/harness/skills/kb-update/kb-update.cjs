#!/usr/bin/env node
/**
 * kb-update.cjs — 知识库增量更新脚本
 *
 * 自包含于 kb-update Skill，从任意前端项目调用。
 * "脚本负责执行": git diff + meta.yaml 数据驱动域匹配。
 * 输出 JSON 供 kb-update Skill (AI) 消费。
 *
 * 用法:
 *   node "<skill_dir>/kb-update.cjs"                     # 自动探测知识库根 + 自动采集 diff
 *   node "<skill_dir>/kb-update.cjs" <commitHash>         # 指定 lastHash（覆盖 meta.yaml 记录值）
 *   node "<skill_dir>/kb-update.cjs" --kb-root=<path>     # 指定知识库根（覆盖自动探测）
 *   KB_ROOT=<path> node "<skill_dir>/kb-update.cjs"       # 同上（环境变量）
 *
 * v3（2026-09-16）变更：
 *   1. 知识库根**自动探测**：兼容「扁平布局」`.docs/llm-knowledge/meta.yaml`
 *      与「带端层布局」`.docs/llm-knowledge/<platform>/meta.yaml`（如 frontend/）。
 *      旧版把 KB_ROOT 硬编码为 `.docs/llm-knowledge`，在带端层布局下 META_PATH 不存在
 *      → meta = {} → `meta.domains is not iterable` 直接崩溃。
 *   2. `meta.domains` 缺失时不再抛 TypeError，降级为空域列表（errors/warnings 中说明）。
 *   3. 变更文件采集**并入工作区未提交改动**（`git diff HEAD` + untracked），
 *      并输出 `diffSource` 说明来源；移除语义错误的 `HEAD~1..HEAD` 兜底
 *      （hash 相同或文档落后时它会错误地返回上一轮提交的 diff）。
 *   4. 支持 CLI 位置参数 commitHash（旧版注释里有但代码未实现）。
 *   5. git 统一带 `-c core.quotepath=false` 并新增路径归一化，修复含中文/空格路径被输出成
 *      `"\345\..."` 八进制转义串、导致域匹配全部失配的问题。
 *
 * v4（2026-09-16）变更：
 *   6. **域健康检查**：域未解析到任何文件字段、或文件字段指向已不存在的路径 → warning
 *      （文件被删除但 meta.yaml 还留着 entry 的静默失配，从此可被发现）。
 *   7. **知识库自身变更分离**：`.docs/llm-knowledge/**` 不再混入 `changedFiles`，
 *      单独回报为 `kbDocFiles`，避免噪音与「改 KB 触发 KB 更新」的自触发误判；
 *      需要合并时加 `--include-kb-docs`。
 *   8. **原型文档去重**：`meta.yaml#design_docs` 已登记的 story 不再重复报出
 *      （报在 `skippedDesignStories`），避免同一份原型文档被反复搬运。
 *   9. **原型文档目标域不再猜**：移除「兜底取第一个受影响域」等启发式，匹配不到就置
 *      `targetDomain: null` + warning，由 AI/人工决定。
 *  10. 新增 `--help`。
 *  11. 修复 `fileFieldRe` 块形式解析缺陷：CRLF 文件 + 字段恰为域块最后一个字段时，
 *      前瞻三分支全部落空导致该字段被**静默丢弃**（真实 meta.yaml 只是恰好未触发）。
 *      前瞻改为 `\r?\n[ \t]*(?:\w|#|- id:)` / `\r?\n[ \t]*$` / `$`，LF 与 CRLF 通吃。
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const PROJECT_ROOT = process.cwd()

/** 采集过程中的硬错误（Skill 侧据此标记 completed_with_errors） */
const errors = []
/** 非阻断提示（探测降级 / 无可采集来源等） */
const warnings = []

/**
 * 安全执行 git 命令
 *
 * 统一带 `-c core.quotepath=false`：否则含中文等非 ASCII 的路径会被输出成
 * `"\345\234\250..."` 形式的八进制转义串，导致后续域匹配全部失配。
 *
 * @param {string} args git 参数串（不含前导 `git`）
 * @returns {string} stdout（trim 后）；失败返回空串，避免整脚本中断
 */
function git (args) {
  try {
    return execSync(`git -c core.quotepath=false ${args}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 15000 }).trim()
  } catch (e) {
    return ''
  }
}

/**
 * 归一化 git 输出的路径
 *
 * 兜底处理 git 仍会加引号的情形（路径含 `"` / `\` / 控制字符）：剥掉包裹引号并还原转义。
 *
 * @param {string} raw git 输出的一行路径
 * @returns {string} 可直接与 meta.yaml 文件字段做前缀匹配的路径
 */
function normalizePath (raw) {
  let p = raw.trim()
  if (p.length > 1 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1)
    const hadOctal = /\\([0-7]{3})/.test(p)
    p = p.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
    // 八进制转义还原出的是 latin1 字节串，需按 UTF-8 再解一次拿回真实字符
    if (hadOctal) {
      try {
        p = Buffer.from(p, 'latin1').toString('utf8')
      } catch (e) { /* 还原失败则保留当前值 */ }
    }
  }
  return p
}

/**
 * 解析 CLI 参数
 *
 * 支持的参数：
 *   <commitHash>         位置参数，指定 lastHash（覆盖 meta.yaml 的 git.hash）
 *   --kb-root=<path>     指定知识库根（覆盖自动探测）
 *   --include-kb-docs    把知识库自身文档变更也并入 changedFiles（默认分离到 kbDocFiles）
 *   --help / -h          打印用法
 *
 * @param {string[]} argv process.argv
 * @returns {{commitHash: string, kbRoot: string, includeKbDocs: boolean, help: boolean}}
 */
function parseArgs (argv) {
  const out = { commitHash: '', kbRoot: '', includeKbDocs: false, help: false }
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--include-kb-docs') {
      out.includeKbDocs = true
    } else if (arg.startsWith('--kb-root=')) {
      out.kbRoot = arg.slice('--kb-root='.length).trim()
    } else if (!arg.startsWith('--')) {
      out.commitHash = arg.trim()
    }
  }
  return out
}

/** 打印用法（--help） */
function printUsage () {
  const lines = [
    'kb-update.cjs — 知识库增量更新：git 变更采集 + meta.yaml 域匹配 + 原型文档扫描',
    '',
    '用法:',
    '  node kb-update.cjs                     自动探测知识库根 + 自动采集 diff',
    '  node kb-update.cjs <commitHash>        指定 lastHash（覆盖 meta.yaml 的 git.hash）',
    '  node kb-update.cjs --kb-root=<path>    指定知识库根（覆盖自动探测）',
    '  node kb-update.cjs --include-kb-docs   把知识库自身文档变更也并入 changedFiles',
    '  node kb-update.cjs --help              打印本帮助',
    '',
    '环境变量:',
    '  KB_ROOT=<path>                         同 --kb-root',
    '',
    '输出（stdout JSON）:',
    '  kbRoot/metaPath     实际采用的知识库根与 meta.yaml',
    '  lastHash/currentHash/diffSource          变更来源（committed / working-tree / untracked）',
    '  changedFiles        业务变更文件（默认已剔除知识库自身文档）',
    '  kbDocFiles          知识库自身文档变更（单独回报，避免自触发噪音）',
    '  affectedDomains     命中 meta.yaml 文件字段的业务域',
    '  designDocs          待搬运的原型文档（已在 meta.yaml 登记的会进 skippedDesignStories）',
    '  skippedDesignStories 已登记、本次跳过的原型文档',
    '  warnings/errors     非阻断提示 / 硬错误',
    ''
  ]
  console.log(lines.join('\n'))
}

/**
 * 探测知识库根目录与 meta.yaml 路径
 *
 * 兼容两种 KB 布局（不再要求固定层级）：
 *   - 扁平布局（v2）: `<root>/.docs/llm-knowledge/meta.yaml`
 *   - 带端层布局（v1）: `<root>/.docs/llm-knowledge/<platform>/meta.yaml`（如 `frontend/`）
 *
 * 当多个候选都存在 meta.yaml 时按「更像真正知识库根」打分择优：
 * 含 `business/` 子目录 +2、含 `overview.md` +1；同分时保持候选顺序（扁平优先）。
 *
 * @param {string} overrideDir `--kb-root=` / 环境变量 KB_ROOT 指定的根（可相对可绝对）
 * @returns {{kbRoot: string, metaPath: string|null, checked: string[]}}
 *   kbRoot 为最终采用的知识库根（未命中时为优先兜底目录）；metaPath 为 null 表示未找到
 */
function resolveKbRoot (overrideDir) {
  const docsRoot = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
  const candidates = []

  if (overrideDir) {
    candidates.push(path.resolve(PROJECT_ROOT, overrideDir))
  } else {
    candidates.push(docsRoot)
    // 扫描一层子目录（frontend / h5 / miniprogram / ...）
    let entries = []
    try {
      entries = fs.readdirSync(docsRoot, { withFileTypes: true })
    } catch (e) {
      entries = []
    }
    for (const ent of entries) {
      if (ent.isDirectory()) candidates.push(path.join(docsRoot, ent.name))
    }
  }

  const withMeta = candidates.filter(dir => fs.existsSync(path.join(dir, 'meta.yaml')))
  if (withMeta.length === 0) {
    return { kbRoot: candidates[0] || docsRoot, metaPath: null, checked: candidates }
  }

  const scored = withMeta.map(dir => {
    let score = 0
    if (fs.existsSync(path.join(dir, 'business'))) score += 2
    if (fs.existsSync(path.join(dir, 'overview.md'))) score += 1
    return { dir, score }
  })
  scored.sort((a, b) => b.score - a.score)

  return { kbRoot: scored[0].dir, metaPath: path.join(scored[0].dir, 'meta.yaml'), checked: candidates }
}

/** 简化 YAML 解析 — 只提取 domains[]、git.hash 与已登记的 design_docs story_id（v2：文件字段通用化） */
function parseMetaYaml (content) {
  const result = { git: {}, domains: [], designStoryIds: [] }
  // 只匹配 git: 块下的 hash（避免误匹配 doc_stats.git_hash_at_generation）
  const gitBlock = content.match(/git:\s*\n([\s\S]*?)(?=\n\S|$)/)
  if (gitBlock) {
    const hashMatch = gitBlock[1].match(/hash:\s*"([^"]+)"/)
    if (hashMatch) result.git.hash = hashMatch[1]
  }

  // 收集所有 design_docs 条目的 story_id（用于原型文档去重：已搬运过的不再重复报出）
  const storyIdRe = /story_id:\s*"([^"]+)"/g
  let storyMatch
  while ((storyMatch = storyIdRe.exec(content)) !== null) {
    if (!result.designStoryIds.includes(storyMatch[1])) result.designStoryIds.push(storyMatch[1])
  }

  // 全局匹配 domains: 块中 2 空格缩进的 - id:"xxx"（domain 级别）
  const domainsBlock = content.match(/domains:\s*\n([\s\S]*?)(?=\n\S|$)/)
  if (!domainsBlock) return result

  const idRe = /^ {2}- id:\s*"([^"]+)"/gm
  let m
  while ((m = idRe.exec(domainsBlock[1])) !== null) {
    result.domains.push({ id: m[1], path: '', files: [] })
  }

  // 补齐每个 domain 的 path 和文件字段（v2：不再假设前端字段名）
  // 文件字段名可能因项目类型而异：entry_files / stores / apis / components / files / ...
  for (const domain of result.domains) {
    const pathRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"[\s\S]*?path:\s*"([^"]+)"`)
    const pathMatch = domainsBlock[1].match(pathRe)
    if (pathMatch) domain.path = pathMatch[1]

    // 提取该 domain 块的所有「文件类」字段值，统一归入 files[]
    const domainBlockRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"([\s\S]*?)(?=\n  - id:\s*"|\n\S|$)`)
    const blockMatch = domainsBlock[1].match(domainBlockRe)
    if (!blockMatch) continue
    const block = blockMatch[1]

    // 匹配任意 *_files / stores / apis / components / files 等字段
    // ⚠️ 块形式（`entry_files:` 换行 + `- "..."` 列表）必须同时兼容 LF / CRLF，
    //    且前瞻要覆盖「块结尾只剩一个 \r」的情形，否则该字段会被**静默丢弃**
    //    （历史缺陷：CRLF + 字段恰为域块最后一个字段时，旧前瞻三分支全部落空 → 整个匹配失败）。
    const fileFieldRe = /\b(\w*(?:files|stores|apis|components|entries))\s*:\s*(\[[\s\S]*?\]|\r?\n[ \t]*- "[\s\S]*?(?=\r?\n[ \t]*(?:\w|#|- id:)|\r?\n[ \t]*$|$))/g
    let fm
    const collected = []
    while ((fm = fileFieldRe.exec(block)) !== null) {
      const raw = fm[2]
      // 提取所有被引号包裹的字符串
      const strs = raw.match(/"([^"]+)"/g)
      if (strs) collected.push(...strs.map(s => s.replace(/"/g, '')))
    }
    // 兜底：匹配内联数组形式的 entry_files: ["a", "b"]
    const inlineRe = /entry_files\s*:\s*\[([^\]]+)\]/g
    let im
    while ((im = inlineRe.exec(block)) !== null) {
      collected.push(...im[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean))
    }
    domain.files = [...new Set(collected)]
  }

  return result
}

/** 判断变更文件是否属于指定域（前缀匹配 meta.yaml 中的文件字段，v2：字段通用化） */
function matchFileToDomain (file, domain) {
  const sources = domain.files || []
  // 通配符支持：entry_files 里的 "plugins/harness/agents/*.md" 去掉 *.md 后做前缀匹配
  return sources.some(s => {
    const normalized = s.replace(/\*/g, '')  // 去掉通配符
    return file.startsWith(normalized) || file.includes(normalized.replace(/\/$/, ''))
  })
}

// ─── 主逻辑 ──────────────────────────────────────────────────

const cli = parseArgs(process.argv)
if (cli.help) {
  printUsage()
  process.exit(0)
}
const { kbRoot: KB_ROOT, metaPath: META_PATH, checked: KB_CHECKED } = resolveKbRoot(cli.kbRoot || process.env.KB_ROOT || '')

if (!META_PATH) {
  warnings.push(
    '未找到 meta.yaml（已探测：' + (KB_CHECKED.length ? KB_CHECKED.join(', ') : path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')) +
    '）；受影响域匹配将为空，请用 --kb-root=<path> 指定知识库根'
  )
}

let currentHash = git('rev-parse HEAD')
if (!currentHash) {
  errors.push('git rev-parse HEAD failed（不在 git 仓库或 git 不可用）')
  currentHash = ''
}

let meta = {}
if (META_PATH) {
  try {
    meta = parseMetaYaml(fs.readFileSync(META_PATH, 'utf-8'))
  } catch (e) {
    warnings.push('meta.yaml 解析失败：' + e.message)
    meta = {}
  }
}
if (!Array.isArray(meta.domains)) {
  warnings.push('meta.yaml 未解析出 domains[]，受影响域匹配将为空')
  meta.domains = []
}

// lastHash 优先级：CLI 位置参数 > meta.yaml 记录值 > 当前 HEAD
const lastHash = cli.commitHash || meta.git.hash || currentHash

// ─── 域健康检查（非阻断，只 warning） ────────────────────────
// 痛点：文件被删除但 meta.yaml 还留着 entry_files 时，该域会「静默失配」——没人报错也没人发现。
// 仅对「看起来是完整仓库相对路径」的字段做存在性校验（`<目录>/<文件>.<扩展名>` 且不含通配符）；
// 纯文件名片段（如 `imasstapi.request.js`）与目录（`src/views/pc/manage/`）无法判断，跳过。
const STALE_ENTRY_RE = /^(?!.*\*)\S+\/\S+\.(vue|js|jsx|ts|tsx|mjs|cjs|md|json|css|scss|less|html)$/
const emptyFieldDomains = []
const staleFieldEntries = []
for (const domain of meta.domains) {
  if (!domain.files || domain.files.length === 0) {
    emptyFieldDomains.push(domain.id)
    continue
  }
  const stale = domain.files.filter(f => STALE_ENTRY_RE.test(f) && !fs.existsSync(path.join(PROJECT_ROOT, f)))
  if (stale.length > 0) staleFieldEntries.push(`${domain.id} → ${stale.join(', ')}`)
}
if (emptyFieldDomains.length > 0) {
  warnings.push(`以下域未解析到任何文件字段，将永远不会被匹配（检查 meta.yaml 中 entry_files/files/apis 等字段的缩进与命名）：${emptyFieldDomains.join(', ')}`)
}
if (staleFieldEntries.length > 0) {
  warnings.push(`以下域的文件字段指向不存在的路径，建议改为现存精确文件或移除（否则该域会静默失配）：${staleFieldEntries.join('；')}`)
}

// ─── 变更文件采集 ────────────────────────────────────────────
// 三个来源取并集，任一为空则跳过；全部为空时 diffSource = 'none'
const changedSet = new Set()
const addFiles = out => {
  out.split('\n').map(normalizePath).filter(Boolean).forEach(f => changedSet.add(f))
}
const diffSources = []

// 1) 已提交区间 lastHash..currentHash
if (lastHash && currentHash && lastHash !== currentHash) {
  const rangeOut = git(`diff --name-only ${lastHash}..${currentHash}`)
  if (rangeOut) {
    addFiles(rangeOut)
    diffSources.push(`committed:${lastHash.slice(0, 8)}..${currentHash.slice(0, 8)}`)
  }
}

// 2) 工作区未提交改动（含暂存 / 未暂存 / 删除）
const workingTreeOut = git('diff --name-only HEAD')
if (workingTreeOut) {
  addFiles(workingTreeOut)
  diffSources.push('working-tree')
}

// 3) 未跟踪的新文件
const untrackedOut = git('ls-files --others --exclude-standard')
if (untrackedOut) {
  addFiles(untrackedOut)
  diffSources.push('untracked')
}

// ─── 知识库自身文档分离（避免噪音与「改 KB 触发 KB 更新」的自触发误判） ───
// 前缀来源：约定的 `.docs/llm-knowledge/` + 本次实际采用的知识库根
const KB_DOC_PREFIXES = ['.docs/llm-knowledge/']
const kbRootRel = path.relative(PROJECT_ROOT, KB_ROOT).replace(/\\/g, '/')
if (kbRootRel && !kbRootRel.startsWith('..') && !KB_DOC_PREFIXES.includes(kbRootRel + '/')) {
  KB_DOC_PREFIXES.push(kbRootRel + '/')
}

const allChangedFiles = [...changedSet]
const kbDocFiles = allChangedFiles.filter(f => KB_DOC_PREFIXES.some(p => f.startsWith(p)))
const changedFiles = cli.includeKbDocs ? allChangedFiles : allChangedFiles.filter(f => !kbDocFiles.includes(f))

if (allChangedFiles.length === 0) {
  warnings.push('未采集到任何变更文件（已提交区间为空且工作区干净）')
}
if (diffSources.length === 0) diffSources.push('none')

// 匹配受影响域（meta.domains 已保证为数组）
const affectedDomains = []
for (const domain of meta.domains) {
  const matched = changedFiles.filter(f => matchFileToDomain(f, domain))
  if (matched.length > 0) affectedDomains.push({ id: domain.id, path: domain.path, matchedFiles: matched })
}

// ─── 原型文档扫描 ──────────────────────────────────────────
// 扫描 plans 目录下的 prototype-analysis.md，匹配到受影响域
const PLANS_DIR = path.join(PROJECT_ROOT, '.codebuddy', 'plans')
const DESIGN_DOCS_DIR = path.join(KB_ROOT, 'business')
const designDocs = []
/** 已在 meta.yaml#design_docs 登记、本次跳过的原型文档 storyId（避免反复搬运同一份文档） */
const skippedDesignStories = []

if (fs.existsSync(PLANS_DIR)) {
  const storyDirs = fs.readdirSync(PLANS_DIR).filter(d => {
    const stat = fs.statSync(path.join(PLANS_DIR, d))
    return stat.isDirectory()
  })

  for (const storyId of storyDirs) {
    const protoPath = path.join(PLANS_DIR, storyId, 'prototype-analysis.md')
    if (!fs.existsSync(protoPath)) continue

    // 去重：meta.yaml#design_docs 已登记的 story 不再重复报出
    if (meta.designStoryIds.includes(storyId)) {
      skippedDesignStories.push(storyId)
      continue
    }

    // 读取原型文档，提取标题和 prototype_url
    const content = fs.readFileSync(protoPath, 'utf-8')
    const titleMatch = content.match(/#\s*(.+)/)
    const urlMatch = content.match(/prototype_url:\s*(.+)/) || content.match(/原型链接.*?(https?:\/\/[^\s)]+)/)
    const title = titleMatch ? titleMatch[1].trim() : storyId
    const prototypeUrl = urlMatch ? urlMatch[1].trim() : ''

    // 匹配域：通过 story e2e-state.json 的 domain 字段，或通过变更文件匹配
    const statePath = path.join(PLANS_DIR, storyId, 'e2e-state.json')
    let targetDomain = null
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
        if (state.domain && meta.domains.some(d => d.id === state.domain)) {
          targetDomain = state.domain
        }
      } catch (e) {}
    }

    // 🚫 不猜：只采信 e2e-state.json 的显式 domain。
    //    原先的「命中 settings 优先 / 兜底取第一个受影响域」启发式会把原型文档错配到无关域，
    //    已移除；匹配不到时 targetDomain 保持 null（Skill Step 4 会跳过），并给出 warning 由人工判断。
    if (!targetDomain) {
      warnings.push(`原型文档 "${storyId}" 未匹配到目标域（e2e-state.json 无 domain 或该 domain 不在 meta.yaml 中），targetDomain 置 null，请人工确认是否需要搬运`)
    }

    const docFileName = (title || storyId).replace(/[^\w\u4e00-\u9fff-]/g, '-').replace(/-+/g, '-').toLowerCase() + '.md'

    designDocs.push({
      storyId,
      title: title || storyId,
      prototypeUrl,
      sourcePath: protoPath,
      targetDomain,
      targetPath: targetDomain ? `business/${targetDomain}/design/${docFileName}` : null,
      targetDir: targetDomain ? path.join(DESIGN_DOCS_DIR, targetDomain, 'design') : null,
      fileName: docFileName
    })
  }
}

// 输出（保持历史字段不变，新增字段为增量信息）
console.log(JSON.stringify({
  kbRoot: KB_ROOT,
  metaPath: META_PATH,
  lastHash,
  currentHash,
  diffSource: diffSources.join('+'),
  changedFiles,
  kbDocFiles,
  affectedDomains,
  designDocs,
  skippedDesignStories,
  warnings,
  errors
}, null, 2))
