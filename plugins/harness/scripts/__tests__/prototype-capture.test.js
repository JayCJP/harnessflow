/**
 * prototype-capture.test.js — prototype-capture 脚本层的单测
 *
 * 覆盖点:
 *   1. 三层错误判定（spawn / CLI / business）
 *   2. `--json` 回执解析（裸对象形态 / 包装形态 / 二次解码 / 错误形态）
 *   3. 参数引号拼装（中文 / 管道符 / 双引号 / 括号 / 空格）与 Windows 分支
 *   4. 渲染类型分流（**fixture 表**，把「text 绝对值不可靠」固化成可回归断言）
 *   5. iframe 子类判定（C1 / C2 / C3）
 *   6. 拦截页信号与按钮 ref 提取
 *   7. 宿主平台识别（选择器命中 / HTML 命中 / 认不出）
 *   8. 页面状态编码（degradations → status）
 *   9. 材料渲染（必备章节齐全 / 内联降级 / 图片相对路径 / 表格转义）
 *  10. finish 幂等（连调两次只执行一次 CLI，单步失败不阻断）
 *  11. 常量自洽（章节无重名、NEXT_ACTIONS 覆盖全部状态）
 *
 * 为何大量用注入式 fakeRunner:
 *   脚本真实采集需要浏览器与可访问的原型链接（CI 无浏览器、原型链接不公开不可重试），
 *   所以 runner 层接受可注入的 runner 函数，单测用它替换 spawn，
 *   即可在无浏览器环境下覆盖全部判定与拼装逻辑。
 *
 * 实测样本说明:
 *   第 4 组 fixture 的 text/canvas 数值来自 2026-09 本机实测（example.com text=129、
 *   Axure 壳 text=22）。页面会改版，**这些数值只用于校准判定逻辑、不是硬阈值**。
 *   改实现时请保持「iframe > canvas > text」的优先级不变。
 *
 * @module __tests__/prototype-capture.test
 */

const path = require('path')

const { ok, section, summarize } = require('./_helpers')

const SCRIPTS = path.join(__dirname, '..', '..', 'skills', 'prototype-capture', 'scripts')
const runner = require(path.join(SCRIPTS, 'runner'))
const probe = require(path.join(SCRIPTS, 'probe'))
const render = require(path.join(SCRIPTS, 'render'))
const collect = require(path.join(SCRIPTS, 'collect'))
const capture = require(path.join(SCRIPTS, 'capture'))
const constants = require(path.join(SCRIPTS, 'constants'))

// ─────────────────────────────────────────────────────────────
section('1. 三层错误判定')
// ─────────────────────────────────────────────────────────────

let r = runner.classifyError({ status: null, error: { code: 'ENOENT', message: 'not found' } })
ok('spawn 层：status=null 判为 spawn', r.errorLayer === 'spawn', JSON.stringify(r))

r = runner.classifyError({ status: 1, stdout: '{"isError":true,"error":"browser not open"}' })
ok('业务层：JSON 含 isError 判为 business', r.errorLayer === 'business', JSON.stringify(r))
ok('业务层：error 取 isError 的 error 字段', r.error === 'browser not open', r.error)

r = runner.classifyError({ status: 1, stdout: "The browser 'default' is not open", stderr: '' })
ok('CLI 层：纯文本 stdout 判为 cli', r.errorLayer === 'cli', JSON.stringify(r))

r = runner.classifyError({ status: 0, stdout: '{"result":"1"}' })
ok('成功：合法 JSON 且无 isError 则 errorLayer 为 null', r.errorLayer === null, JSON.stringify(r))

// 关键：退出码 1 + isError 不能被当成 CLI 失败（实测 eval 出错时退出码为 1）
r = runner.classifyError({ status: 1, stdout: '{"isError":true,"error":"boom"}' })
ok('退出码 1 + isError → business（不能按非 0 退出码抛异常）', r.errorLayer === 'business', JSON.stringify(r))

// ─────────────────────────────────────────────────────────────
section('2. --json 回执解析')
// ─────────────────────────────────────────────────────────────

// 裸对象形态（list 等状态命令）
r = runner.parseJsonResult('{"browsers":[]}')
ok('裸对象形态：无 result 键时整个对象即结果', r.result && Array.isArray(r.result.browsers), JSON.stringify(r))

