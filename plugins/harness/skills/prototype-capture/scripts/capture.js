#!/usr/bin/env node
/**
 * capture.js — 原型抓取器 CLI（脚本采集 + LLM 判断 两段式）
 *
 * 职责:
 *   - 承担**确定性 + 可循环**的采集动作：环境自检 / 拦截页循环 / 渲染类型判定 /
 *     宿主平台定向提取逐页遍历 / 说明文字采集 / 收尾清理 / 材料渲染
 *   - 把「需要判断」的部分以**结构化状态**交回给 LLM（need_llm / partial），
 *     而不是靠 console 日志让 LLM 猜
 *
 * 与 SKILL.md 的分工:
 *   本脚本的导出常量（见 constants.js）是**契约单一信源** —— 状态枚举、材料章节、
 *   降级文案、平台特征表都以脚本为准，SKILL.md 只描述「何时调、读什么字段」，
 *   不复述任何字段名与章节列表。
 *
 * 用法:
 *   node capture.js run    --url <url> --work-dir <dir> [--terminal pc|h5] [--title <标题>] [--full]
 *   node capture.js probe  --work-dir <dir>
 *   node capture.js page   --work-dir <dir> --target <ref|css> --name <中文名> [--pinyin <拼音>]
 *   node capture.js finish --work-dir <dir>
 *   node capture.js render --result <capture-result.json> [--out <prototype-capture.md>]
 *   node capture.js --help | --version
 *
 * 输出约定:
 *   **stdout 只有 JSON**（便于 LLM 直接 parse），日志与进度走 stderr。
 *
 * 退出码:
 *   0 —— 全部 ok / partial / need_llm（材料可用，LLM 需按 nextAction 介入）
 *   1 —— 有 failed 页或采集层错误
 *   2 —— 前置条件不满足（CLI 未装 / 参数缺失 / 工作目录不存在）
 *
 * 依赖: 仅 node 内建 + 本目录同层模块，零 npm 依赖
 *
 * @module skills/prototype-capture/scripts/capture
 */

const fs = require('fs')
const path = require('path')

const runner = require('./runner')
const probe = require('./probe')
const collect = require('./collect')
const render = require('./render')
const {
  SCHEMA_VERSION,
  CAPTURE_STATUS,
  NON_FATAL_STATUS,
  MATERIAL_SECTIONS,
  NEXT_ACTIONS,
  HOST_PLATFORMS,
  RENDER_TYPES,
  IFRAME_SUBTYPES,
  DEGRADATION_KINDS,
  GATE_SIGNALS,
  A11Y_KEYWORDS,
  VIEWPORT
} = require('./constants')

/** 结果文件名（固定，与 SKILL.md 的约定一致） */
const RESULT_FILENAME = 'capture-result.json'

/**
 * 解析命令行参数
 *
 * 手写解析（与仓库 api-generator 的 scripts/index.js 同风格），不引依赖。
 *
 * ⚠️ `--help` / `--version` 可能出现在**子命令位置**（`capture.js --help`），
 * 所以取 command 时要把这类全局 flag 跳过，否则会被当成子命令名。
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ command: string, opts: object, errors: string[] }}
 */
function parseArgs (argv) {
  const args = Array.isArray(argv) ? argv.slice() : []
  const opts = {}
  const errors = []
  let command = ''

  const known = {
    '--url': 'url',
    '--work-dir': 'workDir',
    '--terminal': 'terminal',
    '--title': 'title',
    '--target': 'target',
    '--name': 'name',
    '--pinyin': 'pinyin',
    '--result': 'result',
    '--out': 'out',
    '--index': 'index'
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i]

    if (a === '--help' || a === '-h') { opts.help = true; continue }
    if (a === '--version' || a === '-v') { opts.version = true; continue }
    if (a === '--full') { opts.full = true; continue }

    const key = known[a]
    if (key) {
      const val = args[i + 1]
      if (val === undefined || val.startsWith('--')) { errors.push(`${a} 缺少取值`); continue }
      opts[key] = val
      i++
      continue
    }

    if (a.startsWith('-')) { errors.push(`未知参数: ${a}`); continue }

    // 第一个非 flag 参数是子命令
    if (!command) { command = a; continue }
    errors.push(`多余的参数: ${a}`)
  }

  return { command, opts, errors }
}

