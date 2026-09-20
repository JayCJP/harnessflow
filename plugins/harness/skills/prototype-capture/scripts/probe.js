/**
 * probe.js — 纯逻辑判定层（渲染类型 / iframe 子类 / 拦截页 / 宿主平台 / 降级编码）
 *
 * 职责:
 *   - 把「实测判据」固化成可单测的纯函数：不碰子进程、不读文件
 *   - 让采集层（capture.js）只负责「取数据 → 喂给本模块 → 按结论行动」
 *
 * 为什么独立成文件:
 *   这些判据此前散在 SKILL.md 与 references 的散文里（如「优先级 iframe > canvas > text」
 *   「text 绝对值不可靠」「C2 读 contentDocument」），是给 LLM 现场解读的规则。
 *   独立成纯函数后：① 可用 fixture 表回归（页面改版时只改 fixture 不改逻辑）
 *   ② 判定结论统一由脚本给出，LLM 不再需要理解这些判据。
 *
 * 依赖: ./constants（纯数据）
 *
 * @module skills/prototype-capture/scripts/probe
 */

const {
  CAPTURE_STATUS,
  RENDER_TYPES,
  IFRAME_SUBTYPES,
  DEGRADATION_KINDS,
  GATE_SIGNALS,
  HOST_PLATFORMS
} = require('./constants')

/**
 * 判定渲染类型
 *
 * 优先级固定为 `iframe` > `canvas` > `text`（实测结论）：
 *   - `text` 绝对值**不可靠** —— 实测纯文本页 text=129 是 A 类，
 *     而 Axure 壳 text=22 是 C 类，都不是 B 类。所以 text 只用于判断
 *     「是否接近空壳」，且必须与 canvas 占主导同时成立才算 B 类。
 *   - B 类要 canvas 多且文本少**两个条件同时成立**，避免把
 *     「canvas 只是装饰、正文仍是 DOM」的页面误判成 B 类。
 *
 * @param {{ iframe?: number, canvas?: number, text?: number, imgs?: number }} metrics - eval 探测结果
 * @returns {{ type: string, reason: string }} type 为 RENDER_TYPES 之一
 */
function classifyRender (metrics) {
  const m = metrics || {}
  const iframe = Number(m.iframe) || 0
  const canvas = Number(m.canvas) || 0
  const text = Number(m.text) || 0

  if (iframe > 0) {
    return { type: RENDER_TYPES.C, reason: `iframe=${iframe}` }
  }

  if (canvas > 0 && text < 100) {
    return { type: RENDER_TYPES.B, reason: `canvas=${canvas} 且 text=${text} 接近空壳` }
  }

  return { type: RENDER_TYPES.A, reason: `text=${text}，canvas=${canvas}` }
}

/**
 * 判定 C 类 iframe 的子类
 *
 * - `c1` 真实 URL → 可 goto 到本体（最省事，A/B 手段全可用）
 * - `c2` `about:blank` / `javascript:` 且同源 → goto 无处可去，读 contentDocument
 * - `c3` 真实 URL 但跨域 → contentDocument 为 **null（不抛异常）**，靠 snapshot/find 穿透
 *
 * @param {{ src?: string, sameOrigin?: boolean }} info - iframe 探测信息
 * @returns {{ subtype: string, reason: string, actionable: string }}
 */
function classifyIframe (info) {
  const src = String((info && info.src) || '')
  const sameOrigin = !!(info && info.sameOrigin)

  const isDynamic = src === '' || src === 'about:blank' || src.startsWith('javascript:')
  if (isDynamic) {
    return sameOrigin
      ? {
          subtype: IFRAME_SUBTYPES.C2,
          reason: `src=${src || '(空)'}，同源动态写入`,
          actionable: '读 contentDocument，或用 snapshot/find 穿透'
        }
      : {
          subtype: IFRAME_SUBTYPES.C2,
          reason: `src=${src || '(空)'}，动态写入且跨域`,
          actionable: 'contentDocument 不可读，只能用 snapshot/find 穿透'
        }
  }

  if (sameOrigin) {
    return {
      subtype: IFRAME_SUBTYPES.C1,
      reason: 'src 是真实 URL 且同源',
      actionable: '可 goto 到 src（注意会丢失宿主壳的页面清单，需先取清单）'
    }
  }

  return {
    subtype: IFRAME_SUBTYPES.C3,
    reason: 'src 是真实 URL 但跨域，contentDocument 为 null',
    actionable: '不要 goto 脱离宿主（会丢页面清单），用 snapshot/find 穿透'
  }
}

