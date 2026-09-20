/**
 * constants.js — prototype-capture 的契约常量（**单一信源**）
 *
 * 职责:
 *   - 集中定义抓取结果的 JSON 契约、状态枚举、材料章节清单、降级提示文案、
 *     宿主平台特征表、说明文字关键词
 *   - 供 capture.js（采集/渲染）与 SKILL.md（文档）共同引用
 *
 * 为什么独立成文件:
 *   此前这些内容散在 SKILL.md 的「必备章节」表、「降级」表、references 的选择器表里，
 *   与脚本实现是两份信源 —— 改一处不改另一处就会出现「脚本返回 partial 但文档没写
 *   partial 怎么办」。收敛到本模块后，SKILL.md 只描述「何时调脚本、读什么字段」，
 *   不复述任何字段名与章节列表。同仓库 scripts/lib/phases.js 的 PHASE_ARTIFACTS
 *   是同一模式（产出物清单唯一信源）。
 *
 * 依赖: 零依赖（纯数据 + 纯函数，不 require 任何模块）
 *
 * @module skills/prototype-capture/scripts/constants
 */

/** 抓取结果 JSON 的契约版本。改字段结构时必须同步 bump。 */
const SCHEMA_VERSION = '1.0.0'

/**
 * 采集状态枚举（页面粒度与整体粒度共用）
 *
 * - `ok`       —— 该页事实采集完整
 * - `partial`  —— 采到了，但有降级项（说明缺失 / 字段来自截图识别）
 * - `need_llm` —— 脚本无法决策，必须由 LLM 介入（如宿主平台认不出）
 * - `failed`   —— 采集失败（点击无反应 / 页面报错）
 * - `skipped`  —— 主动跳过（链接失效 / 需登录）
 */
const CAPTURE_STATUS = {
  OK: 'ok',
  PARTIAL: 'partial',
  NEED_LLM: 'need_llm',
  FAILED: 'failed',
  SKIPPED: 'skipped'
}

/** 状态 → 是否算「本次抓取成功」（need_llm/partial 不算失败，材料仍产出） */
const NON_FATAL_STATUS = [CAPTURE_STATUS.OK, CAPTURE_STATUS.PARTIAL, CAPTURE_STATUS.NEED_LLM]

/**
 * 渲染类型枚举
 *
 * - `a`  —— DOM 有可读语义文本，走通用遍历
 * - `b`  —— canvas 主导且文本近乎空壳，只能靠截图识别
 * - `c`  —— 有 iframe，需再判 C 子类
 */
const RENDER_TYPES = {
  A: 'a',
  B: 'b',
  C: 'c'
}

/**
 * iframe（C 类）子类枚举
 *
 * - `c1` —— src 是真实 URL，可 goto 到本体
 * - `c2` —— src 是 about:blank/javascript:，同源动态写入，读 contentDocument
 * - `c3` —— src 真实 URL 但跨域，contentDocument 为 null，靠 snapshot/find 穿透
 */
const IFRAME_SUBTYPES = {
  C1: 'c1',
  C2: 'c2',
  C3: 'c3'
}

/**
 * 降级类型枚举（degradations[].kind）
 *
 * 每项自带 inlineNote —— 逐页内联标记与末尾汇总章节共用同一文案，
 * 避免「同一事实两处措辞不一致」。
 */
const DEGRADATION_KINDS = {
  NOTES_MISSING: {
    kind: 'notes_missing',
    inlineNote: '本页说明未找到',
    detail: '三轮关键词与通用探针均未命中说明文字',
    advice: '转 open-questions.json 非 blocking 项'
  },
  NOTES_CANVAS: {
    kind: 'notes_canvas',
    inlineNote: '说明为画布绘制，无法提取文本',
    detail: '说明文字是 Canvas 绘制，find 与探针均无效',
    advice: '需人工看截图确认，转 open-questions.json 非 blocking 项'
  },
  FIELD_FROM_SCREENSHOT: {
    kind: 'field_from_screenshot',
    inlineNote: '字段来自截图识别',
    detail: '页面 DOM 无字段语义（Canvas 渲染），字段名靠截图辨认',
    advice: '需用户确认字段名与校验规则'
  },
  SCREENSHOT_TRUNCATED: {
    kind: 'screenshot_truncated',
    inlineNote: '截图可能未覆盖全部内容',
    detail: '内容高于视口上限，已 resize 后仍可能有截断',
    advice: '需人工看截图确认是否遗漏页面下半部分'
  },
  CLICK_NO_EFFECT: {
    kind: 'click_no_effect',
    inlineNote: '本页跳转未生效',
    detail: '点击后 URL 与页面序号均未变化，可能点击未命中',
    advice: '该页内容可能归属其他页面，需人工核对'
  },
  PAGE_REQUIRES_LOGIN: {
    kind: 'page_requires_login',
    inlineNote: '本页要求登录',
    detail: '页面呈现登录墙，未采到任何原型内容',
    advice: '向用户索要截图'
  }
}

