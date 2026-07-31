#!/usr/bin/env node
const { PROJECT_ROOT, PLANS_DIR, getStoryDir, readStateFile, checkAcceptanceCriteria, checkOpenQuestions, checkTaskDagJson, validateContractReferences, checkAcceptanceVerification, getPhaseName } = require("../lib/state")
const args = process.argv.slice(2)
const storyId = args[0]
const targetPhase = parseInt(args[1])
if (!storyId || isNaN(targetPhase)) { console.error("Usage: node validate-contracts.js <storyId> <targetPhase>"); process.exit(1) }

const blockers = [], warnings = [], details = {}
const state = readStateFile(storyId)
if (!state) { console.log(JSON.stringify({ pass: false, blockers: ["状态文件不存在"] })); process.exit(1) }

function logPhaseCheck(phase, desc, result) {
  details["phase" + phase + "_" + desc] = result
  if (result.errors) for (const e of result.errors) blockers.push("[Phase " + phase + " " + desc + "] " + e)
  if (result.warnings) for (const w of result.warnings) warnings.push("[Phase " + phase + " " + desc + "] " + w)
}

// Phase 0->1: 验收标准 + 待确认项
if (targetPhase >= 1) {
  logPhaseCheck(0, "acceptance-criteria", checkAcceptanceCriteria(storyId))
  logPhaseCheck(0, "open-questions", checkOpenQuestions(storyId))
}

// Phase 1->2: 任务契约 + 交叉引用
if (targetPhase >= 2) {
  logPhaseCheck(1, "task-dag-json", checkTaskDagJson(storyId))
  logPhaseCheck(1, "contract-references", validateContractReferences(storyId))
}

// Phase 4->5: 验收对账
if (targetPhase >= 5) {
  logPhaseCheck(4, "acceptance-verification", checkAcceptanceVerification(storyId))
}

const result = {
  pass: blockers.length === 0,
  storyId,
  targetPhase,
  phaseName: getPhaseName(targetPhase),
  blockers,
  warnings,
  details,
  summary: blockers.length > 0
    ? "FAIL: " + blockers.length + " blockers, " + warnings.length + " warnings"
    : warnings.length > 0
      ? "PASS (with warnings): " + warnings.length + " warnings"
      : "PASS: All contracts valid"
}
console.log(JSON.stringify(result, null, 2))
process.exit(result.pass ? 0 : 1)
