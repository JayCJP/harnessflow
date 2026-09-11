# playwright-cli 坑清单与排查

> 每条都有官方 issue / 本机实测佐证。按「踩到的概率 × 后果严重度」排序。

---

## 1. daemon 残留（最严重）

**现象**：`close` 之后浏览器进程仍在，反复抓取会累积；严重时卡死机器。

**根因**：`playwright-cli` 采用 **client-daemon 架构**。daemon 是 `spawn(detached: true)`
+ `unref()` 启动的常驻 Node 进程，独立于父进程存活，持有真实浏览器实例。
若 socket 目录被清理而 daemon 仍活着，**再也无法通过 CLI 关闭它**。

**实测数据**：官方 issue 报告有主机残留 **19 个 daemon、最老存活 4 天 8 小时、约占 14.8GB 内存**
（`microsoft/playwright#42428`，已在 v1.64 部分修复）。

**规避**：

```bash
cd "$W" && playwright-cli close
cd "$W" && playwright-cli kill-all          # 必须补这一条
cd "$W" && playwright-cli --json list       # 复查必须是 {"browsers": []}
```

**疑似残留时**：`--json list` 无输出但内存异常 → `kill-all`；仍不行则查系统进程
（Windows: `Get-Process msedge,chrome`，找 `--type=renderer` 且父进程无 CLI 关联的）。

---

## 2. CWD 强绑定（最难排查的坑）

**现象**：明明 `open` 过了，下一条命令却报 `The browser '<session>' is not open, please run open first`。

**根因**：session 注册表、socket 路径、profile 目录、`.playwright/cli.config.json`
**全部按启动时的 CWD 解析**（工作区路径做 SHA1 哈希命名空间隔离）。
换个目录执行 → 命中不同哈希 → 找不到原 session。

**规避**：**每条命令都带显式 `cd <固定目录> &&` 前缀**（SKILL.md 铁律 1）。
不要依赖 shell 会话的隐式 cwd 保持 —— Agent 每次 Bash 调用可能是独立进程。

**排查**：报「not open」时先 `pwd` 确认 CWD 与 `open` 时一致。

---

## 3. `close-all` 不杀进程

**现象**：`close-all` 后用 `--json list` 显示无会话，但浏览器进程仍在，下次 `open` 报
`Browser is already in use`（profile 被锁）。

**根因**：`close-all` 只清 session 注册，不做进程级终止。

**规避**：只用 `kill-all`，不要用 `close-all`。
profile 被锁时：先 `kill-all`，确认进程退出后再 `open`。

---

## 4. 版本错配

**现象**：`Session.run()` 拒绝执行，提示重新 `open` 会话。

**根因**：CLI client 与常驻 daemon 之间有 `Semver` 兼容性检查
（`compareSemver(clientVersion, daemonVersion) >= 0`）。daemon 是先启动的，若期间 npm 升级了
CLI，client 版本会**低于** daemon → 拒绝。

**规避**：

```bash
playwright-cli --version        # 抓取前先看
```

版本变动后：`kill-all` 杀掉旧 daemon，重新 `open` 起新 daemon。

**额外风险**：`playwright-cli` 处 `0.1.x` 预览期，命令签名可能变动。
本 skill 的命令在 `0.1.17` / `0.1.19` 上验证过；换版本后先 `playwright-cli <command> --help` 核对。

---

## 5. `snapshot` 默认落文件不落 stdout，且两种路径不同

**现象 A**：执行 `snapshot` 后以为「快照是空的」，因为 stdout 只有一行
`- [Snapshot](.playwright-cli\page-2026-...yml)`。

**现象 B**：写了 `--filename=topo.yml`，去 `.playwright-cli/topo.yml` 找却找不到。

**根因**：为省 token，`snapshot` / `screenshot` 默认把结果**写入文件**，stdout 只回路径。
且 **带 `--filename` 与不带 `--filename` 的落盘目录不同**（v0.1.17 / v0.1.19 实测一致）：

