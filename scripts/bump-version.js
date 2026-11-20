#!/usr/bin/env node
/**
 * bump-version.js — 统一更新 harness 插件版本号，杜绝「多处声明漏改」
 *
 * 背景（2026-11-20 事故）：
 *   插件版本散落在 8 处。第一次发 2.3.2 时只改了顶层 plugin.json + 两份市场清单，
 *   漏了 .claude-plugin / .codebuddy-plugin / .codex-plugin 三份 manifest（安装器实际读的那份），
 *   导致 /plugin list 一直显示 2.3.1；此外 .plugins-cache.json 还缓存了一份旧版本 + 旧 manifestMtime，
 *   安装器据此判断「manifest 未变化」不再重新解析。本脚本是这些「当前版本声明」的唯一更新入口。
 *
 * 用法：
 *   node scripts/bump-version.js <new-version>   # 升版本并全员对齐
 *   node scripts/bump-version.js --sync          # 不升版本，以主清单为准对齐所有遗漏点
 *   node scripts/bump-version.js --check         # 只校验一致性，不修改（CI / pre-commit 可用）
 *
 * 设计原则：
 *   1. 声明点集中登记在 DECLARATIONS，新增位置时只加一处，不散落各处手写正则。
 *   2. 用「精确字符串替换」而非 JSON.stringify 重写，避免重排键顺序产生巨量 diff。
 *   3. 替换前后都做 JSON.parse 校验，写坏即报错退出。
 *   4. 语义隔离：只改「当前版本声明」，绝不碰「历史版本标记」
 *      （CODEBUDDY.md:95、phases.js、metrics-aggregator.js 等处的「2.3.1 起 Phase 重排」是历史沿革，
 *       描述的是「从该版本开始」，不是「当前版本」，必须原样保留）。
 *   5. 路径全部基于脚本自身位置解析，不依赖调用时的 cwd。
 */

const fs = require('fs')
const path = require('path')

/** 仓库根目录（脚本在 <root>/scripts/ 下，故上溯一层） */
const ROOT = path.resolve(__dirname, '..')

/** 语义化版本正则：只接受 x.y.z（允许预发布/构建后缀，但本插件用纯三段） */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 当前版本声明点登记表
 *
 * 每项的职责：
 *   file       — 相对仓库根的路径
 *   label      — 人类可读说明（用于输出）
 *   kind       — 替换策略：'plugin-json' | 'marketplace-json' | 'readme-badge' | 'plugins-cache'
 *   tracked    — 是否被 git 跟踪（false 的项仍要改，但会标注「本地缓存」）
 *
 * 注意：不要在此登记「历史版本标记」类文本（见文件头原则 4）。
 */
const DECLARATIONS = [
  {
    file: 'plugins/harness/plugin.json',
    label: '插件主清单',
    kind: 'plugin-json',
    tracked: true
  },
  {
    file: 'plugins/harness/.claude-plugin/plugin.json',
    label: 'Claude Code manifest（安装器可能读此项）',
    kind: 'plugin-json',
    tracked: true
  },
  {
    file: 'plugins/harness/.codebuddy-plugin/plugin.json',
    label: 'CodeBuddy manifest（安装器读此项）',
    kind: 'plugin-json',
    tracked: true
  },
  {
    file: 'plugins/harness/.codex-plugin/plugin.json',
    label: 'Codex manifest（安装器可能读此项）',
    kind: 'plugin-json',
    tracked: true
  },
  {
    file: '.claude-plugin/marketplace.json',
    label: 'Claude 市场清单（harness 项）',
    kind: 'marketplace-json',
    tracked: true
  },
  {
    file: '.codebuddy-plugin/marketplace.json',
    label: 'CodeBuddy 市场清单（harness 项）',
    kind: 'marketplace-json',
    tracked: true
  },
  {
    file: 'README.md',
    label: 'README version badge',
    kind: 'readme-badge',
    tracked: true
  },
  {
    file: '.plugins-cache.json',
    label: '本地市场缓存（非入库，影响安装显示）',
    kind: 'plugins-cache',
    tracked: false
  }
]

/**
 * 读取声明点的当前版本
 *
 * @param {Object} decl - DECLARATIONS 中的一项
 * @returns {{ version: string|null, text: string, err: string|null }} 版本值、原文、错误
 */
