#!/usr/bin/env node
/**
 * context-refresh.js — 上下文刷新模块
 *
 * 每个 Phase 完成后生成 summary，供下个 Agent 加载时替代完整历史。
 * 实现 Claude Code Level 4 Autocompact 的简化版: 保存关键决策 + 契约路径 + 待办。
 *
 * 设计原则 (来自 Harness Engineering 指南):
 *   - 对话历史占 60-80% context，是压缩核心
 *   - 渐进式: 先轻量摘要，必要时升级
 *   - 预算跟踪跨压缩边界
 *
 * @module context-refresh
 */

const fs = require('fs')
const path = require('path')
const { getStoryDir, readJsonArtifact, readStateFile, getPhaseName, PHASE_SLUGS } = require('../lib/state')

/**
 * 生成 Phase 完成后的上下文摘要
 * @param {string} storyId - Story ID
 * @param {number} phase - 刚完成的 Phase 编号
 * @returns {string} summary 文件路径
 */
function generatePhaseSummary (storyId, phase) {
  const storyDir = getStoryDir(storyId)
  const state = readStateFile(storyId)
  if (!state) return null

  const phaseName = getPhaseName(phase)
  const phaseSlug = PHASE_SLUGS[phase] || 'unknown'
  const summaryLines = [
    `# Phase ${phase} (${phaseName}) 完成摘要`,
    '',
    `> Story: ${storyId} | 完成时间: ${new Date().toISOString()}`,
    `> 本文件供下个 Agent 加载，替代完整对话历史。`,
    '',
    '## 关键产出物',
    ''
  ]

  // 根据 Phase 收集产出物信息
  const artifacts = getPhaseArtifacts(storyId, phase)
  for (const a of artifacts) {
    summaryLines.push(`- **${a.name}**: \`${a.path}\``)
    if (a.summary) summaryLines.push(`  - ${a.summary}`)
  }

  // 关键决策（从 e2e-state 中提取）
  summaryLines.push('', '## 关键决策', '')
  if (state.gateChecks && state.gateChecks.gateValidationResults) {
    const recentGates = state.gateChecks.gateValidationResults.filter(g => g.targetPhase <= phase + 1)
    for (const g of recentGates) {
      const status = g.pass ? '✅ 通过' : '❌ 失败'
      summaryLines.push(`- Phase ${g.targetPhase} 门控: ${status}`)
      if (g.warnings && g.warnings.length > 0) {
        summaryLines.push(`  - Warnings: ${g.warnings.join('; ')}`)
      }
    }
  }

  // 待确认项状态 — 从 open-questions.json 读取
  summaryLines.push('', '## 待确认项状态', '')
  const oqJsonPath = path.join(storyDir, 'open-questions.json')
  if (fs.existsSync(oqJsonPath)) {
    try {
      const oqData = JSON.parse(fs.readFileSync(oqJsonPath, 'utf-8'))
      if (Array.isArray(oqData.questions)) {
        const resolved = oqData.questions.filter(q => q.resolved)
        const unresolved = oqData.questions.filter(q => !q.resolved)
        summaryLines.push(`- 已解决: ${resolved.length} 项`)
        summaryLines.push(`- 未解决: ${unresolved.length} 项`)
        if (unresolved.length > 0) {
          summaryLines.push(`- ⚠️ 未解决项: ${unresolved.map(q => q.id).join(', ')}`)
        }
      }
    } catch (e) {
      summaryLines.push('- 无法解析 open-questions.json')
    }
  } else {
    summaryLines.push('- 无待确认项')
  }

  // 下一步指引
  summaryLines.push('', `## 下一步 (Phase ${phase + 1})`, '')
  const nextSteps = getNextSteps(phase, storyId)
  for (const step of nextSteps) {
    summaryLines.push(`- ${step}`)
  }

  // 契约文件清单（供下个 Agent 快速加载）
  summaryLines.push('', '## 契约文件清单', '')
  const contracts = getContractFiles(storyId, phase)
  for (const c of contracts) {
    summaryLines.push(`- \`${c}\``)
  }

  const content = summaryLines.join('\n') + '\n'
  const summaryPath = path.join(storyDir, `phase-${phase}-summary.md`)
  fs.writeFileSync(summaryPath, content, 'utf-8')
  return summaryPath
}