/**
 * 输出帮助文本
 *
 * 帮助里的契约信息（状态枚举、章节清单）直接从常量渲染，不复述。
 *
 * @returns {string}
 */
function helpText () {
  const statuses = Object.values(CAPTURE_STATUS).join(' / ')
  const sections = MATERIAL_SECTIONS.map(s => s.title).join(' / ')
  return [
    'prototype-capture — 在线原型抓取器（playwright-cli 驱动）',
    `schemaVersion: ${SCHEMA_VERSION}`,
    '',
    '用法:',
    '  node capture.js run    --url <url> --work-dir <dir> [--terminal pc|h5] [--title <标题>] [--full]',
    '  node capture.js probe  --work-dir <dir>',
    '  node capture.js page   --work-dir <dir> --target <ref|css> --name <中文名> [--pinyin <拼音>]',
    '  node capture.js finish --work-dir <dir>',
    '  node capture.js render --result <capture-result.json> [--out <prototype-capture.md>]',
    '',
    '子命令职责:',
    '  run     主流程：打开 → 拦截页 → 探测 → 分流 → 逐页采集 → 落 result → 收尾',
    '  probe   只探测当前页渲染类型与 iframe 详情（不翻页不截图）',
    '  page    补抓单页（LLM 判断出平台特征后，或首次采集失败后）',
    '  finish  幂等收尾（close → kill-all → 复查）',
    '  render  读 result JSON 渲染材料 markdown（纯函数，不启浏览器）',
    '',
    `状态枚举: ${statuses}`,
    `材料必备章节: ${sections}`,
    '',
    '退出码: 0=可继续（含 partial/need_llm） 1=有失败 2=前置条件不满足',
    '',
    '输出: stdout 只有 JSON，日志走 stderr。'
  ].join('\n')
}

/**
 * 输出结构化 JSON 到 stdout
 *
 * @param {object} payload - 结果对象
 */
function emit (payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
}

/**
 * 输出 run 结果到 stdout（默认摘要，--full 输出全量）
 *
 * run 的全量结果含每页超长 notes，原样打 stdout 会把调用方读爆（实测一份
 * 墨刀原型单页上千字，5 页全量 JSON 直接撑满输出 token）。所以默认只打摘要：
 * 状态 + 汇总 + 逐页一行（index/name/status/screenshot/notes 条数），
 * 全量仍在 capture-result.json，需要详情时再按页读文件。显式传 --full 才打全量。
 *
 * @param {object} env - 完整结果信封
 * @param {object} opts - 解析后的命令行参数
 */
function emitRunResult (env, opts) {
  if (opts.full) {
    emit(env)
    return
  }
  emit({
    schemaVersion: env.schemaVersion,
    command: env.command,
    ok: env.ok,
    status: env.status,
    title: env.title,
    url: env.url,
    summary: env.summary,
    resultFile: env.resultFile,
    screenshotDir: env.screenshotDir,
    pages: Array.isArray(env.pages)
      ? env.pages.map(p => ({
        index: p.index,
        name: p.name,
        status: p.status,
        screenshot: p.screenshot,
        notes: (p.notes || []).length
      }))
      : []
  })
}

/**
 * 日志（走 stderr，不污染 stdout 的 JSON）
 *
 * @param {string} msg - 日志内容
 */
function log (msg) {
  process.stderr.write(String(msg) + '\n')
}

/**
 * 构造结果信封
 *
 * @param {string} command - 子命令名
 * @param {object} extra - 附加字段
 * @returns {object} 统一信封
 */
