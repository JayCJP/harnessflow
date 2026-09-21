# 排查手册

> 症状 → 根因 → 对策。**命令已全部封装进 `scripts/`**，本文件只解释「为什么」，
> 供理解脚本行为与判断异常时用。
>
> 命令层面的实测结论写在对应模块的头部注释里：
> `scripts/runner.js`（子进程调用）、`scripts/probe.js`（判定逻辑）、`scripts/collect.js`（采集与收尾）。

## 速查：症状 → 对策

| 症状 | 最可能原因 | 对策 |
|---|---|---|
| `Browser 'default' is not open` | 命令的 CWD 与 open 时不一致 | 脚本已固定 CWD；手拼命令时每条都要 `cd <同一目录> &&` |
| 中文参数报「不是内部或外部命令」 | cmd 未切 UTF-8 代码页 | 脚本已带 `chcp 65001`；手拼时不要省 |
| 参数里的 `"` 让 cmd 提前截断 | 用了 `\"` 转义（cmd 不认） | cmd 的正确转义是重复双引号 `""`；脚本已处理 |
| 回执里混着 JS 代码块 | 取值命令没加 `--raw` | 取值统一加 `--raw`（脚本内部已统一） |
| `--filename` 指定的文件找不到 | 落 CWD 根而非 `.playwright-cli/` | 去 `<workDir>/` 根目录找 |
| 抓到全是「声明/提醒」文字 | **前置拦截页没点掉** | 脚本有拦截页循环；手工排查见下「拦截页」 |
| `goto` iframe src 跳到 `about:blank` | **C2 动态写入** | 改用 `contentDocument` 或 snapshot/find 穿透 |
| `contentDocument` 是 `null` | **C3 跨域** | 用 snapshot/find 穿透（跨域也穿透） |
| 找不到页面清单 / 只有 1 页 | **Axure 面板默认折叠** | 先点开 Project Pages 面板 |
| **比平台声明的页数多 1，末页内容与上页重复** | 页面名选择器串到了左下「页面/图层」面板 | 选择器要限定在页面树容器内，见下「幽灵页」 |
| 翻页后回到第 1 页 / 又见拦截页 | 用了 `?p=` URL 跳页（参数被 `/jump` 丢弃） | 只能 click 页面名的 ref |
| `Browser is already in use` | profile 被残留进程锁 | 跑 `capture.js finish`（含 kill-all） |
| session 拒绝执行 / 提示重开 | client-daemon 版本错配 | `kill-all` 后重新 open |
| 内存暴涨 / 进程堆积 | daemon 残留 | 见下「daemon 残留」 |
| 说明面板 `innerText` 取到空 | 面板 `display:none` | 改用 `textContent`（脚本已用） |
| `find "A\|B"` 匹配不到 | 默认是字面量子串，不是正则 | 多关键词加 `--regex` |
| 页面只截到首屏 | 内容超出视口 | 加 `--full-page` |
| 加了 `--full-page` 还是首屏大小 | 播放器类原型文档不滚动 | 脚本已自动「量内容高 → 调高视口 → 再截」 |
| **截图里文字糊成一片** | 平台「适应画布」把画布缩到了 36% | 视口宽度要**够宽**（2560 起），且 resize 后要重新加载，见下「缩放比例」 |
| `resize` 改了宽度但缩放没变 | 平台只在**加载时**算一次自适应缩放 | resize 之后必须 `reload`（脚本已做） |
| 截图被说明面板遮住 | 面板悬浮在页面上 | 点开前后各截一张 |

## daemon 残留（最严重）

**根因**：`playwright-cli` 是 **client-daemon 架构**。daemon 用
`spawn(detached: true)` + `unref()` 启动，独立于父进程存活，持有真实浏览器实例。
若 socket 目录被清理而 daemon 仍活着，**再也无法通过 CLI 关闭它**。

**实测影响**：官方 issue 报告有主机残留 **19 个 daemon、最老存活 4 天 8 小时、
约占 14.8GB 内存**（`microsoft/playwright#42428`，已在 v1.64 部分修复）。

**脚本的保障**：`collect.finish` 做三件套（close → kill-all → `--json list` 复查），
且每个子步骤独立 try-catch（close 失败不阻止 kill-all）。
另外挂了 `process.on('exit')` 与 SIGINT/SIGTERM 双保险 ——
因为 `try-finally` 覆盖不了 `process.exit()`、信号终止、未捕获异步异常。

> Windows 下 SIGTERM 支持不完整，**`exit` 钩子是主保险，信号处理是尽力而为**。
> 异常中断后建议手动补跑一次 `node capture.js finish --work-dir <dir>`。

**排查残留**：`playwright-cli --json list` 无输出但内存异常 → `kill-all`；
仍不行则查系统进程（Windows: `Get-Process msedge,chrome`，
找 `--type=renderer` 且父进程无 CLI 关联的）。

## CWD 强绑定（最难排查的坑）

