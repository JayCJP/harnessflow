/**
 * runner.js — playwright-cli 子进程调用层（Windows 兼容 + 三层错误判定）
 *
 * 职责:
 *   - 定位 playwright-cli 可执行文件（**绝对路径**，见下）
 *   - 拼装并执行单条 CLI 命令，固定 CWD、注入环境变量
 *   - 解析 `--json` 回执（含二次解码）并做三层错误判定
 *
 * 为什么这么写（均为 2026-09 在本机 playwright-cli v0.1.21 实跑验证的结论）:
 *
 *   1. **必须用绝对路径指向 `playwright-cli.cmd`**
 *      node 子进程的 PATH 里没有 CLI 所在目录（nvm 的 node 目录只在 Git Bash 的
 *      PATH 里），裸名 spawn 直接 ENOENT；补 PATH 也无效。且不能拿 `process.execPath`
 *      去跑 POSIX shim（`#!/bin/sh` 脚本会被当 JS 解析，报 `basedir=$(dirname ...)`
 *      语法错）。Windows 上唯一可靠的是同目录的 `.cmd`。
 *
 *   2. **Windows 上不能「可执行文件 + 参数数组」直接 spawn**
 *      `spawnSync(cli.cmd, args, { shell: false })` → EINVAL（Windows 不能直接执行 .cmd）。
 *      统一走 `chcp 65001 && "<cli>" <args...>` + `shell: true`。
 *
 *   3. **中文参数必须过 `chcp 65001`**
 *      实测经 `cmd /c` 传参时中文被破坏（`'??ע' 不是内部或外部命令`），
 *      而 `chcp 65001 >nul && ...` 后中文本参数完好传递。说明文字采集的关键词全是中文，
 *      不走这条就等于该功能静默失效。
 *
 *   4. **必须设 `NO_UPDATE_NOTIFIER=1`**
 *      CLI 入口每次 `main()` 都 fetch npm registry 查更新（超时 1500ms）。
 *      实测冷缓存 1187ms vs 热缓存 430ms —— 一次抓取几十条命令，累积差数十秒。
 *
 *   5. **不能「退出码非 0 即抛异常」**
 *      `--json eval` 遇到业务错误时回 `{"isError":true,...}` 且**退出码为 1**；
 *      而 CLI 层错误（如未 open）回的是纯文本、JSON.parse 会失败。
 *      所以判定顺序必须是「先 parse，parse 成功看 isError，parse 失败算 CLI 层错误」。
 *
 * 依赖: 仅 node 内建（child_process / fs / path），零 npm 依赖
 *
 * @module skills/prototype-capture/scripts/runner
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

/** 环境变量名：关闭 CLI 的 npm registry 更新检查（省一次最长 1.5s 的网络往返） */
const ENV_NO_UPDATE = 'NO_UPDATE_NOTIFIER'

/** 单条 CLI 命令的默认超时（毫秒） */
const DEFAULT_TIMEOUT = 60000

/**
 * 候选可执行文件路径（按平台与常见安装方式排列）
 *
 * 顺序即优先级：Windows 优先 `.cmd`（spawn 兼容），其余平台用无扩展名 shim。
 *
 * @returns {string[]} 候选绝对路径列表
 */
function candidateCliPaths () {
  const names = process.platform === 'win32'
    ? ['playwright-cli.cmd', 'playwright-cli.exe', 'playwright-cli']
    : ['playwright-cli']

  const dirs = []

  // 与当前 node 进程同目录（nvm / 全局安装的典型位置）
  if (process.execPath) dirs.push(path.dirname(process.execPath))

  // PATH 里的候选目录
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) dirs.push(dir)
  }

  const out = []
  const seen = new Set()
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name)
      if (seen.has(p)) continue
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

/**
 * 定位 playwright-cli 可执行文件
 *
 * @param {object} [opts] - { env } 允许注入环境变量（测试用）
 * @returns {{ ok: boolean, path: string|null, checked: number }}
 */
function resolveCli (opts = {}) {
  const candidates = candidateCliPaths()
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return { ok: true, path: p, checked: candidates.length }
    } catch (e) { /* 不存在则继续 */ }
  }
  return { ok: false, path: null, checked: candidates.length }
}

/**
 * 判断字符串是否含非 ASCII 字符
 *
 * 非 ASCII（中文说明关键词、Unicode 文案）必须走 chcp 65001 分支。
 *
 * 实现说明：用「是否有码点 > 0x7F」判定，而不是正则字符区间 ——
 * 后者（`/[^\x00-\x7F]/`）会被 eslint 的 no-control-regex 规则判为可疑用法。
 *
 * @param {string} s - 待检查字符串
 * @returns {boolean}
 */
