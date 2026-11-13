#!/usr/bin/env node
/**
 * fixbugs TAPD 回写测试
 *
 * 覆盖 2026-11 新增的回写能力：
 *   1. 四类评论模板（fixed / to_backend / to_collab / manual）的措辞与硬约束
 *   2. 状态流转只对「前端缺陷 + 验收通过」放行
 *   3. 状态映射校验（防止猜 key 误关单）
 *   4. 跨轮去重（writeback 凭证）
 *   5. planWritebacks 的分流结果
 *
 * 无外部依赖，用临时 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 *
 * 用法:
 *   node scripts/__tests__/tapd-writeback.test.js
 *   npm test
 */

const path = require('path')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// 沙箱必须在 require 之前（paths.js 的环境变量是加载期求值）
const sandbox = makeSandbox('harness-writeback-')

const wb = require(path.join(SCRIPTS_DIR, 'services/tapd-writeback'))

// ════════════════════════════════════════════════════════════
section('1. 评论模板')

const backend = wb.buildComment('to_backend', {
  symptom: '工单列表不显示草稿状态',
  frontendChecked: '已确认前端正确透传 orderId，页面按返回字段渲染',
  needBackend: '查询工单列表接口增加 draftFlag 字段'
})
ok('to_backend 含「需后端处理」', backend.includes('需后端处理'))
ok('to_backend 含三段（现象/已排除/需要后端）',
  /现象：/.test(backend) && /前端已排除：/.test(backend) && /需要后端：/.test(backend))
ok('to_backend 总长 ≤ 120 字', backend.length <= 120, String(backend.length))
ok('to_backend 无代码块', !backend.includes('\u0060\u0060\u0060') && !backend.includes('diff --git'))
ok('to_backend 无不贴文件路径要求（无常见源码后缀）', !/\.(vue|js|ts|scss):\d+/.test(backend))

const collab = wb.buildComment('to_collab', {
  symptom: '草稿标识在多人接待模式下消失',
  pendingItems: '接口 A 在多人模式下是否返回 draftFlag'
})
ok('to_collab 含「需前后端确认」', collab.includes('需前后端确认'))
ok('to_collab 含待确认项', /待确认：/.test(collab))
ok('to_collab 总长 ≤ 120 字', collab.length <= 120, String(collab.length))

const fixed = wb.buildComment('fixed', { fixSummary: '补齐草稿标识渲染' })
ok('fixed 含「前端已修复」与「待测试验证」',
  fixed.includes('前端已修复') && fixed.includes('待测试验证'))
ok('fixed 总长 ≤ 120 字', fixed.length <= 120, String(fixed.length))

const manual = wb.buildComment('manual', { reason: '改动涉及公共协议层，影响面超出本缺陷' })
ok('manual 含「未自动修复」与「转人工」',
  manual.includes('未自动修复') && manual.includes('转人工'))

ok('缺失字段用「未提供」占位，不生成残句',
  wb.buildComment('to_backend', {}).includes('未提供'))

let threw = false
try { wb.buildComment('unknown_kind', {}) } catch (e) { threw = true }
ok('非法评论类型抛错', threw)

// ════════════════════════════════════════════════════════════
section('2. 状态流转放行条件')

ok('frontend + 验收通过 -> 允许改状态',
  wb.canChangeStatus({ category: 'frontend' }, { accepted: true }).allowed)
ok('frontend + 未验收 -> 不允许',
  !wb.canChangeStatus({ category: 'frontend' }, { accepted: false }).allowed)
ok('backend -> 不允许（不抢后端流转权）',
  !wb.canChangeStatus({ category: 'backend' }, { accepted: true }).allowed)
ok('collab -> 不允许', !wb.canChangeStatus({ category: 'collab' }, { accepted: true }).allowed)
ok('未分诊 -> 不允许', !wb.canChangeStatus({}, { accepted: true }).allowed)
ok('无效记录 -> 不允许', !wb.canChangeStatus(null, { accepted: true }).allowed)
ok('目标状态固定 in_progress', wb.TARGET_STATUS === 'in_progress')

// ════════════════════════════════════════════════════════════
section('3. 状态映射校验（防猜 key 误关单）')

ok('映射含 in_progress=接受/处理 -> 通过',
  wb.verifyStatusMap({ new: '新', in_progress: '接受/处理' }).ok)
ok('映射缺 in_progress -> 不通过',
  !wb.verifyStatusMap({ new: '新', resolved: '已解决' }).ok)
ok('中文名不符 -> 不通过',
  !wb.verifyStatusMap({ in_progress: '处理中' }).ok)
ok('映射为空 -> 不通过', !wb.verifyStatusMap(null).ok)

// ════════════════════════════════════════════════════════════
section('4. 跨轮去重')

ok('未写过 -> 不重复',
  !wb.isDuplicateWriteback({ bugId: '1' }, 'to_backend').duplicated)
ok('同类评论已写过 -> 重复',
  wb.isDuplicateWriteback({ writeback: { commentedAt: '2026-11-13T10:00:00Z', commentKind: 'to_backend' } }, 'to_backend').duplicated)
ok('结论变化（类型不同）-> 不算重复',
  !wb.isDuplicateWriteback({ writeback: { commentedAt: '2026-11-13T10:00:00Z', commentKind: 'to_backend' } }, 'fixed').duplicated)

// ════════════════════════════════════════════════════════════
section('5. recordWriteback 落凭证')

const list = { bugs: [{ bugId: '1218765', category: 'frontend' }] }
const rec1 = wb.recordWriteback(list, '1218765', { kind: 'fixed', statusChanged: true, at: '2026-11-13T11:00:00Z' })
ok('record 成功', rec1.ok)
ok('写入 commentedAt', list.bugs[0].writeback.commentedAt === '2026-11-13T11:00:00Z')
ok('写入 statusChangedAt', list.bugs[0].writeback.statusChangedAt === '2026-11-13T11:00:00Z')
ok('写入 commentKind', list.bugs[0].writeback.commentKind === 'fixed')

