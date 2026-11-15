#!/usr/bin/env node
/**
 * fixbugs 模式回归测试
 *
 * 覆盖 2026-08 的 fixbugs 改造：
 *   1. 不再无条件写入空的 prototype-analysis.md（原型按需判定）
 *   2. Bug 分析下沉到 Phase 0 需求分析师，主 Agent 只搬参数
 *   3. Bug 报告只记事实，修复方案归 Phase 2 开发工程师
 *
 * 无外部依赖，用一个临时的 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/fixbugs-regression.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前建好，两个环境变量都要覆盖（原因见 _helpers.js 头注释）──
const sandbox = makeSandbox('harness-fixbugs-')
const storyDir = sandbox.storyDir

const state = require(path.join(SCRIPTS_DIR, 'lib/state'))
const { buildAgentPrompt } = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))
const { createWorkflow } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))
const policy = require(path.join(SCRIPTS_DIR, 'services/policy'))
const { runGateCheck } = policy
const { dispatch } = require(path.join(SCRIPTS_DIR, 'commands/dispatch'))

function writeInput (id, obj) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'story-input.json'), JSON.stringify(obj, null, 2))
}

function writeReport (id, body) {
  fs.writeFileSync(path.join(storyDir(id), '测试需求_bug分析报告.md'), body)
}

function writeBugList (id, obj) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'bug-list.json'), JSON.stringify(obj, null, 2))
}
/**
 * 写一个 Phase 0 的 e2e-state.json（run 模式反例用）
 * @param {string} id - Story ID
 */
function writeState0 (id) {
  fs.mkdirSync(storyDir(id), { recursive: true })
  fs.writeFileSync(path.join(storyDir(id), 'e2e-state.json'),
    JSON.stringify({ storyId: id, phase: 0, status: 'running' }))
}

function readReport (id) {
  return fs.readFileSync(path.join(storyDir(id), '测试需求_bug分析报告.md'), 'utf-8')
}

/**
 * 跑生效门控（policy.js runGateCheck，与 advance-phase.js 调用同一入口）
 * @param {string} id - Story ID
 * @param {number} phase - 来源 Phase（检查 phase → phase+1 的推进）
 * @returns {Object} { passed, blockers, warnings, recoveries, _meta }
 */
function gate (id, phase) {
  return runGateCheck(id, phase, state.readStateFile(id))
}

const COMPLIANT_REPORT = `# 测试需求 Bug 分析报告

> 本报告只记录事实，不含修复方案。修复方案由 Phase 2 开发工程师设计。

## 1. 概览
共 2 个 Bug。

## 2. Bug 明细
### Bug #1 首页崩溃
#### 现象
点击后白屏。
#### 复现步骤
1. 打开首页
2. 点击按钮
#### 代码定位
src/views/Home.vue:42
#### 根因
userInfo 在 onMounted 前被 computed 读取，此时为 undefined。

## 4. 优先级排序
Bug #1 > Bug #2
`

// ════════════════════════════════════════════════════════════
section('1. fixbugs 建流程不写原型存根')

writeInput('FIX-1', {
  mode: 'fixbugs',
  storyId: 'FIX-1',
  title: '测试需求',
  sources: {
    tapdUrl: 'https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944001',
    workspaceId: '10109441',
    owner: '小明',
    statusFilter: '待解决'
  }
})

const r1 = createWorkflow('FIX-1', '测试需求', false, false, 'fixbugs')
ok('createWorkflow 成功', r1.success !== false, JSON.stringify(r1.errors))
ok('state.mode = fixbugs', r1.mode === 'fixbugs', r1.mode)
ok('prototypeRequired = false', r1.prototypeRequired === false, String(r1.prototypeRequired))

const files1 = fs.readdirSync(storyDir('FIX-1'))
ok('无 prototype-analysis.md 存根', !files1.some(f => f.includes('prototype-analysis')), files1.join(','))
ok('getStoryMode = fixbugs', state.getStoryMode('FIX-1') === 'fixbugs')

// ════════════════════════════════════════════════════════════
section('2. fixbugs Phase 0->1 门控（policy.js 生效路径）')

// 文档化行为（references/phases/phase-0.md）：Bug 报告存在性不设门控，
// 缺报告的后果是后续 Phase 拿不到事实（由 expectedOutputs 要求产出），而非被阻断
const g1 = gate('FIX-1', 0)
ok('缺 Bug 报告 -> 不阻断（无 bug 报告相关 blocker）',
  !g1.blockers.some(b => /bug分析报告/i.test(typeof b === 'string' ? b : (b.message || ''))))
