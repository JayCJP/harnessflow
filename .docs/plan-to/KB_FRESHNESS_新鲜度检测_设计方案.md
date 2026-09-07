# 知识库新鲜度检测 — 设计方案

> 背景：腾讯技术工程文章《从 AI Coding 到 Harness Engineering》强调「过期知识比没有知识更危险」，
> 并提出「git hash 差异超过阈值 → 标记过期 → 派发 CLI 自动增量更新」的完整机制。
> 本项目 `gen-docs.cjs --stale` 目前只输出布尔值 `{ stale, changedCount }`，缺阈值分级与自动派发。
> 本文将其升级为「分级 + 阈值 + 自动派发」的完整新鲜度闭环。
>
> 涉及脚本：`plugins/harness/skills/gen-project-docs/gen-docs.cjs`
> 元数据文件：`.docs/llm-knowledge/meta.yaml`
> 成文日期：2026-08-15

---

## 1. 现状诊断

当前 `gen-docs.cjs --stale`（第 84~92 行）逻辑：

```js
if (mode === 'stale') {
  const cur = execSync('git rev-parse HEAD').trim()
  const diff = execSync(`git diff --name-only ${meta.git.hash || cur}..${cur}`).trim()
  const changed = diff ? diff.split('\n').filter(Boolean).length : 0
  console.log(JSON.stringify({ mode: 'stale', stale: changed > 0, changedCount: changed }))
}
```

**三个缺陷：**

| 缺陷 | 表现 | 后果 |
|------|------|------|
| ① 只有布尔，无分级 | `stale: true/false` | 改 1 个文件与改 100 个文件同样「过期」，无法区分严重度 |
| ② 无阈值 | 任何 diff 都算过期 | 提交一个 typo 就触发「过期」，噪音大；真正脱节的域又没被强调 |
| ③ 无自动派发 | 只检测不更新 | 检测结果不落地，无人消费，闭环断裂 |

---

## 2. 目标

把 `--stale` 从「布尔探测」升级为「三级新鲜度评估 + 阈值判定 + 可派发的更新清单」：

1. **三级新鲜度**：`fresh`（新鲜）/ `stale`（陈旧）/ `critical`（严重脱节）
2. **阈值驱动**：按 commit 数 + 天数双维度判定，而非「有没有 diff」
3. **域级颗粒度**：不只报整体，精确到「哪些域过期、该更新哪些文档」
4. **可派发**：输出结构化 `updateTargets`，供 `kb-update` / Phase 6 直接消费

---

## 3. 核心设计

### 3.1 新鲜度分级（三级）

| 级别 | 判定条件 | 语义 | 建议动作 |
|------|---------|------|---------|
| `fresh` | 无 diff 或 diff 影响文件数 < `warnThreshold` | 知识库与代码一致 | 无动作 |
| `stale` | diff 影响文件数 ≥ `warnThreshold`，但 < `criticalThreshold` | 部分域已过时 | 触发增量更新（可自动） |
| `critical` | diff 影响文件数 ≥ `criticalThreshold`，或 commit 数超限，或天数超限 | 大面积脱节，存在「AI 调老接口」风险 | 强制派发更新 + 告警 |

### 3.2 阈值参数（三级阈值）

在 `meta.yaml` 的 `git` 块下新增 `freshness` 配置，默认值如下：

```yaml
git:
  hash: "db8562744be086322fe93e343aa859b651687c1b"
  updated_at: "2026-08-14"
  freshness:                      # 新增：新鲜度阈值
    warn_commits: 5              # 落后 commit 数达到即 stale
    critical_commits: 30         # 落后 commit 数达到即 critical
    warn_days: 3                 # 落后天数达到即 stale
    critical_days: 14            # 落后天数达到即 critical
    min_changed_files: 3         # 影响文件数下限（低于此不算过期，滤噪）
```

**判定优先级**（任一命中即升级到对应级别）：

```
critical：commit 数 ≥ critical_commits || 天数 ≥ critical_days
stale   ：commit 数 ≥ warn_commits     || 天数 ≥ warn_days || 影响文件数 ≥ min_changed_files
fresh   ：其余
```

> 阈值取值依据：`min_changed_files` 过滤 typo/单文件小改（对应缺陷②的噪音）；
> `critical_days=14` 对齐「半年前的文档已严重脱节」的常识，两周不更新即告警。

### 3.3 域级颗粒度（新增）

现有 `--stale` 只看整体 diff 行数，不区分「哪个域变了」。升级后：

1. 复用 `parseMetaYaml` 已解析的 `domains[]`（每个域有 `entry_files` 通配符）
2. 对每个域，展开 `entry_files` 得到文件集合，与 `git diff` 的结果做**交集**
3. 输出每个域的影响文件数，判定该域是否过期

