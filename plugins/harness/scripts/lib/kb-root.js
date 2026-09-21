/**
 * kb-root.js — 知识库根探测与 meta.yaml 解析（零外部依赖底座）
 *
 * 职责:
 *   - resolveKbRoot: 探测知识库根与 meta.yaml 路径（扁平布局 / 带端层布局）
 *   - parseMetaYaml: 简化 YAML 解析，只提取 domains[]（id/path/files）、git.hash、
 *     已登记的 design_docs story_id —— 供 kb-update 做「变更文件 → 受影响域」匹配
 *   - parseDomainIndex: 解析域索引（name/keywords/path/status/files）—— 供 kb-query 做召回
 *
 * 用法:
 *   const { resolveKbRoot, parseMetaYaml, parseDomainIndex } = require('../lib/kb-root')
 *   const { kbRoot, metaPath } = resolveKbRoot('', process.cwd())
 *
 * 使用场景:
 *   - kb-update.cjs（增量更新）：由 git diff 反查受影响域
 *   - gen-docs.cjs（全量/单域生成）：按域取待扫描的文件清单
 *   - kb-query.cjs（渐进式检索）：按关键词召回候选域，交 Jev 重排
 *
 * 说明:
 *   - **收敛背景**：resolveKbRoot / parseMetaYaml 原先在 kb-update.cjs 与 gen-docs.cjs
 *     各有一份副本，且签名已漂移（gen-docs 版无 overrideDir、不返回 checked，
 *     parseMetaYaml 也不提取 designStoryIds）。本模块以 kb-update 版（能力超集）为唯一信源，
 *     两个技能脚本改为 require —— 属于纯迁移，行为不变。
 *   - **projectRoot 显式传入**：两个技能脚本历史上用 `process.cwd()` 作为项目根，
 *     而 lib/paths.js 用的是「环境变量优先、回退 cwd」。为保持迁移后行为完全一致，
 *     本模块不做环境变量推断，由调用方显式传 projectRoot（默认 cwd）。
 *   - **parseDomainIndex 与 parseMetaYaml 并存而非合并**：meta.yaml 的关键词字段
 *     （跨行引号数组 + 内嵌 `#` 注释）解析是新能力，就地扩展既有解析器会把回归风险
 *     引到 kb-update 的生产路径上（该解析器有「CRLF + 前瞻落空 → 字段静默丢弃」的历史伤疤）。
 *     两者共享的只有「域块切分」与「文件字段提取」两条正则策略。
 *   - `keywords` 在本仓库**没有任何脚本维护**，由人工在 meta.yaml 里登记 ——
 *     本模块只读取，不写入。
 *
 * @module kb-root
 */

const fs = require('fs')
const path = require('path')

/** 知识库相对项目根的默认目录 */
const DOCS_REL_DIR = path.join('.docs', 'llm-knowledge')

/**
 * 切出 `domains:` 块的正文（不含首个 domain 之前的前言）
 *
 * 边界依赖「块尾紧跟顶格行」这一 YAML 事实：真实 meta.yaml 中 `domains:` 块之后
 * 必然是顶格的注释行（`# ==== 公共知识领域 ====`）或顶格键（`common:`），
 * 因此 `/domains:\s*\n([\s\S]*?)(?=\n\S|$)/` 能在正确位置收束，
 * 且 `common:` 段下的同缩进条目不会被误当成业务域。
 *
 * @param {string} content - meta.yaml 全文
 * @returns {string|null} 域块正文；无 `domains:` 时返回 null
 */
function domainsBlockOf (content) {
  const block = content.match(/domains:\s*\n([\s\S]*?)(?=\n\S|$)/)
  return block ? block[1] : null
}

/**
 * 从一段 YAML 片段中抽取所有被双引号包裹的字符串
 *
 * meta.yaml 的值统一用双引号包裹，注释为无引号纯文本（含 `|`、`/` 等符号但不含引号），
 * 因此「抽引号串」天然跳过注释，不会把 `# active | stable | deprecated` 混进结果。
 *
 * @param {string} raw - 原始片段
 * @returns {string[]} 引号内的字符串列表（保持出现顺序）
 */
