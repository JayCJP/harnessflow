#!/usr/bin/env node
/**
 * /harness 工作流管理脚本
 *
 * 控制 harness engineering 流程的激活/关闭，通过 .harness-active 标记文件实现。
 *
 * 用法:
 *   node harness-workflow.js start <storyId> "<标题>"   ← 激活 harness 模式
 *   node harness-workflow.js end                          ← 关闭 harness 模式
 *   node harness-workflow.js status                       ← 查看当前状态
 *
 * 设计思路:
 *   - 用户输入 /harness 时，AI 调用 `start` 创建标记文件
 *   - enforce-dev-pass.js 检查标记文件：有 → 需 dev-pass，无 → 直接放行
 *   - 工作流完成后，AI 调用 `end` 删除标记文件
 *   - 标记文件内容记录当前 activated story，方便 status 查询
 */

const fs = require('fs')
const path = require('path')
const { ensureReposJson, readStateFile, loadRepos, PROJECT_ROOT, PLANS_DIR } = require('../lib/state')
const { createWorkflow } = require('./create-workflow')

// ─── 路径常量 ──────────────────────────────────────────────────
// PROJECT_ROOT / PLANS_DIR 单一信源: lib/state.js（含 CLAUDE_PROJECT_DIR 跨宿主回退）

/** harness 激活标记文件 */
const HARNESS_FLAG = path.join(PLANS_DIR, '.harness-active')

// ─── 工具函数 ──────────────────────────────────────────────────

/**
 * 确保 plans 目录存在
 */
function ensurePlansDir() {
  if (!fs.existsSync(PLANS_DIR)) {
    fs.mkdirSync(PLANS_DIR, { recursive: true })
  }
}

/**
 * 读取标记文件内容
 * @returns {Object|null} 标记内容，不存在时返回 null
 */
