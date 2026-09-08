#!/usr/bin/env node
/**
 * harness-audit.js — Harness 工作流健康体检与自修复
 *
 * 职责:
 *   - 工作流状态审计: .harness-active 与 e2e-state.json 一致性、活跃工作流数、dev-pass 有效性与限域精度
 *   - 契约与产出物审计: 未完成 Story 的 acceptance-criteria / open-questions / task-dag /
 *     已越过 Phase 的产出物缺失
 *   - 声明-消费一致性: story-input.json 声明了 Figma 链接但 Phase 1 未产出有效 frame 清单 → 告警
 *
 * 用法:
 *   独立执行:
 *     node plugins/harness/scripts/audit/harness-audit.js           # 人类可读报告
 *     node plugins/harness/scripts/audit/harness-audit.js --json    # 只输出 JSON，供 AI / 脚本解析
 *     node plugins/harness/scripts/audit/harness-audit.js --fix     # 自动修复（当前仅清理过期 dev-pass）
 *     flag 可组合，如 --json --fix
 *
 * 输出:
 *   - --json: { summary, issues, warnings, fixed }，其中 issues 为 BLOCKER、warnings 为 WARNING
 *   - 默认: 先打印 Harness 激活状态 / 活跃工作流数 / dev-pass 状态，
 *     再分段列出 BLOCKERS / WARNINGS / FIXED 及计数
 *   - 退出码: 存在 BLOCKER 时为 1，其余为 0
 *
 * 使用场景:
 *   - 人工诊断: /harness-evolve 的 Step 0 体检；或流程卡住时手动跑一遍，
 *     先分清是「脚本坏了」还是「状态/产出物缺失」再决定修哪边
 *   - 改脚本后的自检: 修改 scripts/ 下任一脚本后立刻跑，确认工作流状态与产出物未断裂
 *   - 工作流卡死排查: 用 --json 拿到结构化结果，按 cat 字段定位 BLOCKER 类别
 *     （state / contract / artifact / decl-consume / dev-pass）
 *
 * 说明:
 *   - 「语法错误」与「未定义引用」不在本脚本职责内，由 ESLint 负责（plugins/harness 下
 *     npm run lint）。此处曾有一份 178 行的正则悬空引用扫描器 + node --check 语法体检，
 *     前者自述「启发式……仍可能误报，故一律降为 WARNING」，后者只能抓语法错误；
 *     两者覆盖能力都是 ESLint（真实 AST）的真子集，已删除，不要重新加回手写实现。
 *   - --fix 目前只清理过期的 dev-pass.json，不会改动 e2e-state.json 或任何契约文件
 *   - 有 BLOCKER 时 exit 1，可直接用作提交前门禁或 CI 检查
 *
 * @module harness-audit
 */
const fs = require('fs')
const path = require('path')
const { PLANS_DIR, listStoryDirs, readStateFile, findActiveWorkflows, checkPhaseArtifact, checkAcceptanceCriteria, checkOpenQuestions, checkTaskDagJson, validateContractReferences, checkDevPass, detectFigmaSource, checkFigmaFrameInventory } = require('../lib/state')
const { HARNESS_ACTIVE_FLAG } = require('../lib/artifacts')
const args = process.argv.slice(2)
const fixMode = args.includes('--fix')
const jsonOnly = args.includes('--json')
const issues = []; const warnings = []; const fixed = []
const summary = {}

function auditActiveStory () {
  const hf = HARNESS_ACTIVE_FLAG
  const ha = fs.existsSync(hf)
  const wfs = findActiveWorkflows()
  if (ha) {
    try {
      const flag = JSON.parse(fs.readFileSync(hf, 'utf-8'))
      summary.harnessStoryId = flag.storyId; summary.harnessActive = true
      const st = readStateFile(flag.storyId)
      if (!st) issues.push({ cat: 'state', severity: 'BLOCKER', msg: '.harness-active 引用 ' + flag.storyId + ' 但 e2e-state.json 不存在' })
      else summary.harnessPhase = st.phase
    } catch { issues.push({ cat: 'state', severity: 'BLOCKER', msg: '.harness-active JSON 解析失败' }) }
  } else { summary.harnessActive = false; if (wfs.length > 0) warnings.push({ cat: 'state', severity: 'WARNING', msg: String(wfs.length) + ' 个活跃工作流但 .harness-active 不存在' }) }
  summary.activeWorkflows = wfs.length
}

function auditDevPass () {
  const dp = checkDevPass()
  summary.devPassValid = dp.valid; summary.devPassStoryId = dp.storyId
  if (dp.valid && dp.storyId) {
    try {
      const pp = path.join(PLANS_DIR, dp.storyId, 'dev-pass.json')
      const pass = JSON.parse(fs.readFileSync(pp, 'utf-8'))
      if (pass.pathSource === 'fallback-src-glob') warnings.push({ cat: 'dev-pass', severity: 'WARNING', msg: 'dev-pass 降级为 src/** 全局 (storyId=' + dp.storyId + ')，建议完善 task-dag.json files' })
      else summary.devPassScope = 'precise (' + (pass.allowedPaths ? pass.allowedPaths.length : 0) + ' files)'
    } catch {}
  } else if (dp.storyId && fixMode) {
    try { fs.unlinkSync(path.join(PLANS_DIR, dp.storyId, 'dev-pass.json')); fixed.push('已清理过期 dev-pass: ' + dp.storyId) } catch {}
  }
}

