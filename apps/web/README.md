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
lastReviewedAt: 2026-10-04
lastReviewedCommit: 669ef4d205ab5916aad30bc6579842d4b236ca50
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

`/{locale}/data-foundation/spatial-workspace` 仅在显式本机开发模式下读取已核对的资料包，不作为正式Data API失败时的替代。空间证据、就绪／合成复核和遥感检查在同一界面，复用固定版本回查、双窗、场景恢复和全屏。 / This explicitly enabled local-only workspace reads a validated pack, never substitutes fixtures for failed production Data reads, and shares exact-source, comparison, saved-scene and fullscreen interactions.

阅读链接保留轨道、区域、需求、日期角色、月／日范围、页签及固定来源／记录／具体位置，刷新与返回时复核当前可显示输入；不完整或失效的链接显示恢复操作。地图与矩阵共用受控范围，精确日条件须明确切换后才核对月覆盖；合成演练不写入真实阅读链接。旧裸工作台入口仍打开真实总览，旧不完整记录／来源链接需重新选择。 / Private reading URLs restore track, region, need, date role, month/day scope, tabs and exact source/record/position pins against current displayable input. Invalid links show recovery actions; controlled map/matrix state prevents hidden-pane rewrites. Day-filtered coverage requires an explicit month-window choice. Exercises remain separate, bare workspace links retain the REAL overview, and incomplete old source/record links require selection again.

可选的公共地理参照由两份固定哈希OSM GeoJSON独立提供：四区行政面／永定河线与五条端点补证参考河线。地图内各有开关，并保留许可、来源哈希和未核实边界说明；它们不增加业务记录或已定位数。绝对路径配置与固定哈希见[前端开发](../docs/src/content/docs/zh-CN/development/frontend.md#本地多流域资料工作台)。 / Optional hash-pinned OSM reference files supply separate administrative, watercourse and endpoint-evidence layers. Their controls and license/hash details do not add business records or verified locations. See [Frontend development](../docs/src/content/docs/en/development/frontend.md#local-multi-region-material-workspace) for local paths and fixed hashes.

配置见[前端开发](../docs/src/content/docs/zh-CN/development/frontend.md#本地多流域资料工作台)。额外验收使用 `pnpm --filter @wiser/web exec playwright test --config playwright.spatial.config.ts`，连接已启动的回环3410预览，不自行启动整套服务。真实Auth、Data API、OAuth和Worker集成另行验证。 / This browser suite connects to an already running loopback3410 preview. Real Auth, Data API, OAuth and Worker integration remains separate.

宽度不超过1100 px或高度不超过500 px时，在地图、结果与证据之间切换单区查阅，保留选择、视角、固定来源和已加载结果；桌面布局保留。 / At widths up to 1100 px or heights up to 500 px, one Map, Results or Evidence pane is visible while selection, camera, fixed sources and loaded results remain intact. Desktop retains its concurrent layout.

就绪九问按实际事实类型展开，再选择记录或固定来源；可选的固定哈希补充依据沿用本机回环准入，发布月份与采样时点分开，待审对应只用于假设。真实账号、持久候选和标准入库另行验收。 / Readiness opens actual typed facts before a reader chooses a record or fixed source. Optional hash-pinned supplements retain the local gate; publication months stay separate from sampling dates and pending correspondences stay hypothetical. Authenticated and persistent workflows require separate acceptance.

结果按已定位、位置未确定和范围外分别分页，每页40条；表格保留原时间、原值、来源及位置角色，选择记录进入固定证据。页面切换和全屏往返保留当前阅读页，筛选改变后回到首组；这不等于持久保存或真实账号验收。 / Results page located, unresolved and outside-extent records independently in 40-row tables. Original time, values, sources and location roles remain distinct, and selecting a record opens fixed evidence. Pane/fullscreen transitions retain the current page; changed filters reset it. Durable storage and authenticated acceptance remain separate.

## 候选资料查阅 / Candidate material reading

已完成待审候选的接收详情以原件、记录和地图标签查阅实际固定批次，保留原值、原文定位、解析缺项及待审核状态。通过正式保存视图入口创建、读取、重开及撤回固定配置，重开和恢复重新核全部成员当前权限；拒绝清除内容。 / Intake detail reads a real fixed pending batch through Originals, Records and Map, retaining raw values, locators, incomplete parsing and review state. Service-backed fixed views support create/list/open/revoke and reauthorize all members on reopening/recovery; denied access clears content.

候选地图复用现有组件，仅展开组合几何的绘制部分，不添加发布版本或猜测位置角色。双语、语义主题、键盘操作、窄屏表格和工作区全屏共用查阅状态；未应用的既有地图／时段配置明确提示。 / Candidate maps reuse the existing component without published identities or inferred location roles. Both locales, semantic themes, keyboard controls, narrow table panels and fullscreen share reading state; retained map/period settings not applied here are explicitly identified.

真实账号、候选持久保存、原件读取和浏览器验证需在获准运行环境另行完成，不以合成回归代替。 / Real accounts, persisted candidates, originals and browser behavior require their authorized runtime checks, not synthetic substitutes.

就绪总览提供六范围×19需求矩阵；当前展示许可、取得、解析与专业核验分别显示，点选进入相同区域与需求的九问明细。全局按集合去重，时窗记录与历史资料分列；真实待审资料不能由技术检查升级为专业批准。 / The readonly six-range by19-demand matrix separates display permission, original receipt, parsing and independent review. Cell selection shares the existing question scope; overlapping totals use a set union and current-window rows stay separate from historical inventory. Technical checks do not approve real pending materials.