function envelope (command, extra) {
  return Object.assign({
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: true,
    status: CAPTURE_STATUS.OK,
    pages: [],
    needLlm: [],
    errors: [],
    summary: { total: 0, ok: 0, partial: 0, needLlm: 0, failed: 0, skipped: 0 }
  }, extra || {})
}

/**
 * 汇总页面状态并推导整体状态
 *
 * @param {Array<object>} pages - 页面记录列表
 * @returns {{ summary: object, status: string, needLlm: Array }}
 */
function summarize (pages) {
  const list = Array.isArray(pages) ? pages : []
  const summary = { total: list.length, ok: 0, partial: 0, needLlm: 0, failed: 0, skipped: 0 }
  const needLlm = []

  for (const p of list) {
    switch (p.status) {
      case CAPTURE_STATUS.OK: summary.ok++; break
      case CAPTURE_STATUS.PARTIAL: summary.partial++; break
      case CAPTURE_STATUS.SKIPPED: summary.skipped++; break
      case CAPTURE_STATUS.FAILED: summary.failed++; break
      case CAPTURE_STATUS.NEED_LLM:
        summary.needLlm++
        needLlm.push({
          index: p.index,
          pageName: p.name,
          reason: p.reason || 'host_platform_unrecognized',
          probe: p.probe || null,
          nextAction: NEXT_ACTIONS[CAPTURE_STATUS.NEED_LLM]
        })
        break
      default: break
    }
  }

  let status = CAPTURE_STATUS.OK
  if (summary.failed > 0) status = CAPTURE_STATUS.FAILED
  else if (summary.needLlm > 0) status = CAPTURE_STATUS.NEED_LLM
  else if (summary.partial > 0) status = CAPTURE_STATUS.PARTIAL

  return { summary, status, needLlm }
}

/**
 * 把页面名转成文件名安全的拼音片段
 *
 * 中文页面名不进文件名（Git Bash 下会乱码），退化用序号占位。
 *
 * @param {string} name - 页面中文名
 * @param {number} index - 序号（兜底用）
 * @returns {string} 文件安全片段
 */
function toPinyin (name, index) {
  const s = String(name || '')
  // 已是 ASCII 的（英文/数字）直接用
  const ascii = s.replace(/[^A-Za-z0-9-]/g, '').toLowerCase()
  if (ascii) return ascii.slice(0, 40)
  return `page-${String(index).padStart(2, '0')}`
}

/**
 * run 子命令：主采集流程
 *
 * @param {object} opts - 解析后的参数
 * @returns {number} 退出码
 */
function cmdRun (opts) {
  const workDir = opts.workDir
  const env = envelope('run', { url: opts.url || '', title: opts.title || '', pages: [] })

  if (!opts.url) {
    env.ok = false
    env.errors.push('缺少 --url')
    emit(env)
    return 2
  }
  if (!workDir) {
    env.ok = false
    env.errors.push('缺少 --work-dir')
    emit(env)
    return 2
  }

  fs.mkdirSync(workDir, { recursive: true })
  collect.installFinishHooks(workDir)

  try {
    log('[1/5] 前置检查')
    const pre = collect.preflight(workDir)
    env.playwrightVersion = pre.version
    if (!pre.ok) {
      env.ok = false
      env.errors.push(pre.reason)
      env.installHint = 'npm install -g @playwright/cli@latest && playwright-cli install-browser'
      emit(env)
      return 2
    }

    log('[2/5] 打开原型并探测渲染类型')
    const opened = collect.openAndProbe(workDir, opts.url, opts.terminal || 'pc')
    env.gate = opened.gate
    if (!opened.ok) {
      env.ok = false
      env.errors.push(opened.error)
      env.status = CAPTURE_STATUS.FAILED
      emit(env)
      return 1
    }
    env.render = opened.render
    env.metrics = opened.metrics

    log(`[3/5] 分流处理（渲染类型 ${opened.render.type}）`)
    const traverse = traverseByType(workDir, opened, env)
    env.pages = traverse.pages
    if (traverse.platform) env.platform = { id: traverse.platform.id, label: traverse.platform.label }
    if (traverse.iframe) env.iframe = traverse.iframe
    if (traverse.limitation) env.limitations = traverse.limitation

    log('[4/5] 汇总状态')
    const sum = summarize(env.pages)
    env.summary = sum.summary
    env.status = sum.status
    env.needLlm = sum.needLlm
    env.nextAction = NEXT_ACTIONS[sum.status] || ''
    env.capturedAt = new Date().toISOString()
    env.screenshotDir = 'prototype-work'

    log(`[5/5] 写结果文件 ${RESULT_FILENAME}`)
    fs.writeFileSync(path.join(workDir, RESULT_FILENAME), JSON.stringify(env, null, 2), 'utf8')
    env.resultFile = RESULT_FILENAME

    emitRunResult(env, opts)
    return sum.summary.failed > 0 ? 1 : 0
  } finally {
    // 主流程收尾（exit 钩子是第二重保险，见 collect.installFinishHooks）
    const f = collect.finish(workDir)
    log(`收尾: ${f.reason}`)
  }
}