function hasNonAscii (s) {
  const str = String(s == null ? '' : s)
  for (let i = 0; i < str.length; i++) {
    if (str.codePointAt(i) > 0x7F) return true
  }
  return false
}

/**
 * 把单个参数转成可安全嵌入 shell 命令串的形式
 *
 * 策略（Windows cmd 语义，**实测校准**）：
 *   - 含空白或 cmd 元字符 → 整体用双引号包裹
 *   - 参数内部的双引号 → 用 `""` 转义（**不是** `\"`）
 *
 * ⚠️ 为什么是 `""` 而非 `\"`：
 *   cmd.exe 不认反斜杠转义。实测把 `new RegExp("a|b")` 写成 `"...\"a|b\"..."`
 *   会让 cmd 在第一个 `\"` 的引号处**提前结束**带引号段，于是 `a|b` 裸奔成
 *   一条新命令（报 `'a' is not recognized as an internal or external command`）。
 *   cmd 的正确转义是重复引号 `""`。
 *
 * ⚠️ 单引号在 cmd 里**没有**引用语义（实测 `'说明|备注'` 会被当普通字符 + 管道），
 *   所以脚本内部一律用双引号，不要用单引号包裹参数。
 *
 * 中文不需要额外转义，交给 `chcp 65001` 处理（见 buildCommand）。
 *
 * @param {string} arg - 原始参数
 * @returns {string} 可直接拼进命令串的参数
 */
