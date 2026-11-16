# Phase 5 — Git 提交 + MR（主流程终点）

> 门控：通用三道（见 [README.md](./README.md)）—— 本 Phase 有契约文件 `git-submit.json`，
> 存在性与 schema 校验都是硬门控；无 Phase 专属门控函数。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。执行 `git add` + `commit` + `push` 开发分支，
创建 MR 到 `dev` 分支，并产出 `git-submit.json` 契约。

**本 Phase 完成即主流程结束**：推进到 Phase 6（云端部署）时，`advance-phase.js` 会写
`status: 'completed'` 并触发度量聚合。此后的云端部署是可选阶段。

## 产出物（契约）

`git-submit.json` —— 它是「代码已 push、MR 已创建」的唯一可验证事实，
归档门槛与「主流程已完成」判定都读它，不接受「Agent 说建了」。

```json
{
  "storyId": "STORY-001",
  "commitHash": "abc1234def5678",        // 必填：完整或短 hash
  "branch": "feat/story-001-assign",     // 必填：已推送的开发分支
  "mrUrl": "https://gitlab.example.com/g/p/-/merge_requests/12",  // 必填：MR 链接
  "targetBranch": "dev",                 // 必填：MR 目标分支
  "remote": "origin",                    // 可选
  "commitMessage": "feat(settings): 支持等级分配",  // 可选
  "submittedAt": "2026-11-16T10:00:00.000Z",       // 可选
  "notes": "未验证项 / 遗留风险"                    // 可选
}
```

schema：`scripts/schemas/git-submit.schema.json`。缺字段或 `mrUrl` 为空 → 门控拦截。

## 硬性约束

| 约束 | 原因 |
|------|------|
| 🚫 禁止 `--no-verify` | 跳过 pre-commit hook 等于绕过项目自己的质量门；本插件的 lint 门控只覆盖变更文件，项目 hook 可能还有别的检查 |
| 🚫 不直接推 main / master | 除用户明确要求外，先建分支 |
| ✅ 只 stage 本 Story 相关文件 | `git add .` 会带进无关改动；`task-dag.json` 的 `files[]` 是天然的范围参照 |
| ✅ MR 目标分支 `dev` | 云端部署构建的是 `dev`，目标分支写错产物就不含本次变更 |

## 发布前确认

`commit` / `push` / 建 MR 都是不可逆动作，**执行前必须拿到用户确认**（通过主 Agent 转达）。
确认内容含：待提交文件清单、commit message、目标分支、MR 标题。

以 `code-review.json` 为准向用户说明本 Story 的实际验证覆盖面
（`issues[]` 中 BLOCKER 是否清零），由用户决定是否接受后再发布。

## 不等待 MR 合并

本 Phase 在 **MR 创建后即结束**，不阻塞等用户合并。
「MR 已合并」的确认挪到可选阶段 Phase 6（云端部署）内部 —— 因为部署构建的是 `dev`，
代码没合进 `dev` 构建产物就不含本次变更，这个前提在部署前确认即可。

## 常见失败与对策

- **pre-commit hook 报错**：修问题，不要 `--no-verify`。若 hook 本身坏了，
  这是需要向用户报告的事实，不是可以静默跳过的障碍。
- **push 被拒（非 fast-forward）**：先 `git pull --rebase`，不要 force push ——
  force push 属于需用户确认的破坏性操作。
- **门控报 `artifact_missing: git-submit.json`**：确认 MR 已创建后补写契约文件，
  不要为了「先过门控」写空 `mrUrl` —— schema 会拦。
- **MR 合并后发现要改代码**：主流程已结束，`src/` 无 dev-pass。新建 Story 或
  `advance-phase.js <storyId> 2 --rollback` 回退重做，不要绕过 hook。