ok('门控不检查原型文档',
  !g1.blockers.some(b => /prototype-analysis/i.test(typeof b === 'string' ? b : (b.message || ''))))

writeReport('FIX-1', COMPLIANT_REPORT)
const g2 = gate('FIX-1', 0)
ok('合规报告 -> 无越界警告',
  !g2.warnings.some(w => /修复建议|解决方案|测试验证/.test(w)))

// 越界内容必须写成标题行 —— 门控只扫标题，避免正文里的根因描述误报
writeReport('FIX-1', readReport('FIX-1') +
  '\n#### 修复建议\n把初始化移到 created。\n\n#### 测试验证\n回归首页。\n')
const g3 = gate('FIX-1', 0)
ok('越界标题 -> 出警告（warning 级）',
  g3.warnings.some(w => /修复建议/.test(w) && /只记录事实|修复设计属于/.test(w)))
ok('越界仅警告，不阻断',
  !g3.blockers.some(b => /bug分析报告|修复建议/i.test(typeof b === 'string' ? b : (b.message || ''))))

// ════════════════════════════════════════════════════════════
section('2b. bug-list.json 门控（fixbugs 新增契约）')

// 缺清单 -> BLOCKER（人读报告文件名含动态标题，程序读不到，必须靠固定文件名兜住）
const gb0 = gate('FIX-1', 0)
ok('缺 bug-list.json -> BLOCKER bug_list_missing',
  gb0.blockers.some(b => b.type === 'bug_list_missing'))

writeBugList('FIX-1', { bugs: [] })
const gb1 = gate('FIX-1', 0)
ok('bugs 为空 -> BLOCKER bug_list_empty', gb1.blockers.some(b => b.type === 'bug_list_empty'))

writeBugList('FIX-1', { bugs: [{ bugId: '1218765', title: '会话窗口缺少草稿标识', status: 'new' }] })
const gb2 = gate('FIX-1', 0)
ok('缺 category -> BLOCKER bug_list_missing_category',
  gb2.blockers.some(b => b.type === 'bug_list_missing_category'))

writeBugList('FIX-1', { bugs: [{ bugId: '1218765', title: '会话窗口缺少草稿标识', status: 'new', category: 'frontend', commentCount: 3, commentDigest: '仅在 PC 端复现' }] })
const gb3 = gate('FIX-1', 0)
ok('合规清单 -> 无 bug-list 相关 blocker',
  !gb3.blockers.some(b => String(b.type || '').startsWith('bug_list')))
ok('合规清单 -> 无未读评论 warning', !gb3.warnings.some(w => /未读|get_comments/.test(w)))

writeBugList('FIX-1', { bugs: [{ bugId: '1218790', title: '列表不显示草稿态', status: 'new', category: 'backend' }] })
const gb4 = gate('FIX-1', 0)
ok('无评论证据 -> 仅 WARNING 不阻断',
  !gb4.blockers.some(b => String(b.type || '').startsWith('bug_list')) &&
  gb4.warnings.some(w => /get_comments/.test(w)))

// run 模式不受影响
ok('run 模式不校验 bug-list', !gate('RUN-1', 0).blockers.some(b => String(b.type || '').startsWith('bug_list')))

// ════════════════════════════════════════════════════════════
section('2b-2. 本轮无缺陷 -> 结束工作流（dispatch 转 terminal）')

// 场景: fixbugs 建流后 Phase 0 查 TAPD 一条都没命中，分析员按事实写空数组。
// 门控仍需拦推进（否则会带着 0 条 AC 进 Phase 1），但 dispatch 不派单 —— 直接收工。
writeBugList('FIX-1', { bugs: [] })
const gbEmpty = gate('FIX-1', 0)
ok('空清单仍拦推进（bug_list_empty）', gbEmpty.blockers.some(b => b.type === 'bug_list_empty'))
ok('isNoBugsOutcome 识别空清单 blocker', gbEmpty.blockers.filter(b => policy.isNoBugsOutcome(b)).length === 1)
ok('isNoBugsOutcome 不误判其它 blocker',
  policy.isNoBugsOutcome({ type: 'bug_list_missing_category' }) === false &&
  policy.isNoBugsOutcome({ type: 'artifact_missing' }) === false)

const dNoBugs = dispatch('FIX-1')
ok('无缺陷 -> status=terminal', dNoBugs.status === 'terminal', dNoBugs.status)
ok('无缺陷 -> recovery.type=no_bugs_matched', dNoBugs.recovery && dNoBugs.recovery.type === 'no_bugs_matched',
  JSON.stringify(dNoBugs.recovery))
ok('无缺陷 -> 不派单（nextAgent / agentPrompt 为空）',
  dNoBugs.nextAgent === null && dNoBugs.agentPrompt === null)
