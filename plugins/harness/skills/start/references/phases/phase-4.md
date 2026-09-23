# Phase 4 — Git 提交

> 无 Phase 专属门控函数：`runGateCheck` 只跑通用三道检查（见 [README.md](./README.md)）。
> `PHASE_ARTIFACTS[5].fileName` 为 `null`，产出物存在性检查亦被跳过 ——
> 本 Phase 的质量靠 Agent 自律与 git hook，不靠 policy.js。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。执行 `git add` + `commit` + `push`，并创建 MR 合并到 dev 分支。

## 产出物

commit + push + MR（无文件型产出物）。

## 硬性约束

| 约束 | 原因 |
|------|------|
| 🚫 禁止 `--no-verify` | 跳过 pre-commit hook 等于绕过项目自己的质量门；本插件的 lint 门控只覆盖变更文件，项目 hook 可能还有别的检查 |
| 🚫 不直接推 main / master | 除用户明确要求外，先建分支 |
| ✅ 只 stage 本 Story 相关文件 | `git add .` 会带进无关改动；`task-dag.json` 的 `files[]` 是天然的范围参照 |

推进 Phase 4→5 前，dev-pass 已在 Phase 3→4 被兜底撤销，此时 `src/` 处于不可编辑状态 ——
若发现还需改代码，走 `--rollback` 回 Phase 2，不要设法绕过 hook。

## Phase 4 停顿点（人工门，2026-09-22）

Phase 4 有**两个**必须等用户的门，缺一即流程违规：

| # | 时点 | 谁问 | 等什么 |
|---|------|------|--------|
| 1 | 发布**前** | 主 Agent 转达 | 用户接受当前验证覆盖面（`code-review.json` 的 BLOCKER 是否清零），确认后才 Spawn `release-assistant` |
| 2 | 创建 MR **后** | 主 Agent 转达 | 用户确认 MR 已合并；**未确认不得推进 Phase 5** |

第 2 道门易被漏掉，原因与后果：

- `release-assistant` 定义 4.8 已写明「等用户明确回复『已合并 / 审核通过』」，但**主 Agent 拿到汇报后若直接
  `advance-phase.js <storyId> 5`，Phase 4→5 门控不拦** —— 门控只看产出物，不看 MR 状态。
- 后果：Phase 6 云端构建的是 **`dev` 分支**。代码未合进 `dev` 时，构建产物**不含本次变更**，
  却会被当成「本次需求已上线」，属于静默失败。

`release-assistant` 定义 **4.8** 会输出一个以 `⏸ 等待用户确认合并` 开头的固定块，
内含 `MR_URL=` / `MR_STATE=` / `MR_BRANCH=` / `MR_CONFLICTS=` / `MR_DIVERGED=` / `COMMIT=` 键值行。
主 Agent 收到该汇报后必须：

1. 把 **MR URL + source→target + commit hash** 原样交给用户（不加工、不省略；
   固定块里的键值行直接贴给用户即可）；
2. **停下**，等用户回复确认合并；
3. 可用 `gitlab_get_merge_request` 复核 `state === 'merged'` 作为客观凭据；
4. 仅在确认后执行 `advance-phase.js <storyId> 5`。

> 若汇报里**没有** `MR_URL=` 行，或 `MR_STATE` 不是 `merged` 且用户未回复 → 视为门未过，
> **不得推进**，必要时把 `release-assistant` 再派一轮补齐 MR URL。

> 若 `state` 仍为 `opened` 或无用户确认 → 保持 Phase 4 不动，**不得**推进。

## 发布前确认（P2-4，2026-09）

原「unverifiable AC 占比 ≥50% 强告警」随 Phase 4 功能测试一并移除 —— 该告警读的是
`acceptance-verification.json`，AC 核对现已并入 Phase 3、结论记入 `code-review.json`。
发布与创建 MR 前，以 `code-review.json` 为准向用户说明本 Story 的实际验证覆盖面
（`issues[]` 中 BLOCKER 是否清零），由用户决定是否接受后再发布。

## 常见失败与对策

- **pre-commit hook 报错**：修问题，不要 `--no-verify`。若 hook 本身坏了，
  这是需要向用户报告的事实，不是可以静默跳过的障碍。
- **push 被拒（非 fast-forward）**：先 `git pull --rebase`，不要 force push ——
  force push 属于需用户确认的破坏性操作。
- **Story 已归档却要补提交**：先 `archive-story.js <id> restore` 复档。
