#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const { execSync } = require("child_process")
const { PROJECT_ROOT, PLANS_DIR, getStoryDir, listStoryDirs, readStateFile, findActiveWorkflows, checkPhaseArtifact, getPhaseName, getPhaseSlug, checkAcceptanceCriteria, checkOpenQuestions, checkTaskDagJson, validateContractReferences, checkAcceptanceVerification, checkDevPass } = require("../lib/state")
const args = process.argv.slice(2)
const fixMode = args.includes("--fix")
const jsonOnly = args.includes("--json")
const issues = [], warnings = [], fixed = []
const summary = {}

function auditSettings() {
  const sp = path.join(PROJECT_ROOT, ".codebuddy", "settings.json")
  if (!fs.existsSync(sp)) {
    // 本机 hooks 由 CodeBuddy 全局配置注入，项目内不一定有 settings.json，
    // 因此缺失时不报 BLOCKER，降级为 WARNING 提示
    warnings.push({ cat: "config", severity: "WARNING", msg: "settings.json 不存在（hooks 可能由全局配置注入，可忽略）" })
    return
  }
  try { JSON.parse(fs.readFileSync(sp, "utf-8")); summary.settingsValid = true } catch (e) { issues.push({ cat: "config", severity: "BLOCKER", msg: "settings.json 解析失败: " + e.message }) }
}

function auditHooks() {
  // 实际 hook 脚本位于 scripts/hooks/ (audit 的 __dirname 是 scripts/audit/，所以 ../hooks)
  const hd = path.join(__dirname, "..", "hooks")
  if (!fs.existsSync(hd)) { issues.push({ cat: "hooks", severity: "BLOCKER", msg: "hooks 脚本目录不存在: " + hd }); return }
  // 当前实际 hook 文件 (v2: .js 后缀)
  const exp = ["session-start.js","session-stop.js","enforce-dev-pass.js","enforce-artifact.js","enforce-state-file.js","trace-command.js"]
  const ex = fs.readdirSync(hd).filter(f => f.endsWith(".js") || f.endsWith(".cjs"))
  for (const f of exp) { if (!ex.includes(f)) issues.push({ cat: "hooks", severity: "BLOCKER", msg: "缺失 hook: " + f }) }
  for (const f of ex) {
    try { execSync("node --check \"" + path.join(hd, f) + "\"", { timeout: 5000, stdio: "pipe" }) }
    catch (e) { issues.push({ cat: "hooks", severity: "BLOCKER", msg: "Hook 语法错误: " + f + " — " + ((e.stderr||"")+"").substring(0,200) }) }
  }
}

function auditActiveStory() {
  const hf = path.join(PLANS_DIR, ".harness-active")
  const ha = fs.existsSync(hf)
  const wfs = findActiveWorkflows()
  if (ha) {
    try {
      const flag = JSON.parse(fs.readFileSync(hf, "utf-8"))
      summary.harnessStoryId = flag.storyId; summary.harnessActive = true
      const st = readStateFile(flag.storyId)
      if (!st) issues.push({ cat: "state", severity: "BLOCKER", msg: ".harness-active 引用 " + flag.storyId + " 但 e2e-state.json 不存在" })
      else summary.harnessPhase = st.phase
    } catch { issues.push({ cat: "state", severity: "BLOCKER", msg: ".harness-active JSON 解析失败" }) }
  } else { summary.harnessActive = false; if (wfs.length > 0) warnings.push({ cat: "state", severity: "WARNING", msg: String(wfs.length) + " 个活跃工作流但 .harness-active 不存在" }) }
  summary.activeWorkflows = wfs.length
}

function auditDevPass() {
  const dp = checkDevPass()
  summary.devPassValid = dp.valid; summary.devPassStoryId = dp.storyId
  if (dp.valid && dp.storyId) {
    try {
      const pp = path.join(PLANS_DIR, dp.storyId, "dev-pass.json")
      const pass = JSON.parse(fs.readFileSync(pp, "utf-8"))
      if (pass.pathSource === "fallback-src-glob") warnings.push({ cat: "dev-pass", severity: "WARNING", msg: "dev-pass 降级为 src/** 全局 (storyId=" + dp.storyId + ")，建议完善 task-dag.json files" })
      else summary.devPassScope = "precise (" + (pass.allowedPaths ? pass.allowedPaths.length : 0) + " files)"
    } catch {}
  } else if (dp.storyId && fixMode) {
    try { fs.unlinkSync(path.join(PLANS_DIR, dp.storyId, "dev-pass.json")); fixed.push("已清理过期 dev-pass: " + dp.storyId) } catch {}
  }
}

