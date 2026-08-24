---
name: harness-run
description: Start, resume, inspect, or end the Harness Engineering feature-development workflow. Use when the user invokes $harness-run or asks to run the gated Harness lifecycle for a Story.
---

# Harness Run

Adapt the legacy Harness `run` command to Codex without duplicating its workflow protocol.

## Required loading

1. Load `$harness-conductor` before changing workflow state.
2. Resolve the installed plugin root from `PLUGIN_ROOT`; fall back to `CLAUDE_PLUGIN_ROOT` for compatibility.
3. Read `<plugin-root>/commands/run.md` completely and treat it as the authoritative run protocol.

Do not reconstruct the phase workflow from memory. The command document and the scripts it names are the single source of truth.

## Codex adaptations

When following `commands/run.md`:

- Treat `use_skill("name")` as an instruction to load `$name`.
- Treat `Spawn nextAgent` as a request to start a Codex subagent with the exact `nextAgent` role and unmodified `agentPrompt` returned by `dispatch.js`.
- Use `PLUGIN_ROOT` in newly constructed shell commands. Existing output containing `CLAUDE_PLUGIN_ROOT` remains valid because Codex supplies the compatibility variable.
- Treat `$harness-run` arguments and the rest of the user's prompt as the legacy `/harness` arguments.
- Preserve approval boundaries. Do not infer permission for publishing, deployment, pushing, or other external mutations merely because the workflow reaches that phase.

## Entry routing

- `start <storyId> "<title>"` or a new-feature request: follow the start and `story-input.json` initialization flow in `commands/run.md`.
- `status`: run the documented status operation and report the result.
- `end`: run the documented end operation.
- A Story ID with an active workflow: enter the documented `dispatch.js` loop and resume from persisted state.
- Missing required identifiers or source information: request only the information required by the command protocol; do not invent it.

Keep workflow state changes inside the bundled scripts. Never edit `e2e-state.json` or `dev-pass.json` directly.
