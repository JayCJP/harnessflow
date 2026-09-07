# 插件中知识库的使用方案 —— agent / skill / command / rules 四类载体

> 状态：现状梳理 + 重构同步
> 目标：厘清知识库在 harness 插件中的完整使用链路，确保 kb-init v2 重构（去 frontend 硬编码）后，所有载体一致指向新路径
> 关联：`rules/kb-auto-query.md`、`skills/kb-{init,query,update}/`、`skills/gen-project-docs/`、`agents/*.md`、`commands/{run,fixbugs}.md`

---

## 一、四类载体全景

知识库在插件中由 **4 类载体** 协作使用，各司其职：

| 载体 | 文件 | 角色 | 触发时机 |
|------|------|------|---------|
| **rules** | `rules/kb-auto-query.md` | 自动触发规则（alwaysApply） | 任何业务开发任务，无需等触发词 |
| **skill** | `skills/kb-{init,query,update}/`、`gen-project-docs/` | 可复用能力（脚本+提示词） | 由 agent 或 command 显式调用 |
| **agent** | `agents/*.md` | 角色提示词（嵌入知识库检索流程） | 每个 Phase 的 Agent 启动时 |
| **command** | `commands/{run,fixbugs}.md` | 命令入口（门控约定） | 用户触发 /harness 命令 |

---

## 二、四类载体的知识库使用细节

### 2.1 rules 层：自动触发规则

`rules/kb-auto-query.md`（`alwaysApply: true`）是**最底层的自动触发机制**，不依赖 agent 或 command 显式调用：

- **总则**：处理任何业务开发任务前，先查知识库，再操作代码
- **触发场景**：涉及功能模块 / 修改代码 / 询问实现 / 需求相关 / 不确定入口
- **流程**：L1 overview 定位域 → L2 meta.yaml 取文件配置 → L3 按需加载域文档
- **与 graphify 关系**：并行互补，不降级（语义层 vs 结构层）

> **v2 同步**：L1/L2 路径从 `.docs/llm-knowledge/frontend/` 改为 `.docs/llm-knowledge/`。

### 2.2 skill 层：可复用能力

4 个 skill 构成知识库的完整生命周期（详见 `KB_SKILL_重构_设计方案.md`）：

| Skill | 阶段 | 作用 |
|-------|------|------|
| kb-init | 初始化 | 项目画像 + 动态域扫描 + 建骨架 |
| gen-project-docs | 填充 | 扫描源码生成文档内容 |
| kb-update | 更新 | git diff 定位变更域 + 增量更新 |
| kb-query | 消费 | L1/L2/L3 分层检索 |

### 2.3 agent 层：角色提示词

每个 Agent 的「知识库集成」章节都内嵌了检索流程（kb-query ∥ graphify 双源交叉验证）：

| Agent | Phase | 知识库用途 |
|-------|-------|-----------|
| 需求分析师 | 0 | 确定需求涉及的业务域 |
| 任务规划师 | 1 | 语义层定位候选文件，拆任务 |
| 前端开发工程师 | 2 | 业务语义 + 踩坑记录 |
| 代码审查师 | 3 | 业务约束 + 已知问题 |
| 测试工程师 | 4 | 业务上下文 + 历史问题 → 回归范围 |
| 发布助手 | 5-7 | Phase 6 调用 kb-update 增量更新 |

> **v2 同步**：5 个 agent（需求/规划/开发/审查/测试）的 L1/L2 路径已从 frontend 改为新路径。

### 2.4 command 层：命令入口

| Command | 知识库约定 |
|---------|-----------|
| `run.md` | Phase 0 门控要求 agent 调用 `use_skill("kb-query")`；Phase 6 要求 `use_skill("kb-update")` |
| `fixbugs.md` | Bug 修复说明要求用 `kb-query ∥ graphify` 双源验证后自行设计 |

---

## 三、重构后的统一路径（v2）

所有载体统一指向新路径：

```
旧：.docs/llm-knowledge/frontend/{overview.md, meta.yaml, business/<domain>/}
新：.docs/llm-knowledge/{overview.md, meta.yaml, business/<domain>/}
```

| 载体 | 改动 |
|------|------|
| rules/kb-auto-query.md | L1/L2 路径去 frontend |
| skills/kb-init/kb-query/kb-update/gen-project-docs | 脚本 + SKILL.md 全部去 frontend |
| agents/*.md（5 个） | 知识库集成的 L1/L2 路径去 frontend |
| commands/run.md、fixbugs.md | 无路径硬编码，仅约定用 kb-query/kb-update，无需改 |
| scripts/services/context-refresh.js | evidenceKbRefresh 兼容新旧路径 |

---

## 四、知识库使用的完整数据流

```
                        ┌─────────────────────────────────────┐
                        │  rules/kb-auto-query.md (alwaysApply)│
                        │  自动触发：任何业务任务先查知识库      │
                        └──────────────┬──────────────────────┘
                                       │ 触发
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
   │  agent (角色提示词) │     │ command (命令入口) │     │  skill (可复用能力) │
   │  内嵌 kb-query 流程 │     │  门控约定 kb-update │     │  kb-init/query/    │
   │  双源交叉验证       │     │  要求 use_skill    │     │  update/gen-docs   │
   └────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
            │                        │                        │
            └────────────────────────┼────────────────────────┘
                                     ▼
                    ┌─────────────────────────────────┐
                    │  知识库（.docs/llm-knowledge/）  │
                    │  overview.md + meta.yaml +       │
                    │  business/<domain>/ 域文档        │
                    └─────────────────────────────────┘
```

---

## 五、核心结论

知识库在插件中的使用是 **4 类载体协同**：

1. **rules** 提供「自动触发」——不用等任何人说触发词
2. **skill** 提供「可复用能力」——脚本 + 提示词，跨项目复用
3. **agent** 提供「角色化检索」——每个 Phase 的 Agent 知道自己该查什么
4. **command** 提供「门控约定」——Phase 0 必须查，Phase 6 必须更新

kb-init v2 重构后，这 4 类载体已全部统一指向新路径 `.docs/llm-knowledge/`（去掉 frontend 硬编码层），分层检索（L1/L2/L3）概念保持不变。