ok('无缺陷 -> 不给推进命令', dNoBugs.advanceCommand === null)
ok('无缺陷 -> 结束命令是 harness-workflow end',
  /harness-workflow\.js"?\s+end/.test(String(dNoBugs.recovery.command)), dNoBugs.recovery.command)
ok('无缺陷 -> 结束命令为绝对路径且正斜杠',
  /[A-Za-z]:\//.test(String(dNoBugs.recovery.command)) && !String(dNoBugs.recovery.command).includes('\\'),
  dNoBugs.recovery.command)

// 反例: 清单缺失（分析员压根没写）仍应派单重做，不能被当成「本轮无缺陷」收工
fs.unlinkSync(path.join(storyDir('FIX-1'), 'bug-list.json'))
const dMissing = dispatch('FIX-1')
ok('清单缺失 -> 仍派单 Phase 0（不误判为无缺陷收工）',
  dMissing.status === 'ready' && dMissing.nextAgent === 'requirement-analyst',
  dMissing.status + '/' + dMissing.nextAgent)

// 反例: run 模式空清单不触发收工（bug-list 是 fixbugs 专有产出物）
writeState0('RUN-EMPTY')
fs.writeFileSync(path.join(storyDir('RUN-EMPTY'), 'story-input.json'), JSON.stringify({ mode: 'run', sources: {} }))
writeBugList('RUN-EMPTY', { bugs: [] })
ok('run 模式不受空清单影响', !['terminal'].includes(dispatch('RUN-EMPTY').status) ||
  dispatch('RUN-EMPTY').recovery.type !== 'no_bugs_matched')

// ════════════════════════════════════════════════════════════
section('2c. 前端缺陷排期覆盖（Phase 1→2）')
// ════════════════════════════════════════════════════════════
section('3. fixbugs prompt 注入')

const p0 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 0 })
ok('storyMode = fixbugs', p0.storyMode === 'fixbugs')
// P0-2: story-input.json 路径为动态解析的绝对路径（PLANS_DIR 推导），不再给相对路径
ok('P0 给出 story-input.json 路径（不内联原文，优化上下文）', /story-input\.json/.test(p0.agentPrompt) && /读取 [A-Za-z]:[\\/].*story-input\.json/.test(p0.agentPrompt) && !/读取 \.codebuddy\/plans\//.test(p0.agentPrompt))
ok('P0 含自行调 skill 指引', p0.agentPrompt.includes('tapd-bug-analyzer'))
ok('P0 含「不写修复方案」', /不要写修复方案|不写修复方案|只记录事实|只记事实/.test(p0.agentPrompt))
// expectedOutputs 是主 Agent 校验子 Agent 产出物汇报的依据，
// 只进 expectedDescriptions（prompt 文字）会导致漏检 —— 见 harness/SKILL.md
ok('P0 expectedOutputs 含 bug分析报告', JSON.stringify(p0.expectedOutputs).includes('bug分析报告'))
ok('P0 产出要求文字含 bug分析报告', p0.agentPrompt.includes('bug分析报告'))
// bug-list.json 是 fixbugs 专属必需产出物，必须进 expectedOutputs（主 Agent 靠它校验汇报）
ok('P0 expectedOutputs 含 bug-list.json', p0.expectedOutputs.includes('bug-list.json'))
ok('P0 产出要求文字含 bug-list.json', p0.agentPrompt.includes('bug-list.json'))

const p1 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 1 })
ok('P1 不重复注入 story-input 原文', !p1.agentPrompt.includes('"tapdUrl"'))
ok('P1 给出 Bug 报告文件路径', /测试需求_bug分析报告\.md/.test(p1.agentPrompt) && /请读取/.test(p1.agentPrompt))
// 路径化而非内联：报告正文的特征串（根因描述）不应出现在 prompt 里
ok('P1 不内联报告正文', !p1.agentPrompt.includes('userInfo 在 onMounted 前被 computed 读取'))

// v3 token 优化：报告只在 Phase 0-1 注入。Phase 2+ 靠 task-dag.json / AC 等契约产出物，
// 不再被要求回头读 10~27KB 的原始报告（实测真实项目体积）。
for (const ph of [2, 3, 4, 5, 6, 7]) {
  const pn = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: ph })
  ok(`P${ph} 不再注入 Bug 报告路径`, !/bug分析报告/i.test(pn.agentPrompt))
}

