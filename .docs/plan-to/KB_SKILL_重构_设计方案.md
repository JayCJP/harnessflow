# 知识库 Skill 重构方案 —— 从「固定目录」到「统一概念 + 项目实际」

> 状态：设计稿（未实现）
> 目标：知识库初始化时，不再套用硬编码的客服业务域目录，而是「统一的概念框架」+「结合目标项目实际情况动态生成目录」
> 关联：`skills/kb-init/`、`kb-query/`、`kb-update/`、`gen-project-docs/`

---

## 〇、背景：当前插件项目知识库 Skill 的现状

当前 harness 插件（`plugins/harness/skills/`）里，围绕「知识库」有 **4 个 skill**，构成一条完整链路：

### 0.0 四个 skill 的分工

| Skill | 定位 | 触发词 | 核心产物 |
|-------|------|--------|---------|
| **kb-init** | 初始化知识库目录骨架 | 初始化知识库、kb-init | 目录结构 + `meta.yaml` 索引 + 文档模板 |
| **gen-project-docs** | 填充文档内容 | 生成知识库文档、gen-docs | 按域扫描源码生成 8 类文档 |
| **kb-update** | 增量更新 | 更新知识库、kb-update | git diff 定位变更域，增量更新文档 |
| **kb-query** | 检索消费 | （开发/改 bug 时自动触发） | 三层渐进式检索，返回知识 |

### 0.1 四个 skill 的协作关系

```
                    ┌─────────────────────────────────────────┐
                    │            知识库生命周期                │
                    └─────────────────────────────────────────┘

  首次初始化           日常开发               任务完成后
  ┌──────────┐      ┌──────────┐          ┌──────────┐
  │ kb-init  │ ───► │ kb-query │ ◄────────│ kb-update │
  │ 建骨架    │      │ 检索消费  │          │ 增量更新   │
  └────┬─────┘      └──────────┘          └────┬─────┘
       │                                       │
       ▼                                       ▼
  ┌───────────────┐                   ┌──────────────────┐
  │ gen-project-  │                   │ gen-project-docs │
  │ docs (首次填充)│                   │ (增量模式，被调用) │
  └───────────────┘                   └──────────────────┘
```

### 0.2 四个 skill 的「设计哲学」

每个 skill 都声明了「自包含 + 数据驱动 + AI 负责认知、脚本负责执行」：

- **kb-init**：脚本 `kb-init.cjs` 建目录（确定性），AI 生成 overview/meta.yaml（认知）
- **gen-project-docs**：脚本 `gen-docs.cjs` 收集文件清单（确定性），AI 生成文档内容（认知）
- **kb-update**：脚本 `kb-update.cjs` git diff + 域匹配（确定性），AI 增量更新文档（认知）
- **kb-query**：纯 AI 认知，三层渐进式检索

**理想是「数据驱动、不硬编码」，但实际代码里却处处硬编码了客服前端的实例**——这正是本方案要修的核心矛盾。

### 0.3 四个 skill 的硬编码点全景（共 10 处）

| # | 硬编码点 | 位置 | 问题 |
|---|---------|------|------|
| 1 | `DOMAINS = ['chat','group-chat','ticket','settings','voice','permission','data']` | `kb-init.cjs:21` | 客服业务域写死，套到任何项目都生成这 7 个域 |
| 2 | `KB_ROOT = '.docs/llm-knowledge/frontend'` | `kb-init.cjs:19` | 硬编码 `frontend` 层，假设所有项目都是前端 |
| 3 | `common/{conventions,lib_usage,tech}` 三目录 | `kb-init.cjs:26-28` | 前端导向的通用分类，插件/后端项目不适用 |
| 4 | `KB_ROOT = '.docs/llm-knowledge/frontend'` | `gen-docs.cjs:18` | 同上，`frontend` 写死 |
| 5 | `SRC_ROOT = 'src'` + `src/store/` + `src/api/` | `gen-docs.cjs:20,75-76` | 前端目录约定，插件项目源码在 `plugins/` 下 |
| 6 | 「8 类文档」固定表（overview/pages/api/store/architecture/config/pitfalls/log） | `gen-project-docs/SKILL.md` | pages/store/api 是前端特有切面 |
| 7 | `KB_ROOT = '.docs/llm-knowledge/frontend'` | `kb-update.cjs:17` | 同上，`frontend` 写死 |
| 8 | 域字段硬编码 `entry_files/stores/apis/components` | `kb-update.cjs:37,48-61` | 前端字段，插件项目是 entry-files/schemas/commands |
| 9 | `.docs/llm-knowledge/frontend/` 路径写死 | `kb-query/SKILL.md:41,49` | 检索端也耦合了 `frontend` 路径 |
| 10 | 域识别规则写死（`src/views/pc/chat.vue → chat`） | `kb-init/SKILL.md:56-61` | 用客服项目的具体路径做推断，不通用 |