**根因**：session 注册表、socket 路径、profile 目录、`.playwright/cli.config.json`
**全部按启动时的 CWD 解析**（工作区路径做 SHA1 哈希命名空间隔离）。
换个目录执行 → 命中不同哈希 → 找不到原 session。

**脚本的保障**：`runCli` 用 `spawnSync` 的 `cwd` 选项固定工作目录，
比 shell 前缀更可靠（不受调用方 shell 状态影响）。

## 为什么不能被 node 直接跑 shim

`playwright-cli`（无扩展名）是 `#!/bin/sh` 脚本。Windows 上用
`node <该文件>` 会报 `basedir=$(dirname ...)` 语法错。
`.ps1` 同理不能 node 直跑。

**脚本的保障**：`resolveCli` 按平台优先找 `.cmd`（Windows），
用绝对路径调用 —— 因为 node 子进程的 PATH 里**没有** CLI 所在目录
（nvm 的 node 目录只在 Git Bash 的 PATH 里），裸名 spawn 会 ENOENT。

## 更新检查拖慢每次调用

**根因**：CLI 入口每次 `main()` 都 `fetch` npm registry 查更新（超时 1500ms）。

**实测**：冷缓存 **1187ms** vs 热缓存 **430ms** —— 一次抓取几十条命令，累积差数十秒。

**脚本的保障**：`runCli` 注入 `NO_UPDATE_NOTIFIER=1`，直接跳过网络往返。

## 拦截页（反诈 / 免责 / 声明）

**现象**：`open` 后探测到 `text` 有内容，但**全是声明条款**，找不到任何原型画面。

**根因**：托管平台在原型前插了一层拦截页，必须点掉才能进入。
实测样本（产品大牛）：`⚠️ 反诈提醒 / 📄 声明 / 知道了, 进入查看`。

**识别信号**：URL 含 `/jump?go=`、`/verify`、`/notice`；
页面文本含「声明」「提醒」「同意」「进入查看」。

**脚本的保障**：`handleGateLoop` 循环最多 3 轮，每轮 snapshot 找按钮 ref 后点击，
确认 URL 稳定才继续。**不处理就会把声明文字当成需求分析输入。**

## iframe 三种形态

同样是 iframe，处理方式完全不同：

| 子类 | `src` | 同源 | 处理 |
|---|---|---|---|
| **C1 可跳转** | 真实 URL | 无关 | 可 `goto` 到本体（但会丢宿主壳的页面清单） |
| **C2 动态写入** | `about:blank` / `javascript:` | 是 | `goto` 无处可去 → 读 `contentDocument` |
| **C3 跨域** | 真实 URL | **否** | `contentDocument` 为 **`null`（不抛异常，静默）** → 靠 snapshot/find 穿透 |

**关键结论**：`snapshot` 与 `find` **不受同源策略限制**，跨域 iframe 内的节点
照样出现在快照里（ref 带 `f` 前缀，如 `f1e2` / `f4e6`），且可直接点击。
嵌套深度看 ref 前缀层级。

## Axure 播放器壳的三个坑

1. **页面树面板默认折叠** —— 不点开会误判「只有一页」，且**每次跳页后可能重新折叠**。
   壳文本里的 `(N of M)` 给出总页数，可取到的清单不足 M 个就是漏了。
2. **`a.sitemapPageLink` 的 `href` 是 `null`** —— Axure 用 JS 跳转，不能靠 href。
3. **`?p=<页面名>` URL 跳页不可靠** —— 实测会重新触发 `/jump?go=` 拦截流程，
   点掉后 `p` 参数被丢弃、回到第 1 页。**只能 click 页面名的 ref。**

> 其他托管平台（墨刀 / 蓝湖等）结构不同但套路一致：先找页面树容器，再找页面名节点。
> 认不出特征时退回通用遍历，**不要硬套 Axure 选择器**。

## 幽灵页：页面数比平台声明多一页

**现象**：材料里多出一页，内容与上一页几乎完全相同（实测墨刀：多出的那页叫「页面 1」，
截图与第 4 页是同一条画板），且平台自己标的页数是 `画布（4）` 而脚本采到 5 页。

**根因**：页面名选择器**没限定在页面树容器内**。
实测墨刀左下角还有一个「页面 / 图层」面板，里面同样是画板列表，
页面项类名与右侧页面树**完全一样**：

| 位置 | 容器 | 是否算页面 |
|---|---|---|
| 左侧「画布」页面树 | `#screen_list` | ✅ 是 |
| 左下「页面 / 图层」面板 | `ul#mb-enabled-canvas-list`（在 `#canvas-scroll-list` 内） | ❌ 不是 |

裸用 `li.rn-content-item` 会同时命中两者 → 多收一个幽灵页。

**脚本的保障**：`readPageTree` 用 `treeContainer + ' ' + pageNameNode` 限域
（见 `HOST_PLATFORMS[].treeContainer`）；限域后一个都取不到时退回不限域（宁可多收不漏页）。
另外 `capture.js` 会拿 `totalPagesPattern`（墨刀 `画布（N）`）比对实际页数，
**多了少了都会写进材料的「抓取局限」**。

