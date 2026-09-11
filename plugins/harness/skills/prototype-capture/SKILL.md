---
name: prototype-capture
description: >
  原型抓取器 —— 用 playwright-cli 抓取在线原型链接（墨刀 / Axure / Figma 原型 / 任意 URL），
  探测页面渲染类型后分流遍历，逐页截图 + 提取页面拓扑 / 内容 / 跳转 / 状态变体，
  产出可供任务规划师拆 Task 的页面清单。
  只采集事实，不猜字段、不伪造交互流程。
  触发：需求分析师在 Harness Phase 0 检测到原型链接时加载；用户提供原型分享链接。
  不执行代码修改，只产出抓取结果与页面清单素材。
---

# Prototype Capture

## Overview

用 `playwright-cli`（微软官方命令行浏览器自动化工具）抓取在线原型，把「页面拓扑 → 页面内容 →
交互跳转 → 状态变体」四层信息抽出来，写成 `prototype-analysis.md` 的素材。

> 本 skill **只采集事实**。产出是 `prototype-analysis.md` 的输入材料，不产出 AC、不改代码。

## 执行总览（按顺序走，不要跳步）

```
open 原型链接
  ↓
Step 0  前置拦截页？ —— 反诈/免责/年龄确认 → 点掉按钮再继续   ← 最容易漏
  ↓
Step 1  探测渲染类型（iframe / canvas / text / imgs）
  ↓
Step 2  分流：有 iframe → C 类；canvas 主导 → B 类；其余 → A 类
  ↓
Step 2.1  C 类再判子类：C1 可跳转 / C2 about:blank / C3 跨域
  ↓
Step 3  按类型遍历（C 类优先找宿主平台页面树，比通用遍历准）
  ↓
四层信息 → 产出映射 → 写 prototype-analysis.md
  ↓
收尾 close + kill-all + --json list 复查
```

## 🚨 边界

| 做 | 不做 |
|---|---|
| 探测原型渲染类型并分流遍历 | 判断需求是否合理 |
| 截图归档 + 提取 DOM 文本 / 结构 | 猜字段名、猜校验规则 |
| 记录点击前后的 URL / DOM 变化 | 设计实现方案、拆任务 |
| 如实标注抓不到的局限 | 为「看起来对」而补全信息 |

**抓不到就说抓不到。** Canvas 渲染类原型的字段只能靠截图识别，必须标注来源与遗漏风险，
并在 `open-questions.json` 留待确认项 —— 禁止为了让文档看起来完整而编造字段。

## 铁律（违反必踩坑）

1. **CWD 固定**：session / profile / config 全按**启动时 CWD** 解析，换目录报
   `Browser is not open`。**每条命令都带 `cd <固定目录> &&` 前缀。**
2. **`eval` 必须用箭头函数**：`--raw eval "() => ..."`。写成 `eval "var x = ..."` 报 SyntaxError。
3. **收尾双保险**：`close` 后**必须**再跑 `kill-all`，并用 `--json list` 复查为空。
   daemon 是 detached 常驻进程，漏杀会累积（实测有主机残留 19 个 daemon、占 14.8GB）。
4. **`snapshot` 落文件不落 stdout**：不带 `--filename` 落 `.playwright-cli/`，
   带 `--filename=x.yml` 落 **CWD 根** —— **两种路径不同**。都必须 `cat` 出来看。
5. **取值一律用 `--raw`**：不加会混入 `### Ran Playwright code` 代码块。
6. **快照按需读、读完即弃**：yml 是工作文件，不复制进 Story 产物目录。
7. **本 skill 的命令已在 v0.1.17 / v0.1.19 逐条实跑验证**：改任何命令后**必须重新实跑再定稿**
   —— 定稿前的实跑揪出过 2 处错误，仅读 `--help` 发现不了。

> 完整坑清单与排查路径见 [references/pitfalls.md](references/pitfalls.md)。

## 前置检查与工作目录

```bash
playwright-cli --version          # 期望 ≥ 0.1.17
playwright-cli --json list        # 期望 {"browsers": []}，非空先 kill-all
```

工作目录固定 `<storyDir>/prototype-work/`，截图与快照都落这里，抓完归档。

> 新机器首次使用 / 报错排查时，先跑一轮公共页面自检序列确认 CLI 链路通畅
> （原型链接失效即无法重试，别拿真实原型试错）——
> 命令见 [references/cli-commands.md §0.2](references/cli-commands.md)。

## Step 0 — 前置拦截页（每次 `open` 后第一件事）