// 包装形态 + 二次解码（实测 eval "() => JSON.stringify({a:1})" 需要解两层）
r = runner.parseJsonResult('{"result":"\\"{\\\\\\"a\\\\\\":1}\\""}')
ok('包装形态：二次解码后得到对象 {a:1}', r.result && r.result.a === 1, JSON.stringify(r.result))

// 包装形态 + 单层（--json eval document.title）
r = runner.parseJsonResult('{"result":"\\"Example Domain\\""}')
ok('包装形态：单层解码得到裸字符串', r.result === 'Example Domain', JSON.stringify(r.result))

r = runner.parseJsonResult('Found 1 match for /x/')
ok('非 JSON：parsed 为 null 且 error 标注', r.parsed === null && /not JSON/.test(r.error), JSON.stringify(r))

r = runner.parseJsonResult('')
ok('空 stdout：error 标注 empty', r.parsed === null && /empty/.test(r.error), JSON.stringify(r))

r = runner.parseJsonResult('{"isError":true,"error":"x"}')
ok('错误形态：result 为 null 且 error 取自 error 字段', r.result === null && r.error === 'x', JSON.stringify(r))

// 字面量解码（2026-09 真实墨刀原型暴露的 bug）：
// `--json eval "() => !!document.querySelector('#x')"` 的 result 是**字符串** "true"，
// 不解码会让 `=== true` 的平台识别判定永远失败（墨刀实测：选择器全命中却识别不出平台）
r = runner.parseJsonResult('{"result":"true"}')
ok('字面量：字符串 "true" 解为布尔 true', r.result === true, JSON.stringify(r.result))

r = runner.parseJsonResult('{"result":"false"}')
ok('字面量：字符串 "false" 解为布尔 false', r.result === false, JSON.stringify(r.result))

r = runner.parseJsonResult('{"result":"42"}')
ok('字面量：字符串 "42" 解为数字 42', r.result === 42, JSON.stringify(r.result))

// 反向：普通英文字符串不能被误当 JSON 解坏
r = runner.parseJsonResult('{"result":"Example Domain"}')
ok('反向：普通字符串不被误解析', r.result === 'Example Domain', JSON.stringify(r.result))

// ─────────────────────────────────────────────────────────────
section('3. 参数引号拼装与命令构造')
// ─────────────────────────────────────────────────────────────

ok('普通参数不加引号', runner.quoteArg('--json') === '--json', runner.quoteArg('--json'))
ok('含空格参数加双引号', runner.quoteArg('a b') === '"a b"', runner.quoteArg('a b'))
ok('中文参数加双引号', runner.quoteArg('说明|备注') === '"说明|备注"', runner.quoteArg('说明|备注'))
ok('含括号参数加双引号', runner.quoteArg('a(b)') === '"a(b)"', runner.quoteArg('a(b)'))

// 关键：cmd 的引号转义是重复双引号，不是反斜杠（实测 \" 会让 cmd 提前结束引号段）
const dq = runner.quoteArg('() => new RegExp("a|b")')
ok('双引号用 "" 转义（cmd 语义，不是 \\"）', dq.includes('""a|b""') && !dq.includes('\\"'), dq)

ok('空参数转为空引号对', runner.quoteArg('') === '""', runner.quoteArg(''))

const cmd = runner.buildCommand('C:\\x\\playwright-cli.cmd', ['--json', 'eval', '() => 1'])
ok('Windows 分支带 chcp 65001', /chcp 65001/.test(cmd), cmd)
ok('Windows 分支含可执行文件路径', cmd.includes('C:\\x\\playwright-cli.cmd'), cmd)

ok('hasNonAscii 识别中文', runner.hasNonAscii('说明') === true)
ok('hasNonAscii 放行 ASCII', runner.hasNonAscii('abc') === false)

// ─────────────────────────────────────────────────────────────
section('4. 渲染类型分流（fixture 表）')
// ─────────────────────────────────────────────────────────────

