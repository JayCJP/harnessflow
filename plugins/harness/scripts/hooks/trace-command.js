#!/usr/bin/env node
/**
 * trace-command.js — 命令/Skill/MCP 调用后自动追加 trace.jsonl 记录
 *
 * 职责:
 *   - 在工具调用完成后识别 harness 命令、Skill 调用、MCP 调用三类事件
 *   - 将事件以 JSONL 追加到当前 running Story 的 trace.jsonl
 *   - 全程静默失败，绝不阻塞主流程（始终 continue: true）
 *
 * 用法:
 *   由宿主自动触发，无需手动执行。
 *   注册事件: PostToolUse
 *   输入: stdin JSON（{ tool_name, tool_input: { command | skill } }，由 lib/hook-runner 同步读取）
 *   输出: stdout JSON（恒为 { continue: true }，不做任何拦截）
 *   手动调试: echo '{"tool_name":"Bash","tool_input":{"command":"node advance-phase.js S-1 2"}}' | node trace-command.js
 *
 * 使用场景:
 *   - 复盘一次 Harness 流程时缺少「谁在什么时候执行了什么」的时间线：
 *     不记录就只能靠对话历史回溯，跨会话、跨 Agent 的执行轨迹完全丢失，
 *     Phase 卡住时无法定位是命令没跑、跑错参数还是被 Hook 拦下。
 *   - session-stop.js 需要从 trace.jsonl 里捞出 hook_rejection 沉淀经验：
 *     没有 trace 就没有经验采集的输入源，门控只能重复硬拦而无法形成历史失败模式库。
 *
 * 说明:
 *   - 事件类型判定:
 *       harness 命令 — tool_input.command 命中 dispatch / advance-phase / create-workflow /
 *                      harness-workflow / archive-story
 *       Skill 调用   — tool_name 为 Skill 或 use_skill
 *       MCP 调用     — tool_name 形如 mcp__<server>__<tool>
 *     三类都不命中则直接放行，不写 trace。
 *   - 只写入扫描到的第一个 status='running' 的 Story，写完即 break。
 *   - 项目根与 Story 目录枚举统一走 lib/paths.js —— 此前本文件自带一份
 *     normalizeProjectRoot + plansDir 拼接的副本，与 paths.js 逻辑重复。
 *   - e2e-state.json 解析失败时跳过该 Story 继续扫描（原实现会中断整个扫描）。
 *   - harness 命令沿用 tool_executed 语义（timestamp 字段）以兼容既有消费方；
 *     Skill / MCP 用 tool_call 语义（ts 字段）。
 *   - @module trace-command-hook
 */
const fs = require('fs')
const { runHook } = require('../lib/hook-runner')
const { listStoryDirs } = require('../lib/paths')
const { ARTIFACT, artifactPath, readJson } = require('../lib/artifacts')
const debugLog = require('../lib/debug-log')

runHook('PostToolUse', ctx => {
  const toolName = ctx.toolName
  const cmd = ctx.toolInput.command || ''

  // 1. harness 命令（dispatch / advance-phase / create-workflow / harness-workflow / archive-story）
  //    2026-09 修复：此前漏了 dispatch 与 create-workflow——三步循环的 Step 1 与建流入口反而不被记录
  const isHarnessCmd = cmd.includes('dispatch') || cmd.includes('advance-phase') ||
    cmd.includes('create-workflow') || cmd.includes('harness-workflow') || cmd.includes('archive-story')
  // 2. Skill 调用（CodeBuddy 中 tool_name 为 Skill，input 里带 skill 名）
  const isSkill = toolName === 'Skill' || toolName === 'use_skill'
  // 3. MCP 调用（tool_name 形如 mcp__<server>__<tool>）
  const isMcp = /^mcp__/.test(toolName)

  if (!isHarnessCmd && !isSkill && !isMcp) return { decision: 'allow' }

  try {
    for (const storyId of listStoryDirs()) {
      const state = readJson(storyId, ARTIFACT.E2E_STATE)
      if (!state || state._parseError || state.status !== 'running') continue

      const phase = state.phase != null ? state.phase : null
      let entry
      if (isSkill) {
        // Skill 调用：提取 skill 名
        const skillName = ctx.toolInput.skill || ctx.toolInput.command || ''
        entry = {
          ts: new Date().toISOString(),
          type: 'tool_call',
          tool: toolName,
          skill: String(skillName).substring(0, 100),
          phase: phase != null ? String(phase) : null,
          result: 'success',
          storyId
        }
      } else if (isMcp) {
        // MCP 调用：tool_name = mcp__<server>__<tool>，拆出 server 与 tool
        const parts = toolName.split('__')
        entry = {
          ts: new Date().toISOString(),
          type: 'tool_call',
          tool: toolName,
          mcp: parts[1] || null,
          mcpTool: parts.slice(2).join('__') || null,
          phase: phase != null ? String(phase) : null,
          result: 'success',
          storyId
        }
      } else {
        // harness 命令（保留原有 tool_executed 语义，兼容既有消费方）
        entry = {
          timestamp: new Date().toISOString(),
          type: 'tool_executed',
          tool: toolName,
          command: cmd.substring(0, 200),
          storyId
        }
      }
      fs.appendFileSync(artifactPath(storyId, ARTIFACT.TRACE), JSON.stringify(entry) + '\n')

      // debug 载荷层：Skill / MCP 调用的输入与返回（宿主 PostToolUse 提供 tool_response
      // 时全量留痕，缺失时标注 responseAvailable=false）。
      // harness 命令不在此记录 script_output —— 命令脚本自身的输出口已全量留痕，
      // 此处再记即重复计费。
      if (isSkill || isMcp) {
        const raw = ctx.raw
        const resp = raw.tool_response != null ? raw.tool_response
          : (raw.tool_result != null ? raw.tool_result
              : (raw.response != null ? raw.response : null))
        debugLog.record(storyId, 'agent_report', {
          tool: toolName,
          toolClass: isSkill ? 'skill' : 'mcp',
          input: ctx.toolInput,
          response: resp,
          responseAvailable: resp != null
        }, { phase, source: 'trace-command.js' })
      }
      break
    }
  } catch (e) {
    // 静默失败，不阻塞主流程
  }

  return { decision: 'allow' }
})
