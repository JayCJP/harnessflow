#!/usr/bin/env node
/**
 * 范围审计回归测试 —— 覆盖 2026-09 文件级限域从「写前拦截」改为「事后审计」的落地：
 *   1. getDeclaredScope 从 task-dag.json 提取声明范围（含去重与跨仓归仓）
 *   2. isFileInDeclaredScope 的三种匹配形态（精确文件 / 目录 pattern / glob）
 *   3. Phase 2→3 门控按 git 实际变更生成 scope-amendments.json 并给出 warning
 *   4. Phase 3 prompt 注入「范围外改动核对」段（无清单时不注入）
 *
 * 第 3 组需要真实 git 仓库（git status --porcelain 是唯一事实来源），
 * 故用 execSync 在沙箱内 git init 后保留未跟踪文件作为「变更」。
 *
 * 用法:
 *   node scripts/__tests__/scope-audit.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require state.js 之前建好，PLANS_DIR 是模块加载期求值的 ──
const sandbox = makeSandbox('harness-scope-')
const SANDBOX = sandbox.root
const storyDir = sandbox.storyDir

const { runGateCheck } = require(path.join(SCRIPTS_DIR, 'services/policy'))
const { getDeclaredScope, isFileInDeclaredScope } = require(path.join(SCRIPTS_DIR, 'lib/scope'))
const promptBuilder = require(path.join(SCRIPTS_DIR, 'services/prompt-builder'))

// ════════════════════════════════════════════════════════════
section('1. getDeclaredScope — 声明范围提取')

const dir1 = storyDir('SCOPE-DECL')
fs.mkdirSync(dir1, { recursive: true })
fs.writeFileSync(path.join(dir1, 'task-dag.json'), JSON.stringify({
  tasks: [
    { id: 'task-1', title: 'A', files: ['src/views/Foo.vue', 'src/api/'], acceptanceCriteria: ['AC-1'], parallelizable: false },
    { id: 'task-2', title: 'B', files: ['src/views/Foo.vue', 'src/views/Bar.vue'], acceptanceCriteria: ['AC-2'], parallelizable: false }
  ]
}))

const decl = getDeclaredScope('SCOPE-DECL')
ok('source=task-dag.json', decl.source === 'task-dag.json', decl.source)
ok('相同文件去重（Foo.vue 出现 2 次只留 1 条）', decl.paths.filter(p => p.path === 'src/views/Foo.vue').length === 1, JSON.stringify(decl.paths))
ok('共 3 条声明范围', decl.paths.length === 3, String(decl.paths.length))
ok('未注册仓库回退到 primary', decl.paths.every(p => p.repo), JSON.stringify(decl.paths))

// task-dag 缺失 → 声明范围为空且给出原因，而不是降级成 src/**
const missing = getDeclaredScope('SCOPE-NO-DAG')
ok('task-dag 缺失时 source=none', missing.source === 'none', missing.source)
ok('task-dag 缺失时 paths 为空', missing.paths.length === 0)
ok('task-dag 缺失时给出 warning', missing.warnings.length > 0, JSON.stringify(missing.warnings))

// ════════════════════════════════════════════════════════════
section('2. isFileInDeclaredScope — 匹配形态')

const patterns = [
  { repo: 'main', path: 'src/views/Foo.vue' },   // 精确文件
  { repo: 'main', path: 'src/api/' },            // 目录 pattern
  { repo: 'main', path: 'src/pages/*.vue' }      // 单层 glob
]
const repoRoot = path.join(SANDBOX, 'main-repo')
fs.mkdirSync(path.join(repoRoot, 'src/views'), { recursive: true })
fs.mkdirSync(path.join(repoRoot, 'src/api/v1'), { recursive: true })
fs.mkdirSync(path.join(repoRoot, 'src/pages/sub'), { recursive: true })
fs.writeFileSync(path.join(repoRoot, 'src/views/Foo.vue'), '<template/>\n')
fs.writeFileSync(path.join(repoRoot, 'src/api/v1/user.js'), 'export {}\n')
fs.writeFileSync(path.join(repoRoot, 'src/pages/Home.vue'), '<template/>\n')
fs.writeFileSync(path.join(repoRoot, 'src/pages/sub/Deep.vue'), '<template/>\n')
const repos = { primary: 'main', repos: { main: repoRoot } }

ok('精确文件命中', isFileInDeclaredScope(path.join(repoRoot, 'src/views/Foo.vue'), patterns, repos))
ok('精确文件不匹配同名不同目录的文件', !isFileInDeclaredScope(path.join(repoRoot, 'src/views/Foo2.vue'), patterns, repos))
ok('目录 pattern 命中任意层级', isFileInDeclaredScope(path.join(repoRoot, 'src/api/v1/user.js'), patterns, repos))
ok('单层 glob 只命中同层', isFileInDeclaredScope(path.join(repoRoot, 'src/pages/Home.vue'), patterns, repos))
ok('单层 glob 不穿透子目录', !isFileInDeclaredScope(path.join(repoRoot, 'src/pages/sub/Deep.vue'), patterns, repos))
ok('空范围一律不匹配', !isFileInDeclaredScope(path.join(repoRoot, 'src/views/Foo.vue'), [], repos))

// ════════════════════════════════════════════════════════════
section('3. Phase 2→3 门控生成 scope-amendments.json')

try {
  execSync('git init', { cwd: repoRoot, stdio: 'pipe' })
} catch (e) {
  console.log('  (跳过: 沙箱内无法 git init)')
}

// 范围内改动（Foo.vue 已声明）+ 范围外改动（other/*.vue 未声明）
fs.mkdirSync(path.join(repoRoot, 'src/other'), { recursive: true })
fs.writeFileSync(path.join(repoRoot, 'src/other/Legacy.vue'), '<template/>\n')

const dir3 = storyDir('SCOPE-GATE')
fs.mkdirSync(dir3, { recursive: true })
fs.writeFileSync(path.join(dir3, 'task-dag.json'), JSON.stringify({
  tasks: [{ id: 'task-1', title: 'A', files: ['src/views/Foo.vue'], acceptanceCriteria: ['AC-1'], parallelizable: false }]
}))
fs.writeFileSync(path.join(dir3, 'repos.json'), JSON.stringify({
  primary: 'main', repos: { main: repoRoot }, updatedAt: new Date().toISOString()
}))

const gate = runGateCheck('SCOPE-GATE', 2)
const amendPath = path.join(dir3, 'scope-amendments.json')
ok('生成 scope-amendments.json', fs.existsSync(amendPath))

if (fs.existsSync(amendPath)) {
  const amend = JSON.parse(fs.readFileSync(amendPath, 'utf-8'))
  const outList = (amend.outOfScope || []).map(f => f.path)
  ok('范围内文件不计入 outOfScope（src/views/Foo.vue）', outList.indexOf('src/views/Foo.vue') === -1, JSON.stringify(outList))
  ok('范围外文件被记入（src/other/Legacy.vue）', outList.some(p => p.indexOf('src/other/Legacy.vue') >= 0), JSON.stringify(outList))
  ok('非 src/ 文件不计入（相对路径都可能经过的文件被过滤）', !outList.some(p => p === 'task-dag.json'))
}
ok('范围审计不阻塞门控（不进 blockers）', gate.blockers.filter(b => String(b.type || '').indexOf('scope') >= 0).length === 0)
ok('范围外改动进入 warnings', gate.warnings.some(w => w.indexOf('范围外改动文件') >= 0), JSON.stringify(gate.warnings))

// ════════════════════════════════════════════════════════════
section('4. Phase 3 prompt 注入「范围外改动核对」')

const p3 = promptBuilder.buildAgentPrompt({ storyId: 'SCOPE-GATE', targetPhase: 3, summaryPhase: 2 })
ok('Phase 3 注入范围外核对段', p3.agentPrompt.includes('范围外改动核对'))
ok('Phase 3 列出具体文件', p3.agentPrompt.includes('src/other/Legacy.vue'))

const p3Clean = promptBuilder.buildAgentPrompt({ storyId: 'SCOPE-DECL', targetPhase: 3, summaryPhase: 2 })
ok('无清单时不注入该段（不会谎称「全部在范围内」）', !p3Clean.agentPrompt.includes('范围外改动核对'))

const p2 = promptBuilder.buildAgentPrompt({ storyId: 'SCOPE-GATE', targetPhase: 2, summaryPhase: 1 })
ok('非 Phase 3 不注入该段', !p2.agentPrompt.includes('范围外改动核对'))

summarize(sandbox)
