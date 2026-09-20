/**
 * collect.js — 采集层（打开 / 拦截页 / 遍历 / 逐页事实 / 收尾）
 *
 * 职责:
 *   - 把 runner（子进程）与 probe（判据）拼成完整抓取流程
 *   - 逐页采集「说明原文 + 字段 + 截图」，产出 capture-result.json 的 pages 数组
 *   - 收尾清理，保证 daemon 不残留
 *
 * 设计原则:
 *   - **确定性动作全在这里，判断留给 probe 与 LLM**
 *   - 每个可能失败的动作都返回结构化结果（不抛异常到顶层），
 *     因为「抓不到」是常态而非异常 —— 材料里要如实记录，而不是让脚本崩掉
 *
 * ⚠️ 收尾必须执行三件套（close → kill-all → --json list 复查）：
 *   官方 issue 记载有主机残留 19 个 daemon、占 14.8GB 内存。
 *   单靠 try-finally 不够（process.exit / 信号 / 未捕获异步异常都会绕过），
 *   所以 capture.js 里另有 process.on('exit') 双保险，见 installFinishHooks。
 *
 * 依赖: ./runner, ./probe, ./constants（均零 npm 依赖）
 *
 * @module skills/prototype-capture/scripts/collect
 */

const fs = require('fs')
const path = require('path')

const { runCli } = require('./runner')
const probe = require('./probe')
const {
  RENDER_TYPES,
  DEGRADATION_KINDS,
  HOST_PLATFORMS,
  A11Y_KEYWORDS,
  NOTES_ATTR_PATTERN,
  NOTES_ANCHOR_MAX_LEN,
  VIEWPORT,
  PLAYER_HEADER_HEIGHT,
  MAX_VIEWPORT_HEIGHT,
  WAIT
} = require('./constants')

/** 收尾幂等标志（模块级） */
let finished = false

/**
 * 等异步渲染完成
 *
 * SPA 异步渲染，goto 后立刻取值会拿到空文本而误判 B 类。
 * **不要用 networkidle** —— 原型页常有长轮询/心跳请求，会一直超时。
 *
 * @param {string} workDir - 固定 CWD
 * @param {number} ms - 等待毫秒数
 */
function wait (workDir, ms) {
  runCli(workDir, ['--raw', 'eval', `() => new Promise(r => setTimeout(r, ${ms}))`])
}

/**
 * 前置检查：CLI 可用性与会话残留
 *
 * @param {string} workDir - 固定 CWD
 * @returns {{ ok: boolean, reason: string, version: string|null, staleBrowsers: number }}
 */
function preflight (workDir) {
  const versionRun = runCli(workDir, ['--version'])
  const versionText = (versionRun.stdout || versionRun.stderr || '').trim()
  if (!versionText || /not found|not recognized|无法将/i.test(versionText)) {
    return { ok: false, reason: 'playwright-cli 未安装或不可用', version: null, staleBrowsers: 0 }
  }
  const version = (/\d+\.\d+\.\d+/.exec(versionText) || [null])[0]

  // 会话残留：非空先杀掉，否则后续 open 可能报 profile 被锁
  const listRun = runCli(workDir, ['--json', 'list'])
  const browsers = listRun.result && Array.isArray(listRun.result.browsers)
    ? listRun.result.browsers.length
    : 0
  if (browsers > 0) runCli(workDir, ['kill-all'])

  return { ok: true, reason: '', version, staleBrowsers: browsers }
}

/**
 * 点掉前置拦截页（可能多层，循环到 URL 稳定）
 *
 * 托管平台在原型前插一层反诈/免责/年龄确认页，不点掉只抓到声明文字。
 *
 * @param {string} workDir - 固定 CWD
 * @returns {{ handled: boolean, rounds: number, reason: string }}
 */