/**
 * 从 iframe 列表里挑出**原型本体**（而非第三方广告/统计 iframe）
 *
 * 实测（墨刀真实原型）：页面有 3 个 iframe，其中 2 个是 360 广告
 * （`360fenxi.mediav.com/mediav1130.html`、`s.union.360.cn/proxy.html`）。
 * 盲取 `iframes[0]` 恰好是原型本体的侥幸情况，但判定类型时会被广告污染
 * （广告是跨域真实 URL → 会被误判成 C3）。
 *
 * 挑选规则（按优先级）：
 *   1. 同源且 src 为空 / about:blank —— 宿主壳动态写入的原型容器（墨刀/Axure 典型）
 *   2. 同源的 iframe
 *   3. 排除已知广告域名后取首个
 *
 * @param {Array<{src?: string, sameOrigin?: boolean}>} iframes - iframe 探测结果
 * @returns {{ primary: object|null, ads: Array, reason: string }}
 */
function pickPrimaryIframe (iframes) {
  const list = Array.isArray(iframes) ? iframes : []
  if (list.length === 0) return { primary: null, ads: [], reason: 'no iframe' }

  const ads = list.filter(f => isAdIframe(f))
  const candidates = list.filter(f => !isAdIframe(f))

  // 规则 1：同源 + 空 src（宿主动态写入的原型容器）
  const dynamic = candidates.find(f => {
    const src = String(f.src || '')
    return f.sameOrigin && (src === '' || src === 'about:blank' || src.startsWith('javascript:'))
  })
  if (dynamic) {
    return { primary: dynamic, ads, reason: '同源空 src（宿主动态写入的原型容器）' }
  }

  // 规则 2：同源
  const same = candidates.find(f => f.sameOrigin)
  if (same) return { primary: same, ads, reason: '同源 iframe' }

  // 规则 3：排除广告后取首个
  if (candidates.length > 0) {
    return { primary: candidates[0], ads, reason: '排除广告后首个 iframe' }
  }

  return { primary: null, ads, reason: '全部是广告 iframe' }
}

/**
 * 判断是否为第三方广告 / 统计 iframe
 *
 * @param {{ src?: string }} frame - iframe 信息
 * @returns {boolean}
 */
function isAdIframe (frame) {
  const src = String((frame && frame.src) || '').toLowerCase()
  if (!src) return false
  const adHosts = [
    'mediav.com', 'union.360.cn', 'doubleclick.net', 'googlesyndication.com',
    'googleadservices.com', 'adsrvr.org', 'cpro.baidu.com', 'pos.baidu.com',
    'gtag', 'analytics', 'umeng', 'cnzz', 'talkingdata'
  ]
  return adHosts.some(h => src.includes(h))
}

/**
 * 检测是否为前置拦截页
 *
 * 托管平台（产品大牛等）在原型前插一层反诈/免责/年龄确认页。
 * 不点掉只会把声明文字当成需求分析输入 —— 这是最容易漏的一步。
 *
 * @param {string} url - 当前 URL
 * @param {string} pageText - 页面可见文本（或快照文本）
 * @returns {{ isGate: boolean, reason: string, hitButtons: string[] }}
 */
function detectGateSignals (url, pageText) {
  const u = String(url || '')
  const t = String(pageText || '')

  const urlHit = GATE_SIGNALS.urlFragments.filter(f => u.includes(f))
  const hitButtons = GATE_SIGNALS.buttonTexts.filter(b => t.includes(b))

  if (urlHit.length > 0) {
    return { isGate: true, reason: `URL 命中 ${urlHit.join(', ')}`, hitButtons }
  }
  if (hitButtons.length > 0) {
    return { isGate: true, reason: `按钮文案命中 ${hitButtons.join(', ')}`, hitButtons }
  }
  return { isGate: false, reason: '', hitButtons: [] }
}

