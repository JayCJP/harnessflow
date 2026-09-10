#!/usr/bin/env node
/**
 * fix-loop.js — --fix-loop: Phase 3/4 失败后的修复回路
 *
 * 职责:
 *   1. 从失败 Phase 的产出物提取待修复问题（code-review.json 的 open BLOCKER 为唯一
 *      唯一信源）
 *   2. 按失败源独立计数的修复预算做轮次校验（用尽 → 升级为人工介入）
 *   3. 写 fix-request.json + fix-context.md、归档本轮源产出物
 *   4. 回退到 Phase 2、重签 dev-pass、写回 e2e-state.json
 *   5. 委托 prompt-builder 生成开发者 spawnPrompt，输出结构化结果供主 Agent Spawn
 *
 * 用法（由 advance-phase.js 按 flag 分派，不直接被主 Agent 调用）:
 *   const { runFixLoop } = require('./phase-ops/fix-loop')
 *   const r = runFixLoop({ storyId, state, currentPhase, targetPhase, ADVANCE_CMD, ARCHIVE_CMD })
 *   emit(r.output); process.exit(r.exitCode)
 *
 * 使用场景:
 *   - Phase 3 代码审查报出 BLOCKER / Phase 4 验收未通过 → 回退 Phase 2 重修
 *
 * 说明:
 *   - 本模块只做「计算 + 落盘」，不 emit、不 process.exit：输出由主文件统一出口，
 *     保证 debug 留痕的 source 始终是 advance-phase.js
 *   - 跨仓 Story 中 issue.file 只是「问题出现位置」，修复点可能在别的仓库，
 *     故受影响文件按 issue.project / issue.repoPath 归仓（见 addAffectedFile 注释）
 */

const fs = require('fs')
const path = require('path')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  PHASE_SLUGS,
  getMaxFixRounds,
  loadRepos,
  writeStateFile,
  DEV_PASS_TTL,
  issueDevPass
} = require('../../lib/state')
const trace = require('../../lib/trace')
const promptBuilder = require('../../services/prompt-builder')

/**
 * 从 code-review.json 中提取 BLOCKER 级别问题
 *
 * 保留 issue 的 project/repoPath —— 跨仓 Story 中 issue.file 只是「问题出现位置」，
 * 修复点可能在别的仓库（如落地页），fix-loop 需据此把受影响文件定位到正确仓库。
 *
 * @param {string} storyDir - Story 目录路径
 * @returns {Array<{id: string, severity: string, file: string, line: string, description: string, suggestion: string, project: string|undefined, repoPath: string|undefined}>}
 *   提取失败或无 open BLOCKER 时返回空数组
 */
function extractFixIssuesFromReview (storyDir) {
  const crJsonPath = path.join(storyDir, 'code-review.json')
  if (!fs.existsSync(crJsonPath)) return []

  try {
    const crData = JSON.parse(fs.readFileSync(crJsonPath, 'utf-8'))
    const openBlockers = (crData.issues || []).filter(
      i => i.severity === 'BLOCKER' && i.status === 'open'
    )
    return openBlockers.map((b, idx) => ({
      id: b.id || `FIX-${String(idx + 1).padStart(2, '0')}`,
      severity: 'BLOCKER',
      file: b.file || '',
      line: b.line ? String(b.line) : '',
      description: b.title ? `${b.title}: ${b.description || ''}` : (b.description || ''),
      suggestion: b.suggestion || '',
      project: b.project || undefined,
      repoPath: b.repoPath || undefined
    }))
  } catch (e) {
    return []
  }
}

/**
 * 执行修复回路
 *
 * @param {Object} ctx - 上下文
 * @param {string} ctx.storyId - Story ID
 * @param {Object} ctx.state - e2e-state.json 解析对象（原地修改）
 * @param {number} ctx.currentPhase - 当前 Phase
 * @param {string} ctx.ADVANCE_CMD - advance-phase.js 的绝对调用形式（nextSteps 里给出）
 * @param {string} ctx.ARCHIVE_CMD - archive-story.js 的绝对调用形式（错误提示里给出）
 * @returns {{ exitCode: number, output: Object }} 退出码与待输出对象（output 由调用方 emit）
 */