function handleGateLoop (workDir) {
  let rounds = 0

  for (let i = 0; i < 3; i++) {
    const urlRun = runCli(workDir, ['--raw', 'eval', '() => location.href'])
    const textRun = runCli(workDir, ['--raw', 'eval', '() => document.body.innerText'])
    const url = String(urlRun.stdout || '').trim()
    const text = String(textRun.stdout || '')

    const gate = probe.detectGateSignals(url, text)
    if (!gate.isGate) {
      return { handled: rounds > 0, rounds, reason: rounds > 0 ? '已点掉拦截页' : '无拦截页' }
    }

    // 取快照找按钮 ref
    const snapName = `gate-${i + 1}.yml`
    runCli(workDir, ['snapshot', `--filename=${snapName}`])
    const snapPath = path.join(workDir, snapName)
    let snapText = ''
    try { snapText = fs.readFileSync(snapPath, 'utf8') } catch (e) { /* 快照可能没落盘 */ }

    const btn = probe.findGateButtonRef(snapText)
    if (!btn.ref) {
      return { handled: rounds > 0, rounds, reason: `检测到拦截页但找不到可点按钮（${gate.reason}）` }
    }

    runCli(workDir, ['click', btn.ref])
    wait(workDir, WAIT.afterGateClick)
    rounds++
  }

  return { handled: rounds > 0, rounds, reason: '拦截页层数超上限，可能仍未进入原型' }
}

/**
 * 打开原型并探测渲染类型
 *
 * @param {string} workDir - 固定 CWD
 * @param {string} url - 原型链接
 * @param {'pc'|'h5'} terminal - 终端类型，决定视口
 * @returns {{ ok: boolean, error: string|null, render: object|null, gate: object, width: number, height: number }}
 */
function openAndProbe (workDir, url, terminal) {
  const vp = VIEWPORT[terminal] || VIEWPORT.pc

  const openRun = runCli(workDir, ['open', url])
  if (!openRun.ok && /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_ABORTED/i.test(openRun.stdout || '')) {
    return {
      ok: false,
      error: '页面无法访问（可能链接失效或网络受限）: ' + compactError(openRun),
      render: null,
      gate: { handled: false, rounds: 0, reason: '' },
      width: vp.width,
      height: vp.height
    }
  }

  wait(workDir, WAIT.afterOpen)
  runCli(workDir, ['resize', String(vp.width), String(vp.height)])

  const gate = handleGateLoop(workDir)

  const metricsRun = runCli(workDir, ['--json', 'eval', probe.renderProbeExpression()])
  const metrics = metricsRun.result

  return {
    ok: true,
    error: null,
    render: probe.classifyRender(metrics),
    metrics,
    gate,
    width: vp.width,
    height: vp.height
  }
}

/**
 * 探测 iframe 详情并判子类
 *
 * ⚠️ 页面可能混入第三方广告 iframe（实测墨刀真实原型有 2 个 360 广告），
 * 所以先用 `pickPrimaryIframe` 挑出原型本体再判子类 —— 否则广告的
 * 「跨域真实 URL」特征会把类型误判成 C3。
 *
 * @param {string} workDir - 固定 CWD
 * @returns {{ iframes: Array<object>, primary: object|null, ads: Array, subtype: string|null, actionable: string }}
 */
function probeIframes (workDir) {
  const run = runCli(workDir, ['--json', 'eval', probe.iframeProbeExpression()])
  const iframes = Array.isArray(run.result) ? run.result : []
  if (iframes.length === 0) {
    return { iframes: [], primary: null, ads: [], subtype: null, actionable: '' }
  }

  const picked = probe.pickPrimaryIframe(iframes)
  if (!picked.primary) {
    return { iframes, primary: null, ads: picked.ads, subtype: null, actionable: '页面上只有广告 iframe，未找到原型本体' }
  }

  const cls = probe.classifyIframe(picked.primary)
  return {
    iframes,
    primary: picked.primary,
    ads: picked.ads,
    subtype: cls.subtype,
    pickReason: picked.reason,
    actionable: cls.actionable
  }
}