/**
 * 材料（prototype-capture.md）必备章节清单 —— **缺一即未完成**
 *
 * 这是 SKILL.md「必备章节」表的唯一信源；文档里不再复述本表。
 * `render: true` 的章节由 renderMaterial 自动产出，`render: false` 的由 LLM 补充。
 */
const MATERIAL_SECTIONS = [
  {
    key: 'method',
    title: '原型抓取方法',
    render: true,
    description: '渲染类型(A/B/C 及子类)、宿主平台、说明文字来源、降级情况汇总'
  },
  {
    key: 'page-list',
    title: '页面清单',
    render: true,
    description: '序号 / 中文页面名 / 截图文件名 / 状态 / 关键功能点'
  },
  {
    key: 'page-facts',
    title: '逐页事实',
    render: true,
    description: '每页独立小节：页面名 + 内嵌全页截图 + 该页说明原文/交互记录/字段提取'
  },
  {
    key: 'limitations',
    title: '局限与待确认',
    render: true,
    description: '逐条列抓不到的部分，提醒需求分析师转 open-questions.json 非 blocking 项'
  }
]

/**
 * 状态 → 给 LLM 的下一步提示文案
 *
 * 取代 SKILL.md 原有的「抓不到时的降级」8 行表格。
 * 脚本在 JSON 输出的 nextAction 字段里直接带上本表文案，LLM 不必查文档。
 */
const NEXT_ACTIONS = {
  [CAPTURE_STATUS.OK]: '无需介入，材料已可用。',
  [CAPTURE_STATUS.PARTIAL]: '读该页的 degradations 字段，按 advice 决定是否需要人工确认；材料仍可正常产出。',
  [CAPTURE_STATUS.NEED_LLM]: '脚本无法识别该站点结构：请读 probe 字段判断渲染类型，必要时用 `capture page` 指定选择器补抓，或向用户索要截图。',
  [CAPTURE_STATUS.FAILED]: '该页采集失败：先读 errorLayer 与 error 判断原因（CLI 层 / 业务层 / spawn 层），再决定重试或如实记录。',
  [CAPTURE_STATUS.SKIPPED]: '该页被跳过（链接失效或需登录），如实写进材料，禁止编造内容。'
}

/**
 * 前置拦截页识别信号
 *
 * 托管平台（产品大牛等）在原型前插一层反诈/免责/年龄确认页，
 * 不点掉只会把声明文字当成需求输入。
 *
 * urlFragments: URL 里出现即疑似拦截页
 * buttonTexts:  页面上出现这些按钮文案即为入口
 */
const GATE_SIGNALS = {
  urlFragments: ['/jump?go=', '/verify', '/notice'],
  buttonTexts: ['知道了', '进入查看', '我同意', '继续', '同意并继续', '确定进入'],
  maxRounds: 3
}

/**
 * 宿主平台特征表（**唯一预期会被增长的表**）
 *
 * 识别到特征即走定向提取（比通用遍历准）；认不出返回 null → 交 LLM 判断。
 * 新增平台时只改本表，SKILL.md 不必复述任何选择器。
 *
 * 注意: 本表只描述「怎么找到页面清单与页面名节点」，不含任何命令行 ——
 * 命令由 capture.js 统一拼装（见 runCli）。
 *
 * ⚠️ 第三方广告 iframe（如 360 的 `mediav1130.html` / `union.360.cn/proxy.html`）
 * 会混在 iframe 列表里，**它们不是原型本体**。判定原型 iframe 时用 `iframeSelector`
 * 或「首个同源且 src 为空」的规则，不要盲取 iframes[0] 之外的东西。
 */
