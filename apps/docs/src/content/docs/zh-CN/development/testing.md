---
title: 测试与完成定义
description: WISER 的 Red-Green-Refactor 循环、根验证范围、聚焦测试、集成 smoke、AI fake 边界和完成标准。
docType: workflow
scope: repository-testing
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 开始行为变更、选择验证命令或准备提交时
  - 修改数据库、浏览器流程、可观测性或 Agent 演练时
whenToUpdate:
  - 测试脚本、CI 门禁、workspace 或完成定义变化时
checkPaths:
  - package.json
  - vitest.config.ts
  - apps/*/package.json
  - apps/*/vitest.config.ts
  - apps/*/playwright.config.ts
  - apps/*/playwright.*.config.ts
  - apps/*/e2e*/**
  - tests/toolchain/*browser*.spec.ts
  - tests/toolchain/candidate-backflow-fixture.spec.ts
  - tests/toolchain/a12-candidate-load-driver.spec.ts
  - tests/toolchain/a12-candidate-load-traversal.spec.ts
  - tests/toolchain/a12-candidate-load-runner.spec.ts
  - tests/toolchain/a12-candidate-original-http.spec.ts
  - tests/toolchain/a12-standard-intake-http.spec.ts
  - tests/toolchain/a12-candidate-inventory-collector.spec.ts
  - scripts/data-foundation/**
  - infrastructure/observability/**
  - examples/agent-excon/**
  - .github/workflows/**
lastReviewedAt: 2026-10-06
lastReviewedCommit: ce4cfe5b04ae7f31c10bef4b0ad0026ef9a96411
---

## Red → Green → Refactor

行为变更从一个描述用户结果、协议保证或领域不变量的失败测试开始。

1. **Red**：写最小失败测试，实际运行并确认失败原因正是缺少目标行为，而不是 fixture、环境或拼写错误。
2. **Green**：实现让该测试通过的最小变化，并运行同一边界的回归测试。
3. **Refactor**：在测试保持全绿时整理命名、重复和依赖方向，不改变外部行为。
4. **Integrate**：根据变化类型运行真实数据库、浏览器、可观测性或纵向 smoke。
5. **Document and commit**：更新中英文文档；每个提交前运行 worktree Docpact check，分支交接前再对 merge base 运行 branch-wide lint；保留小而可恢复的 Red/Green 提交。

测试优先调用公开函数、HTTP、GraphQL、MCP、数据库策略或可见 UI。不要用私有函数调用次数代替业务结果；生产缺陷先以回归测试复现。

异步地图替换测试先等待旧实例移除及新实例创建，再核对相机和未改变的原生输入。加载文字消失不能作为绘制生命周期完成的屏障。可通过受控响应与提交阶段观察区分这两个条件，无需改变生产 effect；聚焦检查和有界重复通过后，仍须完成组合验证门禁才能形成 Green 里程碑。

## 测试层级

| 层级         | 主要证明                                               | 默认工具                           |
| ------------ | ------------------------------------------------------ | ---------------------------------- |
| 纯领域与契约 | 状态转换、评分、Schema、错误码、确定性                 | Vitest                             |
| 应用组件     | Fastify route、身份解析、幂等、adapter 协作            | Vitest + Fastify `inject()`        |
| 数据库集成   | migration、约束、RLS、runtime role、锁与事务原子性     | 本机 Supabase / Compose PostgreSQL |
| 浏览器       | 中文默认、英文同构、深浅色、键盘、响应式和关键流程     | Playwright Chromium                |
| 纵向 smoke   | Auth、API、Worker、持久化、投影、MCP 与 Web 的真实组合 | 仓库运维脚本                       |
| Agent 演练   | 多 RunAgent、Receipt、Barrier、修订与确定性评价        | scripted/rework cookbook           |
| 在线 AI      | 供应商凭据和最小调用可用性                             | 仅显式 opt-in，不进默认测试或 CI   |

## `pnpm verify` 实际覆盖什么

在仓库根目录运行：

```bash
pnpm verify
```

它按顺序执行：

1. `prettier --check .`，检查整个仓库的格式；
2. 生成 Fumadocs 内容后运行 type-aware Oxlint；
3. 对所有声明了 `typecheck` 的 workspace 运行 TypeScript 检查；
4. `pnpm test:coverage` 在一次 Vitest projects 运行中执行完整单元测试并检查覆盖率：各 app project 可并行执行，名为 `repository` 的根 project 串行运行 `packages/**/*.spec.ts` 与 `tests/**/*.spec.ts`；
5. `pnpm test:ops` 用 Node test runner 运行 `scripts/data-foundation/*.test.mjs`，验证运维编排、runtime role、Supabase 状态解析和纵向 smoke 合同；
6. 对所有声明了 `build` 的 workspace 构建；
7. 运行 `docker compose config --quiet` 验证默认 Compose 配置。

`pnpm verify` 不会启动 Docker 服务，不会 reset 或测试 Supabase，不会应用 Data migration，不会运行 `data:smoke`，也不包含 Web/Docs Playwright、observability smoke、cookbook、showcase 或任何真实 AI 调用。相关变化必须追加下面的聚焦门禁。

## CI 调度与完成判定

文档治理、workspace 验证、reference 浏览器、Supabase、Data Foundation 和可观测性在隔离 runner 上独立启动，不消费 workspace 作业的构建产物。交付合同仍要求每项现有检查通过；`CI complete` 等待全部六个作业，并拒绝失败、取消、跳过或缺失结果。配置分支保护时保留现有必需检查名称；汇总检查是追加检查，不能用来省略任何验证作业。

push 前运行 `pnpm verify`，本地便会执行与 CI 相同的单元覆盖率棘轮。集成数据库继续使用可丢弃状态并从迁移创建；各集成作业内保留环境准备、断言和无条件清理顺序。并行调度只改变开始时间，不改变通过条件。

### CI 镜像与环境准备

Data 环境准备保留 Chromium、全新 Supabase 启动/reset 和 `pnpm data:up` 的顺序。迁移、seed、服务健康、解析器、smoke、登录浏览器和 PostgreSQL 检查仍全部运行。每个作业使用新建数据库及 Docker 原生存储；运行凭据、数据库卷和 smoke 状态不进入缓存。

## Vitest 与 workspace 聚焦命令

开发循环先运行最窄命令，再在完成前回到根验证。

| 范围                             | 命令                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| 单个根或 package spec            | `pnpm exec vitest run <path-to-spec>`                                                 |
| 全部 unit coverage               | `pnpm test:coverage`                                                                  |
| Data Foundation 运维合同         | `pnpm test:ops`                                                                       |
| Agent EXCON contracts/core/infra | `pnpm exec vitest run packages/contracts/test packages/core/test packages/infra/test` |
| Platform contracts/auth          | `pnpm exec vitest run packages/platform-contracts/test packages/platform-auth/test`   |
| API composition                  | `pnpm --filter @wiser/api test`                                                       |
| Agent EXCON 持久 journal         | `pnpm test:postgres:excon-v2`                                                         |
| EXCON v1 compatibility Worker    | `pnpm --filter @agent-excon/worker test`                                              |
| Data Worker                      | `pnpm --filter @wiser/data-worker test`                                               |
| MCP composition                  | `pnpm --filter @wiser/mcp test`                                                       |
| Telemetry Ingress                | `pnpm --filter @wiser/telemetry-ingress test`                                         |
| Web unit/read-model              | `pnpm --filter @wiser/web test`                                                       |
| Data contracts                   | `pnpm --filter @wiser/data-contracts test`                                            |
| Data core                        | `pnpm --filter @wiser/data-core test`                                                 |
| Data infrastructure              | `pnpm --filter @wiser/data-infra test`                                                |
| EXCON scenario assets            | `pnpm --filter @agent-excon/scenarios test`                                           |

`pnpm test` 明确组合 `test:unit` 与 `test:ops`。`@agent-excon/contracts`、`@agent-excon/core`、`@agent-excon/infra`、`@wiser/platform-contracts` 和 `@wiser/platform-auth` 没有独立 `test` script，它们的 spec 由 `repository` project 收集，因此使用表中的路径命令。不要把 `pnpm --filter <package> test` 的无脚本结果误认为测试已经运行。

## 覆盖率

```bash
pnpm test:coverage
```

该命令在同一次 Vitest projects 运行中合并 packages 与具有 unit suite 的 apps，显式纳入尚未被测试 import 的 TypeScript/TSX 源文件，并生成文本、`coverage/lcov.info` 与 `coverage/coverage-summary.json`。Docs 仍由 build/Playwright 验证，不进入 unit coverage。长运行进程的 bootstrap 文件显式排除；CLI、barrel 和 Web 页面保留在报告中。

经过实测的覆盖率棘轮设置全局下限：statement 73%、branch 67%、function 75%、line 76%。纯 Core v2、共享确定性 helper、OTLP Collector forwarder，以及 Graph/STAC/PostGIS 输入校验使用更高的分层下限。本地和 CI 的 `pnpm verify` 都恰好运行一次该命令；CI 保留 LCOV 与 JSON summary 7 天。阈值禁止自动更新；后续上调必须基于新的 Green 报告显式评审。

这些数字只衡量 Vitest manifest。Playwright、pgTAP、真实 PostgreSQL integration、运维 smoke 与浏览器可见的 Next.js 页面仍是独立证明层，不会合并进 unit 百分比。不得为了容纳未测试代码而下调阈值，也不能把全局数字解释成产品级覆盖率。

该套件在 Vitest 5 中显式声明 `{ concurrent: false }`，不再使用已移除的 `describe.sequential`。升级测试框架时保留全部七个数据库用例及清理逻辑；仅收集到用例不能作为数据库执行通过的证据。

## Supabase 与 Data Foundation

Supabase schema、RLS、seed 或平台/EXCON 数据库逻辑变化时：

```bash
pnpm supabase:start
pnpm supabase:verify
pnpm supabase:stop
```

`supabase:verify` 会重置本机 Supabase，然后运行 pgTAP、lint 和 advisor。需要保留的数据必须提前备份。

Agent EXCON journal 深度测试只允许连接已经验证的本机 Supabase PostgreSQL，并要求显式提供 loopback 管理员 URL：

```bash
EXCON_JOURNAL_TEST_ADMIN_URL='<loopback-admin-dsn>' pnpm test:postgres:excon-v2
```

该套件不会 reset 共享的 `postgres` 数据库。七个串行用例分别创建一个精确跟踪的临时数据库和 login role，应用 canonical journal migration，经过生产 runtime 后关闭所有 service/pool，并只删除自己记录的对象。它验证最小权限下的重启/回放、pending outcome 恢复、唯一 writer、result drift、intent corruption、历史 HMAC key 丢失，以及拒绝具备 RLS bypass、创建数据库/角色或 replication 能力的 runtime role。CI 在 `supabase:verify` 之后、无条件停止 Supabase 之前运行它。

Data package、migration runner 或 Compose 合同变化时先运行：

```bash
pnpm data:verify
```

`data:verify` 复用根 `test:ops` 入口，再检查四个 Data workspace 的 test/typecheck/build 和 Compose 配置；它不接触运行中的数据库。Data schema、runtime role、Worker、对象存储、投影、REST、GraphQL、MCP 或登录 Web 变化还需要真实纵向路径：

```bash
pnpm supabase:start
pnpm supabase:reset
pnpm data:up
pnpm data:migrate
pnpm data:seed
pnpm data:smoke
pnpm data:down
pnpm supabase:stop
```

两个真实 PostgreSQL adapter 门禁只允许指向 CI 或明确可丢弃的隔离 Data 数据库。API 门禁同时运行 command 与 PostGIS query spec，需要 migration owner DSN 来创建临时非 bypass role；Worker 门禁使用真实 `wiser_data_worker` 登录并会提交随机 authority fixture：

```bash
WISER_DATA_PG_INTEGRATION=1 DATA_TEST_DATABASE_URL='<owner-dsn>' pnpm test:postgres:data-api
DATA_WORKER_PG_SMOKE_URL='<worker-dsn>' pnpm test:postgres:data-worker
```

API command spec 通过临时非 bypass role 证明 Operation、Ingestion、Job 与 Transform Plan 的非法转换会以稳定 PostgreSQL 错误失败，并验证权威 identity/content、终态与运行中同态保护、Capability 限定的上传完成、精确 row version、旧 claim 路径移除、审核唤醒后准确的 claim event 历史，以及合法 heartbeat/等待态聚合；其正向 fixture 沿合法生命周期逐步推进，不直接插入不可能的中间状态。API PostGIS spec 另行证明权威的最新/精确不可变版本选择、sibling extent 聚合、snapshot 分页、DataItem 交集，以及 Tenant、安全等级和策略边界全部 fail closed。登录态 GeoJSON 浏览器 fixture 必须启用 vector、禁用 raster，且不发出 raster tile 请求；它验证版本级权威 metadata，但不把 fixture 冒充为有效 COG 证明。随后 Worker 深度测试证明完整 ingestion commit 路径仍可通过受保护 schema。

Data Foundation CI 先完成纵向 smoke 并保存机器可读报告，再对同一套栈运行登录态 Data 浏览器套件，然后运行 API、Worker 两个深度测试，最后无条件删除该 job 的 Data volumes。固定顺序是 `smoke → 登录态浏览器 → API/Worker 深度测试 → always cleanup`；前序任一步失败也必须执行清理。不要把这些命令指向共享数据库或需要保留的本机 volume。

在干净环境中，`pnpm stack:full:up` 会执行启动 Supabase、启动 Data profile、migration、seed 和 `data:smoke` 的收敛流程。Smoke 的成功证明固定步骤跨越上传、扫描、指纹、fake Agent、确定性转换、质量/审核、权威提交、Outbox、五个 completion target、REST、GraphQL、MCP 和登录 Web，并验证 Outbox 重放不重复创建 target facts。上传 bundle 同时包含英文与 `zh-CN` Markdown；REST 阶段会分别限定 `fulltext`、`semantic` 与 `graph` source，证明 OpenSearch 中文多 analyzer、Weaviate 纯向量和 Neo4j 全文图种子都能独立召回同一受控版本。

## Playwright

同时运行两套 reference 浏览器测试：

```bash
pnpm test:e2e:reference
```

也可以只运行受影响的应用：

```bash
pnpm --filter @wiser/web test:e2e
pnpm --filter @wiser/docs test:e2e
```

根命令以 workspace concurrency 2 并行运行 Web 与 Docs，并使用 `--no-bail`：任一套件失败都会使命令失败，另一套件仍完成并保留自己的诊断。两者使用不同端口和输出目录。两个 Playwright 配置都会启动自己的隔离开发服务器：Web 使用 `127.0.0.1:3200`，Docs 使用 `127.0.0.1:4322`。Web 在这一隔离套件中显式配置 reference/Auth-off 模式，生产环境继续禁止关闭认证。CI 的 Web 使用一个浏览器 worker，每个测试上限 60 秒，避免并发首次路由编译，并允许多视口导航用例在 runner 上完成；本地 Web 使用四个 worker。CI 的 browser job 独立于 `pnpm verify` 运行同一根命令，只在失败时保留 screenshot、trace 和 HTML report。这些套件证明浏览器中的路由、语言、主题和交互；它不能替代统一 Auth 或数据库纵向 smoke，包含编译的耗时也不作为生产延迟预算。

### 登录态 Data live 套件

一套可丢弃的 loopback 栈已经完成 Data migration、seed 和 smoke 后，对同一套栈运行受保护浏览器流程：

```bash
WISER_WEB_LIVE_BASE_URL='http://127.0.0.1:3100' \
WISER_WEB_LIVE_SMOKE_REPORT='<成功-smoke-report.json-的绝对路径>' \
WISER_WEB_LIVE_EMAIL='<本机-seed-账号>' \
WISER_WEB_LIVE_PASSWORD='<本机-seed-密码>' \
pnpm test:e2e:data-live
```

| 变量                          | 合同                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `WISER_WEB_LIVE_BASE_URL`     | 已运行 Web 应用的 loopback origin；禁止指向共享、staging 或 production 环境。 |
| `WISER_WEB_LIVE_SMOKE_REPORT` | 同一套栈刚生成且成功的机器可读 `data:smoke` 报告绝对路径。                    |
| `WISER_WEB_LIVE_EMAIL`        | 通过登录界面使用的本机 seed fixture 身份。                                    |
| `WISER_WEB_LIVE_PASSWORD`     | 该本机 fixture 身份的密码；不得打印，也不得持久化进诊断产物。                 |

这个命令只消费既有测试栈，不负责编排：它不会启动或停止服务，不会应用 migration 或 seed，不会运行 smoke，也不会 reset 任何权威存储。它必须复用已经 migrate、seed、smoke 验证过的 loopback 可丢弃栈，且该栈的数据和 volumes 都允许清理。与 reference/Auth-off 套件不同，它通过真实 Supabase Session 登录并验证受保护的 Data Web/API 行为；reference 套件通过不能替代这条身份边界。

Live Playwright 配置关闭 trace 和 video，只在失败时截图。CI 只允许上传失败运行的 screenshot 与 live HTML report，并设置受限访问和短保留期；不得发布四个环境变量、Auth cookie 或 storage state、请求头、DSN、smoke 报告、服务日志或下载的用户内容。即使是允许保留的失败诊断，向 CI 之外分享前也必须按敏感产物处理。

任何可见 UI 变化都要同时覆盖中文默认与英文等价状态，并检查浅色/深色、键盘焦点、窄屏和失败/不可用状态。修复定位器时优先使用 role、label、可见文本或稳定 test id。

## 可观测性

修改 OTLP ingress、collector、trace/metric/log pipeline、Grafana datasource 或脱敏逻辑时运行：

```bash
pnpm observability:config
pnpm observability:up
pnpm observability:smoke
pnpm observability:down
```

Smoke 检查真实 OTLP traces、metrics、logs 和敏感字段脱敏。它验证的是最佳努力的诊断面；即使 telemetry 完整，也不能替代 Event、Receipt、评价或数据库审计事实。

## Cookbook、showcase 与其他 smoke

Agent EXCON 场景、MCP 参与流程、Barrier、评价或演练 runner 变化时运行两条无模型路径：

```bash
pnpm cookbook:scripted
pnpm cookbook:rework
pnpm showcase:preflight
```

`cookbook:scripted` 验证四个脚本 RunAgent 通过真实 MCP/API 完成案例；`cookbook:rework` 先注入一次 schema 错误，再证明 scoped grant、revision 2 与最终评价。`showcase:preflight` 只验证展示前提，不等于会话已经成功运行。

真实 WorkBuddy 路径会产生模型用量并需要网络、登录和当前用户明确授权：

```bash
WORKBUDDY_LIVE=1 pnpm cookbook:workbuddy
```

它不属于默认验证，也不得因普通代码改动自动运行。完整 Data smoke 使用 `pnpm data:smoke`；可观测性 smoke 使用 `pnpm observability:smoke`。不要把单个 `/health/ready` 响应当作纵向 smoke 通过。

## AI 与确定性边界

- 测试、CI、scripted cookbook 和 Data smoke 使用 fake provider 或确定性 fake embedding，不访问网络且不产生模型费用。
- fake 输出仍要通过与生产 adapter 相同的 Schema 和业务门禁。
- AI 不得生成确定性分数、授权决定、质量结论、验收或发布裁决；这些行为由纯规则和测试固定。
- 本机 Codex provider 只允许在可信宿主显式启用；认证文件不能进入容器。
- OpenAI-compatible 或 WorkBuddy 在线 smoke 必须是显式 opt-in，失败要如实报告，不能隐藏重试或回退为“成功”。

## 何时运行什么

| 变化类型                       | 最小开发循环                       | 合并前追加                                       |
| ------------------------------ | ---------------------------------- | ------------------------------------------------ |
| Contracts / core               | 单个 spec 或 package 路径          | `pnpm verify`                                    |
| API / Worker / MCP             | 对应 workspace `test`              | `pnpm verify`；涉及真实存储时追加相应 smoke      |
| Web / Docs UI                  | Web unit 或 Docs build             | 对应 Playwright + `pnpm verify`                  |
| Supabase schema/RLS/seed       | pgTAP Red + `pnpm supabase:verify` | `pnpm verify`                                    |
| Data schema/runtime/projection | 聚焦 spec + `pnpm data:verify`     | 完整 Data 顺序或 `stack:full:up` + `pnpm verify` |
| Observability                  | 聚焦 Vitest                        | config/up/smoke/down + `pnpm verify`             |
| EXCON 场景/cookbook            | 聚焦 root spec                     | scripted + rework + `pnpm verify`                |
| 文档治理                       | Docs build + `pnpm docpact:check`  | Docs Playwright + `pnpm verify`                  |

## 完成定义

一项变化可以交接之前，应满足：

- 新测试曾因预期原因失败，现在通过；现有回归保持全绿。
- 权限、输入错误、并发、幂等和不可用状态有与风险相称的负向测试。
- Core 保持纯确定性，跨系统调用只经过公开 contracts 或 HTTP。
- 数据库 migration 可从空本机数据库重放；RLS 使用非超级用户实际验证，seed 与声明 schema 保持同步。
- 可见 UI 同步中英文文案，并验证主题、键盘和响应式行为。
- 默认测试没有真实模型调用、外部费用或秘密依赖。
- 编码后运行 `pnpm docpact:check`，更新命中的权威文档或记录真实审查证据。
- 多提交分支对目标 base 运行 `docpact lint --root . --merge-base <base-ref> --mode enforce --fail-on-uncovered-change --fail-on-stale-docs`，覆盖已经提交的 Red/Green 切片。
- 所需聚焦门禁、集成 smoke 和最终 `pnpm verify` 均通过。
- Git diff 只包含预期范围，`git diff --check` 通过；Red 是可恢复检查点，最终提交处于 Green 且目的单一。

Data API 的 PostgreSQL 集成命令依次运行各测试文件。临时角色仍需在共享 schema 上配置权限，即使业务数据分属不同租户，并发 fixture 也可能在系统目录发生冲突。全部测试和回滚检查仍保留。

### 显式来源案例浏览器测试

#### 候选 API 负载驱动器

预检拒绝畸形输入，不输出其异常内容。发出的请求和固定引用不允许传输适配器改写；错误分类保持限定值，不能改写为未经脱敏的报告内容。

`pnpm exec vitest run tests/toolchain/a12-candidate-load-driver.spec.ts tests/toolchain/a12-candidate-load-traversal.spec.ts` 使用合成响应验证 `apps/web/e2e-live/support/a12-candidate-load-driver.ts` 中的确定性测量工具。这个单元门禁只证明驱动器与断言，不证明当前 Auth、真实 HTTP 耗时、完整分页、内存、连续负载或冷重建。

采样前固定标准接收回执、候选引用、各原件计数、有序列定义及内容摘要。未知计数或不完整清单使任务未运行；正式采样后出现漂移使本轮失败。真实与合成数据分开统计。每个数据集有十八个条件：三项既有候选 GET 能力、首段 50/200 条和客户端并发 1/4/8。每个条件保留五次预热、一百次正式尝试及所有错误和慢请求；失败不算严格完成响应，不能用重试替换。全部已测耗时排序后，中位数取上中间项，p95 取最近秩；目标保持中位数 ≤300 毫秒、p95 ≤800 毫秒，同时须有一百个完整响应且没有失败尝试。

公开 REST GET 与网页同源 BFF POST 是不同测量边界。拒绝固定引用错误、原件计数漂移、schema 失败、非 JSON 响应、既有 3 MiB 材料上限、过长或回显游标及空续页。保留原字段缺失、null、空字符串及原索引间隙；GeometryCollection 按一条原始几何记录计数，不能按绘制部件计数。报告只含条件标签、序号、耗时、字节／计数检查及泛化结果，不保存 body、原值、坐标、URL、游标、请求头、凭据或原始异常。正式执行仍须经过独立登记的运行／资源／隐私门禁、二十次完整遍历和真实当前核权，并另过连续负载、内存及冷重建验收。

三个固定版本的业务关系/记录导航回归使用已接纳的本机来源数据，包括 TCI 波段和独立核对的观测关系数。未按文件过滤运行 `pnpm --filter @wiser/web test:e2e:data-case --reporter=list` 整套案例时，须提供 `WISER_WEB_LIVE_BASE_URL`、既有 live 凭据、`WISER_WEB_LIVE_RELATION_URL`、`WISER_WEB_LIVE_RECORD_URL`、`WISER_WEB_LIVE_OBSERVATION_COUNT` 和 `WISER_WEB_LIVE_CANDIDATE_VIEW_URL`。关系 URL 必须指向固定目录版本与关系视图，记录 URL 必须携带固定记录焦点，候选 URL 须满足下文真实保存视图要求；只运行候选返回案例时使用下文按文件过滤的命令。缺少或无效的案例输入会明确失败。`e2e-live/*.case.ts` 保留全部断言，由 `playwright.case.config.ts` 收集，不作为可移植的 CI fixture。`test:e2e:data-live` 继续对 CI smoke 环境收集既有全部 `*.spec.ts` 套件。测试发现回归只使用合成输入调用 Playwright `--list`，不能算作真实案例浏览器运行。Docpact 将 live 浏览器案例、浏览器配置和发现 fixture 映射到本双语测试契约。

完整遍历工具使用区分动作的 SHA256 摘要链，保留条目和列定义顺序，摘要不依赖分页边界。二十次遍历每次都须与预先固定的清单匹配，包括全部原件、行与几何计数、身份唯一性和顺序；只与另一遍历相符不足以通过。重复或循环游标会被拒绝，读取量受固定计数约束，结果不保存原始内容。

测试侧 HTTP 适配器直接使用三项公共 GET 的已注册方法、路径和输入契约。提供已验证会话闭包前，先核准任务专用的本机地址及准确端口。适配器不跟随重定向、不发送 GET 正文、不重试失败尝试。成功 JSON 响应记录实际消费的正文流字节，遵守既有 3 MiB 流限制，拒绝未完整结束的传输和非法 UTF-8，保留既有 30 秒总期限。非 200 响应保留状态但不读取错误正文；零字节表示未消费正文，不能解释为响应为空。抛错时字节数仍为未知。客户端取消与关闭适配器会清理自身请求、监听器和定时器，这些检查不证明服务端 SQL 已取消。

内存认证守卫通过既有 Supabase 客户端登录一次，再在每组条件前核验可信声明、相同会话令牌和既有平台身份响应；这些操作不计入 GET 耗时。守卫禁止持久保存会话和刷新，拒绝令牌替换，新检查或失败后旧条件闭包失效。身份接口只能证明身份及必要操作范围，没有包含候选资源、委托和有效期的全部条件；完整的当前候选权限仍由实际公共 GET 核验。假认证测试和合成回环测试不能证明真实 Auth、行级权限、标准接收来源或正式 A12 结果。

通过 `pnpm exec vitest run tests/toolchain/a12-candidate-load-http.spec.ts tests/toolchain/a12-candidate-load-auth.spec.ts` 运行适配器检查。合成 HTTP 服务仅绑定系统为自身分配的回环端口，并只关闭自己的监听器，不占用真实 API 端口。组合检查调用实际认证守卫、HTTP 适配器和驱动器：令牌过期按失权停止新尝试，旧条件按失效停止，守卫关闭按取消停止。已开始的尝试保留在结果中，不发替补请求；配置异常及错误分类均限定范围并脱敏。

`apps/web/e2e-live/support/a12-candidate-load-runner.ts` 中的私有运行入口在登录前核对独立固定的接收回执、候选清单、准备原件及标准服务执行证据。它按实际文件字节重新计算哈希，核对既有上传、接收和 Operation 的关联及每条数据轨道的完整计数，并冻结输入快照。关联的 Operation 必须属于 `data.ingestion.create`；两份无关能力标识相同不足以证明标准接收。上传时提交的哈希、普通 Operation 消息和声明 READY 都不能证明已完成扫描或指纹核验；须由本任务可信执行证据校验器确认，证据缺失或未知时记为 `not_run`。既有接收契约中的来源登记是可选项；带清单的 PARTIAL 批次仍须保留部分可用状态，不得删去清单或改成 READY 来通过测试。

运行入口调用既有驱动器完成三十六组固定条件，并在每条轨道的二十轮中按冻结顺序遍历全部成员。每种操作的代表成员在采样前固定，不把不同成员的性能尝试混成一个样本。遍历页只记录序号、操作、耗时、实际消耗字节和限定结果；每组条件或成员遍历前在计时外重新核权，结束后关闭自身传输，终止性失败停止后续工作，不替换已开始的尝试。清理异常保留已有终止原因及其样本；返回的守卫或传输对象不合规时，仍调用自身直接保存的关闭方法，不读取访问器。`pnpm exec vitest run tests/toolchain/a12-candidate-load-runner.spec.ts` 仅验证合成编排；假时钟、执行证据校验器和传输不能证明真实 Auth／SQL、数据规模或正式性能。候选矩阵完成后，整体 `formalA12` 仍为 `not_run`，连续运行、内存、首屏和冷重建须另有预登记的实际出口证据。

`apps/web/e2e-live/support/a12-candidate-original-http.ts` 中的私有原件读取适配器复用既有固定候选 GET 路由，只接受任务专用回环地址和准确的候选／原件引用。它要求未压缩、完整的 200 响应及预期 Content-Length，对实际响应流重新计算哈希，保留既有 32 MiB 输入边界和 30 秒总期限。重定向、范围读取、传输截断、字节变化及输入访问器均会被拒绝，并清理自身请求。`tests/toolchain/a12-candidate-original-http.spec.ts` 的合成检查证明客户端完整性守卫；真实正常 API 的成功 GET 可证明当时 API 守卫及原件字节，不能单独证明本次逐原件扫描事务。

`apps/web/e2e-live/support/a12-standard-intake-http.ts` 须仅调用既有七项上传会话、资料接收和 Operation 能力，包括 `data.ingestion.submit`。创建接收任务只登记等待中的 Operation；开始处理须调用既有提交命令，使用接收任务的当前版本及匹配的 If-Match。返回的嵌套 Operation 保留原创建能力和身份。写命令沿用登记的路径、成功状态、时限及 UUID 幂等键；事件读取在 30 秒内解析真实有限 SSE 快照及续页游标，保留事件身份与顺序。预签名 PUT 在发送前复制并核对实际字节及哈希，只允许任务存储地址和既有必要对象头，不发送 API 凭据。JSON／SSE 保留既有 3 MiB 流上限，PUT 回应另有有界读取。适配器同时核对数据格式与请求归属，并在完成、取消或失败时清理自身定时器、请求和连接。

真实 DTO 和签名上传目标仅留内存。`redactA12StandardIntakeReply` 生成明确的持久化投影：签名 URL 替换为 `https://redacted.invalid/`，移除上传请求头，脱敏错误／消息文字，分别保存实际响应流与投影摘要。脱敏 JSON 文件不能自证扫描执行或取得可信接收准入。使用 `pnpm exec vitest run tests/toolchain/a12-candidate-original-http.spec.ts tests/toolchain/a12-standard-intake-http.spec.ts` 运行合成回环检查；这些消费者不启动服务、不改权限，也不批准或发布接收资料。真实正常栈来源、Auth／SQL 和正式 A12 仍是独立门禁。

候选清单采集须对照准备好的资产／哈希清单读取既有资产、记录和几何分页，保留来源顺序、严格递增的记录索引、有序列键与标签，以及不依赖分页大小的内容摘要。几何的记录身份、索引和来源标识须与标为包含几何的记录对应。已知零保留为零，未知数量记为 `not_run`，已知 `PARTIAL` 仍为部分解析；正式负载准入继续要求既有完整 `READY` 门禁。空续页仍按无效回应拒绝；回应已判为无权访问后，后续取消或清理失败不得覆盖首个结果。`tests/toolchain/a12-candidate-inventory-collector.spec.ts` 使用合成分页核对这项消费者契约，覆盖外来资产、元数据／列／数量漂移、游标回环、取消和首因清理。这些检查不证明正常栈来源、扫描、真实权限或正式 A12。

任务私有的完整接收采集器须把同一准备顺序贯穿上传目标、上传完成、创建接收任务、实际当前资料读取及提交处理。提交版本取自资料而非Operation；全部回应须保留原创建任务身份。随后有界读取状态与事件分页，采集同一候选清单，并将每个完整原件与准备字节核对。负载入口的接收回执保持六键；提交、提交前读取及字节校验留在私有持有者的捕获记录中。合成DTO、READY或可复制JSON不能生成可信正常栈来源；缺可信证据仍为未知，禁止派发正式负载。使用 `pnpm exec vitest run tests/toolchain/a12-standard-intake-collector.spec.ts` 核对消费者契约，不代替实际Auth／SQL或扫描验收。

#### 固定候选同标签返回案例

只在已经准备好的可丢弃本机栈运行 `pnpm --filter @wiser/web test:e2e:data-case candidate-backflow.case.ts --reporter=list`，提供既有 live 基础地址、测试身份，以及同一栈真实保存视图 HTTP 回执中的 `WISER_WEB_LIVE_CANDIDATE_VIEW_URL`。URL 必须采用配置的 HTTP `localhost` 或 `127.0.0.1` 源，指向接入详情，并且只含一个 `candidateView` UUID；拒绝用户密码段、片段、额外参数和游标。保存视图及所选材料页必须当前可读且非空；输入或资源缺失会明确失败，记为 `not_run`，不能以跳过算作通过。仅提供 URL 不证明资源来源真实或已有读取权限。

案例经过真实登录页，消费实际保存视图 open、固定材料读取和确认结果，点击接入详情当前的 Operation 链接，再以首段控件消费真实事件 HTTP 请求，随后执行 `page.goBack()`。返回前先开启观察，并隔离离开前的请求；保存请求须与实际材料动作及固定引用绑定。仅在内存中比较恢复后的完整 references、viewSpec、固定页锚点和材料内容，等值比较只剔除重新签发的短期游标；逐条将可见行、原值或几何条目与 HTTP 对照，核对所选记录的 focus 状态，并在首段读取结束后比对渲染的事件。不要求 open 恰好发生几次。当前接入的 Operation 以实际链接核对，不推定历史保存批次属于该 Operation。资产、记录和几何响应分别使用既有 schema，保留固定引用绑定。

可见材料只有在受限内容实际可见、没有 inert 且不再忙碌、加载结束并可刷新、所选面板实际可见且与标签绑定，以及技术信息中的批次和审核哈希与保存请求一致后，才算恢复。测试专用可见性 helper 保持真实用例的 30 秒默认超时；可丢弃的合成 DOM 探针可明确传入较短超时。探针用公开合成资产调用同一实际 helper，不加载 live 案例模块、凭据或平台资源；它只证明断言行为，不是实际 Auth 或 Back 验收。

同轮任一候选响应出现 HTTP、JSON、schema 或固定身份不符，超过既有保存 open 的 128 KiB／材料读取器的 3 MiB 上限，或无法读取 body，观察器都会使整轮失败；其后成功的响应不能恢复该轮，45 秒快照等待以泛化失败结束。这一保守判定不能证明拒读后的恢复。Operation 没有可读事件属于缺资源，记为 `not_run`；其他事件契约或渲染不符仍记为失败。真实运行须记录实际使用的资产、记录或几何页类型，验收结论仅适用于实际执行的类型。

案例在填入凭据前要求只有 `list` 报告器，HTML、JSON、blob、自定义或混合报告器会以 `not_run` 拒绝；这些格式即使面对已泛化的错误，仍可能持久化 API 步骤参数。失败截图覆盖为 `off`，trace、video 也保持关闭，并在测试 worker 内启用当前 runner 的 `PLAYWRIGHT_NO_COPY_PROMPT` 开关，持续到产物清理阶段，禁止自动保存失败 DOM 快照。runner 仍可能写出泛化错误与元数据；这个开关并非禁用全部 error-context 文件。诊断不回显输入 URL、响应内容、签名游标或凭据；不得附加 cookie、storage state 或候选材料。案例只测试普通获权的同标签往返，不撤权或合成事件，不验地图真实相机姿态或超过 100 条事件的续页。独立的续页 403 路径仍需真实长事件 Operation 和另经明确授权的控制动作；测试发现和本往返案例都不能满足该路径。发现测试保留原九项案例，新增这一项时只使用明确合成的 `--list` 输入，不启动服务或真实登录。

Supabase CI 通道在结构检查后，串行运行真实智能体连接、受管 MCP 同意、资源权威和资源批次集成套件。`WISER_AGENT_TEST_DATABASE_URL` 和 `WISER_RESOURCE_TEST_DATABASE_URL` 均须指向已播种的隔离测试控制库。它们核验真实 PostgreSQL 授权、同意范围上限、撤权、按用途独立审批和审计失败回滚；未设置变量而跳过测试不算验收。不得指向共享部署。本人浏览器／客户端与获许可外部供方仍是独立的目标环境验收。
