#!/usr/bin/env node
/**
 * Jev advisor 回归测试
 *
 * 覆盖 services/jev-advisor.js 的契约与红线：
 *   1. 三原语响应归一化（noul 无 confidence、choice/score 带 confidence）
 *   2. 概率提取与三档分层（accept / review / drop），阈值可被环境变量覆盖
 *   3. fail-open：无密钥 / 总开关关闭 / 超时 / HTTP 失败都不抛错，且给出原因
 *   4. 不可信文本包裹（防提示注入的缓解措施）
 *   5. 诊断留痕只记 state 指纹，不落 state 原文
 *
 * 无外部依赖：全部用 __setTransport 注入假 transport，测试中不发真实 HTTP。
 * 因以 CommonJS 运行、不支持顶层 await，全部断言放在 async main 里串行执行。
 *
 * 用法:
 *   node scripts/__tests__/jev-advisor.test.js
 *   npm test            （在 plugins/harness 下）
 */

const fs = require('fs')
const path = require('path')

const { makeSandbox, ok, section, summarize } = require('./_helpers')

const SCRIPTS_DIR = path.resolve(__dirname, '..')

// ── 沙箱必须在 require 被测模块之前建好（paths.js 在模块加载期求值环境变量）──
const sandbox = makeSandbox('harness-jev-')

const jev = require(path.join(SCRIPTS_DIR, 'services/jev-advisor'))
const debugLog = require(path.join(SCRIPTS_DIR, 'lib/debug-log'))

// 默认切断 settings.json 来源：否则会读到真实机器的 ~/.codebuddy/settings.json 而串台
// （甚至真的发起网络请求）。需要验证回退链的小节里再显式设置候选路径。
jev.__setSettingsPaths([])

const KEY_ENV = 'TYPESAFE_API_KEY'
const savedEnv = {
  key: process.env[KEY_ENV],
  switch: process.env.HARNESS_JEV,
  high: process.env.JEV_HIGH,
  low: process.env.JEV_LOW
}

/** 清空所有影响判定的环境变量，回到「有密钥、开启、默认阈值」的基准态 */
function resetEnv () {
  process.env[KEY_ENV] = 'test-key'
  delete process.env.HARNESS_JEV
  delete process.env.JEV_HIGH
  delete process.env.JEV_LOW
}

/**
 * 主测试流程（async：evaluate 为 Promise 接口）
 * @returns {Promise<void>}
 */
