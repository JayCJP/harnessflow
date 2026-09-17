---
name: "kb-update"
description: "任务完成后自动增量更新知识库。接收 git commit hash，通过 git diff 定位变更文件，基于 meta.yaml 数据驱动受影映射到响业务域，调用 gen-project-docs 增量模式更新文档，保留手工批注。驱动词：更新知识库、kb-update、同步知识库"
---

# kb-update — 任务完成后自动更新知识库（全局 Skill）

在 Git 提交后自动将本次开发内容同步到知识库。

> 本 Skill 自包含：脚本 `./kb-update.cjs` → 数据驱动域匹配（基于 meta.yaml），不硬编码任何路径规则。
> "AI 负责认知，脚本负责执行" — git diff + 域匹配由脚本完成，文档更新由 AI 完成。

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 执行脚本 | `./kb-update.cjs` | git diff + meta.yaml 数据驱动域匹配 + 原型文档扫描 → JSON |

---

## 前置条件

项目需有 `meta.yaml`（kb-init 或手动创建），每个 domain 配置了文件字段（字段名按项目类型，如 `entry_files` / `files`，不再是固定的 `stores/apis/components`）。

```yaml
domains:
  - id: "settings"
    path: "business/settings/"
    entry_files: ["src/views/pc/Settings.vue"]   # 前端项目示例
  - id: "scripts-core"
    path: "business/scripts-core/"
    entry_files: ["plugins/harness/scripts/lib/*.js"]   # 插件项目示例
```

**知识库根（KB root）自动探测**：脚本不再硬编码 `.docs/llm-knowledge`，而是按下列候选依次探测 `meta.yaml`：

| 布局 | 路径 | 说明 |
|------|------|------|
| 扁平（v2） | `<root>/.docs/llm-knowledge/meta.yaml` | 单端项目 |
| 带端层（v1） | `<root>/.docs/llm-knowledge/<platform>/meta.yaml` | 如 `frontend/`、`h5/`、`miniprogram/`，扫描一层子目录 |

多个候选同时存在时按「更像真正知识库根」打分择优（含 `business/` 子目录 +2、含 `overview.md` +1），避免命中遗留的临时副本。若自动探测不中，可用 `--kb-root=<path>` 或环境变量 `KB_ROOT` 显式指定。

---

## 执行流程

### Step 1: 脚本提取变更 + 匹配域 + 扫描原型文档

```bash
node "<skill_dir>/kb-update.cjs"                      # 自动探测 KB root + 自动采集 diff
node "<skill_dir>/kb-update.cjs" <commitHash>          # 指定 lastHash（覆盖 meta.yaml 记录值）
node "<skill_dir>/kb-update.cjs" --kb-root=<path>      # 指定知识库根
node "<skill_dir>/kb-update.cjs" --include-kb-docs     # 把知识库自身文档变更也并入 changedFiles
node "<skill_dir>/kb-update.cjs" --help                # 打印用法
```

变更文件来源取三者**并集**（`diffSource` 字段如实回报）：

1. `committed` —— `git diff --name-only <lastHash>..<currentHash>`（`lastHash` = CLI 参数 > `meta.yaml` 的 `git.hash` > `HEAD`）
2. `working-tree` —— `git diff --name-only HEAD`（含暂存 / 未暂存 / 删除），**支持「改动未提交就先同步知识库」**
3. `untracked` —— `git ls-files --others --exclude-standard`（新增文件尚未 `git add` 的情形）

输出 JSON：

```json
{
  "kbRoot": "<absolute-path>/.docs/llm-knowledge/frontend",
  "metaPath": "<absolute-path>/.docs/llm-knowledge/frontend/meta.yaml",
  "lastHash": "abc123",
  "currentHash": "def456",
  "diffSource": "committed:abc123..def456+working-tree+untracked",
  "changedFiles": ["src/views/pc/settings/AssignRule.vue", "..."],
  "kbDocFiles": [".docs/llm-knowledge/frontend/log.md", "..."],
  "affectedDomains": [{ "id": "settings", "path": "...", "matchedFiles": [...] }],
  "designDocs": [{
    "storyId": "STORY-002",
    "title": "1v1客服等级分配模式",
    "prototypeUrl": "https://modao.cc/...",
    "sourcePath": ".codebuddy/plans/STORY-002/prototype-analysis.md",
    "targetDomain": "settings",
    "targetPath": "business/settings/design/xxx.md",
    "targetDir": "<absolute-path>/design/",
    "fileName": "xxx.md"
  }],
  "skippedDesignStories": ["STORY-001"],
  "warnings": [],
  "errors": []
}
```

