# INSTALL — Harness Marketplace 安装指南（面向 AI 代理）

> 本文档指导 **AI 代理**（Claude Code / CodeBuddy Code）在本机安装 Harness 插件市场并完成验证。
> 如果你是人类用户，请参阅 [README.md](./README.md)。
> 本仓库同时兼容 **Claude Code** 与 **CodeBuddy Code**（两者使用相同的 `/plugin` 命令体系，
> 市场清单分别位于 `.claude-plugin/marketplace.json` 与 `.codebuddy-plugin/marketplace.json`，内容一致）。

---

## 0. 安装前检查（AI 必须先确认）

在执行任何安装命令前，依次确认以下条件，任一不满足请先解决再继续：

| # | 检查项 | 通过条件 | 失败处理 |
|---|--------|---------|---------|
| 1 | 工具已安装 | 已安装 **Claude Code** 或 **CodeBuddy Code**（两者任一即可，均能识别 `/plugin` 命令） | 提示用户先安装 Claude Code 或 CodeBuddy Code |
| 2 | GitHub 可访问 | `git ls-remote https://github.com/JayCJP/harnessflow.git` 返回 refs | 提示用户检查网络与 GitHub 账号权限 |
| 3 | 仓库结构完整 | 仓库根目录存在 `.codebuddy-plugin/marketplace.json`（或 `.claude-plugin/marketplace.json`）与 `plugins/harness/plugin.json` | 提示用户仓库克隆不完整 |
| 4 | 无需 npm 依赖 | `plugins/harness/vendor/ajv.bundle.js` 存在（ajv 已单文件内置，**不需要 `npm install`**） | 若缺失，从 GitHub 官方 `ajv-dist` 的 CDN 重新 vendor 后提交 |

> ⚠️ **重要**：本插件 **不依赖 `node_modules`**。`scripts/services/schema-validator.js`
> 通过 `require('../../vendor/ajv.bundle.js')` 使用内置的单文件 ajv（8.x，UMD 格式）。
> 如果你看到任何 `npm install` 步骤或 `ajv` 报 `MODULE_NOT_FOUND`，说明仓库状态异常，请检查 `vendor/ajv.bundle.js` 是否存在。

---

## 1. 添加市场

在工具命令输入框中执行：

```bash
/plugin marketplace add https://github.com/JayCJP/harnessflow.git
```

- 添加成功后市场名为 **`harness-marketplace`**。
- 若本机已配置 GitHub SSH 密钥，也可用 SSH 方式：
  ```bash
  /plugin marketplace add git@github.com:JayCJP/harnessflow.git
  ```

**验证**：执行 `/plugin marketplace list`，输出中应包含 `harness-marketplace`。

---

## 2. 安装插件

```bash
/plugin install harness@harness-marketplace
```

安装时会提示选择**安装作用域**，默认选 **用户作用域**（对本机所有项目生效）：

| 作用域 | 生效范围 | 适用场景 |
|--------|---------|---------|
| 用户作用域（默认） | 本机所有项目 | 个人开发机 |
| 项目作用域 | 仅当前仓库，写入 `.codebuddy/settings.json` | 团队协作、随仓库分发 |
| 本地作用域 | 仅本人当前仓库 | 临时调试 |

---

## 3. 重新加载插件

```bash
/reload-plugins
```

加载完成后会输出插件、技能、代理、命令等统计信息。**安装即生效，无需重启工具。**

---

## 4. 验证安装（AI 必须执行）

### 4.1 插件列表确认

```bash
/plugin list
```

确认输出包含 `harness` 插件。若未出现，参考下方「故障排除」第 1、2 条。

### 4.2 插件可执行性冒烟测试

在任意项目目录下执行（不依赖业务代码，仅验证工作流脚本可用）：

```bash
/harness evolve --check-only
```

预期输出：`体检(audit)` + `度量(metrics)` 结果（settings 缺失属正常，不再作为 WARNING 输出）。

> 若工具不支持 `/harness` 子命令参数，可改为直接验证脚本：
> ```bash
> node <插件安装路径>/plugins/harness/scripts/audit/harness-audit.js --json
> ```
> 预期：返回 JSON，`totalIssues` 为 0 或仅含可忽略项，且**不报 ajv 相关错误**。

### 4.3 门控链路自检（可选，验证 schema 校验可用）

