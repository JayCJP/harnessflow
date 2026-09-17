---
name: prototype-capture
description: >
  原型抓取器 —— 用 playwright-cli 抓取在线原型链接（墨刀 / Axure / Figma 原型 / 任意 URL），
  探测页面渲染类型后分流遍历，逐页采集页面拓扑 / 页面内容 / 原型说明文字 / 交互跳转 / 状态变体，
  并逐页截图，产出供需求分析师理解与撰写的抓取材料（文本 + 截图）。
  只采集事实，不猜字段、不伪造交互流程。
  触发：需求分析师在 Harness Phase 0 检测到原型链接时加载；用户提供原型分享链接。
  不产出 AC、不写 prototype-analysis.md、不改代码。
---

# Prototype Capture

## Overview

用 `playwright-cli`（微软官方命令行浏览器自动化工具）抓取在线原型，按渲染类型分流遍历，
逐页采集「页面拓扑 → 页面内容 → **原型说明文字** → 交互跳转 → 状态变体」五层信息 + 整页截图，
产出**抓取材料（文本 + 截图）**供需求分析师理解后撰写 `prototype-analysis.md`。

> 只采集事实，不猜字段、不伪造交互、不写 AC、不改代码、**不下载图片**。材料只「归拢」不「分析」。

## 产出要求

本 skill **必须输出** `<storyDir>/prototype-capture.md`（抓取材料，固定文件名）——
这是本 skill 的**唯一文本产物，不输出即视为本次抓取未完成**。内容骨架见 Step 5「必备章节」。
截图与快照落 `<storyDir>/prototype-work/` 保留不删，作为材料的原始证据。

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
Step 4  逐页采集：原型说明文字 + 截图（每页必截）
  ↓
Step 5  五层信息 → 产出映射 → 落素材 prototype-capture.md（交需求分析师理解）
  ↓
收尾 close + kill-all + --json list 复查
```

## 边界

| 做 | 不做 |
|---|---|
| 探测渲染类型并分流遍历 | 判断需求是否合理 |
| 逐页截图归档 + 提取 DOM 文本 / 结构 | 猜字段名、猜校验规则 |
| 采集原型说明 / 批注 / 标注文字 | 设计实现方案、拆任务 |
| 记录点击前后的 URL / DOM 变化 | 写 `acceptance-criteria.json` / `featurePoints` |
| **输出 `prototype-capture.md`** + 截图归档 | 写 `prototype-analysis.md`（由需求分析师撰写） |
| 整页截图（`--full-page`）作唯一视觉证据 | **下载原型图片资源**（`<img src>`/背景图/icon） |

**抓不到就说抓不到。** Canvas 类字段只能靠截图识别，必须标注来源与遗漏风险，禁止编造字段。

## 铁律（违反必踩坑）

1. **CWD 固定**：session / profile / config 全按启动时 CWD 解析，换目录报 `Browser is not open`。**每条命令带 `cd <固定目录> &&` 前缀。**
2. **`eval` 用箭头函数 + 取值带 `--raw`**：`--raw eval "() => ..."`。写成 `eval "var x = ..."` 报 SyntaxError；不带 `--raw` 会混入 `### Ran Playwright code` 代码块。
3. **收尾三件套**：`close` → `kill-all` → `--json list` 复查为空；再 `rm -rf "$W/.playwright-cli"` 只清缓存。daemon 是 detached 常驻进程，漏杀会累积（实测残留 19 个占 14.8GB）。
4. **`snapshot`/`screenshot` 显式给 `--filename`**：落 **CWD 根**；不带则落 `.playwright-cli/`（收尾被删）且路径不同。都必须 `cat`/查看。
5. **快照保留、按需读**：yml 是原始证据，留在 `prototype-work/` 不删；读时按需取片段（`cat ... | head`），不要整份读进上下文。
6. **说明文字优先 `find --regex` + 通用探针**：`find` 穿透 iframe，是发现说明最可靠的手段；隐藏面板（`display:none`）用 **`textContent`** 取（`innerText` 返回空）。判定「有没有说明」靠命令不靠猜。
7. **不下载原型图片资源**：`<img src>`/背景图/icon/SVG 一律不下载到本地，整页截图是唯一视觉证据，`img` 仅用于渲染类型计数。禁止 `curl`/`wget`/`fetch` 原型图片 URL。
8. **命令改后必须实跑再定稿**：本 skill 命令已在 v0.1.17 / v0.1.19 逐条实跑验证，仅读 `--help` 发现不了错误。