// 实测样本：text 绝对值不可靠，判定优先级固定 iframe > canvas > text
const renderFixtures = [
  { name: '纯文本页 text=129（example.com 实测）', m: { text: 129, iframe: 0, canvas: 0 }, expect: 'a' },
  { name: '重 DOM 页 iframe=1 text=3118', m: { text: 3118, iframe: 1, canvas: 0 }, expect: 'c' },
  { name: 'Axure 壳 iframe=1 text=22（实测）', m: { text: 22, iframe: 1, canvas: 0 }, expect: 'c' },
  { name: 'Canvas 主导 canvas=5 text=5', m: { text: 5, iframe: 0, canvas: 5 }, expect: 'b' },
  { name: '装饰性 canvas + 正文', m: { text: 800, iframe: 0, canvas: 2 }, expect: 'a' },
  { name: '全空', m: { text: 0, iframe: 0, canvas: 0 }, expect: 'a' },
  { name: 'iframe 优先于 canvas', m: { text: 5, iframe: 1, canvas: 5 }, expect: 'c' }
]
for (const f of renderFixtures) {
  const got = probe.classifyRender(f.m)
  ok(`分流：${f.name} → ${f.expect}`, got.type === f.expect, `实得 ${got.type}（${got.reason}）`)
}

// ─────────────────────────────────────────────────────────────
section('5. iframe 子类判定')
// ─────────────────────────────────────────────────────────────

const iframeFixtures = [
  { name: 'about:blank + 同源 → C2', i: { src: 'about:blank', sameOrigin: true }, expect: 'c2' },
  { name: 'javascript: + 同源 → C2', i: { src: 'javascript:void(0)', sameOrigin: true }, expect: 'c2' },
  { name: '空 src + 同源 → C2', i: { src: '', sameOrigin: true }, expect: 'c2' },
  { name: '真实 URL + 同源 → C1', i: { src: 'https://x.com/p/1', sameOrigin: true }, expect: 'c1' },
  { name: '真实 URL + 跨域 → C3', i: { src: 'https://cdn.com/x', sameOrigin: false }, expect: 'c3' }
]
for (const f of iframeFixtures) {
  const got = probe.classifyIframe(f.i)
  ok(`子类：${f.name}`, got.subtype === f.expect, `实得 ${got.subtype}`)
}

const c3 = probe.classifyIframe({ src: 'https://cdn.com/x', sameOrigin: false })
ok('C3 的 actionable 提示不要 goto（会丢页面清单）', /不要 goto|snapshot/.test(c3.actionable), c3.actionable)

// 原型 iframe 挑选（2026-09 真实墨刀原型暴露：页面混有 2 个 360 广告 iframe）
const modaoIframes = [
  { id: '', src: '', sameOrigin: true },
  { id: '', src: 'https://360fenxi.mediav.com/mediav1130.html', sameOrigin: false },
  { id: '', src: 'https://s.union.360.cn/proxy.html', sameOrigin: false }
]
const picked = probe.pickPrimaryIframe(modaoIframes)
ok('挑出原型本体：同源空 src（不是广告）',
  picked.primary && picked.primary.src === '' && picked.primary.sameOrigin === true,
  JSON.stringify(picked.primary))
ok('识别出 2 个广告 iframe', picked.ads.length === 2, JSON.stringify(picked.ads.map(a => a.src)))
ok('广告 iframe 不参与类型判定（否则会被误判 C3）',
  probe.classifyIframe(picked.primary).subtype === 'c2',
  probe.classifyIframe(picked.primary).subtype)

ok('isAdIframe 识别 360 分析域名',
  probe.isAdIframe({ src: 'https://360fenxi.mediav.com/x.html' }) === true)
ok('isAdIframe 不误判同源空 src', probe.isAdIframe({ src: '' }) === false)

// 页面名清洗（墨刀 li.rn-content-item 的 innerText 是「序号\n页面名」两行）
ok('cleanPageName：取最后一行非数字为页面名',
  collect.cleanPageName('1\n页面 1') === '页面 1',
  collect.cleanPageName('1\n页面 1'))
ok('cleanPageName：中文需求名不被序号干扰',
  collect.cleanPageName('5\n【权限】客服支持订单退款操作') === '【权限】客服支持订单退款操作',
  collect.cleanPageName('5\n【权限】客服支持订单退款操作'))
ok('cleanPageName：纯页面名原样返回',
  collect.cleanPageName('更新日志') === '更新日志')
ok('cleanPageName：空输入返回空串', collect.cleanPageName('') === '')