```bash
node <插件安装路径>/plugins/harness/scripts/services/schema-validator.js --help 2>/dev/null || true
```

更实用的验证方式是直接 require 模块确认加载无误：

```bash
node -e "const sv = require('<插件安装路径>/plugins/harness/scripts/services/schema-validator'); console.log('schema-validator OK, schemas:', Object.keys(sv.SCHEMA_MAP).length)"
```

预期输出：`schema-validator OK, schemas: 8`。

---

## 5. 安装后可用能力

| 类型 | 内容 |
| --- | --- |
| **命令** | `/harness run`（全流程）、`/harness fixbugs`（修 Bug）、`/harness evolve`（自进化）、`/harness archive`（归档） |
| **代理** | 需求分析师、任务规划师、前端开发工程师、代码审查师、测试工程师、发布助手 |
| **技能** | harness-conductor、kb-query/kb-update/kb-init、gen-project-docs、api-generator、figma、tapd-bug-analyzer、harness-evolve 等 |
| **规则** | kb-auto-query（知识库自动检索） |
| **钩子** | 工作流阶段钩子（enforce-dev-pass、enforce-artifact、enforce-state-file、trace-command 等） |

### 外部服务依赖

仅在使用对应能力时需要，不影响插件本体安装：

| 能力 | 依赖 |
|------|------|
| Bug 分析 / 缺陷修复 | TAPD MCP 服务 |
| 设计稿协作 | Figma MCP 服务 |
| 部署发布 | DevOps MCP 服务 |

---

## 6. 常用配置

插件安装后可在 `/plugin` 界面修改配置：

| 配置项 | 类型 | 说明 | 默认值 |
| --- | --- | --- | --- |
| `workspaceRoot` | string | 默认工作区根目录 | `D:/workfile` |

---

## 7. 故障排除（AI 排查路径）

| # | 症状 | 排查步骤 |
|---|------|---------|
| 1 | 市场添加后无法加载 | ① `git ls-remote <market-url>` 确认仓库可达；② 确认仓库根目录存在 `.codebuddy-plugin/marketplace.json`；③ 检查仓库是否有读写权限（`strict: true` 时安装需写入缓存目录） |
| 2 | 安装时提示「路径未找到」 | 优先使用 **Git 型市场**（即 `https://...git` 地址），不要使用 URL 型市场 |
| 3 | 命令 / 技能不显示 | ① `/reload-plugins` 重载；② 删除缓存 `rm -rf ~/.codebuddy/plugins/cache` 后重启并重新安装 |
| 4 | 报 `Cannot find module 'ajv'` | 确认 `plugins/harness/vendor/ajv.bundle.js` 存在；不存在则说明仓库未同步最新代码，`git pull` 后重试（**不要** `npm install`） |
| 5 | 报 `MODULE_NOT_FOUND: .../vendor/ajv.bundle.js` | 检查安装路径是否正确——缓存目录结构为 `~/.codebuddy/plugins/cache/harness-marketplace/harness/<version>/`，脚本中相对路径 `../../vendor/` 基于 `scripts/services/` 解析 |
| 6 | 需要调试日志 | 启动工具时加 `--debug` 参数 |

---

## 8. 卸载

```bash
# 卸载插件
/plugin uninstall harness@harness-marketplace

# 移除市场（⚠️ 会同时卸载该市场下所有插件）
/plugin marketplace remove harness-marketplace
```

---

## 9. 仓库结构（维护者参考）

```
harness-marketplace/
├── .codebuddy-plugin/marketplace.json   # CodeBuddy Code 市场清单
├── .claude-plugin/marketplace.json      # Claude Code 市场清单（内容一致）
├── plugins/
│   └── harness/
│       ├── plugin.json                  # 插件元信息（commands/agents/skills/hooks 入口）
│       ├── agents/                     # 6 个工程角色代理
│       ├── commands/                   # run / fixbugs / evolve / archive
│       ├── skills/                     # 编排 / 知识库 / 文档 / 接口 / Figma 技能
│       ├── hooks/                      # 阶段钩子（hooks.json 声明）
│       ├── rules/                      # 知识库自动检索规则
│       ├── scripts/                    # audit / services / schemas / commands
│       ├── vendor/ajv.bundle.js        # 内置 ajv 单文件（免 npm install）
│       └── output-styles/
```