function readDeclaration (decl) {
  const full = path.join(ROOT, decl.file)
  if (!fs.existsSync(full)) return { version: null, text: '', err: '文件不存在' }

  const text = fs.readFileSync(full, 'utf-8')
  if (decl.kind === 'readme-badge') {
    const m = text.match(/version-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)-blue/)
    return { version: m ? m[1] : null, text, err: m ? null : '未找到 version badge' }
  }

  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { version: null, text, err: `JSON 解析失败: ${e.message}` }
  }

  // 定位版本号所在字段（结构感知，不依赖行号）
  let version = null
  if (decl.kind === 'plugin-json') {
    version = data.version
  } else if (decl.kind === 'marketplace-json') {
    const harness = (data.plugins || []).find(p => p && p.name === 'harness')
    version = harness ? harness.version : null
  } else if (decl.kind === 'plugins-cache') {
    const harness = (data.plugins || []).find(p => p && p.name === 'harness')
    version = harness ? harness.version : null
  }

  return {
    version: typeof version === 'string' ? version : null,
    text,
    err: version == null ? '未找到 harness 的 version 字段' : null
  }
}

/**
 * 按声明点类型做精确替换（不重写整个 JSON，避免键顺序变动）
 *
 * @param {Object} decl - 声明点
 * @param {string} text - 原文本
 * @param {string} oldV - 旧版本
 * @param {string} newV - 新版本
 * @returns {string} 替换后的文本
 */
function replaceDeclaration (decl, text, oldV, newV) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  if (decl.kind === 'readme-badge') {
    return text.replace(
      new RegExp(`version-${esc(oldV)}-blue`),
      `version-${newV}-blue`
    )
  }

  if (decl.kind === 'plugin-json') {
    // 只替换顶层第一个 "version": "<old>"（plugin.json 版本声明在第 3 行，唯一）
    return text.replace(
      new RegExp(`("version"\\s*:\\s*")${esc(oldV)}(")`),
      `$1${newV}$2`
    )
  }

  if (decl.kind === 'marketplace-json' || decl.kind === 'plugins-cache') {
    // 定位 "name": "harness" 之后最近的 "version": "<old>"，避免误改市场清单自身的 1.0.1
    const re = new RegExp(
      `("name"\\s*:\\s*"harness"[\\s\\S]*?"version"\\s*:\\s*")${esc(oldV)}(")`
    )
    return text.replace(re, `$1${newV}$2`)
  }

  throw new Error(`未知声明点类型: ${decl.kind}`)
}

/**
 * 校验替换后的文本仍可解析（README 除外，走 badge 断言）
 *
 * @param {Object} decl - 声明点
 * @param {string} text - 替换后文本
 * @returns {string|null} 错误信息，null 表示通过
 */
function verifyReplacement (decl, text) {
  if (decl.kind === 'readme-badge') {
    return /version-\d+\.\d+\.\d+-blue/.test(text) ? null : '替换后 badge 格式非法'
  }
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    return `替换后 JSON 解析失败: ${e.message}`
  }
}

/**
 * 刷新本地缓存的 manifestMtime，迫使安装器重新解析源 manifest
 * （这是 2.3.1 一直显示不更新的最后一道缓存：mtime 不变则安装器认为 manifest 未变化）
 *
 * @param {string} text - .plugins-cache.json 原文
 * @returns {string} 新文本
 */
function refreshCacheMtime (text) {
  return text.replace(
    /("manifestMtime"\s*:\s*)[\d.]+/,
    `$1${Date.now()}`
  )
}

/**
 * 主流程
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {number} 退出码：0 成功，1 失败
 */
