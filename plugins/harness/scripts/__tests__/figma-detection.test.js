#!/usr/bin/env node
/**
 * Figma 分模式判定回归测试
 *
 * 覆盖 2026-08 的 Figma 改造：
 *   1. hasFigmaDesign 从 story-input.json 的 sources.figmaUrls 自动推导
 *      （原先只来自 --figma flag，而唯一入口 harness-workflow.js 硬编码 false，
 *       导致三道 Figma 门控在正常流程下永不触发）
 *   2. run 开硬门控 / fixbugs 关硬门控 / --figma 任何模式强制开
 *   3. 两种模式都注入 figma-to-component-map 解析指引（软约束始终在）
 *   4. --refresh-input 在 story-input.json 后写场景下回填判定
 *
 * 无外部依赖，用一个临时的 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/figma-detection.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前设好，PLANS_DIR 是模块加载期求值的 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-figma-'))
process.env.CLAUDE_PROJECT_DIR = SANDBOX
fs.mkdirSync(path.join(SANDBOX, '.codebuddy', 'plans'), { recursive: true })

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { buildAgentPrompt } = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const { createWorkflow, refreshStoryInput } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))

let pass = 0
const failures = []

function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

function section (title) {
  console.log(`\n-- ${title} --`)
}

const storyDir = id => path.join(SANDBOX, '.codebuddy', 'plans', id)

function writeInput (id, obj) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'story-input.json'), JSON.stringify(obj, null, 2))
}

const FIGMA_URL = 'https://www.figma.com/design/AbC123/订单中心?node-id=12-345'

/** run / fixbugs 共用的 sources 骨架，只在 figmaUrls 上做变量 */
function inputWithFigma (mode, urls) {
  return { mode, sources: { text: '需求描述', figmaUrls: urls } }
}

// ════════════════════════════════════════════════════════════
section('1. run 模式 + figmaUrls -> 硬门控开启')

writeInput('FG-RUN', inputWithFigma('run', [FIGMA_URL]))
const runFigma = createWorkflow('FG-RUN', '带 Figma 的新功能', false, false, 'run')
ok('createWorkflow 成功', runFigma.success !== false, JSON.stringify(runFigma.errors))
ok('run + figmaUrls -> hasFigmaDesign=true', runFigma.hasFigmaDesign === true, String(runFigma.hasFigmaDesign))

const runState = state.readStateFile('FG-RUN')
ok('状态文件落盘 hasFigmaDesign=true', runState.hasFigmaDesign === true)
ok('落盘判定依据可排查', typeof runState.hasFigmaDesignReason === 'string' && runState.hasFigmaDesignReason.length > 0,
  runState.hasFigmaDesignReason)
ok('依据提到链接数量', /1 个 Figma/.test(runState.hasFigmaDesignReason), runState.hasFigmaDesignReason)

// ════════════════════════════════════════════════════════════
section('2. run 模式无 figmaUrls -> 硬门控关闭')

writeInput('FG-RUN-NONE', { mode: 'run', sources: { text: '纯文字需求' } })
const runNone = createWorkflow('FG-RUN-NONE', '无设计稿', false, false, 'run')
ok('无 figmaUrls -> hasFigmaDesign=false', runNone.hasFigmaDesign === false, String(runNone.hasFigmaDesign))

writeInput('FG-RUN-EMPTY', inputWithFigma('run', []))
ok('figmaUrls=[] -> false',
  createWorkflow('FG-RUN-EMPTY', '空数组', false, false, 'run').hasFigmaDesign === false)

writeInput('FG-RUN-BLANK', inputWithFigma('run', ['   ', '']))
ok('figmaUrls 全空白 -> false',
  createWorkflow('FG-RUN-BLANK', '空白链接', false, false, 'run').hasFigmaDesign === false)

// ════════════════════════════════════════════════════════════
section('3. fixbugs 模式 + figmaUrls -> 硬门控关闭')