const HOST_PLATFORMS = [
  {
    id: 'axure-player',
    label: 'Axure 播放器',
    // 命中任一 selector 即认定
    selectors: ['#sitemapTreeContainer', '.sitemapPageName', '.sitemapPageLink'],
    // 页面树容器与页面名节点
    treeContainer: '#sitemapTreeContainer',
    pageNameNode: '.sitemapPageName',
    // 页面树面板默认折叠，取清单前必须先点开
    panelToggleText: 'Project Pages',
    // 壳文本里的总页数线索，形如 (1 of 7)
    totalPagesPattern: '\\((\\d+)\\s+of\\s+(\\d+)\\)',
    // href 常为 null，只能 click 页面名的 ref 翻页
    pageLinkHrefReliable: false,
    // 播放器是固定视高应用，--full-page 覆盖不到内部画布
    needsResizeForFullPage: true,
    canvasSelectors: ['.rResCanvas', '.zoom-area', '.screen-container']
  },
  {
    id: 'modao',
    label: '墨刀',
    // 实测（2026-09，modao.cc/proto/.../sharing）：页面树容器 #screen_list，
    // 页面项 li.rn-content-item，画布容器 #canvas（class 含 CanvasContainer__）
    selectors: ['#screen_list', '#left-slide-panel', '.rn-content-item', '#canvas'],
    treeContainer: '#screen_list',
    // 页面名节点：列表项（内含序号 + 页面名两行）
    pageNameNode: 'li.rn-content-item',
    // 墨刀面板默认展开，无需点击
    panelToggleText: null,
    // 总页数字段形如「画布（1）」/「画布(3)」
    totalPagesPattern: '画布[（(](\\d+)[）)]',
    pageLinkHrefReliable: false,
    needsResizeForFullPage: true,
    canvasSelectors: ['#canvas', '.zoom-area', '.screen-container']
  }
]

/**
 * 说明文字采集关键词（三轮，按优先级）
 *
 * 说明面板标题未必叫「说明」，一轮不中就要换关键词再找一轮。
 * 三轮全空才判「未找到说明文字」。
 */
const A11Y_KEYWORDS = [
  '说明|备注|批注|标注|注释|交互说明|Notes?|Annotations?',
  '校验|规则|逻辑|限制|条件',
  '需求|背景|提示|文案|交互|流程'
]

/**
 * 说明文字通用探针的匹配模式（id/class 命中即候选）
 *
 * 与 A11Y_KEYWORDS 分开：前者匹配**文本内容**，本模式匹配**属性名**。
 */
const NOTES_ATTR_PATTERN = '(note|annotat|comment|remark|mark|desc|说明|备注|批注|标注|注释)'

/** 纯文本锚点的最大长度（超过则不是面板标题而是正文） */
const NOTES_ANCHOR_MAX_LEN = 12

/** 视口尺寸约定 */
const VIEWPORT = {
  pc: { width: 1920, height: 1080 },
  h5: { width: 375, height: 812 }
}

/** 播放器类原型 resize 时的页头补偿高度（像素） */
const PLAYER_HEADER_HEIGHT = 100

/** 视口高度上限，防止 resize 到异常值 */
const MAX_VIEWPORT_HEIGHT = 20000

/** 异步渲染等待时长（毫秒） */
const WAIT = {
  afterOpen: 3000,
  afterClick: 2500,
  afterResize: 2000,
  afterGateClick: 2500
}

module.exports = {
  SCHEMA_VERSION,
  CAPTURE_STATUS,
  NON_FATAL_STATUS,
  RENDER_TYPES,
  IFRAME_SUBTYPES,
  DEGRADATION_KINDS,
  MATERIAL_SECTIONS,
  NEXT_ACTIONS,
  GATE_SIGNALS,
  HOST_PLATFORMS,
  A11Y_KEYWORDS,
  NOTES_ATTR_PATTERN,
  NOTES_ANCHOR_MAX_LEN,
  VIEWPORT,
  PLAYER_HEADER_HEIGHT,
  MAX_VIEWPORT_HEIGHT,
  WAIT
}
