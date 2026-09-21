#!/usr/bin/env node
/**
 * kb-query.cjs — 渐进式分层检索的「候选域召回 + 相关性重排」脚本
 *
 * 自包含于 kb-query Skill。读出知识库的域索引，按查询主题排名，并直接给出**该读哪些文件**。
 *
 * 用法:
 *   node "<skill_dir>/kb-query.cjs" --story=<storyId> [--mode=A|B|C|D]
 *   node "<skill_dir>/kb-query.cjs" --query="<自然语言主题>" [--top=3]
 *   node "<skill_dir>/kb-query.cjs" --help
 *
 * 输出（stdout JSON）:
 *   kbRoot/layout/mode/queryHash  检索上下文
 *   source                        jev | keyword-fallback | keyword-only | no-kb
 *   ranked[]                      {id,name,p,tier,hitKeywords,hitFiles,docs,missingDocs}
 *   skipped[]                     未命中而被排除的域及原因
 *   jev                          {used,model,durationMs,error} 或 null
 *
 * 设计要点:
 *   - **两段式**：先用确定性规则召回（meta.yaml 的 domains[].keywords + 文件字段命中），
 *     再交 Jev 做语义相关性重排。召回不依赖模型，因此永远有可用结果。
 *   - **命中域 ≤1 时短路**：只有唯一候选时排序毫无意义 —— 直接跳过 Jev，
 *     既省成本也避免让模型做无意义的判断（source=keyword-only）。
 *   - **不发域文档正文**：state 只含查询主题 + 候选域的元数据（id/名称/截断后的关键词）。
 *     域文档正文既不必要（token）也不宜外发（合规）。
 *   - **drop 只降序不剔除**：低置信域仍出现在 ranked 尾部。剔除等于让模型决定「不给你看」，
 *     判断权就从人/Agent 手里外移了。
 *   - **docs 是真正的收益点**：按 SKILL.md 的四种检索模式映射出待读文档类型，
 *     再按实际存在性过滤（真实知识库里 config.md / pitfalls.md 多数域并不存在），
 *     不存在的进 missingDocs 供 Agent 判断是否改写检索策略。
 *   - **fail-open**：无知识库、无 TYPESAFE_API_KEY、HARNESS_JEV=0、超时、HTTP 失败
 *     一律降级为关键词排序，exit 0，并在 source/jev.error 里如实标注。
 *   - **缓存**：--story 模式下把结果写 `<storyDir>/kb-query-result.json`（同 queryHash 复用）。
 *     它是纯旁路文件，**不是门控产出物、不进 PHASE_ARTIFACTS**，也不写任何状态文件。
 *
 * 说明:
 *   - 知识库根探测与 meta.yaml 解析统一走 `scripts/lib/kb-root.js`
 *     （与 kb-update.cjs / gen-docs.cjs 共用同一实现，不得另行实现副本）。
 *   - **关键词富信源是 meta.yaml 的 domains[].keywords**（真实知识库单域可达 46 条，
 *     含组件名 / 字段名 / 枚举值），而非 overview.md 的域地图表（关键词被精简到 4~6 个）。
 *   - 模式 → 文档类型映射表只存在于本脚本（MODE_DOCS）。**不再回填 SKILL.md**：
 *     两处各存一份必然漂移。SKILL.md 只负责「跑脚本拿清单」与脚本不可用时的兜底说明。
 *   - 项目根取 lib/paths.js 的 PROJECT_ROOT（环境变量优先、回退 cwd），与其余脚本一致。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { PROJECT_ROOT, getStoryDir } = require('../../scripts/lib/paths')
const { resolveKbRoot, parseDomainIndex } = require('../../scripts/lib/kb-root')
const jev = require('../../scripts/services/jev-advisor')

/** 检索模式 → 待读文档类型（单一信源：此处不与其他文档重复） */
const MODE_DOCS = {
  A: ['overview', 'api', 'architecture'], // 需求拆解
  B: ['overview', 'pages', 'api', 'store', 'architecture'], // 技术方案
  C: ['api'], // 接口搜索
  D: ['overview', 'architecture', 'pitfalls'] // 知识问答
}

/** 模式的人类可读名（仅用于输出提示） */
const MODE_NAMES = {
  A: '需求拆解',
  B: '技术方案',
  C: '接口搜索',
  D: '知识问答'
}

/** 每个域喂给 Jev 的关键词上限（字符数）——避免 state 随域数 × 长关键词表膨胀 */
const MAX_KEYWORDS_CHARS = 400