writeInput('FG-FIX', inputWithFigma('fixbugs', [FIGMA_URL]))
const fixFigma = createWorkflow('FG-FIX', 'Bug 修复带设计稿', false, false, 'fixbugs')
ok('fixbugs + figmaUrls -> hasFigmaDesign=false', fixFigma.hasFigmaDesign === false, String(fixFigma.hasFigmaDesign))
ok('依据说明为何关闭', /fixbugs/.test(state.readStateFile('FG-FIX').hasFigmaDesignReason),
  state.readStateFile('FG-FIX').hasFigmaDesignReason)

// ════════════════════════════════════════════════════════════
section('4. --figma 手工覆盖（任何模式强制开）')

writeInput('FG-FLAG-RUN', { mode: 'run', sources: { text: '无链接但手工开' } })
ok('run + --figma 无链接也开',
  createWorkflow('FG-FLAG-RUN', '手工开门控', false, true, 'run').hasFigmaDesign === true)

writeInput('FG-FLAG-FIX', inputWithFigma('fixbugs', [FIGMA_URL]))
const flagFix = createWorkflow('FG-FLAG-FIX', 'fixbugs 手工开', false, true, 'fixbugs')
ok('fixbugs + --figma -> 覆盖模式默认值', flagFix.hasFigmaDesign === true, String(flagFix.hasFigmaDesign))
ok('依据标明手工指定', /--figma/.test(state.readStateFile('FG-FLAG-FIX').hasFigmaDesignReason))

// ════════════════════════════════════════════════════════════
section('5. bypass 跳过 Phase 0-1 -> 门控无意义')

writeInput('FG-BYPASS', inputWithFigma('run', [FIGMA_URL]))
const byp = createWorkflow('FG-BYPASS', 'hotfix 带设计稿', true, false, 'run')
ok('bypass + figmaUrls -> hasFigmaDesign=false', byp.hasFigmaDesign === false, String(byp.hasFigmaDesign))
ok('bypass 仍直接进 Phase 2', byp.phase === 2, String(byp.phase))

// ════════════════════════════════════════════════════════════
section('6. detectFigmaSource 边界与容错')

const noInput = state.detectFigmaSource('FG-NOT-EXIST')
ok('story-input 不存在 -> hasFigma=false', noInput.hasFigma === false)
ok('不存在时 urls 为空数组', Array.isArray(noInput.urls) && noInput.urls.length === 0)

fs.mkdirSync(storyDir('FG-BAD'), { recursive: true })
fs.writeFileSync(path.join(storyDir('FG-BAD'), 'story-input.json'), '{ 坏 JSON')
const badInput = state.detectFigmaSource('FG-BAD')
ok('坏 JSON -> hasFigma=false 不抛异常', badInput.hasFigma === false, badInput.reason)
ok('坏 JSON -> reason 说明解析失败', /解析失败|不存在/.test(badInput.reason), badInput.reason)

writeInput('FG-DETECT', inputWithFigma('run', [FIGMA_URL, 'https://www.figma.com/design/XyZ/详情页']))
const detected = state.detectFigmaSource('FG-DETECT')
ok('多链接全部保留', detected.urls.length === 2, JSON.stringify(detected.urls))
ok('多链接 -> hasFigma=true', detected.hasFigma === true)

// ════════════════════════════════════════════════════════════
section('7. prompt 注入 figma-to-component-map（两种模式都注入）')

const runPrompt = buildAgentPrompt({ storyId: 'FG-RUN', targetPhase: 0 }).agentPrompt
ok('run P0 点名 figma-to-component-map', runPrompt.includes('figma-to-component-map'))
ok('run P0 含 Figma 链接原文', runPrompt.includes(FIGMA_URL))
ok('run P0 要求产出 frame 清单', runPrompt.includes('figma-frame-inventory.json'))
ok('run P0 标注门控已开启', /已开启 Figma 门控/.test(runPrompt))
ok('run P0 声明桌面端前置条件', /桌面端/.test(runPrompt))