const rec2 = wb.recordWriteback(list, '9999', { kind: 'fixed' })
ok('不存在的 bug -> 失败', !rec2.ok)
const rec3 = wb.recordWriteback({ bugs: [] }, '1', { kind: 'nope' })
ok('非法 kind -> 失败', !rec3.ok)

// 只写评论不改状态时，保留已有的 statusChangedAt
const list2 = { bugs: [{ bugId: '1', writeback: { commentedAt: 'a', commentKind: 'fixed', statusChangedAt: 'b' } }] }
wb.recordWriteback(list2, '1', { kind: 'to_backend', at: 'c' })
ok('只写评论时保留历史 statusChangedAt', list2.bugs[0].writeback.statusChangedAt === 'b')

// ════════════════════════════════════════════════════════════
section('6. planWritebacks 分流')

const plan = wb.planWritebacks({
  bugs: [
    { bugId: '1', category: 'frontend' },
    { bugId: '2', category: 'backend' },
    { bugId: '3', category: 'collab' }
  ]
}, { accepted: true })
ok('三个缺陷各有一条计划', plan.length === 3, JSON.stringify(plan))
ok('frontend -> fixed 且改状态',
  plan.find(p => p.bugId === '1').kind === 'fixed' && plan.find(p => p.bugId === '1').changeStatus === true)
ok('backend -> to_backend 且不改状态',
  plan.find(p => p.bugId === '2').kind === 'to_backend' && plan.find(p => p.bugId === '2').changeStatus === false)
ok('collab -> to_collab 且不改状态',
  plan.find(p => p.bugId === '3').kind === 'to_collab' && plan.find(p => p.bugId === '3').changeStatus === false)

const planNotAccepted = wb.planWritebacks({ bugs: [{ bugId: '1', category: 'frontend' }] }, { accepted: false })
ok('未验收 -> frontend 不产生 fixed 计划', planNotAccepted.length === 0)

// ════════════════════════════════════════════════════════════
section('7. 排期匹配边界（1218765 不应命中 12187651）')

const fsx = require('fs')
const pathx = require('path')
const { runGateCheck } = require(pathx.join(SCRIPTS_DIR, 'services/policy'))
const stateMod = require(pathx.join(SCRIPTS_DIR, 'lib/state'))

const schedDir = sandbox.storyDir('SCHED-1')
fsx.mkdirSync(schedDir, { recursive: true })
fsx.writeFileSync(pathx.join(schedDir, 'story-input.json'), JSON.stringify({
  mode: 'fixbugs', sources: { tapdUrl: 'https://x/tapd_fe/1/story/detail/2', workspaceId: '1', owner: 'a' }
}))
fsx.writeFileSync(pathx.join(schedDir, 'e2e-state.json'), JSON.stringify({
  storyId: 'SCHED-1', mode: 'fixbugs', phase: 1, status: 'running', phases: {}
}))
fsx.writeFileSync(pathx.join(schedDir, 'bug-list.json'), JSON.stringify({
  bugs: [{ bugId: '1218765', title: 'a', status: 'new', category: 'frontend' }]
}))

const schedGate = () => runGateCheck('SCHED-1', 1, stateMod.readStateFile('SCHED-1'))

fsx.writeFileSync(pathx.join(schedDir, 'task-dag.json'), JSON.stringify({
  tasks: [{ id: 'T-1', title: '修复 12187651 的问题', files: ['src/a.vue'] }]
}))
ok('更长 id 不应被误判为已排期',
  schedGate().blockers.some(b => b.type === 'bug_not_scheduled'))

fsx.writeFileSync(pathx.join(schedDir, 'task-dag.json'), JSON.stringify({
  tasks: [{ id: 'T-1', title: '修复 1218765 的问题', files: ['src/a.vue'] }]
}))
ok('title 中出现完整 id -> 已排期',
  !schedGate().blockers.some(b => b.type === 'bug_not_scheduled'))

fsx.writeFileSync(pathx.join(schedDir, 'task-dag.json'), JSON.stringify({
  tasks: [{ id: 'T-1', bugId: '1218765', title: 'x', files: ['src/a.vue'] }]
}))
ok('task.bugId 显式承接 -> 已排期',
  !schedGate().blockers.some(b => b.type === 'bug_not_scheduled'))

// ════════════════════════════════════════════════════════════
section('8. 回写后 schema 校验（写坏清单 = 改坏门控输入）')

const { validateArtifact } = require(pathx.join(SCRIPTS_DIR, 'services/schema-validator'))
const wbDir = sandbox.storyDir('WB-S')
fsx.mkdirSync(wbDir, { recursive: true })
const wbPath = pathx.join(wbDir, 'bug-list.json')
fsx.writeFileSync(wbPath, JSON.stringify({ bugs: [{ bugId: '1', title: 'a', status: 'new', category: 'frontend' }] }, null, 2))
const wbList = JSON.parse(fsx.readFileSync(wbPath, 'utf-8'))
wb.recordWriteback(wbList, '1', { kind: 'fixed', statusChanged: true, at: '2026-11-13T11:00:00Z' })
fsx.writeFileSync(wbPath, JSON.stringify(wbList, null, 2) + '\n')
ok('回写后仍通过 schema 校验', validateArtifact('WB-S', 'bug-list.json', wbDir).valid)
ok('回写凭证可被回读', JSON.parse(fsx.readFileSync(wbPath, 'utf-8')).bugs[0].writeback.commentKind === 'fixed')

// ════════════════════════════════════════════════════════════
summarize(sandbox)