**很多托管平台在原型前插一层拦截页**（反诈提醒 / 免责声明 / 年龄确认 / 密码），
不点掉就只抓到声明文字。**判据：`text` 有内容但全是声明条款、找不到原型画面；
URL 含 `/jump?go=`、`/verify`、`/notice` 之类路径段。**

处理：`snapshot` 找按钮（文案通常是「知道了」「进入查看」「我同意」「继续」）→ `click` →
延时 → 确认 URL 已跳离。**可能有多层，循环到 URL 稳定。**

> 实测样本与完整命令见 [references/pitfalls.md §11](references/pitfalls.md)。

## Step 1 — 打开并探测

```bash
cd "$W" && playwright-cli open "<原型URL>"        # 先做 Step 0，再探测
cd "$W" && playwright-cli --raw eval "() => JSON.stringify({iframe: document.querySelectorAll('iframe').length, canvas: document.querySelectorAll('canvas').length, text: document.body.innerText.length, imgs: document.querySelectorAll('img').length})"
```

> **SPA 先延时再探测**（异步未渲染会误判成 B 类）：
> `cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"`

## Step 2 — 按结果分流

| 探测结果 | 判定 | 下一步 |
|---|---|---|
| 有 iframe | **C 类** | 走 Step 2.1 判 C1 / C2 / C3 |
| `canvas > 0` 且 `text` 极低 | **B 类** | 走「B 类截图遍历」 |
| 其余（DOM 有可读语义文本） | **A 类** | 走「A 类 DOM 遍历」 |

⚠️ **`text` 的绝对值不可靠，不要套数字判阈值** —— 实测 `example.com` 只有 129 字符却是
标准 A 类（DOM 完整），产品大牛原型壳只有 22 字符但 iframe 内有大量真内容。
**`text` 只看「是否接近空壳」，优先级是 `iframe` > `canvas` > `text`。**

> 拿不准时 `playwright-cli --raw find "<页面上肯定存在的词>"` —— 命中说明有可读文本。
> **`find` 会穿透同源与跨域 iframe。**
> 实测样本表见 [references/cli-commands.md §2.1](references/cli-commands.md)。

## Step 2.1 — C 类分流（**关键**）

**同样是 iframe，处理方式完全不同 —— 必须再判一次。**

```bash
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>({id:e.id, src:e.src})))"
cd "$W" && playwright-cli --raw eval "() => { const f=document.querySelectorAll('iframe')[0]; try { return JSON.stringify({sameOrigin: !!f.contentDocument}) } catch(e) { return 'BLOCKED' } }"
```

| 子类 | `src` 特征 | 同源？ | 处理 |
|---|---|---|---|
| **C1 可跳转** | 真实 URL | 无关 | 取 `src` → `goto` → 回到 Step 1 重新探测 |
| **C2 动态写入** | `about:blank` / `javascript:` | 是 | **`goto` 无处可去** → 读 `contentDocument` |
| **C3 跨域不可读** | 真实 URL + **跨域** | 否 | `contentDocument` 为 `null` → 用 `snapshot`/`find` 穿透 |

> **首选手段是 `snapshot` + `find`，不是 `goto`** —— 二者**自动穿透 iframe，跨域也能穿透**，
> 把内部节点以嵌套缩进 + `f1e*`/`f4e*` 多级 ref 前缀列出，且**可 `click <f前缀 ref>`**（已实测）。
> 只有需要成段取文本时才用 `contentDocument`（仅同源）。
> `goto` 的代价是**脱离宿主壳、拿不到左侧页面清单**。

> 完整命令、跨域实测结论、嵌套 iframe 处理、
> 见 [references/cli-commands.md §5](references/cli-commands.md) 与
> [references/pitfalls.md §12](references/pitfalls.md)。

## Step 3 — 按类型遍历

**A 类核心循环**：`snapshot` → 读 yml 拿 `ref` → `click` → 比对 URL / DOM 变化 →
`--raw eval` 取文本 → `screenshot` → `go-back`

**B 类核心循环**：`snapshot`（只用来找导航节点）→ `click` → `screenshot --filename=`
→ 若有可读文本则一并 `eval innerText`，否则纯截图

**C 类核心循环**：按 Step 2.1 定子类 → C1 `goto` 后转 A/B；C2/C3 用 `snapshot` + `find`

### C 类优先走宿主平台定向提取

**Axure 播放器壳**（产品大牛 / Axure Cloud / 墨刀导出站）有稳定 DOM 特征，
识别到就**直接用定向提取，比通用遍历准得多**：