function main (argv) {
  const checking = argv.includes('--check')
  const syncing = argv.includes('--sync')
  const args = argv.filter(a => a !== '--check' && a !== '--sync')
  const newVersion = args[0]

  console.log(`仓库根: ${ROOT}`)
  console.log('')

  // ── 读取所有声明点 ───────────────────────────────────────────
  const states = DECLARATIONS.map(decl => ({ decl, ...readDeclaration(decl) }))

  // ── --check 模式：只报告一致性 ──────────────────────────────
  if (checking) {
    const versions = [...new Set(states.filter(s => s.version).map(s => s.version))]
    let bad = false
    for (const s of states) {
      if (s.err) {
        console.log(`  ✗ ${s.decl.file}: ${s.err}`)
        bad = true
      } else {
        const mark = versions.length === 1 ? '✓' : ' '
        console.log(`  ${mark} ${s.decl.file}: ${s.version}  (${s.decl.label})`)
      }
    }
    if (versions.length > 1) {
      console.log(`\n✗ 版本不一致: ${versions.join(' / ')}`)
      return 1
    }
    if (bad) return 1
    console.log(`\n✓ 全部 ${states.length} 处声明一致: ${versions[0]}`)
    return 0
  }

  // ── 更新模式：--sync 以主清单为准，否则必须给新版本号 ─────────
  // 基准版本取自插件主清单（第一个声明点）
  const baseline = states[0].version
  if (!baseline) {
    console.error(`✗ 无法从 ${states[0].decl.file} 读取当前版本`)
    return 1
  }

  const target = syncing ? baseline : newVersion
  if (!target) {
    console.error('用法: node scripts/bump-version.js <new-version> | --sync | --check')
    return 1
  }
  if (!SEMVER_RE.test(target)) {
    console.error(`✗ 版本号格式非法: ${target}（应为 x.y.z）`)
    return 1
  }
  if (!syncing && baseline === target) {
    console.error(`✗ 版本已是 ${target}，无需更新（如要对齐遗漏的声明点请用 --sync）`)
    return 1
  }

  console.log(`当前版本: ${baseline} → 目标版本: ${target}${syncing ? '  (--sync 对齐模式)' : ''}\n`)

  // drift 与缺失只警告不中止 —— 版本号本就该全员一致，drift 是遗漏而非有意手改，
  // 本脚本的目标正是把它们统一到 target。真正中止的只有「无法读取版本」。
  const drift = states.filter(s => s.version && s.version !== target)
  if (drift.length > 0) {
    console.log('  ⚠ 以下声明点与目标版本不一致，将一并对齐:')
    for (const s of drift) console.log(`      ${s.decl.file}: ${s.version}`)
  }
  const missing = states.filter(s => !s.version)
  if (missing.length > 0) {
    console.error('✗ 以下声明点无法读取版本，拒绝批量更新:')
    for (const s of missing) console.error(`    ${s.decl.file}: ${s.err || '无版本'}`)
    return 1
  }

  // ── 逐点替换并写回 ───────────────────────────────────────────
  // 注意：oldV 用每个声明点自身的当前版本（s.version），而非基准 —— 这样 drift 点
  // （如 README 仍是 2.3.1 而主清单是 2.3.2）也能被正确替换，否则正则找不到目标串。
  for (const s of states) {
    const full = path.join(ROOT, s.decl.file)
    let text = replaceDeclaration(s.decl, s.text, s.version, target)

    // 本地缓存额外刷新 mtime，破除安装器「manifest 未变化」判断
    if (s.decl.kind === 'plugins-cache') {
      text = refreshCacheMtime(text)
    }

    const err = verifyReplacement(s.decl, text)
    if (err) {
      console.error(`✗ ${s.decl.file}: ${err} —— 未写入`)
      return 1
    }
    fs.writeFileSync(full, text, 'utf-8')
    console.log(`  ✓ ${s.decl.file}: ${s.version} → ${target}` + (s.decl.tracked ? '' : '  (本地缓存)'))
  }

  // ── 写后复核 ─────────────────────────────────────────────────
  const after = DECLARATIONS.map(decl => ({ decl, ...readDeclaration(decl) }))
  const wrong = after.filter(s => s.version !== target)
  if (wrong.length > 0) {
    console.error('\n✗ 写后复核失败，以下声明点未更新:')
    for (const s of wrong) console.error(`    ${s.decl.file}: ${s.version || s.err}`)
    return 1
  }

  console.log(`\n✓ 全部 ${DECLARATIONS.length} 处声明已更新为 ${target}`)
  console.log('')
  console.log('下一步：')
  console.log('  1. cd plugins/harness && npm test   # 确认测试仍全绿')
  console.log(`  2. git add -A && git commit -m "chore: bump version to ${target}"`)
  console.log('  3. git push')
  console.log('  4. /plugin uninstall harness@harness-marketplace && /plugin install harness@harness-marketplace')
  console.log('     （或直接在 CodeBuddy 重新安装插件以加载新版本）')
  return 0
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)))
}

module.exports = { main, DECLARATIONS, readDeclaration, replaceDeclaration }