| 写法 | 落盘位置 |
|---|---|
| `snapshot` | `<CWD>/.playwright-cli/page-<时间戳>.yml` |
| `snapshot --filename=topo.yml` | `<CWD>/topo.yml`（**CWD 根，不是 `.playwright-cli/`**） |
| `screenshot` | `<CWD>/.playwright-cli/page-<时间戳>.png` |
| `screenshot --filename=x.png` | `<CWD>/x.png` |

**规避**：路径要写对。

```bash
cd "$W" && playwright-cli snapshot --filename=topo.yml
cat "$W/topo.yml"                       # --filename 落在 CWD 根
```

或全局改成 stdout 模式（在当前目录建 `playwright-cli.json`）：

```json
{ "outputMode": "stdout" }
```

> 对本 skill 不建议改 stdout —— 落文件后可按需 `cat` 片段（如 `head -120`），
> 比全量进上下文省得多。

---

## 6. `eval` 语法约束

**现象**：`SyntaxError: Unexpected token 'var'`。

**根因**：`eval` 的参数被当作**表达式**求值，不是函数体。
`"var x = 1; x"` 是语句，非法；`"() => { const x = 1; return x }"` 是表达式，合法。

**规避**：

| ❌ 错 | ✅ 对 |
|---|---|
| `eval "document.title"` | 也合法（纯表达式），但复杂逻辑要用箭头函数 |
| `eval "var a=[...]; JSON.stringify(a)"` | `eval "() => JSON.stringify([...a])"` |
| `eval "document.querySelectorAll('a').length"` | ✅ 合法 |

**推荐统一写成箭头函数** `"() => ..."`，避免记两套规则。

---

## 7. 读 `src` 属性不受同源策略限制

**现象**：需要拿到 iframe 的本体地址来判断/跳转。

**要点**：**读 `src` 属性本身不受同源策略限制**（`contentDocument` 受限制，
但 `src` 只是个字符串属性）：

```bash
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('iframe')].map(e=>e.src))"
```

**但「拿到 src 就去 goto」不是万能的** —— `about:blank` 动态写入的 iframe 无处可跳（C2）。
iframe 的三种形态与各自处理方式见 **§12**。

---

## 8. 响应慢导致误判「页面没内容」

**现象**：`goto` 后立刻 `eval innerText` 拿到空/极少文本，误判为 B 类（Canvas）。

**根因**：SPA 异步渲染，DOM 还没填充。

**规避**：`goto` 之后先延时再探测：

```bash
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"
```

> use `domcontentloaded` 语义即可，**不要用 `networkidle`** —— 原型页面常有长轮询/心跳请求，
> `networkidle` 会一直超时（这是原 MCP 版本的既有经验，CLI 下同样适用）。

**排查「点了没反应」**：

```bash
cd "$W" && playwright-cli console          # 看 JS 报错
cd "$W" && playwright-cli network          # 看请求失败
```

---

## 9. 中文文件名在 Windows shell 转义

**现象**：`screenshot --filename=订单列表.png` 在 Git Bash 下文件名乱码或报错。

**根因**：Git Bash / MSYS 对非 ASCII 参数的处理与 Windows 原生不一致。

**规避**：文件名用**序号 + 拼音**（`03-order-list.png`），中文名登记在
`prototype-analysis.md` 的页面清单表格里。这样文件名可移植、可排序，中文可读性不丢。

---

## 10. 不加 `--raw` 导致回执混入代码块

**现象**：`eval` 的 stdout 除了结果值，还跟着 `### Ran Playwright code` + JS 代码块，
Agent 解析时容易把代码块当内容读进来。

**根因**：默认输出模式面向人类阅读，会回显等价 Playwright 代码。**实测对比**：

```
# 不加 --raw
### Result
"Example Domain"
### Ran Playwright code
```js
await page.evaluate('() => document.title');
```

# 加 --raw
"Example Domain"
```

**规避**：所有「取值」命令一律加 `--raw`。

