---
name: prototype-capture
description: >
  原型抓取器 —— 用 capture.js（playwright-cli 驱动）抓取在线原型链接
  （墨刀 / Axure / Figma 原型 / 任意 URL），自动完成环境自检、拦截页处理、
  渲染类型探测分流、宿主平台逐页遍历、说明文字采集、逐页截图与收尾清理，
  产出原型抓取材料（prototype-capture.md，含逐页内嵌截图）供需求分析师理解。
  只采集事实，不猜字段、不伪造交互流程。
  触发：需求分析师在 Harness Phase 0 检测到原型链接时加载；用户提供原型分享链接。
  不产出 AC、不写 prototype-analysis.md、不改代码。
---

# Prototype Capture

## Overview

**跑脚本采集，而不是读文档拼命令。**

`scripts/capture.js` 承担确定性 + 可循环的全部动作；大模型只在
**脚本明确交回判断权**时介入，共两处：

| 介入点 | 脚本信号 | 你要做什么 |
|---|---|---|
| 认不出宿主平台 | `status: need_llm` + `needLlm[]` | 读 `probe` 字段判断结构，或用 `page` 子命令指定选择器补抓 |
| 抓不到说明文字 | `status: partial` + 页内 `degradations` | 按 `advice` 决定是否需要人工确认；材料仍可产出 |

其余情况**直接读脚本输出的 JSON 并按 `nextAction` 走**，不要自己拼 playwright-cli 命令。

## 产出要求

本 skill **必须输出**两个产物（缺一即本次抓取未完成）：

| 产物 | 位置 | 说明 |
|---|---|---|
| `prototype-capture.md` | `<storyDir>/` | 抓取材料，固定文件名。由 `capture.js render` 生成 |
| `prototype-work/` | `<storyDir>/` | 截图 + 快照 yml + `capture-result.json`，**保留不删**（原始证据） |

材料章节清单的唯一信源是脚本的 `MATERIAL_SECTIONS` 常量 ——
`capture.js --help` 会打印它，**不要在本文件里找章节列表**。

## 执行总览

```
① node capture.js run --url <原型链接> --work-dir <storyDir>/prototype-work [--title <需求标题>]
   ↓ 读 stdout JSON（默认只打摘要；逐页全文读 <storyDir>/prototype-work/capture-result.json）
② status 为 ok / partial？ → 直接进第 ④ 步
   status 为 need_llm？    → 读 needLlm[]，必要时用 probe / page 子命令补，再重跑
   status 为 failed？      → 读 errorLayer 与 error 判断原因（见下方降级处理）
   ↓
③ 如补抓了页面：node capture.js page --work-dir <dir> --target <ref|css> --name <中文名>
   完了重跑 render 重出材料（不必重开浏览器）
   ↓
④ node capture.js render --result <dir>/capture-result.json --out <storyDir>/prototype-capture.md
   ↓
⑤ 交付：材料 + 截图给需求分析师（他理解后自己写 prototype-analysis.md）
```

## 运行方式

脚本在**本 skill 的 `scripts/capture.js`**，用 `node` 绝对路径调用：

```bash
node "<skill 根>/scripts/capture.js" <子命令> [选项]
```

| 子命令 | 用途 |
|---|---|
| `run` | 主流程：打开 → 拦截页 → 探测 → 分流 → 逐页采集 → 落 result → 自动收尾 |
| `probe` | 只探测当前页渲染类型与 iframe 详情（不翻页不截图） |
| `page` | 补抓单页（认不出平台特征后，或某页采集失败后） |
| `finish` | 幂等收尾（异常中断后可手动补跑） |
| `render` | 读 result JSON 渲染材料 markdown（纯函数，不启浏览器） |

> `capture.js --help` 会打印完整用法、状态枚举与材料章节清单 ——
> **遇到不确定时先跑 `--help`**，它的内容直接从脚本常量渲染，永远与实现同步。

## 铁律

1. **不下载原型图片资源**：`<img src>` / 背景图 / icon / SVG 一律不下载，
   整页截图是唯一视觉证据，`img` 仅用于渲染类型计数。禁止 `curl` / `wget` / `fetch` 原型图片 URL。