/**
 * 按渲染类型分流遍历
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} opened - openAndProbe 的返回值
 * @param {object} env - 结果信封（读取 url/title）
 * @returns {{ pages: Array, platform: object|null, iframe: object|null, limitation: string }}
 */
function traverseByType (workDir, opened, env) {
  const type = opened.render.type

  if (type === RENDER_TYPES.C) {
    const ifr = collect.probeIframes(workDir)
    const platform = collect.identifyPlatform(workDir)

    if (!platform) {
      // LLM 介入点之一：认不出宿主平台
      // 只把**原型本体**的 iframe 放进 probe，避免广告 iframe 干扰判断
      return {
        pages: [{
          index: 1,
          name: env.title || '未识别的原型页面',
          namePinyin: toPinyin(env.title || 'unrecognized', 1),
          url: env.url,
          iframeSrc: ifr.primary ? ifr.primary.src : null,
          screenshot: null,
          screenshotOk: false,
          status: CAPTURE_STATUS.NEED_LLM,
          reason: 'host_platform_unrecognized',
          probe: { iframes: ifr.iframes, primary: ifr.primary, ads: ifr.ads, subtype: ifr.subtype, actionable: ifr.actionable },
          degradations: [],
          notes: [],
          fields: [],
          interactions: []
        }],
        platform: null,
        iframe: { subtype: ifr.subtype, actionable: ifr.actionable, primary: ifr.primary, ads: ifr.ads },
        limitation: ifr.actionable
      }
    }

    // 命中宿主平台 → 定向提取页面树
    const tree = collect.readPageTree(workDir, platform)
    const plan = probe.platformPlan(platform)
    const names = tree.names.length ? tree.names : ['首页']

    const pages = []
    for (let i = 0; i < names.length; i++) {
      log(`  采集第 ${i + 1}/${names.length} 页: ${names[i]}`)
      if (i > 0) {
        // 翻页：按页面名点击页面树节点
        const clicked = clickPageByName(workDir, platform, names[i], plan ? plan.canvasSelectors : [])
        if (!clicked) {
          pages.push(makeFailedPage(i + 1, names[i], 'click_no_effect'))
          continue
        }
      }
      pages.push(collect.collectPageFacts(workDir,
        { index: i + 1, name: names[i], pinyin: toPinyin(names[i], i + 1) },
        {
          width: opened.width,
          height: opened.height,
          needsResize: !!(plan && plan.needsResize),
          canvasSelectors: plan ? plan.canvasSelectors : [],
          renderType: type
        }))
    }

    let limitation = ''
    // 数量对不上两个方向都要报：少 = 漏页；多 = 幽灵页（如选择器串到了别的面板列表）
    if (tree.total && names.length !== tree.total) {
      limitation = names.length < tree.total
        ? `页面树声明 ${tree.total} 页，实际取到 ${names.length} 页，可能漏页`
        : `页面树声明 ${tree.total} 页，实际取到 ${names.length} 页，可能多收了非页面树节点（重复页）`
    }

    return { pages, platform, iframe: { subtype: ifr.subtype, actionable: ifr.actionable }, limitation }
  }

  // A / B 类：单页采集（通用遍历的菜单点击需语义判断 → 交 LLM 用 page 子命令补抓）
  const name = env.title || (type === RENDER_TYPES.B ? '画布页面' : '首页')
  const page = collect.collectPageFacts(workDir,
    { index: 1, name, pinyin: toPinyin(name, 1) },
    {
      width: opened.width,
      height: opened.height,
      needsResize: type === RENDER_TYPES.B,
      canvasSelectors: [],
      renderType: type
    })

  return {
    pages: [page],
    platform: null,
    iframe: null,
    limitation: type === RENDER_TYPES.B
      ? 'Canvas 渲染，字段只能来自截图识别'
      : 'A 类页面如需遍历多页菜单，由 LLM 用 page 子命令逐页补抓'
  }
}