> 完整坑清单见 [references/pitfalls.md](references/pitfalls.md)。

## 前置检查与工作目录

### ① 判断 playwright-cli 是否已安装（**未装则终止，不要硬跑**）

```bash
playwright-cli --version          # 有版本号(≥0.1.17)=已装；报 "command not found"/"无法将...识别为命令"=未装
```

**未安装时**：向用户输出下述提示并**终止本次抓取**（不执行 Step 0 及之后）：

> ⚠️ 未检测到 `playwright-cli`，原型抓取无法继续。请安装（需 Node.js ≥ 20）：
> ```bash
> npm install -g @playwright/cli@latest
> playwright-cli install-browser   # 首次运行也会自动下载浏览器，可省略
> ```
> 不想全局安装可用 `npx playwright cli <command>` 等价替代。安装来源以 https://playwright.dev/agent-cli/installation 为准。

### ② 已安装 → 查版本与会话残留

```bash
playwright-cli --version          # 期望 ≥ 0.1.17
playwright-cli --json list        # 期望 {"browsers": []}，非空先 kill-all
```

**工作目录** `W="<storyDir>/prototype-work"`（截图/快照/说明文字全落这里，**抓完整体保留**，只清 `.playwright-cli/`）。
**默认视口** `1920×1080`（PC，`open` 后先 `resize 1920 1080`）；H5/小程序用 `375×812`。截整页时高度按 Step 4.2 上调。

> 新机器/报错排查时，先跑公共页面自检确认 CLI 链路通畅（原型链接失效无法重试，别拿真实原型试错）——见 [cli-commands.md §0.2](references/cli-commands.md)。

## Step 0 — 前置拦截页（每次 `open` 后第一件事）

很多托管平台在原型前插拦截页（反诈/免责/年龄确认/密码），不点掉只抓到声明文字。
**判据**：`text` 有内容但全是声明条款、URL 含 `/jump?go=`、`/verify`、`/notice`。

处理：`snapshot` 找按钮（「知道了」「进入查看」「我同意」「继续」）→ `click` → 延时 → 确认 URL 跳离。**可能多层，循环到 URL 稳定。**

> 实测样本见 [pitfalls.md §11](references/pitfalls.md)。

## Step 1 — 打开并探测

```bash
cd "$W" && playwright-cli open "<原型URL>"        # 先做 Step 0，再探测
cd "$W" && playwright-cli --raw eval "() => JSON.stringify({iframe: document.querySelectorAll('iframe').length, canvas: document.querySelectorAll('canvas').length, text: document.body.innerText.length, imgs: document.querySelectorAll('img').length})"
```

> SPA 先延时再探测（异步未渲染会误判 B 类）：`playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"`

## Step 2 — 按结果分流

| 探测结果 | 判定 | 下一步 |
|---|---|---|
| 有 iframe | **C 类** | 走 Step 2.1 判 C1/C2/C3 |
| `canvas > 0` 且 `text` 极低 | **B 类** | 走「B 类截图遍历」 |
| 其余（DOM 有可读语义文本） | **A 类** | 走「A 类 DOM 遍历」 |

⚠️ `text` 绝对值不可靠，不要套数字阈值。优先级 `iframe` > `canvas` > `text`，`text` 只看「是否接近空壳」。
拿不准时 `playwright-cli --raw find "<肯定存在的词>"`，命中即有可读文本（`find` 穿透同源与跨域 iframe）。

## Step 2.1 — C 类分流（**关键**）

同样是 iframe，处理方式完全不同，必须再判一次：

```bash
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>({id:e.id, src:e.src})))"
cd "$W" && playwright-cli --raw eval "() => { const f=document.querySelectorAll('iframe')[0]; try { return JSON.stringify({sameOrigin: !!f.contentDocument}) } catch(e) { return 'BLOCKED' } }"
```

| 子类 | `src` 特征 | 同源？ | 处理 |
|---|---|---|---|
| **C1 可跳转** | 真实 URL | 无关 | 取 `src` → `goto` → 回 Step 1 重新探测 |
| **C2 动态写入** | `about:blank`/`javascript:` | 是 | `goto` 无处可去 → 读 `contentDocument` |
| **C3 跨域不可读** | 真实 URL+跨域 | 否 | `contentDocument` 为 `null` → 用 `snapshot`/`find` 穿透 |