function auditContracts() {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === "completed") continue
    const ph = st.phase || 0
    if (ph >= 1 || (st.phases && st.phases["0_requirement_analysis"] && st.phases["0_requirement_analysis"].status === "completed")) {
      const ac = checkAcceptanceCriteria(sid)
      if (!ac.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] acceptance-criteria.json: " + ac.errors.join("; ") })
      const oq = checkOpenQuestions(sid)
      if (!oq.allResolved) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] open-questions.json: " + oq.unresolved.length + " 项未解决" })
    }
    if (ph >= 2 || (st.phases && st.phases["1_task_planning"] && st.phases["1_task_planning"].status === "completed")) {
      const tdj = checkTaskDagJson(sid)
      if (!tdj.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] task-dag.json: " + tdj.errors.join("; ") })
      const ref = validateContractReferences(sid)
      if (!ref.valid) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] AC-Task 引用: " + ref.errors.join("; ") })
    }
    if (ph >= 5 || (st.phases && st.phases["4_e2e_verification"] && st.phases["4_e2e_verification"].status === "completed")) {
      const av = checkAcceptanceVerification(sid)
      if (!av.allPassed) warnings.push({ cat: "contract", severity: "WARNING", msg: "[" + sid + "] acceptance-verification.json: " + av.errors.join("; ") })
    }
  }
}

function auditArtifacts() {
  const dirs = listStoryDirs()
  for (const sid of dirs) {
    const st = readStateFile(sid)
    if (!st || st.status === "completed") continue
    const ph = st.phase || 0
    for (let p = 0; p < ph; p++) {
      if (st.bypass && p < 2) continue
      const art = checkPhaseArtifact(sid, p)
      if (!art.exists) { for (const m of art.missing) warnings.push({ cat: "artifact", severity: "WARNING", msg: "[" + sid + "] Phase " + p + " 缺失: " + m.description + " -> " + m.fileName }) }
    }
  }
}

function run() {
  auditSettings(); auditHooks(); auditActiveStory(); auditDevPass(); auditContracts(); auditArtifacts()
  summary.auditedAt = (new Date()).toISOString()
  summary.totalIssues = issues.length; summary.totalWarnings = warnings.length; summary.totalFixed = fixed.length
  if (jsonOnly) { console.log(JSON.stringify({ summary: summary, issues: issues, warnings: warnings, fixed: fixed }, null, 2)); return }
  console.log("")
  console.log("═══════════════════════════════════════════════════════")
  console.log("  Harness Engineering — CCHF 健康审计报告")
  console.log("  时间: " + summary.auditedAt)
  console.log("  Harness: " + (summary.harnessActive ? ("已激活 (" + (summary.harnessStoryId||"?") + ")") : "未激活"))
  console.log("  活跃工作流: " + (summary.activeWorkflows || 0) + " 个")
  console.log("  dev-pass: " + (summary.devPassValid ? ("有效" + (summary.devPassScope ? (" (" + summary.devPassScope + ")") : "")) : "无效"))
  console.log("═══════════════════════════════════════════════════════")
  if (issues.length > 0) { console.log(""); console.log("BLOCKERS (" + issues.length + "):"); for (const i of issues) console.log("  [" + i.cat + "] " + i.msg) }
  if (warnings.length > 0) { console.log(""); console.log("WARNINGS (" + warnings.length + "):"); for (const w of warnings) console.log("  [" + w.cat + "] " + w.msg) }
  if (fixed.length > 0) { console.log(""); console.log("FIXED (" + fixed.length + "):"); for (const f of fixed) console.log("  [ok] " + f) }
  if (issues.length === 0 && warnings.length === 0) { console.log(""); console.log("All checks passed.") }
  console.log(""); console.log("═══════════════════════════════════════════════════════")
  console.log("  Blockers: " + summary.totalIssues + " | Warnings: " + summary.totalWarnings + " | Fixed: " + summary.totalFixed)
  console.log("═══════════════════════════════════════════════════════")
  if (issues.length > 0) process.exit(1)
}
run()
