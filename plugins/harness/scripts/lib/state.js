#!/usr/bin/env node
/**
 * state.js — 工作流状态与契约的唯一读写层（**聚合再导出**）
 *
 * 职责:
 *   - 本文件不再含任何实现，只做一件事: 把下列模块聚合成一个 import 面，
 *     让 15 个既有调用方的 `require('../lib/state')` 一行不动
 *   - 新代码请直接 require 精确模块（见下方模块表），旧引用自然衰减
 *
 * 模块划分（2026-09 从本文件拆出，按原分组注释切）:
 *   | 模块 | 内容 |
 *   |---|---|
 *   | paths.js | 项目根 / Story 目录 / 状态文件判定（零依赖） |
 *   | artifacts.js | ARTIFACT 文件名表 + 统一读取（零依赖） |
 *   | stdin.js | stdin 读取（零依赖，hook 与状态层共用） |
 *   | repos.js | 仓库注册表 repos.json + isSrcFile |
 *   | phases.js | PHASE_SLUGS / PHASE_NAMES / PHASE_ARTIFACTS / PHASE_AGENTS |
 *   | story-state.js | e2e-state.json CRUD + 活跃工作流 + 目录清理 |
 *   | artifacts-check.js | 产出物存在性 + Figma 链路校验 |
 *   | contracts.js | 契约文件常量 + 读取 + 结构校验 |
 *   | dev-pass.js | dev-pass 生命周期 + 修复轮次预算 |
 *   | errors.js | 结构化错误辅助（零依赖） |
 *
 * 用法:
 *   const { readStateFile, writeStateFile, checkPhaseArtifact } = require('../lib/state')
 *   // 新代码更推荐:
 *   const { readStateFile } = require('../lib/story-state')
 *
 * 使用场景:
 *   - 被 hooks/ 复用（enforce-dev-pass / enforce-artifact / session-start / session-stop）:
 *     读 dev-pass 判断 src/ 编辑是否放行、读 e2e-state 判断是否跳 Phase
 *   - 被 services/ 复用（validate-contracts / policy / schema-validator /
 *     prompt-builder / context-refresh / experience）: 做门控校验、契约校验、产出物清单与 prompt 组装
 *   - 被 commands/ 复用（create-workflow / advance-phase / dispatch / archive-story / harness-workflow）:
 *     做状态流转、dev-pass 生命周期管理、Story 目录创建与清理
 *   - 被 audit/ 三个脚本复用同一套校验逻辑，保证人工诊断与自动门控口径一致
 *
 * 说明:
 *   - v2.0 按 Story 分目录存储，文件命名去掉 storyId 前缀
 *     旧: plans/STORY-002-e2e-state.json
 *     新: plans/STORY-002/e2e-state.json
 *   - PHASE_ARTIFACTS 是产出物清单的**唯一信源**: 门控校验（checkPhaseArtifact）、
 *     prompt 产出要求（prompt-builder）、上下文摘要（context-refresh）都从此读取
 *   - PHASE_AGENTS 的 agent 字段是 Agent 注册名（frontmatter 的 name，英文），
 *     label 仅供人类阅读，禁止用于 Spawn
 *   - 为什么保留聚合层而不是直接改 15 个调用方: 拆分与改调用方混在一个改动里会让
 *     diff 无法审查。等旧引用自然衰减完，本文件可以直接删掉。
 *
 * @module state
 */

// ─── 零依赖底座 ────────────────────────────────────────────────
// paths.js 同时消除了 state ⇄ debug-log 的加载期循环依赖：debug-log 过去为了拿
// getStoryDir 必须惰性 require state，现在两者都只依赖 paths。
const {
  PROJECT_ROOT,
  PLANS_DIR,
  getStoryDir,
  ensureStoryDir,
  listStoryDirs,
  isStateFile
} = require('./paths')

const { readStdin } = require('./stdin')

// ─── 按主题拆分的实现模块 ──────────────────────────────────────
const {
  getReposFilePath,
  getDefaultRepoName,
  loadRepos,
  ensureReposJson,
  getRepoRoot,
  getRepoForFile,
  isSrcFile
} = require('./repos')