| 特征 | 选择器 | 用途 |
|---|---|---|
| 页面树容器 | `#sitemapTreeContainer` | 一次取全部页面名 |
| 页面名节点 | `.sitemapPageName` | 逐页名 |
| 页面树面板 | 文本「Project Pages」的节点 | **默认折叠，必须先点开** |
| 当前页指示 | 壳文本 `(N of M)` | 校验总页数与序号 |

⚠️ **翻页只能 `click` 快照里页面名的 ref** —— 实测 `?p=<页面名>` URL
会重新触发 `/jump` 拦截流程、参数被丢弃回到第 1 页。
另：`a.sitemapPageLink` 的 `href` 恒为 `null`（Axure 用 JS 跳转）。

> 完整命令序列与实测样本见 [references/cli-commands.md §5.4](references/cli-commands.md)，
> 坑说明见 [references/pitfalls.md §13](references/pitfalls.md)。
> 其他托管平台结构不同但套路一致：**先找页面树容器，再找页面名节点**。
> 认不出特征就退回通用遍历，**不要硬套 Axure 选择器**。

## 四层信息 → 产出映射

**本 skill 的核心：抓到的东西分别写进 `prototype-analysis.md` 的哪一节。**

| 层 | 载体 | CLI 取法 | 写入章节 |
|---|---|---|---|
| 页面拓扑 | 左侧页面/菜单清单 | 宿主平台：`#sitemapTreeContainer .sitemapPageName`；A 类：快照 link/list 节点；B 类：截图识别 | 页面清单 |
| 页面内容 | DOM 文本 / 截图 | C 类：`snapshot`+`find` 或 `contentDocument`；A 类 `eval innerText`；B 类 `screenshot` | 字段与校验规则 |
| 页面跳转 | 点击热区 → URL / DOM 变化 | `click` → `eval "() => location.href"` 前后对比 | 交互流程 |
| 状态变体 | hover / 弹窗 / tab | `hover` / `click` 后 `snapshot` / `press Escape` | 状态变体 |

### B 类（Canvas 渲染）的强制标注

Canvas 类原型 CLI **拿不到 DOM 语义** —— 字段信息只能来自截图识别。此时必须：

1. 在「原型抓取方法」一节写明「本原型为 Canvas 渲染，DOM 无可读语义，
   字段信息来自截图识别，**存在遗漏风险**」；
2. 在 `open-questions.json` 追加一条**非 blocking** 待确认项，列出存疑字段；
3. **禁止凭截图猜测字段名** —— 只写能明确看清的。

## 输出组织

| 产物 | 落盘位置 | 命名 |
|---|---|---|
| 截图 | `<workDir>/*.png`（`--filename` 落 CWD 根） | `<序号>-<页面名拼音>.png` |
| 快照 yml | `<workDir>/` 或 `.playwright-cli/` 临时，**不归档** | 见铁律 4 |
| 页面清单 | 写进 `prototype-analysis.md` 的表格 | — |

- **中文页面名不进文件名**（Windows shell 转义易错）→ 用「序号-拼音」，
  中文名登记在 `prototype-analysis.md` 的页面清单表格里。
- 序号按遍历顺序递增，与页面清单表格一一对应。
- `<workDir>`（含 `.playwright-cli/`）抓完即可删。

## 抓不到时的降级

| 情况 | 处理 |
|---|---|
| 页面要求登录 | `open-questions.json` 记 **blocking** 项，向用户要截图，**不要瞎猜内容** |
| 拦截页按钮点了没反应 | 可能有多层 → 重新 `snapshot` 找下一层；或 `console` 看报错 |
| 点击无反应（交互没做/异步慢） | `console` + `network` 查报错；必要时 `tracing-start/stop` |
| `contentDocument` 返回 `null` | **跨域（C3）** → 改用 `snapshot`/`find`，或 `goto` iframe `src` |
| 页面清单找不到 / 只有 1 页 | **Axure 面板默认折叠** → 先点开「Project Pages」 |
| 原型链接失效 / 403 | 如实记录，向用户确认链接有效性 |

## 按需加载

| 场景 | 读哪个 reference |
|---|---|
| 具体 CLI 命令 / 三类完整遍历序列 / 宿主平台定向提取 / 输出组织 | [references/cli-commands.md](references/cli-commands.md) |
| 命令报错、会话残留、拦截页/iframe 异常、疑似踩坑 | [references/pitfalls.md](references/pitfalls.md) |

> `playwright-cli` 处 `0.1.x` 预览期，命令可能变 —— 以 `playwright-cli --help`
> 与 `playwright-cli <command> --help` 实际输出为准。
