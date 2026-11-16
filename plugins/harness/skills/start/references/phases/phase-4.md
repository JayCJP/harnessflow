# Phase 4 — 知识库更新（主流程第四步）

> 门控实现：`services/policy.js` → `checkPhase4Gate()` —— **只产出 WARNING，不阻断推进**。
> 通用三道检查见 [README.md](./README.md)（本 Phase 产出物是 `fileName: null`，检查空转）。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。调用 `use_skill("kb-update")` 增量更新
项目知识库文档，产出体现为 `meta.yaml` 的 hash 变化。

**本 Phase 紧接代码审查**：评审通过后立刻沉淀经验，不用等提交与合并。
此时代码尚未提交，`kb-update` 走它的 `working-tree` 分支（git diff HEAD + untracked），
本来就是支持的路径。

## 产出物

知识库文档更新（`meta.yaml` 的 `git.hash` / `doc_stats` / `log.md`），无 story 级契约文件。

## 门控：未调用 kb-update → WARNING

`checkPhase4Gate` 读 `trace.jsonl`，看本 Phase 内是否出现过 `kb-update` 的 Skill 调用记录：

| 情形 | 结果 |
|------|------|
| 有调用记录 | 通过（不解析调用成败） |
| 无调用记录 | WARNING `kb_unchanged`，**不阻断推进** |
| trace.jsonl 缺失 / 读失败 | WARNING，提示人工确认 |

为什么只 WARN：知识库的价值体现在「下一个 Story 的 `kb-query` 能否查到本次经验」，
而不是「本次能不能推进」。`kb-init` 尚未初始化的项目本就无法更新知识库，
用 BLOCKER 会把流水线卡死在一个与代码质量无关的前置缺失上。

## 要点

| 要点 | 说明 |
|------|------|
| 增量而非重写 | `kb-update` 是增量更新；**必须保留手工批注** —— 知识库里人写的内容比机器生成的更贵 |
| 调用成功才算完成 | `use_skill("kb-update")` 返回失败时不要把本 Phase 报成完成；门控看不出来，但没人会回来补 |
| 与 Phase 0 的呼应 | Phase 0 需求分析师用 `kb-query` 读知识库，本 Phase 写回去 —— 这条回路断了，下个 Story 的检索就查不到本次的经验 |
| hash 时点 | 知识库更新发生在提交之前，`meta.yaml` 的 `git.hash` 反映的是**评审时点**，不是提交时点。记录与 `HEAD` 不一致属正常，不要为此重跑 |

知识库相关 skill：`kb-init`（初始化）/ `kb-query`（检索）/ `kb-update`（增量更新）。

## dev-pass 在本 Phase 前关闭

推进 Phase 3→4 时 `advance-phase.js` 会兜底撤销 dev-pass（幂等，正常流程在 2→3 已撤销）。
进入本 Phase 后 `src/` 处于不可编辑状态；若发现还需改代码，走
`advance-phase.js <storyId> 2 --rollback`，不要设法绕过 hook。

## 常见失败与对策

- **`kb-update` 报找不到知识库**：项目可能从未 `kb-init`。这是需要如实告知用户的前置缺失，
  不要静默跳过本 Phase。
- **手工批注被覆盖**：说明用的是重写而非增量路径。回滚该文件后改用 `kb-update`。
- **门控报了 `kb_unchanged` warning**：确认是否真的调过 `kb-update`；确实不需要更新（如纯配置改动）
  也可以直接推进，warning 会进 phase summary 备查。