/**
 * 按页面名点击页面树节点（Axure / 墨刀等）
 *
 * 两条路径（按可靠性排序）：
 *   1. **按页面名做 DOM 查找后点击**（首选）—— 用 eval 找到文本匹配的列表项，
 *      直接 `click` 其 CSS 路径。墨刀的页面项是 `li.rn-content-item`
 *      （**div，不在无障碍树里**，snapshot ref 找不到它）。
 *   2. **快照 ref**（回退）—— Axure 的页面名在无障碍树里有 ref。
 *
 * ⚠️ 不要拼 `?p=<页面名>` / `?screen=` URL 跳页：
 *   实测 Axure 的 `?p=` 会重新触发 `/jump?go=` 拦截流程并丢参数。
 *
 * ⚠️ 生效判定**不能只看 URL** —— 墨刀是前端换屏、URL 完全不变。
 *   用画布内容指纹比对（见 collect.canvasFingerprint）。
 *
 * @param {string} workDir - 固定 CWD
 * @param {object} platform - 平台定义
 * @param {string} pageName - 目标页面名
 * @param {string[]} canvasSelectors - 画布容器选择器
 * @returns {boolean} 是否成功点击并换页
 */
function buildTagExpr (selector, index) {
  const s = JSON.stringify(selector)
  return '() => { document.querySelectorAll("[data-pc-target]").forEach(e => e.removeAttribute("data-pc-target"));' +
    ' const el = document.querySelectorAll(' + s + ')[' + index + '];' +
    ' if (!el) return "miss"; el.setAttribute("data-pc-target", "1"); return "ok" }'
}

