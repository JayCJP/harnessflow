/**
 * render.js — 把 capture-result.json 渲染成 prototype-capture.md（纯函数，不碰浏览器）
 *
 * 职责:
 *   - 按 MATERIAL_SECTIONS 常量产出材料的四个必备章节
 *   - 「逐页事实」章节按「页面名 + 内嵌截图 + 说明原文（独立块）+ 该页事实表格」组织
 *   - 说明原文用独立 markdown 块（代码围栏）呈现，**保留原换行与缩进，不塞进表格**，
 *     避免长文本被表格转义（换行变空格、`|` 转义）后读起来不明显
 *   - 降级信息**两处呈现**：受影响页面的内联标记 + 末尾「局限与待确认」汇总
 *
 * 为什么与采集解耦:
 *   LLM 补抓若干页后只需重跑 render 重出材料，无需重开浏览器；
 *   同时 render 是唯一可纯单测（无浏览器）的部分。
 *
 * 依赖: ./constants（章节清单与降级文案的唯一信源）
 *
 * @module skills/prototype-capture/scripts/render
 */

const { SCHEMA_VERSION, CAPTURE_STATUS, MATERIAL_SECTIONS } = require('./constants')

/** 页面状态 → 表格里显示的短标签 */
const STATUS_LABEL = {
  [CAPTURE_STATUS.OK]: '完整',
  [CAPTURE_STATUS.PARTIAL]: '⚠️ 部分',
  [CAPTURE_STATUS.NEED_LLM]: '⚠️ 待判断',
  [CAPTURE_STATUS.FAILED]: '❌ 失败',
  [CAPTURE_STATUS.SKIPPED]: '⏭ 跳过'
}

/**
 * 渲染整份材料 markdown
 *
 * @param {object} result - capture-result.json 的内容
 * @returns {string} markdown 全文
 */
function renderMaterial (result) {
  const r = result || {}
  const pages = Array.isArray(r.pages) ? r.pages : []

  const parts = []
  parts.push(renderTitle(r))
  parts.push(renderMethod(r, pages))
  parts.push(renderPageList(pages))
  parts.push(renderPageFacts(pages, r))
  parts.push(renderLimitations(pages))

  return parts.filter(Boolean).join('\n\n') + '\n'
}

/**
 * 标题与元信息
 *
 * @param {object} r - result
 * @returns {string}
 */
function renderTitle (r) {
  const title = r.title || '未命名需求'
  const lines = [
    `# 原型抓取材料：${title}`,
    '',
    `> 由 \`capture.js\`（schemaVersion ${r.schemaVersion || SCHEMA_VERSION}）采集于 ${r.capturedAt || '未知时间'}`,
    `> 原型地址：${r.url || '未知'}`,
    `> 渲染类型：${describeRender(r)}`,
    '' // 末尾空行：避免与下一个 `##` 章节标题粘连
  ]
  return lines.join('\n')
}

/**
 * 用一句话描述渲染类型（含 C 子类与宿主平台）
 *
 * @param {object} r - result
 * @returns {string}
 */
function describeRender (r) {
  const t = (r.render && r.render.type) || '未知'
  const typeText = { a: 'A 类（DOM）', b: 'B 类（Canvas）', c: 'C 类（iframe）' }[t] || t
  const subtype = r.iframe && r.iframe.subtype ? `，${r.iframe.subtype.toUpperCase()}` : ''
  const platform = r.platform && r.platform.label ? `｜宿主平台：${r.platform.label}` : ''
  return `${typeText}${subtype}${platform}`
}

/**
 * 「原型抓取方法」章节
 *
 * @param {object} r - result
 * @param {Array} pages - 页面数组
 * @returns {string}
 */
