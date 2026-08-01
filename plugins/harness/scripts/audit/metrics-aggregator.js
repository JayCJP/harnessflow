#!/usr/bin/env node
/**
 * metrics-aggregator.js — 度量聚合引擎
 *
 * 职责：
 * 1. 读取当前项目所有 Story 的 trace.jsonl + e2e-state.json
 * 2. 计算 8 项核心指标（Phase 耗时、门控通过率、Fix-loop 触发率等）
 * 3. 生成跨项目通用的流程级洞察（非项目特定逻辑）
 * 4. 合并到全局经验库 ~/.codebuddy/experience/metrics-insights.json
 * 5. 供 advance-phase.js 和 session-start.js 注入到 Agent prompt
 *
 * 用法：
 *   node metrics-aggregator.js                    # 聚合当前项目 + 合并到全局
 *   node metrics-aggregator.js --json             # JSON 输出（不写入全局）
 *   node metrics-aggregator.js --global-stats     # 查看全局统计
 *
 * 触发时机：
 *   - Phase 7 完成时由 advance-phase.js 自动触发
 *   - 手动执行
 *
 * @module metrics-aggregator
 */

const fs = require('fs')
const path = require('path')
const {
  PLANS_DIR,
  PROJECT_ROOT,
  listStoryDirs,
  readStateFile,
  getStoryDir,
  getPhaseName,
  PHASE_SLUGS
} = require('../lib/state')

const experience = require('../services/experience')

// ─── 常量 ──────────────────────────────────────────────────

/** 当前项目名（用于 sourceProjects 追踪） */
const PROJECT_NAME = path.basename(PROJECT_ROOT)

/** 阈值常量 */
const THRESHOLDS = {
  PHASE_DURATION_MS: 20 * 60 * 1000,      // Phase 耗时 > 20min → 瓶颈
  GATE_FIRST_TRY_RATE: 0.8,                 // 一次通过率 < 80% → 警告
  FIX_LOOP_TRIGGER_RATE: 0.4,              // Fix-loop 触发率 > 40% → 警告
  FIX_LOOP_SUCCESS_RATE: 0.8,              // Fix-loop 成功率 < 80% → 警告
  DEV_PASS_PRECISION: 0.7                   // dev-pass 限域精度 < 70% → 提示
}

// ─── trace.jsonl 解析 ──────────────────────────────────────

/**
 * 读取指定 Story 的 trace.jsonl 并解析为事件数组
 * @param {string} storyId - Story ID
 * @returns {Array<Object>} trace 事件列表
 */
function readTraceEvents (storyId) {
  const traceFile = path.join(getStoryDir(storyId), 'trace.jsonl')
  if (!fs.existsSync(traceFile)) return []

  const events = []
  const lines = fs.readFileSync(traceFile, 'utf-8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (e) { /* 跳过损坏行 */ }
  }
  return events
}

// ─── 指标计算 ──────────────────────────────────────────────

/**
 * 计算单个 Story 的 Phase 耗时
 * @param {Object} state - e2e-state.json 状态对象
 * @returns {Object<number, number>} Phase 编号 → 耗时（毫秒）
 */
function computePhaseDurations (state) {
  const durations = {}
  if (!state.phases) return durations

  for (let p = 0; p <= 7; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    const phaseState = state.phases[phaseKey]
    if (!phaseState) continue

    const start = phaseState.startedAt ? new Date(phaseState.startedAt).getTime() : null
    const end = phaseState.completedAt
      ? new Date(phaseState.completedAt).getTime()
      : (phaseState.rolledBackAt ? new Date(phaseState.rolledBackAt).getTime() : null)

    if (start && end && end > start) {
      durations[p] = end - start
    }
  }
  return durations
}

/**
 * 聚合所有 Story 的度量数据
 * @returns {Object} 聚合后的度量对象
 */
