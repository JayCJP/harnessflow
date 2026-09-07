/**
 * _helpers.js — 测试公共设施（沙箱 / 断言 / 汇总）
 *
 * 职责:
 *   - makeSandbox: 创建临时项目根，同时设置 CODEBUDDY_PROJECT_DIR 与 CLAUDE_PROJECT_DIR，
 *     预建 .codebuddy/plans，并返回 storyDir() 与 cleanup()
 *   - ok / section: 断言与分段输出，命中数与失败项记录在模块级状态里
 *   - summarize: 打印「通过 x / y」并按失败数决定退出码
 *
 * 用法:
 *   const { makeSandbox, ok, section, summarize } = require('./_helpers')
 *
 *   // 沙箱必须在 require 被测模块之前建好（见下方说明）
 *   const sandbox = makeSandbox('harness-flow-')
 *   const state = require('../lib/state')
 *
 *   section('1. xxx')
 *   ok('断言名', cond, '失败时附加的细节')
 *   summarize(sandbox)          // 末尾调用，内部会 cleanup + process.exit
 *
 * 说明:
 *   - **沙箱必须在 require 被测模块之前调用**: state.js 的 PROJECT_ROOT / PLANS_DIR 是
 *     模块加载期求值的，晚设环境变量会让沙箱失效、测试读写真实项目目录。
 *     两个环境变量必须同时设置，只设其一同样会失效。
 *   - **沙箱是可选的**: experience-lessons.test.js 的 EXPERIENCE_DIR 由 __dirname 推导、
 *     不受环境变量影响，它有意不建沙箱、只断言结构性质。不要强制所有测试建沙箱。
 *   - 模块级 pass/failures 是有意为之: run-all.js 用 spawnSync 串行跑每个测试文件，
 *     每个文件是独立进程，不存在状态串台。
 *   - 本文件不以 .test.js 结尾，run-all.js 的发现规则不会把它当测试跑。
 *
 * @module __tests__/_helpers
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** 断言命中数 */
let pass = 0
/** 失败的断言名 */
const failures = []

/**
 * 创建测试沙箱：临时项目根 + 环境变量 + .codebuddy/plans 目录
 *
 * @param {string} [prefix] - 临时目录名前缀，便于在 tmp 里辨认来源
 * @returns {{ root: string, plansDir: string, storyDir: (id: string) => string, cleanup: () => void }}
 */
function makeSandbox (prefix = 'harness-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))

  // 两个都要设：宿主可能注入任一别名，只设其一会导致沙箱失效
  process.env.CODEBUDDY_PROJECT_DIR = root
  process.env.CLAUDE_PROJECT_DIR = root

  const plansDir = path.join(root, '.codebuddy', 'plans')
  fs.mkdirSync(plansDir, { recursive: true })

  return {
    root,
    plansDir,
    storyDir: id => path.join(plansDir, id),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch (e) { /* 清理失败不影响结论 */ }
    }
  }
}

/**
 * 断言
 * @param {string} name - 断言名（失败时进 failures 列表）
 * @param {*} cond - 判定条件，按真值处理
 * @param {string} [detail] - 失败时打印的附加细节（实际值等）
 */
function ok (name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? '  ->  ' + detail : ''}`)
  }
}

/**
 * 分段标题
 * @param {string} title - 段落标题
 */
function section (title) {
  console.log(`\n-- ${title} --`)
}

/**
 * 打印汇总并退出：全绿 exit 0，有失败 exit 1
 *
 * @param {{ cleanup?: () => void }} [sandbox] - makeSandbox 的返回值；传入则先清理临时目录
 * @returns {never}
 */
function summarize (sandbox) {
  if (sandbox && typeof sandbox.cleanup === 'function') sandbox.cleanup()

  const total = pass + failures.length
  console.log(`\n${'='.repeat(48)}`)
  if (failures.length === 0) {
    console.log(`通过 ${pass} / ${total}   [全绿]`)
    process.exit(0)
  } else {
    console.log(`通过 ${pass} / ${total}\n失败项:\n  - ${failures.join('\n  - ')}`)
    process.exit(1)
  }
}

module.exports = { makeSandbox, ok, section, summarize }