function quoteArg (arg) {
  const s = String(arg == null ? '' : arg)
  if (s === '') return '""'

  const needsQuote = /[\s&|<>^()"']/.test(s)
  if (!needsQuote) return s

  // cmd 的引号转义是重复双引号；同时不能留裸反斜杠在引号前
  return '"' + s.replace(/"/g, '""') + '"'
}

/**
 * 拼装完整的 CLI 命令串（跨平台）
 *
 * @param {string} cliPath - resolveCli 返回的绝对路径
 * @param {string[]} args - CLI 参数数组
 * @returns {string} 可直接交给 shell:true 的完整命令串
 */
function buildCommand (cliPath, args) {
  const quotedCli = quoteArg(cliPath)
  const quotedArgs = (args || []).map(quoteArg).join(' ')
  const core = quotedArgs ? `${quotedCli} ${quotedArgs}` : quotedCli

  if (process.platform === 'win32') {
    // chcp 65001 切 UTF-8 代码页，中文参数才不会被破坏
    return `chcp 65001 >nul && ${core}`
  }
  return core
}

/**
 * 解析 CLI 的 `--json` 回执
 *
 * CLI 有两种 `--json` 形态（实测 v0.1.21）：
 *   - **包装形态**（`eval` / `find` 等取值命令）：`{"result":"..."}`，
 *     且 result 常被**再序列化一次**（形如 `{"result":"\"{\\\"a\\\":1}\""}`），
 *     因此要对 result 再做一次 JSON.parse；解析失败则原样返回字符串
 *     （例如 `eval "() => document.title"` 的 result 是 `"Example Domain"`）。
 *   - **裸对象形态**（`list` 等状态命令）：直接是 `{"browsers":[]}`，没有 result 包装。
 *
 * 两种都要认，否则 `list` 会拿到 undefined 而误判会话残留为空。
 *
 * @param {string} stdout - 子进程标准输出
 * @returns {{ parsed: object|null, result: *, error: string|null }}
 */
function parseJsonResult (stdout) {
  const text = String(stdout == null ? '' : stdout).trim()
  if (!text) return { parsed: null, result: null, error: 'empty stdout' }

  let envelope
  try {
    envelope = JSON.parse(text)
  } catch (e) {
    return { parsed: null, result: null, error: 'stdout is not JSON' }
  }

  if (!envelope || typeof envelope !== 'object') {
    return { parsed: null, result: null, error: 'stdout is not a JSON object' }
  }

  if (envelope.isError) {
    return { parsed: envelope, result: null, error: String(envelope.error || 'cli reported isError') }
  }

  // 裸对象形态：没有 result 键，整个对象就是结果
  if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
    return { parsed: envelope, result: envelope, error: null }
  }

  // 包装形态：result 可能被再序列化 1~2 层，循环解到非字符串为止
  // 实测 `--json eval "() => JSON.stringify({a:1})"` 需要解两层：
  //   envelope.result = '"{\"a\":1}"'  →  '"{\"a\":1}"' 的 JSON.parse →  '{"a":1}'  →  {a:1}
  //
  // ⚠️ 除对象/数组外，**裸字面量也要解** —— 实测 `--json eval "() => !!x"` 的
  // result 是字符串 `"true"`（不是布尔 true），不解会让 `=== true` 判定永远失败。
  // 同理适用于数字（`"42"`）与 null（`"null"`）。
  let result = envelope.result
  for (let depth = 0; depth < 3 && typeof result === 'string'; depth++) {
    const inner = result.trim()
    if (!inner) break
    if (!/^[{["]|^-?\d|^true$|^false$|^null$/.test(inner)) break
    try {
      const next = JSON.parse(inner)
      if (next === result) break
      result = next
    } catch (e) { break }
  }

  return { parsed: envelope, result, error: null }
}

/**
 * 三层错误判定
 *
 * ① stdout 能 parse 成 JSON 且含 isError  → 业务层（CLI 正常执行但操作失败）
 * ② stdout 非 JSON（纯文本）              → CLI 层（如未 open、参数非法）
 * ③ status === null                       → spawn 层（ENOENT / EINVAL / 超时）
 *
 * @param {object} spawnResult - spawnSync 的返回值
 * @returns {{ errorLayer: string|null, error: string|null }}
 */
function classifyError (spawnResult) {
  const r = spawnResult || {}
  const stdout = String(r.stdout || '').trim()

  if (r.status === null || r.status === undefined) {
    const code = r.error && r.error.code ? r.error.code : 'UNKNOWN'
    return { errorLayer: 'spawn', error: `spawn failed: ${code}${r.error ? ' - ' + r.error.message : ''}` }
  }

  const parsed = parseJsonResult(stdout)
  if (parsed.parsed) {
    // stdout 是合法 JSON：即便退出码为 0，isError 也算业务层失败
    if (parsed.parsed.isError) return { errorLayer: 'business', error: parsed.error }
    return { errorLayer: null, error: null }
  }

  // stdout 不是 JSON
  if (r.status === 0) return { errorLayer: null, error: null }

  const stderr = String(r.stderr || '').trim()
  return { errorLayer: 'cli', error: (stderr || stdout || `exit ${r.status}`).slice(0, 500) }
}

/**
 * 默认 runner：真正 spawn 子进程
 *
 * @param {string} command - 完整命令串
 * @param {object} options - { cwd, timeout, env }
 * @returns {object} spawnSync 结果
 */
function defaultRunner (command, options) {
  const opts = options || {}
  const env = Object.assign({}, process.env, { [ENV_NO_UPDATE]: '1' }, opts.env || {})
  return spawnSync(command, [], {
    cwd: opts.cwd || process.cwd(),
    env,
    shell: true,
    encoding: 'utf8',
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024
  })
}

/**
 * 执行一条 playwright-cli 命令
 *
 * @param {string} workDir - 固定 CWD（CLI 的 session/profile 按启动 CWD 解析，必须固定）
 * @param {string[]} args - CLI 参数数组，如 ['--json', 'eval', '() => 1']
 * @param {object} [opts] - { runner, cliPath, timeout }
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, result: *, errorLayer: string|null, error: string|null, command: string }}
 */
function runCli (workDir, args, opts = {}) {
  const runner = opts.runner || defaultRunner
  const cliPath = opts.cliPath || resolveCli().path

  if (!cliPath) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      result: null,
      errorLayer: 'spawn',
      error: 'playwright-cli not found',
      command: ''
    }
  }

  const command = buildCommand(cliPath, args)
  let raw
  try {
    raw = runner(command, { cwd: workDir, timeout: opts.timeout })
  } catch (e) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      result: null,
      errorLayer: 'spawn',
      error: 'runner threw: ' + e.message,
      command
    }
  }

  const stdout = String(raw.stdout || '')
  const stderr = String(raw.stderr || '')
  const verdict = classifyError(raw)
  const parsed = parseJsonResult(stdout)

  return {
    ok: verdict.errorLayer === null,
    status: raw.status === undefined ? null : raw.status,
    stdout,
    stderr,
    result: parsed.result,
    errorLayer: verdict.errorLayer,
    error: verdict.error,
    command
  }
}

module.exports = {
  ENV_NO_UPDATE,
  DEFAULT_TIMEOUT,
  candidateCliPaths,
  resolveCli,
  hasNonAscii,
  quoteArg,
  buildCommand,
  parseJsonResult,
  classifyError,
  defaultRunner,
  runCli
}
