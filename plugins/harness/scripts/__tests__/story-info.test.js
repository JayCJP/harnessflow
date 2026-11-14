#!/usr/bin/env node
/**
 * story-info.json（Story 身份卡）回归测试
 *
 * 覆盖「归档后 Story 相关元信息不丢失」这条需求:
 *   1. 建流时写入 story-info.json（storyId / mode / sources / repos / workflowRoot）
 *   2. sources 由 story-input.json 原样投影（TAPD 链接 / 工作区 / 需求 id）
 *   3. 归档时身份卡不被移动，root 只剩它与 archive/
 *   4. 归档后防重复归档判据忽略身份卡（不能因它重判为「未归档」）
 *   5. restore 后身份卡仍在，状态回 running
 *   6. 老 Story（无身份卡）归档时不报错，storyInfoUpdated=false
 *
 * 无外部依赖，用临时 CLAUDE_PROJECT_DIR 做沙箱，跑完自动清理。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱: 必须在 require 业务模块之前建好（PLANS_DIR 模块加载期求值） ──
const sandbox = makeSandbox('harness-storyinfo-')
const SANDBOX = sandbox.root
const storyDir = sandbox.storyDir

const { createWorkflow, refreshStoryInput } = require(path.join(SCRIPTS_DIR, 'commands/create-workflow'))
const { readStoryInfo, getStoryInfoPath } = require(path.join(SCRIPTS_DIR, 'lib/story-info'))

const ENV = { ...process.env, CODEBUDDY_PROJECT_DIR: SANDBOX, CLAUDE_PROJECT_DIR: SANDBOX }

/**
 * 以子进程运行 archive-story.js
 * @param {string[]} args - 命令行参数
 * @returns {{ status: number, out: Object|null, stdout: string, stderr: string }}
 */
function runArchive (args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'commands/archive-story.js'), ...args], {
    encoding: 'utf-8',
    env: ENV
  })
  let out = null
  try { out = JSON.parse(r.stdout) } catch (e) { /* 非 JSON 输出留空 */ }
  return { status: r.status, out, stdout: r.stdout || '', stderr: r.stderr || '' }
}

/**
 * 把 story-input.json 写到沙箱里的独立位置（模拟建流前用户给的输入文件）
 * @param {string} name - 文件名
 * @param {Object} obj - 内容
 * @returns {string} 文件绝对路径
 */
function stageInput (name, obj) {
  const p = path.join(SANDBOX, name)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
  return p
}

const TAPD_URL = 'https://www.tapd.cn/tapd_fe/10109441/story/detail/1010944999'

// ════════════════════════════════════════════════════════════
section('1. 建流时写入身份卡，sources 原样投影')

{
  const input = stageInput('in-a.json', {
    mode: 'fixbugs',
    sources: {
      tapdUrl: TAPD_URL,
      workspaceId: '10109441',
      storyIdInTapd: '1010944999',
      owner: '测试处理人'
    }
  })
  const r = createWorkflow('SI-A', '归档元信息测试', false, false, 'run', { inputFile: input })

  ok('建流成功', r.success === true, JSON.stringify(r.errors))
  ok('返回 storyInfoFile', r.storyInfoFile === getStoryInfoPath('SI-A'), String(r.storyInfoFile))

  const info = readStoryInfo('SI-A')
  ok('身份卡已写入', Boolean(info) && !info._parseError, JSON.stringify(info))
  ok('storyId 正确', info.storyId === 'SI-A', info.storyId)
  ok('mode=fixbugs', info.mode === 'fixbugs', info.mode)
  ok('title 回填', info.title === '归档元信息测试', info.title)
  ok('tapdUrl 保留', info.sources.tapdUrl === TAPD_URL, info.sources.tapdUrl)
  ok('workspaceId 保留', info.sources.workspaceId === '10109441', info.sources.workspaceId)
  ok('storyIdInTapd 保留', info.sources.storyIdInTapd === '1010944999', info.sources.storyIdInTapd)
  ok('owner 保留', info.sources.owner === '测试处理人', info.sources.owner)
  ok('repos.primary 非空', typeof info.repos.primary === 'string' && info.repos.primary.length > 0, info.repos.primary)
  ok('workflowRoot 用正斜杠', !info.workflowRoot.includes('\\'), info.workflowRoot)
}

// ════════════════════════════════════════════════════════════
section('2. 旧通道（无 --input）+ --refresh-input 补全 sources')

{
  const r1 = createWorkflow('SI-B', '旧通道 story', false, false, 'run')
  ok('无 --input 建流成功', r1.success === true, JSON.stringify(r1.errors))

  const info1 = readStoryInfo('SI-B')
  ok('身份卡存在但 sources 为空', info1 && Object.keys(info1.sources).length === 0, JSON.stringify(info1.sources))

  // 模拟主 Agent 之后才写 story-input.json
  fs.writeFileSync(path.join(storyDir('SI-B'), 'story-input.json'), JSON.stringify({
    mode: 'run',
    storyId: 'SI-B',
    sources: { tapdUrl: TAPD_URL, workspaceId: '10109441' }
  }, null, 2))

  const r2 = refreshStoryInput('SI-B')
  ok('refresh 成功', r2.success === true, JSON.stringify(r2))
  ok('refresh 报告身份卡已更新', r2.storyInfoUpdated === true, String(r2.storyInfoUpdated))

  const info2 = readStoryInfo('SI-B')
  ok('sources.tapdUrl 已补全', info2.sources.tapdUrl === TAPD_URL, info2.sources.tapdUrl)
  ok('sources.workspaceId 已补全', info2.sources.workspaceId === '10109441', info2.sources.workspaceId)
}

