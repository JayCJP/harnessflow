# Phase 5 — Git 提交

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[5].fileName` 为 `null`，产出物存在性检查亦被跳过 ——
> 本 Phase 的质量靠 Agent 自律与 git hook，不靠 policy.js。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。执行 `git add` + `commit` + `push`，并创建 MR。

## 产出物

commit + push + MR（无文件型产出物）。

## 硬性约束

| 约束 | 原因 |
|------|------|
| 🚫 禁止 `--no-verify` | 跳过 pre-commit hook 等于绕过项目自己的质量门；本插件的 lint 门控只覆盖变更文件，项目 hook 可能还有别的检查 |
| 🚫 不直接推 main / master | 除用户明确要求外，先建分支 |
| ✅ 只 stage 本 Story 相关文件 | `git add .` 会带进无关改动；`task-dag.json` 的 `files[]` 是天然的范围参照 |

推进 Phase 5→6 前，dev-pass 已在 Phase 4→5 被兜底撤销，此时 `src/` 处于不可编辑状态 ——
若发现还需改代码，走 `--rollback` 回 Phase 2，不要设法绕过 hook。

## 发布前确认（P2-4，2026-09）

Phase 4→5 推进结果的 warnings 若含「⚠️ [强告警] unverifiable AC 占比 …% ≥ 50%」——
说明过半验收标准因环境限制（无法登录的第三方系统等）未实际验证，仅代码逻辑审读通过
（实跑曾出现 1 passed / 0 failed / 14 unverifiable 仍静默放行到部署）。
发布与创建 MR 时必须向用户明示本 Story 的实际验证覆盖面，由用户决定是否接受后再发布。

## 常见失败与对策

- **pre-commit hook 报错**：修问题，不要 `--no-verify`。若 hook 本身坏了，
  这是需要向用户报告的事实，不是可以静默跳过的障碍。
- **push 被拒（非 fast-forward）**：先 `git pull --rebase`，不要 force push ——
  force push 属于需用户确认的破坏性操作。
- **Story 已归档却要补提交**：先 `archive-story.js <id> restore` 复档。