/**
 * 从快照 YAML 文本里挑出拦截页的按钮 ref
 *
 * 快照形如 `- button "知道了, 进入查看" [ref=e15]`，
 * 返回第一个命中文案的 ref。
 *
 * @param {string} snapshotYaml - snapshot 的 YAML 文本
 * @returns {{ ref: string|null, text: string|null }}
 */
function findGateButtonRef (snapshotYaml) {
  const text = String(snapshotYaml || '')
  for (const btnText of GATE_SIGNALS.buttonTexts) {
    // 匹配 button/ link 节点且该行含目标文案，取其 ref
    const re = new RegExp(`-\\s+(?:button|link)\\s+"[^"]*${escapeRegExp(btnText)}[^"]*"\\s*\\[ref=([^\\]]+)\\]`)
    const m = re.exec(text)
    if (m) return { ref: m[1], text: btnText }
  }
  return { ref: null, text: null }
}

/**
 * 识别宿主平台
 *
 * 命中特征表即返回平台定义（走定向提取，比通用遍历准）；
 * **认不出返回 null** —— 这是脚本交给 LLM 判断的两个介入点之一。
 *
 * 两种判定输入（任一命中即可）：
 *   - `selectors`：调用方用 eval 逐个测过的**选择器原文**（如 `#sitemapTreeContainer`）
 *   - `html`：页面 HTML 源码。**注意匹配时要剥掉 CSS 前缀** ——
 *     HTML 里出现的是 `class="sitemapPageName"`，不含 `.` / `#` 前缀，
 *     直接拿 `.sitemapPageName` 去 includes 永远匹配不到。
 *
 * @param {{ html?: string, selectors?: string[] }} probeData - 页面特征
 * @returns {object|null} HOST_PLATFORMS 中的一项，认不出为 null
 */
function detectHostPlatform (probeData) {
  const data = probeData || {}
  const html = String(data.html || '')
  const hitSelectors = Array.isArray(data.selectors) ? data.selectors : []

  for (const platform of HOST_PLATFORMS) {
    // ① 调用方已用 eval 测过选择器命中
    if (platform.selectors.some(s => hitSelectors.includes(s))) return platform

    // ② 回退：在 HTML 源码里找**剥掉 CSS 前缀**后的类名 / id
    if (html) {
      const tokens = platform.selectors.map(selectorToHtmlToken)
      if (tokens.some(tok => tok && html.includes(tok))) return platform
    }
  }
  return null
}

/**
 * 把 CSS 选择器转成它在 HTML 源码里的字面 token
 *
 * `#sitemapTreeContainer` → `sitemapTreeContainer`
 * `.sitemapPageName`       → `sitemapPageName`
 * `div.foo > .bar`         → `foo`（退化取首个类名/ id，够用即可）
 *
 * @param {string} selector - CSS 选择器
 * @returns {string|null} HTML 里可出现的 token，无法提取时为 null
 */