### 0.4 已发生过的实际后果

上一轮在 harness 插件仓库（本项目）初始化知识库时，`kb-init.cjs` 生成的客服业务域完全不适配，被迫**手动**建了 `business/{agents, commands, scripts-core, scripts-commands, scripts-hooks, schemas, skills, experience}` 这 8 个自定义域。这证明：**固定目录无法服务非客服/非前端项目**。

---

## 一、问题诊断（归纳）

核心矛盾：**四个 skill 的「设计哲学」都宣称「数据驱动、不硬编码」，但「实现代码」却把「客服前端」这个具体项目的实例，当成了「所有项目」的通用框架**。

具体表现在三层：
1. **域列表硬编码**（kb-init 的 DOMAINS）
2. **路径硬编码**（`frontend` 层、`src/` 根、`src/store/`、`src/api/`）
3. **文档类型硬编码**（8 类文档里的 pages/store/api 前端切面）

---

## 二、核心命题

> **把知识库的「骨架」和「血肉」分离。**
> 骨架（统一概念框架）是固定的抽象层：任何项目都遵循同一套"域-文档-索引"三元模型。
> 血肉（项目实际结构）是动态生成的实例层：域列表、文档类型、路径规则由目标项目的真实情况推导。

一句话：**框架是统一的，目录是项目自己的。**

---

## 二.5、重构边界（改什么、不改什么）

> **重要约束：kb-query 的「分层检索」概念保持不变。**

本次重构**只动「知识库如何生成」**，**不动「知识库如何被检索」**。边界如下：

| 维度 | 是否改变 | 说明 |
|------|---------|------|
| 目录生成（域列表） | ✅ 改 | 硬编码 DOMAINS → 项目画像 + 自动扫描 |
| 文档类型（8 类 → 按项目类型） | ✅ 改 | 前端切面 pages/store/api 改为按 project_type 选择 |
| 路径（frontend / src/） | ✅ 改 | 去掉 frontend 硬编码层，源码根改为画像配置 |
| **分层检索（L1 overview → L2 meta.yaml → L3 按需加载）** | ❌ **不变** | 渐进式加载的概念和三层结构完全保留 |
| **检索模式（需求拆解/技术方案/接口搜索/知识问答）** | ❌ **不变** | 4 种模式的触发和加载逻辑不变 |
| **双源交叉验证（kb-query ∥ graphify）** | ❌ **不变** | 检索端的收敛规则不变 |

**分层检索"概念不变"的具体含义**：

kb-query 的核心价值是「渐进式分层加载」——L1 先读 overview 定位域、L2 读 meta.yaml 精确筛选、L3 按模式按需加载文档，避免一次全量加载。这个**概念和三层结构不因重构而变**。

重构只影响它的**数据来源**：
- L1 读的 `overview.md` 路径：`.docs/llm-knowledge/frontend/overview.md` → `.docs/llm-knowledge/overview.md`（去掉 frontend 层）
- L2 读的 `meta.yaml` 里的域/字段：从前端字段（entry_files/stores/apis）→ 各项目类型自有的字段
- L3 加载的文档类型：从固定 8 类 → 按 project_type 的文档集

**检索的「动作」（怎么分层、怎么渐进、怎么交叉验证）一个字不改**，只改「数据在哪、字段叫什么」。

---

## 三、统一概念框架（固定的抽象层）

### 2.1 三元模型（任何项目通用）

```
知识库 = 域集合（domains）
每个域 = 文档集合（documents）
每份文档 = 一个知识切面（aspect）
```

### 2.2 域的通用语义（不绑定具体业务）