function clickPageByName (workDir, platform, pageName, canvasSelectors) {
  const plan = probe.platformPlan(platform)
  if (!plan) return false

  // 面板可能已重新折叠（Axure），先确认展开
  collect.tryExpandPanel(workDir, platform)

  const before = collect.canvasFingerprint(workDir, canvasSelectors)

  // 路径 1：按文本找列表项，直接点击其 CSS 路径
  const findByText = `() => { const out=[]; document.querySelectorAll(${JSON.stringify(plan.pageNameNode)}).forEach((el,i)=>{` +
    " const t=(el.innerText||'').trim();" +
    ' const lines=t.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean);' +
    ' const nm=lines.filter(l=>!/^\\d+$/.test(l)).pop() || lines[0] || "";' +
    ` if(nm === ${JSON.stringify(pageName)}) out.push(i) });` +
    ' return JSON.stringify(out) }'
  const found = runner.runCli(workDir, ['--json', 'eval', findByText])
  const idxs = Array.isArray(found.result) ? found.result : []

  if (idxs.length > 0) {
    const tagExpr = buildTagExpr(plan.pageNameNode, idxs[0])
    runner.runCli(workDir, ['--raw', 'eval', tagExpr])
    runner.runCli(workDir, ['click', '[data-pc-target="1"]'])
    collect.wait(workDir, 2500)
    const after = collect.canvasFingerprint(workDir, canvasSelectors)
    if (after && after !== before) return true
    // 内容未变也可能是「本就停在该页」（重复点击）—— 用 URL 变化兜底
    const urlRun = runner.runCli(workDir, ['--raw', 'eval', '() => location.href'])
    if (collect.stripRawQuotes(urlRun.stdout)) return true
  }

  // 路径 2：回退到快照 ref
  const snapName = 'page-nav.yml'
  runner.runCli(workDir, ['snapshot', `--filename=${snapName}`])
  let snapText = ''
  try { snapText = fs.readFileSync(path.join(workDir, snapName), 'utf8') } catch (e) { return false }

  const escaped = probe.escapeRegExp(pageName)
  const re = new RegExp(`[^\\n]*${escaped}[^\\n]*\\[ref=([^\\]]+)\\]`)
  const m = re.exec(snapText)
  if (!m) return false

  runner.runCli(workDir, ['click', m[1]])
  collect.wait(workDir, 2500)
  const after2 = collect.canvasFingerprint(workDir, canvasSelectors)
  return !!(after2 && after2 !== before)
}

/**
 * 构造一个失败页记录
 *
 * @param {number} index - 序号
 * @param {string} name - 页面名
 * @param {string} reason - 失败原因 key
 * @returns {object} 页面记录
 */
function makeFailedPage (index, name, reason) {
  return {
    index,
    name,
    namePinyin: toPinyin(name, index),
    url: '',
    iframeSrc: null,
    screenshot: null,
    screenshotOk: false,
    status: CAPTURE_STATUS.FAILED,
    reason,
    degradations: [],
    notes: [],
    fields: [],
    interactions: []
  }
}

/**
 * probe 子命令：只探测当前页（不翻页不截图）
 *
 * 供 LLM 在 run 返回 need_llm 时介入判断。
 *
 * @param {object} opts - 参数
 * @returns {number} 退出码
 */
function cmdProbe (opts) {
  const env = envelope('probe', {})
  if (!opts.workDir) {
    env.ok = false
    env.errors.push('缺少 --work-dir')
    emit(env)
    return 2
  }

  const metricsRun = runner.runCli(opts.workDir, ['--json', 'eval', probe.renderProbeExpression()])
  const urlRun = runner.runCli(opts.workDir, ['--raw', 'eval', '() => location.href'])

  env.url = collect.stripRawQuotes(urlRun.stdout)
  env.metrics = metricsRun.result
  env.render = probe.classifyRender(metricsRun.result)
  env.iframe = collect.probeIframes(opts.workDir)
  const platform = collect.identifyPlatform(opts.workDir)
  env.platform = platform ? { id: platform.id, label: platform.label } : null
  env.nextAction = env.render.type === RENDER_TYPES.C && !platform
    ? NEXT_ACTIONS[CAPTURE_STATUS.NEED_LLM]
    : ''

  emit(env)
  return 0
}

/**
 * page 子命令：补抓单页
 *
 * @param {object} opts - 参数
 * @returns {number} 退出码
 */
function cmdPage (opts) {
  const env = envelope('page', {})
  if (!opts.workDir || !opts.target || !opts.name) {
    env.ok = false
    env.errors.push('缺少 --work-dir / --target / --name')
    emit(env)
    return 2
  }

  const clicked = runner.runCli(opts.workDir, ['click', opts.target])
  if (!clicked.ok) {
    env.ok = false
    env.errors.push('点击目标失败: ' + collect.compactError(clicked))
    emit(env)
    return 1
  }
  collect.wait(opts.workDir, 2500)

  const index = Number(opts.index) || 1
  const page = collect.collectPageFacts(opts.workDir,
    { index, name: opts.name, pinyin: opts.pinyin || toPinyin(opts.name, index) },
    { width: VIEWPORT.pc.width, height: VIEWPORT.pc.height, needsResize: true, canvasSelectors: [], renderType: RENDER_TYPES.A })

  env.pages = [page]
  const sum = summarize(env.pages)
  env.summary = sum.summary
  env.status = sum.status
  env.nextAction = NEXT_ACTIONS[sum.status] || ''

  emit(env)
  return 0
}

