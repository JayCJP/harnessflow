/**
 * paths.js — 项目路径解析与 Story 目录（零依赖底座）
 *
 * 职责:
 *   - 归一化项目根路径（兼容 Windows Git Bash / MSYS 风格盘符），派生 PROJECT_ROOT / PLANS_DIR
 *   - Story 目录的解析、创建与枚举
 *   - e2e-state.json 的路径形态判定
 *
 * 用法:
 *   const { PLANS_DIR, getStoryDir } = require('./paths')
 *
 * 说明:
 *   - **本模块只依赖 node 内建 fs/path，不得 require 本仓库任何其他模块**。
 *     这是它存在的意义：state.js / debug-log.js / trace.js 原先互相 require 形成
 *     加载期循环依赖（state 顶层 require debug-log，debug-log 惰性 require state 拿
 *     getStoryDir），三者改为依赖本模块后环即断开，惰性 require 的 hack 得以删除。
 *     一旦这里 require 了上层模块，环会立刻复原。
 *   - PROJECT_ROOT / PLANS_DIR 是**模块加载期求值**的（读 CODEBUDDY_PROJECT_DIR，
 *     回退 CLAUDE_PROJECT_DIR，再回退 cwd）。测试沙箱必须在 require 之前设好这两个
 *     环境变量，只设其中一个会导致沙箱失效、读到真实项目目录。
 *   - isSrcFile 不在此处：它依赖 repos.json 反查（getRepoForFile），属于仓库注册表层，
 *     放进来会破坏零依赖约束。
 *
 * @module paths
 */

const fs = require('fs')
const path = require('path')

/**
 * 归一化项目根路径，兼容 Windows 下 Git Bash / MSYS 风格路径
 *
 * 宿主在 Git Bash 环境下注入的 CLAUDE_PROJECT_DIR（CodeBuddy 兼容该别名）
 * 可能是 POSIX 风格（如 "/d/workfile/xxx" 或 "/c/Users/xxx"）。Windows 上
 * Node 的 path.join 会把 "/d/workfile" 当作当前盘符下的绝对路径，解析成
 * "d:\d\workfile\xxx"（多出一层盘符名目录），导致状态文件写错位置。
 * 此函数在 Windows 平台把 "/<盘符>/rest" 还原为 "<盘符>:/rest"。
 *
 * @param {string} p - 原始路径（可能是 POSIX 风格）
 * @returns {string} 归一化后的路径
 */
function normalizeProjectRoot (p) {
  if (!p) return p
  // 仅在 Windows 平台处理 Git Bash / MSYS 风格盘符路径
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])\/(.*)$/.exec(p)
    if (m) {
      // "/d/workfile/xxx" → "d:/workfile/xxx"
      return `${m[1]}:/${m[2]}`
    }
  }
  return p
}

/** 项目根目录 */
const PROJECT_ROOT = normalizeProjectRoot(
  process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()
)

/** plans 目录 */
const PLANS_DIR = path.join(PROJECT_ROOT, '.codebuddy', 'plans')

/**
 * 获取指定 Story 的子目录路径
 * @param {string} storyId - Story ID
 * @returns {string} Story 子目录的绝对路径
 */
function getStoryDir (storyId) {
  return path.join(PLANS_DIR, storyId)
}

/**
 * 确保 Story 目录存在（如不存在则创建）
 * @param {string} storyId - Story ID
 */
function ensureStoryDir (storyId) {
  const dir = getStoryDir(storyId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * 列出所有 Story 子目录
 * @returns {string[]} 目录名称列表（即 storyId）
 */
function listStoryDirs () {
  if (!fs.existsSync(PLANS_DIR)) return []
  return fs.readdirSync(PLANS_DIR).filter(d => {
    const stat = fs.statSync(path.join(PLANS_DIR, d))
    return stat.isDirectory()
  })
}

/**
 * 检查文件路径是否为 e2e-state.json 状态文件
 * @param {string} filePath - 文件路径
 * @returns {boolean}
 */
function isStateFile (filePath) {
  if (!filePath) return false
  const normalized = path.normalize(filePath).replace(/\\/g, '/')
  return normalized.endsWith('/e2e-state.json') && normalized.includes('/plans/')
}

module.exports = {
  normalizeProjectRoot,
  PROJECT_ROOT,
  PLANS_DIR,
  getStoryDir,
  ensureStoryDir,
  listStoryDirs,
  isStateFile
}