function aggregateMetrics () {
  const storyDirs = listStoryDirs()
  const allPhaseDurations = {}  // { phase: [duration1, duration2, ...] }
  let totalAdvances = 0
  let gateFirstTryPasses = 0
  let totalPhase3_4Advances = 0
  let fixLoopCount = 0
  let fixLoopSucceeded = 0
  let totalBlockers = 0
  let remainingBlockers = 0
  let totalDevPass = 0
  let preciseDevPass = 0
  let completedStories = 0
  let totalStories = 0

  for (const storyId of storyDirs) {
    const state = readStateFile(storyId)
    if (!state) continue
    totalStories++

    // Story 完成状态
    if (state.status === 'completed' || (state.phase >= 7 && state.phases && state.phases['7_deployment'] && state.phases['7_deployment'].status === 'completed')) {
      completedStories++
    }

    // Phase 耗时
    const durations = computePhaseDurations(state)
    for (const [phase, dur] of Object.entries(durations)) {
      if (!allPhaseDurations[phase]) allPhaseDurations[phase] = []
      allPhaseDurations[phase].push(dur)
    }

    // 门控结果
    if (state.gateChecks && Array.isArray(state.gateChecks.gateValidationResults)) {
      for (const gate of state.gateChecks.gateValidationResults) {
        totalAdvances++
        if (gate.pass && (!gate.warnings || gate.warnings.length === 0)) {
          gateFirstTryPasses++
        }
        // 统计 Phase 3/4 相关推进
        if (gate.targetPhase === 4 || gate.targetPhase === 5) {
          totalPhase3_4Advances++
        }
      }
    }

    // Trace 事件统计
    const events = readTraceEvents(storyId)
    let storyFixLoopCount = 0
    let storyFixLoopSucceeded = false

    for (const evt of events) {
      // Fix-loop 事件
      if (evt.type === 'fix_loop') {
        fixLoopCount++
        storyFixLoopCount++
      }

      // Phase 3 门控通过（fix-loop 后成功修复）
      if (evt.type === 'gate_decision' && evt.phase === '3' && evt.result === 'pass' && storyFixLoopCount > 0) {
        storyFixLoopSucceeded = true
      }

      // dev-pass 签发事件（精度统计从 trace 读取，
      // 因为 dev-pass.json 在 Phase 2→3 撤销后即被删除，无法追溯）
      if (evt.type === 'dev_pass' && evt.result === 'issued') {
        totalDevPass++
        const src = evt.details && evt.details.source
        if (src && src !== 'fallback-src-glob' && src !== 'none') {
          preciseDevPass++
        }
      }
    }

    if (storyFixLoopCount > 0 && storyFixLoopSucceeded) {
      fixLoopSucceeded++
    }

    // BLOCKER 统计（从 gateChecks）
    if (state.gateChecks && Array.isArray(state.gateChecks.gateValidationResults)) {
      for (const gate of state.gateChecks.gateValidationResults) {
        if (gate.blockers && Array.isArray(gate.blockers)) {
          totalBlockers += gate.blockers.length
        }
      }
    }
  }

  // 计算 Phase 耗时统计
  const phaseDurationStats = {}
  for (const [phase, durations] of Object.entries(allPhaseDurations)) {
    if (durations.length === 0) continue
    const sorted = [...durations].sort((a, b) => a - b)
    const sum = durations.reduce((a, b) => a + b, 0)
    phaseDurationStats[phase] = {
      avg: Math.round(sum / durations.length),
      median: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      count: durations.length
    }
  }

  return {
    storyCount: totalStories,
    completedStories,
    phaseDurations: phaseDurationStats,
    gateFirstTryRate: totalAdvances > 0 ? gateFirstTryPasses / totalAdvances : 1,
    fixLoopTriggerRate: totalPhase3_4Advances > 0 ? fixLoopCount / totalPhase3_4Advances : 0,
    fixLoopSuccessRate: fixLoopCount > 0 ? fixLoopSucceeded / fixLoopCount : 1,
    blockerCount: totalBlockers,
    devPassPrecision: totalDevPass > 0 ? preciseDevPass / totalDevPass : 1,
    storyCompletionRate: totalStories > 0 ? completedStories / totalStories : 0
  }
}

// ─── 洞察生成 ──────────────────────────────────────────────

/**
 * 根据度量数据生成跨项目通用洞察
 * 每条洞察包含 targetPhase（注入目标）+ recommendation（具体建议）
 * @param {Object} metrics - 聚合后的度量数据
 * @returns {Array<Object>} 洞察列表
 */