/**
 * 获取指定 Phase 的产出物信息
 * @param {string} storyId
 * @param {number} phase
 * @returns {Array<{name: string, path: string, summary?: string}>}
 */
function getPhaseArtifacts (storyId, phase) {
  const storyDir = getStoryDir(storyId)
  const artifacts = []

  const phaseFiles = {
    0: ['requirement-analysis.md', 'acceptance-criteria.json', 'open-questions.json', 'prototype-analysis.md', 'figma-frame-inventory.json'],
    1: ['task-dag.md', 'task-dag.json'],
    2: [], // 代码变更，无文件产出物
    3: ['code-review.json'],
    4: ['test-report.md', 'acceptance-verification.json'],
    5: [], // git commit
    6: [], // 知识库更新
    7: []  // 部署
  }

  const files = phaseFiles[phase] || []
  for (const f of files) {
    const filePath = path.join(storyDir, f)
    if (fs.existsSync(filePath)) {
      let summary = ''
      // 为 JSON 文件生成简短摘要
      if (f.endsWith('.json')) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (f === 'acceptance-criteria.json' && data.criteria) {
            summary = `${data.criteria.length} 条验收标准`
          } else if (f === 'open-questions.json' && data.questions) {
            const resolved = data.questions.filter(q => q.resolved).length
            summary = `${data.questions.length} 项 (${resolved} 已解决)`
          } else if (f === 'task-dag.json' && data.tasks) {
            summary = `${data.tasks.length} 个任务`
          } else if (f === 'code-review.json' && Array.isArray(data.issues)) {
            const openBlockers = data.issues.filter(i => i.severity === 'BLOCKER' && i.status === 'open').length
            summary = `${data.issues.length} 个问题 (${openBlockers} 个未修复 BLOCKER)`
          } else if (f === 'acceptance-verification.json' && data.results) {
            const passed = data.results.filter(r => r.status === 'passed').length
            summary = `${data.results.length} 条 (${passed} passed)`
          } else if (f === 'figma-frame-inventory.json' && data.frames) {
            summary = `${data.frames.length} 个 frame`
          }
        } catch (e) { /* ignore */ }
      }
      artifacts.push({ name: f, path: `.codebuddy/plans/${storyId}/${f}`, summary })
    }
  }

  return artifacts
}

/**
 * 获取下一步指引
 * @param {number} completedPhase
 * @param {string} storyId
 * @returns {string[]}
 */
function getNextSteps (completedPhase, storyId) {
  const next = completedPhase + 1
  // 注意: Spawn 时必须使用 agent 的注册名（frontmatter 的 name 字段，英文），
  // 中文仅为可读性标注。传中文名无法解析到 agent。
  const steps = {
    0: [
      `Spawn 任务规划师 (task-planner) → 拆解任务 DAG`,
      `生成 task-dag.md + task-dag.json (含 figmaLink)`,
      `运行: node advance-phase.js ${storyId} 2`
    ],
    1: [
      `dev-pass 已签发，可编辑 src/`,
      `Fork → 并行 spawn 前端开发工程师 (frontend-developer) (注入 figmaLink + AC)`,
      `Join → npm run lint → node advance-phase.js ${storyId} 3`
    ],
    2: [
      `dev-pass 已撤销，禁止直接编辑 src/`,
      `Spawn 代码审查师 (code-reviewer) → git diff → code-review.json`,
      `无 BLOCKER → node advance-phase.js ${storyId} 4`
    ],
    3: [
      `Spawn 测试工程师 (test-engineer) → 用例设计 + 接口验证`,
      `生成 test-report.md + acceptance-verification.json`,
      `100% AC passed → node advance-phase.js ${storyId} 5`
    ],
    4: [
      `Spawn 发布助手 (release-assistant) → git add + commit + push`,
      `禁止 --no-verify → node advance-phase.js ${storyId} 6`
    ],
    5: [
      `Spawn 发布助手 (release-assistant) → kb-update Skill`,
      `保留手工批注 → node advance-phase.js ${storyId} 7`
    ],
    6: [
      `Spawn 发布助手 (release-assistant) → devops MCP`,
      `构建 + 部署 → node advance-phase.js ${storyId} 8`
    ],
    7: [`🎉 工作流完成！`]
  }
  return steps[completedPhase] || ['未知下一步']
}

