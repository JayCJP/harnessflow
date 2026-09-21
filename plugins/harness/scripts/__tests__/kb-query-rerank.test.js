#!/usr/bin/env node
/**
 * kb-query 相关性重排回归测试
 *
 * 覆盖 skills/kb-query/kb-query.cjs 的契约与红线：
 *   1. 确定性召回：meta.yaml 多行 keywords（内嵌 # 注释）命中、deprecated 降权
 *   2. 短 路：候选唯一时不调 Jev（source=keyword-only）
 *   3. 全链降级：无密钥 / 请求失败 一律 keyword-fallback，并如实标注
 *   4. drop 只降序不剔除（低置信域仍在 ranked 尾部）
 *   5. docs 按模式映射 + 存在性过滤，缺失类型进 missingDocs
 *   6. 缓存只缓存 Jev 成功结果（降级结果不复用）
 *   7. CLI 参数错误 exit 1
 *
 * 全部用 __setTransport 注入假 transport，测试中不发真实 HTTP。
 *
 * 用法:
 *   node scripts/__tests__/kb-query-rerank.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')
const KB_QUERY = path.resolve(SCRIPTS_DIR, '..', 'skills', 'kb-query', 'kb-query.cjs')

// ── 沙箱必须在 require 被测模块之前建好（paths.js 在模块加载期求值环境变量）──
const sandbox = makeSandbox('harness-kbq-')

const jev = require(path.join(SCRIPTS_DIR, 'services/jev-advisor'))
const kbQuery = require(KB_QUERY)
const { parseDomainIndex } = require(path.join(SCRIPTS_DIR, 'lib/kb-root'))

// 切断 settings.json 密钥来源：本测试用「删除环境变量」模拟无密钥，若允许回退到
// 真实机器的 ~/.codebuddy/settings.json，降级断言会全部失真
jev.__setSettingsPaths([])

// ─── mini 知识库（按真实布局与真实 meta.yaml 形态构造）──────────
const KB_ROOT = path.join(sandbox.root, '.docs', 'llm-knowledge', 'frontend')

/** 真实 meta.yaml 的三个形态特征：跨行 keywords + 数组内 # 注释 + status 行尾内联注释 */
const META_YAML = `# 测试知识库索引

git:
  hash: "abcdef1234567890"

domains:
  - id: "chat"
    name: "即时会话 1v1"
    keywords: ["chat", "即时会话", "会话列表",
               # STORY-x: 会话卡片与角色群聊入口
               "售后单", "AddressConfirmCard", "RoleGroupChat"]
    path: "business/chat/"
    entry_files:
      - "src/views/pc/chat.vue"
      - "src/views/h5/chat.vue"
    stores: ["oneToOneWorkbench.store.js"]
    status: "active"  # active | stable | deprecated

  - id: "group-chat"
    name: "门店群聊"
    keywords: ["群聊", "群设置", "RoleGroupChat", "groupv2"]
    path: "business/group-chat/"
    entry_files: ["src/views/pc/chat.vue"]
    status: "active"

  - id: "ticket"
    name: "工单系统"
    keywords: ["ticket", "工单", "工单列表"]
    path: "business/ticket/"
    entry_files: ["src/views/pc/ticket/"]
    status: "active"

  - id: "legacy"
    name: "旧版设置"
    keywords: ["设置", "RoleGroupChat"]
    path: "business/legacy/"
    entry_files: ["src/views/pc/legacy.vue"]
    status: "deprecated"
`

const DOMAIN_DOCS = {
  chat: ['overview.md', 'api.md', 'architecture.md'],
  'group-chat': ['overview.md', 'api.md'],
  ticket: ['overview.md'],
  legacy: ['overview.md']
}

function seedKb () {
  for (const [id, docs] of Object.entries(DOMAIN_DOCS)) {
    const dir = path.join(KB_ROOT, 'business', id)
    fs.mkdirSync(dir, { recursive: true })
    for (const doc of docs) fs.writeFileSync(path.join(dir, doc), `# ${id} ${doc}\n`, 'utf-8')
  }
  // custom/ 目录：验证「有内容才列出」
  const customDir = path.join(KB_ROOT, 'business', 'chat', 'custom')
  fs.mkdirSync(customDir, { recursive: true })
  fs.writeFileSync(path.join(customDir, 'notes.md'), '# 补充沉淀\n', 'utf-8')

  fs.writeFileSync(path.join(KB_ROOT, 'meta.yaml'), META_YAML, 'utf-8')
  fs.writeFileSync(path.join(KB_ROOT, 'overview.md'), '# 全局总览\n', 'utf-8')
}

seedKb()

const KEY_ENV = 'TYPESAFE_API_KEY'
const savedKey = process.env[KEY_ENV]