2. **只记采到的事实**：说明里写明的规则**原样摘录**，没写的**禁止**推断补全。
   抓不到就说抓不到，在材料里如实标注。
3. **不替需求分析师下结论**：材料只呈现「看到了什么」；
   功能点归并、AC 推导、风险判断是需求分析师的活。
4. **脚本报错先查 troubleshooting**：不要自己手拼 playwright-cli 命令绕过脚本 ——
   命令的 CWD 绑定、中文参数转义、收尾清理都有坑，脚本已处理，手拼会踩。

## 脚本契约（读什么字段）

`run` / `page` 的 stdout 是统一信封 JSON，**stdout 只有 JSON，日志走 stderr**：

> `run` **默认只打摘要**（`status` + `summary` + 逐页 `index/name/status/screenshot/notes 条数`），
> 逐页全文仍在 `<work-dir>/capture-result.json`。显式加 `--full` 才把全量 JSON 打到 stdout。
> 所以：看整体状态读 stdout，读某页说明时直接读 result 文件，别让全量 notes 灌满上下文。

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 契约版本（渲染材料时校验） |
| `ok` | 本次命令是否正常执行完（`partial` / `need_llm` 也算 true） |
| `status` | 整体状态：`ok` / `partial` / `need_llm` / `failed` / `skipped` |
| `pages[]` | 逐页记录（含 `status` / `degradations` / `notes` / `fields` / `screenshot`） |
| `needLlm[]` | **需要你介入的页面清单**（含 `reason` / `probe` / `nextAction`） |
| `nextAction` | 当前状态下建议的下一步（文案来自脚本常量） |
| `errorLayer` | 失败层次：`spawn`（进程起不来）/ `cli`（命令层）/ `business`（业务层） |
| `errors[]` | 错误文本 |

**退出码**：`0` = 可继续（含 `partial` / `need_llm`）；`1` = 有失败页；`2` = 前置条件不满足。
`need_llm` **不是失败**，不要因为退出码非 0 就中止流程。

## 降级处理

抓不到是常态，按下面的原则如实记录（具体文案由脚本 `degradations[].inlineNote` 给出，
不要自己另写措辞）：

| 情况 | 处理 |
|---|---|
| 页面要求登录 | 脚本标 `skipped`；`open-questions.json` 记 **blocking** 项，向用户要截图，不瞎猜 |
| 说明文字找不到 | 脚本标 `partial` + `notes_missing`；材料如实写「未找到说明文字」 |
| 字段来自截图（Canvas 类） | 脚本标 `partial` + `field_from_screenshot`；**禁止**凭截图猜字段名 |
| 链接失效 / 403 | 脚本标 `failed` 并记入 `errors`；如实记录，向用户确认链接有效性 |
| 认不出宿主平台 | 脚本标 `need_llm`；按 `nextAction` 处理，或向用户索要截图 |

> 降级项会**两处呈现**：受影响页面的内联标记 + 材料末尾「局限与待确认」汇总。
> 存疑项请提醒需求分析师转 `open-questions.json` 的**非 blocking** 待确认项。

## 未安装 playwright-cli 时

脚本 `preflight` 会检测并在 JSON 里返回 `installHint` 与退出码 2。此时向用户输出：

> ⚠️ 未检测到 `playwright-cli`，原型抓取无法继续。请安装（需 Node.js ≥ 20）：
> ```bash
> npm install -g @playwright/cli@latest
> playwright-cli install-browser   # 首次运行也会自动下载浏览器，可省略
> ```
> 不想全局安装可用 `npx playwright cli <command>` 等价替代。
> 安装来源以 https://playwright.dev/agent-cli/installation 为准。

## 按需加载

| 场景 | 读哪个 reference |
|---|---|
| 脚本报错、采集异常、收尾残留、怀疑踩坑 | [references/troubleshooting.md](references/troubleshooting.md) |

> `playwright-cli` 处 `0.1.x` 预览期，命令签名可能变。
> 命令全部封装在 `scripts/` 内，**改脚本前先读 `scripts/runner.js` 的头部注释**
> （记录了 CWD 绑定、中文参数、update check 等实测结论）。