function runFixLoop ({ storyId, state, currentPhase, ADVANCE_CMD, ARCHIVE_CMD }) {
  // 🛡️ 归档状态守卫：归档后产出物已移走，无法提取修复问题
  if (state.status === 'archived') {
    return {
      exitCode: 1,
      output: {
        error: `Story 已归档 (round ${state.archiveRound || '?'})，禁止 --fix-loop`,
        hint: '归档后的 Story 不支持修复回路。如需恢复，请先执行: ' + ARCHIVE_CMD + ' ' + storyId + ' restore'
      }
    }
  }

  const storyDir = path.join(PLANS_DIR, storyId)

  // 1. 从失败 Phase 的产出物中提取待修复问题
  let issues = []
  let sourcePhase = null
  let sourceFile = null

  // 从 code-review.json 提取未修复 BLOCKER（唯一信源）
  const extracted = extractFixIssuesFromReview(storyDir)
  if (extracted.length > 0) {
    issues = extracted
    sourcePhase = 3
    sourceFile = 'code-review.json'
  }

  // Phase 4（功能测试）移除前，此处还有 acceptance-verification.json / test-report.md 两条兜底信源。
  // 现修复回路只服务 Phase 3 代码审查，code-review.json 是**唯一**信源。

  if (issues.length === 0) {
    return {
      exitCode: 1,
      output: {
        status: 'no_issues_found',
        message: '未在 code-review.json 中找到可修复问题',
        hint: '如果确实需要修复，请手动创建 fix-request.json'
      }
    }
  }

  // 2. 修复预算按失败源独立计数（code-review 与 test 各 2 次，不共享额度）
  const MAX_FIX_ROUNDS = getMaxFixRounds(storyId)

  // 检查修复轮次
  const fixRequestPath = path.join(storyDir, 'fix-request.json')
  let currentRound = 0
  if (fs.existsSync(fixRequestPath)) {
    try {
      const prevFix = JSON.parse(fs.readFileSync(fixRequestPath, 'utf-8'))
      // round 独立计数：仅当上次 fix-loop 与本次同源才累加；跨源（review→test 或反之）视为该阶段首次
      currentRound = (prevFix.sourcePhase === sourcePhase) ? (prevFix.round || 0) : 0
    } catch (e) { /* 解析失败，从 0 开始 */ }
  }

  if (currentRound >= MAX_FIX_ROUNDS) {
    const sourceLabel = '代码审查 (Phase 3)'
    return {
      exitCode: 1,
      output: {
        action: 'human_intervention_required',
        status: 'fix_loop_exhausted',
        message: `已达 ${sourceLabel} 的最大修复轮次 (${MAX_FIX_ROUNDS})，需人工介入决策`,
        remainingIssues: issues.map(i => `${i.id}: ${i.description}`),
        escalation: [
          '1. 人工评审剩余 BLOCKER，判断是否可降级为 WARNING',
          '2. 联系需求分析师确认是否需要调整 AC',
          '3. 或联系任务规划师重新拆解任务'
        ],
        blockerCount: issues.length
      }
    }
  }

  const nextRound = currentRound + 1

  // 3. 提取受影响文件 —— 跨仓 Story 中 issue.file 只是「问题出现位置」，修复点可能在别的仓库
  //    （如跳转参数无人消费，问题报在跳出端，要改的是落地页）。
  //    收集规则：
  //      - issue.file：问题出现位置（必收）
  //      - issue.repoPath：若它是具体修复点文件（非仓库根路径）→ 作为额外受影响文件加入；
  //        若它是仓库根 → 仅用于把 issue.file 定位到该仓库
  //    据此把每个受影响文件归到正确仓库，避免跨仓修复时路径解析错位。
  const reposForFix = loadRepos(storyId)
  // 已注册仓库根路径集合，用于判断 repoPath 是「仓库根」还是「具体文件」
  const repoRoots = new Set(Object.values(reposForFix.repos).map(r => path.resolve(r).replace(/\\/g, '/')))
  const affectedFileRepo = {} // 文件(相对路径) → { repo, repoPath }

  /**
   * 登记一个受影响文件（同一路径只登记一次）
   * @param {string} relPath - 文件相对路径
   * @param {string} repoName - 目标仓库名（无效时回落到 primary）
   * @param {string} [explicitRepoPath] - 显式仓库路径
   * @returns {void}
   */
  function addAffectedFile (relPath, repoName, explicitRepoPath) {
    if (!relPath) return
    const trimmed = String(relPath).trim()
    if (!trimmed) return
    const validRepo = reposForFix.repos[repoName] ? repoName : reposForFix.primary
    if (!affectedFileRepo[trimmed]) {
      affectedFileRepo[trimmed] = { repo: validRepo, repoPath: explicitRepoPath || reposForFix.repos[validRepo] }
    }
  }

  for (const issue of issues) {
    const repoName = issue.project || reposForFix.primary
    // repoPath 是仓库根还是具体修复点文件？
    let repoPathIsRoot = false
    if (issue.repoPath) {
      const rpAbs = path.resolve(issue.repoPath).replace(/\\/g, '/')
      repoPathIsRoot = repoRoots.has(rpAbs)
    }
    // 修复点文件：repoPath 是具体文件（非仓库根）时采用；否则用 issue.file 并归到 project 仓库
    if (issue.repoPath && !repoPathIsRoot) {
      addAffectedFile(issue.repoPath, repoName, issue.repoPath)
    } else {
      addAffectedFile(issue.file, repoName, issue.repoPath)
    }
  }

  const affectedFiles = Object.keys(affectedFileRepo)

  // 4. 生成 fix-request.json
  const fixRequest = {
    source: 'code-review',
    sourcePhase,
    sourceFile,
    round: nextRound,
    maxRounds: MAX_FIX_ROUNDS,
    generatedAt: new Date().toISOString(),
    issues,
    affectedFiles,
    constraint: '⛔ 仅修复以上 affectedFiles 中的文件，禁止修改其他文件'
  }
  fs.writeFileSync(fixRequestPath, JSON.stringify(fixRequest, null, 2), 'utf-8')

  // 5. 归档当前 Phase 产出物（sourcePhase）
  const archiveDir = path.join(storyDir, 'archive')
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true })
  }
  if (sourcePhase && sourceFile) {
    const srcPath = path.join(storyDir, sourceFile)
    if (fs.existsSync(srcPath)) {
      const archivedPath = path.join(archiveDir, `${sourceFile}.fix-round-${nextRound}.archived`)
      fs.copyFileSync(srcPath, archivedPath)
    }
  }

  // 6. 回退到 Phase 2 + 重新运行 Phase 2
  const now = new Date()
  const phase2Key = '2_development'

  // 标记当前及中间 Phase 为 rolled_back
  for (let p = 3; p <= currentPhase; p++) {
    const phaseKey = `${p}_${PHASE_SLUGS[p]}`
    if (state.phases && state.phases[phaseKey]) {
      state.phases[phaseKey].status = 'rolled_back'
      state.phases[phaseKey].rolledBackAt = now.toISOString()
    }
  }

  // 重新启动 Phase 2
  if (!state.phases) state.phases = {}
  state.phases[phase2Key] = {
    status: 'running',
    startedAt: now.toISOString(),
    fixRound: nextRound
  }
  state.phase = 2
  state.status = 'running'
  state.updatedAt = now.toISOString()

  // 7. 重新签发 dev-pass（凭证不含文件清单 —— 文件级范围由 policy.js 在 Phase 2→3 按 git 变更审计）
  const devPass = issueDevPass(storyId, DEV_PASS_TTL, `Fix loop round ${nextRound}/${MAX_FIX_ROUNDS} (from Phase ${sourcePhase})`)

  // 8. 记录 trace
  trace.tracePhaseTransition(storyId, currentPhase, 2)
  trace.appendTrace(storyId, {
    type: 'fix_loop',
    phase: '2',
    from: String(currentPhase),
    sourcePhase: String(sourcePhase),
    round: String(nextRound),
    maxRounds: String(MAX_FIX_ROUNDS),
    issueCount: String(issues.length),
    result: 'prepared'
  })

  // 9. 持久化 state
  writeStateFile(storyId, state)

  // 9.5 生成 fix-context.md（上下文延续，供下轮审查/测试 Agent 加载）
  const fixContextPath = path.join(storyDir, 'fix-context.md')
  const issueListForContext = issues.map((i) =>
    `- **${i.id}** [${i.severity}]${i.file ? ` \`${i.file}${i.line ? ':' + i.line : ''}\`` : ''}\n  - 问题: ${i.description}\n  - 建议: ${i.suggestion || '请根据上下文分析并修复'}`
  ).join('\n')
  const fixContextContent = [
    `# 修复回路上下文 (第 ${nextRound}/${MAX_FIX_ROUNDS} 轮)`,
    '',
    `> Story: ${storyId} | 来源: Phase ${sourcePhase} (代码审查) | 生成时间: ${now.toISOString()}`,
    '> 本文件供下轮代码审查师/测试工程师加载，了解上轮发现的问题和本轮修复情况。',
    '',
    '## 上轮发现的问题',
    '',
    issueListForContext,
    '',
    '## 受影响文件',
    affectedFiles.length > 0 ? affectedFiles.map(f => `- \`${f}\``).join('\n') : '- 未明确（从 fix-request.json 获取）',
    '',
    '## 修复核对报告',
    '',
    '修复完成后，开发者会产出 `fix-verification.json`，逐项标记每个问题的修复状态（fixed/partially/skipped）。',
    '审查/测试时应以该文件为锚点，逐项核对修复是否到位。',
    '',
    '## 审查/测试指引',
    '',
    '- 优先复查 `affectedFiles` 中的文件改动',
    '- 逐项核对 `fix-verification.json` 中每个 FIX-XX 的修复状态',
    '- `status=skipped` 的问题需重点确认是否有合理理由',
    '- `status=partially` 的问题需重点复查是否完全修复',
    '- 确认修复未引入新的 BLOCKER',
    ''
  ].join('\n')
  fs.writeFileSync(fixContextPath, fixContextContent, 'utf-8')

  // 10. 构造 spawnPrompt —— P1-2: 统一委托 prompt-builder（单一信源），
  //     收编原先在此手写拼装的 prompt 体（「主 Agent 手写 prompt」缺陷的脚本侧变体）
  const spawnPrompt = promptBuilder.buildFixLoopSpawnPrompt({
    storyId,
    round: nextRound,
    maxRounds: MAX_FIX_ROUNDS,
    sourcePhase,
    issues,
    affectedFiles
  })

  // 11. 输出结构化结果
  return {
    exitCode: 0,
    output: {
      status: 'fix_loop_prepared',
      action: 'spawn_frontend_developer',
      storyId,
      sourcePhase,
      round: nextRound,
      maxRounds: MAX_FIX_ROUNDS,
      issueCount: issues.length,
      affectedFiles,
      fixRequestPath: path.relative(PROJECT_ROOT, fixRequestPath),
      devPassExpiresAt: devPass.expiresAt,
      spawnPrompt,
      nextSteps: [
        '1. 主 Agent 将上述 spawnPrompt 作为 Prompt Spawn 前端开发工程师 (agent 注册名: frontend-developer)',
        `2. 开发者修复完成后 → 主 Agent 执行: ${ADVANCE_CMD} ${storyId} 3`,
        `3. 如果 Phase 3/4 仍失败 → 再次执行: ${ADVANCE_CMD} ${storyId} 2 --fix-loop`,
        `4. 达到 ${MAX_FIX_ROUNDS} 轮上限 → 人工介入处理`
      ]
    }
  }
}

module.exports = { runFixLoop, extractFixIssuesFromReview }