/**
 * 识别宿主平台
 *
 * @param {string} workDir - 固定 CWD
 * @returns {object|null} 平台定义或 null（null 即需 LLM 介入）
 */
function identifyPlatform (workDir) {
  const hitSelectors = []
  for (const platform of HOST_PLATFORMS) {
    for (const sel of platform.selectors) {
      const run = runCli(workDir, ['--json', 'eval',
        `() => !!document.querySelector(${JSON.stringify(sel)})`])
      if (run.result === true) hitSelectors.push(sel)
    }
  }
  return probe.detectHostPlatform({ selectors: hitSelectors })
}

/**
 * 取画布内容指纹（用于判定翻页是否生效）
 *
 * ⚠️ 翻页生效判定**不能只看 URL** —— 实测墨刀是前端换屏、URL 完全不变，
 * 只看 URL 会把成功的翻页全判成 `click_no_effect`。
 *
 * 用「画布容器内文本的哈希 + 长度」作指纹，变化即认为翻页生效。
 *
 * @param {string} workDir - 固定 CWD
 * @param {string[]} canvasSelectors - 画布容器选择器
 * @returns {string} 内容指纹（空串表示取不到）
 */
function canvasFingerprint (workDir, canvasSelectors) {
  const sels = (canvasSelectors && canvasSelectors.length) ? canvasSelectors : ['#canvas']
  const expr = '() => { const sels=' + JSON.stringify(sels) + '; for(const s of sels){' +
    ' const n=document.querySelector(s); if(!n) continue;' +
    " const t=(n.innerText||'').replace(/\\s+/g,' ').trim();" +
    ' return t.length + ":" + t.slice(0,300) }' +
    " const b=document.body; const t=(b&&b.innerText||'').replace(/\\s+/g,' ').trim();" +
    ' return t.length + ":" + t.slice(0,300) }'
  const run = runCli(workDir, ['--json', 'eval', expr])
  return typeof run.result === 'string' ? run.result : ''
}

/**
 * 取宿主平台页面树里的页面名清单
 *
 * - **Axure**：面板**默认折叠**，不点开会误判「只有一页」；且每次跳页后可能重新折叠。
 * - **墨刀**：面板默认展开，页面项 `li.rn-content-item` 的 innerText 形如
 *   `1\n页面 1`（序号 + 页面名两行），需要抽掉序号行只留名字。
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} platform - detectHostPlatform 的返回值
 * @returns {{ names: string[], total: number|null, panelOpened: boolean, rawCount: number }}
 */
function readPageTree (workDir, platform) {
  const plan = probe.platformPlan(platform)
  if (!plan) return { names: [], total: null, panelOpened: false, rawCount: 0 }

  // 先尝试展开面板（找不到可点节点也无妨，可能本就展开着）
  const panelOpened = tryExpandPanel(workDir, platform)

  const expr = `() => JSON.stringify([...document.querySelectorAll(${JSON.stringify(plan.pageNameNode)})].map(e => (e.innerText || '').trim()).filter(Boolean))`
  const run = runCli(workDir, ['--json', 'eval', expr])
  const rawList = Array.isArray(run.result) ? run.result : []
  const names = rawList.map(cleanPageName).filter(Boolean)

  // 从壳文本解析总页数（Axure: `(1 of 7)`；墨刀: `画布（1）`）
  const shellRun = runCli(workDir, ['--raw', 'eval', '() => document.body.innerText'])
  const tp = probe.parseTotalPages(String(shellRun.stdout || ''), platform.totalPagesPattern)

  return { names, total: tp ? tp.total : null, panelOpened, rawCount: rawList.length }
}

/**
 * 清洗页面名的原始文本
 *
 * 各平台列表项的 innerText 形态不同：
 *   - 墨刀 `li.rn-content-item`：`1\n页面 1`（首行是序号）
 *   - Axure `.sitemapPageName`：直接是页面名
 *
 * 清洗规则：取**最后一行非纯数字**的内容作为页面名；若全无可读内容，
 * 回退用首行（便于材料里至少能看到标识）。
 *
 * @param {string} raw - 列表项的 innerText
 * @returns {string} 清洗后的页面名
 */
