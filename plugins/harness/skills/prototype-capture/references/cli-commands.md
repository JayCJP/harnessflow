# CLI 命令与遍历序列

> `playwright-cli` v0.1.17 / v0.1.19 实测验证。命令以 `playwright-cli --help` 实际输出为准。

## 0. 命令前缀约定

**所有命令都带 `cd <workDir> &&` 前缀。** 原因见 [pitfalls.md](pitfalls.md#2-cwd-强绑定最难排查的坑)。

```bash
W="<storyDir>/prototype-work"     # 本 Story 的固定工作目录
cd "$W" && playwright-cli <command>
```

---

## 0.1 输出模式：`--raw` / `--json` / 默认（**取值必看**）

三种输出模式的实测回执对比（同一命令 `eval "() => document.title"`）：

| 模式 | 回执 | 用途 |
|---|---|---|
| **默认** | `### Result` + 值 + **`### Ran Playwright code` JS 代码块** | 人类阅读；**Agent 取值需额外解析，不要用** |
| **`--raw`** | 只有值本身（`"Example Domain"`） | **Agent 读取内容的默认选择** |
| **`--json`** | `{ "result": "..." }`（结构化，含 `isError` 字段） | 需要区分成功/失败、程序化解析时 |

**实测：不加 `--raw` 时 `eval` 的回执长这样** ——

```
### Result
"Example Domain"
### Ran Playwright code
```js
await page.evaluate('() => document.title');
```
```

代码块是**指令回显**，对取值的 Agent 是纯噪音。加 `--raw` 后只剩 `"Example Domain"`。

**选择规则**：

| 场景 | 用哪个 |
|---|---|
| `eval` / `find` 取页面内容 | **`--raw`** |
| 判断会话残留（`list`） | **`--json`**（要读 `browsers` 数组） |
| 需要判断命令是否失败 | **`--json`**（有 `isError` / `error` 字段） |
| `open` / `click` / `close` 等动作类命令 | 默认即可（主要看是否报错） |

> **`--raw` 是 agent 友好模式**，本 skill 中所有「取值」命令都带 `--raw`，不要省。

---

## 0.2 前置检查与环境自检序列

**每次抓取前跑（2 条）**：

```bash
playwright-cli --version          # 期望 ≥ 0.1.17（已在 0.1.17 / 0.1.19 验证）
playwright-cli --json list        # 期望 {"browsers": []}；非空则 playwright-cli kill-all
```

**仅在「新机器首次使用」或「报错后排查」时跑** —— 用公共页面确认 CLI 链路通畅：

```bash
cd /tmp && playwright-cli open "https://example.com"
cd /tmp && playwright-cli --raw eval "() => document.title"     # 期望 "Example Domain"
cd /tmp && playwright-cli --raw eval "() => document.querySelectorAll('a').length"   # 期望 1
cd /tmp && playwright-cli screenshot --filename=smoke.png        # 期望落 /tmp/smoke.png
cd /tmp && playwright-cli close && playwright-cli kill-all
cd /tmp && playwright-cli --json list                            # 期望 {"browsers": []}
rm -f /tmp/smoke.png && rm -rf /tmp/.playwright-cli
```

> **为何要这一步**：原型链接往往不公开、失效即无法重试，且托管平台可能有拦截页/权限。
> 先用一个公共页面把 CLI 链路验证通，比拿真实原型试错便宜得多。
> 自检失败 → 先解决环境（未安装 / 版本过低 / daemon 残留），不要带着问题去跑真实原型。

> **未安装时的判断与安装**：跑 `playwright-cli --version`，若报 `command not found` /
> PowerShell「无法将项识别为命令」即未安装。安装命令（需 Node.js ≥ 20）：
> ```bash
> npm install -g @playwright/cli@latest
> playwright-cli install-browser   # 首次运行 CLI 也会自动下载浏览器，可省略
> ```
> 不想全局安装可用 `npx playwright cli <command>` 等价替代。详见 SKILL.md「前置检查 §①」。
> 安装来源以官方为准：https://playwright.dev/agent-cli/installation

**工作目录约定**：

```bash
W="<storyDir>/prototype-work"     # 本 Story 固定工作目录
mkdir -p "$W"
```

截图与快照都落这里，**抓完整体保留**（原始证据，供需求分析师自上而下理解与复核）；
只清掉 `$W/.playwright-cli/` 缓存目录，**不删 `$W` 本身**。

---

## 1. 命令速查（原型抓取用得到的）

### 导航

| 命令 | 用途 |
|---|---|
| `open <url>` | 打开浏览器并导航（自动截首屏快照） |
| `goto <url>` | 当前会话内导航 |
| `go-back` / `go-forward` / `reload` | 前进后退刷新 |

### 观察

| 命令 | 用途 | 输出位置 |
|---|---|---|
| `snapshot` | 无障碍树快照，含元素 `ref` | **落文件** `.playwright-cli/page-*.yml` |
| `snapshot --filename=x.yml` | 同上，指定文件名 | **落 CWD 根** `./x.yml`（**注意与不带参数时路径不同**） |
| `find "<text>"` | 按**大小写不敏感子串**搜快照，返回命中节点 + 上下文切片 | stdout |
| `find --regex "<re>"` | 同上，正则模式（与文本参数**互斥**，二者只能给一个） | stdout |
| `--raw eval "() => ..."` | 执行 JS 并只输出返回值 | stdout |
| `screenshot` | 截图 | 落文件 `.playwright-cli/page-*.png` |
| `screenshot --filename=x.png` | 同上，指定文件名 | **落 CWD 根** `./x.png` |
| `console [level]` | 控制台消息 | stdout |
| `network` / `requests` | 网络请求列表 | stdout |
| `resize <w> <h>` | 调整视口 | — |
| `run-code "<async page => ...>"` | 执行 Playwright API 代码（诊断用，如列 frame） | stdout |

### 交互

| 命令 | 用途 |
|---|---|
| `click <ref>` | 点击（`ref` 来自快照，也支持 CSS / `role=button[name=X]`） |
| `hover <ref>` | 悬停（取状态变体） |
| `press <key>` | 按键（`Escape` 关弹窗、`Enter` 提交） |
| `fill <ref> "<text>"` | 填表单 |
| `tab-new` / `tab-list` / `tab-select <n>` / `tab-close` | 标签页（子 tab 场景） |

### 会话收尾

| 命令 | 用途 |
|---|---|
| `close` | 关闭浏览器（清 session 文件） |
| `kill-all` | **强制杀所有 daemon 进程**（收尾必跑） |
| `--json list` | 查看残留会话（复查用） |

---

## 2. 探测协议（完整序列）

### 2.0 前置拦截页（**先做这一步**）

```bash
W="<storyDir>/prototype-work"
cd "$W" && playwright-cli open "<原型URL>"
cd "$W" && playwright-cli --raw eval "() => location.href"        # URL 变成 /jump?go= 之类 = 有拦截页

# 有拦截页 → 找到按钮点掉
cd "$W" && playwright-cli snapshot --filename=gate.yml && cat "$W/gate.yml"
# 定位 button "知道了, 进入查看" 的 ref 后：
cd "$W" && playwright-cli click <ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"
cd "$W" && playwright-cli --raw eval "() => location.href"        # 确认已跳离
```

### 2.1 渲染类型探测

```bash
cd "$W" && playwright-cli --raw eval "() => JSON.stringify({iframe: document.querySelectorAll('iframe').length, canvas: document.querySelectorAll('canvas').length, text: document.body.innerText.length, imgs: document.querySelectorAll('img').length})"
```

结果分流：

| 结果 | 判定 | 下一步 |
|---|---|---|
| 有 iframe | C 类 | 走 §2.2 判 C1 / C2 / C3 |
| `canvas > 0` 且 `text` 极低 | B 类 | 走 §4 |
| 其余（有可读语义文本） | A 类 | 走 §3 |

**实测样本分布（用于校准判断，不是硬阈值）**：

| 实测样本 | text | iframe | canvas | 判定 |
|---|---|---|---|---|
| `example.com`（纯文本页） | 129 | 0 | 0 | **A 类** —— 文本少但 DOM 完整 |
| `modao.cc/feature/prototype`（重 DOM） | 3118 | 1 | 0 | **C 类**（iframe 优先） |
| 产品大牛 Axure 原型（壳 + 动态 iframe） | 22 | 1 | 0 | **C2** —— 壳文本极少但 iframe 内有真内容 |

> **要点**：`text` 绝对值极不可靠 —— 129 是 A 类、22 是 C 类，都**不是** B 类。
> 判定优先级固定为 `iframe` > `canvas` > `text`；`text` 只用于判断「是否接近空壳」，
> 且必须与 `canvas`/`imgs` 占主导同时成立才算 B 类。
>
> ⚠️ 上述数值是 v0.1.17 / v0.1.19 在特定时间点抓的，页面本身会改版 ——
> **当参考，不要写成代码里的阈值。**

### 2.2 C 类子类判定（**必做**）

```bash
# 列出 iframe 的 id 与 src
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>({id:e.id, src:e.src})))"

# 判同源（跨域时 contentDocument 为 null，不抛异常）
cd "$W" && playwright-cli --raw eval "() => { const f=document.querySelectorAll('iframe')[0]; try { return JSON.stringify({sameOrigin: !!f.contentDocument}) } catch(e) { return 'BLOCKED' } }"
```

| `src` | 同源 | 子类 | 处理 | 章节 |
|---|---|---|---|---|
| 真实 URL | — | **C1** | `goto` src → 回 §2.1 重新探测 | §5.1 |
| `about:blank` / `javascript:` | 是 | **C2** | 读 `contentDocument` | §5.2 |
| 真实 URL | 否 | **C3** | `snapshot` / `find` 穿透 | §5.3 |

> **`snapshot` 与 `find` 会自动穿透 iframe，跨域也能穿透** —— 这是 C2/C3 的首选手段。
> 实测跨域 iframe 内元素可直接 `click f4e6` 成功。

---

## 3. A 类：DOM 遍历完整循环

### 3.1 先摸清页面拓扑

```bash
cd "$W" && playwright-cli snapshot --filename=topo.yml
cat "$W/topo.yml" | head -120     # --filename 落 CWD 根，不是 .playwright-cli/
```

快照是 YAML 无障碍树，形如：

```yaml
- generic [ref=e2]:
  - heading "Example Domain" [level=1] [ref=e3]
  - link "Learn more" [ref=e6] [cursor=pointer]:
    - /url: https://iana.org/domains/example
```

**从快照里挑出菜单/页面列表节点，形成遍历清单**，再逐项点击。
主页面往往只是默认落地页，功能点藏在二三级菜单里 —— 跳过遍历等于没抓。

### 3.2 逐项遍历循环

对遍历清单的每一项：

```bash
# ① 点击前记录 URL
cd "$W" && playwright-cli --raw eval "() => location.href"

# ② 点击
cd "$W" && playwright-cli click <ref>

# ③ 等异步渲染（延时用箭头函数 + Promise）
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 1500))"

# ④ 检查是否产生 iframe（有则要穿透，见 §5）
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>e.src))"

# ⑤ 点击后 URL 变化 → 记录跳转关系（写进「交互流程」）
cd "$W" && playwright-cli --raw eval "() => location.href"

# ⑥ 截图归档（序号按遍历顺序，文件名用拼音；整页必带 --full-page）
cd "$W" && playwright-cli screenshot --filename=03-order-list.png --full-page

# ⑦ 取可见文本（页面内容 → 字段与校验规则）
cd "$W" && playwright-cli --raw eval "() => document.body.innerText"

# ⑧ 返回继续下一项
cd "$W" && playwright-cli go-back
```

### 3.3 状态变体

```bash
# hover 态
cd "$W" && playwright-cli hover <ref>
cd "$W" && playwright-cli screenshot --filename=03-order-list-hover.png --full-page

# 弹窗：点开后 snapshot 记录结构，再 ESC 关闭
cd "$W" && playwright-cli click <ref>
cd "$W" && playwright-cli snapshot --filename=modal.yml && cat "$W/modal.yml"
cd "$W" && playwright-cli screenshot --filename=03-order-list-modal.png --full-page
cd "$W" && playwright-cli press Escape
```

### 3.4 省 token 的取文本方式

`eval innerText` 会拉全文。**已知要找什么时优先用 `find`**（返回命中节点 + 前后文）：

```bash
# 纯文本：大小写不敏感的子串匹配
cd "$W" && playwright-cli --raw find "提交"

# 正则：必须显式加 --regex（默认参数是纯文本，写 "a|b" 会被当字面量）
cd "$W" && playwright-cli --raw find --regex "提交|取消|保存"
```

> **易错点**：`find "A|B"` 不会按正则解释，只会找字面量 `A|B`。
> 多关键词用 `--regex`，且文本参数与 `--regex` 不能同时给。

### 3.5 需要精确文本时

`innerText` 拿不到 `value` 属性、`placeholder`、被 CSS 隐藏的内容。要这些用 `eval` 定制：

```bash
# 表单字段：label + placeholder + 必填标记
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('input,textarea,select')].map(e=>({tag:e.tagName, name:e.name, type:e.type, ph:e.placeholder, required:e.required})))"
```

---

## 4. B 类：截图遍历（Canvas / 图片渲染）

> ⚠️ **「图片渲染」指原型用图片 / canvas 画出来，不是要下载这些图片。**
> 全程**只整页截图**，原型里的 `<img src>` / 背景图 / icon **一律不下载到本地** ——
> 截图本身就是唯一视觉证据。详见 SKILL.md 铁律 §9。

B 类 DOM 是空壳，`eval innerText` / `get_visible_text` 拿不到东西。**能拿的只有两样**：
左侧页面清单的导航节点 + 截图。

```bash
# ① 截图看整体布局（人/AI 读图识别页面清单）
cd "$W" && playwright-cli screenshot --filename=00-overview.png --full-page

# ② snapshot 只用来找导航节点 ref（不要指望拿到页面内容）
cd "$W" && playwright-cli snapshot --filename=nav.yml && cat "$W/nav.yml"

# ③ 逐页面：点导航 → 截图
cd "$W" && playwright-cli click <nav-ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 1500))"
cd "$W" && playwright-cli screenshot --filename=01-login.png --full-page

# ④ 顺便试一次文本（混合渲染有时残留可读文本，有就白捡）
cd "$W" && playwright-cli --raw eval "() => document.body.innerText.length"
```

**必须执行**：按 SKILL.md「B 类（Canvas 渲染）的强制标注」三条，在
`prototype-capture.md` 标注字段来源局限，并提醒需求分析师把存疑字段转为 `open-questions.json`
的非 blocking 待确认项（需求分析师再据此写入 `prototype-analysis.md`）。

> 截图里能看清的字段名/文案**可以**写进文档（这是事实）；
> 看不清的**禁止**靠上下文推断补全（这是编造）。

---

## 5. C 类：iframe 三种形态

**同样是 iframe，处理方式完全不同 —— 先用 §2.2 判子类。**

### 5.1 C1 可跳转（`src` 是真实 URL）

最省事的一种：把本体提为顶层页面，A/B 类手段全可用。

```bash
# ① 列出所有 iframe 的 src
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>e.src))"
# → ["https://prototype.example.com/p/abc123"]

# ② 直接导航到 iframe src（这才是原型本体）
cd "$W" && playwright-cli goto "https://prototype.example.com/p/abc123"

# ③ 重新走 §2.1 探测（iframe 内可能是 A 也可能是 B）
cd "$W" && playwright-cli --raw eval "() => JSON.stringify({iframe: document.querySelectorAll('iframe').length, canvas: document.querySelectorAll('canvas').length, text: document.body.innerText.length})"

# ④ 抓完 go-back 返回壳页面继续遍历其他菜单项
cd "$W" && playwright-cli go-back
```

> **代价**：脱离宿主壳后**拿不到左侧页面清单**，需自行维护遍历顺序。
> 若壳页面有页面树，**先把清单抓下来再 `goto`**。
> `go-back` 回不去时直接 `goto` 壳页面 URL 重建。

### 5.2 C2 动态写入（`src=about:blank`，同源）

**实测样本**：产品大牛托管的 Axure 原型 —— iframe `id=mainFrame`，`src=about:blank`，
内容由 Axure 的 JS 注入。**「读 src 再 goto」在此完全失效**（`about:blank` 无处可跳）。

```bash
# ① 首选：snapshot / find 自动穿透（无需关心同源）
cd "$W" && playwright-cli snapshot --filename=cur.yml && cat "$W/cur.yml"
cd "$W" && playwright-cli --raw find "<页面上肯定存在的词>"

# ② 需要成段取文本时读 contentDocument（同源才可行）
cd "$W" && playwright-cli --raw eval "() => { const d=document.querySelector('iframe').contentDocument; return JSON.stringify({title: d.title, text: d.body.innerText.slice(0,2000)}) }"
# → {"title":"优化商品限购排版","text":"需求背景：…"}
```

### 5.3 C3 跨域（`src` 是真实 URL 但**跨域**）

⚠️ **Axure / 托管平台的 iframe 不一定同源 —— 内嵌来源可能是第三方域。**

实测：跨域时 `contentDocument` 返回 **`null`（不抛异常）**，`eval` 读不到内部 DOM。

```bash
# ① 首要手段：snapshot / find 自动穿透（跨域也穿透！）
cd "$W" && playwright-cli snapshot --filename=xo.yml && cat "$W/xo.yml"
#   - iframe [ref=e4]:
#     - generic [ref=f1e2]:
#       - heading "Example Domain" [ref=f1e3]
cd "$W" && playwright-cli --raw find "Learn more"

# ② iframe 内元素可直接操作（实测成功）
cd "$W" && playwright-cli click f4e6

# ③ 兜底：goto 到 src 脱离宿主（丢页面清单，见 §5.1 的代价说明）
cd "$W" && playwright-cli goto "<iframe src>"

# ④ 诊断：列所有 frame 及 URL（确认嵌套了几层）
cd "$W" && playwright-cli --raw run-code "async page => JSON.stringify(page.frames().map(f=>({url:f.url(),name:f.name()})))"
# → [{"url":"http://127.0.0.1:8765/host.html","name":""},{"url":"https://example.com/","name":""}]
```

> **关键结论**：`snapshot` 与 `find` 的穿透能力**不受同源策略限制**，
> 跨域 iframe 内的节点照样出现在快照里（ref 带 `f` 前缀），且可点击。
> **所以 C2/C3 都首选 `snapshot` + `find`**，只有需要成段文本时才用 `contentDocument`（仅同源）。
>
> **嵌套深度看 ref 前缀层级**：`f1e*` → `f2e*` → `f4e*`。
> 嵌套 iframe → 重复 §2.1 探测。

---

## 5.4 宿主平台定向提取（Axure 播放器壳）

**识别到 Axure 播放器特征就直接用定向提取，比通用遍历准得多。**
典型平台：产品大牛 / Axure Cloud / 墨刀导出站。

| 特征 | 选择器 | 用途 |
|---|---|---|
| 页面树容器 | `#sitemapTreeContainer` | 一次取全部页面名 |
| 页面名节点 | `.sitemapPageName` | 逐页名 |
| 页面链接 | `a.sitemapPageLink` | **`href` 常为 `null`，不能靠它跳页** |
| 页面树面板标题 | 文本「Project Pages」的节点 | **默认折叠，必须先点开** |
| 当前页指示 | 壳文本 `(N of M)` | 校验总页数 |

```bash
# ① 点开 Project Pages 面板（默认折叠！不点开会漏掉全部页面）
cd "$W" && playwright-cli snapshot --filename=nav.yml && cat "$W/nav.yml"
#   - generic "Project Pages" [ref=f1e9]:
#     - generic "Project Pages" [ref=f1e12] [cursor=pointer]   # ← 展开按钮
#     - generic [ref=f1e13]:
#       - generic [ref=f1e14]: 更新日志
#       - generic [ref=f1e15]: (1 of 7)                        # ← 总页数线索
cd "$W" && playwright-cli click <f1e12 这类面板标题 ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 2000))"

# ② 一次取全页面清单（比逐页 click 快得多）
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('#sitemapTreeContainer .sitemapPageName')].map(e=>e.innerText))"
# → ["更新日志","优化商品限购排版","报名表、调查问卷文本框扩容","导航栏展示页面新增我的优惠券","交易分析优化筛选、修改说明文案","互动大屏新增用户uid显示","下单页商品支持点击放大商品"]

# ③ 跳页：click 该页面名的 ref（**唯一可靠方式**）
cd "$W" && playwright-cli click <第 N 个页面名的 ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"

# ④ 取当前页内容（C2 同源时）
cd "$W" && playwright-cli --raw eval "() => { const d=document.querySelector('iframe').contentDocument; return JSON.stringify({title: d.title, text: d.body.innerText.slice(0,2000)}) }"

# ⑤ 截图（Axure 是 PC 宽屏，先 resize 到默认视口；高度按内容高调，见 §7）
cd "$W" && playwright-cli resize 1920 1080
cd "$W" && playwright-cli screenshot --filename=02-<拼音页面名>.png --full-page
```

> ⚠️ **不要用 `?p=<页面名>` URL 跳页** —— 实测（v0.1.19 / 产品大牛）该 URL 会**重新触发
> `/jump?go=` 拦截流程**，点掉拦截页后 `p` 参数被丢弃、回到第 1 页。
> **翻页只能靠 click 快照里的页面名 ref。**
>
> **另外两个坑**：① 面板默认折叠，不点开就取不到页面清单（会误判「只有一页」），
> 且**每次页面跳转后面板可能重新折叠**，取清单前先确认展开状态；
> ② `a.sitemapPageLink` 的 `href` 是 `null`，Axure 用 JS 跳转。
>
> **其他托管平台**（墨刀 / 蓝湖等）结构不同但套路一致：
> 先找页面树容器，再找页面名节点。认不出特征时退回通用遍历，
> **不要硬套 Axure 选择器**。

---

## 6. 收尾（必须执行，缺一不可）

```bash
cd "$W" && playwright-cli close
cd "$W" && playwright-cli kill-all
cd "$W" && playwright-cli --json list        # 必须为 {"browsers": []}
rm -rf "$W/.playwright-cli"                  # 只清浏览器缓存，截图与快照保留
```

`close` 只清 session 文件，daemon 进程可能仍在。`kill-all` 是强制杀。
`--json list` 是复查 —— 非空就再跑一次 `kill-all`。
**`$W` 整体保留**（截图 + 快照 = 原始证据）；**只删 `.playwright-cli/`**。

## 7. 输出组织

截图与快照**留在 `<workDir>` 原地**，不搬运 —— `workDir` 就是本 Story 的原型证据目录。

```bash
# 只清浏览器缓存；截图与快照保留
rm -rf "$W/.playwright-cli"
```

| 产物 | 位置 | 命名 |
|---|---|---|
| 截图（`--filename`） | `<workDir>/`（CWD 根） | `<序号>-<拼音>.png` |
| 截图（不带参数） | `<workDir>/.playwright-cli/`（**收尾会被清掉**） | 自动生成时间戳名 |
| 快照（`--filename`） | `<workDir>/`（CWD 根） | `<用途>.yml` |
| 页面清单 | `prototype-capture.md` 表格 | 中文名 + 序号 + 截图文件名 + URL/iframe src |

> **`--filename` 落 CWD 根，不带 `--filename` 落 `.playwright-cli/`** —— 实测确认。
> 本 skill 统一用 `--filename`（落 CWD 根，路径可预期）。
> ⚠️ 不带 `--filename` 的产物落在 `.playwright-cli/` 内，收尾清理时一并消失 —— **一律显式给 `--filename`**。

**截图参数（v0.1.19 实测可用）**：

| 选项 | 用途 |
|---|---|
| `--full-page` | 截**整页**（含可滚动部分）—— **逐页截图默认必带**，不截首屏 |
| `--hires` | 按设备像素比截**高清**（小字号 / Canvas 类需要） |
| `--type=webp\|jpeg` | 换格式，默认按扩展名推断 |

**默认视口 `1920×1080`**（PC）：`open` 后先 `playwright-cli resize 1920 1080` 统一基线；
H5 / 小程序用 `375×812`。

⚠️ **播放器类原型（墨刀 / Axure / 产品大牛）只加 `--full-page` 仍然截不全**：
这类页面是固定视高应用，**文档不滚动**（`document.scrollHeight == innerHeight`），
画布内容在内部容器里**按当前视口高度裁切**（不缩放适配），`--full-page` 覆盖不到。
**先量内容高度、再把视口调高**：

```bash
# ① 量出画布真实内容高度
cd "$W" && playwright-cli --raw eval "() => { const n=document.querySelector('.rResCanvas')||document.querySelector('.zoom-area')||document.querySelector('.screen-container'); return Math.max(n?(n.scrollHeight||n.offsetHeight):0, document.documentElement.scrollHeight) }"

# ② 视口高度调到 ≥ 内容高（+播放器页头约 100px），宽度保持 1920，延时后整页截图
cd "$W" && playwright-cli resize 1920 2250
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 2000))"
cd "$W" && playwright-cli screenshot --filename=03-order-list.png --full-page
```

> 实测（墨刀，v0.1.19，宽 1920）：画布内容高 2111px。
> - `1920×1080`（默认）→ 画布容器仅 1032px，下半截看不到；`--full-page` 输出仍是 **1920×1080（= 首屏）**。
> - `resize 1920 2250` → 容器 2202px ≥ 2111px，整页截图 **1920×2250** 完整覆盖。

**中文页面名进 md 表格，不进文件名。**

最终还要落盘**抓取材料 `<storyDir>/prototype-capture.md`**（需求分析师据此 + 截图理解后撰写 `prototype-analysis.md`）—— 见 §9。

---

## 8. 原型说明文字采集（**核心环节**）

原型说明 = 产品经理写在原型里的**需求说明 / 交互说明 / 校验规则**。抓不到它，下游只能靠猜。

### 8.1 关键词探测（首选，会穿透 iframe）

```bash
cd "$W" && playwright-cli --raw find --regex "说明|备注|批注|标注|注释|交互说明|校验|规则|Notes?|Annotations?"
```

**实测（v0.1.19）**：`find --regex` **会穿透 iframe** —— iframe 内的说明文字
（ref 形如 `f1e5`）照样进结果，并带上下文切片。这是**发现说明最可靠的手段**，优先于任何选择器。

命中示例（本地 fixture 实跑）：

```
- generic [ref=e5]:
  - iframe [ref=e12]:
    - generic [ref=f1e1]:
      - text: 限购数量
      - textbox "请输入限购数量" [ref=f1e3]
      - button "立即购买" [ref=f1e4]
      - generic [ref=f1e5]: 说明：限购数量不可超过当前库存      ← iframe 内的说明被穿透命中
- complementary [ref=e13]:
  - generic [ref=e14]: 交互说明：输入框失焦即实时校验，非法值红字提示
```

### 8.2 通用说明探针（属性提示 + 文本锚点兜底）

`find` 只按关键词命中，会漏掉「面板标题不叫说明、但内容就是说明」的情况。用探针兜底：

```bash
cd "$W" && playwright-cli --raw eval "() => { const KEY = /(note|annotat|comment|remark|mark|desc|说明|备注|批注|标注|注释)/i; const out = []; const seen = new Set(); const push = (src, el) => { const t = ((el && el.textContent) || '').replace(/\s+/g, ' ').trim(); if (t.length < 2 || t.length > 4000 || seen.has(t)) return; seen.add(t); out.push({ src: src, text: t.slice(0, 800) }); }; const nodes = document.querySelectorAll('div,section,aside,article,li,dl,dd,td,th,p,h1,h2,h3,h4,h5,label,span,button'); const cands = []; nodes.forEach(el => { const sig = [el.id, typeof el.className === 'string' ? el.className : ''].join(' '); if (KEY.test(sig)) cands.push(['attr:' + (el.id || el.className), el]); }); nodes.forEach(el => { const own = (el.textContent || '').trim(); if (own.length <= 12 && KEY.test(own)) { const box = el.closest('section,aside,div,li,dl') || el.parentElement; if (box) cands.push(['anchor:' + own, box]); } }); cands.forEach(c => push(c[0], c[1])); return JSON.stringify(out.slice(0, 40)); }"
```

**实测输出（本地 fixture）**：

```json
[
  {"src":"attr:btnNotes","text":"说明"},
  {"src":"attr:notesPanel","text":"原型说明 下单页限购数量上限由商品配置决定，默认 5 件 点击「立即购买」时校验库存，库存不足提示「库存不足，请调整数量」 支付结果页展示订单号与实付金额，2 秒后自动跳转订单详情"},
  {"src":"attr:note-item","text":"下单页限购数量上限由商品配置决定，默认 5 件"},
  {"src":"attr:canvasRemark","text":"交互说明：输入框失焦即实时校验，非法值红字提示"}
]
```

**三条要点**：

1. **用 `textContent` 而非 `innerText`**：`display:none` 的说明面板 `innerText` 返回空，
   `textContent` 仍返回全文 —— **不点开也能拿到说明文字，点开只为补一张截图**。
2. `attr:` = 属性命中（id/class 含 note/annotation/comment…），`anchor:` = 文本锚点命中。
   `anchor:` 会带回工具栏一类噪音（如 `"说明 批注 (1 of 3)"`），**需过滤，不要无脑写进材料**。
3. **探针是兜底不是替代**：先 `find`（命中即准），再用探针补齐结构化说明面板。

### 8.3 展开说明面板（仅为截图，取文本不需要）

```bash
cd "$W" && playwright-cli snapshot --filename=notes.yml && cat "$W/notes.yml"   # 找「说明」按钮 ref
cd "$W" && playwright-cli click <ref>            # 也支持 CSS：playwright-cli click "#btnNotes"
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 500))"
cd "$W" && playwright-cli screenshot --filename=03-order-list-notes.png
```

> 点开后面板可能改变布局 → **先点开、再截正文页，或点开前后各截一张**，避免截到被遮挡的页面。

### 8.4 三轮找不到就是真没有

```bash
cd "$W" && playwright-cli --raw find --regex "需求|背景|交互|校验|逻辑|提示|备注|说明"
```

三轮都没有 → 在 `prototype-capture.md` 如实写「**未找到说明文字**」，
**禁止**用通用经验补一段像模像样的规则。

---

## 9. 落盘抓取材料 prototype-capture.md

**`<storyDir>/prototype-capture.md`** 是本 skill 的产物（不是 `<workDir>/`）——
它只**归拢采集到的事实**。需求分析师读这份材料 + `<storyDir>/prototype-work/` 里的截图与快照，
**理解后自己撰写 `prototype-analysis.md`**。下面给一份可直接照抄的骨架，`<>` 内按实际填写：

```markdown
# 原型抓取材料：<需求标题>

## 原型抓取方法
- 原型地址：<URL>
- 渲染类型：<A 类 DOM / B 类 Canvas / C 类 iframe（C1/C2/C3）>
- 说明文字来源：<宿主平台说明面板 / 画布批注 / 画布文本 / 未找到说明>
- 抓取局限：<登录墙 / Canvas 无 DOM 语义 / 说明缺失 / 链接失效 —— 如实写>

## 页面清单
| 序号 | 页面名 | URL / iframe src | 截图 | 关键功能点 | 状态变体 |
|---|---|---|---|---|---|
| 1 | 首页 | <url> | 01-home.png | <功能点> | <hover/弹窗> |
| 2 | 下单页 | <url> | 02-order-list.png | <功能点> | 02-order-list-notes.png |

## 原型说明（原文摘录，勿加工）
> 逐条摘录，标注出处页面与载体；无则写「未找到说明文字」。
- [下单页 / 说明面板] 限购数量上限由商品配置决定，默认 5 件
- [下单页 / 画布批注] 输入框失焦即实时校验，非法值红字提示

## 交互流程（实测）
- <页面A> --点击「立即购买」--> <页面B>（实测 URL / DOM 变化）

## 字段与校验规则（原始提取）
| 字段 | 类型 | 必填 | placeholder | 校验规则 | 来源 |
|---|---|---|---|---|---|
| 限购数量 | 数字 | - | 请输入限购数量 | 不可超过当前库存 | 说明文字 |

## 局限与待确认
- <存疑字段 / 抓不到的部分>（提醒需求分析师转为 open-questions.json 的非 blocking 项）
```

**硬约束**：

- 截图保留在 `<storyDir>/prototype-work/`（**不删**），文件名写进「页面清单」表格。
- 「原型说明」只摘录原文，**不加工成规则、不下结论** —— 功能点归并与 AC 推导是需求分析师的活。
- Canvas 类的字段来源必须标「截图识别」+ 遗漏风险，并提醒需求分析师转记 `open-questions.json`。