| 场景 | 用哪个 |
|---|---|
| `eval` / `find` 取页面内容 | **`--raw`** |
| 判断会话残留 / 命令失败 | **`--json`**（有 `browsers` / `isError` 字段） |
| 动作类命令（`open` / `click` / `close`） | 默认即可 |

---

## 11. 前置拦截页（反诈提醒 / 免责声明）

**现象**：`open` 后探测到 `text` 有内容（如 202 字符），但**全是声明条款**，
找不到任何原型画面；URL 变成 `/jump?go=...` 之类。

**根因**：托管平台在原型前插了一层拦截页，必须点掉才能进入。
实测样本 —— 产品大牛 `u.pmdaniu.com/nx90R`：

```
⚠️ 反诈提醒 / 📄 声明 / 知道了, 进入查看
```

**规避**：`snapshot` → 找按钮（文案常见「知道了」「进入查看」「我同意」「继续」）
→ `click <ref>` → 延时 → **重新探测**。可能有多层，循环到 URL 稳定。

```bash
cd "$W" && playwright-cli snapshot --filename=gate.yml && cat "$W/gate.yml"
cd "$W" && playwright-cli click <button ref>
cd "$W" && playwright-cli --raw eval "() => location.href"      # 确认已跳离拦截页
```

> **识别信号**：URL 含 `/jump?go=`、`/verify`、`/notice`；页面文本含
> 「声明」「提醒」「同意」「进入查看」。**不处理就会把声明文字当成需求分析输入。**

---

## 12. iframe 三种形态，处理方式完全不同

**现象**：探测到 `iframe: 1` 就去读 `src` 并 `goto`，但要么跳到 `about:blank` 发呆，
要么跳过去了却丢了左侧页面清单。

**根因**：iframe 分三种，`src` 与同源性决定打法（详见 SKILL.md Step 2.1 / 2.2）：

| 子类 | `src` | 同源 | 处理 |
|---|---|---|---|
| **C1 可跳转** | 真实 URL | 无关 | 读 `src` → `goto` → 重新探测 |
| **C2 动态写入** | `about:blank` | 是 | `goto` 无处可去 → 读 `contentDocument` |
| **C3 跨域** | 真实 URL | **否** | `contentDocument` 为 **`null`** → 用 `snapshot`/`find` 穿透 |

**实测：跨域时 `contentDocument` 返回 `null`（不抛异常）** ——

```bash
# 不能只看 !!f.contentDocument 就以为没内容，跨域是静默 null
cd "$W" && playwright-cli --raw eval "() => { const f=document.querySelectorAll('iframe')[0]; try { return JSON.stringify({sameOrigin: !!f.contentDocument, src: f.src}) } catch(e) { return 'BLOCKED' } }"
```

**关键结论：`snapshot` 与 `find` 会穿透 iframe，跨域也能穿透** ——

```bash
# 跨域 iframe 的节点照样出现在快照里，ref 带 f 前缀
cd "$W" && playwright-cli snapshot --filename=xo.yml && cat "$W/xo.yml"
#   - iframe [ref=e4]:
#     - generic [ref=f1e2]:
#       - heading "Example Domain" [ref=f1e3]
```

实测**跨域 iframe 内元素也能直接 `click f4e6` 成功**。所以：

> **优先用 `snapshot` + `find`**（自动穿透、无需关心同源），
> 只有需要成段取文本时才用 `contentDocument`（仅同源可用）。

**诊断 frame 结构**：

```bash
cd "$W" && playwright-cli --raw run-code "async page => JSON.stringify(page.frames().map(f=>({url:f.url(),name:f.name()})))"
```

---

## 13. Axure 播放器壳：面板默认折叠 + href 为 null + `?p=` 跳页不可靠

**现象 A**：`snapshot` 里只看到「Project Pages」一个折叠节点，**看不到任何页面名**，
误判「这个原型只有一页」。

**现象 B**：读到 `a.sitemapPageLink` 想用 `href` 跳页，拿到的全是 `null`。

**现象 C**：用 `?p=<页面名>` URL 跳页，结果**又回到反诈拦截页**，点掉后 `p` 参数丢失、
回到第 1 页（实测 v0.1.19 / 产品大牛）。