function selectorToHtmlToken (selector) {
  const s = String(selector || '').trim()
  if (!s) return null
  const m = /[#.]([A-Za-z0-9_-]+)/.exec(s)
  return m ? m[1] : null
}

/**
 * 从壳文本里解析 Axure 的 `(N of M)` 总页数线索
 *
 * 用于校验页面清单是否取全 —— 取到的少于 M 个就是漏了。
 *
 * @param {string} shellText - 宿主壳的可见文本
 * @param {string} [pattern] - 平台定义里的 totalPagesPattern
 * @returns {{ current: number, total: number }|null}
 */
function parseTotalPages (shellText, pattern) {
  const p = pattern || HOST_PLATFORMS[0].totalPagesPattern
  const m = new RegExp(p).exec(String(shellText || ''))
  if (!m) return null
  return { current: Number(m[1]), total: Number(m[2]) }
}

/**
 * 按平台定义从 HTML 抽取页面清单（选择器形式）
 *
 * @param {object} platform - detectHostPlatform 的返回值
 * @returns {{ treeContainer: string, pageNameNode: string, needsResize: boolean }|null}
 */
function platformPlan (platform) {
  if (!platform) return null
  return {
    treeContainer: platform.treeContainer,
    pageNameNode: platform.pageNameNode,
    needsResize: !!platform.needsResizeForFullPage,
    canvasSelectors: platform.canvasSelectors || []
  }
}

/**
 * 生成「探测渲染类型」的 eval 表达式
 *
 * 抽成函数而非散在采集层，是为了让单测能断言表达式本身
 * （表达式里含引号与花括号，是 shell 转义最容易出问题的地方）。
 *
 * @returns {string} 可直接作为 eval 参数的箭头函数串
 */
function renderProbeExpression () {
  return "() => JSON.stringify({iframe:document.querySelectorAll('iframe').length," +
    "canvas:document.querySelectorAll('canvas').length," +
    'text:document.body.innerText.length,' +
    "imgs:document.querySelectorAll('img').length})"
}

/**
 * 生成「列 iframe src 与同源性」的 eval 表达式
 *
 * @returns {string}
 */
function iframeProbeExpression () {
  return "() => { const f=document.querySelectorAll('iframe'); if(!f.length) return JSON.stringify([]);" +
    ' return JSON.stringify([...f].map(e=>{ let same=false; try{ same=!!e.contentDocument }catch(err){ same=false }' +
    ' return {id:e.id, src:e.src, sameOrigin:same} })) }'
}

/**
 * 生成「量画布内容高」的 eval 表达式
 *
 * 播放器类原型（墨刀/Axure/产品大牛）是固定视高应用，文档不滚动
 * （`scrollHeight == innerHeight`），`--full-page` 覆盖不到内部画布 ——
 * 必须先量出内容高再把视口调高，否则截图等于首屏。
 *
 * @param {string[]} canvasSelectors - 平台定义里的画布容器选择器
 * @returns {string}
 */
function measureHeightExpression (canvasSelectors) {
  const sels = (canvasSelectors && canvasSelectors.length ? canvasSelectors : ['.rResCanvas', '.zoom-area', '.screen-container'])
  const list = sels.map(s => `'${s}'`).join(',')
  return `() => { const sels=[${list}]; let h=0; for(const s of sels){ const n=document.querySelector(s);` +
    ' if(n) h=Math.max(h, n.scrollHeight||n.offsetHeight||0) }' +
    ' return Math.max(h, document.documentElement.scrollHeight, document.body?document.body.scrollHeight:0) }'
}

/**
 * 生成「说明文字通用探针」的 eval 表达式
 *
 * 兜底手段：`find` 只按关键词命中，会漏掉「面板标题不叫说明、但内容就是说明」的情况。
 *
 * 关键实现点（实测结论）：
 *   - 用 **textContent** 而非 innerText —— `display:none` 的说明面板
 *     innerText 返回空，textContent 仍返回全文。所以不点开也能拿到说明文字，
 *     点开只为补一张截图。
 *   - 同时按「属性命中（id/class 含 note/说明…）」与「文本锚点命中（短文本恰好是
 *     『说明』二字）」两种策略收集候选。
 *
 * @param {string} attrPattern - 属性名匹配模式
 * @param {number} anchorMaxLen - 文本锚点的最大长度
 * @returns {string}
 */
function notesProbeExpression (attrPattern, anchorMaxLen) {
  const pat = attrPattern || 'note|annotat|comment|remark|mark|desc|说明|备注|批注|标注|注释'
  const maxLen = anchorMaxLen || 12
  return '() => { const KEY=new RegExp(' + JSON.stringify(pat) + ",'i');" +
    ' const out=[]; const seen=new Set();' +
    " const push=(src,el)=>{ const t=((el&&el.textContent)||'').replace(/\\s+/g,' ').trim();" +
    ' if(t.length<2||t.length>4000||seen.has(t)) return; seen.add(t);' +
    ' out.push({src:src, text:t.slice(0,800)}) };' +
    " const nodes=document.querySelectorAll('div,section,aside,article,li,dl,dd,td,th,p,h1,h2,h3,h4,h5,label,span,button');" +
    ' const cands=[];' +
    ' nodes.forEach(el=>{ const sig=[el.id, typeof el.className===String?el.className:""].join(" ");' +
    "   if(KEY.test(sig)) cands.push(['attr:'+ (el.id||el.className), el]) });" +
    ' nodes.forEach(el=>{ const own=(el.textContent||"").trim();' +
    '   if(own.length<=' + maxLen + '&&KEY.test(own)){ const box=el.closest("section,aside,div,li,dl")||el.parentElement;' +
    "     if(box) cands.push(['anchor:'+own, box]) } });" +
    ' cands.forEach(c=>push(c[0],c[1]));' +
    ' return JSON.stringify(out.slice(0,40)) }'
}

/**
 * 过滤通用探针的噪音结果
 *
 * `anchor:` 策略会带回两类噪音，必须过滤，不能无脑写进材料：
 *   1. 计数行 —— 工具栏的 `说明 批注 (1 of 3)`、`(1 of 7)` 这类状态指示
 *   2. 纯符号 / 纯数字
 *
 * 判定要点：**含 `(N of M)` 形式的计数就视为噪音**，不论还带了多少个词 ——
 * 实测 Axure 工具栏的说明按钮文本就是 `说明 批注 (1 of 3)`，
 * 只按「整串是否纯计数」过滤会漏掉它。
 *
 * @param {Array<{src: string, text: string}>} candidates - 探针原始输出
 * @returns {Array<{src: string, text: string}>} 过滤后的候选
 */
function filterNotesProbe (candidates) {
  const list = Array.isArray(candidates) ? candidates : []
  return list.filter(item => {
    if (!item || !item.text) return false
    const t = String(item.text).trim()
    if (t.length < 4) return false
    // 纯计数 / 纯符号
    if (/^[\d\s()（）/·\-—_]+$/.test(t)) return false
    // 含 (N of M) 的计数行（工具栏状态指示，不是说明内容）
    if (/\(\s*\d+\s+of\s+\d+\s*\)/i.test(t)) return false
    // 整串只是若干工具栏按钮名的拼接（如「说明 批注」），无实质句子
    if (/^(说明|批注|备注|标注|注释|交互说明)(\s+(说明|批注|备注|标注|注释|交互说明))*$/.test(t)) return false
    return true
  })
}

/**
 * 按降级项推导页面状态
 *
 * 状态推导规则（唯一信源，避免各处自行判断）：
 *   - 无降级项 → ok
 *   - 有降级项但页面有实质内容 → partial
 *   - 需要用户提供截图才能继续（登录墙）→ skipped
 *
 * @param {Array<object>} degradations - DEGRADATION_KINDS 的实例列表
 * @returns {string} CAPTURE_STATUS 之一
 */
function derivePageStatus (degradations) {
  const list = Array.isArray(degradations) ? degradations : []
  if (list.length === 0) return CAPTURE_STATUS.OK
  if (list.some(d => d && d.kind === DEGRADATION_KINDS.PAGE_REQUIRES_LOGIN.kind)) {
    return CAPTURE_STATUS.SKIPPED
  }
  return CAPTURE_STATUS.PARTIAL
}

/**
 * 转义正则元字符
 * @param {string} s - 原始字符串
 * @returns {string} 可安全嵌入正则的字符串
 */
function escapeRegExp (s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  classifyRender,
  classifyIframe,
  pickPrimaryIframe,
  isAdIframe,
  detectGateSignals,
  findGateButtonRef,
  detectHostPlatform,
  selectorToHtmlToken,
  parseTotalPages,
  platformPlan,
  renderProbeExpression,
  iframeProbeExpression,
  measureHeightExpression,
  notesProbeExpression,
  filterNotesProbe,
  derivePageStatus,
  escapeRegExp
}