function cleanPageName (raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''

  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (lines.length === 0) return ''

  // 优先取最后一行（页面名通常在序号下方）
  const named = lines.filter(l => !/^\d+$/.test(l))
  if (named.length > 0) return named[named.length - 1].slice(0, 100)

  // 全是数字时回退首行
  return lines[0].slice(0, 100)
}

/**
 * 尝试点开折叠的页面树面板
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} platform - 平台定义
 * @returns {boolean} 是否成功点击
 */
function tryExpandPanel (workDir, platform) {
  if (!platform.panelToggleText) return false

  const snapName = 'nav-panel.yml'
  runCli(workDir, ['snapshot', `--filename=${snapName}`])
  let snapText = ''
  try { snapText = fs.readFileSync(path.join(workDir, snapName), 'utf8') } catch (e) { return false }

  const re = new RegExp(`-\\s+generic\\s+"[^"]*${probe.escapeRegExp(platform.panelToggleText)}[^"]*"\\s*\\[ref=([^\\]]+)\\][^\\n]*cursor=pointer`)
  const m = re.exec(snapText)
  if (!m) return false

  runCli(workDir, ['click', m[1]])
  wait(workDir, WAIT.afterClick)
  return true
}

/**
 * 量画布内容高度（播放器类原型截全的关键）
 *
 * 墨刀 / Axure / 产品大牛是固定视高应用，文档不滚动，
 * `--full-page` 只按文档滚动高度扩展 → 等于首张首屏。
 *
 * @param {string} workDir - 固定 CWD
 * @param {string[]} canvasSelectors - 画布容器选择器
 * @returns {number} 内容高度（像素），量不到时回退到视口高
 */
function measureContentHeight (workDir, canvasSelectors) {
  const run = runCli(workDir, ['--json', 'eval', probe.measureHeightExpression(canvasSelectors)])
  const h = Number(run.result)
  if (!h || Number.isNaN(h)) {
    const vh = runCli(workDir, ['--raw', 'eval', '() => innerHeight'])
    return Number(vh.stdout) || VIEWPORT.pc.height
  }
  return h
}

/**
 * 截图当前页（播放器类先调高视口再截）
 *
 * @param {string} workDir - 固定 CWD
 * @param {string} filename - 截图文件名（序号-拼音.png）
 * @param {{ width: number, height: number, needsResize: boolean, canvasSelectors: string[] }} opts
 * @returns {{ ok: boolean, truncated: boolean, error: string|null }}
 */
function screenshotPage (workDir, filename, opts) {
  const o = opts || {}
  let truncated = false

  if (o.needsResize) {
    const contentH = measureContentHeight(workDir, o.canvasSelectors)
    const target = Math.min(contentH + PLAYER_HEADER_HEIGHT, MAX_VIEWPORT_HEIGHT)
    if (target > (o.height || 0)) {
      runCli(workDir, ['resize', String(o.width || VIEWPORT.pc.width), String(target)])
      wait(workDir, WAIT.afterResize)
      if (contentH + PLAYER_HEADER_HEIGHT > MAX_VIEWPORT_HEIGHT) truncated = true
    }
  }

  const run = runCli(workDir, ['screenshot', `--filename=${filename}`, '--full-page'])
  const exists = fs.existsSync(path.join(workDir, filename))
  return { ok: run.ok && exists, truncated, error: run.ok ? null : compactError(run) }
}

