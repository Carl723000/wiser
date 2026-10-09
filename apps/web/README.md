---
title: WISER Web component guide
docType: component-guide
scope: apps/web
status: active
authoritative: true
owner: wiser
language: bilingual
whenToUse:
  - when running or changing the shared WISER product frontend
whenToUpdate:
  - when Web routes, identity, read models, locales, themes, or verification changes
checkPaths:
  - apps/web/**
  - apps/api/src/platform/**
  - apps/api/src/v2-*
  - apps/api/src/data-foundation/**
lastReviewedAt: 2026-10-09
lastReviewedCommit: a32ad00c148bc1de08b18cfa168e0ee9952784e2
---

# WISER Web / 产品界面

证据档案首层保留业务事实、缺项、使用条件和原文入口，完整技术标识按需展开；资料卡突出来源单位与审核状态。 / Evidence dossiers keep business facts, limits, conditions of use and original access visible; full technical references are disclosed on demand. Result cards identify providers and review state.

空间查阅的单区布局覆盖1100 px及以下宽度和500 px及以下高度。WebGL手势后的复位、隐藏区往返和全屏不受旧容器事件回写；同一资料的具体位置和固定几何版本保持一致。 / Single-pane spatial reading covers widths up to 1100 px and heights up to 500 px. Reset, hidden-pane return and fullscreen after WebGL gestures do not accept obsolete resize camera updates; exact position and pinned geometry versions are retained.

`apps/web` 是 WISER Portal、数据基座与智能体演练场共用的产品网页。中文是默认语言：`/` 跳转至 `/zh-CN`，英文入口为 `/en`。Portal 与登录页公开；业务工作区依照当前登录账号和项目权限展示。 / `apps/web` serves the Portal, Data Foundation, and Agent EXCON. Chinese is the default language, and business workspaces show only what the signed-in account may access.

## 用户从哪里开始 / Where users start

| 任务 / Task                                | 中文入口                 | English entry         |
| ------------------------------------------ | ------------------------ | --------------------- |
| 了解 WISER / Learn about WISER             | `/zh-CN`                 | `/en`                 |
| 登录 / Sign in                             | `/zh-CN/login`           | `/en/login`           |
| 查阅和管理项目访问 / Review project access | `/zh-CN/account/access`  | `/en/account/access`  |
| 探索资料、记录与地图 / Explore data        | `/zh-CN/data-foundation` | `/en/data-foundation` |
| 查看演练场景 / Browse scenarios            | `/zh-CN/scenarios`       | `/en/scenarios`       |
| 查看演练运行 / Review exercise runs        | `/zh-CN/runs`            | `/en/runs`            |

数据基座还有目录、接入任务、质量、检索、知识、关系、地图与数据操作工作区。演练运行可查看概览、协作、评测、追踪与回放。所有页面按当前项目和资料权限重新读取数据。 / Data Foundation also has catalog, intake, quality, search, knowledge, relation, map, and operation workspaces. A run offers overview, collaboration, evaluation, trace, and replay. Reads are scoped to the current project and permissions.

Portal 提供“让智能体接入 WISER”的设置复制入口；复制指令本身不授予权限。参见[智能体接入](../docs/src/content/docs/zh-CN/protocols/agent-setup.md) / [Agent setup](../docs/src/content/docs/en/protocols/agent-setup.md)。

## 运行 / Run

从仓库根目录安装依赖，再启动网页： / Install dependencies from the repository root, then start the web app:

```bash
pnpm install --frozen-lockfile
pnpm --filter @wiser/web dev
```

默认地址为 `http://127.0.0.1:3100`。完整的登录和数据服务本机体验见[快速开始](../docs/src/content/docs/zh-CN/quick-start.md) / [Quick start](../docs/src/content/docs/en/quick-start.md)。单独预览演练界面及所需配置见[前端开发](../docs/src/content/docs/zh-CN/development/frontend.md) / [Frontend development](../docs/src/content/docs/en/development/frontend.md)。

## 实现边界 / Implementation boundary

- 登录、会话续期和退出由 Supabase Auth 处理。受保护的业务路由需要已验证会话；仅本机参考预览可关闭认证。 / Supabase Auth handles sign-in and sessions. Protected workspaces require a verified session; Auth-off is for local reference preview only.
- 数据基座的浏览器请求经 Next.js 服务端转发至 HTTP API；资料原件、项目权限和查询结果由服务端重新核验。 / Data Foundation reads pass through the server-side HTTP API and are reauthorized for each scope.
- 演练场既可在本机展示参考数据，也可读取已授权的运行状态；会话或权限失效时不会自动切换为参考数据。 / EXCON supports local reference data and authorized live reads. A lost live session never switches to reference data.
- 可见文案统一维护在 `src/lib/i18n.ts` 的中英文词典。页面使用共享设计语义、键盘交互、响应式布局与明暗主题。 / Both locale dictionaries own visible copy; the shared design system covers interaction, responsive layout, and themes.

具体身份与交互规则见[统一身份](../docs/src/content/docs/zh-CN/architecture/unified-auth.md)、[产品体验](../docs/src/content/docs/zh-CN/development/product-experience.md)及对应英文页。 / See the matching English [identity](../docs/src/content/docs/en/architecture/unified-auth.md) and [product experience](../docs/src/content/docs/en/development/product-experience.md) guides.

## 验证 / Verify

```bash
pnpm --filter @wiser/web test
pnpm --filter @wiser/web typecheck
pnpm --filter @wiser/web build
pnpm --filter @wiser/web test:e2e
```

仓库交付前还须运行 `pnpm verify` 及 Docpact 检查；需要真实数据库或浏览器环境的检查见[测试与验证](../docs/src/content/docs/zh-CN/development/testing.md) / [Testing and verification](../docs/src/content/docs/en/development/testing.md)。

## 本机空间资料工作台 / Local spatial workbench

`/{locale}/data-foundation/spatial-workspace` 未携带候选查询时，仅在显式本机开发模式下读取已核对的资料包，不作为正式Data API失败时的替代。空间证据、就绪／合成复核和遥感检查在同一界面，复用固定版本回查、双窗、场景恢复和全屏。 / Without candidate navigation, this explicitly enabled local-only workspace reads a validated pack, never substitutes fixtures for failed production Data reads, and shares exact-source, comparison, saved-scene and fullscreen interactions.

阅读链接保留轨道、区域、需求、日期角色、月／日范围、页签及固定来源／记录／具体位置，刷新与返回时复核当前可显示输入；不完整或失效的链接显示恢复操作。地图与矩阵共用受控范围，精确日条件须明确切换后才核对月覆盖；合成演练不写入真实阅读链接。旧裸工作台入口仍打开真实总览，旧不完整记录／来源链接需重新选择。 / Private reading URLs restore track, region, need, date role, month/day scope, tabs and exact source/record/position pins against current displayable input. Invalid links show recovery actions; controlled map/matrix state prevents hidden-pane rewrites. Day-filtered coverage requires an explicit month-window choice. Exercises remain separate, bare workspace links retain the REAL overview, and incomplete old source/record links require selection again.

可选的公共地理参照由两份固定哈希OSM GeoJSON独立提供：四区行政面／永定河线与五条端点补证参考河线。地图内各有开关，并保留许可、来源哈希和未核实边界说明；它们不增加业务记录或已定位数。绝对路径配置与固定哈希见[前端开发](../docs/src/content/docs/zh-CN/development/frontend.md#本地多流域资料工作台)。 / Optional hash-pinned OSM reference files supply separate administrative, watercourse and endpoint-evidence layers. Their controls and license/hash details do not add business records or verified locations. See [Frontend development](../docs/src/content/docs/en/development/frontend.md#local-multi-region-material-workspace) for local paths and fixed hashes.

配置见[前端开发](../docs/src/content/docs/zh-CN/development/frontend.md#本地多流域资料工作台)。额外验收使用 `pnpm --filter @wiser/web exec playwright test --config playwright.spatial.config.ts`，连接已启动的回环3410预览，不自行启动整套服务。真实Auth、Data API、OAuth和Worker集成另行验证。 / This browser suite connects to an already running loopback3410 preview. Real Auth, Data API, OAuth and Worker integration remains separate.

宽度不超过1100 px或高度不超过500 px时，在地图、结果与证据之间切换单区查阅，保留选择、视角、固定来源和已加载结果；桌面布局保留。 / At widths up to 1100 px or heights up to 500 px, one Map, Results or Evidence pane is visible while selection, camera, fixed sources and loaded results remain intact. Desktop retains its concurrent layout.

就绪九问按实际事实类型展开，再选择记录或固定来源；可选的固定哈希补充依据沿用本机回环准入，发布月份与采样时点分开，待审对应只用于假设。真实账号、持久候选和标准入库另行验收。 / Readiness opens actual typed facts before a reader chooses a record or fixed source. Optional hash-pinned supplements retain the local gate; publication months stay separate from sampling dates and pending correspondences stay hypothetical. Authenticated and persistent workflows require separate acceptance.

结果按已定位、位置未确定和范围外分别分页，每页40条；表格保留原时间、原值、来源及位置角色，选择记录进入固定证据。页面切换和全屏往返保留当前阅读页，筛选改变后回到首组；这不等于持久保存或真实账号验收。 / Results page located, unresolved and outside-extent records independently in 40-row tables. Original time, values, sources and location roles remain distinct, and selecting a record opens fixed evidence. Pane/fullscreen transitions retain the current page; changed filters reset it. Durable storage and authenticated acceptance remain separate.

## 候选资料查阅 / Candidate material reading

当前接收详情可将完整候选链接到同一空间工作台。服务端核当前会话、项目范围和仍一致的候选四元，复用同一只读阅读器及现有候选／原件读取；候选已替换或拒权时不回落本地资料包。程序事实区分固定批次已知总数与当前已加载分页，显示解析规则／状态和声明字段；人工清洗、质控、密度及专业用途缺证保持未知。入口不提供保存动作，不新增已发布版本、矩阵／月份／专题投影或核心契约。 / Current intake detail links its complete candidate into the same spatial workspace. The server checks the current session, Project and matching current tuple, then reuses the readonly reader and existing candidate/original reads; denial or replacement never falls back to a local pack. Processing facts separate fixed-batch known totals from loaded pages and show parser metadata/declared fields; missing cleaning, QC, density and professional-use evidence remains unknown. This entry adds no save action, published version, matrix/month/topic projection or core contract.

已完成待审候选的接收详情以原件、记录和地图标签查阅实际固定批次，保留原值、原文定位、解析缺项及待审核状态。通过正式保存视图入口创建、读取、重开及撤回固定配置，重开和恢复重新核全部成员当前权限；拒绝清除内容。 / Intake detail reads a real fixed pending batch through Originals, Records and Map, retaining raw values, locators, incomplete parsing and review state. Service-backed fixed views support create/list/open/revoke and reauthorize all members on reopening/recovery; denied access clears content.

候选固定视图的共享范围标为“本人及获权独立审核人”；保存范围帮助说明分享不授予资料访问权限。现有`project`枚举及全部候选权限核验保持不变。 / Candidate fixed-view sharing is labelled “Me and authorized independent reviewers”; contextual help explains that sharing grants no material access. The existing `project` enum and all-member authorization remain unchanged.

候选地图复用现有组件，仅展开组合几何的绘制部分，不添加发布版本或猜测位置角色。双语、语义主题、键盘操作、窄屏表格和工作区全屏共用查阅状态。受支持的二维中心和缩放可恢复并以当前阅读位置另存新视图；不支持的相机、图层及时段配置原样保留，明确未应用，时段不筛选原记录。 / Candidate maps reuse the existing component without published identities or inferred location roles. Both locales, semantic themes, keyboard controls, narrow table panels and fullscreen share reading state. Supported planar center/zoom can be restored and current reading position saved as a new view; unsupported camera, layer and period settings remain intact and visibly unapplied, with no period filtering of raw records.

真实账号、候选持久保存、原件读取和浏览器验证需在获准运行环境另行完成，不以合成回归代替。 / Real accounts, persisted candidates, originals and browser behavior require their authorized runtime checks, not synthetic substitutes.

原生栅格面板区分固定派生TIFF与上游源产品，转换血缘尚未核验保持可见。B03／B8A标为编码值，比例与偏移未核验前不称物理反射率；自填SCL筛选标识不表示专业质量规则版本。来源、掩膜和面积依据复用问号帮助，读取及筛选行为不变。 / The native raster panel distinguishes fixed derived TIFFs from upstream source products and visibly retains unverified conversion lineage. B03/B8A remain encoded values, not physical reflectance before scale/offset verification; a user-entered SCL filter identifier is not a professional quality-rule version. Contextual help explains source, mask and area semantics without changing reading or filtering.

就绪总览提供六范围×19需求矩阵；当前展示许可、取得、解析与专业核验分别显示，点选进入相同区域与需求的九问明细。全局按集合去重，时窗记录与历史资料分列；真实待审资料不能由技术检查升级为专业批准。 / The readonly six-range by19-demand matrix separates display permission, original receipt, parsing and independent review. Cell selection shares the existing question scope; overlapping totals use a set union and current-window rows stay separate from historical inventory. Technical checks do not approve real pending materials.

月度覆盖明细新增逐月原值，复用既有分类、分组与固定引用。同月多值、未知月份、缺月、null、空文本、无水、未监测和有效零值分别保留；不推断浓度或趋势。首屏有界并支持本地展开，显示／总数不改计数口径。点选核对固定作品／版本／原件和唯一当前记录ID，引用冲突时不跳到另一来源。 / Monthly coverage details now read exact original values using existing kinds, grouping and fixed references. Multiple same-month values, unknown or missing months, null, empty text, dry, unmonitored and valid zero remain distinct. Bounded local reveal retains full counts. Selection requires a complete fixed reference and unique current record ID; ambiguity never navigates to another source. No concentration or trend is inferred.

本机空间首屏保留生效检索、图层、时间未知资料排除及矩形标签，月份与日期窗口明确区分。已显示公共参照署名在WebGL和平面画布可见，完整许可依据按需展开；查询、时间及保存契约不变。 / The local spatial first screen retains active search, layers, unknown-time exclusion and rectangle chips, distinguishes month/date windows, and keeps displayed public-reference attribution visible in both renderers. Detailed evidence remains disclosed on demand; query, time and saving contracts are unchanged.

本地规格2将“报告期”与“发布日期”“观测期”分开，沿地图、月份、阅读链接、本机场景和导出显式保存；规格1原义不变。纯候选就绪引用独立计数，不伪造已发布身份或授予访问权限。 / Local format 2 preserves Report period separately from Publication and Observation through map/month/URL/scene/export adapters. Format 1 keeps its meaning; pure candidate references retain separate counts without published identities or access grants.

已有专题可在接收页“已保存专题”中读取并重开，固定深链使用`?candidateTopic=<UUID>`，与旧`candidateView`互斥。此入口恢复完整服务端专题，不显示普通接收摘要；不可用时清空资料、标题、计数和引用。专题修改／另存、原件下载与原生影像读取暂不可用，旧视图原件授权保留。 / Existing topics can be listed and reopened from intake reading or a mutually exclusive `candidateTopic` deep link. The server-authorized complete specification remains intact; unavailability clears content, titles, counts and references. Topic editing/saving, original downloads and native raster reading remain unavailable. Legacy view-original authorization is preserved. Real Auth/HTTP and native browser acceptance remain separate from synthetic tests.

候选查阅与就绪缺口明细共用持久跟进面板，复用既有五项能力、幂等键、当前版本和服务端逐来源核权。补证可选择清单内另一真实候选，整记录更正保留明确新旧对应；技术办结与专业批准分开显示。 / Candidate reading and readiness gap details share the persistent followup panel, existing five capabilities, idempotency, current version and server source checks. Supplements can select another actual candidate in the manifest; whole-record corrections retain explicit correspondence. Technical closure and professional approval remain distinct.

候选页“关系依据”按需读取当前获权清单内的关系，分页显示主体、关系、客体和候选决定；详情固定修订及决定版本，保留原文摘录和来源定位。此入口不创建或批准关系，不自动生成流域／需求归属。 / The candidate Relationship evidence panel reads a finite authorized selection, pages subject/predicate/object and candidate decisions, and opens exact revision/decision details with source excerpts and locators. It neither creates nor approves relations or infers basin/requirement assignments.

关系证据可在同一候选内通过“查看对应记录”回到确切行；先核当前资产身份与原件哈希，沿有界分页定位。跨候选或无记录身份时保留原文依据，不推测跳转。 / Relation evidence can return to the exact row within the same candidate after current asset and original-hash verification and bounded page lookup. Cross-candidate or unidentified evidence retains its text without inferred navigation.