// 墨刀平台特征（2026-09 实测补充）
const modaoPlatform = probe.detectHostPlatform({ selectors: ['#screen_list'] })
ok('识别墨刀平台（#screen_list 命中）',
  modaoPlatform && modaoPlatform.id === 'modao', JSON.stringify(modaoPlatform))
ok('墨刀平台声明画布选择器 #canvas',
  modaoPlatform && modaoPlatform.canvasSelectors.includes('#canvas'),
  JSON.stringify(modaoPlatform && modaoPlatform.canvasSelectors))
ok('墨刀无需点开面板（默认展开）', modaoPlatform && modaoPlatform.panelToggleText === null)

// ─────────────────────────────────────────────────────────────
section('7.5 说明文字清洗（2026-09 真实墨刀原型暴露）')
// ─────────────────────────────────────────────────────────────
//
// 真实墨刀的说明/批注是画在画布里的文本，`find` 命中的却全是工具栏按钮。
// 原实现把 find 的**整段 YAML 片段**当说明存进材料 —— 材料里出现
// `- generic [ref=e5]: - generic [ref=e6]:` 这种垃圾。

const snapSample = [
  'Found 3 matches for /说明|备注|批注/:',
  '',
  '- generic [ref=e5]:',
  '  - generic [ref=e12]:',
  '    - generic [ref=e13] [cursor=pointer]: 总览',
  '    - generic [ref=e14] [cursor=pointer]: 演示',
  '- generic [ref=e42]:',
  '  - listitem [ref=e296] [cursor=pointer]:',
  '    - generic "批注" [ref=e297]',
  '----',
  '- generic [ref=e147]: 客户诉求：',
  '  - generic [ref=e149]: a.'
].join('\n')