function generateInsights (metrics) {
  const insights = []

  // 规则 1: Phase 耗时瓶颈
  for (const [phaseStr, stats] of Object.entries(metrics.phaseDurations)) {
    const phase = parseInt(phaseStr, 10)
    if (stats.avg > THRESHOLDS.PHASE_DURATION_MS && stats.count >= 2) {
      const avgMin = Math.round(stats.avg / 60000)
      const maxMin = Math.round(stats.max / 60000)
      insights.push({
        id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
        targetPhase: Math.max(0, phase - 1), // 注入到上一个 Phase（规划阶段优化）
        type: 'bottleneck',
        severity: 'warning',
        title: `Phase ${phase}(${getPhaseName(phase)})平均耗时 ${avgMin}min，最长 ${maxMin}min`,
        description: `${getPhaseName(phase)}阶段耗时偏长，可能影响整体交付效率`,
        recommendation: getRecommendationForPhase(phase),
        evidence: `${stats.count} 个 Story 统计: avg=${avgMin}min, median=${Math.round(stats.median / 60000)}min, max=${maxMin}min`
      })
    }
  }

  // 规则 2: 门控一次通过率
  if (metrics.gateFirstTryRate < THRESHOLDS.GATE_FIRST_TRY_RATE && metrics.storyCount >= 2) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 0,
      type: 'gate_quality',
      severity: 'warning',
      title: `门控一次通过率 ${Math.round(metrics.gateFirstTryRate * 100)}%`,
      description: `${Math.round((1 - metrics.gateFirstTryRate) * 100)}% 的 Phase 推进需要多次门控尝试`,
      recommendation: '需求分析阶段确保 AC 格式正确（id/description/criteria 非空）、open-questions 全部 resolved、task-dag 使用 title 而非 name',
      evidence: `通过率 ${Math.round(metrics.gateFirstTryRate * 100)}% (基于 ${metrics.storyCount} 个 Story)`
    })
  }

  // 规则 3: Fix-loop 触发率
  if (metrics.fixLoopTriggerRate > THRESHOLDS.FIX_LOOP_TRIGGER_RATE) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 2,
      type: 'fix_loop_trigger',
      severity: 'warning',
      title: `Fix-loop 触发率 ${Math.round(metrics.fixLoopTriggerRate * 100)}%`,
      description: '代码审查/测试失败率偏高，开发阶段自测不充分',
      recommendation: '开发阶段加强自测：参考知识库 pitfalls.md 避免已知坑点，ESLint 0 error 后再提交审查',
      evidence: `触发率 ${Math.round(metrics.fixLoopTriggerRate * 100)}%`
    })
  }

  // 规则 4: Fix-loop 第 1 轮成功率
  if (metrics.fixLoopSuccessRate < THRESHOLDS.FIX_LOOP_SUCCESS_RATE && metrics.fixLoopTriggerRate > 0) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 3,
      type: 'fix_loop_success',
      severity: 'warning',
      title: `Fix-loop 第 1 轮成功率 ${Math.round(metrics.fixLoopSuccessRate * 100)}%`,
      description: 'BLOCKER 修复建议的可操作性不足，导致需要多轮修复',
      recommendation: '代码审查师在 FIX_DATA 块中给出代码级建议（含具体行号和替换方案），而非泛泛描述问题',
      evidence: `成功率 ${Math.round(metrics.fixLoopSuccessRate * 100)}%`
    })
  }

  // 规则 5: dev-pass 限域精度
  if (metrics.devPassPrecision < THRESHOLDS.DEV_PASS_PRECISION) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 1,
      type: 'dev_pass_scope',
      severity: 'info',
      title: `dev-pass 限域精度 ${Math.round(metrics.devPassPrecision * 100)}%`,
      description: 'task-dag.json 的 files 声明不完整，dev-pass 降级为 src/** 全局授权',
      recommendation: '任务规划时为每个 task 声明完整的 files 列表，确保 dev-pass 精确限域',
      evidence: `精度 ${Math.round(metrics.devPassPrecision * 100)}%`
    })
  }

  // 规则 6: Story 完成率
  if (metrics.storyCount >= 3 && metrics.storyCompletionRate < 0.7) {
    insights.push({
      id: `INSIGHT-${String(insights.length + 1).padStart(3, '0')}`,
      targetPhase: 0,
      type: 'completion_rate',
      severity: 'warning',
      title: `Story 完成率 ${Math.round(metrics.storyCompletionRate * 100)}%`,
      description: '部分 Story 未完成，可能存在需求不清晰或阻塞未解决',
      recommendation: '需求分析阶段确保 open-questions 全部 resolved，需求边界明确后再进入开发',
      evidence: `${metrics.completedStories}/${metrics.storyCount} 完成`
    })
  }

  return insights
}