域（domain）是知识库的第一层划分，其语义是**「一组内聚的代码/功能的集合」**，但**划分依据由项目类型决定**：

| 项目类型 | 域的划分依据 | 示例 |
|---------|------------|------|
| 前端业务项目 | 业务模块 | chat / ticket / settings |
| 插件/工具项目 | 功能模块 | agents / commands / scripts / skills |
| 后端服务 | 服务/领域 | order / user / payment |
| 库/SDK | 功能包 | core / utils / io |

### 2.3 文档类型的通用语义（不绑定 pages/store/api）

文档类型（aspect）是域的切面，**由「代码的结构维度」决定**，而非固定 8 类：

| 通用维度 | 前端项目实例 | 插件项目实例 | 后端项目实例 |
|---------|------------|------------|------------|
| 总览 | overview.md | overview.md | overview.md |
| 结构/入口 | pages.md（页面） | entry-files.md（入口脚本） | routes.md（路由） |
| 数据/状态 | store.md（状态管理） | schemas.md（schema 定义） | models.md（数据模型） |
| 接口/能力 | api.md（接口） | commands.md（命令） | api.md（接口） |
| 架构 | architecture.md | architecture.md | architecture.md |
| 配置 | config.md | config.md | config.md |
| 踩坑 | pitfalls.md | pitfalls.md | pitfalls.md |
| 变更日志 | log.md | log.md | log.md |

**关键洞察**：`overview / architecture / config / pitfalls / log` 是**所有项目通用的切面**（5 类），而 `pages/store/api` 这类是**前端特有的切面**，对插件项目应替换为 `entry-files/schemas/commands` 等。

---

## 四、项目实际结构（动态生成的实例层）

### 3.1 项目画像（Project Profile）

kb-init 第一步不是建目录，而是**生成项目画像**，作为后续所有步骤的输入：

```yaml
# .docs/llm-knowledge/.profile.yaml（新概念：项目画像）
project_type: "plugin"          # frontend | backend | plugin | library | ...
tech_stack: ["nodejs", "vue3"]  # 从 package.json / 目录结构推断
source_root: "plugins/harness"  # 源码根（不再是写死的 src/）
domain_axis: "feature"          # 域划分依据：feature | business | service | package
```

### 3.2 域识别（数据驱动，替代硬编码 DOMAINS）

不再写死 `['chat', 'ticket', ...]`，而是根据 `project_type` 用**通用启发式**扫描：

| project_type | 域识别启发式 |
|-------------|------------|
| frontend | 扫描 `src/views/**` 的一级子目录 → 业务域 |
| plugin | 扫描 skill/agent/command 目录的一级子目录 → 功能模块 |
| backend | 扫描 `src/**/` 的 service/domain 目录 |
| library | 扫描包的一级导出模块 |

> 之前 harness 仓库手动建的 `agents/commands/scripts-core/...` 8 个域，正是 `plugin` 类型下「扫描功能模块」的自然结果。方案要把它变成**自动的**。

### 3.3 文档类型模板（按 project_type 选择，替代固定 8 类）

kb-init 内置**多套文档模板**，按项目类型选择：

```
templates/
├── frontend/     # pages.md / store.md / api.md / ...
├── plugin/       # entry-files.md / schemas.md / commands.md / ...
├── backend/      # routes.md / models.md / api.md / ...
└── library/      # public-api.md / usage.md / ...
```

`project_type` 决定用哪套模板，`tech_stack` 决定模板内部的框架细节（Vue vs React）。

---

## 五、改造方案（分文件落地）

### 4.1 kb-init.cjs 改造（消除硬编码 DOMAINS）

**改前**：
```js
const DOMAINS = ['chat', 'group-chat', 'ticket', 'settings', 'voice', 'permission', 'data']
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge', 'frontend')
```

**改后**：
```js
// 1. 读项目画像（无则先生成）
const profile = loadProjectProfile(PROJECT_ROOT)  // project_type / source_root / domain_axis

// 2. 根据 project_type 扫描真实域（不再硬编码）
const domains = discoverDomains(profile)  // 返回真实目录/模块名列表

// 3. 文档类型模板按 project_type 选择
const docTemplates = selectTemplates(profile.project_type)  // 不再固定 8 类

// 4. KB_ROOT 去掉 frontend 硬编码层
const KB_ROOT = path.join(PROJECT_ROOT, '.docs', 'llm-knowledge')
```