function renderMethod (r, pages) {
  const notesSources = new Set()
  for (const p of pages) {
    for (const n of (p.notes || [])) {
      if (n && n.source) notesSources.add(describeSource(n.source))
    }
  }

  const degradedPages = pages.filter(p => (p.degradations || []).length > 0)
  const gateText = r.gate && r.gate.handled ? `已点掉 ${r.gate.rounds} 层拦截页` : '无拦截页'

  const rows = [
    ['渲染类型', describeRender(r), 'capture-result.json'],
    ['宿主平台', (r.platform && r.platform.label) || '未识别（需人工判断）', r.platform ? '脚本定向提取' : '脚本探测'],
    ['说明文字来源', notesSources.size ? [...notesSources].join(' + ') : '未找到说明', 'find + 通用探针'],
    ['前置拦截页', gateText, '脚本拦截页循环'],
    ['降级情况', degradedPages.length ? `${degradedPages.length} 页存在降级项（见各页标记）` : '无降级', '见各页 inlineNote'],
    ['抓取局限', r.limitations || '无', '脚本记录']
  ]

  return [
    '## 原型抓取方法',
    '',
    '| 项 | 内容 | 来源 |',
    '|---|---|---|',
    ...rows.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`)
  ].join('\n')
}

/**
 * 「页面清单」章节
 *
 * @param {Array} pages - 页面数组
 * @returns {string}
 */
function renderPageList (pages) {
  const lines = [
    '## 页面清单',
    '',
    '| 序号 | 页面名 | 截图 | 状态 | 关键功能点 |',
    '|---|---|---|---|---|'
  ]
  for (const p of pages) {
    const status = STATUS_LABEL[p.status] || p.status
    const shot = p.screenshot || '-'
    lines.push(`| ${p.index} | ${p.name || '-'} | ${shot} | ${status} | ${p.featurePoint || '-'} |`)
  }
  if (pages.length === 0) lines.push('| - | 未采集到任何页面 | - | - | - |')
  return lines.join('\n')
}

/**
 * 「逐页事实」章节 —— 每页一节 + 内嵌截图 + 该页事实
 *
 * 图文同处一节：需求分析师读一页即可看懂一页，不必来回跳。
 *
 * @param {Array} pages - 页面数组
 * @param {object} r - result
 * @returns {string}
 */
function renderPageFacts (pages, r) {
  if (pages.length === 0) {
    return ['## 逐页事实', '', '未采集到任何页面，无法产出逐页事实。'].join('\n')
  }

  // 截图相对 md 文件的路径：md 落 <storyDir>/，截图落 <storyDir>/prototype-work/
  const shotDir = r.screenshotDir || 'prototype-work'

  const blocks = pages.map(p => renderOnePage(p, shotDir))
  return ['## 逐页事实', '', blocks.join('\n\n---\n\n')].join('\n')
}

/**
 * 渲染单个页面的小节
 *
 * @param {object} p - 页面记录
 * @param {string} shotDir - 截图目录（相对 md 文件）
 * @returns {string}
 */
function renderOnePage (p, shotDir) {
  const lines = [`### ${p.index}. ${p.name || '未命名页面'}`, '']

  // 截图（图文同处一节）
  if (p.screenshot) {
    lines.push(`![${p.name || '页面'}](./${shotDir}/${p.screenshot})`)
    lines.push('')
  }

  // 内联降级标记（与末尾汇总章节共用同一文案，来自 constants）
  const inlineNotes = (p.degradations || []).map(d => d.inlineNote).filter(Boolean)
  if (inlineNotes.length > 0) {
    lines.push(`> ⚠️ ${inlineNotes.join('；')}。`)
    lines.push('')
  }

  // 说明原文：独立 markdown 块，保留原文换行与缩进，不塞进表格
  lines.push(renderNotesBlock(p))
  lines.push('')

  // 事实表格（只放短字段，说明原文已上移独立呈现）
  const rows = [
    ['页面地址', p.url || '-'],
    ['iframe 来源', p.iframeSrc || '-'],
    ['交互记录', renderInteractions(p)],
    ['字段提取', renderFields(p, inlineNotes)]
  ]
  lines.push('| 项 | 内容 |', '|---|---|')
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`)

  return lines.join('\n')
}

/**
 * 渲染该页的说明原文 —— 独立 markdown 块，逐条摘录、不加工
 *
 * 与旧实现（塞进表格单元格 + escapeCell 把换行变空格）不同：
 * 这里用四级标题「说明原文」+ 每条「来源：载体」小标 + 代码围栏承载正文，
 * 保留原文的换行与缩进（a./b./I./II. 等层级一目了然），也不会被表格转义破坏。
 *
 * @param {object} p - 页面记录
 * @returns {string}
 */
function renderNotesBlock (p) {
  const notes = (p.notes || []).filter(n => n && n.text)
  const header = '#### 说明原文'
  if (notes.length === 0) {
    return `${header}\n\n未找到说明文字`
  }
  const parts = notes.map(n => {
    const source = describeSource(n.source)
    return `**来源：${source}**\n\n\`\`\`text\n${n.text}\n\`\`\``
  })
  return `${header}\n\n${parts.join('\n\n')}`
}