const {
  PHASE_SLUGS,
  PHASE_NAMES,
  PHASE_ARTIFACTS,
  PHASE_AGENTS,
  getPhaseAgent,
  getPhaseSlug,
  getPhaseName
} = require('./phases')

const {
  readStateFile,
  writeStateFile,
  findActiveWorkflows,
  hasActiveWorkflow,
  isPhaseCompleted,
  cleanStoryDir
} = require('./story-state')

const {
  checkPhaseArtifact,
  readStoryInput,
  getStoryMode,
  detectFigmaSource,
  isPrototypeRequired,
  findBugAnalysisReports,
  checkRequirementDoc,
  checkTaskDAGDoc,
  hasFigmaDesign,
  checkFigmaFrameInventory,
  validateTaskFigmaReferences,
  getTasksRequiringFigma,
  hasTaskRequiringFigma
} = require('./artifacts-check')

const {
  ACCEPTANCE_CRITERIA_FILE,
  OPEN_QUESTIONS_FILE,
  TASK_DAG_JSON_FILE,
  ACCEPTANCE_VERIFICATION_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  STORY_INPUT_FILE,
  readJsonArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  checkAcceptanceVerification
} = require('./contracts')

const {
  DEV_PASS_TTL,
  getDevPassAllowedPaths,
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  renewDevPass,
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS,
  getMaxFixRounds
} = require('./dev-pass')

const {
  structuredError,
  errorToString,
  errorToType
} = require('./errors')

// ─── 导出（符号集合与拆分前完全一致，共 64 个）──────────────────
module.exports = {
  // 路径常量
  PROJECT_ROOT,
  PLANS_DIR,
  DEV_PASS_TTL,
  PHASE_SLUGS,
  PHASE_NAMES,
  PHASE_ARTIFACTS,
  PHASE_AGENTS,
  getPhaseAgent,

  // 仓库注册表（repos.json，story 级独立）
  getDefaultRepoName,
  getReposFilePath,
  loadRepos,
  ensureReposJson,
  getRepoRoot,
  getRepoForFile,

  // Story 目录辅助
  getStoryDir,
  ensureStoryDir,
  listStoryDirs,

  // stdin 读取
  readStdin,

  // 文件路径检查
  isSrcFile,
  isStateFile,

  // 状态文件操作
  readStateFile,
  writeStateFile,
  findActiveWorkflows,
  hasActiveWorkflow,
  isPhaseCompleted,
  getPhaseSlug,
  getPhaseName,

  // 产出物检查
  checkPhaseArtifact,
  isPrototypeRequired,
  detectFigmaSource,
  findBugAnalysisReports,
  checkRequirementDoc,
  checkTaskDAGDoc,
  hasFigmaDesign,
  checkFigmaFrameInventory,
  validateTaskFigmaReferences,
  getTasksRequiringFigma,
  hasTaskRequiringFigma,

  // 契约 JSON 读取与校验
  ACCEPTANCE_CRITERIA_FILE,
  OPEN_QUESTIONS_FILE,
  TASK_DAG_JSON_FILE,
  ACCEPTANCE_VERIFICATION_FILE,
  FIGMA_FRAME_INVENTORY_FILE,
  STORY_INPUT_FILE,
  readStoryInput,
  getStoryMode,
  readJsonArtifact,
  checkAcceptanceCriteria,
  checkOpenQuestions,
  checkTaskDagJson,
  validateContractReferences,
  checkAcceptanceVerification,
  getDevPassAllowedPaths,

  // dev-pass 管理
  issueDevPass,
  revokeDevPass,
  checkDevPass,
  renewDevPass,

  // 修复回路配置
  DEFAULT_MAX_REVIEW_FIX_ROUNDS,
  DEFAULT_MAX_TEST_FIX_ROUNDS,
  getMaxFixRounds,

  // 结构化错误辅助
  structuredError,
  errorToString,
  errorToType,

  // 目录清理
  cleanStoryDir
}
