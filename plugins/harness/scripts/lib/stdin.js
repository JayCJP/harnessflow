/**
 * stdin.js — 从 stdin 读取全部内容（零依赖底座）
 *
 * 职责:
 *   - 为 hook（PreToolUse / Stop / SessionStart）提供 stdin 读取
 *   - hook 的输入由宿主通过 stdin 传入，读不到就等于没有输入，一律按放行处理
 *
 * 用法:
 *   const { readStdin } = require('./stdin')
 *
 * 使用场景:
 *   - lib/hook-runner.js: 每个 hook 的入口都要先读 stdin 再解析 tool_name / tool_input
 *   - lib/state.js: 再导出本函数，保持既有 import 一行不动
 *
 * 说明:
 *   - 两段式实现（先 fs.readSync(fd 0)，失败再 openSync(process.stdin.fd)）是 Windows 兼容
 *     需要：直接用 process.stdin 的异步 API 在 Windows 上会读不完整，而某些终端下 fd 0
 *     又不可直接 read。两段都失败才返回空串，由调用方按"无输入"处理。
 *   - hooks/session-start.js 另有一份只读一次的简化实现（openSync + 单次 readSync），
 *     与这里语义有差异（不循环读、无 fd 0 快路径），本次未动，避免改变其输入行为。
 */

const fs = require('fs')

/**
 * 读取 stdin 全部内容（Windows 兼容）
 * 使用 fs.readSync 从 fd 0 读取，避免 Windows 上 process.stdin 的异步问题。
 * @returns {string} stdin 内容字符串；读取失败返回空串
 */
function readStdin () {
  const chunks = []
  try {
    const buf = Buffer.alloc(65536)
    const fd = 0
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, 4096, null)
      if (bytesRead === 0) break
      chunks.push(buf.slice(0, bytesRead))
    }
    return Buffer.concat(chunks).toString('utf-8')
  } catch (e) {
    try {
      const fd = fs.openSync(process.stdin.fd, 'r')
      const buf = Buffer.alloc(65536)
      const bytesRead = fs.readSync(fd, buf, 0, 65536, null)
      fs.closeSync(fd)
      if (bytesRead > 0) {
        return buf.toString('utf-8', 0, bytesRead)
      }
      return ''
    } catch (e2) {
      return ''
    }
  }
}

module.exports = { readStdin }