// ════════════════════════════════════════════════════════════
section('3. 归档: 身份卡原地保留，root 只剩它与 archive/')

{
  // 造点产出物，确保归档确实有东西可搬
  fs.writeFileSync(path.join(storyDir('SI-A'), 'requirement-analysis.md'), '# 需求\n')

  const a = runArchive(['SI-A', 'archive', '--force'])
  ok('归档 exit 0', a.status === 0, a.stdout + a.stderr)
  ok('归档成功', a.out && a.out.success === true, a.stdout)
  ok('storyInfoUpdated=true', a.out && a.out.storyInfoUpdated === true, a.stdout)

  // debug.jsonl 是保留的运行时日志（归档自身会重建），其余文件都必须进归档
  const rootFiles = fs.readdirSync(storyDir('SI-A'), { withFileTypes: true })
    .filter(e => e.isFile()).map(e => e.name).sort()
  ok('root 只剩 story-info.json 与 debug.jsonl',
    rootFiles.join(',') === 'debug.jsonl,story-info.json', rootFiles.join(','))
  ok('archive/round-1/ 已生成', fs.existsSync(path.join(storyDir('SI-A'), 'archive', 'round-1')))
  ok('e2e-state.json 已进归档',
    fs.existsSync(path.join(storyDir('SI-A'), 'archive', 'round-1', 'e2e-state.json')))

  const info = readStoryInfo('SI-A')
  ok('身份卡 status=archived', info.status === 'archived', info.status)
  ok('身份卡 archiveRound=1', info.archiveRound === 1, String(info.archiveRound))
  ok('身份卡 archivedAt 有值', typeof info.archivedAt === 'string' && !isNaN(Date.parse(info.archivedAt)), info.archivedAt)
  ok('归档后 TAPD 信息仍可查', info.sources.tapdUrl === TAPD_URL, info.sources.tapdUrl)
}

// ════════════════════════════════════════════════════════════
section('4. 归档后判据: 忽略身份卡，仍判定为已归档')

{
  const again = runArchive(['SI-A', 'archive', '--force'])
  ok('重复归档被拒绝', again.status === 1, again.stdout)
  ok('错误信息指向 story-info.json 例外', Boolean(again.out && /story-info\.json/.test(again.out.error)), again.stdout)

  const st = runArchive(['SI-A', 'status'])
  ok('status exit 0', st.status === 0, st.stderr)
  ok('status.archived=true', st.out && st.out.archived === true, st.stdout)
  ok('status 带出 sources.tapdUrl', st.out && st.out.sources && st.out.sources.tapdUrl === TAPD_URL, st.stdout)

  const ls = runArchive(['SI-A', 'list'])
  ok('list.archived=true', ls.out && ls.out.archived === true, ls.stdout)
  ok('list 有 1 轮归档', ls.out && ls.out.totalArchives === 1, ls.stdout)
}

// ════════════════════════════════════════════════════════════
section('5. 复档: 身份卡保留，状态回 running')

{
  const rs = runArchive(['SI-A', 'restore', '--force'])
  ok('复档 exit 0', rs.status === 0, rs.stdout + rs.stderr)
  ok('storyInfoUpdated=true', rs.out && rs.out.storyInfoUpdated === true, rs.stdout)

  ok('root 存在 e2e-state.json', fs.existsSync(path.join(storyDir('SI-A'), 'e2e-state.json')))
  ok('story-info.json 仍在 root', fs.existsSync(getStoryInfoPath('SI-A')))

  const info = readStoryInfo('SI-A')
  ok('身份卡 status=running', info.status === 'running', info.status)
  ok('身份卡 restoredFromRound=1', info.restoredFromRound === 1, String(info.restoredFromRound))
  ok('归档历史仍保留 archivedAt', typeof info.archivedAt === 'string', String(info.archivedAt))
}

// ════════════════════════════════════════════════════════════
section('6. 老 Story（无身份卡）归档不报错')

{
  const r = createWorkflow('SI-OLD', '老 story', false, false, 'run')
  ok('建流成功', r.success === true, JSON.stringify(r.errors))
  fs.rmSync(getStoryInfoPath('SI-OLD'), { force: true })

  const a = runArchive(['SI-OLD', 'archive', '--force'])
  ok('无身份卡时归档仍成功', a.status === 0 && a.out && a.out.success === true, a.stdout + a.stderr)
  ok('storyInfoUpdated=false', a.out && a.out.storyInfoUpdated === false, a.stdout)

  const rootFiles = fs.readdirSync(storyDir('SI-OLD'), { withFileTypes: true })
    .filter(e => e.isFile()).map(e => e.name).sort()
  ok('老 Story 也无产出物残留（仅 debug.jsonl）',
    rootFiles.join(',') === 'debug.jsonl', rootFiles.join(','))
}

// ════════════════════════════════════════════════════════════
summarize(sandbox)