> **首选 `snapshot` + `find`，不是 `goto`** —— 二者自动穿透 iframe（跨域也穿透），内部节点以嵌套缩进 + `f1e*`/`f4e*` 多级 ref 前缀列出，可 `click <f前缀 ref>`。`goto` 会脱离宿主壳、拿不到左侧页面清单。完整命令见 [cli-commands.md §5](references/cli-commands.md) 与 [pitfalls.md §12](references/pitfalls.md)。

## Step 3 — 按类型遍历

- **A 类**：`snapshot` → 读 yml 拿 `ref` → `click` → 比对 URL/DOM → `--raw eval` 取文本 → `screenshot` → `go-back`
- **B 类**：`snapshot`（只找导航节点）→ `click` → `screenshot --filename=` → 有可读文本则 `eval innerText`，否则纯截图
- **C 类**：按 Step 2.1 定子类 → C1 `goto` 后转 A/B；C2/C3 用 `snapshot` + `find`

### C 类优先走宿主平台定向提取

Axure 播放器壳（产品大牛/Axure Cloud/墨刀导出站）有稳定 DOM 特征，识别到直接定向提取，比通用遍历准：

| 特征 | 选择器 | 用途 |
|---|---|---|
| 页面树容器 | `#sitemapTreeContainer` | 一次取全部页面名 |
| 页面名节点 | `.sitemapPageName` | 逐页名 |
| 页面树面板 | 文本「Project Pages」节点 | **默认折叠，必须先点开** |
| 当前页指示 | 壳文本 `(N of M)` | 校验总页数与序号 |

⚠️ 翻页只能 `click` 快照里页面名的 ref —— `?p=<页面名>` URL 会重新触发 `/jump` 拦截。其他平台套路一致：先找页面树容器，再找页面名节点；认不出就退回通用遍历。完整序列见 [cli-commands.md §5.4](references/cli-commands.md)。

## Step 4 — 逐页采集说明文字与截图（缺一不可）

### 4.1 原型说明文字（**本 skill 重点采集项**）

「原型说明」= 产品经理在原型里写的需求说明/交互说明/校验规则，三种载体：

| 载体 | 典型位置 | 取法 |
|---|---|---|
| 宿主平台说明面板 | 工具栏「说明/备注/批注/Notes/标注」或右侧说明栏 | 关键词 `find` 探测 → 通用探针提取 |
| 画布批注 | 画布上的说明便签/注释框 | `find` 或通用探针 |
| 画布文本 | 原型里直接画的说明文字 | `innerText` / `find` |

```bash
W="<storyDir>/prototype-work"

# ① 探测：find 穿透 iframe，一次命中说明面板/批注/画布说明
cd "$W" && playwright-cli --raw find --regex "说明|备注|批注|标注|注释|交互说明|规则|Notes?"

# ② 通用探针提取（textContent 能取隐藏面板，完整命令见 cli-commands.md §8.2）
cd "$W" && playwright-cli --raw eval "<通用说明探针>"

# ③ 说明面板默认折叠：点开补一张截图佐证（文字不点开也能取到）
cd "$W" && playwright-cli click "#btnNotes"      # 或 snapshot 里的 ref
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 500))"
cd "$W" && playwright-cli screenshot --filename=03-order-list-notes.png --full-page
```

> 说明面板常 `display:none`：`innerText` 返回空，`textContent` 仍能取全文 —— 不点开也能拿文字，点开只为补截图。一轮没找到换关键词（需求/交互/校验/逻辑/备注）再找一轮。

### 4.2 截图（**每页必截，且必须截全**）

> ⚠️ **只截图，不下载原型图片。** `<img src>`/背景图/icon/SVG 一律不下载，整页截图是唯一视觉证据，`img` 仅用于渲染类型计数。禁止 `curl`/`wget`/`fetch` 原型图片 URL。

```bash
cd "$W" && playwright-cli screenshot --filename=<序号>-<拼音>.png --full-page    # 整页，不是首屏
```

| 场景 | 命令 |
|---|---|
| 页面正文（默认） | `screenshot --filename=<序号>-<拼音>.png --full-page` |
| 说明面板展开态 | `screenshot --filename=<序号>-<拼音>-notes.png --full-page` |
| 高清 | 追加 `--hires`（小字号/Canvas 类） |
| 状态变体 | hover/弹窗后另截一张（同样带 `--full-page`） |

⚠️ **播放器类原型（墨刀/Axure/产品大牛）：光加 `--full-page` 仍截不全** —— 这类是固定视高应用，画布按当前视口高度裁切。对策：先量内容高，再把视口高度调到内容高以上：

