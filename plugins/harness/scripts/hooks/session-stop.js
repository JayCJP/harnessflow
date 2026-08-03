#!/usr/bin/env node
/**
 * Stop Hook — Agent 回答结束时自动收尾
 *
 * ⚠️ 注册在 Claude Code 的 `Stop` 事件下，每轮回答结束都会触发（不是会话终止）。
 *    会话终止对应 `SessionEnd` 事件。
 *
 * 功能：
 * 1. 单次扫描所有工作流（活跃 + 已完成）
 * 2. 清理过期的 dev-pass 文件
 * 3. 从 trace.jsonl 沉淀 Hook 拒绝事件到经验库
 * 4. 所有工作流完成后自动结束 Harness 模式
 * 5. 输出 session 变更摘要
 *
 * 输入：stdin JSON
 * 输出：stdout JSON
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const {
  PROJECT_ROOT,
  PLANS_DIR,
  listStoryDirs,
  readStateFile,
  getPhaseName,
  revokeDevPass,
  readStdin
} = require('../lib/state')
const experience = require('../services/experience')

// ─── 常量 ────────────────────────────────────────────────────────

const HARNESS_ACTIVE_FILE = path.join(PLANS_DIR, '.harness-active')
const GIT_TIMEOUT = 5000

/** 非代码文件目录前缀，不计入 src 变更统计 */
const NON_SRC_PREFIXES = ['node_modules/', 'dist/', '.codebuddy/', '.git/']

// ─── 工作流扫描（单次迭代） ──────────────────────────────────────

/**
 * 单次扫描所有 Story 目录，同时分类为 active / completed
 * @returns {{ active: Array, completed: Array }}
 */
function scanAllWorkflows() {
  const dirs = listStoryDirs()
  const active = []
  const completed = []

  for (const dir of dirs) {
    const stateFile = path.join(PLANS_DIR, dir, 'e2e-state.json')
    if (!fs.existsSync(stateFile)) continue

    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      if (state.status === 'running' || state.status === 'paused') {
        active.push({ storyId: dir, state })
      } else if (state.status === 'completed') {
        completed.push({ storyId: dir, state })
      }
    } catch (_) { /* JSON 损坏，跳过 */ }
  }

  return { active, completed }
}

// ─── Git 变更检测 ────────────────────────────────────────────────

/** 安全执行 git 命令，失败返回空字符串 */
function safeGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT
    })
  } catch (_) {
    return ''
  }
}

/**
 * 获取本次 session 所有变更文件（去重）
 */
function getChangedFiles() {
  const staged = safeGit('diff --cached --name-only').split('\n').filter(Boolean)
  const unstaged = safeGit('diff --name-only').split('\n').filter(Boolean)
  const untracked = safeGit('ls-files --others --exclude-standard').split('\n').filter(Boolean)

  return [...new Set([...staged, ...unstaged, ...untracked])]
}

/** src/ 下是否有变更 */
function hasSrcChanges(files) {
  return files.some(f => {
    const n = f.replace(/\\/g, '/')
    return n.startsWith('src/') && !NON_SRC_PREFIXES.some(p => n.startsWith(p))
  })
}

// ─── 知识库更新 ──────────────────────────────────────────────────

function checkKbUpdateTasks(activeWorkflows, changedFiles) {
  if (!hasSrcChanges(changedFiles)) return []

  return activeWorkflows
    .filter(wf => {
      const dev = wf.state.phases?.['2_development']
      return dev?.status === 'completed'
    })
    .map(wf => ({
      storyId: wf.storyId,
      title: wf.state.title || '',
      reason: wf.state.phases?.['5_git_submit']?.commitHash
        ? `可增量更新 (commit: ${wf.state.phases['5_git_submit'].commitHash})`
        : '开发已完成，知识库未更新'
    }))
}

// ─── Dev-Pass 清理 ───────────────────────────────────────────────

function cleanupDevPasses() {
  if (!fs.existsSync(PLANS_DIR)) return

  const dirs = listStoryDirs()
  const now = new Date()
  let cleaned = 0

  for (const dir of dirs) {
    const fp = path.join(PLANS_DIR, dir, 'dev-pass.json')
    if (!fs.existsSync(fp)) continue
    try {
      const pass = JSON.parse(fs.readFileSync(fp, 'utf-8'))
      if (new Date(pass.expiresAt) < now) {
        fs.unlinkSync(fp)
        cleaned++
      }
    } catch (_) {
      try { fs.unlinkSync(fp); cleaned++ } catch (__) { /* 无法删除，放弃 */ }
    }
  }
  return cleaned
}