/** --story 模式的结果缓存文件名（纯旁路，非门控产出物） */
const CACHE_FILE = 'kb-query-result.json'

/** 结果来源标记 */
const SOURCE = {
  JEV: 'jev',
  FALLBACK: 'keyword-fallback',
  KEYWORD_ONLY: 'keyword-only',
  NO_KB: 'no-kb'
}

/**
 * 解析 CLI 参数
 *
 * @param {string[]} argv - process.argv
 * @returns {{storyId: string, query: string, mode: string, top: number|null, noJev: boolean,
 *   noCache: boolean, kbRoot: string, help: boolean}}
 */
function parseArgs (argv) {
  const out = { storyId: '', query: '', mode: 'B', top: null, noJev: false, noCache: false, kbRoot: '', help: false }
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--no-jev') out.noJev = true
    else if (arg === '--no-cache') out.noCache = true
    else if (arg.startsWith('--story=')) out.storyId = arg.slice('--story='.length).trim()
    else if (arg.startsWith('--query=')) out.query = arg.slice('--query='.length).trim()
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length).trim().toUpperCase()
    else if (arg.startsWith('--top=')) {
      const n = Number.parseInt(arg.slice('--top='.length), 10)
      if (Number.isFinite(n) && n > 0) out.top = n
    } else if (arg.startsWith('--kb-root=')) out.kbRoot = arg.slice('--kb-root='.length).trim()
  }
  return out
}

/** 打印用法（--help） */
function printUsage () {
  const lines = [
    'kb-query.cjs — 知识库候选域召回 + Jev 相关性重排',
    '',
    '用法:',
    '  node kb-query.cjs --story=<storyId> [--mode=A|B|C|D]   从 story-input.json 取查询主题',
    '  node kb-query.cjs --query="<主题>" [--mode=A|B|C|D]    直接给定查询主题',
    '  node kb-query.cjs --help                              打印本帮助',
    '',
    '选项:',
    '  --mode=A|B|C|D   检索模式（默认 B）：A 需求拆解 / B 技术方案 / C 接口搜索 / D 知识问答',
    '  --top=N          只裁剪输出的域条数（不改变分层，drop 档不会被剔除）',
    '  --no-jev         跳过 Jev，纯关键词排序（无密钥/离线/对照组场景）',
    '  --no-cache       不读也不写 <storyDir>/' + CACHE_FILE,
    '  --kb-root=<path> 覆盖知识库根自动探测',
    '',
    '环境变量:',
    '  TYPESAFE_API_KEY  Jev API 密钥；缺失时自动降级为关键词排序',
    '                    密钥也可写在 settings.json 的 env 字段（插件会直接读取，无需重启会话）：',
    '                    <项目>/.codebuddy/settings.local.json > <项目>/.codebuddy/settings.json > ~/.codebuddy/settings.json',
    '  JEV_NO_SETTINGS=1 不读任何 settings 文件，只用进程环境变量',
    '  HARNESS_JEV=0     关闭 Jev 能力（总开关，与 debug-log 同款约定）',
    '  JEV_HIGH / JEV_LOW  分层阈值覆盖（默认 0.8 / 0.5）',
    '  JEV_TIMEOUT_MS    请求超时（默认 8000ms；境内实测单次约 1~3s，跨境更慢可放宽）',
    '  JEV_ENDPOINT      端点覆盖（默认官方端点；走网关/代理时使用）',
    '',
    '输出: stdout JSON（source 字段说明结果来自 Jev 还是关键词降级）',
    ''
  ]
  console.log(lines.join('\n'))
}

/**
 * 归一化关键词/文本，用于跨写法比对
 *
 * 去掉大小写、空格、连字符、下划线、等号 —— 让 `RoleGroupChat` / `role_group_chat` /
 * `role-group-chat` 与 `msgType=14` / `msgType 14` 都能对上。
 *
 * @param {string} s - 原始字符串
 * @returns {string} 归一化结果（小写、无分隔符）
 */
function normalizeKey (s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s\-_=]+/g, '')
}

/**
 * 切分查询文本为词元（保留中文与字母数字，丢弃标点）
 *
 * @param {string} text - 查询主题
 * @returns {string[]} 归一化后的词元列表（长度 ≥2，已去重）
 */