const fixPrompt = buildAgentPrompt({ storyId: 'FG-FIX', targetPhase: 0 }).agentPrompt
ok('fixbugs P0 同样点名 skill', fixPrompt.includes('figma-to-component-map'))
ok('fixbugs P0 标注未开强制门控', /未开启 Figma 强制门控/.test(fixPrompt))
ok('fixbugs P0 不误报门控开启', !/已开启 Figma 门控/.test(fixPrompt))

const noFigmaPrompt = buildAgentPrompt({ storyId: 'FG-RUN-NONE', targetPhase: 0 }).agentPrompt
ok('无链接 -> 不注入 Figma 段落', !noFigmaPrompt.includes('figma-to-component-map'))

// --figma 手工开门控但 story-input 无链接: 不该凭空注入解析指令
const flagOnlyPrompt = buildAgentPrompt({ storyId: 'FG-FLAG-RUN', targetPhase: 0 }).agentPrompt
ok('--figma 但无链接 -> 仍不注入解析指令', !flagOnlyPrompt.includes('figma-to-component-map'))

// ════════════════════════════════════════════════════════════
section('8. --refresh-input 回填（story-input.json 后写场景）')

// 真实时序: harness-workflow.js Step 1A 先建流程（此时无 story-input.json），
// 主 Agent Step 1B 才写入 —— 复现这个顺序
const late = createWorkflow('FG-LATE', '后写输入', false, false, 'run')
ok('建流程时无输入 -> 门控关闭', late.hasFigmaDesign === false, String(late.hasFigmaDesign))
ok('建流程时无输入 -> 保守要求原型', late.prototypeRequired === true, String(late.prototypeRequired))

writeInput('FG-LATE', inputWithFigma('run', [FIGMA_URL]))
const beforeRefresh = state.readStateFile('FG-LATE')
const refreshed = refreshStoryInput('FG-LATE')
ok('refresh 成功', refreshed.success === true, JSON.stringify(refreshed.errors))
ok('refresh 后 hasFigmaDesign=true', refreshed.hasFigmaDesign === true, String(refreshed.hasFigmaDesign))
ok('refresh 落盘生效', state.readStateFile('FG-LATE').hasFigmaDesign === true)

// 相位跃迁仍归 advance-phase.js 独有，refresh 不得越权
const lateState = state.readStateFile('FG-LATE')
ok('refresh 不改 phase', lateState.phase === late.phase, `${lateState.phase} vs ${late.phase}`)
ok('refresh 不改 status', lateState.status === beforeRefresh.status,
  `${lateState.status} vs ${beforeRefresh.status}`)

// fixbugs 后写输入: 回填后门控仍应关闭
const lateFix = createWorkflow('FG-LATE-FIX', '后写输入-修复', false, false, 'fixbugs')
ok('fixbugs 建流程门控关闭', lateFix.hasFigmaDesign === false)
writeInput('FG-LATE-FIX', inputWithFigma('fixbugs', [FIGMA_URL]))
ok('fixbugs refresh 后仍关闭', refreshStoryInput('FG-LATE-FIX').hasFigmaDesign === false)
ok('fixbugs refresh + --figma 强制开', refreshStoryInput('FG-LATE-FIX', true).hasFigmaDesign === true)

const missing = refreshStoryInput('FG-NO-WORKFLOW')
ok('工作流不存在 -> 失败且给出原因', missing.success === false && missing.errors.length > 0,
  JSON.stringify(missing))

// ════════════════════════════════════════════════════════════
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true })
} catch (e) { /* 清理失败不影响结论 */ }

const total = pass + failures.length
console.log(`\n${'='.repeat(48)}`)
if (failures.length === 0) {
  console.log(`通过 ${pass} / ${total}   [全绿]`)
  process.exit(0)
} else {
  console.log(`通过 ${pass} / ${total}\n失败项:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