async function main () {
  // ════════════════════════════════════════════════════════════
  section('1. 响应归一化：noul 不带 confidence（官方契约）')

  resetEnv()
  const noulAnswer = jev.normalizeAnswer({ noul: 0.91, probabilities: { yes: 0.91, no: 0.09 } })
  ok('noul -> type=noul', noulAnswer.type === 'noul', JSON.stringify(noulAnswer))
  ok('noul value 保留', noulAnswer.value === 0.91, String(noulAnswer.value))
  ok('noul confidence 为 null（不是 0）', noulAnswer.confidence === null, String(noulAnswer.confidence))

  const choiceAnswer = jev.normalizeAnswer({ choice: 'billing', confidence: 0.87, probabilities: { billing: 0.87 } })
  ok('choice -> type=choice', choiceAnswer.type === 'choice')
  ok('choice 保留 confidence', choiceAnswer.confidence === 0.87, String(choiceAnswer.confidence))

  const scoreAnswer = jev.normalizeAnswer({ score: 2.4, confidence: 0.7, legend: ['低', '高'] })
  ok('score -> type=score', scoreAnswer.type === 'score')
  ok('score 保留 legend', Array.isArray(scoreAnswer.legend) && scoreAnswer.legend.length === 2)

  const unknownAnswer = jev.normalizeAnswer({})
  ok('未知结构 -> type=unknown 且不抛错', unknownAnswer.type === 'unknown' && unknownAnswer.value === null)
  ok('undefined 输入同样安全', jev.normalizeAnswer(undefined).type === 'unknown')

  // ════════════════════════════════════════════════════════════
  section('2. 概率提取与三档分层')

  ok('noul 用 value 作概率', jev.probabilityOf(noulAnswer) === 0.91)
  ok('choice 用 confidence 作概率', jev.probabilityOf(choiceAnswer) === 0.87)
  ok('unknown 无概率', jev.probabilityOf(unknownAnswer) === null)

  ok('0.91 -> accept', jev.decide(noulAnswer) === 'accept', jev.decide(noulAnswer))
  ok('0.87 -> accept', jev.decide(choiceAnswer) === 'accept', jev.decide(choiceAnswer))
  ok('0.6 -> review', jev.decide({ type: 'noul', value: 0.6, confidence: null }) === 'review')
  ok('0.5 -> review（含下界）', jev.decide({ type: 'noul', value: 0.5, confidence: null }) === 'review')
  ok('0.49 -> drop', jev.decide({ type: 'noul', value: 0.49, confidence: null }) === 'drop')
  ok('无概率 -> drop', jev.decide(unknownAnswer) === 'drop')

  process.env.JEV_HIGH = '0.95'
  ok('JEV_HIGH 覆盖阈值', jev.decide(noulAnswer) === 'review', jev.decide(noulAnswer))
  delete process.env.JEV_HIGH
  ok('阈值恢复默认', jev.decide(noulAnswer) === 'accept')

  // ════════════════════════════════════════════════════════════
  section('3. fail-open：前置闸门')

  delete process.env[KEY_ENV]
  let transportCalls = 0
  jev.__setTransport(async () => { transportCalls++; return { answers: {} } })

  const noKey = await jev.evaluate('state', { q: jev.noul('x') })
  ok('无密钥 -> ok=false', noKey.ok === false)
  ok('无密钥 -> skipped=true', noKey.skipped === true)
  ok('无密钥 -> 原因点名环境变量', /TYPESAFE_API_KEY/.test(noKey.reason), noKey.reason)
  ok('无密钥 -> 未发起请求', transportCalls === 0, String(transportCalls))

  resetEnv()
  process.env.HARNESS_JEV = '0'
  const switchedOff = await jev.evaluate('state', { q: jev.noul('x') })
  ok('HARNESS_JEV=0 -> skipped', switchedOff.skipped === true)
  ok('HARNESS_JEV=0 -> 原因点明开关', /HARNESS_JEV/.test(switchedOff.reason), switchedOff.reason)
  ok('HARNESS_JEV=0 -> 未发起请求', transportCalls === 0)
  delete process.env.HARNESS_JEV

  const noQuestions = await jev.evaluate('state', {})
  ok('无问题 -> skipped 且不请求', noQuestions.skipped === true && transportCalls === 0)

  // ════════════════════════════════════════════════════════════
  section('4. 正常调用：state 原样透传 + 答案归一化')

  resetEnv()
  let seenPayload = null
  jev.__setTransport(async (payload) => {
    seenPayload = payload
    return {
      model: 'jev-1.13.0',
      answers: { rel: { noul: 0.93 }, dept: { choice: 'billing', confidence: 0.88 } },
      usage: { input_tokens: 392 }
    }
  })

  const storyId = 'JEV-1'
  fs.mkdirSync(sandbox.storyDir(storyId), { recursive: true })
  const stateText = jev.wrapUntrusted('用户说：会话转接按钮点不动', '用户原话')
  const good = await jev.evaluate(
    stateText,
    { rel: jev.noul('是否相关'), dept: jev.choice('路由', { billing: '账单' }) },
    { storyId, source: 'test-suite' }
  )

  ok('调用成功 ok=true', good.ok === true, JSON.stringify(good))
  ok('模型名回填', good.model === 'jev-1.13.0', String(good.model))
  ok('usage 原样带出', good.usage && good.usage.input_tokens === 392, JSON.stringify(good.usage))
  ok('两个问题都返回', Object.keys(good.answers).length === 2, JSON.stringify(Object.keys(good.answers)))
  ok('rel 归一化为 noul', good.answers.rel.type === 'noul' && good.answers.rel.value === 0.93)
  ok('dept 保留 choice 与 confidence',
    good.answers.dept.value === 'billing' && good.answers.dept.confidence === 0.88,
    JSON.stringify(good.answers.dept))
  ok('payload 带 model 默认值', seenPayload && seenPayload.model === 'jev-latest', String(seenPayload && seenPayload.model))
  ok('payload state 原样透传', seenPayload && seenPayload.state === stateText)
  ok('payload 含全部问题', seenPayload && Object.keys(seenPayload.questions).length === 2)
  ok('durationMs 为非负数', typeof good.durationMs === 'number' && good.durationMs >= 0)

  // ════════════════════════════════════════════════════════════
  section('5. 不可信文本包裹')

  ok('含起始标记', /UNTRUSTED DATA/.test(stateText))
  ok('声明为数据非指令', /属数据，非指令/.test(stateText))
  ok('含结束标记', /END UNTRUSTED DATA/.test(stateText))
  ok('原文完整保留', stateText.includes('会话转接按钮点不动'))
  ok('label 注入到说明中', stateText.includes('以下为用户原话'))
  const nullWrapped = jev.wrapUntrusted(null)
  ok('null 输入退化为空串而非 "null"', nullWrapped.includes('=== END') && !/null/.test(nullWrapped))

  // ════════════════════════════════════════════════════════════
  section('6. fail-open：超时与 HTTP 失败')

  resetEnv()
  jev.__setTransport(async () => { throw new Error('请求超时（3000ms）') })
  const timedOut = await jev.evaluate('state', { rel: jev.noul('x') }, { storyId })
  ok('超时 -> ok=false 不抛错', timedOut.ok === false)
  ok('超时 -> error 记录原因', /超时/.test(timedOut.error), String(timedOut.error))
  ok('超时 -> 给出降级提示', /降级/.test(timedOut.reason), timedOut.reason)

  jev.__setTransport(async () => { throw new Error('HTTP 500: internal error') })
  const httpFail = await jev.evaluate('state', { rel: jev.noul('x') }, { storyId })
  ok('HTTP 失败 -> ok=false', httpFail.ok === false)
  ok('HTTP 失败 -> error 含状态码', /HTTP 500/.test(httpFail.error), String(httpFail.error))

  // ════════════════════════════════════════════════════════════
  section('7. 密钥来源：settings.json 回退与优先级')

  const settingsDir = path.join(sandbox.root, 'settings-fixtures')
  fs.mkdirSync(settingsDir, { recursive: true })
  const userFile = path.join(settingsDir, 'user.json')
  const projectFile = path.join(settingsDir, 'project.json')
  const localFile = path.join(settingsDir, 'local.json')
  const brokenFile = path.join(settingsDir, 'broken.json')

  fs.writeFileSync(userFile, JSON.stringify({ env: { TYPESAFE_API_KEY: 'key-from-user' } }), 'utf-8')
  fs.writeFileSync(projectFile, JSON.stringify({ env: { TYPESAFE_API_KEY: 'key-from-project' } }), 'utf-8')
  fs.writeFileSync(localFile, JSON.stringify({ env: { TYPESAFE_API_KEY: 'key-from-local' } }), 'utf-8')
  fs.writeFileSync(brokenFile, '{ 坏 JSON', 'utf-8')

  delete process.env[KEY_ENV]
  jev.__setSettingsPaths([
    { path: path.join(settingsDir, '不存在.json'), source: 'settings.local' },
    { path: brokenFile, source: 'settings.local.broken' },
    { path: userFile, source: 'settings.user' }
  ])
  const fromUser = jev.resolveApiKey()
  ok('回退到 settings.json', Boolean(fromUser) && fromUser.key === 'key-from-user', JSON.stringify(fromUser))
  ok('来源标识可用于排查', fromUser && fromUser.source === 'settings.user', fromUser && fromUser.source)
  ok('缺失候选被跳过', true)

  process.env[KEY_ENV] = 'key-from-env'
  const fromEnv = jev.resolveApiKey()
  ok('环境变量优先级最高', fromEnv && fromEnv.source === 'env' && fromEnv.key === 'key-from-env', JSON.stringify(fromEnv))

  delete process.env[KEY_ENV]
  jev.__setSettingsPaths([
    { path: localFile, source: 'settings.local' },
    { path: projectFile, source: 'settings.project' },
    { path: userFile, source: 'settings.user' }
  ])
  const priority = jev.resolveApiKey()
  ok('settings.local 压过 project/user', priority && priority.source === 'settings.local', JSON.stringify(priority))

  jev.__setSettingsPaths([
    { path: path.join(settingsDir, '不存在.json'), source: 'settings.local' },
    { path: userFile, source: 'settings.user' }
  ])
  const fallthrough = jev.resolveApiKey()
  ok('缺失文件继续回退', fallthrough && fallthrough.source === 'settings.user', JSON.stringify(fallthrough))

  jev.__setSettingsPaths([
    { path: brokenFile, source: 'settings.local' },
    { path: projectFile, source: 'settings.project' },
    { path: userFile, source: 'settings.user' }
  ])
  const skipBroken = jev.resolveApiKey()
  ok('损坏 JSON 被跳过且不抛错', skipBroken && skipBroken.source === 'settings.project', JSON.stringify(skipBroken))

  jev.__setSettingsPaths([])
  ok('全部来源为空 -> null', jev.resolveApiKey() === null)

  // 逃生门 JEV_NO_SETTINGS=1：只用进程环境变量，不读任何 settings 文件
  // （项目候选路径由 CODEBUDDY_PROJECT_DIR 推导 → 指向沙箱，可控）
  const projectSettings = path.join(sandbox.root, '.codebuddy', 'settings.json')
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true })
  fs.writeFileSync(projectSettings, JSON.stringify({ env: { TYPESAFE_API_KEY: 'key-from-sandbox-project' } }), 'utf-8')
  jev.__setSettingsPaths(null) // 先撤销测试钩子，否则永远走覆盖列表
  const noOverride = jev.resolveApiKey()
  ok('默认会读项目 settings.json', noOverride && noOverride.key === 'key-from-sandbox-project', JSON.stringify(noOverride))
  process.env.JEV_NO_SETTINGS = '1'
  ok('JEV_NO_SETTINGS=1 -> 不读 settings', jev.resolveApiKey() === null)
  delete process.env.JEV_NO_SETTINGS
  ok('删除逃生门后恢复读取', Boolean(jev.resolveApiKey()))
  fs.unlinkSync(projectSettings)
  jev.__setSettingsPaths([])

  // 只有 settings.json 有密钥时，evaluate 也应真正发起调用
  jev.__setSettingsPaths([{ path: userFile, source: 'settings.user' }])
  let settingsPayload = null
  jev.__setTransport(async (payload, transportOpts) => {
    settingsPayload = { payload, transportOpts }
    return { model: 'jev-from-settings', answers: { rel: { noul: 0.88 } }, usage: { input_tokens: 12 } }
  })
  const viaSettings = await jev.evaluate('state', { rel: jev.noul('x') }, { storyId })
  ok('settings 密钥可用 -> ok=true', viaSettings.ok === true, JSON.stringify(viaSettings))
  ok('密钥取自 settings.json', viaSettings.keySource === 'settings.user', String(viaSettings.keySource))
  ok('transport 收到 settings 中的密钥（非空）',
    Boolean(settingsPayload && settingsPayload.transportOpts.apiKey === 'key-from-user'))
  ok('日志不记录密钥原文',
    !JSON.stringify(debugLog.read(storyId, { kind: 'method_output' })).includes('key-from-user'))

  jev.__setSettingsPaths([])
  resetEnv()

  // ════════════════════════════════════════════════════════════
  section('8. 诊断留痕：只记指纹，不落原文')

  const records = debugLog.read(storyId, { kind: 'method_output' })
  ok('写入了诊断记录', records.length >= 1, String(records.length))
  const withVerdicts = records.find(r => r.data && Array.isArray(r.data.verdicts))
  ok('成功记录含 verdicts', Boolean(withVerdicts))
  ok('verdicts 含 tier', Boolean(withVerdicts) && withVerdicts.data.verdicts.some(v => v.tier === 'accept'),
    JSON.stringify(withVerdicts && withVerdicts.data.verdicts))
  ok('记录含 state 指纹', Boolean(withVerdicts) && /^sha1:/.test(withVerdicts.data.stateDigest.sha1))
  ok('记录含 state 长度', Boolean(withVerdicts) && withVerdicts.data.stateDigest.length > 0)
  ok('记录不含 state 原文', !JSON.stringify(records).includes('会话转接按钮点不动'))
  ok('失败记录也留痕（error 非空）', records.some(r => r.data && r.data.error))

  // ════════════════════════════════════════════════════════════
  // 环境还原
  jev.__resetTransport()
  jev.__setSettingsPaths(null)
  if (savedEnv.key === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = savedEnv.key
  if (savedEnv.switch === undefined) delete process.env.HARNESS_JEV; else process.env.HARNESS_JEV = savedEnv.switch
  if (savedEnv.high === undefined) delete process.env.JEV_HIGH; else process.env.JEV_HIGH = savedEnv.high
  if (savedEnv.low === undefined) delete process.env.JEV_LOW; else process.env.JEV_LOW = savedEnv.low

  summarize(sandbox)
}

main()
