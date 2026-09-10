/**
 * scope.js — task-dag.json 声明范围的提取与匹配（越界审计的事实基准）
 *
 * 职责:
 *   - getDeclaredScope: 从 task-dag.json 的 files[] 提取「本 Story 声明会动的文件/目录」
 *   - isFileInDeclaredScope: 判断某个文件是否落在声明范围内（支持目录型 pattern 与 glob）
 *
 * 用法:
 *   const { getDeclaredScope, isFileInDeclaredScope } = require('./scope')
 *
 * 使用场景:
 *   - Phase 2→3 门控（policy.js）: 用实际 git 变更减去声明范围，得出「范围外改动」清单，
 *     落 scope-amendments.json 交 Phase 3 审查核对
 *
 * 说明:
 *   - 这里是 task-dag.json 之外唯一的匹配实现（此前在 dev-pass.js 与 enforce-dev-pass.js
 *     各有一份逐行同构的实现，两份一旦分叉，「声明范围」就没有唯一答案）。
 *   - 2026-09 之前的形态是「Phase 2 写文件时实时拦截范围外文件」—— 该 Hook 拦截已取消，
 *     原因有三:
 *       1. Phase 1 规划无法穷尽依赖（新增文件 / 跨模块公共组件 / 类型定义 / 跨仓适配），
 *          开发中出现范围外文件是常态而非异常，硬拦只会逼 Agent 绕道
 *       2. 原实现只匹配 Write/Edit 类工具，Bash 写入完全绕过 —— 守规矩的被卡，
 *          不守规矩的一跳就过，形成逆向淘汰
 *       3. 越界与否应以「实际改了什么」判定，而不是「打算改什么」
 *     现改为事后审计：以 git diff 为事实来源，不阻塞开发，改完对账。
 */

const fs = require('fs')
const path = require('path')
const { TASK_DAG_JSON_FILE, readJsonArtifact } = require('./contracts')
const { loadRepos } = require('./repos')

/**
 * 从 task-dag.json 提取本 Story 声明的改动范围
 *
 * task.project / task.repo 决定文件归属哪个仓库，缺省或未注册时回退到 primary。
 *
 * @param {string} storyId - Story ID
 * @returns {{ paths: Array<{repo:string, path:string}>, source: string, warnings: string[] }}
 *   paths: 声明范围（对象数组，去重）；
 *   source: 'task-dag.json' | 'none' —— 取不到时为 'none'，paths 为空；
 *   warnings: 取不到范围的原因，供调用方决定是否降级提示
 */
function getDeclaredScope (storyId) {
  const result = { paths: [], source: 'none', warnings: [] }
  const taskData = readJsonArtifact(storyId, TASK_DAG_JSON_FILE)
  const repos = loadRepos(storyId)

  if (!taskData || taskData._parseError) {
    result.warnings.push(`${TASK_DAG_JSON_FILE} 不存在或解析失败，无法判定声明范围`)
    return result
  }

  if (!Array.isArray(taskData.tasks) || taskData.tasks.length === 0) {
    result.warnings.push('task-dag.json 中无任务，无法判定声明范围')
    return result
  }

  // 收集所有 task 的 files，统一为 { repo, path } 对象格式（去重）
  const allFiles = new Set()
  for (const task of taskData.tasks) {
    if (!Array.isArray(task.files)) continue
    // 优先使用 task.project，其次 task.repo，缺省为 primary
    const repoName = task.project || task.repo || repos.primary
    // 验证 repo 是否已注册，未注册则回退到 primary
    const validRepo = repos.repos[repoName] ? repoName : repos.primary
    for (const f of task.files) {
      if (typeof f === 'string' && f.trim()) {
        allFiles.add(JSON.stringify({ repo: validRepo, path: f.trim() }))
      }
    }
  }

  if (allFiles.size === 0) {
    result.warnings.push('task-dag.json 中所有 task 的 files 均为空，无法判定声明范围')
    return result
  }

  result.source = TASK_DAG_JSON_FILE
  result.paths = [...allFiles].map(s => JSON.parse(s))
  return result
}

/**
 * 判断文件是否落在声明范围内
 *
 * 匹配规则（按优先级）:
 *   1. src/** 通配 —— 命中该仓库 src/ 下任意文件
 *   2. 目录型 pattern —— 以 / 结尾、pattern 为 '.'，或在磁盘上确实是目录，
 *      按目录前缀匹配该目录下任意层级文件（这是 task-dag.files 声明「模块目录」的用法）
 *   3. 其余 —— 按仓库根解析为绝对路径后转 glob 正则匹配（支持 * 与 **）
 *
 * @param {string} targetFile - 目标文件路径（绝对或相对）
 * @param {Array<{repo:string, path:string}>} declaredPaths - getDeclaredScope 得到的声明范围
 * @param {Object|string} [reposOrStoryId] - 已加载的 repos 配置 或 storyId（string）；不传则按单仓默认解析
 * @returns {boolean} 命中任一 pattern 即 true
 */
function isFileInDeclaredScope (targetFile, declaredPaths, reposOrStoryId) {
  if (!declaredPaths || declaredPaths.length === 0) return false

  let reposConfig
  if (typeof reposOrStoryId === 'string') {
    reposConfig = loadRepos(reposOrStoryId)
  } else if (reposOrStoryId && typeof reposOrStoryId === 'object') {
    reposConfig = reposOrStoryId
  } else {
    reposConfig = loadRepos()
  }
  const absTarget = path.resolve(targetFile).replace(/\\/g, '/')

  for (const p of declaredPaths) {
    let repoName, pattern

    if (typeof p === 'object' && p !== null && p.repo && p.path) {
      repoName = p.repo
      pattern = p.path
    } else if (typeof p === 'string') {
      // 兼容防御：旧格式字符串，归到 primary
      repoName = reposConfig.primary
      pattern = p
    } else {
      continue
    }

    const repoRoot = reposConfig.repos[repoName]
    if (!repoRoot) continue

    // src/** 通配：匹配该仓库 src/ 下任意文件
    if (pattern === 'src/**') {
      const srcDir = path.resolve(repoRoot, 'src').replace(/\\/g, '/') + '/'
      if (absTarget.indexOf(srcDir) === 0) return true
      continue
    }

    const absAllowed = path.resolve(repoRoot, pattern).replace(/\\/g, '/')

    // 目录型 pattern：以 / 结尾，或在磁盘上实际是目录 → 按目录前缀匹配任意层级文件
    let isPlainDirPattern = /\/$/.test(pattern) || pattern === '.'
    if (!isPlainDirPattern && absAllowed !== '') {
      // TOCTOU 保护：existsSync+statSync 间目录可能被删，statSync 失败按非目录降级（走 glob 正则）
      try {
        isPlainDirPattern = fs.statSync(absAllowed).isDirectory()
      } catch (_) { /* 目录不存在或不可访问，按非目录处理 */ }
    }
    if (isPlainDirPattern) {
      const dirAbs = /\/$/.test(absAllowed) ? absAllowed : absAllowed + '/'
      if (absTarget.indexOf(dirAbs) === 0) return true
      continue
    }

    // 精确文件或 glob 通配：转换为正则匹配
    const escaped = absAllowed.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    const r = '^' + escaped.replace(/\*\*/g, '__STARSTAR__').replace(/\*/g, '[^/]+').replace(/__STARSTAR__/g, '.*') + '$'
    try {
      if (new RegExp(r).test(absTarget)) return true
    } catch (e) { /* 正则构造失败按不匹配处理 */ }
  }
  return false
}

module.exports = { getDeclaredScope, isFileInDeclaredScope }