/**
 * 获取 Phase 对应的优化建议
 * @param {number} phase - Phase 编号
 * @returns {string} 建议文本
 */
function getRecommendationForPhase (phase) {
  const recommendations = {
    0: '需求分析阶段确保 AC 覆盖完整、格式正确，open-questions 全部 resolved 后再推进',
    1: '任务规划时将大 task 拆为 Fork-Join 并行，单 task 控制在 15min 内，为每个 task 声明完整 files',
    2: '开发阶段加强自测，ESLint 0 error 后再提交审查，参考知识库 pitfalls.md 避免已知坑点',
    3: '代码审查师在 FIX_DATA 块中给出代码级建议（含行号和替换方案）',
    4: '测试工程师确保 AC 100% 覆盖，evidence 数组至少 1 条',
    5: 'Git 提交确保 commit 格式规范，禁止 --no-verify',
    6: '知识库更新时保留手工批注',
    7: '部署前确认构建产物完整'
  }
  return recommendations[phase] || '优化该 Phase 的执行效率'
}

// ─── CLI 入口 ──────────────────────────────────────────────

const args = process.argv.slice(2)
const jsonOnly = args.includes('--json')
const globalStats = args.includes('--global-stats')

// 查看全局统计
if (globalStats) {
  const globalData = experience.readMetricsInsights()
  console.log(JSON.stringify({
    totalProjects: globalData.totalProjects,
    totalStories: globalData.totalStories,
    insightCount: globalData.insights.length,
    lastUpdated: globalData.lastUpdated,
    insights: globalData.insights.map(i => ({
      id: i.id,
      targetPhase: i.targetPhase,
      type: i.type,
      title: i.title,
      occurrences: i.occurrences,
      sourceProjects: i.sourceProjects
    }))
  }, null, 2))
  process.exit(0)
}

// 聚合当前项目度量
const metrics = aggregateMetrics()
const insights = generateInsights(metrics)

if (jsonOnly) {
  // JSON 输出模式（不写入全局）
  console.log(JSON.stringify({
    project: PROJECT_NAME,
    metrics,
    insights
  }, null, 2))
  process.exit(0)
}

// 合并到全局经验库
console.log(`\n📊 度量聚合 — 项目: ${PROJECT_NAME}`)
console.log(`   Story 数: ${metrics.storyCount}`)
console.log(`   已完成: ${metrics.completedStories}`)
console.log(`   Phase 耗时统计:`)
for (const [phase, stats] of Object.entries(metrics.phaseDurations)) {
  console.log(`     Phase ${phase}(${getPhaseName(parseInt(phase, 10))}): avg=${Math.round(stats.avg / 60000)}min, max=${Math.round(stats.max / 60000)}min`)
}
console.log(`   门控一次通过率: ${Math.round(metrics.gateFirstTryRate * 100)}%`)
console.log(`   Fix-loop 触发率: ${Math.round(metrics.fixLoopTriggerRate * 100)}%`)
console.log(`   Fix-loop 成功率: ${Math.round(metrics.fixLoopSuccessRate * 100)}%`)
console.log(`   dev-pass 限域精度: ${Math.round(metrics.devPassPrecision * 100)}%`)

console.log(`\n💡 生成 ${insights.length} 条洞察:`)
for (const i of insights) {
  console.log(`   ${i.severity === 'warning' ? '⚠️' : '📊'} [Phase ${i.targetPhase}] ${i.title}`)
}

// 合并到全局
if (insights.length > 0) {
  experience.mergeInsightsToGlobal(insights, PROJECT_NAME)
  console.log(`\n✅ 已合并到全局经验库: ~/.codebuddy/experience/metrics-insights.json`)
} else {
  console.log(`\nℹ️ 无新洞察需要合并`)
}

process.exit(0)
