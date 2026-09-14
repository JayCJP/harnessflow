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

用 `playwright-cli`（微软官方命令行浏览器自动化工具）抓取在线原型，把
「页面拓扑 → 页面内容 → **原型说明文字** → 交互跳转 → 状态变体」五层信息抽出来，
逐页截图归档，产出**抓取材料（文本 + 截图）**。

> 本 skill **只采集事实**：产出是需求分析师**读材料、理解后撰写 `prototype-analysis.md`** 的输入。
> 它不产出 AC、**不直接写 `prototype-analysis.md`**、不改代码。
> 材料只做「归拢」不做「分析」：把抓到的事实按页面 / 说明归类落盘即可，
> **不是**猜字段、不是推断原型里没写明的交互。

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

## 🚨 边界

| 做 | 不做 |
|---|---|
| 探测原型渲染类型并分流遍历 | 判断需求是否合理 |
| 逐页截图归档 + 提取 DOM 文本 / 结构 | 猜字段名、猜校验规则 |
| 采集原型说明 / 批注 / 标注文字 | 设计实现方案、拆任务 |
| 记录点击前后的 URL / DOM 变化 | 写 `acceptance-criteria.json` / `featurePoints` |
| 落盘抓取材料（文本 + 截图）供需求分析师理解 | 写 `prototype-analysis.md`（由需求分析师理解后撰写） |

**抓不到就说抓不到。** Canvas 渲染类原型的字段只能靠截图识别，必须标注来源与遗漏风险，
并在 `open-questions.json` 留待确认项 —— 禁止为了让文档看起来完整而编造字段。

## 铁律（违反必踩坑）

1. **CWD 固定**：session / profile / config 全按**启动时 CWD** 解析，换目录报
   `Browser is not open`。**每条命令都带 `cd <固定目录> &&` 前缀。**
2. **`eval` 必须用箭头函数**：`--raw eval "() => ..."`。写成 `eval "var x = ..."` 报 SyntaxError。
3. **收尾三件套**：`close` → `kill-all` → `--json list` 复查为空；再 `rm -rf "$W/.playwright-cli"`
   只清浏览器缓存。daemon 是 detached 常驻进程，漏杀会累积（实测有主机残留 19 个 daemon、占 14.8GB）。
4. **`snapshot` 落文件不落 stdout**：不带 `--filename` 落 `.playwright-cli/`，
   带 `--filename=x.yml` 落 **CWD 根** —— **两种路径不同**。都必须 `cat` 出来看。
5. **取值一律用 `--raw`**：不加会混入 `### Ran Playwright code` 代码块。
6. **快照保留、按需读**：yml 是原始证据（精确文本 / 结构 / ref），**留在 `prototype-work/` 不删**；
   读时按需取片段（`cat ... | head`），**不要整份读进上下文**。
7. **说明文字优先 `find --regex` + 通用探针**：`find` **会穿透 iframe**，是发现说明文字最可靠的手段；
   隐藏面板（`display:none`）的文字用 **`textContent`** 取（`innerText` 会返回空）。
   **判定「有没有说明」靠命令，不靠猜。**
8. **本 skill 的命令已在 v0.1.17 / v0.1.19 逐条实跑验证**：改任何命令后**必须重新实跑再定稿**
   —— 定稿前的实跑揪出过 2 处错误，仅读 `--help` 发现不了。

> 完整坑清单与排查路径见 [references/pitfalls.md](references/pitfalls.md)。

## 前置检查与工作目录

```bash
playwright-cli --version          # 期望 ≥ 0.1.17
playwright-cli --json list        # 期望 {"browsers": []}，非空先 kill-all
```

**默认视口 `1920×1080`**（PC）：`open` 后先 `playwright-cli resize 1920 1080` 统一基线，
再开始探测 / 遍历；H5 / 小程序改用 `375×812`。截整页时高度另按 Step 4.2 上调。