### 4.2 kb-query / kb-update / gen-project-docs 同步改造

| skill | 改造点 |
|-------|--------|
| kb-query | 路径 `.docs/llm-knowledge/frontend/` → `.docs/llm-knowledge/`，域和文档类型从 meta.yaml 动态读 |
| kb-update | 域匹配不再假设 `entry_files/stores/apis/components`，改为 meta.yaml 里各项目类型自有的字段 |
| gen-project-docs | 「8 类文档」→ 按 project_type 的模板集生成 |

### 4.3 meta.yaml 结构扩展

```yaml
# 新增顶层字段，替代硬编码假设
profile:
  project_type: "plugin"
  source_root: "plugins/harness"
  domain_axis: "feature"

domains:
  - id: "scripts-core"
    path: "business/scripts-core/"
    entry_files: ["scripts/lib/state.js", "scripts/lib/trace.js"]  # 各类型自有的字段
    # 不再强制 stores/apis/components

doc_types:  # 本项目实际启用的文档类型（来自模板选择）
  - overview
  - entry-files
  - schemas
  - commands
  - architecture
  - pitfalls
```

---

## 六、与现有资产的关系

| 资产 | 关系 |
|------|------|
| 已建好的 harness 定制知识库 | 是 `plugin` 项目类型的一个实例，方案落地后可用 kb-init 自动重建（而非手动） |
| kb-query 的**分层检索概念（L1/L2/L3）** | **完全不变**：渐进式加载的三层结构、4 种检索模式、双源交叉验证，一个字不改；只改它的数据来源（去 frontend 路径、meta.yaml 字段按项目类型） |
| kb-update 的 git diff 域匹配 | 匹配字段从 meta.yaml 的 profile 动态取，不再假设前端字段 |
| gen-project-docs 的增量更新 | 「8 类文档」改为「profile 决定的文档类型集」 |
| failure-patterns / metrics-insights | 无关，知识库是另一套体系 |

---

## 七、落地优先级

| 阶段 | 内容 | 理由 |
|------|------|------|
| K0 | 引入「项目画像」概念（.profile.yaml 或 meta.yaml 的 profile 块） | 一切动态化的输入 |
| K1 | kb-init.cjs 消除硬编码 DOMAINS，改为 discoverDomains 扫描 | 核心修复 |
| K2 | 文档模板按 project_type 分套（frontend/plugin/backend/library） | 消除「固定 8 类」 |
| K3 | kb-query/kb-update/gen-project-docs 去 frontend 硬编码路径 | 消费端同步 |
| K4 | 用 harness 仓库 + 一个前端项目各跑一遍 kb-init 验证 | 验证通用性 |

---

## 八、风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 项目画像推断不准（project_type 判错） | 中 | 画像支持手动覆盖；判错时提示用户确认 |
| 域自动扫描漏掉/多扫域 | 中 | 扫描结果先展示给用户确认，再落盘 |
| 已有项目（客服/harness）迁移兼容 | 中 | 旧的 meta.yaml 无 profile 字段时，默认按 frontend 兼容读取 |
| 文档模板维护成本上升（多套模板） | 低 | 先做 frontend + plugin 两套，backend/library 按需补 |

---

## 九、核心结论

当前知识库 skill 的根因是**把「客服前端的实例」当成了「通用框架」**——`DOMAINS` 写死客服域、`frontend` 路径写死、8 类文档写死前端切面。

重构的核心是**分离骨架与血肉**：
- **骨架（统一概念）**：域-文档-索引三元模型 + 5 类通用切面（overview/architecture/config/pitfalls/log）+ **分层检索概念（L1/L2/L3）**
- **血肉（项目实际）**：域列表、文档类型、路径规则，由「项目画像 + 自动扫描」动态生成

**重构范围的一句话总结**：只改「知识库如何生成」（目录、域、文档类型、路径），**不改「知识库如何检索」**（L1/L2/L3 分层检索、4 种模式、双源交叉验证全部保留）。

这样，初始化任何类型的项目（前端/后端/插件/库），都遵循同一套概念框架，生成的是该项目的真实目录，而检索端的分层加载概念稳定不变。
