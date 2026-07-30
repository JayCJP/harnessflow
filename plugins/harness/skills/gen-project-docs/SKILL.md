---
name: "gen-project-docs"
description: "自动生成项目结构化知识库文档。按业务域扫描源码，生成 8 类标准化文档（overview/pages/api/store/architecture/config/pitfalls/custom），支持增量更新、手工批注保留与新鲜度检测。触发词：生成知识库文档、更新项目文档、gen-docs、文档生成、增量更新知识库、新鲜度检测"
location: "user"
---

# gen-project-docs — 项目文档生成（全局 Skill）

自动扫描前端项目源码，按业务域生成符合规范的 8 类结构化文档。

> 框架无关：不限定 Vue/React/Angular。数据驱动：从 `meta.yaml` 获取每个域的扫描目标。  
> 本 Skill 自包含：脚本 `./gen-docs.cjs` 收集文件路径（确定操作），AI 生成文档内容（认知操作）。

---

## 自包含资源

| 资源 | 路径 | 说明 |
|------|------|------|
| 执行脚本 | `./gen-docs.cjs` | 读 meta.yaml → 输出每域需扫描的文件清单 JSON |

---

## 前置条件

- 项目已通过 `kb-init` 初始化知识库骨架
- `meta.yaml` 各域已配置 `entry_files / stores / apis / components`
- 源码在 `src/` 下

---

## 4 种模式

| 模式 | 命令 | 用途 |
|------|------|------|
| 全量 | `./gen-docs.cjs --all` | 首次 / 重建全量知识库 |
| 单域 | `./gen-docs.cjs <domain_id>` | 只生成指定域 |
| 增量 | `./gen-docs.cjs` | Phase 6 自动触发（配合 kb-update） |
| 新鲜度 | `./gen-docs.cjs --stale` | 只检测不生成，输出 `{ stale, changedCount }` |

---

## 8 类文档生成规范

对每个域，AI 按以下顺序生成：

| # | 文档 | 数据来源 | 内容 |
|---|------|---------|------|
| 1 | `overview.md` | 汇总 | 域定位、入口文件、核心流程、设计决策 |
| 2 | `pages.md` | `entry_files` | 路由配置、页面组件列表 |
| 3 | `api.md` | `apis` | 接口签名、参数、返回值 |
| 4 | `store.md` | `stores` | State/Getters/Actions、数据流 |
| 5 | `architecture.md` | 组件+store | 依赖图、数据流、设计模式 |
| 6 | `config.md` | 配置文件 | 环境变量、编译/运行时配置 |
| 7 | `pitfalls.md` | lint+经验 | 已知问题、避坑建议 |
| 8 | `log.md` | 自动追加 | 变更历史（不可覆盖） |

## 手工批注保留

增量更新时，以下区域不覆盖：
```markdown
<!-- CUSTOM:START -->
[人工编写的业务说明]
<!-- CUSTOM:END -->
```

## 配合其他 Skill

| Skill | 关系 |
|-------|------|
| `kb-init` | 先驱—创建骨架 |
| `kb-update` | 触发方—定位变更域后调用 |
| `kb-query` | 消费方—开发时检索 |

## log.md 格式

```markdown
## YYYY-MM-DD HH:MM
- Git hash: abc123 | 模式: incremental
- 域: settings | 文件: 更新 overview.md
```
