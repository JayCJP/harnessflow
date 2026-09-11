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

**工作目录约定**：

```bash
W="<storyDir>/prototype-work"     # 本 Story 固定工作目录
mkdir -p "$W"
```

截图与快照都落这里，抓完归档到 `<storyDir>/prototype/`，`$W` 整个删掉。

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

# ⑥ 截图归档（序号按遍历顺序，文件名用拼音）
cd "$W" && playwright-cli screenshot --filename=03-order-list.png

# ⑦ 取可见文本（页面内容 → 字段与校验规则）
cd "$W" && playwright-cli --raw eval "() => document.body.innerText"

# ⑧ 返回继续下一项
cd "$W" && playwright-cli go-back
```

### 3.3 状态变体

```bash
# hover 态
cd "$W" && playwright-cli hover <ref>
cd "$W" && playwright-cli screenshot --filename=03-order-list-hover.png

# 弹窗：点开后 snapshot 记录结构，再 ESC 关闭
cd "$W" && playwright-cli click <ref>
cd "$W" && playwright-cli snapshot --filename=modal.yml && cat "$W/modal.yml"
cd "$W" && playwright-cli screenshot --filename=03-order-list-modal.png
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

B 类 DOM 是空壳，`eval innerText` / `get_visible_text` 拿不到东西。**能拿的只有两样**：
左侧页面清单的导航节点 + 截图。

```bash
# ① 截图看整体布局（人/AI 读图识别页面清单）
cd "$W" && playwright-cli screenshot --filename=00-overview.png

# ② snapshot 只用来找导航节点 ref（不要指望拿到页面内容）
cd "$W" && playwright-cli snapshot --filename=nav.yml && cat "$W/nav.yml"

# ③ 逐页面：点导航 → 截图
cd "$W" && playwright-cli click <nav-ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 1500))"
cd "$W" && playwright-cli screenshot --filename=01-login.png

# ④ 顺便试一次文本（混合渲染有时残留可读文本，有就白捡）
cd "$W" && playwright-cli --raw eval "() => document.body.innerText.length"
```

**必须执行**：按 SKILL.md「B 类（Canvas 渲染）的强制标注」三条，在
`prototype-analysis.md` 标注字段来源局限 + 在 `open-questions.json` 留非 blocking 待确认项。

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

# ⑤ 截图（Axure 是 PC 宽屏，先 resize）
cd "$W" && playwright-cli resize 1440 900
cd "$W" && playwright-cli screenshot --filename=02-<拼音页面名>.png
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
```

`close` 只清 session 文件，daemon 进程可能仍在。`kill-all` 是强制杀。
`--json list` 是复查 —— 非空就再跑一次 `kill-all`。

## 7. 输出组织

```bash
# 截图收拢到 Story 产物目录（序号与页面清单表格一致）
mkdir -p "<storyDir>/prototype"
cp "$W"/00-overview.png "$W"/01-login.png "<storyDir>/prototype/"

# 快照 yml 不归档；整个 workDir 抓完即删
rm -rf "$W"
```

| 产物 | 位置 | 命名 |
|---|---|---|
| 截图（`--filename`） | `<workDir>/`（CWD 根） | `<序号>-<拼音>.png` |
| 截图（不带参数） | `<workDir>/.playwright-cli/` | 自动生成时间戳名 |
| 快照（`--filename`） | `<workDir>/`（CWD 根） | `<用途>.yml` |
| 快照（不带参数） | `<workDir>/.playwright-cli/` | 自动生成时间戳名 |
| 页面清单 | `prototype-analysis.md` 表格 | 中文名 + 序号 + 截图文件名 + URL/iframe src |

> **`--filename` 落 CWD 根，不带 `--filename` 落 `.playwright-cli/`** —— 实测确认。
> 本 skill 统一用 `--filename`（落 CWD 根，路径可预期），抓完整个 `<workDir>` 一起删。

**中文页面名进 md 表格，不进文件名。**
