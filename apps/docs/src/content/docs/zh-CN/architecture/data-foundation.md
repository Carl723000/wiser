---
title: 数据基座领域架构
description: 数据基座当前的资料权威、接入、探索、访问权限及验证边界。
docType: architecture
scope: data-foundation
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 修改 Data Foundation DTO、Capability、状态机、权威数据或发布门禁时
  - 实现或审查 data-postgres、对象存储、Worker、投影、API、MCP、Skill 或 Web 时
whenToUpdate:
  - 公开契约、状态转换、权威源、投影或完成边界变化时
checkPaths:
  - packages/data-*/**
  - apps/data-worker/**
  - apps/api/src/data-foundation/**
  - apps/mcp/src/data-foundation/**
  - apps/web/src/app/*/data-foundation/**
  - infrastructure/data-foundation/**
lastReviewedAt: 2026-10-08
lastReviewedCommit: 82f2dcbc194c226f667572e1f670533c76dd3083
---

## 当前可运行能力

| 领域       | 当前能力                                                                    | 必须保留的边界                                                   |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 权威数据   | 数据基座管理原件、固定版本、接入、质量、血缘与数据操作                      | 人员、会话、组织、项目和成员资格由 Supabase 管理                 |
| 数据接入   | 获准的用户和智能体通过智能体或 API 登记来源、上传、检查、审核并发布固定版本 | 当前网页工作区按任务编号查看进度；上传和登记检查不代表科学完整性 |
| 数据探索   | 同一授权查询联动目录资料、解析记录、地图、关系和统计                        | 数量保留各自计数对象；位置和候选关系须另行核验                   |
| 访问权限   | 每次读取或操作均核对项目成员资格、来源许可、资源授权和用途                  | 网页与 AI/MCP 的资料用途分别授权                                 |
| 外部元数据 | 已登记来源可通过有界站点目录读取器查询                                      | 默认读取器未启用；真实供方连接及实时许可须由可信宿主配置         |

面向使用者的操作见[现网资料指南](/development/wiser-data-guide/)，可调用操作见 [Data REST 协议](/protocols/data-rest/)。本页解释这些任务背后的权威、状态和实现边界；精确协议字段仍以运行时能力清单与 schema 为准。

## 外部元数据读取边界

外部元数据 reader 通过已注册的只读能力 `data.external.metadata.read` 提供，只接收来源标识、明确年度范围和有界数值分页。可信宿主端口必须解析当前 WISER 成员权限与提供方来源许可；请求 JSON 不得提供许可、令牌、字段表或 URL。读取前后均核对主体、委派、租户、项目、用途、授权版本、安全上限、许可年份、字段集合及有效期；在途授权变化或取消会丢弃该页。仅返回站码、年份及获准行政标签，坐标与观测数值不返回；不完整页和提供方失败不能作为空结果。

该组件不创建资料资产、索引或存储观测。宿主配置的 HTTP 适配器只向固定端点请求一页规范化元数据，不跟随重定向，凭据仅放请求头。必须使用 HTTPS；隔离测试可显式允许字面回环地址 HTTP。超时覆盖响应头和正文（默认10秒、最多30秒）；解压后的响应字节受限（默认256 KiB、最多1 MiB），压缩响应也不能绕过上限。提供方拒绝、超时、内容异常和调用方取消返回稳定脱敏错误，不作为零条成功。页面结果不缓存，提供方正文不记录或持久化。该传输层不代表某个真实供方协议已适配，也不授予来源访问许可。

REST、GraphQL及Registry驱动的MCP复用现有身份、严格校验和仅哈希审计。REST与GraphQL响应禁止缓存；GraphQL元数据别名也不复用请求级缓存。客户端断连会取消外部读取，命令仍保留原生命周期。默认运行时注册未启用执行器，返回 `EXTERNAL_SOURCE_UNCONFIGURED`；只有可信宿主注入具备实时来源许可的读取器后才可读取。注册能力不等于启用真实来源或授予元数据权限；真实供方配置、网页状态和来源验收仍需单独完成。

## 权威边界

Data Foundation 是与 Agent EXCON 平级的 WISER 业务系统。它拥有 DataItem、不可变版本、资产、入库、质量、血缘、知识、检索、GIS、Operation 与投影事实；它不拥有用户 Session、Tenant、Project、Membership、Role 或 Token。Supabase Auth/PostgreSQL 是统一身份与控制面，独立 data-postgres/PostGIS 与 S3 兼容对象存储构成 Data 权威面。

默认 Data runtime 组合：

```text
Supabase principal + Tenant/Project/Purpose
  → Fastify REST / schema-first GraphQL
  → 由当前 Registry 驱动的 DataCapabilityHandler
  → data-postgres RLS transaction / SeaweedFS S3
  → PostgreSQL durable job + Transactional Outbox
  → Data Worker
  → PostGIS spatial readiness（同一 data-postgres）
  → Weaviate / OpenSearch / Neo4j / STAC 可重建外部投影
  → REST / GraphQL / MCP / authenticated Web readback
```

GeoServer、TiTiler 和 Martin 作为 Compose-internal GIS 服务存在于同一个精确锁定 profile，不发布 host port；外部只经过统一 Auth 的 Fastify GIS 代理。Outbox ledger 有五个完成目标。`POSTGIS` 目标在权威 data-postgres 内建立/验证受治理的 `catalog.spatial_extent` 空间表示；其 source/version/spatial authority rows 不能当作可丢弃外部投影。Weaviate、OpenSearch、Neo4j 与 STAC 是可重建外部投影。任何单一 target 都不承担身份、授权、验收或发布决定。

## 包与依赖方向

| 模块                                        | 职责                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `@wiser/data-contracts`                     | 严格 Zod DTO、Capability 发现及四种传输映射                                 |
| `@wiser/data-core`                          | 纯确定性的入库/Operation 状态机、质量、安全继承和发布门禁                   |
| `@wiser/data-infra`                         | checksum migration、PostgreSQL/S3、任务/Outbox、投影、检索和 fake embedding |
| `@wiser/data-worker`                        | 具体入库 Handler、Scheduler、投影 consumer、健康与指标                      |
| `apps/api`                                  | 统一身份后的 REST/GraphQL 服务与受控原件交付                                |
| `apps/mcp` / `skills/wiser-data-foundation` | 只经 HTTP 的 Agent 适配层                                                   |
| `apps/web`                                  | 支持授权读取与受控操作的双语工作区                                          |

依赖固定为 `platform contracts <- data-contracts <- data-core <- application/infra <- apps`。Core 不导入数据库、HTTP、文件系统、框架、时钟、随机或 AI Provider；时钟、ID 与外部效果全部通过 Port 注入。

## 单一 Capability 契约

`@wiser/data-contracts` 是 REST、GraphQL、MCP、Skill 与 runtime validation 的唯一契约源。公开对象使用 strict Zod 4 schema；未知字段和缺失必填字段均失败。`GET /api/data/v1/capabilities` 返回 draft-7 输入/输出 JSON Schema、Scope、安全上限、执行模式、timeout、audit level 以及精确的四种 transport mapping。

Registry 覆盖 catalog/version、query/search、knowledge/graph、geo、upload/ingestion 与 Operation 生命周期。精确 Capability ID、顺序、版本、Scope 与各 transport mapping 只由 discovery endpoint 和[协议参考](/protocols/data-rest/)维护，架构页不复制第二份清单。

所有执行器统一经过输入/输出校验、实时 Scope、安全等级 ceiling、Purpose、声明 timeout、command 幂等和 hash-only audit。查询只接受结构化 filter；不接受任意 SQL、Cypher、OpenSearch DSL、shell 或数据库管理命令。

本机 `data-steward` Role seed 覆盖演示所需的最小 Scope。新增 Capability 时必须同时更新 Registry、Role/Scope、API、MCP、Skill、文档和验证。

## 数据模型与独立迁移历史

数据基座的 SQL 不进入 Supabase 迁移历史。`infrastructure/data-foundation/postgres/migrations` 中经过校验和核对的文件是唯一正式历史。完整的当前顺序以该目录为准：早期迁移建立权威模型、RLS、任务与发布生命周期及受控 GIS；后续迁移扩展探索、证据、资源范围和关系完整性，同时保留既有历史。

迁移执行器按四位版本排序，在 session advisory lock 下逐文件事务执行，并记录文件名和 SHA-256。已执行文件缺失、改名、内容漂移或非前缀历史会失败关闭。pgSTAC 使用官方 pyPgSTAC 0.9.12 migration，不伪造成 PostgreSQL extension。

业务表全部 `ENABLE` 且 `FORCE ROW LEVEL SECURITY`；另有独立 `schema_migrations` ledger。API 和 Worker 通过部署脚本创建的不同非超级用户 role 访问，migration 不隐式授予 runtime。每个事务必须设置并验证 Tenant、Project、最高安全等级和 policy version；缺任一上下文返回零行或失败。

Martin 使用隔离的 `wiser_data_gis` 登录：`NOSUPERUSER`、`NOBYPASSRLS`，不继承通用 runtime role、没有业务表权限，只能执行 `service.wiser_spatial_extent_mvt`。该 security-definer function 严格接收 `tenantId/projectId/versionId/maxSecurityLevel/policyVersion` 五项 query 参数，在 SQL 内再次过滤 Version 与 spatial extent。

API 矢量瓦片先对 Version/spatial extent 做 RLS 授权，再给该 function 注入五项上下文。栅格瓦片只从可见 RAW asset 中选择 TIFF/GeoTIFF COG，验证 `tenants/.../versions/{versionId}/sha256/{hash}` 内容寻址 key 后，才在服务端生成 TiTiler 使用的内部 S3 URI；浏览器不能选择对象或 upstream。

Operation event、Audit event、Outbox、content/version 历史由 trigger 拒绝不合法的 UPDATE/DELETE。Operation、Ingestion Session、Job 与 Transform Plan 的数据库边界还强制合法生命周期边、identity/scope/policy 不可变、上传安全等级不可降低、冻结计划内容不可改，以及每次只允许 `row_version` 增加一；即使 runtime role 拥有表级 `UPDATE` 也不能绕过，Operation 终态内容也不能重写。仅保留非终态 Operation 进度聚合、运行中 Job 的 heartbeat/取消请求、所有确定性事实都相同的 Transform Plan 重放所需的窄同态更新。多 Job 聚合可让 Operation 在两个等待状态间转换；上传直接完成在 Core 与 PostgreSQL 中都限定到对应 Capability。复杂转换使用显式事务、行锁/乐观版本、唯一约束与 append-only 事实。

## 权威对象与提交

`DataItem` 是最小治理粒度，不等于文件、表或图层。processing stage、quality grade、acceptance status、publication status 与 L0–L3 security level 相互独立。

SeaweedFS adapter 强制 path-style S3，并只从已验证的 Tenant/Project/Upload/Version UUID 与小写 SHA-256 派生 key。客户端不能提交任意对象路径。上传支持无歧义的 `PRESIGNED_PUT` 与 `MULTIPART`；签名 URL 只存活 60–900 秒。完成前 HEAD 必须同时匹配 size、content type 与 SHA-256 metadata。

内容先停留在 `quarantine`。指纹后 `catalog.content_blob` 保存内容身份，正式提交把对象幂等提升到内容寻址的 raw/version key；相同 hash 可复用，不同 hash 永不覆盖。Abort 只能删除派生 quarantine 对象。API 读取版本资产时重新核验 Supabase 身份和 data-postgres RLS，并记录审计。受管理资料通过 API 流式交付，途中持续复核权限；旧资料仍可能使用短期签名重定向。STAC 清单不暴露长期存储凭据。

MCP Evidence/STAC Resource 通过真实 HTTP 权威边界读取。Evidence GET 只读取调用方 RLS 可见且关联已提交版本的 fragment，并追加 `data.evidence.read` hash-only audit。STAC GET 先把 collection 绑定到当前 Tenant/Project，再从固定内部 STAC origin 有界读取，剥离上游内部字段，并在 data-postgres 中复核已发布/已验收版本、Evidence、source hash、安全等级、policy 与质量；通过后追加 `data.stac-item.read`。两个 JSON 响应都不超过 256 KiB，STAC asset 只能指向上述短期授权下载入口。

正式版本只能从已批准且冻结的 review checkpoint 创建。一个 data-postgres 事务提交 DataItemVersion、质量/血缘事实、Operation event、Audit 与 Outbox；Supabase、data-postgres 和 S3 之间不伪造分布式事务。

## 确定性入库与 Agent 边界

项目可启用服务器维护的 `REQUIRE_INDEPENDENT_REVIEW` 策略。入库冻结其模式和修订号，并从已验证 Auth 保存不可变的提交人、委托人引用；同一策略进入审核哈希与正式版本资产清单。启用后，公开且高置信度的输入也停在待审。策略缺失、撤销或变更均停止后续处理，客户端参数不能关闭该策略；这些限定范围的引用不构成另一套身份权威。

最终批准须由有权限且不同于提交人及其委托人的真人执行，幂等重放也重新检查。历史责任缺失时不猜填。Worker/runtime 数据库守卫拒绝自动批准和未审核版本的提交、发布。未配置策略的项目保留已有自动路径；真实专业审核仍单独决定。

存在冻结或当前审核策略的会话，其专业`data.ingestion.reject`在写入审核记录前复用独立真人与当前策略检查，缓存命令重放也重新核验；当前会话已不可读取时拒绝重放。两种策略均不存在的旧驳回行为保留，`data.operation.cancel`仍是独立的非审核退出动作。数据库继续允许FAILED、CANCELLED和REJECTED安全退出，这不构成专业审核API的授权。命令Schema、受管能力准入和发布守卫保持不变。

研究数据包可在入库时选择可选的 `sourceRegistration` 类型。迁移 `0010_source_registration.sql` 将不可变的来源描述保存在受 RLS 保护的 Ingestion Session 中。有界 JSON 清单把来源、原始路径与哈希、脱敏副本、部分下载/样本/空文件状态及每个上传资产绑定到精确大小和 SHA-256；缺失、重复、多余或内容变化都会失败。零字节来源单独登记，不伪造非空上传。

准备后内容完全相同的不同路径可以引用同一个内容资产。每个路径仍保留各自的原始/准备后大小和哈希、处理方式、完整性与来源关联，且必须逐项匹配该资产；重复路径和重复的权威资产身份仍然无效。Skill 在每个来源登记内按准备后内容哈希只上传一次，并在清单和有界证据片段中保留全部路径别名。

该类型的验证范围是**来源登记**：保留原始对象，通过确定性清单校验创建包含来源名称、提供方和限制说明的 `METADATA_QUALITY` / `DECLARED` 版本，不运行文档/GIS 解析或 AI 映射计划。质量通过只表示登记完整性检查通过，不推断分析有效性、数据集完整性、许可或地理正确性。病毒扫描、指纹、安全继承、复核、事务/审计/Outbox 与发布门禁仍然生效。冻结的来源限制会进入证据、图谱和 STAC 检索投影。

入库使用 18 个状态：

```text
RECEIVED → QUARANTINED → SECURITY_SCANNED → FINGERPRINTED
→ PROFILED → CLASSIFIED → SCHEMA_MAPPED → SEMANTIC_MAPPED
→ VALIDATED → SPATIOTEMPORAL_ALIGNED
→ REVIEW_REQUIRED / APPROVED / REJECTED
→ COMMITTED → PROJECTING → PUBLISHED

允许的非终态可按政策进入 FAILED 或 CANCELLED；
REJECTED、PUBLISHED、FAILED、CANCELLED 为终态。
```

默认 Worker 以具体 `data.ingestion.process.v1` Handler 执行入库：

1. 从权威表恢复上传资产和当前版本；
2. 通过 S3 reader 核对 size/media type；
3. 使用 ClamAV INSTREAM 扫描；
4. 流式计算 SHA-256 并固化指纹；
5. 用 Tika 解析 Markdown/文档，用受控 GeoJSON parser 保留来源 CRS；
6. 生成确定性 profile/classification；
7. fixture fake Agent 提出 schema/semantic plan，注入 validator 校验置信度与形状；
8. 确定性 transformer、质量规则与 EPSG:4326/4490/3857 对齐执行；
9. 冻结 hash-only review checkpoint，低置信度/高风险进入人工审核；
10. 批准后提交权威版本与 Outbox，等待五个 completion target ledger 成功再发布。

Tika 4 只运行在 Data 私有网络中。Worker 保持显式的 `PUT /rmeta/text` JSON 契约；挂载的服务端配置将请求限制为 16 MiB、抽取输出限制为一百万字符、总解析时间限制为 30 秒，并把 fork 池限制为一个子进程。HTTP `429` 与 `503` 仍作为可重试依赖失败，格式错误的 `400` 与超限的 `413` 则为终态失败。这样既吸收 Tika 4 的进程隔离与背压语义，也不向外暴露其原始错误正文。

Agent 只提出解释与计划，不能修改原始数据、静默纠正字段、决定质量/验收、绕过审核或直接写权威/投影存储。fake Agent 和 `DeterministicFakeEmbedding` 只用于测试、CI 与本机 smoke；同文本、版本和维度产生相同有限向量。Worker 记录 Agent run/action、模型 identity、input/output hash 与 transform plan，不把 prompt、凭据或对象正文写入 audit。

质量门禁只读取确定性检查；blocking rule 失败时即使总分过阈值也不能通过。派生安全等级取全部来源最高值，只能显式提高不能降低。发布要求已提交版本、可发布验收、通过质量门禁、`PROJECTING` 状态和五个唯一 `SUCCEEDED` completion target。

## 持久任务、Outbox 与投影

Worker 使用 PostgreSQL `FOR UPDATE SKIP LOCKED`、lease owner/expiry、heartbeat、priority、attempt count、确定性指数退避、取消、等待输入/审核、超时回收和 dead letter。带时间参数的 claim function 在更新前保留被选中行的真实 previous status；缺少 Job Attempt/Event/Outbox 语义的旧 claim function 已从数据库删除。Native Node HTTP 暴露 `/health/live`、`/health/ready` 与 Prometheus `/metrics`，优雅关闭先停止领取并等待 in-flight Handler。

`data.ingestion.process` 的排队及人工审核等待不占用执行时限。每次领取任务时开始六小时执行时限；租约过期仍按有限重试处理。对于旧版已过排队期限、但从未被领取的任务，可携带当前 Operation 版本调用 `data.ingestion.resume`：保留原资产、Job 与 Operation ID，只清除旧排队期限，并追加 Operation 事件、审计和 Outbox。已领取、已取消和终态任务不能使用该恢复入口；其他 Job 类型保持原有期限规则。

`ProjectionOutboxConsumer` 读取单调 checkpoint。每个 target 的 `PENDING/RUNNING/SUCCEEDED/FAILED` ledger 跨崩溃保留；外部写成功但 ledger 尚未更新时可安全重试。持续运行的 Worker 按真实嵌入配置与消费者名称派生独立位点；位点之后的事件即使已在共享台账标记成功，也会写入当前 Weaviate 集合，其他成功 target 仍跳过。fake 保留原位点以兼容样本和回退。首次启用会独立于重建 CLI 遍历保留的历史，之后续跑；切换和回退均先让 Worker 追平并完成验收，再切换 API 查询。投影 identity 由 DataItem/Version/Evidence 等权威 ID 派生：

若五个 completion target 已成功，但对应 Operation 已进入 `FAILED` 或 `CANCELLED`，该 publication poison event 不得改写 Operation 终态，也不得发布权威版本。Consumer 以 `PUBLICATION_OPERATION_TERMINAL` 写入 `consumer_checkpoint.last_error` 并推进该 event，避免队首永久阻塞；后续成功 event 清除摘要。原 Job、Operation、target ledger 与版本证据全部保留。

- data-postgres/PostGIS 的 `catalog.spatial_extent` 保存受 RLS 保护的 source geometry、CGCS2000 canonical geometry 与 Web Mercator display derivative；权威记录不可随投影缓存清空；
- Weaviate 使用 Worker 提供的固定版本向量与受认证 tenant；
- OpenSearch 使用受治理 ICU 索引；
- Neo4j 使用固定参数化 `MERGE`；
- pgSTAC 写 STAC 1.1 Collection/Item，asset href 指向受控 API 下载入口。

### 中文与中英混合检索合同

正文以中文为主、允许英文与中英混合，但三个检索投影不重复承担同一信号：

- **OpenSearch 是正文词法主召回。** `wiser-evidence-v2` 对同一 `content` 建立三个受控字段：ICU 主字段先做 `nfkc_cf` Unicode 兼容归一化，再执行 `icu_tokenizer` 与 `icu_folding`；官方 SmartCN 字段补充简体中文词典/HMM 边界；低权重 CJK 字段用重叠双字词兜底分词歧义。查询固定组合 ICU `3`、SmartCN `2`、CJK `0.75` 与 ICU phrase `4`，至少一路命中；权重只是在建立 judgment set 前的受治理基线，不能替代 Recall/NDCG 评测。通用 n-gram、非官方 IK 与未经审阅的同义词文件不进入默认生产路径。参见 [OpenSearch ICU analyzer](https://docs.opensearch.org/latest/analyzers/language-analyzers/icu/)、[CJK analyzer](https://docs.opensearch.org/latest/analyzers/language-analyzers/cjk/)与[官方插件清单](https://docs.opensearch.org/latest/install-and-configure/additional-plugins/)。
- **Weaviate 是纯向量语义召回。** `WiserEvidenceChunkV2` 继续使用 Worker 提供的版本化向量，但 `semantic` channel 改用 `nearVector`，不再在内部重复 BM25；因此 OpenSearch lexical 不会在外层 RRF 中重复投票。正文只存储、不建倒排索引；Tenant/Project/Version、安全、发布与 channel 等字段使用 `field` tokenization 并只为实际过滤建立索引。查询与写入向量必须精确匹配配置维度，租户由受控写入显式创建，`autoTenantCreation` 关闭。参见 [Weaviate bring-your-own vectors](https://docs.weaviate.io/weaviate/concepts/search/vector-search#bring-your-own-vector) 与 [multi-tenancy](https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy)。
- **Neo4j 是图种子召回。** Worker 在写图前幂等创建并等待 `wiser_entity_name_cjk_v1` ONLINE；该全文索引对 `WiserEntity.name` 使用官方 `cjk` analyzer、同步更新，再按 Lucene score 排序并沿 `EVIDENCED_BY` 回到 Evidence。用户查询只允许 NFKC 后最多 64 个 literal term，所有 Lucene 特殊字符由服务端转义；Tenant、Project、安全、policy、验收与发布条件同时复核 entity、relation 与 evidence。内置 CJK 是双字词 analyzer，不处理简繁转换、拼音、领域词典，也不能可靠召回长文本中的单汉字，因此 Neo4j 不替代 OpenSearch 正文检索。参见 [Neo4j full-text indexes](https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/full-text-indexes/)。

每个 backend 先形成独立排名；`SearchOrchestrator` 再执行固定 `RRF k=60`，不直接相加 OpenSearch BM25、Weaviate distance 与 Neo4j Lucene score。OpenSearch analyzer、Weaviate schema 或 Neo4j analyzer 变化都使用新版本物理索引/collection，从 data-postgres 权威事实重放投影并完成中文、英文、中英混合 golden queries 后切读；不能让 `IF NOT EXISTS` 或一次 schema `200` 掩盖旧索引语义。测试/CI/本机 smoke 仍使用确定性 fake embedding；生产语义召回必须另行选择并锁定一个经过中文/英文评测的 embedding model、版本和维度。

对应 query adapter 下推 Tenant、Project、Version、security、policy version、acceptance、publication、domain 与 channel filter。`SearchOrchestrator` 并行召回，固定 `RRF k=60`，按 DataItem+Version 去重，再逐条授权并脱敏 excerpt。

## 协议与产品面

图谱工作区在客户端按需加载 G6 5.1.1，只绘制受治理 HTTP 返回的有界结果。可用键盘操作的实体列表与选择详情保留精确 Version/Evidence 来源，画布不可用时仍可查看。等待在途绘制结束后释放画布资源，主题变化复用语义 token；初始布局是确定性的，不表示空间关系。

数据总览使用 `includeTotal=true` 取得受授权的目录总数，指标不再取预览页大小。目录计数和当前页使用同一个短 repeatable-read 权威事务。该数量表示登记对象，不表示已经通过分析验证的记录。

- REST：`/api/data/v1` 的能力发现、Operation SSE、Evidence/STAC Resource、受控原件交付，以及唯一外部 OGC/STAC/矢量/栅格 GIS 代理；Fastify OpenAPI 直接由 Zod 4 Registry 的当前能力生成，GIS GET 使用显式安全 route Schema，共享文档标题为 **WISER Platform API**；见 [Data REST](/protocols/data-rest/)。
- GraphQL：`POST /graphql`，36 个 schema-first field 共用同一 Handler；见 [Data GraphQL](/protocols/data-graphql/)。
- MCP：stdio/无状态 Streamable HTTP，36 个 Tool 与受控 Resource 都只调用 HTTP；见 [Data MCP](/protocols/data-mcp/)。
- Skill：`skills/wiser-data-foundation` 定义发现、查询、上传、入库、Operation 与安全解释流程。
- Web：现有 Next.js 应用中的 14 个 Data route，server-only DAL、真实 Supabase Session、双语/主题、不可变版本选择，以及高德 JS API 2.0 官方底图与同步的透明 MapLibre 业务图层：PostGIS authority GeoJSON、STAC extent、受控 vector MVT 与 raster 四图层。

DataItem detail 的 `?version=<uuid>` 会把指定版本送入 API 并核对 `selectedVersion`，版本列表以 `aria-current` 切换并可打开受控地图。地图查询为 `?bbox=minx,miny,maxx,maxy&dataItem=<uuid>&version=<uuid>&crs=EPSG:4326|EPSG:4490`，可分别切换四图层，显示固定 Version 与 高德显示校准状态。对 `data.geo.query`，省略单数 `versionId` 时，从每个 DataItem 的最新可见且已提交版本选择 extent；指定时则从该精确不可变版本选择 extent；每次响应受 `first` 限制，并用绑定 snapshot/query/scope 的不透明 `nextCursor` 继续。若同时给出 `dataItemIds`，它与上述版本选择取交集；版本不可见或不存在时返回空结果集。`data.geo.intersect` 使用同样的 snapshot cursor，先选择 DataItem target 的版本，再合并该版本全部 sibling extent；任一 target 不存在、不可见或无 extent 时返回空结果，绝不回退历史版本。Map server 必须在权威 PostGIS 版本排名之前把选定的 `versionId` 传入查询，受控取完不超过 10,000 个 feature 的分页，并在 cursor 重复或越界时 fail closed，不能先取最新版本再做事后过滤。浏览器只请求同源 `/api/data-foundation/geo/...`；Next server 使用刚验证的 Supabase 短期 Session 追加 Tenant/Project/Purpose 后转发 Fastify，Bearer 和内部 GIS origin 永不进入客户端。

每个当前 `DataItemVersion` 都必须带有权威 `tileAvailability: { vector, raster }`。`vector=true` 表示这个可见、已提交 Version 存在可见的版本级 spatial extent；`raster=true` 表示存在可见 RAW TIFF/GeoTIFF asset，且 blob/hash/input 关联和内容寻址 storage key 全部有效。这两个布尔量只表示受控 tile source 可路由，不代表 Martin/TiTiler 健康，也不证明 COG 合规。Catalog 链接同时携带 DataItem 与 Version，Map 在生成任一 tile URL 前会重新读取该精确权威配对。

Web 负责治理与查询，不在 Server Action 或 Route Handler 执行文件解析、向量化、GIS 转换或投影。其同源 GIS Route Handler 只是有界认证代理；mutation 由 REST、GraphQL、MCP 或 Skill 发起。

## 依赖与可执行验证

npm 的精确版本由对应 `package.json` 与根 `pnpm-lock.yaml` 定义；Data 容器的稳定 tag、digest 与兼容注记由 `compose.yaml` 和 `infrastructure/data-foundation/versions.env` 定义。架构文档不复制这些会频繁变化的清单。

`pnpm data:smoke` 从上传、扫描、解析、受控 Agent 计划、确定性转换、质量/人工门禁、权威提交与 Outbox 一直验证到全部投影，并通过 REST、GraphQL、MCP 和登录后的 Web 回读；重复消费同一 Outbox event 不得创建重复权威或投影对象。完整命令矩阵见[测试与验证](/development/testing/)，数据库重置与迁移纪律见[数据库与迁移](/development/databases/)。

## 固定版本的统一探索

`data.explore.query` 从调用者可见的已发布版本建立有效期 30 分钟的结果集。声明式 `QuerySpec` 支持文本、数据项 ID、明确的版本对、业务领域和质量等级；未指定版本时选择每个数据项最新可访问的已发布版本。服务端清单固定最多 10,000 个版本引用，资源页最多 200 条；超过上限需要缩小查询范围。

每次续查都绑定 Actor、Tenant、Project、Purpose、精确授权版本和安全上限。PostgreSQL 强制 RLS 保护清单，各视图还会重新核查引用的数据项及版本是否仍可访问且已发布。授权或发布变化使续查失效，不会静默改变结果集；新发布的版本也不会替换已固定版本。这固定的是版本成员，不是跨投影存储的分布式快照。就绪状态与分析数量独立：只有登记的资源返回 `NOT_PARSED`，未知记录数为 `null`。

Web 的 `/zh-CN/data-foundation/explore` 工作区复用这些契约，通过 Next.js API adapter 使用当前 Supabase Session，提供紧凑资源表格、查询、固定结果集分页与精确版本详情。

`@wiser/data-infra` 的分析解析器核验来源 SHA-256，以流式方式读取严格 CSV，并生成固定版本范围内的稳定记录 ID。源字符串、前导零、中文字段和空值均被保留，字段键与显示名称独立。JSON/GeoJSON 解析保留属性并验证格式声明的 WGS84 几何；普通经纬度属性不能证明 CRS 或几何有效。格式错误、不支持的 CRS 和明确的大小/记录上限返回分类失败。解析不会改变质量、验收、发布、来源完整性或单位。设置 `WISER_DATA_REAL_CASE=1` 的可选测试核对已准入 NLDI 样本哈希和坐标，不提交源内容。

分析契约将请求绑定到已入库的数据项与版本。成功解析的空数据源具有明确的零记录数；不支持、无效或受限的数据源保留未知数量与原因代码；部分解析必须说明原因。

`data.analysis.create` 接收已发布的 `dataItemId` / `versionId` 和幂等键，原子创建带审计的操作与持久化分析任务，不改变来源登记与质量声明。REST：`POST /api/data/v1/analyses`；GraphQL：`createDataAnalysis(input: JSON!)`；MCP：`data_analysis_create`。需要 `data.ingestion.write` 与 `data.catalog.read` 权限；通过返回的操作 ID 查询进度。

探索契约 1.1 将已完成的分析批次与已发布版本共同固定。`view: "records"` 必须提供 `queryId` 和 `versionId`，返回逐资产字段定义、稳定的记录/要素 ID 及有界分页。`view: "map"` 复用同一结果集，支持可选的 WGS84 `[west,south,east,north]` 范围。游标绑定视图与过滤条件。要纳入原查询之后完成的分析，需要重新运行查询条件。数量表示已索引记录，资源就绪状态与覆盖信息同时披露未解析来源。

探索契约 1.2 在同一授权清单上增加 `view: "graph"`。可选 `versionId` 缩小资源图范围；`recordId` 还要求该版本及其固定分析批次中的记录。资源、版本、文件和证据节点具有明确类型，关系表示权威包含关系；聚焦记录与表格、地图共用身份，文件节点保留来源哈希。这一溯源视图不推断科学关系。每页最多包含 100 个版本、200 个文件和 100 个证据片段；`truncated` 披露省略节点，`nextCursor` 翻阅后续版本，改变聚焦条件不能复用游标。此前 1.0 与 1.1 的契约定义保留在归档中。

有界 CSV/JSON 分析器允许每个不超过 64 MiB 的来源最多 2,000,000 条记录。真实北京城市河湖 CSV 包含 1,048,575 行，验证时不把全部解析记录累积在内存中。容量限制与未知坐标系标记为分析暂不支持并保留具体原因，不判定源内容无效；资产回滚后不发布部分计数。

迁移 `0013_analysis_query_scope.sql` 保留分析记录的强制 RLS 及相同的租户、项目、安全等级、策略版本条件，将请求内恒定的辅助函数改为每条语句计算一次。记录分页按选定分析批次和文件的索引顺序读取；总数仍统计获授权的记录，不以更宽范围的资产元数据代替。真实 361,379 行水库来源纳入有界分页的浏览器性能测试。

`infrastructure/data-foundation/parser` 来源解析组件固定使用 openpyxl 3.1.5 的只读工作簿、xlrd 2.0.2 的旧版 XLS 读取与 pypdf 6.18.0。它保留工作表/原始行位置、公式文本和日期语义，将文档内容作为普通文本提取，并校验压缩包路径、加密、展开预算与成员哈希。压缩包保留成员路径、哈希、解析内容和逐成员完成摘要；不支持或失败的成员使整个压缩包明确保持部分可用。Python 依赖使用版本和哈希锁定。

HTML 解析保留原有正文段落顺序，随后追加有界的 `html_table_row` 原表表示，保存表格/行位置、显式表头、跨行跨列信息与原始单元格文字。追加行是表格证据，不是独立观测；不推断单位或统计含义。嵌套、未闭合、超出限制或其他无法可靠解析的表结构保留正文，并以 `HTML_TABLE_STRUCTURE_UNRESOLVED` 明确标记部分解析。后续可根据原表坐标核对表头关系，而不是从扁平文字猜测。

文档提取遇到 PostgreSQL JSONB 无法保存的 U+0000 时，仅在派生文本中替换为 U+FFFD。受影响记录保留 `__text_encoding`：原字符编码、去除段落首尾空白后文本块内从零开始的 Unicode 码点偏移，以及原文本块 UTF-8 字节的 SHA-256。偏移用于区分替换标记与原文已有的 U+FFFD，并能重建提取后的原文本块；它不是 PDF 文件字节位置。资产明确记为 `PARTIAL`、原因为 `TEXT_ENCODING_REPLACED`；后续触发提取上限时保留相应限制原因。原始文件不变，替换位置表示尚未解决的提取缺陷，不表示已校正科学符号或通过专业核验。

HTML原件优先按UTF-8字节顺序标记解码，否则读取正文前、前16 KiB内明确声明的受支持字符集。支持UTF-8及GB2312/GBK/GB18030系列；旧中文编码声明统一用GB18030严格解码。无声明时仍严格使用UTF-8，不支持的声明或非法字节仍标为内容无效，不靠猜测或静默替换生成正文。HTML记录保留`__source_encoding`。这是有界的资料提取规则，不是完整的浏览器编码探测器；原始字节不变。

解析器镜像固定 GDAL 3.13.3 与经过哈希锁定的 Python 环境。内部 `/parse` 协议仅接受具名文件字节与 SHA-256，写入临时目录前校验主文件和伴随文件，并流式返回有界 NDJSON。每个请求使用独立进程，限制 CPU、内存、时长和输出；解析器不具有数据库或身份权威，客户端断开时终止解析。

Worker 解析适配器在传输前核验已准入文件字节，验证 UTF-8 NDJSON 字段、行序与完成总数，并在本地将稳定 ID 绑定到来源版本。流中断会回滚，部分结果必须保留具体原因。

分析任务将 XLSX/XLS、HTML/Markdown/文本、PDF 和 ZIP 资产交给隔离解析器。Worker 在现有逐资产保存点与租约校验下分批保存记录；容量失败会丢弃暂存记录并保留未知数量，加密内容标记受限。部分解析保留逐资产原因，并使完成的分析批次保持部分可用。

解析 NDJSON 使用 HTTP/1.1 分块传输与明确的终止块，避免以关闭连接作为 Node Worker 唯一的完成信号；应用层完成摘要与数量校验仍然必需。

GDAL 组件要求 Shapefile 的 SHX/DBF 伴随文件，保留属性、原始几何与 CRS，并禁用近似基准转换；无法确认坐标系时不产生地图几何。栅格以有界条带核验全部源像元，保留波段、缺测值、掩码、单位、比例与仿射元数据，未索引像元值时明确说明。NetCDF 保留变量维度、单位、日历属性、掩码和有界值，包括带前导零的字符串坐标。截断内容标记无效，不作为成功的空数据集。

Worker 只从同一已准入版本与目录中查找地理伴随文件。Shapefile 格式组不包含无关脚本或相邻目录；ArcInfo 覆盖通过头文件解析一次。物理伴随文件以 `FORMAT_COMPANION` 和零条独立记录保留在对账中，不对每个 ADF 成员重复生成整组记录。传输的每个成员均核验哈希。

解析帧最多 4 MiB，完整输出仍限制为 1 GiB，因而能保留真实案例中六个超过 1 MiB 的多边形（最大约 2.3 MB）的完整坐标。RESDC 主 Shapefile 组的三个文件共核对 8,628 条记录、零个已验证 WGS84 要素，并保留具体坐标系原因。私有案例浏览器检查需设置 `WISER_DATA_REAL_CASE=1`，与 CI 的可丢弃测试数据分别运行。

Word 提取依据实际 OOXML 内容识别格式，即使后缀为 `.doc`；禁用外部 XML 实体，读取正文、表格及页眉页脚的普通文本，二进制 Word 使用 Ubuntu antiword 0.37-17。压缩包内脚本与不支持的格式仅登记，不执行；成员失败时保留已提取内容和明确结果。暂不展开嵌套 ZIP。记录总数包含内容记录和成员摘要，不表示去重后的科学观测数。

探索查询对序列化冲突或死锁最多执行三次完整数据库事务，始终保留调用者范围并重新授权；其他错误不自动重试。记录视图默认优先选择已有索引内容的文件，再考虑零记录的格式伴随文件；用户明确选择的文件仍然优先。

探索契约 1.3 在 `QuerySpec` 中增加提供机构完整名称、登记类型以及内容/空间就绪状态筛选。汇总统计整个已授权且固定版本的结果集，与当前资源页分别显示。分析完成但没有内容资产时为 `METADATA_ONLY`；已解析的空内容为 `EMPTY`；已解析内容没有验证几何时为 `NO_SPATIAL_DATA`，坐标系未知或无法可靠转换时为 `CRS_UNVERIFIED`。无效、受限或不支持的未解析内容保留未知数量；物理格式伴随文件不能证明分析内容可用。已索引内容记录包括来源的多种表示、文档和压缩包记录，不表示已去重的科学观测。契约归档中的 1.0–1.2 定义保持不变。

截断 PDF 流与无效 PDF 页面结构归类为 `INVALID_CONTENT`，保留未知数量和来源完整性，不再将其报告为解析服务失败。

探索契约 1.4 允许在 `view: "records"` 中同时提供 `queryId`、`versionId` 和 `recordId`，从固定分析批次回查一条明确记录。API 自动定位所属文件；若明确指定的文件不匹配，或记录不属于该查询，则返回未找到。单记录回查不能附带续页游标。资源、记录分页、地图和图谱仍绑定版本范围，1.3 契约保留在归档中。

内部查询瓦片源 `service.wiser_exploration_mvt`（迁移 `0014_exploration_tiles.sql`）绑定租户、项目、用户、查询、用途、安全上限及授权版本七项服务端参数。GIS 角色只能执行函数，不能读取业务表。函数先重新检查全部固定成员，拒绝过期或失效查询，再按空间范围选取记录。每张瓦片将点聚合到最多 4,096 个网格，计数只包含授权范围内记录；单要素携带记录、文件、分析批次、版本和资源身份，原始字段通过记录查询回查。线面按瓦片裁切。Web Mercator 表示不覆盖其纬度范围外的极区；超过 3 MiB 的瓦片明确失败，不静默丢弃要素。可回滚的真实 PostgreSQL 集成测试解码 MVT，核对十万个点的聚类计数、响应大小、跨范围拒绝、过期和成员失效。

查询结果矢量入口为 `GET/HEAD /api/data/v1/geo/tiles/vector/queries/{queryId}/{z}/{x}/{y}.pbf`，额外要求 `data.query.execute` 与 `data.catalog.read`。每次请求均在 RLS 下重新校验当前用户的查询清单及全部固定版本和分析批次，然后才调用 Martin。调用方不得提交查询参数，七项范围值全部来自已验证上下文和路径。响应使用 `exploration` 图层及 `Cache-Control: no-store`；过期、撤权或属于其他用户的查询不会访问上游。现有按版本瓦片保留原路径和图层。

探索契约 1.5 增加可选的地图整体 `spatial.bounds`（WGS84；空结果为 null）及 `mercatorFeatureCount`，由同一授权记录集合计算，不受分页影响。浏览器只请求一条初始记录与范围摘要，定位整个结果范围，再按视口加载同源查询瓦片。点选单要素通过 1.4 的精确记录回查获取详情，点选聚合点继续放大。地图分别标明视口要素／聚合点数与可上图记录总数。追加迁移 `0015_exploration_tile_boundaries.sql` 明确接缝点的唯一瓦片归属，防止重复计数。1.4 契约仍保留在归档中。

通过授权后的 Martin `204 No Content` 规范化为内容为空的 `200` MVT 响应，使无数据视口正常显示。这一处理仅适用于已授权的 Martin 请求；其他缺失内容类型的响应仍拒绝通过校验。

当响应表明授权或固定成员范围失效，或结果到达声明的过期时间时，探索工作区一并清除当前查询、选择、文件详情及已渲染视图；从后台或历史页面恢复时再次检查同一截止时间。旧查询的迟到失败不能清除新查询，被中止的请求也不能恢复旧数据。查询表单条件保留，便于重新获取当前有权查看的结果。临时地图故障卸载画布并提供重新加载，不展示上游诊断。

G6 5.1.1 的分层画布在 Next.js 打包的显式同源模块 Worker 中调用固定版本 @antv/layout 2.0.0 计算 Dagre 位置。布局只接收有界节点和边的标识。客户端校验位置有限且完整，并在成功、错误、取消或十秒截止时终止 Worker，不把失败布局悄悄转回主线程。布局完成后再渲染，选择更新保留现有画布。引擎边界最多接收 5,000 个节点和 10,000 条边用于有界压力验证；HTTP 图响应仍执行更严格的契约上限。

探索契约 1.6 增加可选的 `spec.recordQuery`，必须绑定一个显式不可变 `versions` 条目和来源 `assetId`。创建查询前，最多八条文本／数值／空值条件、一项字段升降序排序和最多 32 个不重复的选择列均按固定分析文件的字段模式校验。数值转换接受有限十进制及科学计数值，不改写来源标识或原始 JSON；空值和缺失需使用显式存在性条件。记录页、地图摘要、查询瓦片与图谱记录回查执行相同条件，精确回查不能绕过筛选。排序以原始记录序号稳定打破并列。列选择约束返回的记录字段；目录就绪总数仍表示已索引的来源内容，不暗示跨文件单位换算或科学聚合。追加迁移 `0016_exploration_record_queries.sql` 提供共享条件函数并更新瓦片函数，发现服务仍保留不可变的 1.5 契约。

迁移 `0017_exploration_predicate_compilation.sql` 保持类型化比较语义，并将最多八条条件的表达式交给 PostgreSQL 规划。数值转换采用带格式边界的精确 SQL/JSON 数值解析。记录查询在限定文件范围内只计算一次每个类型化字段，物化记录标识与比较值，在同一关系上完成计数和排序分页，最后仅按当前页标识读取原始内容。空值排序及来源序号的稳定并列顺序保持不变。集成测试先对比 187 组旧、新标量条件结果，再验证 RLS、分页和筛选后的瓦片。

探索 1.7 增加 `view: "aggregate"`，使用已有 `queryId`、`versionId` 和 `aggregate` 来源配置。文本分组或正数宽度的数值分桶支持计数、求和、均值、最小值与最大值。分组、数值及可选单位字段均校验固定来源模式；不同单位分别统计且不换算。聚合前应用既有记录条件与授权。有效、缺失和无效数值数量可以对账；计数包含所有匹配记录。十进制结果保留为字符串，数值桶返回精确上界；最多返回 200 个分组，并明确完整分组／记录数量及截断状态。空分组／单位标签包含缺失、非标量及超过 4096 字符的标签，无效数值分组也归入空桶；未知单位仍标为未注明。Web 统计页提供字段表单、图表和精确值表格，点击可表达为条件的分组生成共享记录查询。数值图表近似显示有限十进制值，表格保留精确计算值。1.6 发现模式保持不可变。

记录页将 `first` 视为条数上限，同时实施保守的 3 MiB 响应预算。PostgreSQL 先计算有序候选前缀的大小，再返回完整原始内容；选择列时先投影再计量。游标按实际返回条数推进，因字节预算缩小的页不会跳过或重复记录。预算预留元数据与查询配置开销，单条记录仍无法容纳时明确失败，不截断字段。记录视图仅返回用于身份判断的几何存在状态，完整地图几何仍由地图表示提供。

探索协议 1.8 增加时间条件、时间排序，以及小时、日、月、年聚合。源格式为 `iso-offset`、`dmy-local` 或 `ymd-local`；`utcOffsetMinutes` 必须明确填写 −840 至 840 的固定偏移，不推断时区或夏令时。ISO 源值使用自身偏移；无偏移的源时间使用配置偏移，该偏移同时定义日历分组。无效日期归入无法分组，不自动修正。边界使用最多六位小数的 UTC 字符串，范围采用包含起点的 `gte` 和不包含终点的 `lt`，源字符串保持不变。浏览器支持时间折线、完整时间段刷选和等价的键盘范围控件，不同单位使用独立序列。所有视图及 MVT 复用相同条件。1.7 发现协议保持不可变。

探索协议 1.9 支持新 `spec` 同时携带 `baseQueryId`。服务端先重新授权当前用户的完整基础查询，再创建新查询；匹配范围限定为基础查询已固定的版本，并保留各版本的解析批次 ID（含未解析的空值）。显式版本不能扩展到基础范围外。基础查询过期、无权访问或权限撤销时明确失败，不静默切换至新解析批次。Web 记录条件与图表选择使用此细化路径；普通新搜索仍解析当前可访问版本。1.8 发现协议保持不变。

探索协议 1.10 增加不可变的 `spec.spatialBounds`，按 WGS84 西、南、东、北排列。记录、聚合、图谱记录回查和查询 MVT 在聚合前使用相同的已验证几何相交条件。资源及来源图概览显示匹配版本；来源就绪统计仍表示已索引内容。查询清单保留底层授权范围的版本与批次，使通过 `baseQueryId` 清除或改变范围时不刷新解析结果、不丢失原始范围。即使位于地图范围外，所有固定成员仍需重新授权。地图提供点、线、面显隐、图例、本地字体聚合数量与视口筛选；图层显隐只改变呈现，不改变查询授权或计数。未验证坐标的数据明确排除。1.9 发现协议保持不可变。

探索协议 1.11 增加 `graph.detail`（`assets`、`evidence`、`records`），按固定版本分页展开邻居；记录展开还需指定来源文件。`graph.grain` 标明 `totalCount` 的计数单位。游标绑定焦点、展开类型与关系筛选；记录复用共享条件、固定解析批次及字节预算。`graph.relations` 筛选包含／来源关系。可选 `graph.path` 在关系筛选后的当前返回页内查找最多八条边的有向最短路径；端点不在本页时明确失败，不泄露外部节点。未找到路径只说明本页中没有路径，不代表完整知识库中不存在。1.10 契约保持不可变。

保存视图使用 `data.explore.view.create`、`.list`、`.open` 和 `.revoke`；`data.explore.export` 导出一次有界查询表示。均要求 `data.query.execute` 与 `data.catalog.read`。创建／撤销为同步命令，必须携带 UUID `Idempotency-Key`，并原子写入审计与命令账本。视图保存原 QuerySpec、版本／解析批次，以及类型化 ViewSpec（视图请求、分页历史、选择身份、地图视角与图层），不复制记录正文。每位用户在项目内最多保留 100 个有效视图。默认私人可见；显式项目分享仍需当前登录用户的项目范围、用途与安全级别检查，打开时重新授权每个固定成员。列表仅返回当前用户自己的保存配置。打开时重新签发本人绑定的 30 分钟查询和游标，不解析更新版本或批次；原临时查询到期不影响持久配置。仅创建者可以单向撤销。导出重新授权请求，返回原始值、来源、明确的返回／总量和计数单位；后续页或截断结果不会标成完整。各传输入口不会在 SSR/BFF 内排空所有分页。

保存视图创建1.1、打开1.2增加可选的类型化 presentation：图谱视角、呈现方式、读图风格、有界相机与布局、阅读页码、日历步进单位和显示焦点。复用现有JSON视图字段，不新增表、查询范围、观测或权限。旧创建1.0与打开1.0/1.1契约冻结，无呈现字段的历史视图仍可读取。打开保存链接时恢复配置，尊重显式网址覆盖；主动重置为默认后刷新不恢复旧配置。焦点只能高亮授权查询返回的对象，不接收任意URL、脚本或未知字段。

探索工作区默认保存有名称的私人视图，支持明确选择项目分享、持久链接和创建者撤销。保存链接恢复经授权的固定查询、记录／图谱分页、所选来源、地图图层／视角及已应用的聚合配置；每次打开都会重新授权并建立新查询。导出下载一次有界 JSON 结果页，保留来源原值、准确返回／总量及完整／部分标记；地图初始记录页不代表全部已加载瓦片。尚未应用的草稿条件不会保存。

数据工作区导航将检索、知识和专业空间／图谱工具归入数据探索，原有深链接继续有效，探索工具栏提供专业入口。窄屏下只有资源表可以隐藏提供机构列；记录与聚合表在自身滚动区域内保留全部所选字段和单位。来源统计将资源就绪概况放入独立折叠区，仅在展开时挂载图表。来源层级图谱宽度小于 560 像素时由 Worker 计算纵向布局，并提供键盘可用的缩放、全图及所选节点定位控件；视角操作不使用动画。

宽度不超过 900 像素时，可通过底部按钮在非模态抽屉中查看所选来源。展开后键盘焦点进入带名称的详情区域；收起或 Escape 将焦点返回按钮，保留当前选择。取消选择时按需将焦点返回当前视图页签。桌面详情仍在侧栏中滚动。G6 内部画布图层不参与 Tab 顺序，键盘交互由有名称的视角控件和来源节点列表提供。

Portal 根据已验证会话选择主操作：已登录用户进入数据工作区，匿名用户进入登录页。数据目录使用每页 25 行的游标分页及可键盘聚焦的内部滚动表格，后续页和返回第一页均保留名称条件。列表保留来源、发布、质量和安全信息，并引导结合详情中的检查范围与内容就绪状态判断。

API 与 Worker 共用 `DATA_EMBEDDING_PROVIDER` 和明确的嵌入配置。本机 smoke 与 CI 默认使用 `DeterministicFakeEmbedding`；生产环境拒绝 fake。OpenAI 兼容适配器支持配置的 Qwen3-Embedding-8B 服务及 4,096 维输出，区分查询指令与文档输入，限制批量与响应大小，校验返回模型、维度与有限数值并做 L2 归一化；服务失败时不替换为伪向量。模型、部署修订号、维度和查询指令共同派生独立的 Weaviate 集合；修订号标识部署的嵌入配置，不冒充未经核实的模型权重 commit。服务权重或预处理变化时必须增加修订号。Worker 的限定项目、可续跑重建工具从权威证据写入新集合，验收后再切换查询，保留旧集合和原发布台账。配置与切换步骤见[本机开发环境](/zh-CN/development/local-environment/)。

搜索证据仍可能包含来源登记清单；Web 说明其检查范围，将原始摘录与结果摘要分开，不改写权威事实。智能分析仍需要按内容类型索引、领域与字段语义、相关性评测和受治理的计划执行。Neo4j 承担关联发现与投影，HTTP 授权和 PostgreSQL/PostGIS 保持权威。Web 把精确版本连接到资源、记录、地图、图谱与统计视图，不宣称已能够生成分析答案。

知识图谱画布默认使用使用确定性初始位置、最多 160 次迭代的 ForceAtlas2 关系网络，由现有可取消 Worker 计算。键盘可操作的布局切换提供 Dagre 来源层级；只有层级布局在窄屏改变方向。两种布局均保留有界身份、选择、路径高亮和文字替代视图，独立资源的关联组在二维平面分区排布。初始概览每页显示八项资源，聚焦后的邻居页保留独立条数上限。关系文字与语义节点颜色辅助表达节点类型。

原文件字节通过 `GET/HEAD /api/data/v1/tenants/{tenantId}/projects/{projectId}/versions/{versionId}/assets/{assetId}/content` 提供。API 重复既有资产／版本授权和审计，仅为内部存储入口签名，并以两分钟截止和单范围请求支持流式传输，内部对象地址按 GET 签名；外部 HEAD 使用单字节 GET 探测，不返回正文，仍返回原件长度和类型；空文件另以零字节 GET 确认。签名地址不外露。验证当前会话的 Web 入口 `/api/data-foundation/assets/{versionId}/{assetId}` 提供带文件名的附件或白名单内的惰性预览，剥离上游 Cookie，使用 no-store、nosniff 和沙箱内容策略。原文件下载与有界查询页导出相互独立。资源页先显示解析内容，再展示治理信息，保持精确版本与文件身份，提供分页表格、来源文档、结构化内容及地图／图谱联动。嵌套结构按有界分组懒加载，展示标签之外保留原始标签。

地图仅在显示边界使用 GCJ-02。原始 WGS84/CGCS2000 坐标、空间查询和已保存视角保留权威坐标系。高德缩放级别等于 MapLibre 加一，方位角与俯仰角固定为零。GeoJSON 和授权矢量瓦片使用校准后的显示坐标。高德原生标识和版权信息始终可见、可点击。JS Key 属于公开客户端标识，安全密钥仅由经过认证的服务端代理使用。

SDK 安全代理使用高德要求的一级路径 `/_AMapService`，由 Next.js 的 `%5FAMapService` 路由提供；需登录的配置入口仍为 `/api/maps/amap/config`。两条入口复用会话验证与上游白名单，安全密钥不返回浏览器。专业地图没有权威要素或 STAC 范围时，使用已校验的查询 bbox 定位仅有栅格的结果。这只是视角回退，不会生成资产范围，也不代表栅格已经完成对齐验收。

栅格叠加在独立浏览器 Worker 中，将 GCJ-02 像素中心反向映射至授权 WGS84 TiTiler 瓦片，采用最近邻采样保留类别和无数据区域。中国境内且缩放级别不低于 8 时使用八像素间隔的显示插值；低缩放级别及坐标转换边界采用精确映射。相邻瓦片请求有数量上限，地图销毁时取消请求并终止 Worker。原始栅格数值和文件保持不变。

## 副本关系核验与业务观测去重

`data.reconciliation.create/get/list/review` 保存独立、持久的核验证据。每批固定两份不同的 CSV/XLSX/XLS 资产、不可变 DataItem 版本、已完成的分析 ID、来源 SHA-256 和路径。两份资产都必须完整解析（`READY` 或 `EMPTY`）；文档片段、不支持或截断的来源不能作为观测。浏览器从资源内容中选择当前版本的两份文件；API 也支持明确指定、已授权的跨版本来源。

调用者定义最多八个成对业务键（文本、精确十进制或带明确偏移的 ISO 时间）、观测值字段、指标与单位的字段或固定值，以及可选的十进制仿射单位换算。文本保留前导零，去除首尾空白须显式选择。不同指标、未经换算的不同单位保持独立。缺失、空白、无效值或键均保留为信息不完整；零是有效值。不安全的大整数数值键不作舍入合并。等价关系仅覆盖所选字段；文件名、字节数或记录总数相同不能证明副本，也不能据此判断未选字段等价或来源在解析资产之外的完整性。

纯确定性引擎按规范化业务键、指标和单位分组，保留每条来源记录 ID、所属文件侧、行号、规范化值和处理状态。相同观测合并成一组，新增及仅基准存在的观测继续保留。不同值默认保持冲突；只有冻结规则明确声明“对照文件修订基准文件”时才采用修订值。此优先级不能消除任何单份来源内部的不同值冲突。原文件、解析记录、版本和来源值均不修改或删除。

批次区分候选格式副本、部分重叠、修订、无共同观测和待核对关系。两份文件各两条记录仍计四条解析记录，可以得到两个候选观测。存在任何冲突或信息不完整的记录时，候选总数保持未知。只有创建批次的人类用户具备 `data.publish` 权限，提交预期版本和核验说明后，才能确认或拒绝候选；仅确认后提供 `independentObservationCount`。确认仅覆盖本批所选规则，不能推广至整个资源或目录。已审核批次不可变；调整规则须创建新批次。

创建同步执行；两份来源合计超过 50,000 条记录、任一来源所选字段超过 8 MiB，或分组证据序列化超过 24 MiB 时直接失败，不截断计算。观测组和来源成员分别分页，每页最多 100 项，游标绑定批次、版本和观测组。列表返回涉及指定版本的最近最多 100 批。命令复用事务、审计、Outbox 和幂等账本，重放也重新授权来源。私有的 `service.observation_reconciliation` 表强制 RLS，绑定所有者、租户、项目、用途和安全上下文。每次读取或审核均重新检查两份版本及分析的当前权限，包括策略变更后。`0022_observation_reconciliation.sql` 和隔离 PostgreSQL 集成测试验证这些边界。

迁移`0023_exploration_point_guard.sql`先物化非空点候选，再读取X/Y坐标进行聚合，防止查询规划器重排条件后将线、面传入仅支持点的函数。原始与高德查询瓦片继续沿用既有权限检查，来源几何不变。

GIS 适配器在权威授权后，仅将与请求坐标完全一致的 TiTiler PNG 越界响应转换为透明瓦片，使覆盖边缘的有效邻接影像继续显示。文件缺失、访问拒绝和其他错误仍然失败。地图显示坐标已转换不代表位置已经独立核验。

打开未填写 bbox 的固定版本地图时，先授权校验精确的 DataItem/Version，再通过 HTTP 复用该版本已有探索解析范围。仅打开地图时建立这一有界查询；目录渲染不额外预取解析或下载文件。只有点的范围扩为小幅查询视口，不生成资产足迹；未知范围仍然未知。目录与探索详情指向同一地图，地图可回到固定版本来源。

## 资料取得与类型检查

`data.assessment.create/get/list` 将检查记录追加到 `service.intake_assessment`，绑定固定资料版本、文件及其哈希。服务器复用该原件最近一次完成的解析结果，不重新下载、解析，也不采信提供方自查的通过结论。`wiser.intake.v1` 按资料类型检查来源、授权说明、字段绑定、单位、时间含义和原文位置。单位或坐标系未知时保留原件，限制相应用途。`CHECKS_PASSED` 仅表示所列信息检查通过，不代表科学适用性、发布批准或位置已实证核验；模型建议不参与确定性通过判断。

获取因登录、权限或申请要求而失败时，即使来源原先声明为公开或已授权，下一步也转为申请访问。系统保留原声明，不把它当作当前许可。限流和临时故障仍可稍后重试；已保存原件仍可在既有授权边界内复用。

取得情况分别针对数据集本体、说明网页、下载文件或查询接口，入口、访问条件及完整性声明均保留证据，不自动传递到关联对象。保存 HTML 不证明数据集原件已取得；样本即使解析完整仍是样本。接口查询报告保持待独立核验。旧资料在没有报告时保持待核查，原质量和发布状态不变。生成方法、参考尺度、时间含义和限制可带出处登记，但本流程的位置状态始终为待核验。

写入复用现有幂等、审计和 Outbox；读取及重试都重新检查原版本和文件权限。报告仅在相应项目、安全等级和策略范围内可读，每页最多 100 条，不把本页报告数当作全库核查覆盖率或独立数据集总数。更正追加新报告；回退时停用新入口并保留证据，无须改写旧原件。

目录概况 `data.assessment.overview` 仅统计当前有权限查看、已发布且接纳通过资料的最新合格版本，按指定检查对象选取最近报告。同一条一致性查询同时返回全范围下一步计数和筛选后的资料页，未核查保持独立；说明页的检查不转移为数据集检查。解析已判定内容无效时，即使声明类型像 CSV，也不能证明数据集原件已取得。

## 有证据的业务关系

业务关系流程复用 `knowledge.assertion`、`knowledge.evidence_fragment` 和 `knowledge.review_record`；迁移 `0025` 增加不可变的 `knowledge.assertion_binding`。未知置信度保留 null，不编造分数。候选整理保留同名异物、多处及矛盾证据、未知单位、报告原值、时间与限制。证据及断言正文不能覆盖；更正通过 `supersedesId` 保留前序关系，以明确的映射和版本范围避免静默身份合并。默认关系查询及图只包含已通过断言，每次读取均重新授权来源；待审核、需修正、已否决队列独立计数。

Data Worker 按至多 100 条的批次把权威关系同步到独立的 Neo4j `WiserBusinessEntity` / `WISER_BUSINESS_RELATION` 标签，保留断言标识及原件证据，不改变已有发布目标和来源溯源图。迁移 `0026` 保存各目标的权威读取位点，项目/目标 advisory lock 串行化写入，失败不推进位点。每轮完成后重新扫描，以接收审核、更正及来源撤回。API 读取 PostgreSQL 权威状态，因此撤回后立即拒绝读取；投影在后续扫描中移除。重建 CLI 先完成保留的进度，再做一次完整扫描；删除投影后仍可恢复相同身份和审核依据。回退时停用新增入口与消费者并保留权威证据，不回填旧资料或替换原始几何。

### 类型化知识候选（关系协议1.1）

关系协议1.1在现有来源绑定流程中增加人物、机构、文档、观点、事件、观测、政策、模型运行及地点。已登记关系规则限制两端对象类型；新增关系必须说明记录性质、时间角色、位置角色和适用条件。计划、历史报道及模拟不能标为采样观测。原件哈希、不可变版本、待审核与权限规则保持不变，保留1.0发现契约。跨资料身份对应与联合查询见下述扩展。

跨资料身份对应：IDENTITY_MATCH显式引用已存在的来源对象，不按同名合并。接收时核对名称、类型和外部标识，拒绝引用链。列表最多联合六十四份明确选择的来源，每次读取重新核权；来源撤回后关联边及计数隐藏。可重建图投影使用原始端点身份。待审对应不等于已批准知识。

关系列表能力1.3沿用原有请求与返回字段，将范围扩为主来源加最多63份关联版本（合计64份）；1.1最多12份与1.2最多32份的发现契约原样归档。每份所选来源在计数和读取前核验权限，任何一份被拒绝都不返回部分结果；每页仍最多100条关系。不迁移权威数据，不改变审核状态或图投影身份。

精确记录探索链接通过有界的`recordFocus`仅保存资源、不可变版本和记录标识。打开或历史恢复时重新鉴权，并通过既有HTTP探索接口读取该条记录；返回的三个身份必须全部一致。记录缺失、参数错误、无权访问或身份不符时明确失败，不替换成首行或放宽到整份资料。地图/表格选中与视图切换保留定位及已校验的业务图返回上下文；应用新查询条件或选择其他资源时清除旧定位。选中记录不代表坐标已经核验，也不自动建立科学对象身份或图谱到空间要素的映射，这些仍须来源证据支持。保存视图继续遵守原有选中契约，不与独立记录定位混用。

### Word原表结构

OOXML Word解析保留既有段落文字和定位，再在可选的来源结构列中追加`word/document.xml`的物理表格行。每行记录表号、行号，以及单元格所在列、横向跨列数、纵向合并标记和原文。空值、无水与零分别保留，不自动向下填充合并内容，表格行不作为独立观测计数。二进制DOC继续使用不执行内容的antiword文字提取，不声称已重建行列。嵌套表格、不支持的包装或旧合并方式、非法跨列和超限均明确返回部分完成，避免猜配结构。不改变原件、审核状态或几何。

跨资料读取先在本次查询内固定被引用对象的租户、项目、资料、版本和映射范围，再核对端点身份、审核状态、来源发布状态与每份证据文件。这不是权限缓存：每次读取、翻页和投影重建仍执行行级权限及原有可见性检查。查询先收窄引用范围，避免把无关关系反复展开核证；计数、筛选、审核含义与公开接口保持不变。

XML解析保留各节点的展开命名空间、同级序号路径、属性、直接文本与尾部文本，不自动转数值或推断空间要素。复用既有锁定的defusedxml依赖，拒绝DTD、实体声明与外部资源；超深、超长或超记录限制显式失败。XML节点数描述元数据结构，不是观测数。重新解析复用原有不可变资产，创建新的分析批次。

关系列表1.4增加`queryId`入口，与内联来源清单互斥。先通过已有探索POST能力建立不可变来源范围，之后GET分页只传短标识。每次检查所有者、租户/项目、用途、策略、安全级别、有效期及全部来源；有来源不可见时整次失败，不返回部分成功。经授权的空范围返回零条。内联来源仍限64份，1.0—1.3发现契约保持不变。查询标识会过期，长期入口复用保存视图来恢复原版本。业务时间和记录级条件通过下述探索1.12扩展提供。

探索1.12为明确的版本清单增加可选`businessQuery`，固定审核状态、当前/历史模式、原资料时间筛选及关系版本标识（最多2,000条）。每次读回重新检查来源权限和关系版本，发生变更或不可见时整次失败。关系列表、明确绑定的记录、记录汇总和地图要素共用该范围。`urn:wiser:record:`只能绑定到指定解析批次中、与关系证据文件相符的记录。按日期查询HTML横向表格时需要已核对的原列选择，返回时收起其他时期，原件不变。资料概况和就绪度仍统计来源资产，不能称为筛选后的观测量。保存视图打开/导出1.1保留这些条件，其1.0及探索1.11发现契约保持冻结。保存链接受用途隔离：面向用户的视图须在已授权网页控制台用途下创建，不能直接分享批处理用途中的私人视图。无几何记录保留未定位，不推断位置或专业批准。

### 固定版本的跨来源证据

跨来源关系证据可选填写 `source.dataItemId`、`versionId`、`analysisId` 和 `recordId`，同时保留原文件哈希。定位固定为 `record:<recordId>`；非空摘录须存在于该条解析记录中。导入、详情和审核接口为1.2，列表为1.5，既有契约版本保留。读取与重试均重新校验关系所属资料及全部证据来源；来源撤回、无权访问或定位不匹配的证据不能继续支撑关系或从证据与检索入口泄露。提取的日期仍是有来源的候选，不代表专业审核。

证据读取先在行级权限下固定文件、版本和哈希，再核对所属资料及外部记录，避免逐条证据重复扫描整个文件目录。发布、接纳、安全级别与记录核验全部保留，不跨请求缓存可见性结果。

### 关系完整性与原表单元格范围

迁移 `0028_relation_integrity.sql` 用内部定义表约束同一来源版本、映射版本、实体key的名称、类型和外部ID。受范围检查的触发器以迁移所有者身份检查全部定义；运行角色无权读取或修改该表，业务查询继续遵循原RLS。已有定义冲突会阻止迁移，需明确处理，不自动选择一份覆盖。审核依据锁定的权威行版本，数据库也限制审核版本，隐藏历史不能放行第101次审核。投影对称保留两端的类型与外部ID。

带日期条件的HTML表格查询要求固定断言中存在明确原单元格证据（`table:N/row:N/column:N`）。服务端核对文件、可选跨来源记录、表号和行号，只接收证据支持的列；只保留所选结构化表格字段，不能带出含其他月份的整行文字或任意元数据。缺失或过期映射返回校验错误，不猜月份列。旧保存查询如不满足约束，须通过受治理断言补正后重建；原件及历史证据不改写。此检查保证符合已登记映射，不替代月份含义的专业核验。

空间来源说明按固定版本、原文件读取最新且仍有访问权限的检查。来源、生成方式、参考尺度、时间含义和限制，与可上图几何、当前显示状态、独立位置核验及业务用途复核分别展示。SOURCE_CHANGED 发现使旧说明停止用于地图标签；未知保持未知，放大地图不会提升原始精度，也不会确认接纳水体关系。

栅格显示设置可选择单个波段、有限且递增的数值范围、明确的缺测码和用户填写的单位标签。TiTiler 仅对显示像元应用范围、viridis 配色、最近邻采样和透明掩膜，原始数值、文件及来源声明不变。单位未知时继续显示未知。重新加载先移除旧栅格来源，再替换该来源，保留视角、透明度、图层顺序和其他图层；部分瓦片失败时持续显示失败，直到用户主动重试。

高德采用俯视的 3D 模式以支持连续缩放。若 SDK 报告不支持 WebGL，两个地图页面均使用整数缩放，并提示使用加减按钮；该回退状态禁用滚轮及双指缩放。适配范围时向下取整，保证范围仍可见。视角一致属于显示验证，不等于独立的位置或科学适用性验收。

业务图分组阅读消费网页已完整加载并授权的关系结果。每组六条展示关系保留准确断言与端点身份；原记录和地图导航只转递经过校验的显示状态。通用来源图继续使用原网络布局。可选的可读层次布局复用可取消 Worker 和既有 G6/Dagre 依赖，不改变 API、数据库迁移、投影或知识审批。

### 业务图谱查阅与呈现

业务问题图在全景总览、资料对照、围绕对象、证据追溯、时空对照五种查阅视角及平面、类别立体分层、空间锚点三种呈现方式之间保留完整授权关系集合。显示设置和有界视口参数保存在网址中，同一查询的记录／地图链接保留这些参数与准确的选中关系。资料对照分列来源类别和业务内容；一层／两层邻域保留原断言方向，证据视角展开既有有界路径阅读器。按来源标题归类是明确标示的阅读辅助，未知分类保持未知，不改变来源登记、身份或知识审核。时间组织只采用对象自身来源中明确的观测／事件时间含义，未知与多时段对象单列。

业务画布使用确定性分类位置和 SVG 立体投影；普通来源图及可选的六条断言分组阅读继续使用 G6。立体层标题放入独立侧边标注区，通过引线连接图层。滚轮、双指和键盘缩放只改变视口，不重排节点或删除连线，名称随尺度逐步出现；所选对象、关系与证据也可通过键盘列表访问。悬停预览直接联系，点击锁定依据并淡化完整网络背景。交叉连线命中时列出实际候选断言供选择。证据区保留原始支持／矛盾含义、准确来源版本、表格／段落定位、限制、审核状态和前版关系入口。

空间呈现复用完整有界的 HTTP 地图查询，按资料、版本、记录三个标识绑定原始点线面几何，沿用既有显示坐标转换；无位置知识单列并保留原关系。虚线将资料标签连接到原几何的显示中心，标签和中心均不成为新增点要素或业务关系。位置读取拒绝范围不符、分页不完整及无权结果。移动地图不改变业务问题；位置精度与知识审核保持独立。画布操作不下载原件、不重跑解析、不迁移数据库、不写入业务数据。

### 服务端业务成员清单存储

追加迁移`0029_exploration_membership.sql`在既有查询快照和保存视图中增加可空的`business_pins`，只保存断言UUID与版本对，与有大小限制的客户端条件分开。旧行继续为null，不回填或改写。数据库拒绝格式错误、重复或超限清单（最多100,000对／8 MiB）；这是存储保护上限，不是已验证的查询或绘图能力。整行强制RLS、快照不可改写及保存视图单向撤销约束同样覆盖新列。`packages/data-infra/test/migrations/exploration-membership.spec.ts`在独立合成库验证2,033个成员、六项作用域隔离及修改拒绝。当前项目业务查询已通过下述授权 API 路径使用这些固定成员；存储上限不批准知识、不导入外部观测，也不代表可绘制同等规模。

### 项目业务范围（探索1.13）

使用 `scope: "project"` 与 `businessQuery`，由服务器按权限确定来源清单；此模式不接受调用方提供版本或关系清单。现有查询快照固定资料版本、解析版本及关系UUID/修订号，只返回短查询编号和 `membership` 计数。计数描述显示筛选前的固定范围，不是独立观测量或当前页数量；资源与关系列表仍有界分页。超过服务器上限直接失败，不静默截断；存储上限不代表绘制性能。

保存视图打开1.3、导出1.2保留该范围。通过 `baseQueryId` 调整条件时，先重新核验原有来源和关系，再在其中筛选，不吸收后来新增的成员；切换审核状态须重新查询。成员缺失、撤回或修订变化时整次失败，不返回不完整全景。探索1.12、保存视图打开1.2及导出1.1的历史契约保持冻结，明确版本查询沿用原限制。无权读取且未获目录公开许可的元数据不包含在内；受限来源的可发现目录需另行授权。沿用原GraphQL、REST和MCP入口，不建立新的身份体系。

### 混合审核查询范围（探索1.14）

`businessQuery.schemaVersion: 2` 与 `status: "APPROVED_AND_PENDING"` 同时查询有权读取的已审与待审关系。它只表示查询范围，不是新的审核状态或审核决定；每条关系保留实际状态及修订号，已拒绝与要求更正的关系不包含在内。当前修订筛选不会让待审更正隐藏已审关系；版本1保留原有单状态行为。

关系列表1.6仅允许通过状态一致的业务查询编号使用此范围，内联来源或普通非业务查询不能使用。来源授权、固定成员、分页、记录证据及撤回检查保持有效；即使关系仍处于所选状态集合内，修订变化也会使旧查询失效。保存打开1.4与导出1.3保留该范围；探索1.13、保存打开1.3、导出1.2及关系列表1.5的历史发现契约及哈希保持冻结。不更改权威身份模型或新增数据库迁移。

网页默认入口使用项目范围、业务查询v2、已审与待审混合范围及当前修订，不添加来源、类别或时段限制。`/[locale]/data-foundation`与`/explore`共用服务端加载逻辑；已有查询编号与保存视图继续使用其原成员范围。资源每页25项，业务关系列表保留查询成员核验。打开首页不登记、批准或获取外部观测。

网页元数据读取须经已核实会话及同源通道，只保留白名单中的来源访问状态，并限制请求／响应大小及支持取消。目录可见不授予供方数据权限；可信来源许可尚未接线时，正式来源读取保持关闭。

同源 `POST /api/data-foundation/external-metadata` 只接受严格的来源、年度和分页契约，请求正文上限4 KiB、读取上限5秒，并将浏览器取消信号传给已验证会话的DAL。DAL调用已注册的固定Capability路由，响应头与正文共用超时，限制解码后字节，并核对来源、年份、字段白名单和分页一致性。所有结果禁止缓存，网页只接收与状态匹配的公开错误分类。供方许可配置及来源目录绑定仍是独立前置条件，此入口不会启用真实供方。

已通过原目录读取授权的详情页，可通过宿主配置 `WISER_EXTERNAL_METADATA_BINDINGS` JSON数组展示外部站点目录面板。每项只含 `tenantId`、`projectId`、`dataItemId`、`sourceId`；配置非法、重复、过大或范围不匹配均不展示面板。该配置只提供导航对应关系，不是供方许可；不从名称或文档推断，不创建数据库记录，不含供方网址或凭据。读取器在未接入实时来源许可时仍默认关闭。

## 有界的项目关系批量页

关系列表1.7新增可选的`pageMode: "BOUNDED_PROJECT"`，`first`最多500，仅适用于已有项目业务`queryId`。每页仍核查清单所有者、到期、当前来源与证据权限及固定关系版本。单条关系不会被截断；完整结果（关系、总数和游标）的UTF-8 JSON最多1 MiB，单条超限时校验失败，不返回空续页。传输协议的外层封装不包含在此结果预算内。

未指定新模式时保持100条上限及原行为，1.6发现模式原样归档，更早版本不变。客户端先发现1.7能力再启用，不支持时使用旧路径。固定项目清单不代替每页鉴权；此改动减少往返次数，不改变全范围校验成本，实际性能须另行测量。

项目图通过已验证会话的网页访问层请求有界批量页。每次请求先发现目标关系读取能力；明确支持1.7时使用批量模式，否则保留同一查询及游标、按最多100条读取。能力发现失败直接返回，不绕过授权重试。固定来源查询继续使用100条路径。网页在显示图谱前拒绝总数不完整、身份重复、空续页和重复游标。

### 项目权限工作区的资料覆盖

权限工作区复用已授权探索资源与完整查询汇总，不复制目录或扫描原件。每页20条资源不是统计分母。登记资源、解析内容记录、空间要素和专业复核断言分别计量。所选租户和项目通过既有已验证调用方上下文传递，保留通常的RLS与查询续读检查；管理权不自动赋予Data正文读取权。

## 资源读取范围基础

追加迁移 `0030_resource_read_scope.sql` 在既有租户、项目和安全等级强制 RLS 上叠加固定资源版本范围。可信 API 事务可设置 `wiser.resource_scope` 与 `wiser.resource_action`；未配置的事务保留原有行为。受管模式下，目录、版本、资产、证据、分析、记录、显示几何及谱系在统计和分页前按获准版本筛选。原件读取独立控制，结果导出还须具备内容查看权限；来源发现权限不开放完整目录元数据。无效、空或过期的受管范围拒绝读取。授权仍由控制库负责，不复制到 Data 权威库。SQL 事务适配器已在目录、探索、证据、地图权威、分析、关系与命令来源读取前设置编译后的范围；原件使用独立动作，探索导出检查查看与导出的交集。目录及结构化/空间游标、命令重放哈希绑定授权指纹。实际执行器和数据库联验已确认失去范围后不能重放旧探索清单或导出。当前运行时及响应交付时的复核见下文。受管模式仍需明确启用项目并提供可信来源许可；迁移本身不启用任何项目。

受管项目的联合／语义检索向各后端传递最多1000个获准内容版本；仅有来源发现权限时不返回正文命中。搜索游标绑定资源权限指纹，结果发布前按资料、版本和证据的精确组合回查Data PostgreSQL行级权限、发布状态及跨来源依据可见性；缺少权威回验适配器时拒绝返回。

受管图扩展及路径查询对每个节点和关系应用内容版本范围，不向Neo4j传递完整授权快照，并在返回图谱前回查Data PostgreSQL中的节点与原文依据。端点可读不代表关系证据可读；内容权限为空时不查询投影。

REST、GraphQL、原文依据、STAC和地图响应在工作完成后重新解析权限；原件内容在取得上游响应后、发送字节前再核验。主体、项目、用途、动作、成员修订或资源范围变化时停止返回，包括请求期间启用受管策略的情况。已提交的命令不会因响应拒绝而自动回滚，须沿用幂等与审计记录对账。受管项目的原件路由统一代理传输，不返回存储签名链接。每个内容块在上游读取后重新核验权限；权限变化或不可用时取消后续传输。已经交付的字节无法收回。未启用资源策略的旧重定向链接仍保留既有短有效期，本机制不能单独撤销这些链接。

受管项目仅放行明确列出的资源感知能力及下述自有待审资料上传、创建、提交、详情读取及有归属守卫的标准接收操作状态／事件。批准／拒绝、对账及其他维护命令仍在进入未受资源限制的执行器前返回FORBIDDEN。外部目录调用须有对应来源、未过期的external.directory授权，并同时满足供方许可。未启用项目保留既有能力门禁。

资源管理采用仅核验元数据的内部端口。Platform在控制面项目与权限设置锁内检查当前来源许可后，生成进程内、单次使用的办理凭据，绑定已核验的操作者与会话、租户、项目、用途、岗位、操作权限、密级、权限版本、精确资源及请求动作。凭据最长五秒有效，且不超过来源许可期限；序列化副本、变更请求和重复使用均在访问Data前拒绝。端口在独立只读事务中，以一次有界查询核验固定版本、发布状态、接收状态和来源授权说明，仅返回是否通过。其事务局部RLS范围仅包含指定版本，不修改个人授权，也不向正文、证据、原件或导出适配器传递连接及范围；租户、项目与密级限制继续生效。取消或超时结果均拒绝。该核验不要求、也不授予个人正文读取权。外部来源仍需独立注册端口；管理范围的覆盖浏览另行接入验收。

来源管理目录在无登录、不能绕过 RLS 的 `wiser_data_metadata` 角色下运行，只能读取固定目录列白名单。部署授权包含当前目录行策略必需的 `security.resource_related_ids(text)` 调用者权限函数；正文列、资产和证据仍不可读。真实 PostgreSQL API 验证通道在迁移后检查实际部署角色配置。

## 本地加工候选与正式资料边界

### 项目资料就绪规则边界

`packages/data-core/src/project-readiness.ts`按调用者提供的固定版本事实，计算明确需求／版本／区域／用途及真实或合成演练轨道的就绪信息，不读取文件、数据库、网络或时钟。作品、版本、资产、源内对象与解析记录分别计数；声明属于同一作品的转换资产不增加作品数。`readinessRecordKey`用作品／版本／资产及未改写的源内记录ID确定引用范围。调用者须提供规范作品／几何引用及获准事实；规则不自行发现重复原件、不授予展示权限，也不核验CRS或控制点。

月报命名对象覆盖须有原文支持的出版系列声明；原名、星号、脚注及各来源内对象继续保留。按显式需求时窗逐对象计算缺月，未知、解析失败或日期角色不符时保留未知；时窗是覆盖目标，不作为隐式记录过滤条件。非月报另列。待审对应只计算假设覆盖，已批对应须明确覆盖同一系列内所有参与记录，才能联结名称组作统计；两者均不合并原始身份。已批准记录仍参与选定轨道的统计。

类别、类别区间、无水、无法监测、null、空串与数值0分别表达；浓度差和通量检查不能使用类别值。数值上下文缺失时保持未知，浓度差不擅自转换不同指标／单位／方法。独立观测数只取明确指定、有依据且记录范围完全一致的确认对账；密度还须有该范围的面积分母依据。

就绪规则`wiser.project-readiness.v2`对传入的`FLUX`用途四态作确定性约束；`CHECKS_PASSED`、`LIMITED`、`UNKNOWN`、`BLOCKED`只作为状态上限，不作为批准输入。完整配对须恰有一条有限、非负浓度和一条有限、非负流量，解析均为READY，检查及两条原值均有当前范围内的依据，对象为同一固定来源内身份或有当前依据的APPROVED对应，且为显式观测月份窗口内同一合法公历观测日。已知对象、日期、窗口、解析或单位量纲违反条件时返回`BLOCKED`；身份、证据、配对支持、单位或方法缺项时保留`UNKNOWN`。原记录、原值、名称、身份及月份覆盖范围均不改写，不从多条数值中自行挑选配对。

每条数值记录的原值证据必须引用该记录自身的固定作品、版本及资产；范围内的方法说明或身份对应来源不能替代原值依据。用途检查的方法依据及当前已批跨来源对应的证据仍可引用范围内的独立来源。这项结构检查不核验自由文本定位、摘录的真实性，也不证明它们对应原文中的原值；这些事实仍须通过原资料与可信处理链核实。源内记录引用和原值继续保留。

内部v2单位表为mg/L、μg/L、ug/L、m3/s、m³/s和L/s明确相对mg/L及m³/s的比例，只证明质量／体积与体积／时间量纲兼容，不执行换算或通量计算。窄测试路径仅在SYNTHETIC轨道认定NH3-N／`synthetic-colorimetry-v1`及DISCHARGE／`synthetic-current-meter-v1`两项演练方法定义；这些字符串不能批准REAL方法。当前就绪载体没有经过复核的计量定义绑定、期间支持／积分声明及有符号流量方向，因此一般方法、月／年配对和负流量仍为`UNKNOWN`，REAL通量始终不能由此路径取得准入。纯规则、当前本地证据重绑及合成批准字段，不构成Auth验收、计算许可、专业批准或科学计算。

九问入口分别下钻到实际作品／版本／对象／记录、检查、字段、覆盖格、加工任务及用途检查。`KNOWN`表示相应事实已知，不表示质量通过；不存在的检查、责任人及观测分母不补造。内部类型不新增公共HTTP DTO、持久权威、授权、专业决定、候选读取路径或网页；服务与网页接线须另外完成受管验收，纯规则通过不能替代项目端到端就绪验收。

本地空间工作台的 `WorkspacePack` 是前端与本地处理器间的窄中间契约，非新的公开查询协议或权威身份库。来源原件、提取行、文字位置、参考几何、方法证据与专业待审状态分别保留；源内同名对象不自动合并。原件路径不进入浏览器，许可不足的来源不能借派生图形暴露。

私有阅读链接先以来源身份、固定版本、原件哈希和来源处理规则固定当前可显示资料，再分别固定记录自身处理规则及所选位置的几何来源。它们是前端阅读引用，不是发布身份、公开查询、授权或保存视图编号。打开链接时重新核对当前显示许可及固定引用；引用缺失、重复、变更或撤回时不选择替代对象。旧资料和缺省链接明确按真实轨道读取，合成轨道必须显式选择并与来源、记录一致。参考几何保留原位置角色，导航不把它变成采样位置。

可选公共地理参照背景是独立、无路径的地图输入，不属于`WorkspacePack`记录，也不作Data API失败回退。固定OSM衍生文件含四区行政参考面和一条永定河原生水系线；另一端点补证文件含五条地理参考河线，月报边界确认绑定为零，专业复核待完成。本机读取时核验两个GeoJSON的完整SHA-256及WGS84坐标，只把安全名称、固定来源／原件哈希、限制和ODbL署名送到浏览器。平面与WebGL地图分别提供行政、水系、参考河段开关。仅当完整几何与固定原件来源均相同且对应记录已显示时，视觉上隐藏重叠背景；不更改记录、来源计数、定位身份或关系。以后可由获准来源提供同一独立地图输入，但登录后的读取不得回退这些本机文件。

本机合成候选可练习接受、排除和暂存，再计算源或规则变化影响。真实候选保持待审，练习不能成为专业审核、授权、正式更正或发布。标准接收、普通账号权限及供方实时访问仍须独立端到端验收。

### 计量定义与比较准入

`@wiser/data-contracts` 的追加计量契约保留定义ID／版本、来源内ID／固定版本及原件SHA-256。声明包含真实／合成轨道、连续量／有序类别／编码／未知、差值用途、原文依据、指标与方法／单位、时间角色／精度／时长、点／河段／区域支持、聚合规则和分母。来源声明与专业复核分开，字符串、原值和来源内身份不规范化或合并。这些类型未注册为公开HTTP操作，也不能由调用方凭`APPROVED`字段取得授权。

`assessMeasurementComparison` 只使用调用方提供的固定定义及审核事实，进行无IO的确定性准入。定义缺失、重复冲突、类型未知或非连续量、用途未批准、轨道混用、记录未批准、定义自审或证据不足均阻断计算。主机适配须提供经过认证、包含委托主体的规范身份及真实审核结果；纯函数和Schema本身不能验证身份或颁发批准。实际记录须与定义的指标、方法、单位、原生日期范围和统计支持一致。聚合分母须为有依据的正数，观测计数为整数；不从几何面积或解析行数补分母，不自动换算单位，不默认不同分母可比。

本机`WorkspacePack`版本1追加可选定义表、轨道和记录引用，旧包继续可读但缺乏定义时仅并列。服务器校验并按固定定义来源的显示许可裁剪，导出另核分发许可；保存场景复用来源固定清单，定义来源过期时移除差值而保留原记录。本机记录契约尚无真实专业批准事实，因此只有明确演练轨道的合成正例可通过此适配。标准候选持久化、业务审核、历史引用和HTTP接线仍独立验收，不把纯规则或固定包测试作为完整A6完成证据。

### 离线协议与栅格检查

`connectors/cnemc-offline` 是纯协议和回环故障测试模块，不修改既有外部元数据读取器或公共观测契约，不接入真实供方。请求保留手册参数写法；响应核对字段、分页和业务错误。重复／不完整页、重定向、取消、超时和超限均拒绝交付部分结果。合成供方只监听数字回环地址，最多32页、单响应4 MiB，不含真实凭据或监测响应。稳定排序、唯一键、修订和许可仍待真实接续。

`scripts/raster-inspection` 只读保留栅格并核对前后哈希，报告CRS、网格、像元、质量类、NoData和产品元数据。最近邻显示缩略图与原生像元分开；通道数不增加场景或空间像元数，算法分类不是真值。该流程不入库、不发布、不替代控制点验收。

本地原生窗口读取器可在固定四产品清单中选择任意原生行列像元或有界整数矩形。结果交出前，保留可信本地调用者提供的来源／版本引用，核对产品／场景／采集时间标签、原生格网以及文件／清单前后哈希；该CLI尚未核验权威资产／版本映射。限制为4,096个空间格、24,576个通道值、1 MiB返回值／掩膜数组和8 MiB实际UTF-8 JSON；这些限制不等于源文件块读取或整文件哈希的磁盘读量。越界窗口不填充或裁剪，不取显示缩略图像元，不隐式重采样不同格网，未绑定哈希的旁车文件拒绝使用。

纯窗口统计分别保留编码值、逐通道掩膜、显式质量选择、可重叠的无效原因和联合分母。有效0仍为数值；非有限数值及NoData标签保留明确原因，空有效集统计保持null。投影格网面积按有限仿射行列式和可靠线性单位换算计算，经纬度或未知单位不补造平方米；该面积不是实测水面或真实地表面积。旧缩略图报告不能表达的非有限标签拒绝显示交付。这一内部CLI／纯规则切片不新增公共查询、权威模型、授权、持久化、专业决定或浏览器选择；对应接线和验收分别执行。

### 本机就绪查阅适配

本机工作台通过明确的`@wiser/data-core/project-readiness`入口复用纯规则。九问分别展开作品、版本、原件、对象、记录、字段、检查、月份覆盖、任务与用途事实；真实待审记录保持待审，合成补充不混入真实统计。可显示几何引用按仍可读取的全部固定位置引用去重，不限于规则记录中的代表几何，也不计作采样点。有原文依据的发布序列只修正本次只读覆盖核对的日期角色，冻结记录不改写。本机依据不授予权限、不发布资料、不持久化候选，也不替代带认证的HTTP流程验收。

## 候选固定输入契约

入库候选采用严格的`ingestion-candidate`引用，由入库会话、冻结审核SHA-256和处理批次组成；已发布版本引用契约拒绝这种身份。解析批次保留原件资产哈希，以及READY、PARTIAL或UNAVAILABLE的实际状态，未知记录／几何数量保持null。记录页保留原值、原文定位、来源顺序和唯一记录身份，限定单一资产及已声明字段，每页最多200条、单条原值最多256 KiB、整页最多3 MiB。纯完整性规则拒绝输入更换、重复原件、待审策略变化／撤回，以及不再处于REVIEW_REQUIRED的会话。原值序列化前拒绝自定义原型和访问器。契约与纯完整性规则自身不授予读取权；下述候选读取能力另行执行当前权限检查，普通已发布版本查询契约保持现有行为。

纯规则`@wiser/data-core/candidate-monthly-projection`接收一份固定候选批次、同一资产的全部记录页，以及显式给出的源内资料编号和资产SHA-256。带版本的北京月报DOCX版式要求三条精确表题指向同一发布月份，并核对`c3.word_table_row`的表头、物理行／格定位及河流水系列纵向合并顺序。输出保留对象原名和类别原文（包括空值）、`PUBLICATION`月份、候选四元引用、源内记录身份、原件资产哈希和处理规则版本；不生成目录`versionId`、采样日期、跨月统一身份或几何。缺页、原件变化和未知版式返回带原因的`NOT_PARSED`，不输出部分业务行。对已有八份解析事件的纯规则回放每份得到139条类别记录、合计1112条；这不是实际候选持久化、Auth、SQL、HTTP或网页验收。若输入是由DOC转换的DOCX，候选资产哈希只标识该DOCX字节，不能冒充先前DOC原件哈希。

网页`candidate-monthly-semantic-reader`只从当前获权、完整的`candidate.get`与`candidate.records`分页组装上述纯规则输入；若使用标准固定候选视图，收集前后各重新打开一次。它核对固定候选四元引用、所选资产、不变的批次元数据、声明计数、页数／字节上限、游标与资产去重、记录连续顺序与身份，并在转换前重读首个资产页。拒绝、取消、过期、分页矛盾和未知版式都不输出部分业务行。现有get／records契约给出解析资产SHA-256，却没有源内作品编号，也没有DOC转DOCX前后哈希的对应；因此必须显式提供固定的源内编号与原件哈希，原件与准备后资产哈希不同时，在独立证明转换对应并绑定获权候选前保持`NOT_PARSED`。不能为让单个资产进入投影而把`PARTIAL`批次改写为`READY`。适配层为后续阅读、就绪和专题提供候选来源内记录，不生成已发布版本、权威对象身份、推测位置，也不在登录失败时退回固定包。合成传输测试不证明真实Auth、SQL、HTTP或浏览器验收。

候选解析区分冻结的入库／审核／批次身份与已发布目录身份。独立的标准CSV／GeoJSON及隔离文档入口保留原值、定位、几何与既有容量限制，记录ID由Worker按固定输入绑定。解析接线本身不持久保存候选、不授予权限、不注册能力，也不发布资料。

默认Worker在受管检查点冻结后调用候选处理器，恢复同一待审入库任务时再次调用。迁移`0037_ingestion_candidate_storage.sql`在强制RLS的私有表中保存原件绑定、解析状态及原值／几何。处理器读取隔离原件前核对检查点哈希、当前服务器策略和完整原件集合；提交前再次核对原件哈希与任务租约。临时失败回滚批次后重试，部分解析和不可解析保留实际状态；已提交批次不重复解析。候选处理不把任务标为成功、不创建目录版本、不产生图谱投影事件，父任务仍返回WAITING_REVIEW。读取限定当前固定检查点、策略、范围与提交／委托主体，或同一Worker租约。HTTP及受管候选准入、独立审核者读取检查见下节；真实Auth与浏览器回验仍单独验收。

### 待审候选受权读取

`data.ingestion.candidate.get/records/geometry` 1.0 分别提供候选原件结果、原始记录和 WGS84 几何，与已发布目录版本分开。每次请求固定 `kind: ingestion-candidate`、接收编号、冻结审核哈希和解析批次；记录及几何分页还固定原件编号。摘要给出全批已解析记录／几何的已知总数及未解析原件数，不能当作去重业务观测数。原件保留不可变 SHA-256；未支持等结果保留 null 计数和原因。

读取要求 `data.operation.read`，并由不可变提交者／委托人持有当前项目接入维护权限 `data.ingestion.write`，或由持有 `data.publish` 的独立人工审核者读取。0038 迁移以可信事务内的身份、用途及当前权限事实执行强制 RLS；委托变化、旧记录身份不明、策略撤回或审核检查点改变均拒绝。受管项目新增这三类候选读取及下述自有接收路径，不扩大已发布资料权限，其他尚无归属检查的维护接口仍不放行。Worker 的有效租约读取保持不变。更新 API／Worker 前须依次应用 0037、0038、0039 并重新配置运行角色。

分页游标绑定引用、视图、原件、当前身份／委托人、用途、策略和资料授权范围；每页最多 200 项且不超过 3 MiB。SQL 先取有界字节前缀，再按最后实际返回的完整记录续读；超限单条几何明确失败。null、数值零、空文本保持区别。几何保留规范 WGS84 点／线／面／集合、来源 CRS 和原文定位，不生成中心点或猜测站点。REST、GraphQL、MCP／Skill 共用同一能力边界。本切片尚不替代真实 Auth／PostgreSQL／浏览器验收、原件下载接线和完整候选保存流程。

候选原件沿用标准流水线的 `FINGERPRINTED` 状态：未绑定目录版本，扫描结果为 CLEAN，输入、资产与内容对象的哈希一致，字节数量一致。`0039_candidate_fingerprinted_original.sql` 只更正候选守卫的状态接线，保留 0037、0038 校验和及既有生命周期约束；不重新扫描、不降级为 QUARANTINED、不创建 RAW 原件或发布版本。

### 合格 READY 历史批次限界读取

追加 `0045_candidate_historical_ready_reads.sql`，只在服务器严格解析的固定引用范围内，允许读取被新计划替代、已正常完成且不可变的 READY 批次。强制 RLS 使用实际批次行，核对旧计划／哈希／治理快照、当前 CLEAN 输入的完整成员与哈希，再对真实较新计划复用原当前读取谓词。历史谓词不回查候选子表、转换结果或目录原件，避免策略递归；当前主体／委托、用途、密级、策略及失败／取消会话检查继续有效，Worker 最新计划及租约写入不变。

现有 get／records／geometry、转换来源及原件适配器设置事务内的有限固定选择；没有明确选择时清除历史范围。不增加公开输入、scope、项目历史枚举、调用方资格声明、已发布身份或新状态载体。原件交付仍独立核实际原件、哈希、长度和权限。一般 PARTIAL、待处理和未完整完成的结果不准入；D1 窄 PARTIAL、保存视图的历史查询／列表、最小不可用回执及完整 v2 恢复仍须接续实现。定向 API／静态检查和被跳过的条件 PostgreSQL 用例不证明真实 Auth／RLS 或原件交付通过。

### 受管待审接收与候选发现

内部`data.catalog.create`执行器仅在携带受管资源范围时，于开启事务或读取旧回执前检查同一当前维护资格。同时要求`data.operation.read`与`data.ingestion.write`是维护角色定义的一致性要求，目录创建本身并不需要读取操作。旧范围仅有接入写入权限的调用仍可创建草稿并重放。目录请求摘要及SQL保持原样，不安装待审接收范围、不锁定入库会话。公共受管目录创建仍未放行；内部执行器控制不表示真实Auth或SQL／RLS验收通过。

标准`data.uploadSession.create/complete`、`data.ingestion.create/submit`及`data.ingestion.get`通过当前维护权限和归属守卫接入受管项目。写入同时要求`data.ingestion.write`和`data.operation.read`，在返回旧回执或处理对象存储前检查可信身份、用途、期限及当前项目。上传责任由服务器保存于不可变Operation请求信息；原人类提交者或负责委托的人类可继续维护，委托主体须同时匹配原身份类型、身份编号和委托人。旧记录责任不明时拒绝。创建只绑定已完成、自有且处于QUARANTINED的资产，不清除资源范围或扩大已发布内容权限。受管幂等请求同时绑定身份类型、委托人、用途和资源指纹，重试重新检查当前归属。

待审归属与独立审核只比较经过校验的UUID身份，不以字母大小写区分同一人。API将新上传责任和可信事务范围内的主体、委托人UUID写为规范形式，避免原提交者仅换大小写就被视为独立审核人，或同一归属人被误拒。既有幂等键与游标仍沿用原范围绑定。

`data.ingestion.get`1.2增加必填、可为null的`candidateReference`，返回实际冻结的`kind: ingestion-candidate`、`ingestionId`、`processingBatchId`与`reviewHash`；没有可读的已完成解析批次时为null，不构造已发布`versionId`。详情在读取质量、Agent或投影摘要前先检查归属，或检查当前独立人工审核权，再用一致快照读取会话及候选引用。1.0和1.1严格输出契约继续归档，REST、GraphQL、MCP和Skill采用同一注册契约。只使用返回的引用衔接现有三项候选读取。

`data.operation.get/events`仅允许读取确切的标准`data.uploadSession.create`或`data.ingestion.create`任务。每次先检查可信Auth、当前获权用途、期限及资源范围，再按不可变上传责任或入库会话责任判断归属，随后才读取状态、错误及事件。当前维护权限允许原提交主体／类型／委托人，或负责委托的人类继续查看；当前发布权限只允许独立人类审核者读取。旧记录责任不明、非接收任务及跨人／项目范围均拒绝，且不泄露诊断信息。受管事件游标另外绑定主体、类型、委托及用途；新的当前合法用途可发起新请求，但不能重放原游标。受管错误保留既有稳定错误类别格式和可重试标记，无效上游类别映射为`HANDLER_UNEXPECTED`，自由诊断文字统一为`Operation failed.`，事件不返回原始消息；提交元数据与存储键不进入响应。继续使用会话RLS与既有Operation不可变触发器，不增加Operation策略或迁移。旧范围读取及DTO／发现归档保持原样。恢复／取消、批准／拒绝及其他维护能力仍未放行。候选发现和状态读取不授予专业批准或发布权；真实Auth、SQL／RLS、Worker和浏览器链须单独完成验收，不能由合成测试替代。

内部`data.ingestion.resume`执行器对携带受管范围的请求，在恢复及同键回执重放前检查当前维护权限、不可变提交／委托责任和同键用途绑定。公共受管准入仍拒绝恢复；这项守卫不表示真实Auth或SQL／RLS验收通过。

内部`data.operation.cancel`执行器安装既有受管待审接收范围，在生命周期写入前检查当前维护权限及锁定会话的既有归属、提交主体／类型／委托责任。不可见或责任不明的会话安全拒绝，不转入普通任务取消。同键重放再次核当前权限与责任；受管请求摘要绑定主体／类型／委托人和用途。旧范围取消及运行任务租约／取消函数保持原行为。公共受管取消仍未放行；隔离执行器检查不代表真实Auth、SQL／RLS、函数内事件或事务提交验收通过。

内部受管恢复的新回执将经过校验的主体、委托人UUID按规范形式纳入完整请求摘要。重放必须匹配完整的规范化请求摘要，或旧回执采用的完整原请求摘要，再通过相同的当前权限和不可变责任检查。旧请求按原样重试仍可返回原结果，不改写旧回执；旧大写或混合写法回执与两种完整摘要都不匹配时继续拒绝，仅凭已存摘要不能证明原UUID写法。旧范围及其他命令保持原哈希，公共受管恢复仍未放行。

### 网页候选读取通道

网页服务端 DAL 保留旧的 `ingestion` 方法，新增严格的 1.2 `ingestionDetail`，保留可为 null 的候选引用，并核对接收编号及服务器配置的租户／项目。`candidate` 方法复用已注册的 get／records／geometry 路径和严格输入／输出契约：路径消耗接收、处理批次及原件编号，GET 查询保留 kind、审核哈希与分页参数。返回结果必须匹配完整固定引用和请求原件，条数不得超过 `first`，空页不能带有续页游标。

同源 POST 入口 `/api/data-foundation/candidates/[action]` 仅提供这三类读取，流式 UTF-8 JSON 请求最多 16 KiB，并传递浏览器取消信号。DAL 验证既有 Session，由服务器固定租户／项目／用途，拒绝重定向并禁止缓存。超时覆盖认证等待、HTTP 请求及正文持续读取；响应以 3 MiB 和网页配置上限中的较小值为限。取消、契约异常及上游失败只返回安全状态分类，不返回原始诊断或存储地址。该通道不创建已发布版本、不回退本机资料包，也不代表真实 Auth／SQL／浏览器验收通过。

### 固定候选原件读取

候选原件通过独立的鉴权 REST 内容入口读取，请求固定完整候选引用及一个原件，不创建已发布版本、不向调用方重定向存储地址。`0041_candidate_original_reads.sql` 原样保留已发布原件与归属明确的隔离上传策略，仅增加固定引用、当前 API 权限下的待审指纹原件读取。候选记录和原件共用当前主体、委托、用途及期限检查；不可变提交责任和独立审核仍由强制 RLS 约束。

API 只对标准内部隔离对象签名，发送任何字节前核对完整 SHA-256 与准确长度，再核对当前权限和固定引用。GET、HEAD 与单段字节范围共用核验。当前原型支持 1 字节至 32 MiB，超限明确失败。API 单实例在向上游发 GET 前按声明长度预留额度：候选原件活动请求总数最多 4 个、总长度最多 128 MiB，同一租户／项目责任主体最多 2 个。慢速或尚未消费完的响应继续占用额度，完成或取消清理结束后释放；额度已满时不读取对象，返回 `503` 与 `Retry-After: 1`。这些阈值限制单实例的并发缓冲暴露，不代表实测吞吐或跨实例配额。响应禁止缓存、按附件交付并限制浏览器执行，输出各块继续核验权限。授权审计不等于已完成下载。这些实现检查不替代真实 Auth／PostgreSQL／存储／浏览器验收和候选保存流程。

### 候选固定视图持久保存（1.0）

`data.ingestion.candidate.view.create/list/open/revoke`在`service.ingestion_candidate_saved_view`保存有界阅读配置，与已发布`data.explore.view.*`分开。清单固定1–100个唯一接收／审核哈希／处理批次引用；配置限定原件、记录或几何活动页，可选原记录焦点、地图相机／图层及年／月显示时段。创建及打开的UTF-8结果均最多128 KiB。不保存原件字节、解析记录、权限快照、签名链接或假造的已发布`versionId/queryId`。显示时段不使候选读取自动具备服务端时间过滤。

每次操作与幂等重放都检查全部引用，包括非活动成员：须具备当前维护权限并符合不可变提交／委托责任，或符合独立人工审核资格。私有保存归创建人或负责的人类委托人；明确的项目分享仅让原本有权读取全部成员者查看配置。期限结束、审核／处理检查点变化或任一成员不可读时整份拒绝；列表不泄漏隐藏标题，不提供全库总数。保存创建人不会因此变为资料提交人或独立审批人。

创建与撤回复用原子命令、审计及Outbox；新命令幂等身份额外绑定主体类型、委托人和用途，不扩大旧命令。资产／记录锚点由固定批次核实。打开返回`kind: ingestion-candidate-view`、不可变清单及按当前身份重建的原三读请求，不持久保存旧权限游标。原值、null／零和原几何保持不变。只有当前所有人／责任人可撤回；配置不可变，原候选继续保留。

旧列表只读取无版本v1：SQL在游标筛选、排序及`LIMIT`之前排除所有带明确`schemaVersion`字段的`view_spec`。旧打开执行器在解析或返回保存配置前，对此类条目（包括完整v2及未知版本）返回安全的`NOT_FOUND`，不暴露标题、候选引用或规格。有效无版本v1的创建／打开行为和时段显示含义不变。定向执行器回归覆盖v2、未知版本拒绝及v1正控制；真实PostgreSQL混合版本分页和Auth／RLS仍须分别验收。

在0037–0041后追加0042并重新配置运行角色。强制invoker RLS逐项核当前权限与全部候选，限定API角色，不授予Worker写入；重新配置仍只允许`UPDATE(revoked_at)`，禁止DELETE。合成接口／恢复检查及条件启用的回滚SQL用例不替代真实Auth、Worker、数据库、浏览器恢复或受控导出验收。已发布保存与历史契约不变；恢复可关闭新四项能力或回退至兼容构建，保留候选与保存历史，不删除表、重置库或改写迁移校验和。

网页 DAL `candidateSavedView`及同源 POST 入口`/api/data-foundation/candidate-saved-views/:action`复用这四项注册严格契约。创建／撤回必须提供UUID命令键；列表保留`first/after`，打开／撤回将保存编号放入注册路径。打开先核对保存编号、完整清单及选定的候选请求，再由现有候选读取继续；列表拒绝重复编号、已撤回项、超量项和带续页游标的空页。入口流式读取最多128 KiB的UTF-8 JSON，非法编码拒绝；响应以128 KiB与网页配置上限中的较小值为限。现有候选通道继续提供可信Session、服务器固定租户／项目／用途、禁止缓存、拒绝重定向、取消和持续期限。全部成员的当前读取权仍由API判断，旧的已发布视图DAL保持独立。本机接线检查不等于真实Auth／数据库／浏览器恢复验收。

保存视图入口在取得DAL前，将请求体读取限定为30秒。输入停滞时返回安全超时并取消读流，不等待挂起的取消承诺。输入完整读取后结束此计时；随后由现有DAL期限约束Session查验与上游交付，调用方取消始终保留。

候选原件网页入口`/api/data-foundation/candidate-assets/:ingestionId/:processingBatchId/:assetId`接受固定`reviewHash`、可选界面语言及可选`savedViewId`；浏览器不能指定租户、项目、用途或存储地址。服务端在请求前和响应后核验现有会话，再沿候选原件API流式交付；不二次缓存完整原件。响应严格核对1字节至32 MiB长度和单段范围，按需读取、取消与120秒期限贯穿交付；截短／超量终止响应，不将错误正文交付为原件。候选统一按附件及沙箱限制交付，HEAD与416无正文，已发布原件入口不改。原件网页接线本身不证明真实登录、原件存储或完整资料闭环已验收。 分段响应必须严格匹配本次请求的字节区间，包括末尾范围及超长终点裁剪；只有该请求确实超出声明原件范围时才接受不可满足响应。取消时释放上游读锁，不等待挂起的取消承诺。

### 候选资料产品入口

当前候选可直接进入既有空间工作台路由，无须转换成WorkspacePack。服务端先用带当前会话和项目范围的`ingestionDetail`核严格、完整的候选查询及当前四元引用，再挂载共用阅读器。只读入口使用已有候选／原件读取，不提供保存动作；拒权或当前候选已替换时，不回退本地文件，也不扩大为历史候选读取。程序事实仅来自同一获权阅读实例，已知精确总数与已加载分页、声明字段和解析元数据分开；人工清洗／质控责任、采样密度及专业用途缺证保持未知。本轮不新增公开DTO、权限、持久化、迁移或时间规则；月报可信转换门禁及矩阵／专题的领域输入要求仍保留。合成测试不证明真实HTTP、Auth或原件存储验收。

接收详情采用权威、可为null的1.2候选引用，并经网页入口复用已有三项读取。原值、来源顺序、定位、未知数量及原生几何仍与已批准版本分开。仅供展示的私有地图集合保留候选真实记录／资产／来源标识；组合绘制部分不新增位置角色或观测。

查阅页对接已有保存视图四动作，使用明确固定引用和分页锚点。重开在再次检查完整清单后才提交可见内容，后续读取和恢复保留该核对。跨任务链接取自获权恢复引用；失败清除候选内容与保存元数据。原件继续通过固定候选原件入口独立核验当前权限。受支持的二维中心与缩放可恢复，当前阅读相机可另存为新的不可变视图，固定成员及页面／焦点不变。另存其他原件时，未获得其当前镜头便不复用旧相机；原不可变视图不改。同一原件不支持的相机配置、图层开关和时段仍可见且原样保留，显示时段不作为原记录查询过滤。本产品接线不新增数据库／HTTP／权威契约，不能证明真实Auth、PostgreSQL、原件存储或浏览器验收完成。

原件网页入口另接受可选且唯一的UUID参数`savedViewId`，仅作为保存视图上下文。携带该编号时，在读取原件前、原件响应头到达后及每个输出块前调用既有标准`candidate.view.open`，每次重查全部固定成员的当前权限，并核对请求的完整候选四元引用属于返回清单，不缓存权限结果。原件API仍独立检查所选资产的读取权；项目分享不授予下载权，不带该上下文的直接单件读取保持原行为。非法或重复编号在Auth前拒绝。复核共用调用方取消及原件既有120秒期限，保存响应仍以128 KiB与网页配置的较小值为限；原件大小及API并发预算不变。重复复核若耗尽期限则安全停止交付，不延长期限。分开的HTTP调用不构成跨请求事务，已交付字节无法收回。合成运输及有界流检查不代替真实Auth、SQL、存储或浏览器验收。每次内部标准打开仍记录既有能力审计，这些复核不能直接统计为用户重开次数或完成下载。

只读就绪总览包含六个既定地理范围和19类需求。矩阵格与下钻明细调用同一范围下的纯规则，取得、解析、独立专业核验与当前展示许可分别显示。全局资料与记录数按集合去重，不相加重叠范围；无权资料的名称、引用和数量均移除，真实待审资料不继承合成批准。判断缺月所需的历史记录保留，匹配当前时间角色与时窗的记录另列。用途保留UNKNOWN、BLOCKED、LIMITED（有限可用）、CHECKS_PASSED四态、检查标识和规则版本；技术检查通过本身不授予执行或专业批准。不新增持久任务、权限、公开DTO或专业权威。

### 候选原生栅格窗口读取

首个浏览器栅格核心只接受同一Sentinel-2场景中四份已保留B03、B8A、SCL、TCI TIFF的精确哈希。它以`geotiff@3.0.5`解码既有候选原件入口返回的完整字节，不新增栅格API或已发布版本。调用者选择原生整数行列矩形，须处于EPSG:32650的1080×1292、20米格网内，最多4096格。核心核四份SHA-256、尺寸、无符号波段、仿射格网、单图像、来源场景／时间、未声明NoData及这四份精确文件已知的`all_valid`掩膜后才返回原编码值。未知哈希、掩膜、CRS、格式或越界均拒绝；有效0值仍是数值。SCL类别筛选必须给明确允许类别和规则版本，不构成专业质量判定。

网页适配层先完整有界读取候选资产的当前分页；带保存视图时调用标准`candidate.view.open`。四份原件依次读取，合计压缩字节上限16 MiB，随后转交单一隔离Worker；取消或失败会终止Worker。整次选择设120秒期限。交付结果前，再通过四次原件HEAD、完整候选资产读取和必要的保存视图打开核当前访问。每个浏览器模块只准入一项进行中的读取；这是本地内存约束，不是跨标签页或服务端配额。完整原件与解码缓冲仍占内存，16 MiB压缩上限不是进程内存峰值的实测。已保留TIFF的数值窗口与独立Rasterio读数对照；真实Auth、SQL、候选登记、浏览器交互、JP2血缘、地图投影和多边形AOI仍须单独验收。

候选“原件”页只对真实固定候选四元引用提供可选的原生行列像元查阅。界面从完整、有界的当前资产分页中找出四份互异且哈希精确相符的原件；既有读取器仍独立重做完整分页及当前权限检查。单次窗口最多4096个原生格，逐页展示原始波段值与数字掩膜码。用户默认查原值，或显式填写互异SCL类别码与规则版本；界面保留原始类别码频数、固定哈希对应的Rasterio `all_valid`掩膜依据，分别展示掩膜有效、质量选择、联合纳入及排除格数，并说明每格400 m²仅是投影格网足迹，不是实测水面面积或专业批准。从用户提交起，包括资产发现阶段，整次选择最多120秒。切换候选或标签、刷新、取消会中止进行中的读取并清除像元；父级候选读取期间不能启动新栅格选择，保存视图变更也清除旧结果。收到拒绝或固定引用失效的响应后，还会清除候选原件链接，等待新一次获权读取。界面没有后台撤权订阅。该功能是原始像元查阅，不生成已发布版本、地图坐标选择或推断性质量分类，也不代表真实Auth/SQL端到端验收。

### 候选原件服务端输出结果

API 将独立的内部 `data.ingestion.candidate.original.output` 事件追加到已有只追加 `security.audit_event` 载体。原有 `data.ingestion.candidate.original.read`／`ALLOWED` 仍表示签发授权。每次由服务器生成尝试编号，区分完整 GET、单范围 GET 和 HEAD，记录有界的选择／提供字节数、耗时和安全错误码。HTTP `finish` 仅在所选字节已提供后记为 API 输出完成；先于 finish 的 `close` 记为中断。容量拒绝、哈希／长度不符及其他输出失败分别记录终态；首个终态有效，正常 finish 后的 close 不重复追加。

只有可信下载适配器产生的进程内不透明收据能追加结果，在异步签发前固定主体／委托人、租户／项目、候选引用及资产密级和策略。结果写入不重新读取或授予内容权限，不增加客户端 JSON 输入、公开 Capability、权限枚举或迁移。独立 SQL 事务保留 10 秒语句上限；每个追加 Promise 只观察一次，观察时限复用原件操作既有的 120 秒上限，期限届满或本模块关闭时记为未确认，不无限等待。追加失败只输出一次含服务器尝试编号的固定脱敏诊断。观察期限不代表取消 SQL、确认回滚或释放仍活动的连接；迟到结果不会重复诊断，不重试或改写不明写入。既有共享连接池关闭逻辑不变，本切片不据此证明整台服务有全局关闭期限。字节表示提供给 API 响应流的数量，不表示浏览器收件、用户落盘下载或后续网页代理的输出。管理读取视图、真实 Auth／SQL／存储核验及产品验收仍分别待验。

错误响应不等待审计观察。非流式原件预算沿用既有清理：已经等待的原件工作落定后释放，未决且不响应取消的取件仍保留预算。流中核权遇到当前拒绝或暂时失败均停止输出并保留已提供字节前缀；禁止访问或资源不可见记为 `AUTHORITY_CHANGED`，其他失败记为 `UNAVAILABLE`。审计 SQL 仍独立持有连接直到实际落定。既有流关闭清理不变，不能据此证明每个未决核权查询或生成器均已结束；观察期限也不证明全局连接池关闭期限。

网页任务页通过明确动作，以最多100条事件续读既有获权事件流。内部POST传输使绑定权限范围的游标不进入浏览器地址；每次动作仍由既有确切任务API重新核权。网页核对页面身份、事件顺序与续读头，失败隐藏原内容。未新增任务权限、公共API、SQL或迁移；真实权限和数据库验收继续单列。

共享API宿主仅从既有事件GET的请求日志URL副本移除`after`参数，包含编码／重复键和编码任务编号；真实请求、授权、游标校验与其他查询参数原编码保持不变。默认与显式请求serializer收到安全URL／raw URL／original URL副本，关闭日志仍保持关闭。外部代理日志和独立自定义日志不在本项验收内。

已登记的 `RESUMED` 事件在 API 和网页读取中保留事件类型，显示为“已恢复 / Resumed”；事件标签不改变独立的任务状态。内部 `PROJECTION_COMPLETED` 与 `PUBLISHED` 里程碑仍归一为 `PROGRESS_REPORTED`，网页读取器继续拒收未登记的事件类型。

## 候选就绪引用与报告期

纯就绪模型保留已发布作品／版本／资产的原键和计数。嵌套的 `candidateReference` 在独立命名空间中固定接收编号、审核哈希、处理批次及资产；候选批次／资产／记录分别计数，任一来源缺少作品声明时，来源声明作品数仍为未知。这些引用不授予读取权限，也不生成目录身份。

`beijing-monthly-docx-c3/1.0.0` 保留历史 `PUBLICATION` 输出。显式的2.0.0投影将题名月份标为 `REPORT_PERIOD`；发布日期和文档级观测日期须有各自原文定位与精度，否则为null。源内编号、原类别、空格和解析拒绝条件保持。承载 `report-period` 的本地空间包、保存场景和专题导出采用规格2，规格1不静默获得新含义。URL适配显式对应 `REPORT_PERIOD` 与 `report-period`；整月转为日边界仅供筛选，不产生逐日观测。转换可信、当前Auth、候选持久化及端到端验收仍各有独立门槛。

### 候选专题版本边界

独立完整专题v2合同检查点固定明确的问题／时间角色、记录选择、规则版本、原件／记录／整记录几何依赖及关系修订／决定pin。保持100个引用和128 KiB原上限，无版本候选视图v1及已发布探索保存不变。纯形状校验不证明当前来源授权或转换可信。详见[合同检查点](/protocols/data-rest/#完整候选专题规格-v2合同检查点)。旧列表／打开保持上述版本隔离；新专题能力和原保存表迁移已在下方接线，实际混合版本SQL分页与真实Auth／RLS恢复仍须分别验收。

服务器校验器复用当前候选范围、不可变提交责任、完整清单及页码／焦点锚点，核对真实候选、原件及解析器记录，并按不同用途生成记录和整记录几何指纹。记录JSON按key排序，保留数组顺序及PostgreSQL数字原值；几何使用精度15的完整EPSG:4326 GeoJSON和既有大小上限。可信宿主提供器须返回所选区域／需求实际采用的完整规则集；非空关系pin还须返回确切候选修订、当前决定版本和每项固定来源依赖。提供器缺失时拒绝，源内对象key须有明确权威映射。新增专题创建／打开及版本化撤销执行器在同一受限连接调用本函数；实际宿主提供器仍是必要条件，不据此证明真实SQL／Auth、转换可信或一般PARTIAL资格。

## 候选原件转换信任

历史原件 O 与上传转换件 P 保留各自身份。转换声明与服务端核验结果分开，调用方的“已核验”标志不能赋予可信状态，历史 P 也不称平台生成。纯函数比较原始表宽、网格、物理单元格、合并、空文本、段落、月份标题及定位，不用文本归一化掩盖差异。限定资格判断可识别仍为 PARTIAL 的批次中已核验且 READY 的 P，不修改真实批次或原件状态；当前权限和完整记录分页仍须调用链核实。

0043 迁移增加私有、不可变的 `ingestion.candidate_conversion_check` 载体，要求有效处理租约、精确冻结成员、不可变提交责任及当前治理，核验结果与候选完成须同事务提交。固定来源窄读已注册为 `data.ingestion.candidate.provenance.get`，使用严格输入／输出契约、受管准入和标准 PostgreSQL 读取运行时。REST、GraphQL 及经 HTTP 调用的 MCP 映射复用当前候选权限，只返回有界摘要。Worker 已接入声明冻结、独立清单核对及同事务写入的私有转换端口；默认没有受信适配器时保留 `UNVERIFIABLE/TOOL_UNAVAILABLE`。真实受信 O → R′ 转换、Auth／PostgreSQL／RLS／HTTP 及原 A13 验收仍未核实；公开读取接线不等于转换闭环可用。

严格的 `wiser.candidate-conversion-claims.v1` 声明只放在 `M.record.candidateConversionPairs` 保留键，含1–128对 O/P、源内作品编号及可空的历史工具版本，不含 M 身份、已核验标志或工具摘要。来源登记入口核实际成员哈希、大小及 DOC/DOCX 角色，从已核字节补齐 M 身份，在 `reviewHash` 前冻结完整声明；候选端从实际 M 独立派生声明，差异即拒绝。受信宿主端口读取实际 O/P 字节、发现工具身份并比较 P/R′ 完整 Word 结构，摘要哈希覆盖完整结构。实际资产结果保存后、批次仍为 PENDING 时写入核验，随后执行原提交前租约锁及完成操作。权限或数据库错误整事务回滚，明确工具失败保留有界原因；无键旧输入沿用原流程，已完成批次不补写。宿主端口须限制工具执行时间并透传取消／失租检查错误；单元调用顺序不能证明 PostgreSQL 并发验收。

私有 `word_structure.py` 读取器用已有 `defusedxml` 直接处理实际 DOCX ZIP/XML 字节，返回支持范围内的全部物理表格，包括嵌套表格、单元格定位、列位／跨度／纵向合并、明确的单元格／表宽、网格宽度、空文本和全部段落。主文档、页眉、页脚、脚注、尾注及批注保留稳定的部分定位；月份标题只是段落原文中的字面子集。危险归档、DTD／实体、不支持的修订／旧式合并／替代内容、过深结构或超限均明确失败，不返回部分结构。旧记录解析器及 HTTP 请求不改。可选 `createCandidateConversionHostRunner` 必须显式核对可执行文件／提取器源码哈希、实际稳定工具版本及平台，使用独立临时 profile、清洁进程环境、有界输出及每个子进程最多120秒的期限。权限回调错误直接传播，严格的私有 `UNVERIFIABLE` 结果保留原四类原因。默认不启用该工厂；它不证明工具来源、许可、依赖库或操作系统沙箱合格。合成 DOCX／schema 及测试可执行程序的进程检查不代表真实 O → R′ 转换、PostgreSQL 并发或 A13 验收。

`structure.pythonPath` 只校验绝对路径，工厂不固定解释器摘要；提取器脚本哈希不能证明解释器及依赖闭包可信。只有核心会话已实际准入的完整任务运行镜像，或已准入的宿主解释器及全部依赖闭包，才可使用该工厂；已有 parser 基础镜像摘要不覆盖任意宿主 Python。当前完整运行环境尚未准入，稳定转换包的取得及哈希核实不等于安装或运行准入。真实八份 DOCX 的不支持构造清单、原值及 A13 核对仍是后续验收，未完成这些核验。

## 候选关系私有载体

候选关系内容保存在 ingestion 私有域，与已发布断言分开。每次修订固定候选四元、源内端点、谓词、完整 context、来源证据、映射／规则版本及不可变的提交主体、委托人和用途。所有谓词均须有 context，包括既有水系谓词；跨来源 IDENTITY_MATCH 须固定两个不同的候选端点并保留双方证据。候选身份不转换为 catalog 版本或已发布 row_version。

迁移0044分别保存不可变内容修订、固定证据、关系／来源责任与追加式决定。新修订从 PENDING_REVIEW 开始；CONFIRMED 是候选决定，不等于专业 APPROVED 或发布。独立决定者须为非委托人类，排除关系提交者／委托人及全部相关来源提交者／委托人。WITHDRAWN 仅供当前责任提议人在待审阶段撤回；REVOKED 表示确认后撤销。内容修订与 decisionVersion 分开，决定版本0表示尚无决定。

内部固定 pin 读取器使用调用方的范围化 PostgreSQL 客户端与当前授权上下文，核对确切历史内容修订及其实际最新决定版本，返回有界的固定候选／原件／记录／哈希依赖。关系选择为空时保持为空；材料缺失、变化或不可读时拒绝，不替换为当前版本。每项依赖重新核对既有候选／来源 RLS。本载体与读取器不启用公开关系命令、不授予来源权限、不生成已发布图投影，也不代表 A7 已验收；真实 PostgreSQL、Auth、并发、公开写执行器及浏览器仍需分别验证。

### 固定引用的内部接线

专题预备校验器设置已严格解析的完整候选清单；关系读取适配器在调用方已有的同一数据库连接中接收相同清单，不另起事务、提交或释放连接，返回的来源依赖不得超出该清单。异步适配器返回后，校验器重新设置原解析清单，再核全部实际成员。固定清单仅收窄历史 RLS，并不授予资料访问权；当前身份权限、全部实际清单成员及资料与规则守卫继续生效。

无版本号的保存视图创建采用完整输入引用；列表、打开、重放和撤销只允许已经通过保存行 RLS 的行，以其实际保存的完整引用重新核清单。不同列表行不合并选择范围。初始不可见的旧v1历史保存行仍返回 NOT_FOUND；v2清单启动和最小所有者回执通过下方0046接线，未配置宿主时规则仍安全拒绝；源内对象提供者及可信转换仍需独立集成。合成 GUC／适配器测试与原生测试清单接线不表示已通过 PostgreSQL／真实身份验收。

## 完整候选专题服务器接口（0046）

完整专题复用不可变的候选保存表，以 `schemaVersion: 2` 明确分派。新增三个 1.0.0 能力 `data.ingestion.candidate.topic.create/list/open`，固定完整候选清单、分页／焦点／地图、月窗或日窗与时间角色、问题／区域／需求、整记录与整几何哈希、实际四类规则版本，以及可选的候选关系内容修订和决定版本。创建保持 100 引用、128 KiB 上限，复用命令事务、幂等、审计及 Outbox；同键重放仍须重新核验当前权限。

旧 DTO、旧列表和旧行不自动升级。专题列表逐行标明 `specVersion: 1|2`，重开返回相应 READABLE 分支，v1 不补造问题或规则。既有撤销能力按存储版本明确分派。v2 创建、重放和重开在同一限定连接核实际资料与宿主权威；缺少规则、所需关系或来源对象提供者时安全拒绝，默认接线不从调用方 pin 补造权威。规则或决定变动不会静默替换固定版本。

0046 先按该不可变 v2 保存行自身的完整引用，复用当前候选 FORCE RLS 核历史读取，再恢复原事务选择；不建立历史候选枚举，不放宽一般 PARTIAL。内容失效后，仅当前原保存者或责任委托人，在相同项目、用途、密级／策略及有效身份期限内，可取得严格 `{status:'UNAVAILABLE',viewId}`。已有受限元数据角色仅有该表 `SELECT(view_id)`，回执策略另限定一个请求 ID；无标题、配置、引用列权限，无 BYPASSRLS 或 definer。列表遇到迟到的失权时整页拒绝，不泄露标题或续页身份。条件 PostgreSQL、真实 Auth 和浏览器验收与合成事务／传输测试分别记录。

### 有限专题宿主配置

启动配置显式采用 `goal101-engineering-inspection/1` 工程检查配方：`DATA_CANDIDATE_TOPIC_PROFILE` 选择固定配方，`DATA_CANDIDATE_TOPIC_TENANT_ID`、`DATA_CANDIDATE_TOPIC_PROJECT_ID` 和 `DATA_CANDIDATE_TOPIC_PURPOSE` 精确绑定已配置的项目及现有 Auth 用途。四字段必须完整，禁止通配或首请求自注册；缺配置时专题权威继续失败关闭。运行时将提供者注入实际候选保存 executor。两套月报规则分别保留：旧 1.0.0 调用原 PUBLICATION 投影，新 2.0.0 调用 REPORT_PERIOD 投影；不能把旧路径称为新版本。需求规则定义摘要与需求输入版本分别记录，登录读取不查本机固定包。六区域与19需求仅为选择目录，不授资料读取权、不生成归属事实或专业批准。关系在同一保存 client 上读取固定修订和当前决定，并重核引用与权限；无可信源内对象映射时 `sourceObjectKey` 继续拒绝，整记录兼容路径保留。私有宿主模块记录定义摘要及本轮工程采用，不创建外部专业标准或公共协议。真实 SQL／Auth／浏览器验收另行记录。

## 取消命令死锁恢复

共用命令执行器仅在`data.operation.cancel`收到PostgreSQL的`40P01`且回滚成功后重试一次。先释放连接，再重开完整事务，重新检查请求身份与范围的有效期、待审维护权限、行可见性、提交责任、乐观版本及同键回执；这不等于重新向Supabase解析身份。其他SQL错误、回滚失败和带对象存储副作用的命令不重试，第二次死锁返回既有脱敏持久化错误。公开准入、生命周期SQL、锁顺序、限额及旧迁移保持不变。

公共执行器先锁入库会话，再锁任务和操作；原生直接辅助函数探针采用不同入口。执行器故障注入验证的是有界恢复，不证明HTTP已复现死锁，也不表示锁环已根除。真实Auth／HTTP与数据库并发验收分别记录。