/**
 * 采集说明文字
 *
 * 三种来源，按可靠性排序（**画布文本优先** —— 这是 2026-09 真实墨刀原型
 * 实测纠正的关键点）：
 *
 *   1. **画布容器 innerText**（首选）
 *      实测墨刀：产品经理写的说明/批注**直接作为文本画在画布里**，
 *      `#canvas` 的 innerText 就含完整说明（如「1. 客户诉求： a. 客服管理支持…」）。
 *      这是最可靠的一手来源，且不需要点开任何面板。
 *
 *   2. **find 关键词**（辅助）
 *      ⚠️ 实测坑：`find` 返回的是**带上下文的无障碍树 YAML 片段**，
 *      命中项多半是工具栏按钮（「总览/演示/标注」「批注/评论/展开全部」）。
 *      所以**只从命中结果里抽文本节点，不能整段塞进材料**。
 *
 *   3. **通用探针 attr/anchor**（兜底）
 *      匹配 id/class 含 note/说明 的面板，用 textContent（隐藏面板也能取到）。
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} [opts] - { canvasSelectors } 画布容器选择器
 * @returns {{ notes: Array<{source: string, text: string}>, found: boolean, rounds: number }}
 */
function collectNotes (workDir, opts = {}) {
  const found = []

  // ① 画布文本（首选）
  const canvasText = collectCanvasText(workDir, opts.canvasSelectors)
  if (canvasText) {
    found.push({ source: '画布文本', text: canvasText })
  }

  // ② find 关键词（从 YAML 里抽纯文本行，不整段保留）
  for (let i = 0; i < A11Y_KEYWORDS.length; i++) {
    const run = runCli(workDir, ['--raw', 'find', '--regex', A11Y_KEYWORDS[i]])
    const out = String(run.stdout || '')
    if (!out || /^No matches found/i.test(out)) continue

    const extracted = extractTextFromSnapshot(out)
    // 只保留有实质内容的命中（过滤纯工具栏按钮名）
    const meaningful = extracted.filter(t => t.length >= 8 && !isToolbarJunk(t))
    if (meaningful.length > 0) {
      found.push({ source: `关键词命中(${i + 1})`, text: meaningful.join('\n') })
      break
    }
  }

  // ③ 通用探针兜底（同样要过滤工具栏噪音）
  const probeRun = runCli(workDir, ['--json', 'eval',
    probe.notesProbeExpression(NOTES_ATTR_PATTERN, NOTES_ANCHOR_MAX_LEN)])
  const candidates = probe.filterNotesProbe(probeRun.result)
  for (const c of candidates) {
    if (isToolbarJunk(c.text)) continue
    found.push({ source: c.src, text: c.text })
  }

  // 去重并去掉被画布文本完全覆盖的碎片
  const deduped = dedupeNotes(found, canvasText)

  return {
    notes: deduped,
    found: deduped.length > 0,
    rounds: A11Y_KEYWORDS.length
  }
}

/**
 * 取画布容器内的可见文本（说明文字的第一手来源）
 *
 * 墨刀的说明/批注是**画在画布里的文本**，`#canvas` 的 innerText 就含完整内容。
 *
 * 换行处理：部分元素的 `innerText` 不给换行符，会把相邻句子粘成一行
 * （实测「允许订单退款不允许订单退款-弹窗限制…」）。
 * 所以对过长的行按「句末标点 + 后续以编号/中文起头」的位置补换行，提升可读性。
 *
 * @param {string} workDir - 固定 CWD
 * @param {string[]} canvasSelectors - 画布容器选择器
 * @returns {string} 画布文本（空串表示取不到或无实质内容）
 */
function collectCanvasText (workDir, canvasSelectors) {
  const sels = (canvasSelectors && canvasSelectors.length) ? canvasSelectors : ['#canvas', '.rResCanvas', '.zoom-area']
  const expr = '() => { const sels=' + JSON.stringify(sels) + '; for(const s of sels){' +
    ' const n=document.querySelector(s); if(!n) continue;' +
    " const t=(n.innerText||'').trim();" +
    ' if(t.length >= 10) return t }' +
    " return '' }"
  const run = runCli(workDir, ['--json', 'eval', expr])
  const text = typeof run.result === 'string' ? run.result.trim() : ''
  if (text.length < 10) return ''
  return splitRunOnText(text).slice(0, 8000)
}