// ─── Trace 经验沉淀 ──────────────────────────────────────────────

function recordHookRejectionsFromTraces() {
  if (!fs.existsSync(PLANS_DIR)) return

  const dirs = listStoryDirs()
  let recorded = 0

  for (const dir of dirs) {
    const traceFile = path.join(PLANS_DIR, dir, 'trace.jsonl')
    if (!fs.existsSync(traceFile)) continue

    try {
      const lines = fs.readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line)
          if (entry.type === 'hook_rejection' && entry.recordFailure) {
            experience.recordHookFailure(entry.recordFailure, entry.phase ? parseInt(entry.phase) : -1, dir)
            recorded++
          }
        } catch (_) { /* 单行损坏 */ }
      }
    } catch (_) { /* 文件读取失败 */ }
  }

  return recorded
}

// ─── Harness 自动结束 ────────────────────────────────────────────

function autoEndHarness(activeWorkflows, completedWorkflows) {
  if (!fs.existsSync(HARNESS_ACTIVE_FILE)) {
    return { ended: false, message: 'Harness 模式未激活' }
  }
  if (activeWorkflows.length > 0) {
    return { ended: false, message: `${activeWorkflows.length} 个活跃工作流，保持 Harness 模式` }
  }
  if (completedWorkflows.length === 0) {
    return { ended: false, message: '无工作流记录，保持 Harness 模式（手动 /harness end）' }
  }

  try {
    fs.unlinkSync(HARNESS_ACTIVE_FILE)
    return {
      ended: true,
      message: `所有工作流已完成 (${completedWorkflows.map(w => w.storyId).join(', ')})，Harness 已自动关闭`
    }
  } catch (e) {
    return { ended: false, message: `标记文件删除失败: ${e.message}` }
  }
}

// ─── 摘要构建 ────────────────────────────────────────────────────

function buildSummary(activeWorkflows, completedWorkflows, changedFiles, harnessResult, kbTasks) {
  const srcFiles = changedFiles
    .filter(f => f.replace(/\\/g, '/').startsWith('src/'))
    .map(f => f.replace(/\\/g, '/'))

  return {
    sessionEndedAt: new Date().toISOString(),
    activeWorkflows: activeWorkflows.map(w => ({
      storyId: w.storyId,
      title: w.state.title || '',
      phase: w.state.phase,
      phaseName: getPhaseName(w.state.phase),
      status: w.state.status
    })),
    completedWorkflows: completedWorkflows.map(w => ({
      storyId: w.storyId,
      title: w.state.title || '',
      completedAt: w.state.completedAt || ''
    })),
    harness: {
      active: fs.existsSync(HARNESS_ACTIVE_FILE),
      ended: harnessResult.ended,
      message: harnessResult.message
    },
    changedFiles: { total: changedFiles.length, src: srcFiles },
    kbUpdateTasks: kbTasks
  }
}

// ─── 入口 ────────────────────────────────────────────────────────

function main() {
  const startedAt = Date.now()

  // 1. 单次扫描（替代之前的 findActive + findCompleted 两次扫描）
  const { active, completed } = scanAllWorkflows()

  // 2. 各环节独立执行，互不阻塞
  let changedFiles = []
  try { changedFiles = getChangedFiles() } catch (_) { /* 非 git 仓库 */ }

  let devPassCleaned = 0
  try { devPassCleaned = cleanupDevPasses() } catch (_) { /* 清理失败不阻塞 */ }

  let traceRecorded = 0
  try { traceRecorded = recordHookRejectionsFromTraces() } catch (_) {}

  const harnessResult = autoEndHarness(active, completed)

  const kbTasks = checkKbUpdateTasks(active, changedFiles)

  // 3. 构建输出
  const summary = buildSummary(active, completed, changedFiles, harnessResult, kbTasks)

  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: JSON.stringify(summary)
    }
  }

  console.log(JSON.stringify(output))

  // 诊断日志（stderr，不影响 stdout JSON）
  const elapsed = Date.now() - startedAt
  const parts = []
  if (active.length > 0) parts.push(`${active.length} active workflows`)
  if (completed.length > 0) parts.push(`${completed.length} completed`)
  if (devPassCleaned > 0) parts.push(`${devPassCleaned} expired dev-pass cleaned`)
  if (traceRecorded > 0) parts.push(`${traceRecorded} trace rejections recorded`)
  parts.push(`took ${elapsed}ms`)
  console.error(`[session-stop] ${parts.join(' | ')}`)

  return 0
}

main()