```bash
# ① 量画布真实内容高度
cd "$W" && playwright-cli --raw eval "() => { const n=document.querySelector('.rResCanvas')||document.querySelector('.zoom-area')||document.querySelector('.screen-container'); return JSON.stringify({contentH: Math.max(n?(n.scrollHeight||n.offsetHeight):0, document.documentElement.scrollHeight), vh: innerHeight}) }"

# ② 视口高度调到 ≥ 内容高 + 播放器页头(约100px)，宽度保持 1920，延时后整页截图
cd "$W" && playwright-cli resize 1920 <contentH+100>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 2000))"
cd "$W" && playwright-cli screenshot --filename=03-order-list.png --full-page
```

- 画布容器自身带滚动条时（`scrollHeight > clientHeight`），`resize` 不够 —— 需滚动容器分屏截图或就地截该元素后拼接。
- 截图前清掉遮挡：说明/批注面板常浮在画布上 → 先收起，或点开前后各截一张。
- **中文页面名不进文件名**（用「序号-拼音」，中文名登记在 `prototype-capture.md` 页面清单）。

## Step 5 — 落盘抓取材料（交需求分析师理解）

产物 = 文本 + 截图；需求分析师读这两样、理解后**自己撰写 `prototype-analysis.md`**。

| 产物 | 落盘位置 | 命名 |
|---|---|---|
| 抓取材料（文本） | `<storyDir>/prototype-capture.md` | 固定名 |
| 截图 + 快照 yml | `<storyDir>/prototype-work/`（**保留不删**） | `<序号>-<拼音>.png` / `<用途>.yml` |

### 必备章节（缺一即未完成）

| 章节 | 内容 | 来源 |
|---|---|---|
| 原型抓取方法 | 渲染类型(A/B/C 及子类)、是否 Canvas、说明文字来源、抓取局限 | 探测+采集结论 |
| 页面清单 | 序号/中文页面名/URL 或 iframe src/截图文件名/关键功能点/状态变体 | 页面拓扑 |
| 原型说明 | 逐条摘录说明/批注/标注文字，**标注出处页面与载体** | Step 4.1 |
| 交互流程 | 页面跳转、点击热区、弹窗、tab 等状态变化 | 点击前后比对 |
| 字段与校验规则 | 字段名/类型/必填/placeholder/校验规则 | DOM + 说明文字 |
| 局限与待确认 | 抓不到的部分（登录墙/Canvas/说明缺失） | 降级记录 |

### 记录纪律

1. **只记采到的事实**：说明里写明的规则**原样摘录**，没写的**禁止**推断补全。
2. **标注来源**：每条说明标注「哪个页面的说明面板/画布批注/画布文本」。
3. **Canvas 类强制标注**：字段来自截图识别 → 写明遗漏风险，存疑字段转 `open-questions.json` **非 blocking** 项，禁止凭截图猜字段名。
4. **说明缺失如实写「未找到说明」**，禁止用通用经验补规则。

> **不要替需求分析师下结论**：材料只呈现「看到了什么」；功能点归并、AC 推导、风险判断是需求分析师的活。

## 抓不到时的降级

| 情况 | 处理 |
|---|---|
| 页面要求登录 | `open-questions.json` 记 **blocking** 项，向用户要截图，不瞎猜 |
| 拦截页按钮没反应 | 可能多层 → 重新 `snapshot` 找下一层；或 `console` 看报错 |
| 点击无反应 | `console` + `network` 查报错；必要时 `tracing-start/stop` |
| `contentDocument` 返回 `null` | 跨域(C3) → 改用 `snapshot`/`find`，或 `goto` iframe `src` |
| 页面清单找不到/只有 1 页 | Axure 面板默认折叠 → 先点开「Project Pages」 |
| 找不到说明面板 | 换关键词(需求/交互/校验/逻辑/备注)再 `find`；仍无 → 写「未找到说明」 |
| 说明文字是 Canvas 绘制 | `find` 与探针均无效 → 只能截图识别，标注遗漏风险 |
| 原型链接失效/403 | 如实记录，向用户确认链接有效性 |

## 按需加载

| 场景 | 读哪个 reference |
|---|---|
| 具体 CLI 命令 / 三类遍历序列 / 宿主平台定向提取 / 说明文字探针 / 材料写法 | [references/cli-commands.md](references/cli-commands.md) |
| 命令报错、会话残留、拦截页/iframe 异常、截图异常、疑似踩坑 | [references/pitfalls.md](references/pitfalls.md) |

> `playwright-cli` 处 `0.1.x` 预览期，命令可能变 —— 以 `playwright-cli --help` 与 `<command> --help` 实际输出为准。