/**
 * 给粘连的长行补换行
 *
 * `innerText` 对某些元素不插换行，导致多个句子粘成一行。
 * 两类补法：
 *   - **句末标点后紧跟新句起头** → 断行（仅对长行做，避免把正常的短句切碎）
 *   - **`【【…】` 这类方括号标题前** → 断行（无论行长短，它天然是分节标记）
 *
 * @param {string} text - 原始文本
 * @returns {string} 补过换行的文本
 */
function splitRunOnText (text) {
  const raw = String(text || '')
  return raw
    .split(/\r?\n/)
    .map(line => {
      // 方括号标题前始终断开（标题天然是独立分节）
      let out = line.replace(/(?<=[^\n])(?=【【)/g, '\n')
      // 句末标点后接新句起头，仅长行处理
      if (out.length >= 60) {
        out = out.replace(/([。！？；：）】」])(?=[\u4e00-\u9fa5A-Za-z0-9【])/g, '$1\n')
      }
      return out
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 从 `find` 的 YAML 片段里抽出纯文本节点
 *
 * `find` 返回形如：
 *   - generic [ref=e297] [cursor=pointer]:
 *     - generic "批注" [ref=e297]
 *       - generic [ref=e146]: "1."
 *       - generic [ref=e147]: 客户诉求：
 *
 * 抽掉 `- generic [ref=...]:` 这类结构行，只留冒号后的文本。
 *
 * @param {string} raw - find 的原始 stdout
 * @returns {string[]} 抽出的文本片段
 */
function extractTextFromSnapshot (raw) {
  const out = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s || /^Found \d+ match/.test(s) || s === '----') continue

    // 形如 `- generic "批注" [ref=e297]` → 取引号内内容
    const quoted = /^-\s+\w+\s+"([^"]+)"/.exec(s)
    if (quoted) { out.push(quoted[1].trim()); continue }

    // 形如 `- generic [ref=e147]: 客户诉求：` → 取冒号后的文本
    const after = /^-\s+\w+[^:]*:\s*(.+)$/.exec(s)
    if (after) {
      const t = after[1].trim().replace(/^"|"$/g, '')
      // 排除纯 ref 行（如 `- /url: https://...`）
      if (t && !/^\[ref=/.test(t)) out.push(t)
    }
  }
  return out.filter(Boolean)
}

/**
 * 判断是否工具栏噪音（不是原型说明内容）
 *
 * 实测墨刀工具栏按钮名会被 `find` / 探针命中：
 * 「总览」「演示」「标注」「批注」「评论」「展开全部」「登录」「免费使用」
 * 以及组合片段「总览演示标注」「批注评论展开全部」「…后可使用标注、导出等更多功能」。
 *
 * @param {string} text - 待判定文本
 * @returns {boolean}
 */
function isToolbarJunk (text) {
  const t = String(text || '').trim()
  if (!t) return true

  const junkWords = ['总览', '演示', '标注', '批注', '评论', '展开全部', '收起', '展开', '登录', '免费使用', '导出']
  if (junkWords.includes(t)) return true

  // 登录提示类文案（含「登录」「可使用」且无实质句子结构）
  if (/登录|可使用.{0,10}更多功能/.test(t) && t.length < 30) return true

  // 整串是若干工具栏词拼接（去掉这些词后几乎不剩什么）
  let stripped = t
  for (const w of junkWords) stripped = stripped.split(w).join('')
  if (stripped.replace(/[\s、，,。.]/g, '').length <= 3) return true

  // 无任何句子标点且很短 → 多半是按钮名
  if (!/[：:。，,、；]/.test(t) && t.length < 20) return true

  return false
}

/**
 * 说明条目去重（画布文本已覆盖的碎片丢弃）
 *
 * @param {Array<{source: string, text: string}>} notes - 原始条目
 * @param {string} canvasText - 画布文本
 * @returns {Array<{source: string, text: string}>} 去重后条目
 */
