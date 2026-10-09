---
title: WISER Data Worker component guide
docType: component-guide
scope: apps/data-worker
status: active
authoritative: true
owner: wiser
language: bilingual
whenToUse:
  - when running or changing Data Foundation ingestion jobs or Outbox projection processing
whenToUpdate:
  - when Data Worker handlers, scheduling, projections, configuration, health, metrics, or verification changes
checkPaths:
  - apps/data-worker/**
  - packages/data-core/**
  - packages/data-infra/**
  - infrastructure/data-foundation/**
lastReviewedAt: 2026-10-08
lastReviewedCommit: bc7730a30d7724ea80dc450fd2bde1f8fc2a35c1
---

# WISER Data Worker / 数据基座 Worker

## Responsibility / 职责

`apps/data-worker` 是 Data Foundation 的后台执行进程。它领取 durable jobs 并运行受控的 `data.ingestion.process.v1` pipeline，同时消费 authority Outbox：在权威 data-postgres/PostGIS 内建立受治理 spatial representation，并写入 Weaviate、OpenSearch、Neo4j 与 STAC 可重建外部投影；全部 ledger target 成功后再通过确定性 gate 完成 publication。

`apps/data-worker` is the Data Foundation background executor. It claims durable jobs and runs the controlled `data.ingestion.process.v1` pipeline while consuming authority Outbox events: it establishes governed spatial representations inside authoritative data-postgres/PostGIS and writes rebuildable external Weaviate, OpenSearch, Neo4j, and STAC projections. Publication passes through a deterministic gate only after every ledger target succeeds.

它负责租约、heartbeat、重试、dead letter、取消和优雅排空，但不提供公共业务 API、不建立第二套 Auth，也不把外部投影当作 authority。`catalog.spatial_extent` 等 data-postgres 权威记录不能按缓存处理。 / It owns leases, heartbeats, retries, dead letters, cancellation, and graceful draining, but exposes no public business API, creates no second Auth system, and never treats external projections as authority. Authoritative data-postgres rows such as `catalog.spatial_extent` are not caches.

Worker 的提交后空间读回保留 source CRS、canonical→WGS84 变换、bbox 和固定 extent 顺序；嵌套 GeometryCollection 只按直接成员补齐 JSON 容器，叶几何继续使用 PostGIS 的 9 位小数、options 0 序列化，保留成员顺序、重复项与 Multi*。简单、扁平及数据库全空根仍走原直接序列化路径，非空树内的空子集合不因当前写入校验而被删除。此私有读取适配不增加几何准入阈值、超时、迁移或权限；同一四 GUC 只读事务及失败回滚保持不变。原生几何读回、受治理提交与全部投影发布分别验收。 / Post-commit Worker spatial readback retains the source CRS, canonical-to-WGS84 transformation, bounding box and fixed extent order. Nested GeometryCollections rebuild only JSON containers from direct members; leaves retain PostGIS nine-decimal, options-0 serialization, member order, duplicates and Multi* containers. Simple, flat and database-empty roots retain the direct serializer; empty children in a nonempty tree are not removed by applying current write validation to historical reads. This private adapter adds no geometry admission limit, timeout, migration or permission. The same four-GUC read-only transaction and safe rollback remain unchanged. Native geometry readback, governed commitment and publication across all targets are separate acceptance checks.

## Entrypoints / 入口

- Process composition / 进程组合：`src/main.ts`
- Runtime composition / ingestion 与 projection 组合：`src/runtime/default-runtime.ts`
- Scheduler / durable job 调度：`src/scheduler.ts`
- Strict configuration / 严格配置：`src/config.ts`
- Package / workspace：`@wiser/data-worker`
- Compose service：`data-worker`（`data-foundation` profile；主机 `127.0.0.1:13003` 映射容器端口 `3003`）

## Run / 运行

推荐从仓库根目录使用完整栈，由脚本准备 Supabase、Data PostgreSQL、迁移、runtime roles、对象存储和投影服务： / Prefer the complete-stack workflow, which prepares Supabase, Data PostgreSQL, migrations, runtime roles, object storage, and projection services:

```bash
pnpm stack:full:up
```

仅在所有依赖已准备且完整的 canonical `DATA_*` 环境已注入时聚焦启动： / Start the process directly only after all dependencies are ready and the complete canonical `DATA_*` environment has been supplied:

```bash
pnpm --filter @wiser/data-worker dev
```

## Configuration boundary / 关键配置边界

配置由 `src/config.ts` 严格校验；缺失、越界或部分配置会启动失败。使用 canonical `DATA_*` 名称；保留的 `WISER_DATA_*` aliases 仅用于迁移兼容并会产生 warning。 / `src/config.ts` validates the entire environment strictly; missing, out-of-range, or partial configuration fails startup. Use canonical `DATA_*` names. Retained `WISER_DATA_*` aliases are migration-only and produce a warning.

| Group / 分组                 | Canonical variables / 关键变量                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Authority and scope / 权威域 | `DATA_DATABASE_URL`, `DATA_TENANT_ID`, `DATA_PROJECT_ID`, `DATA_MAX_SECURITY_LEVEL`, `DATA_POLICY_VERSION`, `DATA_WORKER_ACTOR_ID` |
| Scheduling / 调度            | `DATA_WORKER_ID`, `DATA_WORKER_CLAIM_LIMIT`, `DATA_JOB_LEASE_SECONDS`, `DATA_JOB_HEARTBEAT_SECONDS`, `DATA_JOB_POLL_INTERVAL_MS`   |
| Ingestion / 摄取             | `DATA_S3_*`, `DATA_CLAMAV_*`, `DATA_TIKA_*`, `DATA_INGESTION_*`                                                                    |
| Projections / 投影           | `DATA_WEAVIATE_*`, `DATA_OPENSEARCH_*`, `DATA_NEO4J_*`, `DATA_STAC_*`, `DATA_PROJECTION_*`                                         |
| Status server / 状态服务     | `DATA_WORKER_HEALTH_HOST` (default `0.0.0.0`), `DATA_WORKER_HEALTH_PORT` (default `3003`)                                          |

检索投影按信号分工：OpenSearch `wiser-evidence-v2` 使用 ICU + 官方 SmartCN + CJK bigram 构建中文/多语正文词法召回；Weaviate `WiserEvidenceChunkV2` 只保存受版本治理的外部向量并执行纯 `nearVector`；Neo4j 写入前创建并等待同步的 `wiser_entity_name_cjk_v1` 实体名全文索引。索引/collection 名带版本，因为 analyzer、tokenization 与过滤索引变化必须从 data-postgres 权威面重放，而不能原地假装兼容。 / Retrieval projections separate signals: OpenSearch `wiser-evidence-v2` uses ICU, the official SmartCN plugin, and a CJK-bigram fallback for Chinese/multilingual document text; Weaviate `WiserEvidenceChunkV2` stores governed external vectors and runs pure `nearVector`; Neo4j creates and awaits the synchronous `wiser_entity_name_cjk_v1` entity-name full-text index before graph writes. Index and collection names are versioned because analyzer, tokenization, and filter-index changes require replay from data-postgres authority rather than pretending to be compatible in place.

运行时 DSN 必须使用 Data Foundation 的受限 Worker role，不得使用迁移 owner；Supabase 仍是唯一身份权威，Worker 只接收 Tenant/Project 等 scoped references。 / The runtime DSN must use the restricted Data Worker role, never the migration owner. Supabase remains the sole identity authority; this process receives only scoped Tenant/Project references.

Worker 的 authority 写入必须沿合法状态边且每次精确推进一个 `row_version`；review checkpoint 只有在 ID、plan、hash、状态、批准者、安全等级和 policy 全部相同时才允许幂等重放，批准转换使用独立的受控 SQL。数据库 trigger 会对 runtime role 再次执行这些约束。 / Worker authority writes must follow legal state edges and advance exactly one `row_version`. Review checkpoints permit idempotent replay only when identity, plan, hash, status, approver, security level, and policy all match; approval uses its dedicated guarded SQL. Database triggers enforce the same boundary for the runtime role.

服务器独立审核策略启用后，即使公开且高置信度，Worker 仍冻结策略修订并返回待审；客户端参数不能覆盖。load/freeze/commit 均核对当前策略，旧检查点或撤销策略不能继续提交；正式版本保留同一绑定。提交／委托责任不可改，最终批准须由独立真人经 API 执行。/ With server independent review enabled, Worker freezes the policy revision and waits even for public, high-confidence input. Client flags cannot override it. Load/freeze/commit recheck current policy; stale checkpoints or withdrawn policies cannot proceed. Version manifests retain the binding, submission/delegation responsibility is immutable, and final approval goes through the API as an independent human.

## Mixed spatial geometry / 混合空间几何

默认对齐器将同质集合保持为既有 MultiPoint／MultiLineString／MultiPolygon；混合集合保留原几何成员顺序和坐标，形成同一资产的 GeometryCollection 范围。该范围不替代逐 Feature 的候选记录、属性、源 ID 或原件哈希。内部 PostGIS 投影校验接受非空嵌套集合，整棵几何共用 100,000 个位置上限和统一二维／三维维度；以根几何深度为0，最大深度8，非法成员及未知键拒绝。/ The default aligner keeps existing MultiPoint/MultiLineString/MultiPolygon results for homogeneous collections. Mixed collections retain member order and coordinates as one asset-level GeometryCollection extent, without replacing per-Feature candidate records, properties, source IDs or original hashes. Internal PostGIS projection validation accepts nonempty nested collections with one shared 100,000-position budget and consistent two- or three-dimensional positions. Root geometry has depth zero; maximum depth is eight. Invalid members and unknown keys are rejected.

上述为内部适配兼容，不新增公共 HTTP 契约、权限或迁移。单元测试不代替实际 PostGIS 构造／变换、候选原记录或审核发布验收。/ This is internal adapter compatibility, with no new public HTTP contract, authority or migration. Unit tests do not replace native PostGIS construction/transformation, candidate-record readback or governed publication acceptance.

## Health and metrics / 健康与指标

受管待审入库在冻结检查点后，使用同一已领取Job和默认候选处理器保存原值、定位及几何；恢复时复用同一输入与批次，成功后仍等待独立审核。迁移0037必须先通过校验和Runner执行，再重跑runtime provisioning，使批次／原件只允许更新完成字段、记录保持不可改。原件哈希、当前策略、完整资产集合和提交前租约均须匹配；临时失败回滚，格式／容量缺项保留未知数量和原因。候选不会创建正式版本或进入检索投影；带Auth的HTTP读取与真实数据库／浏览器验收单独执行。/ Governed intake processes the frozen candidate with the same claimed Job and default processor, retaining original values, locators and geometry. Recovery uses the same inputs and batch; success still waits for independent review. Apply migration 0037 through the checked-sum runner and rerun runtime provisioning before this runtime: batches/assets can update only completion fields and records remain immutable. Original hashes, current policy, the complete asset set and the final lease must match. Temporary failure rolls back; format/capacity gaps retain unknown counts and reasons. Candidates create neither published versions nor search projections; authenticated HTTP readback and real database/browser acceptance are separate gates.

来源登记通过现有入库 Handler 执行扫描、指纹与严格清单核对，保留声明的样本/部分/空文件状态，生成 `METADATA_QUALITY` / `DECLARED` 版本；其质量只评价登记完整性。该流程不调用 Tika 或 AI 映射计划，受限来源仍等待有权限的复核，临时清单读取失败可以重试。 / Source registration uses the existing ingestion Handler for scanning, fingerprints and exact manifest reconciliation. It retains sample/partial/empty states and creates `METADATA_QUALITY` / `DECLARED` versions whose quality measures registration integrity. It calls neither Tika nor an AI mapping planner; restricted sources still require authorized review, and temporary manifest reads remain retryable.

严格的 `wiser.candidate-conversion-claims.v1` 声明只放在 `M.record.candidateConversionPairs` 保留键，含1–128对 O/P、源内作品编号及可空的历史工具版本，不含 M 身份、已核验标志或工具摘要。来源登记入口核实际成员哈希、大小及 DOC/DOCX 角色，从已核字节补齐 M 身份，在 `reviewHash` 前冻结完整声明；候选端从实际 M 独立派生声明，差异即拒绝。受信宿主端口读取实际 O/P 字节、发现工具身份并比较 P/R′ 完整 Word 结构，摘要哈希覆盖完整结构。实际资产结果保存后、批次仍为 PENDING 时写入核验，随后执行原提交前租约锁及完成操作。权限或数据库错误整事务回滚，明确工具失败保留有界原因；无键旧输入沿用原流程，已完成批次不补写。宿主端口须限制工具执行时间并透传取消／失租检查错误；单元调用顺序不能证明 PostgreSQL 并发验收。 / Strict `wiser.candidate-conversion-claims.v1` claims live only in the reserved `M.record.candidateConversionPairs` key: 1–128 O/P pairs with source-local work ID and nullable historical tool version. They contain no M identity, verification flag or tool digest. Source registration checks actual member hashes, sizes and DOC/DOCX roles, derives M identity from verified bytes, and freezes full declarations before `reviewHash`. The candidate independently derives declarations from actual M and rejects drift. A trusted host port receives actual O/P bytes, discovers tool identity, and compares complete P/R′ Word structures; its digest covers the full structures. Results are inserted after actual asset outcomes while the batch is PENDING, before the unchanged final lease fence and completion. Authority/DB errors roll back; explicit tool failure is bounded and honest. No-key legacy inputs retain their path, and completed batches are never backfilled. The host port must bound tool time and propagate cancellation/lease-check errors; unit call-order evidence is not PostgreSQL concurrency acceptance.

`createDefaultDataWorkerRuntime` 的第三个参数接受受信宿主注入的 `candidateConversionRunner`，默认缺失时保存工具不可用；不接受公开请求或环境中的工具身份声明。 / The third `createDefaultDataWorkerRuntime` argument accepts a trusted host-injected `candidateConversionRunner`; its absent default retains tool unavailability and never accepts tool identity claims from public requests or environment fields.

不同来源路径可在逐项匹配大小和哈希后引用同一个内容资产，清单与证据保留这些路径别名；重复路径、未列出的资产或不匹配的别名会失败。 / Distinct source paths may reference one content asset after individual size/hash checks; the manifest and evidence retain those aliases. Duplicate paths, unlisted assets and mismatched aliases fail validation.

- `GET /health/live`: scheduler 未停止时为成功。 / Succeeds while the scheduler is not stopped.
- `GET /health/ready`: scheduler 运行且最近一次 job poll 成功后为成功；排空或 poll failure 时返回 `503`。 / Succeeds while running after a successful job poll; draining or a poll failure returns `503`.
- `GET /metrics`: Prometheus text，包含 job outcome、recovery、in-flight 与 readiness counters；它是运行指标，不是业务或 publication authority。 / Prometheus text for job outcomes, recovery, in-flight work, and readiness; it is operational telemetry, not business or publication authority.

## Verify / 验证

```bash
pnpm --filter @wiser/data-worker test
pnpm --filter @wiser/data-worker typecheck
pnpm --filter @wiser/data-worker build
pnpm data:verify
pnpm data:smoke
```

`data:smoke` 需要已启动、迁移并 seed 的完整依赖；通用仓库 gate 仍为 `pnpm verify`。 / `data:smoke` requires running, migrated, and seeded dependencies; `pnpm verify` remains the repository-wide gate.

权威说明 / Authoritative references：

- [后端开发](../docs/src/content/docs/zh-CN/development/backend.md) / [Backend development](../docs/src/content/docs/en/development/backend.md)
- [Data Foundation 架构](../docs/src/content/docs/zh-CN/architecture/data-foundation.md) / [Data Foundation architecture](../docs/src/content/docs/en/architecture/data-foundation.md)
- [数据库开发](../docs/src/content/docs/zh-CN/development/databases.md) / [Database development](../docs/src/content/docs/en/development/databases.md)
- [测试与验证](../docs/src/content/docs/zh-CN/development/testing.md) / [Testing and verification](../docs/src/content/docs/en/development/testing.md)

Version analysis jobs (`data.analysis.process`) read already admitted objects using their immutable version and content hash. CSV and GeoJSON parsing writes bounded batches into scoped analysis tables. Each asset retains a parse outcome independently of source completeness and registration quality. The worker checks its current job lease before committing; a lost lease rolls back the analysis. Unsupported formats retain unknown counts. The original assets are never replaced.

CSV/JSON analysis is bounded at 64 MiB and 2,000,000 records per asset. Capacity and unknown-CRS failures retain unknown counts with an `UNSUPPORTED` reason; malformed content and hash mismatches remain `INVALID`. / CSV/JSON 分析按资产限制为 64 MiB、2,000,000 条记录。容量或未知坐标系问题保留未知计数与 `UNSUPPORTED` 原因，格式错误或哈希不符仍为 `INVALID`。

独立解析适配器校验来源哈希、流式字段与完成总数，在本地绑定记录 ID；不完整结果必须回滚。 / The isolated parser adapter verifies source hashes, streamed schemas and completion totals, binds record IDs locally, and rejects incomplete results.

`DATA_ANALYSIS_PARSER_URL` 配置内部解析器根地址，完整 Data profile 自动连接。XLSX/XLS、文档与压缩包逐资产解析，部分结果保留原因，容量失败回滚记录。 / `DATA_ANALYSIS_PARSER_URL` configures the private parser origin and is supplied by the complete Data profile. Workbook, document and archive analysis retains partial reasons and rolls back records on capacity failure.

地理分析只读取同版本清单里的格式伴随文件，并逐文件核验哈希；ADF 头文件产生覆盖记录，其余成员保留为格式组附件。 / Geospatial analysis reads only same-version manifest companions and verifies each hash; the ADF header produces coverage records while other members remain accounted-for format companions.

## Embedding projection rebuild / 嵌入投影重建

`src/embedding-rebuild-cli.ts` reads the configured project's authority evidence and writes a separate model-profile Weaviate collection with a resumable checkpoint and advisory lock. It leaves original publication state and other projections unchanged. API and Worker share `DATA_EMBEDDING_*`; tests use fake, while production requires a real provider. Run the configured Worker command `pnpm --filter @wiser/data-worker exec tsx src/embedding-rebuild-cli.ts` with the current Compose/runtime files, including `compose.override.yaml`. See the [local environment guide](../docs/src/content/docs/en/development/local-environment.md) for staging, verification, cutover and rollback.

该 CLI 在明确的项目范围内从权威证据重建独立模型集合，以独立位点和 advisory lock 支持续跑；不修改原发布状态及其他投影。API 与 Worker 共用 `DATA_EMBEDDING_*`，测试保留 fake，生产要求真实 provider。切换前按[本机环境指南](../docs/src/content/docs/zh-CN/development/local-environment.md)完成重建和检索验收，保留旧集合供回退。

The live consumer has a separate checkpoint for each real embedding profile and configured consumer name. It replays Weaviate writes despite shared success ledgers, skips other successful targets, and advances only after projection and publication succeed. Its first activation traverses retained history independently of the rebuild CLI; later starts resume. Fake retains the legacy checkpoint. For cutover and rollback, let the selected Worker profile catch up and verify coverage before changing API reads.

持续消费者按真实嵌入配置和消费者名称使用独立位点，不把共享台账的成功视为当前集合已完成；仅重放 Weaviate，跳过其他成功投影，投影与发布成功后才推进位点。首次启用独立遍历保留的历史，之后续跑；fake 保留原位点。切换与回退都先让所选 Worker 配置追平并验收，再切换 API 查询。

## Business relation projection / 业务关系投影

The Worker also runs a bounded authority reconciliation for reviewed business relations through the shared Data infra adapter. Its cursor and labels are independent of legacy publication/provenance projections. Approval and source withdrawal change the next sweep's writes; API authority checks apply immediately. Failures leave the cursor unchanged. / Worker 使用共享 Data infra 适配器分批同步已审核业务关系，位点与标签独立于已有发布/溯源投影。审核及来源撤回影响下一轮写入，API 权限检查立即生效；失败保留进度。

To rebuild a configured business projection after it is removed, use the existing Worker environment and pinned Compose files, including `compose.override.yaml`, with `pnpm --filter @wiser/data-worker exec tsx src/business-rebuild-cli.ts`. It completes the retained sweep and one full sweep with a per-project/target lock, preserving assertion IDs, originals and reviews. Keep one change owner for the target; inspect and verify an isolated target before any shared cutover. / 重建使用已有 Worker 环境，保留本地 Compose override，并执行上述命令。它完成保留进度及一次完整扫描，以项目/目标锁避免相互覆盖，原断言、原件与审核记录保留；共享切换前先验证隔离目标。

XML元数据通过现有隔离解析器按节点保留命名空间、路径与原文；不推断数值、坐标或科学含义。 / XML metadata uses the existing isolated parser, preserving namespaces, source paths and lexical content without inferring numbers, geometry or scientific meaning.

候选解析使用冻结入库／审核／处理批次及原件身份，不能借用已发布版本ID。隔离解析器只接收原件及其哈希，Worker绑定记录ID并保留原文定位、部分解析状态和既有失败规则。默认任务在冻结检查点后持久保存候选，受管读取沿用当前维护或独立审核权限；真实Auth、原件下载与完整保存流程仍单独验收。 / Candidate parsing uses frozen ingestion/review/batch and original identity, never a borrowed published-version ID. The isolated parser receives original bytes and hashes only; Worker binds record IDs while retaining locators, partial outcomes and existing failures. The default Job persists frozen candidates; managed reads enforce current maintenance or independent-review authority. Live Auth, original download and the complete saved-view workflow remain separate acceptance gates.

Candidate reads require additive Data migrations 0037–0039 and runtime-role provisioning. Original parsing reads only canonical FINGERPRINTED assets with CLEAN scan and matching input/asset/blob hashes and byte sizes; completed histories remain immutable. / 候选读取须应用独立Data迁移0037—0039并配置运行角色；解析仅读取扫描CLEAN且输入／资产／内容对象哈希与字节数一致的标准FINGERPRINTED原件，完成历史不可修改。

私有 `word_structure.py` 读取器用已有 `defusedxml` 直接处理实际 DOCX ZIP/XML 字节，返回支持范围内的全部物理表格，包括嵌套表格、单元格定位、列位／跨度／纵向合并、明确的单元格／表宽、网格宽度、空文本和全部段落。主文档、页眉、页脚、脚注、尾注及批注保留稳定的部分定位；月份标题只是段落原文中的字面子集。危险归档、DTD／实体、不支持的修订／旧式合并／替代内容、过深结构或超限均明确失败，不返回部分结构。旧记录解析器及 HTTP 请求不改。可选 `createCandidateConversionHostRunner` 必须显式核对可执行文件／提取器源码哈希、实际稳定工具版本及平台，使用独立临时 profile、清洁进程环境、有界输出及每个子进程最多120秒的期限。权限回调错误直接传播，严格的私有 `UNVERIFIABLE` 结果保留原四类原因。默认不启用该工厂；它不证明工具来源、许可、依赖库或操作系统沙箱合格。合成 DOCX／schema 及测试可执行程序的进程检查不代表真实 O → R′ 转换、PostgreSQL 并发或 A13 验收。 / The private `word_structure.py` reader consumes actual DOCX ZIP/XML bytes with existing `defusedxml` and emits every supported physical table, including nested tables, cell locators, column/span/vMerge, explicit cell/table widths, grid widths, empty text and all paragraphs. Main document, headers, footers, footnotes, endnotes and comments use stable part locators; month titles are a literal subset of preserved paragraph text. Unsafe archives, DTD/entities, unsupported revision/legacy-merge/alternate content, excessive depth or budgets fail without partial structures. The legacy record parser and HTTP request remain unchanged. The optional `createCandidateConversionHostRunner` requires explicit executable/source hashes, exact observed stable tool version and platform; it uses private temporary profiles, a clean process environment, bounded output and per-process deadlines of at most 120 seconds. Its authority callbacks propagate errors, and strict private `UNVERIFIABLE` outcomes retain the existing four reasons. The factory is not enabled by default and does not certify the tool's source, license, dependent libraries or operating-system sandbox. Synthetic DOCX/schema and executable process tests are not real O → R′ conversion, PostgreSQL concurrency or A13 acceptance.

`structure.pythonPath` 只校验绝对路径，工厂不固定解释器摘要；提取器脚本哈希不能证明解释器及依赖闭包可信。只有核心会话已实际准入的完整任务运行镜像，或已准入的宿主解释器及全部依赖闭包，才可使用该工厂；已有 parser 基础镜像摘要不覆盖任意宿主 Python。当前完整运行环境尚未准入，稳定转换包的取得及哈希核实不等于安装或运行准入。真实八份 DOCX 的不支持构造清单、原值及 A13 核对仍是后续验收，未完成这些核验。 / `structure.pythonPath` is checked only for an absolute path; the factory does not pin the interpreter digest. A pinned extractor script does not establish the interpreter or dependency closure. Use the factory only within a complete task runtime image, or a host interpreter and its complete dependency closure, that the core task has actually admitted. The existing parser base-image digest does not cover arbitrary host Python. That complete runtime has not yet been admitted; obtaining and hashing a stable converter package is not installation or runtime admission. The unsupported-construct inventory and original-value/A13 checks for the eight real DOCX files remain future acceptance work, not completed checks.
