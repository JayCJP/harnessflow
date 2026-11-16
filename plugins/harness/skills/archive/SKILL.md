---
name: archive
description: 归档 Story 全部文件 / 复档恢复 / 查看归档历史，归档后仅保留 story-info.json 身份卡
---

# /archive — Story 归档与复档

> 将 story 根目录**全部文件**归档到 `archive/round-{N}/`，root 目录清空。
> 复档（restore）将归档文件全量恢复到 root，完全复原。
> 归档后 `advance-phase.js` 的 `--rollback` / `--fix-loop` 被守卫拦截。

## 脚本

```bash
# 脚本路径：${CLAUDE_PLUGIN_ROOT}/scripts/commands
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js <storyId> <command> [options]
```

## 命令一览

| 命令 | 作用 | 说明 |
|------|------|------|
| `archive` | 归档全部文件 | root 全部文件 → `archive/round-{N}/`（root 清空） |
| `restore` | 复档恢复 | `archive/round-{N}/` 全部文件 → root（完全复原） |
| `list` | 列出归档轮次 | 查看所有已归档的 round |
| `status` | 查看归档状态 | 当前是否已归档、root 文件情况等 |

---

## 归档：archive

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js <storyId> archive [--dry-run] [--round <N>] [--force]
```

| 选项 | 说明 |
|------|------|
| `--dry-run` | 预览归档文件清单，不实际移动 |
| `--round <N>` | 指定轮次编号（缺省自动检测：扫描 `archive/round-*` 取最大+1） |
| `--force` | 主流程未走完（未到 Git 提交阶段）时强制归档 |

**执行流程**：
1. 读取 `e2e-state.json` 获取当前状态
2. 防重复归档：root 目录无文件时拒绝
3. 终态检查（主流程未走完需 `--force`）：主流程 = 审查 → 知识库更新 → Git 提交 + 建 MR，
   到达 Git 提交阶段即可直接归档；云端部署是可选阶段，未做也不阻塞归档（输出 `optionalNote` 提示）
4. 扫描 root 目录**所有文件**（排除 `archive/` 子目录）
5. 更新 `e2e-state.json` 状态为 `archived`，追加 trace
6. 将文件移入 `archive/round-{N}/`（含 e2e-state.json / trace.jsonl / repos.json），
   **跳过 `story-info.json` 与 `debug.jsonl`**（前者是身份卡，后者是运行时日志）
7. 删除 `dev-pass.json`（不归档）
8. 清理 root 空子目录
9. 就地更新 `story-info.json`：`status=archived`、`archiveRound`、`archivedAt`、`phaseReached`

**建议**：先执行 `--dry-run` 预览确认无误后再正式归档。

> **归档后仍可查的 Story 元信息** —— `story-info.json` 不被归档移动，归档完成后 root 只剩它与
> `debug.jsonl`。里面保存的是 storyId、标题、模式、**TAPD 需求链接 / 工作区 ID / 需求 ID**、
> 仓库名与工作区根路径，无需先 restore 就能查到。

## 复档：restore

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js <storyId> restore [--round <N>] [--force] [--keep-archive]
```

| 选项 | 说明 |
|------|------|
| `--round <N>` | 指定复档轮次（缺省自动取最新 round） |
| `--force` | 覆盖根目录同名文件 |
| `--keep-archive` | 保留归档副本（默认移动，归档目录清空） |

**执行流程**：
1. 确定目标轮次（指定或自动检测最新）
2. 扫描 `archive/round-{N}/` 所有文件
3. 检查 root 同名文件冲突（需 `--force` 覆盖）
4. 将归档文件全部恢复到 root（含子目录结构）
5. 非 `--keep-archive` 模式下清理空归档目录
6. 更新恢复后的 `e2e-state.json` 状态为 `running`
7. 追加 trace

> 复档后 `--rollback` / `--fix-loop` 立即恢复可用。