function tokenize (text) {
  const raw = String(text == null ? '' : text).split(/[^\w\u4e00-\u9fff]+/)
  const out = []
  for (const t of raw) {
    const k = normalizeKey(t)
    if (k.length >= 2 && !out.includes(k)) out.push(k)
  }
  return out
}

/**
 * 关键词命中判定
 *
 * 两条通道：整串包含（覆盖「系统设置页面」命中关键词「设置」这类中文场景）与词元互含
 * （覆盖「会话转接」命中 `TransfCustomer` 之外的中英混排场景）。
 *
 * @param {string} wholeNorm - 归一化后的查询全文
 * @param {string[]} tokens - 查询词元
 * @param {string} keyword - meta.yaml 登记的关键词
 * @returns {boolean} 是否命中
 */
function keywordHits (wholeNorm, tokens, keyword) {
  const k = normalizeKey(keyword)
  if (k.length < 2) return false
  if (wholeNorm.includes(k)) return true
  return tokens.some(t => t.length >= 2 && (t === k || k.includes(t) || t.includes(k)))
}

/**
 * 对候选域做确定性召回
 *
 * 打分 = 关键词命中数 × 2 + 文件字段命中数；`status: deprecated` 的域降权（排到 active 之后）。
 *
 * @param {Array<Object>} domains - parseDomainIndex 的结果
 * @param {string} query - 查询主题
 * @returns {{candidates: Array<Object>, skipped: Array<{id: string, reason: string}>}}
 *   candidates：命中域（含 hitKeywords / hitFiles / score）；skipped：未命中域及原因
 */
function recall (domains, query) {
  const wholeNorm = normalizeKey(query)
  const tokens = tokenize(query)
  const candidates = []
  const skipped = []

  for (const domain of domains) {
    const hitKeywords = (domain.keywords || []).filter(k => keywordHits(wholeNorm, tokens, k))
    const hitFiles = (domain.files || []).filter(f => {
      const base = normalizeKey(path.basename(String(f)))
      if (base.length < 2) return false
      return wholeNorm.includes(base) || tokens.some(t => t.length >= 2 && (base.includes(t) || t.includes(base)))
    })

    if (hitKeywords.length === 0 && hitFiles.length === 0) {
      skipped.push({ id: domain.id, reason: 'no_keyword_hit' })
      continue
    }

    candidates.push({
      ...domain,
      hitKeywords,
      hitFiles,
      score: hitKeywords.length * 2 + hitFiles.length,
      deprecated: domain.status === 'deprecated'
    })
  }

  // deprecated 降权；其余按召回分降序（稳定排序：同分保持 meta.yaml 中的原始顺序）
  candidates.sort((a, b) => {
    if (a.deprecated !== b.deprecated) return a.deprecated ? 1 : -1
    return b.score - a.score
  })

  return { candidates, skipped }
}

/**
 * 按模式解析待读文档清单（含存在性过滤）
 *
 * @param {string} kbRoot - 知识库根
 * @param {string} domainPath - 域目录（相对 kbRoot，如 'business/chat/'）
 * @param {string} mode - 检索模式 A|B|C|D
 * @returns {{docs: string[], missingDocs: string[]}} docs 为相对 kbRoot 的正斜杠路径
 */
function resolveDocs (kbRoot, domainPath, mode) {
  const types = MODE_DOCS[mode] || MODE_DOCS.B
  const docs = []
  const missingDocs = []

  for (const type of types) {
    const rel = `${domainPath}${type}.md`
    if (fs.existsSync(path.join(kbRoot, rel))) docs.push(rel)
    else missingDocs.push(`${type}.md`)
  }

  // custom/ 目录是域内的补充沉淀，有内容才列出（SKILL.md 模式 D 会用到）
  const customDir = path.join(kbRoot, domainPath, 'custom')
  try {
    const hasCustom = fs.readdirSync(customDir).some(f => f.endsWith('.md'))
    if (hasCustom) docs.push(`${domainPath}custom/`)
  } catch (e) { /* custom/ 不存在：不列出 */ }

  return { docs, missingDocs }
}

/**
 * 截断喂给 Jev 的关键词表
 *
 * 命中词优先保留，其余按 meta.yaml 原序补足到上限 —— 长关键词表（单域可达 46 条）
 * 全量塞进 state 会稀释信号且抬高 token。
 *
 * @param {string[]} keywords - 域的全量关键词
 * @param {string[]} hitKeywords - 本次命中的关键词
 * @param {number} [maxChars=400] - 字符上限
 * @returns {string[]} 截断后的关键词
 */
