# Harness Marketplace 插件市场

**Harness Engineering 端到端开发自动化工作流插件市场。**

通过本插件市场，你可以安装 **Harness** 插件，获得一条覆盖「Bug 分析 → 需求分析 → 任务规划 → 代码开发 → 审查 → 测试 → 部署」全流程的自动化开发流水线，并配套知识库（KB）管理、文档生成、API 生成、Figma 协作等能力。

> **同时兼容 Claude Code 与 CodeBuddy Code**
> 本插件市场同时支持 **Claude Code** 与 **CodeBuddy Code** 两款 AI 编程工具，两者使用相同的 `/plugin` 命令体系，安装步骤完全一致。
> 市场清单分别位于 `.claude-plugin/marketplace.json`（Claude Code）与 `.codebuddy-plugin/marketplace.json`（CodeBuddy Code），内容一致，可任选其一安装。

> 安装源（GitHub）：`https://github.com/JayCJP/harnessflow.git`

---

## 目录

- [插件能力概览](#插件能力概览)
- [环境要求](#环境要求)
- [安装教程](#安装教程)
- [常用命令](#常用命令)
- [插件配置](#插件配置)
- [卸载与故障排除](#卸载与故障排除)

---

## 插件能力概览

安装后提供 **1 个市场插件（harness）**，包含：

| 类型 | 内容 |
| --- | --- |
| **命令 (Commands)** | `/harness run`（执行全流程）、`/harness fixbugs`（修复 Bug）、`/harness evolve`（自进化）、`/harness archive`（归档） |
| **代理 (Agents)** | 需求分析师、任务规划师、前端开发工程师、代码审查师、测试工程师、发布助手 |
| **技能 (Skills)** | `harness-conductor`（工作流编排）、`kb-query` / `kb-update` / `kb-init`（知识库管理）、`gen-project-docs`（文档生成）、`api-generator`（接口生成）、`figma` / `figma-to-component-map`（设计稿协作）、`tapd-bug-analyzer`（TAPD 缺陷分析）、`harness-evolve`（自进化） |
| **规则 (Rules)** | `kb-auto-query`（知识库自动检索） |
| **钩子 (Hooks)** | 工作流阶段钩子 |

---

## 环境要求

- 已安装 **Claude Code** 或 **CodeBuddy Code**（建议使用最新版本，两者均可）。
- 安装后可访问 GitHub 仓库：`https://github.com/JayCJP/harnessflow.git`。
- 如需使用 TAPD、Figma、DevOps 等能力，请确保对应 MCP 服务已配置。

---

## 安装教程

安装分两步：**① 添加市场 → ② 安装插件**。

### 第 1 步：添加市场

在 Claude Code 或 CodeBuddy Code 的命令输入框中执行：

```bash
/plugin marketplace add https://github.com/JayCJP/harnessflow.git
```

> 若本机已配置 GitHub SSH 密钥，也可使用 SSH 方式：
>
> ```bash
> /plugin marketplace add git@github.com:JayCJP/harnessflow.git
> ```

添加成功后，市场名称为 **`harness-marketplace`**。

### 第 2 步：安装插件

执行：

```bash
/plugin install harness@harness-marketplace
```

此时会提示选择**安装作用域**：

- **用户作用域**（默认）：对本机所有项目生效
- **项目作用域**：仅对当前仓库生效（写入 `.codebuddy/settings.json`，对协作者生效）
- **本地作用域**：仅本人当前仓库生效

### 第 3 步：重新加载插件

```bash
/reload-plugins
```

加载完成后会输出插件、技能、代理等统计信息。安装即生效，无需重启。

### 验证安装

```bash
/plugin list
```

确认列表中包含 `harness` 插件。

---

## 常用命令

安装后即可使用以下命令：

| 命令 | 说明 |
| --- | --- |
| `/harness run` | 执行端到端开发工作流（Bug 分析 → 需求分析 → 任务规划 → 开发 → 审查 → 测试 → 部署） |
| `/harness fixbugs` | 针对缺陷进行根因分析并自动修复 |
| `/harness evolve` | 触发插件自进化体检（audit → 度量 → 诊断 → 治疗 → 验证） |
| `/harness archive` | 归档已完成的迭代 / 任务 |

---

## 插件配置

插件安装后，可在插件配置中设置：

| 配置项 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `workspaceRoot` | string | 默认工作区根目录 | `D:/workfile` |

可在 `/plugin` 界面中找到 `harness` 插件并修改该配置。

---

## 卸载与故障排除

### 卸载插件

```bash
/plugin uninstall harness@harness-marketplace
```

### 移除市场（注意：会同时卸载该市场下所有插件）

```bash
/plugin marketplace remove harness-marketplace
```

### 常见问题

| 问题 | 解决方法 |
| --- | --- |
| 市场添加后无法加载 | 确认 GitHub 地址可访问，且仓库根目录存在 `.codebuddy-plugin/marketplace.json` |
| 安装时提示「路径未找到」 | 优先使用 Git 型市场（即上面的 Git 地址），不要用 URL 型 |
| 命令 / 技能不显示 | 删除缓存 `rm -rf ~/.codebuddy/plugins/cache` 后重启并重新安装 |
| 需要调试日志 | 启动 CodeBuddy Code 时加 `--debug` 参数 |

---

## 仓库结构（面向维护者）

```
harness-marketplace/
├── .codebuddy-plugin/
│   └── marketplace.json        # 市场清单（定义插件入口）
└── plugins/
    └── harness/                # Harness 插件本体
        ├── plugin.json         # 插件元信息与配置
        ├── agents/             # 6 个工程角色代理
        ├── commands/           # 工作流命令（run / fixbugs / evolve / archive）
        ├── skills/             # 10 个技能（工作流编排、知识库、文档等）
        ├── hooks/              # 阶段钩子
        ├── rules/              # 知识库自动检索规则
        ├── scripts/            # 配套脚本（audit / services / schemas 等）
        └── output-styles/      # 输出样式
```