function auditContracts () {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === 'completed') continue
    const ph = st.phase || 0
    if (ph >= 1 || (st.phases && st.phases['0_requirement_analysis'] && st.phases['0_requirement_analysis'].status === 'completed')) {
      const ac = checkAcceptanceCriteria(sid)
      if (!ac.valid) warnings.push({ cat: 'contract', severity: 'WARNING', msg: '[' + sid + '] acceptance-criteria.json: ' + ac.errors.join('; ') })
      const oq = checkOpenQuestions(sid)
      if (!oq.allResolved) warnings.push({ cat: 'contract', severity: 'WARNING', msg: '[' + sid + '] open-questions.json: ' + oq.unresolved.length + ' 项未解决' })
    }
    if (ph >= 2 || (st.phases && st.phases['1_task_planning'] && st.phases['1_task_planning'].status === 'completed')) {
      const tdj = checkTaskDagJson(sid)
      if (!tdj.valid) warnings.push({ cat: 'contract', severity: 'WARNING', msg: '[' + sid + '] task-dag.json: ' + tdj.errors.join('; ') })
      const ref = validateContractReferences(sid)
      if (!ref.valid) warnings.push({ cat: 'contract', severity: 'WARNING', msg: '[' + sid + '] AC-Task 引用: ' + ref.errors.join('; ') })
    }
  }
}

/**
 * 声明-消费一致性检查 — 抓「story-input 声明了外部依赖但流程未消费」的断裂
 *
 * 历史教训: 曾有 Story 在 story-input.json 声明了 figmaUrls，但开发阶段从未真正
 * 消费它 —— Figma 链路静默断裂，前端用默认样式实现，验收才发现货不对板。
 *
 * 检查逻辑: 对每个未完成 Story，若 story-input 声明了 Figma 链接（detectFigmaSource.hasFigma），
 * 则校验后续是否真的产出了 figma-frame-inventory.json（checkFigmaFrameInventory）。
 * 声明了 Figma 但 Phase 1（任务规划）没产出 frame 清单 = 断裂，告警。
 *
 * @returns {void}
 */
function auditDeclarationConsumption () {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === 'completed') continue

    // 声明了 Figma 设计稿？
    const figma = detectFigmaSource(sid)
    if (!figma.hasFigma) continue

    // 是否已进入需要消费 Figma 的阶段（Phase >= 1，即已通过需求分析）
    const ph = st.phase || 0
    if (ph < 1) continue

    // 是否产出了 frame 清单（消费证据）
    const ffi = checkFigmaFrameInventory(sid)
    if (!ffi.valid) {
      const errText = (ffi.errors && ffi.errors.length > 0)
        ? ffi.errors.join('; ')
        : 'figma-frame-inventory.json 缺失或无效'
      warnings.push({ cat: 'decl-consume', severity: 'WARNING', msg: '[' + sid + '] 声明了 ' + figma.urls.length + ' 个 Figma 链接但 Phase 1 未产出有效 frame 清单: ' + errText })
    }
  }
}

function auditArtifacts () {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === 'completed') continue
    const ph = st.phase || 0
    for (let p = 0; p < ph; p++) {
      if (st.bypass && p < 2) continue
      const art = checkPhaseArtifact(sid, p)
      if (!art.exists) { for (const m of art.missing) warnings.push({ cat: 'artifact', severity: 'WARNING', msg: '[' + sid + '] Phase ' + p + ' 缺失: ' + m.description + ' -> ' + m.fileName }) }
    }
  }
}

function run () {
  auditActiveStory(); auditDevPass(); auditContracts(); auditDeclarationConsumption(); auditArtifacts()
  summary.auditedAt = (new Date()).toISOString()
  summary.totalIssues = issues.length; summary.totalWarnings = warnings.length; summary.totalFixed = fixed.length
  if (jsonOnly) { console.log(JSON.stringify({ summary, issues, warnings, fixed }, null, 2)); return }
  console.log('')
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Harness Engineering — CCHF 健康审计报告')
  console.log('  时间: ' + summary.auditedAt)
  console.log('  Harness: ' + (summary.harnessActive ? ('已激活 (' + (summary.harnessStoryId || '?') + ')') : '未激活'))
  console.log('  活跃工作流: ' + (summary.activeWorkflows || 0) + ' 个')
  console.log('  dev-pass: ' + (summary.devPassValid ? ('有效' + (summary.devPassScope ? (' (' + summary.devPassScope + ')') : '')) : '无效'))
  console.log('═══════════════════════════════════════════════════════')
  if (issues.length > 0) { console.log(''); console.log('BLOCKERS (' + issues.length + '):'); for (const i of issues) console.log('  [' + i.cat + '] ' + i.msg) }
  if (warnings.length > 0) { console.log(''); console.log('WARNINGS (' + warnings.length + '):'); for (const w of warnings) console.log('  [' + w.cat + '] ' + w.msg) }
  if (fixed.length > 0) { console.log(''); console.log('FIXED (' + fixed.length + '):'); for (const f of fixed) console.log('  [ok] ' + f) }
  if (issues.length === 0 && warnings.length === 0) { console.log(''); console.log('All checks passed.') }
  console.log(''); console.log('═══════════════════════════════════════════════════════')
  console.log('  Blockers: ' + summary.totalIssues + ' | Warnings: ' + summary.totalWarnings + ' | Fixed: ' + summary.totalFixed)
  console.log('═══════════════════════════════════════════════════════')
  if (issues.length > 0) process.exit(1)
}
run()