function trimKeywords (keywords, hitKeywords, maxChars = MAX_KEYWORDS_CHARS) {
  const hits = new Set(hitKeywords)
  const ordered = [...hitKeywords, ...keywords.filter(k => !hits.has(k))]
  const out = []
  let len = 0
  for (const k of ordered) {
    if (len + k.length + 1 > maxChars) continue
    out.push(k)
    len += k.length + 1
  }
  return out
}

/**
 * 构造 Jev 重排所需的问题契约
 *
 * 每个候选域一个问题（并行采样：域数增加不显著增加延迟）。instructions 直接点名域与关键词 ——
 * Jev 对间接指代敏感，让模型自己去 state 里找会明显拉低准确率。
 *
 * @param {Array<Object>} candidates - 命中的候选域
 * @returns {{questions: Object, questionToDomain: Object<string, string>}} 问题定义与反向索引
 */
function buildQuestions (candidates) {
  const questions = {}
  const questionToDomain = {}
  for (const domain of candidates) {
    const name = `d_${domain.id.replace(/[^\w]/g, '_')}_relevant`
    const kw = trimKeywords(domain.keywords || [], domain.hitKeywords || [])
    questions[name] = jev.noul(
      `判定业务域「${domain.name}」（目录 ${domain.path}，涉及：${kw.join('、') || '（无关键词）'}）` +
      '是否与下述查询主题相关'
    )
    questionToDomain[name] = domain.id
  }
  return { questions, questionToDomain }
}

/**
 * 构造 Jev 调用所需的 state（查询主题 + 候选域元数据）
 *
 * 查询主题来自用户输入 / story-input.json，属外部文本 → 必须用 wrapUntrusted 包裹。
 * 域文档正文一律不发。
 *
 * @param {string} query - 查询主题
 * @param {Array<Object>} candidates - 候选域
 * @returns {string} state 文本
 */
function buildState (query, candidates) {
  const domainList = candidates
    .map(d => `- ${d.id}（${d.name}）：命中 ${(d.hitKeywords || []).slice(0, 8).join('、') || '（无关键词命中，靠文件字段命中）'}`)
    .join('\n')
  return [
    jev.wrapUntrusted(query, '查询主题'),
    '',
    '候选业务域：',
    domainList
  ].join('\n')
}

/**
 * 计算查询摘要（缓存键 + 输出留痕）
 * @param {string} query - 查询主题
 * @returns {string} 形如 sha1:xxx
 */
function hashQuery (query) {
  return 'sha1:' + crypto.createHash('sha1').update(String(query || '')).digest('hex')
}

/**
 * 把知识库根归一化为「相对项目根的正斜杠路径」（项目外路径原样返回）
 *
 * 输出与缓存比对共用同一形态：缓存里存的是输出对象（kbRoot 已归一化），
 * 若比对时用绝对路径就永远命中不了。
 *
 * @param {string} kbRoot - 知识库根（绝对路径）
 * @returns {string} 相对路径或原绝对路径
 */
function relKbRoot (kbRoot) {
  const rel = path.relative(PROJECT_ROOT, kbRoot).replace(/\\/g, '/')
  return rel && !rel.startsWith('..') ? rel : kbRoot
}

/**
 * 读取 story-input.json 拼出查询主题
 *
 * @param {string} storyId - Story ID
 * @returns {{ok: boolean, query: string, error?: string}} 查询主题（标题 + 补充说明）
 */
function queryFromStory (storyId) {
  const file = path.join(getStoryDir(storyId), 'story-input.json')
  if (!fs.existsSync(file)) {
    return { ok: false, query: '', error: `story-input.json 不存在: ${file}` }
  }
  try {
    const input = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const parts = [input.title, input.sources && input.sources.text].filter(Boolean)
    if (parts.length === 0) return { ok: false, query: '', error: 'story-input.json 缺少 title 与 sources.text' }
    return { ok: true, query: parts.join('\n') }
  } catch (e) {
    return { ok: false, query: '', error: `story-input.json 解析失败: ${e.message}` }
  }
}

/**
 * 尝试读取缓存
 *
 * @param {string} storyId - Story ID
 * @param {string} queryHash - 当前查询摘要
 * @param {string} kbRoot - 当前知识库根
 * @returns {Object|null} 命中时返回缓存的输出对象，否则 null
 */