匹配算法（脚本内）：对每个变更文件，遍历 meta.yaml 所有域，检查是否命中该域的文件字段（`entry_files` / `files` 等，支持通配符 `*`）前缀。git 调用统一带 `-c core.quotepath=false`，含中文/空格/特殊字符的路径不会被转义成 `"\345\..."` 而失配。

**四条附加语义**：

| 机制 | 说明 |
|------|------|
| `changedFiles` vs `kbDocFiles` | `.docs/llm-knowledge/**` 属知识库自身文档，默认从 `changedFiles` 剔除、单独回报，避免噪音与「改 KB 触发 KB 更新」的自触发误判；要合并用 `--include-kb-docs` |
| 域健康检查 | `meta.yaml` 中「域未解析到任何文件字段」或「文件字段指向已不存在的路径」→ `warnings` 报警（文件被删除但 entry 还留着的**静默失配**从此可见）。只对形如 `<目录>/<文件>.<扩展名>` 且不含通配符的字段做存在性校验，纯文件名片段与目录会跳过 |
| 原型文档去重 | `meta.yaml#design_docs` 已登记的 story 不再出现在 `designDocs`，改报 `skippedDesignStories`，避免同一份原型文档被反复搬运 |
| 原型文档目标域 | **不猜**：只采信 story `e2e-state.json` 的显式 `domain`；匹配不到则 `targetDomain: null` + `warnings`，由 AI/人工决定 |

### Step 2: AI 增量更新文档

对每个受影响域：
1. 读取已有文档
2. 保留 `<!-- CUSTOM:START --> ... <!-- CUSTOM:END -->` 手工批注
3. 扫描变更文件，提取新增/修改的函数、组件、API
4. 更新对应文档（overview / pages / api / store 等）

### Step 3: 更新索引

- `meta.yaml` `git.hash` = 当前 HEAD
- 更新 `doc_stats` 计数
- 追加 `log.md` 记录

### Step 4: 沉淀原型设计文档 🆕

对 `designDocs` 中的每一项：
1. 检查 `targetDomain` 是否非空
2. 在 `targetDir` 创建 `design/` 目录（如不存在）
3. 将 `sourcePath` 的原型文档复制到 `targetPath`
4. 在 `meta.yaml` 对应 domain 下追加/更新 `design_docs` 条目：

```yaml
domains:
  - id: "settings"
    design_docs:
      - id: "level-allocation"
        title: "1v1客服等级分配模式"
        prototype_url: "https://modao.cc/..."
        doc_path: "business/settings/design/level-allocation.md"
        story_id: "STORY-002"
        created_at: "2026-07-09"
```

5. 如 `designDocs` 为空或无 `targetDomain`，跳过此步骤

---

## 追溯链

```
prototype-analysis.md (plans/)
    ↓ Step 4 自动迁移
design/<doc>.md (knowledge base)
    ↓ meta.yaml 索引
keyword search → L1 domain match → L3 load design doc
```

---

## 容错

- 更新失败不阻断后续流程
- `errors` 非空时标记 `completed_with_errors`
- `warnings` 为**非阻断提示**，照常继续并**如实转述给用户**。常见来源：未找到 `meta.yaml`、`domains[]` 解析为空、采集不到任何变更、**域未解析到文件字段 / 文件字段指向不存在的路径**（域会静默失配）、**原型文档未匹配到目标域**（`targetDomain` 已置 null）
- 原型文档迁移失败仅记录 warning，不影响主流程
- 下次增量更新自动补齐
- **脚本跑不通时（如本机 git/node 环境异常）**：按本容错章节，改由 AI 等价执行 Step 1（`git status --porcelain` + `git diff --name-only HEAD` 取变更 → 按 `meta.yaml` 各域文件字段前缀匹配），并在 `log.md` 中记明失败根因
