---
name: "kb-init"
description: "初始化项目知识库目录结构和规范。自动创建 llm-knowledge/ 标准化目录骨架（overview/meta.yaml/7域/8类文档模板/common/），扫描 src/ 识别业务域、提取入口文件和依赖关系。触发词：初始化知识库、kb-init、知识库初始化、搭建知识库目录"
location: "user"
---

# kb-init — 知识库初始化（全局 Skill）

为任意项目创建符合 Harness Engineering 规范的结构化知识库骨架。

> 本 Skill 自包含：模板从 `./templates/` 读取，脚本执行 `./kb-init.cjs`。  
> 不依赖项目中的任何文件，可跨项目复用。

与 `gen-project-docs` 的关系：
- **kb-init**: 创建**目录骨架 + meta.yaml 索引 + 模板**（本 Skill）
- **gen-project-docs**: 填充**具体文档内容**（扫描源码生成）

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 文档模板 | `./templates/*.template.md` | 8 类文档模板 |
| 执行脚本 | `./kb-init.cjs` | 创建目录 + 写入定制文件 |

---

## 执行流程

### Step 0: 项目理解

读取目标项目的根信息：
- `CODEBUDDY.md` / `package.json` → 项目定位、技术栈
- `src/` 目录结构 → 推断业务域

### Step 1: 执行脚本（确定性操作）

```bash
node "<skill_dir>/kb-init.cjs"
```

脚本负责：创建目录骨架、写入 `custom/README.md`、写入 `common/` 索引、复制 `templates/`。

### Step 2: 生成 overview.md（AI 认知操作）

基于 `./templates/overview.template.md`，填充：
- 项目定位（从 CODEBUDDY.md 提取）
- 技术栈表
- **业务域地图**（关键词 → 域文档入口）

### Step 3: 生成 meta.yaml（AI 认知操作）

扫描 `src/` 推断域，填充 `meta.yaml` 的 `domains[]` 和 `git.hash`。

域识别规则：
| 源码路径 | 推断域 |
|---------|--------|
| `src/views/pc/chat.vue` / `src/views/pc/settings/` / `src/views/pc/ticket/` | chat / settings / ticket |
| `src/api/csReception*` / `src/api/oneToOne*` | chat |
| `src/api/pc*` / `src/api/quickReply*` | settings + permission |

### Step 4: 生成域级 overview.md

每域按 `./templates/overview.template.md` 生成 `business/<domain>/overview.md`。

### Step 5: 输出报告

```
知识库初始化完成 ✅
- 目录: .docs/llm-knowledge/frontend/
- 业务域: N 个 | 模板: 8 类
- meta.yaml: git.hash = <current HEAD>
- 下一步: gen-project-docs 填充内容
```

---

## 使用示例

```
# 任意项目中首次使用
用户: "初始化知识库"
→ 脚本创建目录 + AI 生成 overview.md/meta.yaml/域文档

# 重建（保留 custom/）
用户: "重建知识库目录"
→ 合并更新 meta.yaml → 保留 custom/ 手工文档
```

## 注意事项

- kb-init **不扫描源码生成内容**（由 gen-project-docs 负责）
- 已有 `custom/` 手工文档不被覆盖
- 脚本为 CommonJS（`.cjs`），兼容 ES module 项目
- 模板从 Skill 目录复制到项目 `.docs/llm-knowledge/frontend/templates/`