这样能回答「不是知识库整体过期，而是 `scripts-core` 域过期了」，精确指导更新范围。

### 3.4 输出结构（向后兼容 + 增强）

```json
{
  "mode": "stale",
  "level": "stale",                    // fresh | stale | critical（新增，替代 boolean stale）
  "stale": true,                        // 保留旧字段，向下兼容
  "changedCount": 12,                   // 保留旧字段
  "metrics": {                          // 新增：判定依据
    "commitsBehind": 8,
    "daysBehind": 4,
    "changedFiles": 12
  },
  "domains": [                          // 新增：域级过期明细
    {
      "id": "scripts-core",
      "path": "business/scripts-core/",
      "changedFiles": 6,
      "level": "stale",
      "matchedFiles": ["plugins/harness/scripts/services/policy.js", "..."]
    }
  ],
  "updateTargets": [                    // 新增：可派发的更新清单（供 kb-update 消费）
    { "domainId": "scripts-core", "path": "business/scripts-core/", "level": "stale" }
  ]
}
```

---

## 4. 自动派发闭环（对应缺陷③）

检测结果落地后，形成两条派发路径：

### 4.1 流程内派发（Phase 6 已具备）

`kb-update` 的 `kb-update.cjs` 已经输出 `affectedDomains`（基于 git diff + meta.yaml 域匹配），
Phase 6 发布助手据此增量更新。**新鲜度检测与 kb-update 共用同一套 git diff 逻辑**，
只需让 `--stale` 输出的 `updateTargets` 与 `kb-update.cjs` 的 `affectedDomains` 结构对齐，
Phase 6 即可直接消费 `updateTargets` 作为「必须更新的域清单」。

### 4.2 独立派发（新增命令，文章方案的对齐点）

新增 `gen-docs.cjs --check` 命令（区别于 `--stale` 只检测不派发）：

```bash
# 检测 + 若 stale/critical 则自动执行增量更新
node "<skill_dir>/gen-docs.cjs" --check
```

语义：

| 级别 | `--check` 行为 |
|------|---------------|
| `fresh` | 仅报告，不更新 |
| `stale` | 自动增量更新对应域（调用 kb-update 路径） |
| `critical` | 自动全量重建 + 输出告警信息（建议人工复核） |

> 设计取舍：`critical` 走全量而非增量，是因为大面积脱节时增量 diff 可能漏掉结构性变更
> （如域拆分、文件重命名），全量重建更稳。`stale` 走增量，保留手工批注。

---

## 5. 改动清单

### 5.1 `gen-docs.cjs`（核心改动）

| 改动点 | 内容 |
|--------|------|
| 新增 `parseFreshness` 函数 | 从 meta.yaml 的 `git.freshness` 读阈值，缺省用默认值 |
| 重写 `--stale` 分支 | 计算 commitsBehind / daysBehind / changedFiles，三级判定 |
| 新增域级交集 | 遍历 domains，用 `expandGlob`（已存在）展开 entry_files 与 diff 求交 |
| 新增 `--check` 模式 | 检测后按级别自动派发（复用增量/全量生成逻辑） |
| 保留旧字段 | `stale`、`changedCount` 继续输出，向下兼容 |

### 5.2 `meta.yaml`（新增配置块）

`git` 块下新增 `freshness` 阈值（见 3.2）。`kb-update.cjs` 更新 meta.yaml 时需保留此块。

### 5.3 `kb-init.cjs`（初始化时写入默认阈值）

`kb-init` 生成 meta.yaml 骨架时，自动写入默认 `freshness` 块，确保新项目开箱即有阈值。

### 5.4 SKILL.md 文档（补充说明）

`gen-project-docs/SKILL.md` 的「4 种模式」表新增 `--check` 行，并补充新鲜度分级说明。

---

## 6. 边界与取舍

| 问题 | 决策 |
|------|------|
| 天数的来源 | 用 `git.updated_at`（字符串日期）与当前日期求差；若缺失则只按 commit 数判定 |
| meta.yaml 无 freshness 块 | 全部用默认值，不报错（向后兼容） |
| 域级交集的通配符展开成本 | `expandGlob` 已在用，无新增成本 |
| 是否引入伽利略调用量（接口活跃度） | **不在本方案范围**，属独立主题，需 MCP 接入，另立项 |
| 是否自动写回 meta.yaml hash | 否，更新后由 kb-update 负责写回，避免双写 |

---

## 7. 验收标准

1. `--stale` 在 0 diff 时输出 `level: fresh`；小改动（< min_changed_files）仍 fresh
2. 落后 30+ commit 或 14+ 天时输出 `level: critical`
3. 输出 `domains[]` 能精确定位到过期的具体域
4. `--check` 在 stale 级别自动触发增量更新，critical 级别全量重建
5. 旧字段 `stale` / `changedCount` 仍存在，不破坏现有调用方