## 列表：list

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js <storyId> list
```

列出 story 的所有归档轮次，包含每轮的文件数、总大小、归档时间、达成的 Phase。

## 状态：status

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/commands/archive-story.js <storyId> status
```

查看当前归档状态：root 是否有文件、e2e-state 是否存在、归档轮次等。root 无文件即视为已归档。

---

## 归档目录结构

```
归档前                                 归档后
───────                               ───────
.codebuddy/plans/<storyId>/           .codebuddy/plans/<storyId>/
├── story-info.json  ← 身份卡         │  story-info.json   ← 保留，不进归档
├── e2e-state.json                    │  debug.jsonl       ← 保留，运行时日志
├── trace.jsonl                       │
├── repos.json                        ├── archive/
├── requirement-analysis.md           │   ├── round-1/
├── task-dag.json                     │   │   ├── e2e-state.json
├── code-review.json                   │   │   ├── trace.jsonl
├── ... (所有产物)                     │   │   ├── requirement-analysis.md
└── archive/                          │   │   ├── task-dag.json
    └── (旧的 .archived 散落文件)       │   │   ├── code-review.json
                                      │   │   ├── ... (全部文件)
                                      │   └── round-2/
                                      │       └── ...（下一轮）
```

> 归档后 root 只剩 `story-info.json`（身份卡）与 `debug.jsonl`（运行时日志），
> 其余文件（含 `e2e-state.json`、`trace.jsonl`、`repos.json`）均进入 `archive/round-{N}/`。
> 归档过程中同时清理 `archive/` 中的旧 `.archived` 散落文件。

## Story 身份卡：story-info.json

建流时（`create-workflow.js`）写入，**归档不移走它**，因此归档后无需 restore 即可查到：

| 字段 | 含义 |
|------|------|
| `storyId` / `title` | Story 标识与标题 |
| `mode` | `run` / `fixbugs` |
| `sources.tapdUrl` | TAPD 需求或缺陷链接 |
| `sources.workspaceId` | TAPD 项目（工作区）ID |
| `sources.storyIdInTapd` | TAPD 需求 ID |
| `sources.owner` | Bug 处理人（fixbugs 模式） |
| `sources.figmaUrls` / `prototypeUrls` / `docs` | 设计稿、原型、需求文档入口 |
| `repos` | 主仓库名 + 仓库名列表（不存绝对路径） |
| `workflowRoot` | 工作区根路径（正斜杠） |
| `status` / `archivedAt` / `archiveRound` | 归档时间线与轮次 |

`sources` 由 `story-input.json` 的 `sources` 原样投影，不重新解析 URL。
若走旧通道（建流后才写 `story-input.json`），执行 `create-workflow.js <storyId> --refresh-input`
会把来源字段补进身份卡。

查询方式：`archive-story.js <storyId> status` 会把 `sources` / `repos` 一并输出。

## 守卫机制

归档后 `advance-phase.js` 的 `--rollback` 和 `--fix-loop` 被守卫拦截：

| 场景 | 归档前 | 归档后 |
|------|--------|--------|
| `--rollback` | ✅ 正常执行 | ❌ 拒绝：root 无 e2e-state |
| `--fix-loop` | ✅ 正常执行 | ❌ 拒绝：root 无 e2e-state |
| 常规 Phase 推进 | ✅ 正常执行 | —（phase=8 不会再推进） |

> 复档（restore）后所有文件回到 root，守卫自动解除。

## 安全约束

1. **防重复归档** — root 除 `story-info.json` / `debug.jsonl` 外无文件时拒绝再次归档
2. **主流程保护** — 未走完 Git 提交阶段时警告，需 `--force` 强制归档
3. **复档冲突保护** — root 存在同名文件时拒绝覆盖（需 `--force`）
4. **dry-run 优先** — 建议先预览确认无误后正式执行
5. **全量归档** — 除身份卡与运行时日志外全部进 archive，归档即完整备份