/**
 * finish 子命令：幂等收尾
 *
 * @param {object} opts - 参数
 * @returns {number} 退出码
 */
function cmdFinish (opts) {
  const env = envelope('finish', {})
  if (!opts.workDir) {
    env.ok = false
    env.errors.push('缺少 --work-dir')
    emit(env)
    return 2
  }
  const f = collect.finish(opts.workDir)
  env.finished = f.ran
  env.reason = f.reason
  emit(env)
  return 0
}

/**
 * render 子命令：渲染材料
 *
 * @param {object} opts - 参数
 * @returns {number} 退出码
 */
function cmdRender (opts) {
  const env = envelope('render', {})
  if (!opts.result) {
    env.ok = false
    env.errors.push('缺少 --result')
    emit(env)
    return 2
  }

  let result
  try {
    result = JSON.parse(fs.readFileSync(opts.result, 'utf8'))
  } catch (e) {
    env.ok = false
    env.errors.push('读取 result 失败: ' + e.message)
    emit(env)
    return 2
  }

  const valid = render.validateResult(result)
  if (!valid.ok) {
    env.ok = false
    env.errors.push('result 结构不完整，缺字段: ' + valid.missing.join(', '))
    emit(env)
    return 1
  }

  const md = render.renderMaterial(result)
  if (opts.out) {
    fs.writeFileSync(opts.out, md, 'utf8')
    env.out = opts.out
    env.bytes = Buffer.byteLength(md, 'utf8')
  } else {
    process.stdout.write(md)
    return 0
  }

  emit(env)
  return 0
}

/**
 * 主入口
 */
function main () {
  const { command, opts, errors } = parseArgs(process.argv.slice(2))

  if (opts.version) {
    process.stdout.write(`capture.js ${SCHEMA_VERSION}\n`)
    return 0
  }
  if (opts.help || !command) {
    process.stdout.write(helpText() + '\n')
    return command ? 0 : 2
  }
  if (errors.length) {
    emit({ schemaVersion: SCHEMA_VERSION, command, ok: false, errors })
    return 2
  }

  switch (command) {
    case 'run': return cmdRun(opts)
    case 'probe': return cmdProbe(opts)
    case 'page': return cmdPage(opts)
    case 'finish': return cmdFinish(opts)
    case 'render': return cmdRender(opts)
    default:
      emit({ schemaVersion: SCHEMA_VERSION, command, ok: false, errors: [`未知子命令: ${command}`] })
      return 2
  }
}

// 作为 CLI 直接运行时才执行 main（被 require 时不执行，便于单测）
if (require.main === module) {
  let code = 0
  try {
    code = main()
  } catch (e) {
    log('未捕获异常: ' + (e && e.stack ? e.stack : e))
    code = 1
  } finally {
    process.exitCode = code
  }
}

module.exports = {
  RESULT_FILENAME,
  parseArgs,
  helpText,
  envelope,
  summarize,
  toPinyin,
  cmdRun,
  cmdProbe,
  cmdPage,
  cmdFinish,
  cmdRender,
  main,
  // 常量转发（供 SKILL.md 与测试单点引入）
  SCHEMA_VERSION,
  CAPTURE_STATUS,
  NON_FATAL_STATUS,
  MATERIAL_SECTIONS,
  NEXT_ACTIONS,
  HOST_PLATFORMS,
  RENDER_TYPES,
  IFRAME_SUBTYPES,
  DEGRADATION_KINDS,
  GATE_SIGNALS,
  A11Y_KEYWORDS,
  VIEWPORT
}