工作目录固定 `<storyDir>/prototype-work/`，**截图、快照、说明文字提取结果都落这里，抓完整体保留** ——
它就是本 Story 的**原型证据目录**（原型链接易失效，删了就无法自上而下复核）。
收尾只清 `.playwright-cli/` 缓存，**不删 `prototype-work/`**。

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

## Step 4 — 逐页采集说明文字与截图

**遍历每一页时都要做这两件事，缺一不可。**

### 4.1 原型说明文字（**本 skill 的重点采集项**）

「原型说明」= 产品经理在原型里写的**需求说明 / 交互说明 / 校验规则**，常见三种载体：

| 载体 | 典型位置 | 取法 |
|---|---|---|
| 宿主平台说明面板 | 工具栏「说明 / 备注 / 批注 / Notes / 标注」按钮，或右侧说明栏 | 关键词 `find` 探测 → 通用探针提取 |
| 画布批注 | 贴在画布上的说明便签 / 注释框 | 关键词 `find` 或通用探针 |
| 画布文本 | 原型里直接画上去的说明文字 | 同「页面内容」取法（`innerText` / `find`） |

**采集协议（先探测，再提取，最后按需展开截图）**：

```bash
W="<storyDir>/prototype-work"

# ① 探测：关键词 find 会穿透 iframe，一次命中说明面板标题 / 批注 / 画布说明
cd "$W" && playwright-cli --raw find --regex "说明|备注|批注|标注|注释|交互说明|规则|Notes?"

# ② 通用探针提取：按「属性提示 + 文本锚点」捞出候选说明块（textContent 能取到隐藏面板）
cd "$W" && playwright-cli --raw eval "<通用说明探针，完整命令见 cli-commands.md §8.2>"

# ③ 说明面板默认折叠时：点开再截一张（click 支持快照 ref，也支持 CSS 选择器）
cd "$W" && playwright-cli click "#btnNotes"      # 或 snapshot 里的 ref
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 500))"
cd "$W" && playwright-cli screenshot --filename=03-order-list-notes.png --full-page
```

> **实测结论（v0.1.19）**：
> - `find --regex` **会穿透 iframe**，iframe 内的说明文字照样命中 —— **发现说明最可靠的手段**。
> - 说明面板常默认 `display:none`：`innerText` 返回空，**`textContent` 仍能取到全文** →
>   通用探针用 `textContent`，**不点开也能拿到文字**；点开只是为了补一张截图佐证。
> - 一轮没找到 ≠ 没有说明 —— 换关键词（「需求」「交互」「校验」「逻辑」「备注」）再找一轮。

### 4.2 截图（**每页必截，且必须截全**）

**默认截「整页」，不是截首屏** —— 首屏截图会丢掉滚动区里的字段与状态。
**只截图，不下载原型里的图片资源**（截图本身就是证据，`img` 只用于渲染类型计数）。

```bash
cd "$W" && playwright-cli screenshot --filename=<序号>-<拼音>.png --full-page
```

| 场景 | 命令 | 说明 |
|---|---|---|
| 页面正文（默认） | `screenshot --filename=<序号>-<拼音>.png --full-page` | **整页**（含可滚动部分），逐页归档 |
| 说明面板展开态 | `screenshot --filename=<序号>-<拼音>-notes.png --full-page` | 说明文字的重要佐证 |
| 高清 | 追加 `--hires` | 小字号 / Canvas 类需要 |
| 状态变体 | hover / 弹窗后另截一张（同样带 `--full-page`） | 见 Step 3 |

⚠️ **播放器类原型（墨刀 / Axure / 产品大牛）：光加 `--full-page` 仍然截不全** ——
这类页面是**固定视高应用**：文档本身不滚动（`document.scrollHeight == 视口高`），
画布内容在内部容器里**按当前视口高度裁切**（不是缩放适配），`--full-page` 覆盖不到。

**对策：先量内容高，再把视口高度调到内容高以上**（实测有效）：