/**
 * 获取应加载的契约文件清单
 * @param {string} storyId
 * @param {number} phase
 * @returns {string[]}
 */
function getContractFiles (storyId, phase) {
  // 下个 Phase 需要的契约文件
  const nextPhase = phase + 1
  const storyDir = getStoryDir(storyId)
  const baseContracts = {
    1: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json', '.codebuddy/plans/' + storyId + '/task-dag.json'],
    2: ['.codebuddy/plans/' + storyId + '/task-dag.json', '.codebuddy/plans/' + storyId + '/acceptance-criteria.json'],
    3: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json'],
    4: ['.codebuddy/plans/' + storyId + '/acceptance-criteria.json', '.codebuddy/plans/' + storyId + '/acceptance-verification.json'],
    5: ['.codebuddy/plans/' + storyId + '/acceptance-verification.json'],
    6: [],
    7: []
  }
  const contracts = [...(baseContracts[nextPhase] || [])]

  // 修复回路上下文：Phase 3 审查时，如果存在 fix-request.json，
  // 增加修复相关契约文件供审查师加载（增量审查锚点）
  if (nextPhase === 3) {
    const fixRequestFile = path.join(storyDir, 'fix-request.json')
    if (fs.existsSync(fixRequestFile)) {
      contracts.push('.codebuddy/plans/' + storyId + '/fix-request.json')
      contracts.push('.codebuddy/plans/' + storyId + '/fix-context.md')
      const fixVerificationFile = path.join(storyDir, 'fix-verification.json')
      if (fs.existsSync(fixVerificationFile)) {
        contracts.push('.codebuddy/plans/' + storyId + '/fix-verification.json')
      }
    }
  }

  return contracts
}

/**
 * 加载指定 Story 的最新 Phase summary 内容
 * 用于将上轮产出物摘要注入到下个 Agent 的 prompt 或 session-start additionalContext 中
 * 只加载编号不超过 currentPhase 的 summary（避免显示后续 Phase 的摘要）
 * @param {string} storyId - Story ID
 * @param {number} [currentPhase=Infinity] - 当前 Phase 编号，只取不超过此编号的 summary
 * @param {number} [maxLines=200] - 最大行数限制，防止 summary 过大占用过多上下文
 * @returns {{ content: string, phase: number, path: string }|null} summary 信息，不存在时返回 null
 */
function loadLatestSummary (storyId, currentPhase = Infinity, maxLines = 200) {
  const storyDir = getStoryDir(storyId)
  if (!fs.existsSync(storyDir)) return null

  // 找到编号不超过 currentPhase 的最大 summary 文件（降序排列取第一个符合条件的）
  const summaryRegex = /^phase-(\d+)-summary\.md$/
  const files = fs.readdirSync(storyDir)
    .filter(f => {
      const match = f.match(summaryRegex)
      if (!match) return false
      const phaseNum = parseInt(match[1], 10)
      return phaseNum <= currentPhase
    })
    .sort((a, b) => {
      const na = parseInt(a.match(summaryRegex)[1], 10)
      const nb = parseInt(b.match(summaryRegex)[1], 10)
      return nb - na
    })

  if (files.length === 0) return null

  // 读取最新的 summary（截取防止过大）
  const latestFile = files[0]
  const phaseNum = parseInt(latestFile.match(summaryRegex)[1], 10)
  const filePath = path.join(storyDir, latestFile)
  const rawContent = fs.readFileSync(filePath, 'utf-8')

  // 行数截取：超过 maxLines 时截断并添加提示
  const lines = rawContent.split('\n')
  let content
  if (lines.length > maxLines) {
    content = lines.slice(0, maxLines).join('\n') + `\n\n> ⚠️ summary 已截取前 ${maxLines} 行，完整内容见 ${latestFile}`
  } else {
    content = rawContent
  }

  return { content, phase: phaseNum, path: filePath }
}

module.exports = {
  generatePhaseSummary,
  getPhaseArtifacts,
  getNextSteps,
  getContractFiles,
  loadLatestSummary
}
