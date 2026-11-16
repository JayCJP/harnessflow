# Phase 6 — 云端部署（可选阶段）

> 只有 WARNING 级检查：本 Phase 产出物是 `fileName: null`（部署 URL + 构建号），
> 通用三道检查空转，不阻断推进。

## 定位：可选，不是主流程

主流程是 **需求 → 规划 → 开发 → 审查 → 知识库更新 → Git 提交 + MR**。
走完 Git 提交时 `status` 已写为 `completed`，`dispatch.js` 输出 `status: terminal`，
并附带一条 `optionalNext` 提示（云端部署）。

- 需要部署：用户明确要求后，执行 `optionalNext.command`（`advance-phase.js <storyId> 6`），
  再按 `optionalNext` 的提示派单发布助手。
- 不需要部署：直接归档收尾，本 Phase 不做。

主 Agent 不得在终态下自行推进 —— `optionalNext` 只是提示，必须在用户明确要求时才用。

## 职责

Agent 注册名 **`release-assistant`**（发布助手）。通过 devops MCP 触发云端构建和部署，
回报部署 URL + 构建号。

## 硬性前置：MR 已合并进 `dev`

Git 提交阶段只创建 MR、不等待合并。**构建前必须确认 MR 已合并**：

1. 向主 Agent 提出确认请求（你**没有** `AskUserQuestion`，不要自己直接问用户），
   内容含：MR 链接、目标分支 `dev`；
2. 拿到用户明确回复「已合并 / 审核通过」后再构建；可用 `gitlab_get_merge_request`（看 `state`）二次确认；
3. **未拿到确认不得构建** —— 未合并就构建 = 构建一份不含本次变更的产物，而它会顶替线上版本。

这条是 Agent 纪律而非门控：MR 合并状态在远端、用户可能延迟合并，
写成 BLOCKER 会把可选阶段卡死。

## 构建参数（`app` / `branch` / `group` / `env` / `build_other` **全部必填，缺一即构建失败**）

```
mcp_call_tool(devops, get-applications, {})        → 匹配当前项目对应的应用名
mcp_call_tool(devops, get-branches, { app })       → 确认分支存在（格式 origin/dev）
mcp_call_tool(devops, get-build-app, {
  app: "<应用名>",
  branch: "origin/dev",              // 必填：必须带 origin/ 前缀
  group: "JenkinsFrontweb",          // 必填：前端项目固定此分组
  env: "dev",                        // 必填：环境
  build_other: "dev"                 // 必填：构建制品参数，传【明文】dev
})                                                  → 记录构建号
mcp_call_tool(devops, get-records, { app })        → 轮询直到构建成功
```

## 产出物

部署 URL + 构建号（无文件型产出物，以汇报内容为准）。

## 收尾

```bash
# 归档（清空 Story root，全部文件移入 archive/round-{N}/）
node $HARNESS/archive-story.js <storyId> archive

# 关闭 harness 模式（删 .harness-active，解除 src/ 编辑限制）
# 注意：主流程完成时 session-stop 一般已自动 end，此处仅兜底
node $HARNESS/harness-workflow.js end
```

归档前可用 `--dry-run` 核对将要移走的文件清单。归档细节见 `../工作流生命周期.md`
与 `archive` skill。

## 本 Phase 才暴露的一类错误

Phase 2→3 的编译校验默认关闭，因此 **SCSS / 模板编译错误会一路漂到这里**才被云端构建拦住。
遇到这种情况：

1. 不要在本 Phase 修代码 —— `src/` 此时无 dev-pass，hook 会拒绝
2. 走 `node $HARNESS/advance-phase.js <storyId> 2 --rollback` 回退到开发
3. 修完后建议本轮启用 `HARNESS_RUN_BUILD=1` 再推进，避免二次漂移

见 [phase-2.md](./phase-2.md) 的「编译校验为什么默认关闭」。

## 常见失败与对策

- **构建成功但部署失败**：属于外部系统问题，如实回报构建号与错误，不要重试到超时。
- **已归档后发现要补部署**：先 `archive-story.js <id> restore` 复档，
  归档守卫会拦截归档状态下的 `--rollback` / `--fix-loop`。