const extracted = collect.extractTextFromSnapshot(snapSample)
ok('从快照抽文本：抽出纯文本节点', extracted.includes('客户诉求：'), JSON.stringify(extracted))
ok('从快照抽文本：不含 ref 结构行',
  !extracted.some(t => /\[ref=/.test(t)), JSON.stringify(extracted))
ok('从快照抽文本：不含 Found/---- 等噪音',
  !extracted.some(t => /^Found \d+ match/.test(t) || t === '----'))

ok('工具栏噪音：纯按钮名被识别',
  collect.isToolbarJunk('总览') === true && collect.isToolbarJunk('展开全部') === true)
ok('工具栏噪音：拼接的按钮名片段被识别',
  collect.isToolbarJunk('总览演示标注') === true &&
  collect.isToolbarJunk('批注评论展开全部') === true)
ok('工具栏噪音：登录提示文案被识别',
  collect.isToolbarJunk('登录后可使用标注、导出等更多功能') === true)
ok('工具栏噪音：真实说明不被误杀',
  collect.isToolbarJunk('客户诉求：客服管理支持给客服配置是否支持订单的退款操作') === false,
  '真实说明被误判为噪音')
ok('工具栏噪音：编号列表说明不被误杀',
  collect.isToolbarJunk('1. 涉及模式：店铺客服：多人会话、1v1接待模式') === false)

// 去重：画布文本已覆盖的碎片丢弃
const deduped = collect.dedupeNotes([
  { source: '画布文本', text: '客户诉求：客服管理支持配置退款' },
  { source: 'anchor:说明', text: '客户诉求：客服管理支持配置退款' },
  { source: '关键词命中(1)', text: '另一条独立说明' }
], '客户诉求：客服管理支持配置退款')
ok('去重：与画布文本重复的碎片被丢弃', deduped.length === 2, JSON.stringify(deduped.map(d => d.source)))
ok('去重：画布文本本身保留', deduped.some(d => d.source === '画布文本'))
ok('去重：独立说明保留', deduped.some(d => d.text === '另一条独立说明'))

// 粘连长行的换行补齐
const splitResult = collect.splitRunOnText('开启后，客服获得订单的退款操作权限【【微赞test】订单详情】')
ok('补换行：在【【前断开', splitResult.includes('\n【【'), JSON.stringify(splitResult))
ok('补换行：短行不动', collect.splitRunOnText('短行') === '短行')

// ─────────────────────────────────────────────────────────────
section('6. 拦截页信号与按钮 ref 提取')
// ─────────────────────────────────────────────────────────────

ok('URL 含 /jump?go= 判为拦截页',
  probe.detectGateSignals('https://x.com/jump?go=abc', '').isGate === true)

ok('按钮文案「知道了」判为拦截页',
  probe.detectGateSignals('https://x.com/p', '反诈提醒 知道了, 进入查看').isGate === true)

ok('正常业务页不判为拦截页',
  probe.detectGateSignals('https://x.com/p', '订单列表 提交 取消').isGate === false)

const gateSnap = [
  '- generic [ref=e1]:',
  '- button "知道了, 进入查看" [ref=e15]',
  '- link "我同意" [ref=e16]'
].join('\n')
const gateBtn = probe.findGateButtonRef(gateSnap)
ok('从快照提取拦截页按钮 ref', gateBtn.ref === 'e15', JSON.stringify(gateBtn))

ok('快照无匹配按钮时返回 null ref',
  probe.findGateButtonRef('- generic [ref=e1]: 正文').ref === null)

// ─────────────────────────────────────────────────────────────
section('7. 宿主平台识别')
// ─────────────────────────────────────────────────────────────

ok('选择器命中 → Axure',
  (probe.detectHostPlatform({ selectors: ['#sitemapTreeContainer'] }) || {}).id === 'axure-player')

// 关键：HTML 里是 class="sitemapPageName"，不含 CSS 前缀 `.`，必须剥前缀后匹配
ok('HTML 命中 → Axure（需剥 CSS 前缀）',
  (probe.detectHostPlatform({ html: '<div class="sitemapPageName">x</div>' }) || {}).id === 'axure-player')

ok('认不出 → null（交 LLM 判断）',
  probe.detectHostPlatform({ selectors: ['.unknown-widget'] }) === null)

ok('selectorToHtmlToken 剥 # 前缀',
  probe.selectorToHtmlToken('#sitemapTreeContainer') === 'sitemapTreeContainer')
ok('selectorToHtmlToken 剥 . 前缀',
  probe.selectorToHtmlToken('.sitemapPageName') === 'sitemapPageName')

const tp = probe.parseTotalPages('更新日志 (1 of 7)')
ok('解析 (1 of 7) 得总页数 7', tp && tp.total === 7, JSON.stringify(tp))

// ─────────────────────────────────────────────────────────────
section('8. 页面状态编码')
// ─────────────────────────────────────────────────────────────

ok('无降级 → ok', probe.derivePageStatus([]) === 'ok')
ok('有降级 → partial',
  probe.derivePageStatus([constants.DEGRADATION_KINDS.NOTES_MISSING]) === 'partial')
ok('登录墙 → skipped',
  probe.derivePageStatus([constants.DEGRADATION_KINDS.PAGE_REQUIRES_LOGIN]) === 'skipped')

// 说明探针噪音过滤
const raw = [
  { src: 'attr:notesPanel', text: '限购数量上限由商品配置决定' },
  { src: 'anchor:说明', text: '说明' },
  { src: 'anchor:说明 批注 (1 of 3)', text: '说明 批注 (1 of 3)' },
  { src: 'x', text: '   ' }
]
const filtered = probe.filterNotesProbe(raw)
ok('探针噪音：过滤纯计数行与过短文本', filtered.length === 1, JSON.stringify(filtered.map(f => f.src)))

// ─────────────────────────────────────────────────────────────
section('9. 材料渲染')
// ─────────────────────────────────────────────────────────────

const fixtureResult = {
  schemaVersion: '1.0.0',
  capturedAt: '2026-09-20T10:00:00Z',
  url: 'https://u.pmdaniu.com/nx90R',
  title: '优化商品限购排版',
  render: { type: 'c' },
  iframe: { subtype: 'c2' },
  platform: { id: 'axure-player', label: 'Axure 播放器' },
  gate: { handled: true, rounds: 1 },
  pages: [
    {
      index: 1,
      name: '更新日志',
      url: 'https://x/p',
      screenshot: '01-changelog.png',
      status: 'ok',
      degradations: [],
      notes: [{ source: 'attr:notesPanel', text: '展示版本发布记录' }],
      fields: [],
      interactions: []
    },
    {
      index: 3,
      name: '订单列表',
      url: 'https://x/p',
      screenshot: '03-order-list.png',
      status: 'partial',
      degradations: [
        constants.DEGRADATION_KINDS.NOTES_MISSING,
        constants.DEGRADATION_KINDS.FIELD_FROM_SCREENSHOT
      ],
      notes: [],
      fields: [{ name: '限购数量', type: '数字', ph: '请输入限购数量' }],
      interactions: [{ from: '订单列表', action: '点击「立即购买」', to: '支付结果页' }]
    }
  ]
}

const md = render.renderMaterial(fixtureResult)

for (const s of constants.MATERIAL_SECTIONS) {
  ok(`章节齐全：## ${s.title}`, md.includes(`## ${s.title}`))
}

ok('逐页事实：含该页内嵌截图（相对路径）',
  md.includes('](./prototype-work/03-order-list.png)'), '未找到图片引用')
ok('逐页事实：每页有独立小节标题', md.includes('### 1. 更新日志') && md.includes('### 3. 订单列表'))
ok('内联降级标记（与末尾汇总同源文案）',
  md.includes('> ⚠️ 本页说明未找到；字段来自截图识别。'))
ok('末尾汇总：含降级页与处理建议', md.includes('| 3 | 订单列表 |') && md.includes('非 blocking'))
ok('说明原文：独立块标注载体（attr → 说明面板）', md.includes('**来源：说明面板**'), '未标注来源标记')
ok('说明原文：代码围栏保留原格式（不塞进表格、不转义换行）',
  md.includes('```text\n展示版本发布记录\n```'), '说明原文未被代码围栏包裹')
ok('说明原文：不再出现在表格行', !md.includes('| 说明原文 |'), '表格里仍残留说明原文')
ok('字段来源标注为截图识别', md.includes('来源：截图识别'))

// 表格转义
ok('escapeCell：转义管道符', render.escapeCell('a|b') === 'a\\|b', render.escapeCell('a|b'))
ok('escapeCell：换行转空格', render.escapeCell('a\nb') === 'a b', render.escapeCell('a\nb'))

// validateResult
ok('validateResult：完整 result 通过', render.validateResult(fixtureResult).ok === true)
ok('validateResult：残缺 result 报缺字段',
  render.validateResult({}).missing.includes('schemaVersion'))

// 页面清单里的状态标签
ok('页面清单：partial 显示为「部分」', md.includes('⚠️ 部分'))

// ─────────────────────────────────────────────────────────────
section('10. finish 幂等与韧性')
// ─────────────────────────────────────────────────────────────

const fakeCalls = []
const fakeRunner = (command) => {
  fakeCalls.push(command)
  return { status: 0, stdout: '{"browsers":[]}', stderr: '' }
}

collect.resetFinishFlag()
const f1 = collect.finish('C:\\fake\\work', { runner: fakeRunner, cliPath: 'C:\\fake\\playwright-cli.cmd' })
const callsAfterFirst = fakeCalls.length
const f2 = collect.finish('C:\\fake\\work', { runner: fakeRunner, cliPath: 'C:\\fake\\playwright-cli.cmd' })

ok('finish 首次执行返回 ran=true', f1.ran === true)
ok('finish 第二次返回 ran=false（幂等）', f2.ran === false, JSON.stringify(f2))
ok('finish 幂等：第二次不再调 CLI', fakeCalls.length === callsAfterFirst,
  `${callsAfterFirst} vs ${fakeCalls.length}`)
ok('finish 调了 close', fakeCalls.some(c => /close/.test(c)))
ok('finish 调了 kill-all', fakeCalls.some(c => /kill-all/.test(c)))
ok('finish 调了 --json list 复查', fakeCalls.some(c => /--json list/.test(c)))

// 单步失败不阻断后续：close 抛错仍应执行 kill-all
const failingCalls = []
const failingRunner = (command) => {
  failingCalls.push(command)
  if (/ close/.test(command)) throw new Error('close boom')
  return { status: 0, stdout: '{"browsers":[]}', stderr: '' }
}
collect.resetFinishFlag()
collect.finish('C:\\fake\\work', { runner: failingRunner, cliPath: 'C:\\fake\\playwright-cli.cmd' })
ok('close 抛错不阻断 kill-all', failingCalls.some(c => /kill-all/.test(c)), failingCalls.join(' | '))

collect.resetFinishFlag()

// ─────────────────────────────────────────────────────────────
section('11. 常量自洽与 CLI 参数解析')
// ─────────────────────────────────────────────────────────────

const titles = constants.MATERIAL_SECTIONS.map(s => s.title)
ok('MATERIAL_SECTIONS 无重名', new Set(titles).size === titles.length, titles.join(','))
ok('MATERIAL_SECTIONS 每项有 key/title/description',
  constants.MATERIAL_SECTIONS.every(s => s.key && s.title && s.description))

const statuses = Object.values(constants.CAPTURE_STATUS)
const missingActions = statuses.filter(s => !constants.NEXT_ACTIONS[s])
ok('NEXT_ACTIONS 覆盖全部 CAPTURE_STATUS', missingActions.length === 0, missingActions.join(','))

ok('NON_FATAL_STATUS 含 ok/partial/need_llm（都不算失败）',
  ['ok', 'partial', 'need_llm'].every(s => constants.NON_FATAL_STATUS.includes(s)))
ok('NON_FATAL_STATUS 不含 failed',
  !constants.NON_FATAL_STATUS.includes('failed'))

ok('DEGRADATION_KINDS 每项自带 inlineNote（供内联与汇总共用）',
  Object.values(constants.DEGRADATION_KINDS).every(d => d.kind && d.inlineNote && d.advice))

// CLI 参数解析
let parsed = capture.parseArgs(['run', '--url', 'https://x.com', '--work-dir', 'C:\\w'])
ok('parseArgs：解析子命令与选项',
  parsed.command === 'run' && parsed.opts.url === 'https://x.com' && parsed.opts.workDir === 'C:\\w',
  JSON.stringify(parsed))

parsed = capture.parseArgs(['--help'])
ok('parseArgs：--help 在子命令位置也能识别', parsed.opts.help === true, JSON.stringify(parsed))

parsed = capture.parseArgs(['--version'])
ok('parseArgs：--version 在子命令位置也能识别', parsed.opts.version === true, JSON.stringify(parsed))

parsed = capture.parseArgs(['run', '--url'])
ok('parseArgs：选项缺取值时记错误', parsed.errors.some(e => /缺少取值/.test(e)), JSON.stringify(parsed.errors))

parsed = capture.parseArgs(['run', '--unknown', 'x'])
ok('parseArgs：未知选项记错误', parsed.errors.some(e => /未知参数/.test(e)), JSON.stringify(parsed.errors))

// summarize 状态推导
let sum = capture.summarize([{ status: 'ok' }, { status: 'partial' }])
ok('summarize：有 partial 无 failed → 整体 partial', sum.status === 'partial', JSON.stringify(sum.summary))

sum = capture.summarize([{ status: 'failed' }, { status: 'ok' }])
ok('summarize：有 failed → 整体 failed', sum.status === 'failed', JSON.stringify(sum.summary))

sum = capture.summarize([{ status: 'need_llm', index: 1, name: 'x' }])
ok('summarize：need_llm 进 needLlm 数组且带 nextAction',
  sum.needLlm.length === 1 && !!sum.needLlm[0].nextAction, JSON.stringify(sum.needLlm))

sum = capture.summarize([])
ok('summarize：空页面列表 → ok', sum.status === 'ok' && sum.summary.total === 0)

// 文件名安全
ok('toPinyin：英文名直接用', capture.toPinyin('OrderList', 1) === 'orderlist')
ok('toPinyin：中文名退化为序号（避免 Git Bash 乱码）',
  capture.toPinyin('订单列表', 3) === 'page-03', capture.toPinyin('订单列表', 3))

// 帮助文本从常量渲染（不复述）
const help = capture.helpText()
ok('helpText 含 schemaVersion', help.includes(constants.SCHEMA_VERSION))
ok('helpText 从常量渲染章节清单',
  constants.MATERIAL_SECTIONS.every(s => help.includes(s.title)))

// stripRawQuotes
ok('stripRawQuotes：去掉 --raw 的 JSON 引号',
  collect.stripRawQuotes('"https://example.com/"') === 'https://example.com/',
  collect.stripRawQuotes('"https://example.com/"'))
ok('stripRawQuotes：非引号串原样返回',
  collect.stripRawQuotes('https://x.com') === 'https://x.com')

// ─────────────────────────────────────────────────────────────
summarize()