/**
 * 渲染交互记录
 *
 * @param {object} p - 页面记录
 * @returns {string}
 */
function renderInteractions (p) {
  const list = (p.interactions || []).filter(Boolean)
  if (list.length === 0) return '无'
  return list
    .map(i => `${i.from || '?'} --${i.action || '点击'}--> ${i.to || '?'}`)
    .join('<br>')
}

/**
 * 渲染字段提取
 *
 * @param {object} p - 页面记录
 * @param {string[]} inlineNotes - 内联降级文案（用于标注字段来源）
 * @returns {string}
 */
function renderFields (p, inlineNotes) {
  const fields = (p.fields || []).filter(Boolean)
  if (fields.length === 0) {
    return inlineNotes.some(n => n.includes('截图'))
      ? '字段来自截图识别（见上方标记）'
      : '无'
  }
  const fromScreenshot = inlineNotes.some(n => n.includes('截图'))
  const source = fromScreenshot ? '截图识别' : 'DOM'
  return fields
    .map(f => {
      const bits = [f.name || f.tag || '未命名字段']
      if (f.type) bits.push(f.type)
      if (f.required) bits.push('必填')
      if (f.ph) bits.push(`placeholder「${f.ph}」`)
      return `${bits.join('｜')}｜来源：${source}`
    })
    .join('<br>')
}

/**
 * 「局限与待确认」章节（末尾汇总）
 *
 * 与逐页内联标记同源（都取 degradations），只是呈现粒度不同。
 *
 * @param {Array} pages - 页面数组
 * @returns {string}
 */
function renderLimitations (pages) {
  const rows = []
  for (const p of pages) {
    for (const d of (p.degradations || [])) {
      rows.push([p.index, p.name || '-', d.detail || d.inlineNote || '-', d.advice || '-'])
    }
  }

  const lines = ['## 局限与待确认', '']
  if (rows.length === 0) {
    lines.push('本次抓取未发现降级项。')
  } else {
    lines.push('| 页码 | 页面 | 局限 | 建议处理 |', '|---|---|---|---|')
    for (const [a, b, c, d] of rows) lines.push(`| ${a} | ${b} | ${escapeCell(c)} | ${escapeCell(d)} |`)
    lines.push('')
    lines.push('> 提醒：以上存疑项请需求分析师转为 `open-questions.json` 的**非 blocking** 待确认项。')
  }
  lines.push('')
  lines.push('> 本材料只呈现「看到了什么」，功能点归并、AC 推导、风险判断由需求分析师完成。')

  return lines.join('\n')
}

/**
 * 把内部来源标记转成人类可读的载体名
 *
 * 探针的 source 形如 `attr:notesPanel` / `anchor:说明` / `find:1`，
 * 直接 split(':')[0] 会只剩 `attr`（无意义）。这里映射成载体描述。
 *
 * @param {string} source - 内部来源标记
 * @returns {string} 人类可读载体名
 */
function describeSource (source) {
  const s = String(source || '')
  if (s.startsWith('find:')) return '关键词命中'
  if (s.startsWith('attr:')) return '说明面板'
  if (s.startsWith('anchor:')) return '画布批注'
  return s
}

/**
 * 转义表格单元格内容（避免 `|` 与换行破坏表格）
 *
 * @param {string} s - 原始文本
 * @returns {string}
 */
function escapeCell (s) {
  return String(s == null ? '' : s)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/**
 * 校验 result 是否含全部必备章节所需字段
 *
 * 供 capture.js 在渲染前自检，避免产出残缺材料。
 *
 * @param {object} result - capture-result.json
 * @returns {{ ok: boolean, missing: string[] }}
 */
function validateResult (result) {
  const missing = []
  const r = result || {}
  if (!r.schemaVersion) missing.push('schemaVersion')
  if (!Array.isArray(r.pages)) missing.push('pages')
  if (!r.render) missing.push('render')

  const pages = Array.isArray(r.pages) ? r.pages : []
  pages.forEach((p, i) => {
    if (!p || typeof p.index === 'undefined') missing.push(`pages[${i}].index`)
    if (!p || !p.name) missing.push(`pages[${i}].name`)
  })

  return { ok: missing.length === 0, missing }
}

module.exports = {
  renderMaterial,
  renderTitle,
  renderMethod,
  renderPageList,
  renderPageFacts,
  renderLimitations,
  validateResult,
  escapeCell,
  describeSource,
  STATUS_LABEL,
  MATERIAL_SECTIONS
}