function readFlag() {
  if (!fs.existsSync(HARNESS_FLAG)) return null
  try {
    return JSON.parse(fs.readFileSync(HARNESS_FLAG, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * 写入标记文件
 * @param {Object} data - 标记数据
 */
function writeFlag(data) {
  ensurePlansDir()
  fs.writeFileSync(HARNESS_FLAG, JSON.stringify(data, null, 2), 'utf-8')
}

/**
 * 删除标记文件
 */
function deleteFlag() {
  if (fs.existsSync(HARNESS_FLAG)) {
    fs.unlinkSync(HARNESS_FLAG)
  }
}

// ─── 命令处理 ──────────────────────────────────────────────────

/**
 * 自动生成 Story ID
 * @returns {string} 格式为 STORY-YYYYMMDD-NN
 */
function generateStoryId() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `STORY-${today}`
  // 扫描已有 story，找到今日最大序号 +1
  let maxSeq = 0
  if (fs.existsSync(PLANS_DIR)) {
    const dirs = fs.readdirSync(PLANS_DIR, { withFileTypes: true })
    for (const d of dirs) {
      if (d.isDirectory() && d.name.startsWith(prefix)) {
        const seq = parseInt(d.name.split('-').pop(), 10)
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
      }
    }
  }
  return `${prefix}-${String(maxSeq + 1).padStart(2, '0')}`
}

/**
 * 激活 harness 模式
 * @param {string} [storyId] - Story ID，不提供则自动生成
 * @param {string} [title] - 需求标题，不提供则标记为"待定"
 */
function cmdStart(storyId, title) {
  // 检查是否已有激活的 harness
  const existing = readFlag()
  if (existing && existing.active) {
    console.log(JSON.stringify({
      ok: false,
      message: `⚠️ Harness 模式已激活 (storyId: ${existing.storyId} "${existing.title}")，请先执行 /harness end 结束当前工作流`,
      current: existing
    }))
    process.exit(0)
  }

  const id = storyId || generateStoryId()
  const name = title || '待定'

  // 多仓库唯一真实信源 = story 级 repos.json（由 AI 在 Phase 0/1 通过 ensureReposJson 预配置）
  // 不再依赖任何宿主环境变量（CODEBUDDY_WORKSPACES/CLAUDE_WORKSPACES 均非官方变量，且原实现存在变量名不一致 bug）
  // ensureReposJson: 若 repos.json 已存在（AI 预配置多仓库）则不覆盖，否则写入单仓库默认
  const reposConfig = ensureReposJson(id)

  const data = {
    active: true,
    storyId: id,
    title: name,
    activatedAt: new Date().toISOString(),
    primaryRepo: reposConfig.primary,
    repoCount: Object.keys(reposConfig.repos).length
  }

  writeFlag(data)

  // 内部调用 create-workflow.js 创建 e2e-state.json（断链修复）
  let workflowResult = null
  try {
    workflowResult = createWorkflow(id, name, false)
    if (workflowResult && workflowResult.success) {
      data.phase = workflowResult.phase
      data.e2eStateCreated = true
    }
  } catch (e) {
    // createWorkflow 失败不阻塞 start，AI 可后续手动补执行
    data.e2eStateCreated = false
    data.e2eStateError = e.message
  }

  console.log(JSON.stringify({
    ok: true,
    message: `✅ Harness 模式已激活\n   Story: ${id} "${name}"\n   Phase: 0 (需求分析)\n   标记文件: .codebuddy/plans/.harness-active` +
      (workflowResult?.success ? '\n   e2e-state.json: ✅ 已创建' : '\n   ⚠ e2e-state.json 创建失败，请手动执行: node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/create-workflow.js ' + id + ' "' + name + '"'),
    data
  }))
}

/**
 * 关闭 harness 模式
 */
function cmdEnd() {
  const existing = readFlag()

  if (!existing || !existing.active) {
    console.log(JSON.stringify({
      ok: true,
      message: 'ℹ️ Harness 模式未激活，无需关闭'
    }))
    process.exit(0)
  }

  const summary = {
    storyId: existing.storyId,
    title: existing.title,
    activatedAt: existing.activatedAt,
    completedAt: new Date().toISOString()
  }

  deleteFlag()

  console.log(JSON.stringify({
    ok: true,
    message: `✅ Harness 模式已关闭\n   Story: ${existing.storyId} "${existing.title}"\n   标记文件已删除，src/ 编辑恢复正常`,
    summary
  }))
}

/**
 * 查看当前 harness 状态
 */
function cmdStatus() {
  const existing = readFlag()

  if (!existing || !existing.active) {
    console.log(JSON.stringify({
      active: false,
      message: '🟢 普通模式 — src/ 编辑不受限制'
    }))
  } else {
    // phase 从 e2e-state.json 读取（唯一信源，避免与 .harness-active 不同步）
    const state = readStateFile(existing.storyId)
    const phase = (state && typeof state.phase === 'number') ? state.phase : 0
    // repos 从 story 级 repos.json 读取
    const repos = loadRepos(existing.storyId)
    console.log(JSON.stringify({
      active: true,
      message: `🔴 Harness 模式已激活\n   Story: ${existing.storyId} "${existing.title}"\n   激活时间: ${existing.activatedAt}\n   Phase: ${phase}\n   主仓库: ${repos.primary}\n   涉及仓库: ${Object.keys(repos.repos).join(', ')}\n   src/ 编辑需要 dev-pass`,
      data: { ...existing, phase, repoCount: Object.keys(repos.repos).length }
    }))
  }
}

// ─── 入口 ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'start':
    cmdStart(args[1], args.slice(2).join(' ').replace(/^["']|["']$/g, ''))
    break

  case 'end':
    cmdEnd()
    break

  case 'status':
    cmdStatus()
    break

  default:
    console.log([
      '/harness 工作流管理脚本',
      '',
      '用法:',
      '  node harness-workflow.js start <storyId> "<标题>"   激活 harness 模式',
      '  node harness-workflow.js end                          关闭 harness 模式',
      '  node harness-workflow.js status                       查看当前状态',
      '',
      '详细文档见: CODEBUDDY.md § /harness 工作流'
    ].join('\n'))
    process.exit(1)
}