function readCache (storyId, queryHash, kbRoot) {
  const file = path.join(getStoryDir(storyId), CACHE_FILE)
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (cached && cached.queryHash === queryHash && cached.kbRoot === kbRoot) return cached
  } catch (e) { /* 无缓存 / 解析失败：继续正常流程 */ }
  return null
}

/**
 * 写缓存（静默失败，绝不阻塞）
 *
 * @param {string} storyId - Story ID
 * @param {Object} output - 待缓存输出
 * @returns {boolean} 是否写入成功
 */
function writeCache (storyId, output) {
  try {
    const dir = getStoryDir(storyId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(output, null, 2) + '\n', 'utf-8')
    return true
  } catch (e) {
    return false
  }
}

/**
 * 组装最终输出（含 ranked 排序、docs 解析、top 裁剪）
 *
 * @param {Object} params - 组装参数
 * @param {string} params.kbRoot - 知识库根
 * @param {string} params.mode - 检索模式
 * @param {string} params.source - 来源标记
 * @param {Array<Object>} params.rows - 已带 p/tier 的行
 * @param {Array<Object>} params.skipped - 未命中域
 * @param {Object|null} params.jevInfo - Jev 调用信息
 * @param {number|null} params.top - 输出条数上限
 * @param {string} [params.queryHash] - 查询摘要（也是缓存键，必须落进输出否则缓存永不命中）
 * @returns {Object} 输出对象（ranked 每行含 docs/missingDocs）
 */
function buildOutput ({ kbRoot, mode, source, rows, skipped, jevInfo, top, queryHash }) {
  const limited = top ? rows.slice(0, top) : rows
  const ranked = limited.map(row => {
    const { docs, missingDocs } = resolveDocs(kbRoot, row.path, mode)
    return {
      id: row.id,
      name: row.name,
      p: row.p == null ? null : Number(row.p.toFixed(4)),
      tier: row.tier,
      hitKeywords: row.hitKeywords,
      hitFiles: row.hitFiles,
      docs,
      missingDocs
    }
  })

  return {
    kbRoot: relKbRoot(kbRoot),
    layout: path.basename(kbRoot) === 'llm-knowledge' ? 'flat' : path.basename(kbRoot),
    mode,
    queryHash: queryHash || null,
    modeName: MODE_NAMES[mode] || '',
    source,
    candidateCount: rows.length,
    ranked,
    skipped,
    jev: jevInfo
  }
}

/**
 * 主流程：定位知识库 → 召回 → （可选）Jev 重排 → 输出
 *
 * @param {Object} cli - parseArgs 的结果
 * @param {Object} [deps] - 依赖注入（测试用，可覆盖 jev 模块）
 * @returns {Object} 输出对象
 */
