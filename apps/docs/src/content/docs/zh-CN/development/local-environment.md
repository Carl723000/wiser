---
title: 本机开发环境
description: WISER 完整栈、单应用开发、端口、身份、日志、停止与重置参考。
docType: runbook
scope: repository
status: active
authoritative: true
owner: wiser
language: zh-CN
whenToUse:
  - 选择本机运行模式或排查服务启动问题时
whenToUpdate:
  - Compose profile、端口、脚本或环境变量变化时
checkPaths:
  - package.json
  - compose.yaml
  - .env.example
  - scripts/data-foundation/**
lastReviewedAt: 2026-10-08
lastReviewedCommit: afe653f892264f5fe9b26b46cb285250c3748888
---

## 运行模式

| 模式         | 命令                      | 能证明什么                                                                 |
| ------------ | ------------------------- | -------------------------------------------------------------------------- |
| 完整平台     | `pnpm stack:full:up`      | 统一 Auth、持久 EXCON API、Data Foundation、Data MCP 与登录 Web 的默认集成 |
| 基础栈       | `pnpm stack:up`           | Supabase + 默认 Compose；API 使用本机兼容配置，不启用 Data profile         |
| Data profile | `pnpm data:up`            | 在已可用的本机 Supabase 身份上启动默认服务和全部 Data 基础设施             |
| 可观测性     | `pnpm observability:up`   | 在共享应用镜像已构建后启动 Telemetry Ingress 与 OTel/Grafana 栈            |
| 单应用       | 使用下面的 workspace 命令 | 纯 UI、协议或单元测试循环                                                  |

`data:up` 不是脱离平台的独立数据栈：它读取运行中的本机 Supabase 状态、登录 seed operator，并通过 Compose profile 连同默认应用服务一起收敛。干净机器应优先使用 `stack:full:up`。

## 宿主准备

本地开发必须加载 `compose.override.yaml`，显式指定文件时也要包含它：`docker compose -f compose.yaml -f compose.override.yaml ...`。如果还需要 case/runtime 文件，仍须保留本地 override，并在启动、构建或重建服务前核对合并顺序和最终配置。保留用户手动修改的本地配置，不得静默覆盖其中的端口、源码挂载或开发命令。配置检查与后续 Compose 操作使用同一组文件；`docker compose ... config --quiet` 可校验配置而不打印解析后的秘密。

Data 运维脚本仅在本地 override 不存在时，以仅文件所有者可读写的权限创建 `services: {}`；已有文件的字节保持不变。因此，干净克隆先使用仓库默认配置，再由操作人员提供明确的本机覆盖。

额外 Data 项目可启用独立的 `data-worker-project` 服务，复用有界 Worker 代码与依赖，不暴露主机端口。由已核验的控制面上下文设置 `DATA_PROJECT_WORKER_TENANT_ID`、`DATA_PROJECT_WORKER_PROJECT_ID` 和 `DATA_PROJECT_WORKER_POLICY_VERSION`，并将 `DATA_PROJECT_WORKER_IMAGE` 指向已经部署且与 API 匹配的 Worker 镜像。缺失配置会留下无效项目/策略值和不可用镜像，使服务拒绝启动。在既有 Compose 文件列表上增加 `--profile data-foundation-project`，先核对合并后的镜像、挂载、范围、策略版本与无主机端口，再执行 `up -d data-worker-project`。对于已过期的旧入库任务，应先应用迁移 0032、部署匹配的 API，再对同一 Operation 使用 `data.ingestion.resume`，最后启动该项目 Worker。默认 Worker 仍只处理原项目。

- 完整 Data profile 会同时运行数据库、ClamAV、搜索、图谱与 GIS，资源上限以 `compose.yaml` 为准；启动前确认 Docker 可用容量与磁盘，而不是依赖一个未经仓库验证的“最低配置”数字。
- 部分镜像在 Apple Silicon 上使用显式 `linux/amd64` 模拟，首次拉取、初始化和健康检查会更久。
- 安装和首次构建需要访问 npm registry 与容器 registry。
- OpenSearch one-shot init 会下载并校验与 3.8.0 精确匹配的官方 `analysis-icu` 与 `analysis-smartcn` 插件；readiness 要求两者同时出现。插件使用独立命名卷，版本或 checksum 变化时应在可丢弃环境执行确认式 Data reset，再从权威数据重建版本化检索投影。
- 启用 Data profile 时，API 会等待该初始化任务导出 OpenSearch CA 后才启动。Node 在进程启动时加载 `NODE_EXTRA_CA_CERTS`，之后补齐文件无法修复已启动 API 的信任配置。未启用 Data profile 时该依赖为可选，基础栈仍可独立启动。
- 确认下表端口没有被其他进程或旧 Compose project 占用；端口冲突时先定位占用者，不要随意改一端而遗漏相关回调、CORS 或 smoke 配置。

## 主要端口

| 服务                                         | 本机入口                                             |
| -------------------------------------------- | ---------------------------------------------------- |
| Web                                          | `http://127.0.0.1:3100`                              |
| API / OpenAPI                                | `http://127.0.0.1:3101` / `/openapi.json`            |
| EXCON v1 compatibility Worker health         | `http://127.0.0.1:3002/health/ready`                 |
| Docs                                         | `http://127.0.0.1:4321`                              |
| Data Worker health                           | `http://127.0.0.1:13003/health/ready`                |
| MCP HTTP                                     | `http://127.0.0.1:13004/mcp`                         |
| Supabase API / PostgreSQL / Studio / Mailpit | `56321` / `56322` / `56323` / `56324`                |
| data-postgres                                | `127.0.0.1:55432`                                    |
| SeaweedFS S3                                 | `http://127.0.0.1:18333`                             |
| Weaviate                                     | `http://127.0.0.1:18080`                             |
| OpenSearch / Dashboards                      | `https://127.0.0.1:19200` / `http://127.0.0.1:15601` |
| Neo4j HTTP                                   | `http://127.0.0.1:17474`                             |
| Tika / ClamAV                                | `http://127.0.0.1:19998` / `127.0.0.1:13310`         |
| Telemetry ingress / Grafana / Prometheus     | `14318` / `3300` / `9090`                            |
| OTel gRPC / HTTP / health                    | `4317` / `4318` / `13133`                            |

GeoServer、STAC API、TiTiler 与 Martin 没有 host port；只能由统一 Auth 后的 API 代理访问。

Compose 与独立开发都使用 Web `3100`、API `3101` 作为宿主机入口；Compose 内部端口仍为 `3000`、`3001`。浏览器参考测试使用 `3200`，独立 EXCON Lab 默认使用 `3201`，独立 MCP HTTP 默认使用 `3004`。Supabase Auth 回调使用 Web 的 `3100` 地址，无需本机端口覆盖配置。

现网 OAuth 部署工作树的 `supabase/config.toml` 已把 Site URL、外部 Auth URL 和 JWT issuer 指向公网 HTTPS `:7100`；上表仍描述独立本机开发端口。不要把该现网配置直接用于独立 localhost 登录测试；在单独的本机工作树中设置相应的本机 URL 与回调，部署工作树保留公网配置。现网 Auth 标准发现路径经路由器精确放行，MCP resource 为公网 `/mcp`，与容器内部 transport 地址分开。

## 单应用命令

在不同终端中按需启动：

```bash
pnpm --filter @wiser/api dev
pnpm --filter @wiser/web dev
pnpm --filter @wiser/docs dev
```

也可以用 `pnpm dev` 并行启动这三个进程：Web 固定在 `3100`，API 默认使用 `3101`，Docs 固定在 `4321`。API 在缺少生产配置时使用 Auth off、Agent EXCON memory、Data Foundation off 的本机兼容模式。这个模式适合协议和 UI 循环，不验证统一 Auth、数据库持久化或 Data 功能。

## 身份边界

Data Foundation Web 使用 Supabase SSR Session，完整栈会为 Data smoke 和 Data MCP 注入本机 operator JWT。Agent EXCON live Web 转发已验证的当前 Supabase 用户 Session，`WISER_WEB_OPERATOR_TOKEN` 仅用于本机 Auth-off 预览；EXCON MCP 仍需要绑定具体 RunAgent 的 `AGENT_EXCON_API_KEY`。因此“进程健康”不等于这两个 EXCON 客户端已经获得有效身份，失败时必须保留显式 unavailable/鉴权错误。

共享 MCP 进程总会初始化 EXCON HTTP client；即使只开发 Data MCP，也必须配置非空 `AGENT_EXCON_API_KEY` 和完整 `DATA_*`。Data Tool 不会发送该 EXCON key，因此本机占位值可以用于 Data-only 进程配置；它不是统一 Auth 身份，也不能调用 `excon_*`。

### 如何取得本机身份

仓库 Auth 配置已关闭公众自行注册；保留邮箱认证以供已有账户登录。本机 fixture 登录、经授权的管理员邀请与公众注册入口分别处理。已由 Compose 管理的现网 Auth 还须在持久运行配置中设置 `GOTRUE_DISABLE_SIGNUP=true`，并只重建 Auth 服务；仅修改 `supabase/config.toml` 不会改变已运行的容器。

CLI 邀请模板读取 `apps/web/public/auth-email-templates/invite.html`；Compose 管理的 GoTrue 须通过 `GOTRUE_MAILER_TEMPLATES_INVITE` 获取部署后 Web 的 `/auth-email-templates/invite.html`。投递前核对实际生成的邮件、公网邀请链接及访问日志隐私。当前共享服务器的 SMTP 仍为内部 Mailpit 收件服务，只能证明内部邮件已生成，不能证明送达外部收件人。

- 人类开发者在 `/zh-CN/login` 使用 quick-start 的 seed operator 登录，Web 通过 Supabase Session 访问 Platform 与 Data 页面。
- Agent/服务 delegated credential 由有 `platform.delegation.manage` 的 Supabase 人类通过 `/api/platform/v1/delegations` 创建、签发、轮换和撤销；明文只返回一次。
- EXCON MCP 的 `AGENT_EXCON_API_KEY` 必须来自受信任的 Run 编组/bootstrap，并绑定一个具体 RunAgent。仓库没有把 seed 密码自动换成通用 EXCON token 的 CLI；本机完整协作可使用版本化 Cookbook/Showcase 创建受限会话。
- EXCON live Web 复用当前登录用户 Session，并要求该用户具有 operator 授权；Supabase 模式不需要单独签发 Web operator token。

具体 header、scope 与调用顺序见 [Platform Auth](/architecture/unified-auth/)、[Agent EXCON HTTP](/protocols/http/) 和 [MCP](/protocols/mcp/)。

## 环境变量与秘密

提供方可用以下可选自查命令，将原件的流式 SHA-256 和字节数与有大小上限的已保存解析记录比对：

```bash
pnpm exec tsx scripts/data-foundation/intake-preflight.mts /absolute/original /absolute/profile.json
```

只有文件完全对应时才复用解析事实。检测到 HTML 仅确定已保存内容的类型，保留对应文档的解析结果，不能证明介绍页所述数据集已经取得。文件变化后须重新解析已保存原件；原解析记录无效时仍保持无效。该命令不下载或写入服务器数据，输出仅属提供方自查；接收 API 独立核对已保存来源及解析结果。

Web 与 Docs 通过公开的 `WISER_AGENT_SETUP_URL` 生成可复制的智能体接入指令，本机默认为 `http://127.0.0.1:3101/agent-setup/prompt.md`。部署时指向公开 API，生产 Docs 构建时也需提供。API 的 `DATA_PUBLIC_API_ORIGIN` 控制按内容固定的 Skill 下载地址。发行校验与独立的身份连接见[智能体接入](/protocols/agent-setup/)。

Data Foundation Skill 的研究数据包辅助脚本使用 Python 3 标准库。清点阶段校验包清单和下载清单，将注册入口合并到完整数据源目录，并核对清单外文件，保持来源目录不变。运行 `python3 -B skills/wiser-data-foundation/scripts/water_bundle.py inventory --bundle /absolute/source --out /absolute/output/inventory.json`。这是本机准备步骤；正式入库只能通过统一 HTTP API。Skill 参考文档说明凭据排除、脱敏副本、完整性状态与显式启用的真实案例测试。

Compose 的 `DATA_INGESTION_MAX_OBJECT_BYTES` 默认是 64 MiB，并允许显式环境配置覆盖，可容纳本案例最大的 36,378,636 字节文件。这是 Worker 的单对象上限；来源登记仍逐一校验精确内容，不把部分下载或未解析内容宣称为可分析数据。

`.env.example` 是变量目录，不是可直接用于生产的配置。完整栈会把本机生成的秘密保存在被 Git 忽略的 `<控制目录>/.wiser/local/runtime-secrets.json`；默认控制目录仍是仓库根目录。不要提交 `.env`、数据库 URL、S3 key、Supabase service-role、HMAC key、MCP token 或 Codex 登录文件。

浏览器只能接收 `NEXT_PUBLIC_SUPABASE_URL` 与 publishable key；数据库、对象存储、投影与 operator credential 必须保留在服务端。

### 独立本机控制项目

在调用进程的环境中设置 `WISER_LOCAL_SUPABASE_WORKDIR`，指向已准备好 `supabase/config.toml`、对应迁移、seed 和本机 Auth 回调的控制目录。`stack:full:up`、`data:up` 和纵切 smoke 的默认适配器会把该目录传给 CLI；Node 脚本不会自动把任意 `.env` 文件加载到进程环境中。

`COMPOSE_PROJECT_NAME` 必须与配置中的 `project_id` 相同。配置的 API 和数据库端口决定 CLI 状态、Auth 地址、控制库与 EXCON journal 连接，以及数据库容器身份。`DATA_API_ORIGIN`、`DATA_WEB_ORIGIN` 和 `DATA_MCP_ORIGIN` 必须对应最终 Compose 映射端口；API 公开地址、Worker 的 STAC 原件地址和公开 S3 地址也须与所选 API、存储映射一致。设置这些地址不会改写 Compose 中的固定端口或 URL：需要修改私有 override 或 case 文件，在 `COMPOSE_FILE` 中保留 base 与本地 override，并核对合并结果。

Data Compose 写操作前，脚本编译同一组文件，拒绝外部或归属不符的网络与卷、主机名重定向、固定容器名和存储路径替换；完整栈启动还校验 Supabase Auth 与 PostgreSQL journal 模式。独立项目的主机端口必须绑定回环地址。这是配置归属检查，不代表服务启动或网页验收通过。脚本检查 Docker 端点，仅接受本机 Unix socket，并只在自己的子进程环境中固定端点，不修改用户全局 Docker context。Supabase 启动输出和解析后的运行配置保留在程序内部，不带着密钥打印。

完整栈的 migrate、seed、smoke 子进程继承 `data:up` 生成的同一套运行环境；后续单独执行命令时，也要传入相同控制目录、Compose 项目与文件列表、本机 Docker 端点及各服务地址。角色、连接、回调或凭据变化仍须按授权实测；选择新项目不会获得其他项目的访问权限。

## 日志、停止与重置

以下命令和重置表适用于默认 `wiser` 项目。独立控制项目应保持其所选环境执行 `data:logs` 或 `data:down`，再在同一个已核验本机 Docker 端点上用 `pnpm exec supabase --workdir "$WISER_LOCAL_SUPABASE_WORKDIR" stop` 仅停止对应 Supabase。不要对独立项目使用根目录的 `stack:down`、`supabase:reset` 或 `supabase:verify` 快捷命令，它们仍指向根目录的 Supabase 配置。Data reset 仍限定既有默认项目白名单与明确确认，不扩展删除范围。

```bash
docker compose ps
docker compose logs --tail=200 api web worker docs data-worker mcp-http telemetry-ingress
pnpm data:logs
pnpm exec supabase status
pnpm data:down
pnpm observability:down
pnpm stack:down
```

`docker compose logs` 可以只保留本次失败的 service 名；服务未创建时先用 `docker compose ps -a`。Supabase 由 CLI 管理而不属于根 Compose project；`supabase status` 用于确认服务/端口，具体容器日志从本机 Docker runtime 查看。

`pnpm data:smoke` 先检查 `fixture-bundle`，再并发检查 `authority-migrations`、`pgstac-schema`、`runtime-roles`、`compose-health`、`api-contract` 和 `seed-fixture`。预检失败会阻止进入 vertical，并仅在 cause 中保留固定 `{ phase, errorName }`；异常名限定为安全内置名称，其他情况记为 `unknown`，不带出原异常消息、SQL、响应体或环境值。失败日志仍会尽力收集，收集失败不覆盖 smoke 原因；vertical 的阶段与错误码保持原样。阶段码只指出哪项检查拒绝，不代表已确定根因或可以放宽权限。 运行角色检查另保留固定 `stage`（`role-flags`、`wrong-scope` 或 `fixture-scope`）和 `reasonCode`（`ROLE_FLAGS_INVALID`、`RLS_SCOPE_CROSSED`、`SEEDED_SCOPE_UNREADABLE` 或 `ROLE_CHECK_EXECUTION_FAILED`）。这些字段仅来自本模块生成的异常；未知或伪造错误仍使用通用预检说明。原三项 SQL 和预期结果保持。

本机命令在子进程 `close` 后结算捕获输出，保留 `exit` 后到达的数据。已标识的执行错误另提供有限 `executionStage`（`local-control`、`compose-override`、`docker-endpoint`、`compose-config`、`compose-command`、`postgres-exec`）与 `executionReason`（`CONTROL_CHECK_FAILED`、`PROCESS_START_FAILED`、`PROCESS_INPUT_FAILED`、`PROCESS_OUTPUT_FAILED`、`PROCESS_EXIT_FAILED`）。子阶段分别定位控制配置、覆盖文件、端点、配置检查和命令执行；进程原因只分类控制拒绝、启动、管道或退出失败，不携带原消息、SQL、环境、输出、路径或命令参数。字段来自私有进程内标记；未知执行错误和伪造字段不能产生子阶段诊断。并发预检、三段角色 SQL、RLS 断言与原有超时行为不变；新增诊断和离线回归不证明真实 CI 根因或服务验收通过。

| 操作                                      | 删除什么                                             | 保留什么                                                 |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `pnpm stack:down`                         | 只删除/停止容器                                      | Compose named volumes、Supabase 本机数据、`.wiser/local` |
| `pnpm supabase:reset` / `supabase:verify` | 重建 Supabase 控制面、Auth/EXCON schema 与 seed 数据 | Data Foundation volumes、`.wiser/local`                  |
| 确认式 `pnpm data:reset`                  | allowlist 内的 Data PostgreSQL/S3/投影 named volumes | Supabase、observability volumes、`.wiser/local`          |
| `pnpm observability:down`                 | 停止观测服务                                         | Tempo/Loki/Prometheus/Grafana named volumes              |

仓库没有“一键删除所有本机状态”的命令。各所选控制目录的 `.wiser/local/runtime-secrets.json` 保存对应 EXCON journal 重放所需的历史 HMAC key，现有 journal 仍在时不得删除或只生成新 key。只有在所有服务停止、Supabase/EXCON journal 已明确重置且不需要恢复旧记录时，才可以按团队密钥轮换流程处理该文件；Data reset 本身不需要删除它。

若完整栈失败，先检查 Docker 资源、端口占用和失败服务日志，再重新运行可幂等收敛的 `pnpm stack:full:up`。

Data profile 构建 `source-parser`，它仅通过内部 `data-parser` 网络连接 Worker，不开放主机端口，不持有数据库凭据，也不能访问外网。文件系统只读，临时文件保存在有界内存中。本机单独运行 Worker 时可选配置 `DATA_ANALYSIS_PARSER_URL`；未配置时外部格式明确保持不可解析，完整 profile 自动配置。CI 在固定的 GDAL 镜像中运行解析测试。

## 语义嵌入与索引切换

API 与 Data Worker 必须使用相同的 `DATA_EMBEDDING_*` 配置。CI 和可复现 smoke 保留 `fake`；`NODE_ENV=production` 要求明确的真实 provider。Qwen3-Embedding-8B 通过 OpenAI 兼容的 `/v1/embeddings` 端点接入。服务地址配置在私有部署文件中；浏览器不接收地址或可选 API Key。

```dotenv
DATA_EMBEDDING_PROVIDER=openai-compatible
DATA_EMBEDDING_BASE_URL=http://embedding.internal:7710/v1
DATA_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
DATA_EMBEDDING_VERSION=1.0.0-qwen3
DATA_EMBEDDING_DIMENSIONS=4096
DATA_EMBEDDING_API_KEY=
DATA_EMBEDDING_TIMEOUT_MS=15000
```

`DATA_EMBEDDING_QUERY_INSTRUCTION` 省略或留空时使用已版本化的英文检索指令，仅用于查询。适配器要求返回模型一致，校验该配置下恰好 4,096 个有限且非全零的向量值，并执行归一化。每次最多 16 段文档，每段最多 32,768 字符，响应最多 4 MiB；超限明确失败，不写入截断向量。日志不记录输入或上游响应。

修改模型、修订号、维度或查询指令会派生新的 `WiserEvidenceChunkV3_*` 集合。修订号由运维管理：服务权重或预处理变化时增加版本。准备新集合时，API 继续使用旧配置。使用当前 case 的同一组 Compose 文件（包括 `compose.override.yaml`）启动重建；准备阶段只向重建进程注入新模型环境。

```bash
# Include the running case/runtime file as well when that deployment uses one.
docker compose -f compose.yaml -f compose.override.yaml run --rm --no-deps \
  data-worker pnpm --filter @wiser/data-worker exec tsx src/embedding-rebuild-cli.ts
```

CLI 使用 Worker 明确的租户、项目、安全等级和策略范围，以及每个配置/项目独立的 advisory lock、不可变权威证据、确定性投影 ID 和独立消费位点。它只写目标 Weaviate 集合与重建位点，不重置入库/发布状态，不重放其他投影。中断或失败的事件不推进位点；使用同一配置续跑。

持续运行的 Worker 也按配置的消费者名称和真实嵌入配置隔离位点。首次启动会分批核查保留的历史事件，即使共享投影台账已成功，也会向当前 Weaviate 集合写入证据；其他已成功的投影保持跳过。这一位点与重建位点独立，提前准备集合不会省去首次追赶的工作量。后续启动从该配置的持续消费位点续跑。fake 保留原位点以兼容本机样本及回退，真实配置不会推进该位点。

重建后先切换 Worker，等待其配置位点追上当前项目已提交的事件，核验全部证据覆盖、模型信息与中英文真实案例检索，再把 API 切换到相同配置。保留旧集合；回退也先恢复旧 Worker 配置，让它补齐停用期间发布的数据，确认覆盖后再恢复 API 配置。仅恢复配置不能证明索引完整。嵌入效果提升不会把来源登记内容变成科学证据。

高德官方适配器从 Web 服务端环境读取 `WISER_AMAP_KEY` 和 `WISER_AMAP_SECURITY_CODE`，保存在本机 `.env` 或部署秘密配置中。`/api/maps/amap/config` 仅在会话校验后返回公开 JS API Key。同源代理只允许地图样式和坐标转换，服务端注入安全密钥，限制响应大小并禁用缓存。安全密钥不得使用 `NEXT_PUBLIC_*` 变量；本机 Compose override 仍必须加载。

Data 纵切 smoke 为已登录 Web 目录页 GET 单独保留 60 秒请求预算，以容纳 Next.js 开发模式的首次编译。API 和登录请求仍使用默认 10 秒上限，所有请求继续受整轮 180 秒总期限约束。程序化选项 `webRequestTimeoutMs` 可收紧页面预算（100–60,000 毫秒）；超时不能算作页面断言成功。

smoke 以操作员身份上传、提交、轮询和查询，仅审批 POST 使用第二个人类评审者。本机 seed 提供 `reviewer@agent-excon.test`，密码为 `WiserLocalReviewer-2026!`；这是公开的合成测试值，不是生产凭据。可通过 `WISER_LOCAL_REVIEWER_EMAIL`、`WISER_LOCAL_REVIEWER_PASSWORD` 替换本机登录，或提供 `DATA_API_REVIEWER_BEARER_TOKEN`。程序化调用显式提供 `auth` 时，还须提供 `reviewerAuth` 或评审者 token，租户、项目和用途必须一致。

创建上传前，脚本分别调用已认证的 `GET /api/platform/v1/me`，要求当前范围内两个不同的规范人类主体 ID，并核查评审者当前具有 `data.publish`。Token 字符串不同或自行解码 JWT 都不能证明身份独立。缺少评审认证返回 `REVIEWER_AUTH_CONTEXT_UNAVAILABLE`，无效凭据或上下文返回 `INVALID_REVIEWER_AUTH_CONTEXT`，独立性或范围检查失败返回 `REVIEWER_IDENTITY_REQUIRED`。本机尚未加载评审测试身份时，应在可丢弃环境加载合成 seed，不扩大真实账号权限。生产端仍拒绝提交者及委托者自审，并保留计划哈希、乐观版本、RLS 和发布校验。Mock 请求测试不能代替真实 Auth/SQL 与实际 smoke 验证。

## 对象存储的重启安全

SeaweedFS 启动时将 S3 配置写入 `/run/wiser-seaweed/s3.json`。父目录属主为
`root:seaweed`、权限 `0750`；配置文件保持 `seaweed:seaweed`、权限 `0640`，
供服务读取。这样同一容器再次启动时，无须在公共 sticky `/tmp` 目录中
重新打开服务用户所有的文件。保留宿主机 `fs.protected_regular` 保护，
不要放宽为所有用户可读，也不要通过删除数据卷恢复重启。

核对本地合并后的 Compose 配置后，可运行显式启用的实机回归：

```bash
WISER_TEST_SEAWEEDFS_RESTART=1 node --test scripts/data-foundation/seaweedfs-restart.test.mjs
```

测试使用 Compose 锁定的镜像与启动命令，创建无外部网络、无映射端口、
无业务数据卷的一次性容器，仅用合成凭据。通过 S3 写入测试对象后，
**对同一容器连续重启两次**，每次读取并核对对象，同时检查目录和文件的
属主与权限。默认运维测试跳过这项依赖 Docker 的检查。

不同宿主机的内核保护配置可能不同，本地通过不能代替获授权的目标部署
及读回。修改 Compose 不会改变已创建容器的启动命令；部署时须保留数据卷，
仅重建受影响服务，并检查健康状态及获准既有原件，才能确认恢复。

网页 Data 请求默认使用 `WISER_DATA_PURPOSE=web-console`，与独立获批的网页资源授权一致，Compose 也使用相同值。上线前须核对生成的 case/runtime 文件；`data-steward-console` 等旧覆盖值无法在受管项目中使用 `web-console` 授权。仍支持受信任部署的显式覆盖，但该用途必须另有准确匹配的批准。这是请求上下文，不会赋予权限或自动迁移项目策略。