```bash
# ① 量出画布真实内容高度（播放器画布节点 / 缩放容器 / 文档，取大者）
cd "$W" && playwright-cli --raw eval "() => { const n=document.querySelector('.rResCanvas')||document.querySelector('.zoom-area')||document.querySelector('.screen-container'); return JSON.stringify({contentH: Math.max(n?(n.scrollHeight||n.offsetHeight):0, document.documentElement.scrollHeight), vh: innerHeight}) }"

# ② 视口高度调到 ≥ 内容高 + 播放器页头（约 100px）；宽度保持默认 1920
cd "$W" && playwright-cli resize 1920 <contentH+100>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 2000))"

# ③ 此时画布已完整展开，再整页截图才是真的「截全」
cd "$W" && playwright-cli screenshot --filename=03-order-list.png --full-page
```

> **实测（墨刀，v0.1.19，宽 1920）**：画布内容高 2111px。
> - 视口 `1920×1080`（默认）→ 画布容器仅 1032px，**下半截 1079px 看不到**；
>   `--full-page` 输出仍是 1920×1080（= 首屏）。
> - `resize 1920 2250` → 容器 2202px ≥ 2111px，整页截图 **1920×2250** 完整覆盖。

- 若某个画布容器**自身带滚动条**（`scrollHeight > clientHeight` 且可见），
  `resize` 不够 —— 需滚动容器分屏截图，或就地截该元素后拼接。
- **截图前清掉遮挡**：说明 / 批注面板常浮在画布上 → 先收起，或点开前后各截一张（见 pitfalls §15）。
- 序号与 `prototype-capture.md` 页面清单表格一一对应；**中文页面名不进文件名**（用拼音，见铁律）。
- **默认视口 `1920×1080`**（PC）；H5 / 小程序用 `375×812`。
  截整页时**高度按 ① 量出的内容高上调、宽度不变**。

## Step 5 — 落盘抓取材料（交需求分析师理解）

**skill 的产出 = 文本 + 截图**；需求分析师读这两样、理解后**自己撰写 `prototype-analysis.md`**。

| 产物 | 落盘位置 | 说明 |
|---|---|---|
| 抓取材料（文本） | `<storyDir>/prototype-capture.md` | 采集事实的结构化归拢，见下「必备章节」 |
| 截图 + 快照 | `<storyDir>/prototype-work/` | 原始证据目录，**保留不删**；截图文件名登记在材料页面清单里 |

> 抓取材料落在 **Story 产物目录**（与 `requirement-analysis.md` 同级）；
> 截图与快照留在 `prototype-work/` 原地，**不删** —— 需求分析师复核、后续追溯都靠它。

### 必备章节（抓取材料骨架，缺一即视为未完成）

| 章节 | 内容 | 来源 |
|---|---|---|
| 原型抓取方法 | 渲染类型（A/B/C 及子类）、是否 Canvas、说明文字来源、抓取局限 | 探测 + 采集结论 |
| 页面清单 | 表格：序号 / 中文页面名 / URL 或 iframe src / 截图文件名 / 关键功能点 / 状态变体 | 页面拓扑 |
| 原型说明 | 逐条摘录说明 / 批注 / 标注文字，**标注出处页面与载体** | Step 4.1 |
| 交互流程 | 页面跳转、点击热区、弹窗、tab 等状态变化 | 点击前后比对 |
| 字段与校验规则 | 字段名 / 类型 / 必填 / placeholder / 校验规则 | DOM + 说明文字 |
| 局限与待确认 | 抓不到的部分（登录墙 / Canvas / 说明缺失） | 降级记录 |

### 记录纪律（违反即污染需求分析师的理解）

1. **只记采到的事实**：说明文字里写明的校验规则**原样摘录**；说明没写的规则**禁止**推断补全。
2. **标注来源**：每条说明标注「来自哪个页面的说明面板 / 画布批注 / 画布文本」。
3. **Canvas 类强制标注**：字段只能来自截图识别 → 在「原型抓取方法」写明并说明遗漏风险，
   并在材料里提醒需求分析师把存疑字段转为**非 blocking** 待确认项。