async function run (cli, deps = {}) {
  const advisor = deps.jev || jev
  const { kbRoot, metaPath, checked } = resolveKbRoot(cli.kbRoot || process.env.KB_ROOT || '', PROJECT_ROOT)

  // ── 取查询主题 ──
  let query = cli.query
  if (!query && cli.storyId) {
    const fromStory = queryFromStory(cli.storyId)
    if (!fromStory.ok) {
      return { kbRoot, layout: null, mode: cli.mode, source: SOURCE.NO_KB, error: fromStory.error, ranked: [], skipped: [] }
    }
    query = fromStory.query
  }
  const queryHash = hashQuery(query)

  // ── 缓存命中直接返回 ──
  if (cli.storyId && !cli.noCache) {
    const cached = readCache(cli.storyId, queryHash, relKbRoot(kbRoot))
    if (cached) {
      cached.cache = { hit: true, path: `${CACHE_FILE}` }
      return cached
    }
  }

  // ── 无知识库：如实降级，不猜 ──
  if (!metaPath || !fs.existsSync(metaPath)) {
    return {
      kbRoot: relKbRoot(kbRoot),
      layout: null,
      mode: cli.mode,
      source: SOURCE.NO_KB,
      reason: `未找到 meta.yaml（已探测：${checked.join(', ')}）`,
      ranked: [],
      skipped: []
    }
  }

  const domains = parseDomainIndex(fs.readFileSync(metaPath, 'utf-8'))
  const { candidates, skipped } = recall(domains, query)

  // ── 无候选：如实降级，提示走 L4 全文搜索 ──
  if (candidates.length === 0) {
    return buildOutput({
      kbRoot,
      mode: cli.mode,
      source: SOURCE.KEYWORD_ONLY,
      rows: [],
      skipped,
      jevInfo: null,
      top: cli.top,
      queryHash
    })
  }

  const rows = candidates.map(c => ({ ...c, p: null, tier: 'keyword' }))

  // ── 短路：唯一候选无需排序，不调 Jev ──
  const jevSkippedReason = cli.noJev
    ? '--no-jev 指定跳过'
    : (!advisor.isEnabled() ? 'HARNESS_JEV=0' : (!advisor.hasApiKey() ? '未配置 TYPESAFE_API_KEY' : null))

  if (candidates.length < 2 || jevSkippedReason) {
    return buildOutput({
      kbRoot,
      mode: cli.mode,
      source: candidates.length < 2 ? SOURCE.KEYWORD_ONLY : SOURCE.FALLBACK,
      rows,
      skipped,
      jevInfo: { used: false, reason: candidates.length < 2 ? '候选唯一，排序无意义' : jevSkippedReason },
      top: cli.top,
      queryHash
    })
  }

  // ── Jev 重排 ──
  const { questions, questionToDomain } = buildQuestions(candidates)
  const result = await advisor.evaluate(buildState(query, candidates), questions, {
    storyId: cli.storyId || undefined,
    source: 'kb-query.cjs'
  })

  if (!result.ok) {
    return buildOutput({
      kbRoot,
      mode: cli.mode,
      source: SOURCE.FALLBACK,
      rows,
      skipped,
      jevInfo: { used: false, reason: result.reason, error: result.error || null },
      top: cli.top,
      queryHash
    })
  }

  // 概率写回候选行；drop 只降序，不剔除
  const pByDomain = {}
  for (const [name, answer] of Object.entries(result.answers)) {
    const domainId = questionToDomain[name]
    if (!domainId) continue
    pByDomain[domainId] = { p: advisor.probabilityOf(answer), tier: advisor.decide(answer) }
  }
  for (const row of rows) {
    const hit = pByDomain[row.id]
    if (hit) {
      row.p = hit.p
      row.tier = hit.tier
    }
  }
  // 排序：概率降序（无概率的靠后），同概率保持召回序
  rows.sort((a, b) => {
    const pa = a.p == null ? -1 : a.p
    const pb = b.p == null ? -1 : b.p
    return pb - pa
  })

  const output = buildOutput({
    kbRoot,
    mode: cli.mode,
    source: SOURCE.JEV,
    rows,
    skipped,
    jevInfo: {
      used: true,
      model: result.model,
      keySource: result.keySource, // 密钥来源（env / settings.user / settings.project / settings.local），排查「为什么没走 Jev」用
      durationMs: result.durationMs,
      usage: result.usage,
      thresholds: advisor.getThresholds()
    },
    top: cli.top,
    queryHash
  })

  // 只缓存 Jev 成功的排序结果：降级结果（keyword-fallback / keyword-only）不该被复用 ——
  // 否则「当时没配密钥」会被固化成一整段 Story 的检索质量。
  if (cli.storyId && !cli.noCache) writeCache(cli.storyId, output)

  return output
}

// ─── 执行（CLI 模式） ──────────────────────────────────────────

if (require.main === module) {
  const cli = parseArgs(process.argv)

  if (cli.help) {
    printUsage()
    process.exit(0)
  }
  if (!cli.storyId && !cli.query) {
    console.error(JSON.stringify({ error: '必须提供 --story=<storyId> 或 --query="<主题>"', hint: 'node kb-query.cjs --help' }))
    process.exit(1)
  }
  if (!MODE_DOCS[cli.mode]) {
    console.error(JSON.stringify({ error: `无效的 --mode 值: ${cli.mode}（仅支持 A / B / C / D）` }))
    process.exit(1)
  }

  run(cli)
    .then(output => {
      console.log(JSON.stringify(output, null, 2))
      process.exit(0)
    })
    .catch(e => {
      // 兜底：主流程的任何意外都不应让调用方拿不到结果
      console.log(JSON.stringify({
        source: SOURCE.NO_KB,
        error: e && e.message ? e.message : String(e),
        ranked: [],
        skipped: []
      }, null, 2))
      process.exit(0)
    })
}

module.exports = { MODE_DOCS, SOURCE, MAX_KEYWORDS_CHARS, CACHE_FILE, parseArgs, normalizeKey, tokenize, keywordHits, recall, resolveDocs, trimKeywords, buildQuestions, buildState, queryFromStory, run }
