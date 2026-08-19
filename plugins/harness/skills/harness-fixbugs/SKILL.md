---
name: harness-fixbugs
description: Start or resume the Harness Engineering bug-fix workflow from TAPD or supplied defect context. Use when the user invokes $harness-fixbugs or requests the gated Harness fixbugs lifecycle.
---

# Harness Fixbugs

Adapt the legacy Harness `fixbugs` command to Codex without duplicating its workflow protocol.

## Required loading

1. Load `$harness-conductor` before changing workflow state.
2. Resolve the installed plugin root from `PLUGIN_ROOT`; fall back to `CLAUDE_PLUGIN_ROOT` for compatibility.
3. Read `<plugin-root>/commands/fixbugs.md` completely and treat it as the authoritative fixbugs protocol.
4. Read `<plugin-root>/commands/run.md` when `fixbugs.md` routes into the shared dispatch loop.

Do not reconstruct the phase workflow from memory. The command documents and their bundled scripts are the single source of truth.

## Codex adaptations

When following the command documents:

- Treat `use_skill("name")` as an instruction to load `$name`.
- Treat `Spawn nextAgent` as a request to start a Codex subagent with the exact `nextAgent` role and unmodified `agentPrompt` returned by `dispatch.js`.
- Use `PLUGIN_ROOT` in newly constructed shell commands. Existing output containing `CLAUDE_PLUGIN_ROOT` remains valid because Codex supplies the compatibility variable.
- Treat `$harness-fixbugs` arguments and the rest of the user's prompt as the legacy `/harness fixbugs` arguments.
- The main agent only transports TAPD and defect inputs into `story-input.json`; it must not perform the bug analysis assigned to the requirement-analysis phase.
- Preserve approval boundaries for TAPD access, Git pushes, merge requests, deployment, and other external mutations.

## Entry routing

- A new bug-fix request: require the Story ID, title, TAPD URL or supplied defect source, and any owner/filter values required by `commands/fixbugs.md`.
- A Story ID with an active fixbugs workflow: enter the shared `dispatch.js` loop and resume from persisted state.
- If required input is missing, request only that input and do not invent TAPD identifiers, owners, filters, or defect facts.

Always start the workflow with `--mode=fixbugs`. Keep workflow state changes inside the bundled scripts and never edit `e2e-state.json` or `dev-pass.json` directly.