function dedupeNotes (notes, canvasText) {
  const out = []
  const seen = new Set()
  for (const n of notes) {
    if (!n || !n.text) continue
    const t = String(n.text).trim()
    if (!t) continue
    // 已被画布文本包含的碎片丢弃（画布文本是更完整的版本）
    if (canvasText && canvasText.includes(t) && n.source !== '画布文本') continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push({ source: n.source, text: t })
  }
  return out
}

/**
 * 采集表单字段（label / placeholder / 必填）
 *
 * `innerText` 拿不到 value / placeholder / 被 CSS 隐藏的内容，必须定制 eval。
 *
 * ⚠️ 必须过滤**宿主壳自己的 UI 控件**。实测墨刀：
 *   - 工具栏搜索框（`input[type=text]`，无 name / placeholder）
 *   - 若干 `input[type=checkbox]`（无 name / placeholder）
 *   这些既不是原型字段，位置过滤也无效（它们就在 `#canvas` 容器内）。
 *
 * 因此判据改为**「有语义标识」**：只保留有 `name` 或 `placeholder`
 * 或非 checkbox/radio 的输入控件 —— 原型里真实业务字段至少会有 placeholder
 * 或 name，而宿主 UI 控件两者皆无（实测 10 个全是 `name:''` + `ph:''`）。
 *
 * @param {string} workDir - 固定 CWD
 * @returns {Array<object>} 字段列表
 */
function collectFields (workDir) {
  const expr = "() => JSON.stringify([...document.querySelectorAll('input,textarea,select')]" +
    " .map(e => ({ tag:e.tagName, name:e.name||'', type:(e.type||'').toLowerCase(), ph:e.placeholder||'', required:!!e.required }))" +
    ' .filter(f => f.name || f.ph))'
  const run = runCli(workDir, ['--json', 'eval', expr])
  return Array.isArray(run.result) ? run.result : []
}

/**
 * 采集单页完整事实
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} page - { index, name, pinyin, url, iframeSrc }
 * @param {object} ctx - { width, height, needsResize, canvasSelectors, renderType }
 * @returns {object} PageRecord（结构见 constants 的 MATERIAL_SECTIONS / SCHEMA_VERSION）
 */
function collectPageFacts (workDir, page, ctx) {
  const c = ctx || {}
  const degradations = []

  const filename = `${String(page.index).padStart(2, '0')}-${page.pinyin}.png`
  const shot = screenshotPage(workDir, filename, {
    width: c.width,
    height: c.height,
    needsResize: c.needsResize,
    canvasSelectors: c.canvasSelectors
  })
  if (shot.truncated) degradations.push(DEGRADATION_KINDS.SCREENSHOT_TRUNCATED)

  const notesResult = collectNotes(workDir, { canvasSelectors: c.canvasSelectors })
  if (!notesResult.found) {
    // Canvas 类（B）说明可能是画上去的 → 用更准确的降级类型
    degradations.push(c.renderType === RENDER_TYPES.B
      ? DEGRADATION_KINDS.NOTES_CANVAS
      : DEGRADATION_KINDS.NOTES_MISSING)
  }

  const fields = c.renderType === RENDER_TYPES.B ? [] : collectFields(workDir)
  if (c.renderType === RENDER_TYPES.B && fields.length === 0) {
    degradations.push(DEGRADATION_KINDS.FIELD_FROM_SCREENSHOT)
  }

  const urlRun = runCli(workDir, ['--raw', 'eval', '() => location.href'])

  return {
    index: page.index,
    name: page.name,
    namePinyin: page.pinyin,
    url: stripRawQuotes(urlRun.stdout) || page.url || '',
    iframeSrc: page.iframeSrc || null,
    screenshot: filename,
    screenshotOk: shot.ok,
    status: probe.derivePageStatus(degradations),
    degradations,
    notes: notesResult.notes,
    fields,
    interactions: []
  }
}