**人工判读**：材料「页面清单」里的页数与原型左上角 `画布（N）` 不一致时，
先怀疑幽灵页或漏页，别直接当成原型确实有那么多页。

## 截图截不全（播放器类专属）

**根因**：墨刀 / Axure / 产品大牛是**固定视高应用** ——
`document.scrollHeight == innerHeight`（**文档不滚动**），可滚动内容在**内部容器**里。
`--full-page` 只按文档滚动高度扩展，对内部容器无能为力。

**实测**（墨刀，宽 1920）：画布内容高 2111px。
默认视口 `1920×1080` 时容器仅 1032px，`--full-page` 输出仍是 **1920×1080（= 首屏）**；
视口调到 2250 后容器 2202px ≥ 2111px，整页截图完整覆盖。

**脚本的保障**：`screenshotPage` 检测到平台标记 `needsResizeForFullPage` 时，
先 `measureContentHeight` 量出内容高（试 `.rResCanvas` / `.zoom-area` / `.screen-container`），
再把视口调高 + 页头补偿（约 100px）后截图。超出视口上限时记 `screenshot_truncated` 降级项。

**画布容器自身带滚动条时**（`scrollHeight > clientHeight` 且 resize 不够）：
需滚动容器分屏截图，或就地截该元素后拼接 —— 脚本未自动处理，会记为降级项。

## 截图里文字看不清（缩放比例）

**根因**：墨刀 / Axure 等平台的分享页用「适应画布」渲染 ——
缩放比例 = **画布可用宽度 ÷ 画布原生宽度**，且**封顶 100%**。
画布可用宽度 = 视口宽度 − 平台侧边面板（实测墨刀左侧页面树 + 右侧批注栏约 **684px**）。
于是视口越窄、画布缩得越小，**文字越小**；与直觉相反，**调窄浏览器只会更糊**。

**2026-09 实测**（墨刀 `modao.cc/proto/.../sharing`，画布原生宽 1675px，同页面只改视口宽）：

| 视口宽 | 缩放 | 画布渲染宽 | 说明 |
|---|---|---|---|
| 1280 | 36% | 596px | playwright-cli 默认窗口尺寸下加载的结果，文字基本不可读 |
| 1440 | 45% | 756px | 常见「PC 设计宽」，对墨刀反而更差 |
| 1920 | 74% | 1236px | 旧默认视口 |
| 2560 | 100% | 1675px | **原生 1:1，最清晰** |
| 3840 | 100% | 1675px | 封顶，再加宽无收益只有浪费 |

高度**不影响缩放**（实测 1080 / 1440 / 2400 / 5000 缩放完全相同）；
高度只管「能截多高」，由 `screenshotPage` 按内容高自适应。

**第二个坑：缩放只在加载时算一次。** 实测先加载再 `resize`（1280 → 3200）时缩放恒为 36%，
即**光改视口宽度对截图毫无作用**。脚本因此在 `resize` 后补了一次 `reload`。

**脚本的保障**：`VIEWPORT.pc` 取 2560×1440（`constants.js` 有取值依据表），
`openAndProbe` 顺序为 `open → resize → reload → 采集`。

**判读方法**：截图上工具栏的缩放百分比就是当前比例 ——
看到「36% / 48%」说明画布被平台缩过，材料里的文字必然模糊；
「100%」才是原生尺寸。现场核验用：

```bash
node "<skill 根>/scripts/capture.js" run --url <原型链接> --work-dir <临时目录>
# 打开产出的 PNG，看右上角缩放百分比是否 100%
```

## 说明文字采集的三个陷阱

| 陷阱 | 根因 | 脚本对策 |
|---|---|---|
| 隐藏面板取到空 | `innerText` 忽略未渲染元素，`display:none` 面板返回空 | 用 **`textContent`**（不点开也能取到全文，点开只为补截图） |
| 关键词假阴性 | 面板标题不叫「说明」（可能叫「需求」「备注」「逻辑」…） | 三轮换关键词组再找；三轮全空才判「未找到说明」 |
| 说明是 Canvas 绘制 | 无 DOM 语义 | `find` 与探针均无效 → 只能截图识别，标 `notes_canvas` 降级 |

**另外**：`find` 的文本参数与 `--regex` **互斥**，只能给一个；
`find "A|B"` 默认按字面量匹配，多关键词必须显式 `--regex`。

## 中文文件名在 Windows shell 转义

**现象**：`screenshot --filename=订单列表.png` 在 Git Bash 下文件名乱码或报错。

**规避**：文件名用**序号 + 拼音**（`03-order-list.png`），中文名登记在材料的页面清单表格里。
脚本的 `toPinyin` 对纯中文名退化为 `page-NN`（保证文件安全），中文名保留在 md 里。