4. **说明缺失时如实写「未找到说明」**，禁止用通用经验补一段像模像样的规则。

> **不要替需求分析师下结论**：材料只呈现「看到了什么」；功能点归并、AC 推导、风险判断是需求分析师的活。

## 五层信息 → 产出映射

**本 skill 的核心：抓到的东西分别落进 `prototype-capture.md` 的哪一节**
（需求分析师读这份材料 + 截图，理解后撰写 `prototype-analysis.md`）。

| 层 | 载体 | CLI 取法 | 写入章节 |
|---|---|---|---|
| 页面拓扑 | 左侧页面/菜单清单 | 宿主平台：`#sitemapTreeContainer .sitemapPageName`；A 类：快照 link/list 节点；B 类：截图识别 | 页面清单 |
| 页面内容 | DOM 文本 / 截图 | C 类：`snapshot`+`find` 或 `contentDocument`；A 类 `eval innerText`；B 类 `screenshot` | 字段与校验规则 |
| **原型说明** | **说明/批注/标注面板、画布批注** | **`find --regex` + 通用说明探针（`textContent` 取隐藏面板）** | **原型说明** |
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
| 截图 | `<workDir>/*.png`（`--filename` 落 CWD 根） | `<序号>-<页面名拼音>.png`（**整页**；说明态加 `-notes`） |
| 快照 yml | `<workDir>/*.yml`（`--filename` 落 CWD 根） | `<用途>.yml`（如 `topo.yml`） |
| **prototype-capture.md（抓取材料）** | **`<storyDir>/`（Story 产物目录）** | 固定名 |

- **中文页面名不进文件名**（Windows shell 转义易错）→ 用「序号-拼音」，
  中文名登记在 `prototype-capture.md` 的页面清单表格里。
- 序号按遍历顺序递增，与页面清单表格一一对应；**截图文件名写进页面清单表格**。
- `<workDir>` **整体保留**（截图 + 快照为原始证据）；**只清 `.playwright-cli/`**，不删整目录。
- ⚠️ 不带 `--filename` 的产物落在 `.playwright-cli/` 内，收尾清理时会被删 —— **一律显式给 `--filename`**。

## 抓不到时的降级

| 情况 | 处理 |
|---|---|
| 页面要求登录 | `open-questions.json` 记 **blocking** 项，向用户要截图，**不要瞎猜内容** |
| 拦截页按钮点了没反应 | 可能有多层 → 重新 `snapshot` 找下一层；或 `console` 看报错 |
| 点击无反应（交互没做/异步慢） | `console` + `network` 查报错；必要时 `tracing-start/stop` |
| `contentDocument` 返回 `null` | **跨域（C3）** → 改用 `snapshot`/`find`，或 `goto` iframe `src` |
| 页面清单找不到 / 只有 1 页 | **Axure 面板默认折叠** → 先点开「Project Pages」 |
| 找不到说明面板 / 说明文字 | 换关键词（需求/交互/校验/逻辑/备注）再 `find`；仍无 → 材料里写「未找到说明」，不编造 |
| 说明文字是 Canvas 绘制 | `find` 与探针均无效 → 只能截图识别，必须标注遗漏风险 |
| 原型链接失效 / 403 | 如实记录，向用户确认链接有效性 |

## 按需加载

| 场景 | 读哪个 reference |
|---|---|
| 具体 CLI 命令 / 三类完整遍历序列 / 宿主平台定向提取 / 输出组织 | [references/cli-commands.md](references/cli-commands.md) |
| **说明文字采集完整命令与通用探针 / 抓取材料写法** | [references/cli-commands.md §8 / §9](references/cli-commands.md) |
| 命令报错、会话残留、拦截页/iframe 异常、说明文字/截图异常、疑似踩坑 | [references/pitfalls.md](references/pitfalls.md) |

> `playwright-cli` 处 `0.1.x` 预览期，命令可能变 —— 以 `playwright-cli --help`
> 与 `playwright-cli <command> --help` 实际输出为准。