/** 构造 cli 参数对象（复用被测的 parseArgs） */
function cli (...args) {
  return kbQuery.parseArgs(['node', 'kb-query.cjs', ...args])
}

/**
 * 注入假 transport，返回「问题名 → 概率」映射
 * @param {Object<string, number>} pByQuestion - 问题名 → 概率
 * @returns {{calls: number}} 调用计数对象
 */
function stubTransport (pByQuestion) {
  const counter = { calls: 0 }
  jev.__setTransport(async (payload) => {
    counter.calls++
    const answers = {}
    for (const name of Object.keys(payload.questions)) {
      answers[name] = { noul: pByQuestion[name] != null ? pByQuestion[name] : 0.9 }
    }
    return { model: 'jev-test', answers, usage: { input_tokens: 123 } }
  })
  return counter
}

/**
 * 主测试流程
 * @returns {Promise<void>}
 */
async function main () {
  process.env[KEY_ENV] = 'test-key'

  // ════════════════════════════════════════════════════════════
  section('1. 域索引解析（真实 meta.yaml 形态）')

  const domains = parseDomainIndex(META_YAML)
  ok('解析出 4 个域', domains.length === 4, String(domains.length))
  const chat = domains.find(d => d.id === 'chat')
  ok('跨行 keywords 全部解析', chat && chat.keywords.length === 6, JSON.stringify(chat && chat.keywords))
  ok('数组内 # 注释不混入关键词', chat && !chat.keywords.some(k => k.includes('#')),
    JSON.stringify(chat && chat.keywords))
  ok('status 取的是值而非注释', chat && chat.status === 'active', chat && chat.status)
  ok('legacy 识别为 deprecated', (domains.find(d => d.id === 'legacy') || {}).status === 'deprecated')
  ok('块形式 entry_files 解析', chat && chat.files.length === 3, JSON.stringify(chat && chat.files))
  ok('内联数组 entry_files 解析',
    (domains.find(d => d.id === 'group-chat') || {}).files.includes('src/views/pc/chat.vue'))

  // ════════════════════════════════════════════════════════════
  section('2. 确定性召回（不依赖模型）')

  const recalled = kbQuery.recall(domains, 'RoleGroupChat')
  ok('三域同时命中 RoleGroupChat', recalled.candidates.length === 3,
    JSON.stringify(recalled.candidates.map(c => c.id)))
  ok('未命中域进 skipped', recalled.skipped.some(s => s.id === 'ticket'))
  ok('active 排在 deprecated 之前', recalled.candidates[2].id === 'legacy',
    JSON.stringify(recalled.candidates.map(c => c.id)))
  ok('命中关键词带出', recalled.candidates[0].hitKeywords.includes('RoleGroupChat'))

  const single = kbQuery.recall(domains, '工单列表')
  ok('单词命中仅 1 个域', single.candidates.length === 1, JSON.stringify(single.candidates.map(c => c.id)))

  const noHit = kbQuery.recall(domains, 'zzz-毫无关联的主题')
  ok('无命中 -> 候选为空', noHit.candidates.length === 0 && noHit.skipped.length === 4)

  // ════════════════════════════════════════════════════════════
  section('3. 关键词截断策略')

  const manyKw = Array.from({ length: 60 }, (_, i) => `关键词${i}`)
  const trimmed = kbQuery.trimKeywords(manyKw, ['关键词59'])
  ok('截断到字符上限内', trimmed.join(',').length <= kbQuery.MAX_KEYWORDS_CHARS,
    String(trimmed.join(',').length))
  ok('命中词优先保留', trimmed[0] === '关键词59', trimmed[0])
  ok('未超限时不过度裁剪', kbQuery.trimKeywords(['a', 'b'], ['b']).length === 2)

  // ════════════════════════════════════════════════════════════
  section('4. docs 按模式映射 + 存在性过滤')

  const modeA = kbQuery.resolveDocs(KB_ROOT, 'business/chat/', 'A')
  ok('mode A 三个文档均存在', modeA.docs.filter(d => d.endsWith('.md')).length === 3, JSON.stringify(modeA.docs))
  ok('mode A 无缺失', modeA.missingDocs.length === 0, JSON.stringify(modeA.missingDocs))
  ok('custom/ 有内容才列出', modeA.docs.includes('business/chat/custom/'))

  const modeB = kbQuery.resolveDocs(KB_ROOT, 'business/chat/', 'B')
  ok('mode B 缺失 pages/store 被点名', modeB.missingDocs.includes('pages.md') && modeB.missingDocs.includes('store.md'),
    JSON.stringify(modeB.missingDocs))
  ok('mode B 不列出缺失文件', !modeB.docs.some(d => d.includes('pages.md')), JSON.stringify(modeB.docs))

  const modeD = kbQuery.resolveDocs(KB_ROOT, 'business/ticket/', 'D')
  ok('mode D 缺失 pitfalls 被点名', modeD.missingDocs.includes('pitfalls.md'), JSON.stringify(modeD.missingDocs))
  ok('无 custom/ 时不列出', !modeD.docs.some(d => d.endsWith('custom/')), JSON.stringify(modeD.docs))

  // ════════════════════════════════════════════════════════════
  section('5. Jev 重排：排序、分层、drop 不剔除')

  const counter = stubTransport({
    d_chat_relevant: 0.95,
    d_group_chat_relevant: 0.4,
    d_legacy_relevant: 0.9
  })
  const reranked = await kbQuery.run(cli('--query=RoleGroupChat'), { jev })
  ok('source=jev', reranked.source === kbQuery.SOURCE.JEV, reranked.source)
  ok('发起了一次请求', counter.calls === 1, String(counter.calls))
  ok('按概率降序', reranked.ranked.map(r => r.id).join(',') === 'chat,legacy,group-chat',
    reranked.ranked.map(r => r.id).join(','))
  ok('高概率 -> accept', reranked.ranked[0].tier === 'accept', reranked.ranked[0].tier)
  ok('低概率 -> drop 且仍在 ranked 中', reranked.ranked[2].tier === 'drop', JSON.stringify(reranked.ranked[2]))
  ok('概率写回并保留 4 位', reranked.ranked[0].p === 0.95, String(reranked.ranked[0].p))
  ok('ranked 行带 docs', Array.isArray(reranked.ranked[0].docs) && reranked.ranked[0].docs.length > 0)
  ok('jev 元信息含模型与阈值', reranked.jev.used === true && reranked.jev.model === 'jev-test' &&
    reranked.jev.thresholds.high === 0.8, JSON.stringify(reranked.jev))

  const noJev = await kbQuery.run(cli('--query=RoleGroupChat', '--no-jev'), { jev })
  ok('--no-jev -> keyword-fallback', noJev.source === kbQuery.SOURCE.FALLBACK, noJev.source)
  ok('--no-jev -> tier=keyword', noJev.ranked.every(r => r.tier === 'keyword'))
  ok('--no-jev 未发起请求', counter.calls === 1, String(counter.calls))

  // ════════════════════════════════════════════════════════════
  section('6. 短路与降级')

  const beforeShort = counter.calls
  const onlyOne = await kbQuery.run(cli('--query=工单列表'), { jev })
  ok('候选唯一 -> keyword-only', onlyOne.source === kbQuery.SOURCE.KEYWORD_ONLY, onlyOne.source)
  ok('候选唯一 -> 不调 Jev', counter.calls === beforeShort, String(counter.calls))
  ok('候选唯一 -> 说明排序无意义', /唯一/.test(onlyOne.jev.reason), onlyOne.jev.reason)
  ok('候选唯一 -> 仍给出 docs', onlyOne.ranked[0].docs.length > 0)

  const emptyHit = await kbQuery.run(cli('--query=zzz-毫无关联的主题'), { jev })
  ok('无命中 -> ranked 为空且标注来源', emptyHit.ranked.length === 0 && emptyHit.source === kbQuery.SOURCE.KEYWORD_ONLY)

  delete process.env[KEY_ENV]
  const noKey = await kbQuery.run(cli('--query=RoleGroupChat'), { jev })
  ok('无密钥 -> keyword-fallback', noKey.source === kbQuery.SOURCE.FALLBACK, noKey.source)
  ok('无密钥 -> 原因如实标注', /TYPESAFE_API_KEY/.test(noKey.jev.reason), noKey.jev.reason)
  ok('无密钥 -> 仍有可用排序', noKey.ranked.length === 3)
  process.env[KEY_ENV] = 'test-key'

  let failCalls = 0
  jev.__setTransport(async () => { failCalls++; throw new Error('HTTP 500: boom') })
  const failed = await kbQuery.run(cli('--query=RoleGroupChat'), { jev })
  ok('请求失败 -> keyword-fallback', failed.source === kbQuery.SOURCE.FALLBACK, failed.source)
  ok('请求失败 -> error 带出原因', /HTTP 500/.test(failed.jev.error), String(failed.jev.error))
  ok('请求失败 -> 结果仍可用', failed.ranked.length === 3)
  ok('请求失败 -> 确实发起过请求', failCalls === 1, String(failCalls))

  const noKbDir = path.join(sandbox.root, 'empty-kb')
  fs.mkdirSync(noKbDir, { recursive: true })
  const noKb = await kbQuery.run(cli('--query=RoleGroupChat', '--kb-root=empty-kb'), { jev })
  ok('无 meta.yaml -> no-kb', noKb.source === kbQuery.SOURCE.NO_KB, noKb.source)
  ok('无 meta.yaml -> 点名探测过的路径', /meta\.yaml/.test(noKb.reason), noKb.reason)

  // ════════════════════════════════════════════════════════════
  section('7. 缓存：只缓存 Jev 成功结果')

  const cacheStory = 'KBQ-CACHE'
  const cacheDir = sandbox.storyDir(cacheStory)
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, 'story-input.json'),
    JSON.stringify({ mode: 'run', title: '角色群聊入口改造', sources: { text: 'RoleGroupChat 相关' } }), 'utf-8')

  stubTransport({ d_chat_relevant: 0.95, d_group_chat_relevant: 0.9, d_legacy_relevant: 0.2 })
  const first = await kbQuery.run(cli(`--story=${cacheStory}`), { jev })
  ok('首次运行 source=jev', first.source === kbQuery.SOURCE.JEV, first.source)
  ok('首次运行无 cache 标记', first.cache === undefined)

  const cached = await kbQuery.run(cli(`--story=${cacheStory}`), { jev })
  ok('二次运行命中缓存', cached.cache && cached.cache.hit === true, JSON.stringify(cached.cache))
  ok('缓存结果与首次一致', cached.ranked.map(r => r.id).join(',') === first.ranked.map(r => r.id).join(','))

  const noCache = await kbQuery.run(cli(`--story=${cacheStory}`, '--no-cache'), { jev })
  ok('--no-cache 绕开缓存', noCache.cache === undefined)

  delete process.env[KEY_ENV]
  const degradedStory = 'KBQ-DEGRADED'
  fs.mkdirSync(sandbox.storyDir(degradedStory), { recursive: true })
  fs.writeFileSync(path.join(sandbox.storyDir(degradedStory), 'story-input.json'),
    JSON.stringify({ mode: 'run', title: 'RoleGroupChat 降级验证', sources: {} }), 'utf-8')
  const degraded = await kbQuery.run(cli(`--story=${degradedStory}`), { jev })
  ok('无密钥 -> 走 keyword-fallback', degraded.source === kbQuery.SOURCE.FALLBACK, degraded.source)
  ok('降级结果不写缓存（无文件）',
    !fs.existsSync(path.join(sandbox.storyDir(degradedStory), kbQuery.CACHE_FILE)),
    degraded.source)
  process.env[KEY_ENV] = 'test-key'

  const missingStory = await kbQuery.run(cli('--story=KBQ-NO-INPUT'), { jev })
  ok('story-input 缺失 -> 如实报错', Boolean(missingStory.error), JSON.stringify(missingStory))

  // ════════════════════════════════════════════════════════════
  section('8. CLI 参数校验（exit code 语义）')

  const noArgs = spawnSync(process.execPath, [KB_QUERY], { encoding: 'utf-8' })
  ok('无参数 -> exit 1', noArgs.status === 1, String(noArgs.status))
  ok('无参数 -> stderr 说明用法', /--story|--query/.test(noArgs.stderr), noArgs.stderr)

  const badMode = spawnSync(process.execPath, [KB_QUERY, '--query=x', '--mode=X'], { encoding: 'utf-8' })
  ok('非法 mode -> exit 1', badMode.status === 1, String(badMode.status))

  const help = spawnSync(process.execPath, [KB_QUERY, '--help'], { encoding: 'utf-8' })
  ok('--help -> exit 0', help.status === 0, String(help.status))
  ok('--help 列出模式说明', /需求拆解/.test(help.stdout))

  // CLI 端到端：显式清掉密钥 + 关掉 settings.json 回退 —— 子进程收不到 __setSettingsPaths，
  // 否则会读到真实机器的 ~/.codebuddy/settings.json 并真的发起一次网络调用
  const cliEnv = { ...process.env, JEV_NO_SETTINGS: '1' }
  delete cliEnv[KEY_ENV]
  const realRun = spawnSync(process.execPath, [KB_QUERY, '--query=RoleGroupChat'], { encoding: 'utf-8', env: cliEnv })
  ok('CLI 正常路径 exit 0', realRun.status === 0, String(realRun.status))
  const parsed = JSON.parse(realRun.stdout)
  ok('CLI 输出可解析 JSON', parsed.ranked.length === 3, JSON.stringify(parsed.ranked && parsed.ranked.map(r => r.id)))
  ok('CLI 无密钥时如实降级', parsed.source === kbQuery.SOURCE.FALLBACK, parsed.source)
  ok('CLI 在沙箱知识库上工作', /llm-knowledge/.test(parsed.kbRoot), parsed.kbRoot)

  // ════════════════════════════════════════════════════════════
  jev.__resetTransport()
  if (savedKey === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = savedKey

  summarize(sandbox)
}

main()