**根因**：Axure 播放器的页面树**默认折叠**；跳转由 JS 处理（`href` 不落 DOM）；
`?p=` 参数只在**同一次会话内**被 Axure 使用，重新走托管平台的 `/jump?go=` 入口会被丢弃。

实测样本 —— 产品大牛托管的 7 页原型：

```bash
# 折叠时：只有「Project Pages」组名，没有页面
- generic "Project Pages" [ref=f1e9]:
  - generic "Project Pages" [ref=f1e12] [cursor=pointer]     # ← 这才是展开按钮
  - generic [ref=f1e13]:
    - generic [ref=f1e14]: 更新日志
    - generic [ref=f1e15]: (1 of 7)                          # ← 总页数线索
```

**规避**：

```bash
# ① 点开 Project Pages 面板（不点开会漏掉全部页面）
cd "$W" && playwright-cli click <f1e12 这类面板标题 ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 2000))"

# ② 一次取全页面名
cd "$W" && playwright-cli --raw eval "() => JSON.stringify([...document.querySelectorAll('#sitemapTreeContainer .sitemapPageName')].map(e=>e.innerText))"

# ③ 跳页：click 页面名的 ref（唯一可靠方式）
cd "$W" && playwright-cli click <第 N 个页面名的 ref>
cd "$W" && playwright-cli --raw eval "() => new Promise(r => setTimeout(r, 3000))"
```

> **校验总页数**：壳文本里的 `(N of M)` 给出 M —— 取到的页面清单不足 M 个就是漏了。
> **每次跳页后面板可能重新折叠** —— 取清单前先确认展开状态。
> **其他托管平台**（墨刀 / 蓝湖等）结构不同但套路一致：先找页面树容器，再找页面名节点。
> 认不出特征时退回通用遍历，**不要硬套 Axure 选择器**。

---

## 速查：症状 → 对策

| 症状 | 最可能原因 | 对策 |
|---|---|---|
| `Browser 'default' is not open` | CWD 变了 | 所有命令加 `cd <workDir> &&` |
| `SyntaxError: Unexpected token 'var'` | eval 写法 | 改 `"() => ..."` 箭头函数 |
| 回执里混着 JS 代码块 | 没加 `--raw` | 取值命令加 `--raw` |
| 快照「是空的」 | 落文件了 | `cat` 出来看；注意 `--filename` 落 CWD 根 |
| `--filename` 指定的文件找不到 | 落 CWD 根而非 `.playwright-cli/` | 去 `<workDir>/` 根目录找 |
| 抓到全是「声明/提醒」文字 | **前置拦截页没点掉** | `snapshot` 找按钮点掉，见 §11 |
| `goto` iframe src 跳到 `about:blank` | **C2 动态写入** | 改读 `contentDocument`，见 §12 |
| `contentDocument` 是 `null` | **C3 跨域** | 用 `snapshot`/`find` 穿透，见 §12 |
| 找不到页面清单 / 只有 1 页 | **Axure 面板折叠** | 先点开 Project Pages，见 §13 |
| `a.sitemapPageLink` 的 href 全 null | Axure 用 JS 跳转 | 用 click 页面名 ref，见 §13 |
| `?p=` URL 跳页后回到第 1 页 / 又见拦截页 | 参数被 `/jump` 入口丢弃 | 改用 click 页面名 ref，见 §13 |
| `Browser is already in use` | profile 被残留进程锁 | `kill-all` 后重试 |
| session 拒绝执行 / 提示重开 | client-daemon 版本错配 | `kill-all` → `open` |
| 内存暴涨 / 进程堆积 | daemon 残留 | `kill-all`，养成收尾习惯 |
| 页面文本极少 | 异步未渲染 or Canvas | 先延时再探测；仍少则用 `find` 验证是否真有可读文本 |
| `find "A\|B"` 匹配不到 | 默认是字面量子串，不是正则 | 多关键词加 `--regex` |