function extractQuoted (raw) {
  if (!raw) return []
  const strs = raw.match(/"([^"]+)"/g)
  if (!strs) return []
  return strs.map(s => s.replace(/"/g, ''))
}

/**
 * 提取域块内所有「文件类」字段的值，统一为一个 files[] 数组
 *
 * 文件字段名因项目类型而异（entry_files / stores / apis / components / files / ...），
 * 故用宽匹配 `\w*(?:files|stores|apis|components|entries)`。
 *
 * ⚠️ 块形式（`entry_files:` 换行 + `- "..."` 列表）必须同时兼容 LF / CRLF，
 * 且前瞻要覆盖「块结尾只剩一个 \r」的情形，否则该字段会被**静默丢弃**
 * （历史缺陷：CRLF + 字段恰为域块最后一个字段时，旧前瞻三分支全部落空 → 整个匹配失败）。
 *
 * @param {string} block - 单个域的 YAML 片段
 * @returns {string[]} 去重后的文件/目录路径列表
 */
function extractFileFields (block) {
  const collected = []
  const fileFieldRe = /\b(\w*(?:files|stores|apis|components|entries))\s*:\s*(\[[\s\S]*?\]|\r?\n[ \t]*- "[\s\S]*?(?=\r?\n[ \t]*(?:\w|#|- id:)|\r?\n[ \t]*$|$))/g
  let fm
  while ((fm = fileFieldRe.exec(block)) !== null) {
    collected.push(...extractQuoted(fm[2]))
  }
  // 兜底：匹配内联数组形式的 entry_files: ["a", "b"]
  const inlineRe = /entry_files\s*:\s*\[([^\]]+)\]/g
  let im
  while ((im = inlineRe.exec(block)) !== null) {
    collected.push(...im[1].split(',').map(s => s.trim().replace(/["']/g, '')).filter(Boolean))
  }
  return [...new Set(collected)]
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
 * @param {string} overrideDir - `--kb-root=` / 环境变量 KB_ROOT 指定的根（可相对可绝对）
 * @param {string} [projectRoot=process.cwd()] - 项目根（显式传入以保证迁移前后行为一致）
 * @returns {{kbRoot: string, metaPath: string|null, checked: string[]}}
 *   kbRoot 为最终采用的知识库根（未命中时为优先兜底目录）；metaPath 为 null 表示未找到
 */
function resolveKbRoot (overrideDir, projectRoot = process.cwd()) {
  const docsRoot = path.join(projectRoot, DOCS_REL_DIR)
  const candidates = []

  if (overrideDir) {
    candidates.push(path.resolve(projectRoot, overrideDir))
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

/**
 * 简化 YAML 解析 — 只提取 domains[]、git.hash 与已登记的 design_docs story_id
 * （v2：文件字段通用化）
 *
 * 刻意不用真实 YAML 解析库：插件运行时零依赖是硬约束（package.json 的 dependencies 必须为 {}）。
 *
 * @param {string} content - meta.yaml 全文
 * @returns {{git: {hash?: string}, domains: Array<{id: string, path: string, files: string[]}>, designStoryIds: string[]}}
 */
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

  const block = domainsBlockOf(content)
  if (!block) return result

  // 全局匹配 domains: 块中 2 空格缩进的 - id:"xxx"（domain 级别）
  const idRe = /^ {2}- id:\s*"([^"]+)"/gm
  let m
  while ((m = idRe.exec(block)) !== null) {
    result.domains.push({ id: m[1], path: '', files: [] })
  }

  // 补齐每个 domain 的 path 和文件字段（v2：不再假设前端字段名）
  for (const domain of result.domains) {
    const pathRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"[\s\S]*?path:\s*"([^"]+)"`)
    const pathMatch = block.match(pathRe)
    if (pathMatch) domain.path = pathMatch[1]

    // 提取该 domain 块的所有「文件类」字段值，统一归入 files[]
    const domainBlockRe = new RegExp(String.raw`  - id:\s*"` + domain.id + String.raw`"([\s\S]*?)(?=\n  - id:\s*"|\n\S|$)`)
    const blockMatch = block.match(domainBlockRe)
    if (!blockMatch) continue
    domain.files = extractFileFields(blockMatch[1])
  }

  return result
}

/**
 * 解析域索引（召回层专用）—— 比 parseMetaYaml 多出 name / keywords / status
 *
 * 为什么需要它：`parseMetaYaml` 只提取 id/path/files，**完全不读 keywords**，
 * 而 meta.yaml 的 keywords 是渐进式检索最精确的语料（单个域可达 40+ 条，
 * 含组件名、字段名、枚举值等 token）。kb-query 的候选召回依赖它。
 *
 * 解析约束（均据真实 meta.yaml 实证）:
 *   - `keywords` 是跨行引号数组，中间可夹 `#` 注释行 → 取到第一个 `]` 即可（数组内无嵌套方括号）
 *   - `status: "active"  # active | stable | deprecated` → 值在注释之前，优先匹配引号值
 *   - 域块内所有字段均限定在该域片段内匹配，不越界
 *
 * @param {string} content - meta.yaml 全文
 * @returns {Array<{id: string, name: string, path: string, status: string, keywords: string[], files: string[]}>}
 *   无 `domains:` 块时返回空数组；单个域缺 name 时回退为 id，缺 status 时为空串
 */
function parseDomainIndex (content) {
  const block = domainsBlockOf(content)
  if (!block) return []

  const idRe = /^ {2}- id:\s*"([^"]+)"/gm
  const marks = []
  let m
  while ((m = idRe.exec(block)) !== null) marks.push({ id: m[1], index: m.index })
  if (marks.length === 0) return []

  const domains = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index
    const end = i + 1 < marks.length ? marks[i + 1].index : block.length
    const seg = block.slice(start, end)

    const nameMatch = seg.match(/name:\s*"([^"]+)"/)
    const pathMatch = seg.match(/path:\s*"([^"]+)"/)
    const statusMatch = seg.match(/status:\s*"?([\w-]+)"?/)
    const kwMatch = seg.match(/keywords\s*:\s*\[([\s\S]*?)\]/)

    domains.push({
      id: marks[i].id,
      name: nameMatch ? nameMatch[1] : marks[i].id,
      path: pathMatch ? pathMatch[1] : '',
      status: statusMatch ? statusMatch[1] : '',
      keywords: extractQuoted(kwMatch ? kwMatch[1] : ''),
      files: extractFileFields(seg)
    })
  }

  return domains
}

module.exports = {
  DOCS_REL_DIR,
  domainsBlockOf,
  extractQuoted,
  extractFileFields,
  resolveKbRoot,
  parseMetaYaml,
  parseDomainIndex
}