/**
 * 去掉 `--raw` 回执外层的 JSON 字符串引号
 *
 * `playwright-cli --raw eval "() => location.href"` 的 stdout 是
 * `"https://example.com/"`（含引号，因为 JS 字符串被 JSON 序列化过），
 * 直接用会把引号写进材料。
 *
 * @param {string} raw - --raw 的原始 stdout
 * @returns {string} 去引号并 trim 后的值
 */
function stripRawQuotes (raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s) } catch (e) { return s.slice(1, -1) }
  }
  return s
}

/**
 * 收尾清理（幂等）
 *
 * 三件套缺一不可：close 只清 session 文件、kill-all 才杀 daemon 进程、
 * list 复查确认无残留。**每个子步骤独立 try-catch** —— close 失败不能阻止 kill-all
 * （常见场景：session 已失效但 daemon 还活着）。
 *
 * ⚠️ 本函数必须**只做同步操作**，因为它会被 process.on('exit') 调用，
 * 而 Node 保证 exit 钩子里只能跑同步代码（spawnSync 满足，spawn 异步版不满足）。
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} [opts] - { runner, cliPath } 供测试注入
 * @returns {{ ran: boolean, reason: string }}
 */
function finish (workDir, opts = {}) {
  if (finished) return { ran: false, reason: 'already finished' }
  finished = true

  try { runCli(workDir, ['close'], opts) } catch (e) { /* 继续 */ }
  try { runCli(workDir, ['kill-all'], opts) } catch (e) { /* 继续 */ }
  try {
    const listRun = runCli(workDir, ['--json', 'list'], opts)
    const browsers = listRun.result && Array.isArray(listRun.result.browsers)
      ? listRun.result.browsers.length
      : 0
    if (browsers > 0) runCli(workDir, ['kill-all'], opts)
  } catch (e) { /* 继续 */ }
  try {
    fs.rmSync(path.join(workDir, '.playwright-cli'), { recursive: true, force: true })
  } catch (e) { /* 继续 */ }

  return { ran: true, reason: 'close + kill-all + list 复查完成' }
}

/** 重置收尾标志（仅供测试） */
function resetFinishFlag () {
  finished = false
}

/**
 * 安装收尾双保险钩子
 *
 * try-finally 只覆盖同步抛出；以下场景会绕过它：
 *   - process.exit() 直接退出
 *   - 信号终止（Ctrl+C / 宿主超时 kill）
 *   - 未捕获的异步异常
 *
 * 所以额外挂 process.on('exit')（覆盖 process.exit 与正常结束）
 * 与 SIGINT / SIGTERM（覆盖 Ctrl+C）。
 *
 * ⚠️ Windows 上 SIGTERM 支持不完整，`exit` 钩子是主保险，信号处理是尽力而为。
 *
 * @param {string} workDir - 固定 CWD
 */
function installFinishHooks (workDir) {
  process.on('exit', () => { finish(workDir) })
  process.on('SIGINT', () => { finish(workDir); process.exit(130) })
  process.on('SIGTERM', () => { finish(workDir); process.exit(143) })
}

/**
 * 压缩 CLI 错误文本（去掉冗长的调用日志）
 *
 * @param {object} runResult - runCli 的返回值
 * @returns {string} 单行错误摘要
 */
function compactError (runResult) {
  const r = runResult || {}
  const text = String(r.error || r.stdout || r.stderr || '未知错误')
  const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '未知错误'
  return firstLine.slice(0, 200)
}

module.exports = {
  wait,
  preflight,
  handleGateLoop,
  openAndProbe,
  probeIframes,
  identifyPlatform,
  readPageTree,
  cleanPageName,
  canvasFingerprint,
  tryExpandPanel,
  measureContentHeight,
  screenshotPage,
  collectNotes,
  collectCanvasText,
  splitRunOnText,
  extractTextFromSnapshot,
  isToolbarJunk,
  dedupeNotes,
  collectFields,
  collectPageFacts,
  finish,
  resetFinishFlag,
  installFinishHooks,
  compactError,
  stripRawQuotes
}