const p2 = buildAgentPrompt({ storyId: 'FIX-1', targetPhase: 2 })
ok('P2 含「Bug 修复说明」', p2.agentPrompt.includes('Bug 修复说明'))
ok('P2 含 kb-query ∥ graphify 双源', /kb-query[\s\S]{0,80}graphify|graphify[\s\S]{0,80}kb-query/.test(p2.agentPrompt))
ok('P2 修复说明指向契约文件而非原始报告', /task-dag\.json/.test(p2.agentPrompt))

// v3 精简 2 条 + P3-2「检索失败上报」+「Bash 失败必须交代」共 4 条，删掉的旧约束不应再出现
ok('约束段为 4 条（v3 精简 2 条 + P3-2 检索失败上报 + Bash 失败交代）', p2.agentConstraints.length === 4, JSON.stringify(p2.agentConstraints))
ok('P3-2 检索失败上报约束已注入', p2.agentConstraints.some(c => /检索失败必须停下上报/.test(c)))
ok('Bash 失败交代约束已注入', p2.agentConstraints.some(c => /Bash execution failed/.test(c)))
ok('不再重复 agent .md 已有的 advance-phase 约束', !/- 🚫 由主 Agent 调用 advance-phase/.test(p2.agentPrompt))

// ════════════════════════════════════════════════════════════
section('4. run 模式回归（不受 fixbugs 改造影响）')

const r2 = createWorkflow('RUN-1', '新功能', false, false)
ok('mode = run', r2.mode === 'run', r2.mode)
ok('无 story-input -> 保守要求原型', r2.prototypeRequired === true)

const files2 = fs.readdirSync(storyDir('RUN-1'))
ok('run 模式也不写存根', !files2.some(f => f.includes('prototype-analysis')), files2.join(','))

const rp0 = buildAgentPrompt({ storyId: 'RUN-1', targetPhase: 0 })
ok('run P0 不含 tapd-bug-analyzer', !rp0.agentPrompt.includes('tapd-bug-analyzer'))
const rp2 = buildAgentPrompt({ storyId: 'RUN-1', targetPhase: 2 })
ok('run P2 不含 Bug 修复说明', !rp2.agentPrompt.includes('Bug 修复说明'))
ok('run 门控无 Bug 报告检查', !/bug分析报告/i.test(JSON.stringify(gate('RUN-1', 0))))

// ════════════════════════════════════════════════════════════
section('5. 原型按需判定')

writeInput('RUN-2', { mode: 'run', sources: { prototypeUrls: ['https://proto.example.com/a'] } })
ok('有原型链接 -> required=true',
  createWorkflow('RUN-2', '带原型', false, false, 'run').prototypeRequired === true)

writeInput('RUN-3', { mode: 'run', sources: { figmaUrls: ['https://figma.com/design/abc/x'] } })
ok('有 Figma 链接 -> required=true',
  createWorkflow('RUN-3', '带 Figma', false, false, 'run').prototypeRequired === true)

writeInput('RUN-4', { mode: 'run', sources: { text: '纯文字需求' } })
ok('无原型/Figma -> required=false',
  createWorkflow('RUN-4', '无原型', false, false, 'run').prototypeRequired === false)

// ════════════════════════════════════════════════════════════
section('6. bypass 模式')

const r5 = createWorkflow('BY-1', 'hotfix', true, false)
ok('bypass -> required=false', r5.prototypeRequired === false)
ok('bypass -> 直接 Phase 2', r5.phase === 2, String(r5.phase))

// ════════════════════════════════════════════════════════════
section('7. story-input.schema.json 契约')

const schema = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, 'schemas/story-input.schema.json'), 'utf-8'))
ok('required 含 mode + sources', ['mode', 'sources'].every(k => (schema.required || []).includes(k)))
ok('mode enum = [run, fixbugs]', JSON.stringify(schema.properties.mode.enum) === '["run","fixbugs"]')
ok('顶层 additionalProperties=false', schema.additionalProperties === false)
ok('sources additionalProperties=false', schema.properties.sources.additionalProperties === false)

// ════════════════════════════════════════════════════════════
section('8. 边界与容错')

fs.mkdirSync(storyDir('BAD-1'), { recursive: true })
fs.writeFileSync(path.join(storyDir('BAD-1'), 'story-input.json'), '{ 坏 JSON')
const bad = state.isPrototypeRequired('BAD-1')
ok('坏 JSON -> 保守 required=true', bad.required === true, bad.reason)
ok('坏 JSON -> getStoryMode 回退 run', state.getStoryMode('BAD-1') === 'run')
ok('findBugAnalysisReports 命中已有报告', state.findBugAnalysisReports('FIX-1').exists)
ok('findBugAnalysisReports 目录不存在时安全', state.findBugAnalysisReports('NOT-EXIST').exists === false)

// ════════════════════════════════════════════════════════════
summarize(sandbox)
