---
title: Data REST API
description: Data Foundation's 43 Capabilities, OpenAPI, governed Resources, idempotency, SSE, and asset-download protocol.
docType: protocol-reference
scope: data-rest-api
status: active
authoritative: true
owner: wiser
language: en
whenToUse:
  - when implementing or calling the Data Foundation REST API
whenToUpdate:
  - when Capabilities, routes, headers, identity, idempotency, versions, or errors change
checkPaths:
  - packages/data-contracts/src/capability/**
  - apps/api/src/data-foundation/**
  - skills/wiser-data-foundation/**
lastReviewedAt: 2026-10-06
lastReviewedCommit: daf82f94
---

## Protocol boundary

Data REST lives at `/api/data/v1` in the existing Fastify process; it is not a second service. All 43 business routes call one `DataCapabilityHandler`, which validates input and output with strict Zod 4 schemas from `@wiser/data-contracts`, then enforces live scopes, security level, purpose, timeout, idempotency, and hash-only audit.

MCP, the Skill, and Web's server-side DAL all traverse this HTTP boundary. No caller can submit SQL, Cypher, OpenSearch DSL, shell commands, or arbitrary object-store keys.

## Discovery and health

These non-cacheable reads require no identity:

| Method | Path                                               | Result                                                                             |
| ------ | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/api/data/v1/health`                              | data-postgres, object-store, Worker readiness; any missing authority returns `503` |
| `GET`  | `/api/data/v1/capabilities`                        | ordered 43-item Registry, draft-7 I/O Schemas, and four mappings                   |
| `GET`  | `/api/data/v1/capabilities/:capabilityId/:version` | one fixed Capability version; unknown version returns `404`                        |

A ready response has this core shape:

```json
{
  "status": "ready",
  "system": "data-foundation",
  "authority": { "database": true, "objectStore": true },
  "worker": true,
  "projections": "rebuildable"
}
```

`projections: rebuildable` means projections are not authorization authority. It never permits omission of Tenant/Project/security filters.

## OpenAPI contract projection

Shared `GET /openapi.json` returns OpenAPI 3.1 with the fixed title **WISER Platform API**, covering Platform, Agent EXCON, and Data Foundation. The 43 Data Capabilities do not maintain another handwritten schema. At route registration, Fastify converts Registry Zod 4 input/output into draft-7 JSON Schema and projects it into path, query, body, and required-header OpenAPI operations.

Every Data operation has the `data-foundation` tag, a stable `operationId`, `bearerAuth`, its successful response Schema, plus `Idempotency-Key` for commands and `If-Match` for versioned commands. Fastify schema compilers serve the OpenAPI projection here; the single runtime behavior gate remains strict Zod input/output validation in the shared `DataCapabilityHandler`. Generated documentation never becomes a second behavior source.

Governed OGC/STAC/vector/raster proxies are not Capability Registry entries, so they use explicit route-specific Fastify OpenAPI Schemas. Identity headers, path/query allowlists, binary/content types, and stable 401/403/404/413/422/502/503 errors appear in the same document. POST/PUT/PATCH/DELETE 405 guards remain hidden rather than pretending to be business operations.

## Identity and context headers

Every non-discovery request carries:

```http
Authorization: Bearer <supabase-jwt-or-wdc1-delegated-credential>
X-Wiser-Tenant-Id: <tenant-uuid>
X-Wiser-Project-Id: <project-uuid>
X-Wiser-Purpose: <bounded-purpose>
Accept: application/json
```

The JWT or delegated credential only proves the entry identity. API re-resolves membership, role, scope, L0–L3 ceiling, and authorization version from the Supabase control plane on every request, then sets that exact context in a short data-postgres RLS transaction. Tenant/Project headers never widen permission by themselves.

Every command additionally requires:

```http
Idempotency-Key: <uuid>
```

These versioned commands also require a strong ETag:

```http
If-Match: "v3"
```

This applies to upload Session completion, ingestion submit/resume/approve/reject, and Operation cancel. The header must equal an `expectedVersion` already present in the body. Successful responses include `ETag: "vN"` when an aggregate version is present. Identity, business, and error responses are all `private, no-store`.

`data.ingestion.resume` accepts the existing ingestion ID and the current **Operation** version in `expectedVersion` and `If-Match`. It applies only to an expired, never-claimed PENDING ingestion Job whose original Operation is still RUNNING. A successful response keeps the same Operation ID, advances its version, and records a RESUMED event, audit, and Outbox entry. Use a fresh UUID command key; replay only the identical request.

## The 43 Capability routes

| Capability                        | Method and path                                           | Success |
| --------------------------------- | --------------------------------------------------------- | ------- |
| `data.external.metadata.read`     | `POST /external-sources/:sourceId/metadata/query`         | `200`   |
| `data.catalog.search`             | `GET /catalog/data-items`                                 | `200`   |
| `data.catalog.get`                | `GET /catalog/data-items/:dataItemId`                     | `200`   |
| `data.query`                      | `POST /query`                                             | `200`   |
| `data.search.federated`           | `POST /search`                                            | `200`   |
| `data.knowledge.search`           | `POST /knowledge/search`                                  | `200`   |
| `data.graph.expand`               | `POST /graph/expand`                                      | `200`   |
| `data.graph.findPath`             | `POST /graph/find-path`                                   | `200`   |
| `data.geo.query`                  | `POST /geo/query`                                         | `200`   |
| `data.geo.intersect`              | `POST /geo/intersect`                                     | `200`   |
| `data.ingestion.create`           | `POST /ingestions`                                        | `202`   |
| `data.ingestion.submit`           | `POST /ingestions/:ingestionId/submit`                    | `202`   |
| `data.ingestion.resume`           | `POST /ingestions/:ingestionId/resume`                    | `202`   |
| `data.operation.get`              | `GET /operations/:operationId`                            | `200`   |
| `data.catalog.create`             | `POST /catalog/data-items`                                | `201`   |
| `data.catalog.versions.list`      | `GET /catalog/data-items/:dataItemId/versions`            | `200`   |
| `data.catalog.versions.get`       | `GET /catalog/data-items/:dataItemId/versions/:versionId` | `200`   |
| `data.uploadSession.create`       | `POST /upload-sessions`                                   | `201`   |
| `data.uploadSession.complete`     | `POST /upload-sessions/:uploadSessionId/complete`         | `200`   |
| `data.ingestion.get`              | `GET /ingestions/:ingestionId`                            | `200`   |
| `data.ingestion.approve`          | `POST /ingestions/:ingestionId/approve`                   | `202`   |
| `data.ingestion.reject`           | `POST /ingestions/:ingestionId/reject`                    | `200`   |
| `data.operation.cancel`           | `POST /operations/:operationId/cancel`                    | `200`   |
| `data.operation.events`           | `GET /operations/:operationId/events`                     | `200`   |
| `data.explore.view.create`        | `POST /explore/views`                                     | `200`   |
| `data.explore.view.list`          | `GET /explore/views`                                      | `200`   |
| `data.explore.view.open`          | `POST /explore/views/:viewId/open`                        | `200`   |
| `data.explore.view.revoke`        | `POST /explore/views/:viewId/revoke`                      | `200`   |
| `data.explore.export`             | `POST /explore/export`                                    | `200`   |
| `data.explore.query`              | `POST /explore/query`                                     | `200`   |
| `data.analysis.create`            | `POST /analyses`                                          | `202`   |
| `data.reconciliation.create`      | `POST /reconciliations`                                   | `201`   |
| `data.reconciliation.get`         | `GET /reconciliations/:batchId`                           | `200`   |
| `data.reconciliation.review`      | `POST /reconciliations/:batchId/review`                   | `200`   |
| `data.reconciliation.list`        | `GET /reconciliations`                                    | `200`   |
| `data.assessment.create`          | `POST /assessments`                                       | `201`   |
| `data.assessment.get`             | `GET /assessments/:assessmentId`                          | `200`   |
| `data.assessment.list`            | `GET /assessments`                                        | `200`   |
| `data.assessment.overview`        | `GET /assessments/overview`                               | `200`   |
| `data.knowledge.relations.import` | `POST /knowledge/relations`                               | `201`   |
| `data.knowledge.relations.get`    | `GET /knowledge/relations/:assertionId`                   | `200`   |
| `data.knowledge.relations.list`   | `GET /knowledge/relations`                                | `200`   |
| `data.knowledge.relations.review` | `POST /knowledge/relations/:assertionId/review`           | `200`   |

The internal `data.operation.cancel` executor now installs the existing managed pending-intake scope and checks current maintenance authority plus the locked session's existing owner, submitter/type/delegator fields before lifecycle writes. A hidden or responsibility-unknown session fails closed rather than falling through to general cancellation. Same-key replay rechecks current authority and responsibility; managed request digests bind actor/type/delegator and purpose. Legacy cancellation and the running-job lease/cancellation function are unchanged. Public managed cancellation remains excluded; isolated executor controls do not establish live Auth, SQL/RLS, function event emissions or transaction-commit acceptance.

Paths in the table are relative to `/api/data/v1`. Obtain exact inputs, outputs, scopes, and timeouts from discovery schema; do not substitute stale client types for the runtime contract.

## Cursors, queries, and bounds

Catalog search 1.1 accepts `includeTotal=true` and returns optional `totalCount`: the full caller-visible filtered count before pagination. Count and page share one short PostgreSQL repeatable-read transaction and identical RLS context and filters. Later pages are fresh requests, not a cross-request snapshot. Omit the flag when no count is needed; version 1.0 discovery schemas remain immutable in the archive.

Lists use `first` and opaque `after`. GET arrays are comma-separated, for example `qualityGrades=A,B`. API rejects colliding path/query/body fields, prototype keys, unbounded numbers, and invalid arrays. Cursors bind to Tenant/Project, scope/filter, and authorization version and cannot cross contexts.

Structured query accepts only allowlisted fields and operators:

- `data.query`: selected fields and `EQ/NE/GT/GTE/LT/LTE/IN/CONTAINS` filters;
- graph: entity IDs, relation types, and bounded depth;
- `data.geo.query`: supported GeoJSON geometry, explicit CRS, `INTERSECTS/WITHIN/CONTAINS/NEAREST`, and an optional singular `versionId`. Without `versionId`, each bounded response selects extents from every DataItem's latest visible committed version; with it, the response selects extents from that exact immutable version. Continue with the returned snapshot/query/scope-bound opaque `nextCursor`; `dataItemIds` intersects either selection, and a hidden or absent exact version returns an empty result set;
- `data.geo.intersect`: Geometry or DataItem targets. DataItem targets select latest/exact visible committed Version first, collect all sibling extents, and never fall back to an older Version. Missing, hidden, extent-free, or disjoint targets return an indistinguishable empty page; continuation uses the same snapshot/query/scope-bound cursor;
- federated search: an allowlist of catalog/fulltext/semantic/graph/geo/stac sources.

`data.query` reads structured evidence records from the selected committed version. A visible source-registration version without analytical records returns `200` with its exact `versionId`, requested columns and `rows: []`. Use catalog, evidence retrieval and governed asset download to inspect its source materials. Empty results do not imply that raw files were lost. JSON equality and containment filters compare complete extracted JSON operands; real PostgreSQL integration covers all eight operators, empty records and security/policy filtering.

Current catalog get/version responses require `tileAvailability: { vector, raster }`. The flags describe a routable governed source, not GIS service health: vector requires a visible version-level extent; raster requires a visible RAW TIFF/GeoTIFF asset with blob/hash/input linkage and an exact content-addressed key.

SearchOrchestrator pushes authorization and publication filters into backends, applies fixed `RRF k=60`, deduplicates by DataItem+Version, and reauthorizes every hit.

Graph expansion includes a visible isolated seed. A valid graph query with no visible match returns an empty `nodes`/`edges` result, not a dependency failure. The adapter merges all bounded path rows by entity/edge identity, rejects conflicting duplicates, and filters both nodes and relationships by tenant, project, security, policy, acceptance and publication. This does not create relationships absent from the projection.

## Governed GIS proxy

GeoServer, STAC API, TiTiler, and Martin publish no host ports. Browsers, Agents, and external clients use only these Fastify GET/HEAD surfaces:

| Surface      | Governed route                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------- |
| OGC          | `/api/data/v1/geo/ogc/{wms,wfs,wcs,wmts}`                                                       |
| STAC         | `/api/data/v1/geo/stac`, `/conformance`, `/search`, `/collections/current[/items[/wiser-…]]`    |
| Vector tiles | `/api/data/v1/geo/tiles/vector/versions/{versionId}/{z}/{x}/{y}.pbf`                            |
| Raster tiles | `/api/data/v1/geo/tiles/raster/versions/{versionId}/WebMercatorQuad/{z}/{x}/{y}.{png,jpg,webp}` |

Every call requires the unified Bearer, Tenant, Project, Purpose, and `data.geo.read`; every other HTTP method returns `405`. OGC accepts only each service's read request/query allowlist. Except for GetCapabilities, callers supply an authorized `versionId`, while API fixes layer/type and Tenant/Project/Version filters. STAC `current` becomes the current Tenant/Project's deterministic collection; a cross-scope collection returns safe `404`.

For resource-managed projects, the raw project-wide STAC proxy returns `403` except for static `/conformance`, and OGC GetCapabilities returns `403` even when `versionId` is supplied. Those upstream service catalogs cannot be narrowed reliably to the caller's licensed versions. Governed per-item STAC reads use `/api/data/v1/stac/collections/:collectionId/items/:itemId`; authorized per-version OGC data requests and vector/raster tiles remain available. A resource-filtered STAC listing or capabilities document requires a separate, explicitly governed contract.

Vector tiles first verify an RLS-visible Version with a spatial extent, then call Martin's version-scoped `service.wiser_spatial_extent_mvt` source with server-injected Tenant, Project, Version, security ceiling, and policy version. Raster tiles select only a visible TIFF/GeoTIFF COG from authoritative RAW assets, validate its content-addressed key, and generate a constrained `s3://` source server-side for TiTiler. A client-supplied `url`/source fails with `422` before upstream I/O.

All four upstream origins come from startup-validated internal configuration; userinfo/query/fragment, redirects, and dynamic hosts are forbidden. Query, coordinates, TMS, format, and response content type use strict allowlists. Default timeout is 5 seconds, response cap is 8 MiB, and only safe ETag/Last-Modified pass through. Every contextual ALLOWED/DENIED/FAILED request records `data.geo.read`, target, and route hash. An unauthenticated denial emits only a redacted platform log because no actor audit may be fabricated.

MapLibre never embeds the API Bearer in a tile URL. An authenticated browser requests only same-origin `/api/data-foundation/geo/...`; the Next Route Handler revalidates the Supabase Session and forwards to these Fastify routes with a server-only access token and fixed Tenant/Project/Purpose while bounding path, query, content, and response size again. This Web path is not another GIS business implementation.

After authority checks, an exact TiTiler PNG coverage miss (`404` JSON containing only `detail: Tile(x=…, y=…, z=…) is outside bounds`, with coordinates matching the request) becomes a transparent 256-pixel PNG. Missing assets, authorization failures, malformed or other error responses remain failures. A successful HEAD stays HEAD; only a PNG HEAD coverage candidate is retried once as GET within the same timeout and body limit. Responses remain audited and `no-store`.

## Upload and ingestion

Review policy and submission responsibility are server-owned; upload/create/submit inputs add no bypass flag. With `REQUIRE_INDEPENDENT_REVIEW` enabled, inspect the existing Operation at `WAITING_REVIEW`. Approval requires a verified human with the existing publish authorization who is neither submitter nor delegator. Agent/service approval or unprovable independence returns `INDEPENDENT_REVIEW_REQUIRED` (403); changed policy or checkpoint binding returns a state conflict. Idempotent approval replay rechecks current authority. Professional rejection on a session carrying a frozen or current review policy applies the same independent-human and current-policy checks, including cached replay; unavailable current session access returns `NOT_FOUND`. Rejection without either policy and creator-confirmed reconciliation retain legacy behavior. Operation cancellation remains a separate non-review exit. The command schemas and managed admission remain unchanged.

`data.ingestion.create` 1.1 accepts optional `sourceRegistration`; ingestion get/reject 1.1 preserve that descriptor. Their 1.0 schemas remain in the immutable discovery archive. Obtain the full strict schema from discovery. The descriptor contains source/bundle identity, kind, name, provider, access state, explicit completeness, limitations, and `manifestAssetId` / `manifestSha256`. The manifest asset must be among the completed upload assets supplied to ingestion.

The manifest uses `wiser.source-registration.v1`, a matching `sourceId`, a source `record`, and `files`. Each nonempty file binds an `assetId` to original/prepared size and SHA-256, relative path, artifact class, completeness, disposition and related source IDs. Empty inputs require zero sizes and the empty-content hash. Manifests are limited to 512 KiB and 1,000 file entries. Registration publication preserves raw files and declared source metadata; it does not establish analytical usability. The immutable Version and all retrieval limitations retain this distinction.

Recommended sequence:

1. `POST /upload-sessions` with file name, media type, size, optional SHA-256, and `PRESIGNED_PUT`/`MULTIPART` preference;
2. use only response URLs, headers, opaque upload ids, and contiguous part numbers to upload into quarantine;
3. `POST /upload-sessions/:id/complete` with matching idempotency semantics and `If-Match`, submitting size/hash/ETag;
4. `POST /ingestions` referencing completed asset IDs;
5. `POST /ingestions/:id/submit` to start the durable Worker job;
6. read Operation/SSE; at `WAITING_REVIEW`, a steward with `data.publish` approves or rejects;
7. publication follows five successful completion-target ledgers.

URLs live for 60–900 seconds and callers cannot alter keys. API HEAD-verifies object integrity before completion. Formal raw/version objects are content addressed and never overwritten.

## Operation SSE

`GET /operations/:operationId/events?after=<cursor>&first=<n>` returns a bounded `text/event-stream` snapshot rather than holding an unbounded connection. Every event has stable `id`, `event`, and JSON `data` lines. A response with more data carries `X-Next-Cursor`.

Reconnect with the last confirmed cursor. Never synthesize events from wall time or progress percentages, and do not treat a repeated event as a new transition.

Publication consumer respects terminal Operations. Even after all five completion targets are `SUCCEEDED`, an already `FAILED`/`CANCELLED` Operation is neither rewritten to success nor allowed to publish the version. Consumer records `PUBLICATION_OPERATION_TERMINAL` on its checkpoint and advances past the poison event; a later successful event clears the summary. Original Operation events, Job, and target evidence are never overwritten.

## Evidence and STAC Resource reads

These governed GETs are not part of the 43 business Capabilities. They specifically back MCP Resources while still using unified Auth, data-postgres RLS, post-authorization audit, and no-store:

| Path                                                        | Scope                 | Authority and output boundary                                                                                                                                       |
| ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/data/v1/evidence/fragments/:evidenceId`               | `data.knowledge.read` | `evidenceId` is a UUID; returns only caller-visible Evidence attached to a committed version, with locator/hash, optional excerpt, security/policy/version metadata |
| `/api/data/v1/stac/collections/:collectionId/items/:itemId` | `data.geo.read`       | collection is the current Tenant/Project's deterministic `wiser-<32 hex>` and item is `wiser-<48 hex>`; returns only an authority-reconciled STAC 1.1 Item          |

The Evidence transaction applies `security.authorized_row` to both fragment and DataItemVersion, then appends `data.evidence.read` with a reference hash. Hidden and absent use the same `404`. STAC rejects a cross-Tenant/Project collection before fetch, reads from one fixed bounded internal STAC origin, strips upstream links/unknown fields, and reconciles DataItem, Version, Evidence, source hash, security, policy, quality, acceptance, and `PUBLISHED`. Its source asset href must exactly match the governed download route below; a successful read appends `data.stac-item.read` audit.

Both Resource responses are bounded to 256 KiB, `application/json`, and `private, no-store`. Invalid references return `422`, excessive output `413`, an invalid projection contract `502`, and unavailable dependencies `503`. Database details, internal STAC bearer/origin, upstream URLs, and raw errors never appear.

## Authorized asset download

For a multi-file Version, replace the final `source` segment below with an exact `assetId` returned by the Version. The API binds that asset to the requested visible Version and repeats RLS for both. Tenant/Project path values must match the authenticated header context before any lookup or signing. `source` remains the compatibility alias for the first ordered asset; a hidden or unrelated asset returns `404`.

Published STAC source assets use:

```text
GET /api/data/v1/tenants/{tenantId}/projects/{projectId}/versions/{versionId}/assets/source
```

The complete identity headers and `data.catalog.read` are still required. Path Tenant/Project must equal the authorized context. API selects one RAW asset in an RLS transaction, appends allowed audit, and returns `303` with:

```http
Location: <60-second-presigned-url>
X-Signed-Url-Expires-At: <rfc3339>
```

Absent and undisclosable resources both use safe `404`. Object-store credentials and internal key-resolution failures never enter the response.

## Example

```bash
curl --fail http://127.0.0.1:3101/api/data/v1/health

curl --fail \
  -H "Authorization: Bearer $DATA_API_BEARER_TOKEN" \
  -H "X-Wiser-Tenant-Id: $DATA_TENANT_ID" \
  -H "X-Wiser-Project-Id: $DATA_PROJECT_ID" \
  -H "X-Wiser-Purpose: data-steward-console" \
  'http://127.0.0.1:3101/api/data/v1/catalog/data-items?first=20&qualityGrades=A,B'
```

Writes additionally need `Content-Type: application/json` and a UUID `Idempotency-Key`. Do not persist a real bearer in logs, shell history, Messages, or Artifacts.

## Errors and safe retry

Data REST uses a flat safe envelope:

```json
{
  "code": "CONFLICT",
  "message": "资源状态或版本已发生变化。 / The resource state or version has changed.",
  "traceId": "<32-hex>"
}
```

| HTTP  | Meaning                                                               |
| ----- | --------------------------------------------------------------------- |
| `401` | Missing/invalid bearer or Tenant/Project/Purpose context              |
| `403` | Known identity lacks scope, security ceiling, or resource permission  |
| `404` | Resource absent or its existence cannot be disclosed                  |
| `405` | GIS proxy received a method other than GET/HEAD                       |
| `413` | Governed Resource exceeds the 256 KiB response limit                  |
| `409` | State, version, immutability, or idempotency conflict                 |
| `422` | Strict schema, header, or domain precondition failed                  |
| `502` | Upstream Resource/projection violates its governed contract           |
| `503` | Authority, Worker, or projection dependency unavailable               |
| `500` | Server contract/configuration failure with no internal detail exposed |

After an ambiguous failure, retry only the identical actor, Tenant, Project, Purpose, method, path, body, `Idempotency-Key`, and `If-Match`. The same key/canonical hash returns the original result; a different hash conflicts. Then reconcile with the smallest GET or Operation event query.

## Shared exploration result sets

`POST /api/data/v1/explore/query` calls `data.explore.query` and requires both `data.query.execute` and `data.catalog.read`. Start with `{"spec":{"text":"water"},"view":"resources","first":20}`. Continue with `{"queryId":"<returned UUID>","view":"resources","first":20,"after":"<returned cursor>"}`. Supply exactly one of `spec` or `queryId`; continuation requires the latter. The response carries `queryId`, `spec`, creation/expiry times, authorized `totalCount`, versioned `resources`, readiness and optional `nextCursor`.

The `resources` response also includes optional `summary.coverage`. For the reauthorized, pinned resource set, `temporal` and `geometry` each report `recordedVersionCount` and `unknownVersionCount`; the two counts partition `summary.resourceCount` independently of the page size. A version is recorded when at least one extent row is visible under Data RLS, and multiple rows for that version count once. Unknown includes missing or non-visible extents, so these counts do not certify sampling time, geometry accuracy, CRS, or administrative/river identity. `approvedAssertionCount` and `effectiveActions` remain `null` rather than invented totals. A revoked or expired query cannot reuse its old summary.

Manifests expire after 30 minutes. Foreign owners, changed Purpose/security/policy and expired IDs return `404`; changed authority membership returns `409`; malformed criteria/cursors and more than 10,000 matching versions return `422`. At most 32 recent manifests are retained per matching owner/context; creating another can evict an older query. Re-run the original specification when a result set expires. Projection readiness may advance independently. No raw SQL, Cypher, tenant or actor override is accepted.

`data.analysis.create` accepts an existing published `dataItemId` / `versionId` and an idempotency key. It creates an audited operation and a durable analysis job atomically; source registration and its quality declaration remain unchanged. REST: `POST /api/data/v1/analyses`; GraphQL: `createDataAnalysis(input: JSON!)`; MCP: `data_analysis_create`. Required scopes are `data.ingestion.write` and `data.catalog.read`. Poll the returned operation for completion.

Exploration 1.1 pins the completed analysis batch together with each published version. `view: "records"` requires `queryId` and `versionId` and returns per-asset columns, stable record/feature IDs and a bounded page. `view: "map"` reuses the same result set with an optional WGS84 `[west,south,east,north]` bounding box. Cursors are bound to their view and filters. Re-run the specification to include an analysis completed after the original query. Counts describe indexed records, while resource readiness and coverage disclose unparsed sources.

Exploration 1.2 adds `view: "graph"` on the same authorized manifest. Optional `versionId` narrows the resource graph; `recordId` additionally requires that version and a record in its pinned analysis. Typed resource/version/asset/evidence nodes express authoritative containment, with a focused record sharing its table/map identity. Asset nodes retain source hashes. This provenance view does not infer scientific relationships. Pages include at most 100 versions, 200 assets and 100 evidence fragments; `truncated` discloses omitted nodes and `nextCursor` pages remaining versions. Graph cursors cannot be reused across focus changes. Earlier 1.0 and 1.1 schema definitions remain archived.

Exploration 1.3 adds exact provider names, registration kinds, and content/spatial readiness filters to `QuerySpec`. The result summary counts the entire authorized pinned set, separately from the current resource page. Completed analysis with no content assets is `METADATA_ONLY`; parsed empty content is `EMPTY`; parsed content without verified geometry is `NO_SPATIAL_DATA`, while unknown or untransformable source coordinates are `CRS_UNVERIFIED`. Invalid, restricted and unsupported unparsed content retains unknown counts. Physical format companions do not establish analytical availability. Indexed content records include source representations and document/archive records, not deduplicated scientific observations. The 1.0–1.2 schemas remain immutable in the contract archive.

Exploration 1.4 permits `recordId` in `view: "records"`, together with `queryId` and `versionId`, to retrieve one exact record from the pinned analysis. The API resolves its source asset; an explicitly different asset or a record outside the query returns not found. Exact-record lookups cannot use continuation cursors. Existing resource, record-page, map and graph semantics remain version-scoped, and the 1.3 schemas remain archived.

The query-result vector endpoint `GET/HEAD /api/data/v1/geo/tiles/vector/queries/{queryId}/{z}/{x}/{y}.pbf` additionally requires `data.query.execute` and `data.catalog.read`. Each request reauthorizes the owner-bound manifest and all pinned versions/analyses under RLS before calling Martin. Caller query parameters are forbidden; all seven scope values come from the verified context and path. Responses use the `exploration` source layer and `Cache-Control: no-store`; expired, revoked or foreign result sets cannot reach the upstream. Existing version-based tiles retain their route and layer.

Exploration 1.5 adds optional map-wide `spatial.bounds` (WGS84 or null for an empty result) and `mercatorFeatureCount`, computed over the same authorized record set independently of pagination. The browser requests one initial record and this summary, fits the full result bounds, and loads same-origin query MVT by viewport. Clicking an individual feature performs a 1.4 exact-record lookup; a cluster click zooms in. The map distinguishes viewport feature/cluster counts from map-ready record totals. Tile-boundary ownership is corrected by append-only migration `0015_exploration_tile_boundaries.sql`, so points at tile seams contribute once. The 1.4 contract remains archived.

An authorized Martin `204 No Content` response is normalized to an empty `200` MVT response so empty viewports remain usable. This applies only after authorization and only to Martin; other missing content types still fail validation.

Exploration 1.6 adds optional `spec.recordQuery` bound to exactly one explicit immutable `versions` entry and a source `assetId`. Up to eight typed text/number/presence predicates, one ascending/descending field sort and up to 32 unique selected columns are checked against the pinned analysis asset schema before creating the query. Numeric conversion accepts finite decimal/scientific values without rewriting source identifiers or original JSON. Null/missing values require explicit presence predicates. Record pages, map summaries, query MVT and focused graph records use the same predicates; exact lookup cannot bypass them. Sorting uses source record index as a stable tie-breaker. Column projection affects returned record values; catalog readiness totals still describe indexed source content. No cross-asset unit conversion or scientific aggregation is implied. Migration `0016_exploration_record_queries.sql` supplies shared predicates and updates the tile function; 1.5 remains immutable in discovery.

Migration `0017_exploration_predicate_compilation.sql` preserves typed comparison semantics while exposing the maximum-eight-predicate expression tree to PostgreSQL planning. Numeric conversion uses guarded exact SQL/JSON numeric parsing. Record queries evaluate each distinct typed field once in a bounded source-asset scan, materialize only identities and comparison values, count and select the ordered page from that relation, and fetch original content only for page identities. Null placement and source-index tie-breaking remain stable. Integration compares 187 legacy/new scalar-predicate combinations before exercising RLS, pages and filtered MVT.

Exploration 1.7 adds `view: "aggregate"` with an existing `queryId`, `versionId` and `aggregate` source specification. Text groups or positive-width numeric bins combine with count/sum/mean/min/max. Every grouping, value and optional unit field is checked against the pinned source schema; units are partitioned without conversion. The existing record predicates and authorization apply before grouping. Counts reconcile valid, missing and invalid measure values; count includes every matching record. Decimal results remain strings, numeric bins carry an exact upper bound, and the response contains at most 200 groups with full group/record counts and explicit truncation. Null group/unit labels include missing, non-scalar or over-4096-character labels; invalid numeric group values also enter the null bucket. Unknown units remain unspecified. The Web statistics tab supplies the fields form, a chart and exact-value table; selecting a representable group creates shared record conditions. Numeric charts approximate finite decimal values while the table retains exact source arithmetic. The 1.6 discovery schemas remain immutable.

Record pages treat `first` as a maximum and also enforce a conservative 3 MiB response budget. PostgreSQL measures the ordered candidate prefix before returning original content; selected columns are projected before measuring. The cursor advances by the records actually returned, so byte-limited pages neither skip nor duplicate records. Metadata/specification overhead is reserved, and a single record that cannot fit fails explicitly instead of truncating its fields. Record views return geometry presence for identity; complete map geometry remains in the map representation.

Exploration 1.8 adds typed time predicates and sorting, and hour/day/month/year aggregation. Source formats are `iso-offset`, `dmy-local` or `ymd-local`; `utcOffsetMinutes` is an explicit fixed offset from −840 to 840, not an inferred time zone or daylight-saving rule. ISO source values retain their own offset. Naive source times require the configured offset, which also defines calendar buckets. Invalid dates become ungroupable rather than normalized. Boundaries are UTC strings with up to six fractional digits, and ranges use inclusive `gte` plus exclusive `lt`. Source strings remain unchanged. The browser supports calendar lines, complete-bucket brushing and equivalent keyboard range controls; unit series remain separate. All views and MVT use the same conditions. The 1.7 discovery schemas remain immutable.

Exploration 1.9 accepts `baseQueryId` alongside a new `spec`. It reauthorizes the entire owner-scoped base before creating a fresh query, limits matching to its pinned version members and preserves each completed analysis ID (including an unparsed null). Explicit versions cannot expand beyond the base. Expired, inaccessible or revoked bases fail rather than silently refreshing to newer analyses. Web record controls and chart selections use this refinement path; ordinary new searches continue to resolve current authorized versions. The 1.8 discovery schema remains immutable.

Exploration 1.10 adds immutable `spec.spatialBounds` in WGS84 west/south/east/north order. It uses verified geometry intersections across records, aggregates, graph record lookups and query MVT before clustering. Resource and provenance overviews contain matching versions; source-readiness metrics retain their documented indexed-content meaning. The manifest keeps the underlying authorized pins so clearing or changing the area via `baseQueryId` does not refresh analyses or lose the original population. Every pinned member is reauthorized even when outside the current area. The map offers point/line/polygon visibility, a legend, local-font cluster counts and viewport filtering; layer visibility is presentation only and never changes query authorization or counts. Unverified coordinates are excluded explicitly. The 1.9 discovery schemas remain immutable.

Exploration 1.11 adds `graph.detail` (`assets`, `evidence`, `records`) for version-bound neighbor pages; record expansion also requires a source asset. `graph.grain` identifies the unit of `totalCount`. Continuation binds focus, detail and relation filters; records retain shared predicates, pinned analyses and the byte budget. `graph.relations` selects containment/provenance edge types. Optional `graph.path` finds a directed shortest path of at most eight edges within this returned page only, after relation filtering; missing endpoints fail without disclosing outside nodes. No path means no path in this page, not in the complete knowledge base. The 1.10 schemas remain immutable.

Saved exploration views use `data.explore.view.create`, `.list`, `.open` and `.revoke`; `data.explore.export` exports one bounded query representation. They require `data.query.execute` and `data.catalog.read`. Create/revoke are synchronous commands with UUID `Idempotency-Key`, atomic audit and command ledger. A saved view keeps the original QuerySpec, version/analysis pins and typed ViewSpec (view requests, page history, selection IDs, map camera/layers), not copied record content. At most 100 active views are kept per owner and project. Private is the default; explicit project sharing still requires authenticated project scope, purpose/security checks and authorization of every pinned member when opening. Listing returns only the caller's saved configurations. Opening reissues an owner-bound 30-minute query and continuation bindings without resolving newer versions or analyses; expiry of the original query does not expire the saved configuration. Revocation is one-way and owner-only. Export reauthorizes the request and returns original values, provenance and explicit returned/total counts with a coverage unit; a later page or truncated representation is never marked complete. No transport drains all pages into SSR/BFF memory.

Saved-view create 1.1 and open 1.2 add optional typed `presentation`: graph view/form/style, bounded cameras and layout, reading mode/page, calendar step unit, and display-only focus references. The existing JSON view payload stores these controls; no new table, source membership, observation or permission is introduced. Focus can highlight only objects returned by the authorized query. Create 1.0 and open 1.0/1.1 discovery schemas stay archived unchanged; saved rows without presentation remain valid. An opened saved link restores the controls once, respects explicit URL overrides, and preserves deliberate resets to defaults on reload. Arbitrary URLs, scripts and unknown fields are rejected.

| Capability                 | HTTP path (under `/api/data/v1`)     |
| -------------------------- | ------------------------------------ |
| `data.explore.view.create` | `POST /explore/views`                |
| `data.explore.view.list`   | `GET /explore/views`                 |
| `data.explore.view.open`   | `POST /explore/views/:viewId/open`   |
| `data.explore.view.revoke` | `POST /explore/views/:viewId/revoke` |
| `data.explore.export`      | `POST /explore/export`               |

Exact source bytes are available through `GET/HEAD /api/data/v1/tenants/{tenantId}/projects/{projectId}/versions/{versionId}/assets/{assetId}/content`. The API repeats the existing asset/version authorization and audit, signs only the internal storage endpoint, and streams with a two-minute deadline and single-range support. Internal object URLs sign GET, so an external HEAD uses a one-byte GET probe and returns the original length and type without a body; an empty object uses a second zero-byte GET. The signed URL is never exposed. The session-verified Web endpoint `/api/data-foundation/assets/{versionId}/{assetId}` provides an explicitly named attachment or an allowlisted inert preview; it strips upstream cookies and uses no-store, nosniff and a sandbox content policy. File downloads are independent of bounded query-page exports. Resource pages open parsed content before governance metadata, preserve exact version/file identities, and offer paged tables, source documents, structured values and linked map/graph views. Nested structures mount lazily in bounded groups and source labels remain available alongside display labels.

AMap vector display routes add `/geo/tiles/vector/amap/queries/{queryId}/{z}/{x}/{y}.pbf` and `/geo/tiles/vector/amap/versions/{versionId}/{z}/{x}/{y}.pbf` under `/api/data/v1`. They use the same scopes, immutable query membership, record/spatial predicates, expiry and per-request authorization as the original vector routes. Their tile coordinates are already shifted for the AMap display plane; clients must not shift them again. Original record coordinates, analytical bounds and downloads remain in the declared source/authority CRS.

## Observation reconciliation

`POST /reconciliations`, `GET /reconciliations?versionId=...`, `GET /reconciliations/{batchId}`, `POST /reconciliations/{batchId}/review` project `data.reconciliation.create/list/get/review`. See [copy verification and business deduplication](/en/architecture/data-foundation/#copy-verification-and-business-observation-deduplication) for source pins, normalization, immutable evidence and limits. Reads require `data.query` and `data.catalog.read`; creation additionally requires `data.ingestion.write`, review requires `data.publish` and the creating human identity. Review requires `expectedVersion`; REST also requires matching `If-Match: "v1"`. MCP forwards its expected version as that header. Both commands require a stable UUID idempotency key across identical retries.

`get` takes `batchId`, `first` (default 25, maximum 100), optional `after`, and optional `groupIndex`. Without a group index it pages group summaries; with it, it pages that group's source members. Continue with the returned `nextCursor` without changing the batch/version/group. `list` takes `versionId` and returns at most 100 recent owned batches. Creation freezes `left`, `right` and `plan`; review accepts `decision: "verify" | "reject"` and `note`. Conflicts or incomplete records block verification. Candidate results have null `independentObservationCount`; only a human-verified batch has a count within the declared rules. Agents may propose batches and read deterministic evidence but cannot issue the final review as an Agent identity.

## Intake assessment

`POST /api/data/v1/assessments` (`data.assessment.create`) requires `data.catalog.read`, `data.ingestion.write` and a UUID `Idempotency-Key`. Supply `dataItemId`, immutable `versionId`, `assetId` and the strict `declaration` including expected file hash, material type, target object, access/acquisition/coverage, evidence and optional typed metadata. The selected original must already be a visible committed RAW asset. The response is `{ assessment }`, including server-read hash, parser version, analysis identity, check time, declarations and deterministic rule findings. A stale self-check never replaces the server computation.

`GET /api/data/v1/assessments/:assessmentId` and `GET /api/data/v1/assessments?dataItemId=…&versionId=…&first=25` require `data.catalog.read`; continue using `after=nextCursor`, up to 100 per page. Both reads and identical command retries reauthorize the exact source; withdrawal makes it unavailable. Reports do not grant access, approve publication or certify position. `REMOTE_QUERY_REPORTED` deliberately remains unverified; declared complete coverage is not an independently measured whole-dataset count.

`GET /api/data/v1/assessments/overview` (`data.assessment.overview`, `data.catalog.read`) requires the target object and optionally accepts `query`, `action`, `first` (1–100) and an opaque `after` resource cursor. `totalCount`, `checkedCount`, `uncheckedCount`, and next-action counts share the whole authorized filtered resource denominator; `selectedCount` describes the selected action, independently of the bounded page. Each item pins a resource/version and its latest applicable report time. No check means `UNCHECKED`, not inaccessible.

`data.knowledge.relations.import/get/list/review` is the governed business-relation workflow. Import is bounded to 100 candidates, 100,000 bytes per candidate and 256 KiB per command, pins an authorized published DataItem/Version and all saved source hashes, and accepts up to 64 evidence locations per triple. `mappingVersion` scopes stable source-local identities; changed attributes under the same mapping are conflicts, while corrections use another mapping and an explicit `supersedesId`. `list` defaults to `APPROVED`, supports source-scoped `entityKey`/`mappingVersion`, reports the count for that status and uses at most 100 rows with a version-bound UUID cursor. Every source is reauthorized on reads and command retries. Import requires catalog read plus ingestion write; review requires catalog read plus publish and a human principal, an expected assertion version and rationale. Review remains independent of asset acceptance. The legacy source-provenance graph stays separate.

### Typed knowledge candidates (relations 1.1)

Relations 1.1 adds persons, organizations, documents, claims, events, observations, policies, model runs and places through the existing source-bound workflow. Registered predicates constrain endpoint kinds; each extended relation requires explicit record nature, time role, location role and applicability. Plans, historical reports and simulations cannot be declared sampling observations. Source hashes, immutable versions, pending review and permissions remain unchanged. The 1.0 discovery schemas are retained. This extension now also supports explicit cross-source identity correspondence as described below.

Explicit IDENTITY_MATCH candidates reference existing source entities, preserving versioned identities rather than merging equal labels. Import checks names, kinds and external IDs, refusing reference chains. Lists accept at most sixty-four selected sources and source-scoped entity focus. Every source and referenced endpoint is reauthorized on each read; withdrawal hides related edges and counts. Rebuildable projections retain original endpoint identities. Pending correspondence is not approved knowledge.

For relation lists, URL-encode JSON in `relatedSources` (up to sixty-three additional `{dataItemId, versionId}` objects) and `entityReference` (`{dataItemId, versionId, mappingVersion, entityKey}`). Other query fields remain scalar. Invalid JSON, oversized input and malformed identities are rejected before execution.

List capability 1.3 supports a primary source plus at most 63 related versions (64 total), using the existing request and response fields. The 1.1 twelve-source and 1.2 thirty-two-source discovery schemas remain archived unchanged. Every selected source is authorized before counting or reading; no partial result is returned when any source is denied. Pagination remains at most 100 relations per response. This bounded expansion does not change authority data, review state or projection identities.

List capability 1.4 additionally accepts `queryId` instead of inline source IDs. Create the immutable source manifest through the existing exploration POST capability; GET relation pages then use its short ID. Owner, tenant/project, purpose, policy, security level, expiry and every source are rechecked. Missing or denied members fail the request, never a partial success. An empty authorized manifest returns zero. Inline scope retains the 64-source bound; discovery versions 1.0–1.3 remain unchanged. A query ID expires; use existing saved views to reopen pinned versions. Business conditions are available through exploration 1.12 as described below.

Exploration 1.12 adds optional `businessQuery` to an explicit version manifest. It fixes review status, current/history mode, source-time filters and compact assertion/version pins (at most 2,000). Every read rechecks source authorization and authority versions; a changed or unavailable pin fails the whole scope. Relation pages, bound records, record aggregates and map features use this same scope. Explicit `urn:wiser:record:` identities bind only to records in the pinned analysis with a matching evidence asset. Every date-filtered HTML table row requires original-column selections backed by the selected assertion’s pinned table/row/column evidence, even when only one declared period is currently visible. Caller-supplied month columns and unrestricted whole-row text are rejected; the result omits other periods without altering the original asset or claiming daily observations. Resource inventory/readiness counts still describe source assets, not scoped observations. Saved-view open/export 1.1 retain the new scope, while their 1.0 and exploration 1.11 discovery schemas stay frozen. Saved links are purpose-scoped: create a user-facing view with the authorized web-console purpose, not an unrelated batch-test purpose. Geometry-free records remain unlocated; no location or scientific approval is inferred.

### Pinned cross-source evidence

Cross-source relation evidence optionally pins `source.dataItemId`, `versionId`, `analysisId`, and `recordId`, alongside the original asset hash. The locator is `record:<recordId>`; a non-null excerpt must occur in that parsed record. Import/get/review 1.2 and list 1.5 keep prior schemas archived. Every read and retry reauthorizes the owner and all evidence sources; withdrawn, inaccessible, or mismatched evidence cannot contribute to a relation or its evidence/search readback. Dates remain source-supported candidates, not professional approval.

Assessment list capability 1.1 adds optional `assetId` and `latestPerAsset` (REST `true` / `false`). With `latestPerAsset=true`, choose the newest visible report per original by `created_at DESC, assessment_id DESC` before applying the existing assessment-ID pagination. A newer incomplete or source-mismatched declaration is returned instead of silently falling back to an older complete one. Omitted options preserve full history; the immutable 1.0 input schema remains in the archive. No migration or public output changes are needed.

Raster display queries accept `bidx` (1–256), a finite strictly increasing decimal `rescale=min,max`, optional finite decimal `nodata`, allowlisted resampling, `colormap_name` and `return_mask`. The `nodata` override is forwarded through both allowlists to TiTiler without changing source metadata. Unit labels are browser-only declarations, never a query parameter or a unit conversion. Source selection and authorization are unchanged.

### Project business scope (exploration 1.13)

`scope: "project"` with `businessQuery` requests a server-resolved authorized source manifest; callers cannot supply version or assertion pins in this mode. Source versions, analysis versions and assertion UUID/revisions are fixed in the existing owner-scoped snapshot. Responses expose `membership` counts and a short `queryId`, not the assertion list. Counts describe fixed membership before display filters, not independent observations or the current page. Resource pages and relation pages remain bounded. Exceeding server limits fails without truncation; the storage ceiling is not a rendering performance claim.

Saved-view open 1.3 and export 1.2 retain this scope. Refining through `baseQueryId` retains existing members and rechecks every original source/assertion before narrowing; it does not absorb later additions. Changing review status requires a fresh query. Missing, withdrawn or changed pins fail the request rather than returning a partial panorama. Exploration 1.12, saved-view open 1.2 and export 1.1 schemas remain immutable archives; explicit-version queries keep their existing limits. Hidden data and undiscoverable metadata are not included. A separately authorized source catalogue is required for discoverable restricted sources. No new GraphQL, REST or MCP route or authority model is introduced.

### Mixed review query scope (exploration 1.14)

`businessQuery.schemaVersion: 2` with `status: "APPROVED_AND_PENDING"` selects authorized approved and pending assertions together. This is a query selector, never an authority state or review decision. Each returned assertion retains its real status and revision; rejected/correction-required assertions are excluded. Current-revision selection never lets a pending correction hide an approved assertion. Version 1 keeps its existing single-state behavior.

Relation list 1.6 accepts the selector only with a persisted business `queryId` whose status matches. Inline sources and ordinary non-business queries cannot use it. Existing source authorization, immutable membership, pagination, record evidence and withdrawal checks still apply; any changed assertion revision invalidates replay even when its status remains inside the selected set. Saved-open 1.4 and export 1.3 preserve this scope. Prior query 1.13, saved-open 1.3, export 1.2 and relation-list 1.5 discovery schemas are frozen, including their schema hashes. No authority model or database migration is introduced.

## Read external metadata without ingesting observations

`data.external.metadata.read` 1.0 uses `POST /api/data/v1/external-sources/:sourceId/metadata/query`. Body: `{ "fromYear": 2021, "toYear": 2025, "offset": 0, "limit": 50 }`; limit is 1–100. Source ID comes only from the path; no URL, token, grant or requested fields are accepted. Platform `data.catalog.read` is necessary but never sufficient: the injected trusted reader checks live source-specific permission before and after each page.

Success returns station code, year and only permitted administrative labels, with `checkedAt`, `timePrecision: "year"`, total and optional next offset. It creates no catalog asset, observation or index. Responses, including errors, are private/no-store. Stable errors distinguish `EXTERNAL_SOURCE_UNCONFIGURED` and `EXTERNAL_SOURCE_UNAVAILABLE` (503), `EXTERNAL_SOURCE_TIMEOUT` (504), `EXTERNAL_SOURCE_ACCESS_DENIED` and `EXTERNAL_AUTHORIZATION_EXPIRED` (403), and `EXTERNAL_METADATA_INVALID` (502). Missing source permission uses the existing forbidden response. Cancellation records `REQUEST_CANCELLED`; a disconnected transport generally receives no response. Source rejection/expired permission are denied audits; network/malformed/cancelled work is failed, never successful empty data.

The default runtime is disabled. A real source needs a trusted adapter and live WISER plus provider permission; shared credentials alone are not a grant. Synthetic HTTP integration tests do not certify any real provider protocol or license.

## Bounded project relation pages

Relation list 1.7 adds opt-in `pageMode: "BOUNDED_PROJECT"` with `first` up to 500, only for an existing project business `queryId`. The server rechecks snapshot ownership, expiry, current source/evidence authorization and immutable assertion revisions before each page. A complete relation is never truncated. The serialized UTF-8 JSON result (items, total and cursor) is bounded to 1 MiB; oversized single relations fail validation rather than returning an empty continuation. Transport envelopes are outside this result budget.

Requests without this mode retain the 100-item limit and existing behavior. The exact 1.6 discovery schemas remain archived; older capability versions are unchanged. Clients must discover 1.7 support before opting in and otherwise use the legacy path. A fixed project membership is not an authorization cache. This reduces repeated requests without changing the cost or scope of full reauthorization, and makes no performance claim until measured.

## Resource scope adapter boundary

Trusted SQL adapters preserve existing public inputs and legacy transactions while accepting an internal compiled authority scope. Resource restrictions apply before result counts and pagination. Catalog continuation binds the resource fingerprint; changed-scope continuation is INVALID_DATA_CURSOR. Existing fixed exploration manifests still fail with CONFLICT when any pinned member becomes inaccessible, including export without the required intersection. An internal export action cannot be supplied through JSON. The platform runtime now supplies fresh resource authority. End-to-end resource administration acceptance remains pending.

Managed federated/semantic search sends at most 1000 trusted content-version pins to each backend; discovery-only scope returns no content hits. Search cursors include the resource fingerprint. Exact item/version/evidence references are checked against Data PostgreSQL RLS, publication and cross-source evidence visibility before releasing a page; missing authority adapters fail closed.

Managed graph expansion/path queries constrain every node and relationship to the content-version pins, omit the full authority snapshot from Neo4j parameters, and revalidate node/evidence references against Data PostgreSQL before returning the graph. Readable endpoints never substitute for readable relationship evidence. Empty content scope avoids querying the projection.

REST, GraphQL, evidence, STAC and map response delivery resolves authority again after work completes; asset content also rechecks after fetching and before sending bytes. Changes to principal, project, purpose, actions, membership revision or resource scope suppress the response, including a legacy-to-managed transition. A command already committed is not rolled back by response denial; use its existing idempotency/audit workflow for reconciliation. Managed asset routes always proxy bytes and never return a signed storage URL. Each proxied chunk rechecks current authority after its upstream read; changed or unavailable authority cancels the remaining stream. Already delivered bytes cannot be recalled. Legacy redirect URLs retain their existing short TTL; they cannot be revoked individually by these checks.

Managed projects admit the explicit resource-aware capability set and the owned pending-intake create/submit/upload/get workflow described below. Guarded standard-intake Operation status/events are described below; approval/rejection, reconciliation and other maintenance commands still fail with FORBIDDEN before unscoped executors run. External directory calls require an exact, unexpired external.directory source reference in addition to provider authorization. Legacy projects retain their existing capability gates.

## Frozen candidate contracts

Candidate contract types are separate from published-version inputs. The operations below retain this separate identity. Their strict references, parser outcomes and bounded record pages are documented in [Data Foundation architecture](/en/architecture/data-foundation/#frozen-candidate-contracts); live authorization and transport acceptance remain separate from schema checks.

### Pending ingestion candidates (1.0)

`GET /api/data/v1/ingestions/:ingestionId/candidates/:processingBatchId` and `/:assetId/records` / `/:assetId/geometry` map to `data.ingestion.candidate.get/records/geometry`. Input fixes `kind: ingestion-candidate`, `ingestionId`, `processingBatchId`, lowercase SHA-256 `reviewHash`, optional `first` (default 50; max 200) and `after`; records/geometry also require `assetId`. REST identity path fields must not be repeated in the query. `versionId` is rejected. Summary totals cover the whole candidate batch while `assets` is paged; unknown outcomes retain null counts. Rows preserve raw fields and locators; map rows preserve canonical point/line/area geometry and source CRS. Follow only the returned cursor, bound to current authority and the complete fixed selection. The 3 MiB limit may reduce the row count; it never truncates values.

Current maintenance authority for the immutable submitter/delegator or independent human review authority is checked on each continuation, in addition to scope/security/policy. Published-source grants are unchanged. Candidate parsing and reading do not approve or publish a source. Original download and saved-candidate workflows require their own integration; live Auth/database/browser validation remains a separate gate.

### Managed pending intake and candidate discovery

The standard `data.uploadSession.create/complete`, `data.ingestion.create/submit` and `data.ingestion.get` paths now admit managed projects through their own current maintenance/ownership guards. Writes require both `data.ingestion.write` and `data.operation.read`; fresh trusted identity, purpose, expiry and project scope are checked before cached results or object-store work. Upload responsibility is server-generated immutable Operation metadata. A human owner or the responsible human delegator may continue maintenance; a delegated actor must match the original actor type, actor ID and delegator. Unknown legacy responsibility fails closed. Create only binds completed owned QUARANTINED assets; it neither removes resource scope nor grants access to published content. Managed idempotency also binds actor type, delegator, purpose and resource fingerprint; retries recheck current ownership.

`data.ingestion.get` 1.2 adds required nullable `candidateReference`: the actual frozen `kind: ingestion-candidate`, `ingestionId`, `processingBatchId` and `reviewHash`, or null when no readable completed batch exists. It never creates a published `versionId`. Get guards ownership or current independent human review permission before reading any quality/Agent/projection summary, then reads the session and candidate reference in one consistent snapshot. Both strict 1.0 and 1.1 output schemas remain archived; REST, GraphQL, MCP and Skills share the new registry contract. Follow the returned reference into the existing three candidate reads.

`GET /operations/:operationId` and `GET /operations/:operationId/events` admit managed reads for exact standard upload/ingestion tasks through the [immutable responsibility and current-authority guard](/en/architecture/data-foundation/#managed-pending-intake-and-candidate-discovery). Denied tasks expose neither status nor events. Event continuations bind current actor/type/delegator, authorized purpose and resource scope; a fresh currently authorized purpose may issue a new request, but cannot reuse an old cursor. Managed responses retain existing DTOs and safe error-code/retryable fields, suppress free-text diagnostics, and omit event messages. Legacy responses and discovery archives are unchanged. Resume/cancel, approval/rejection and other maintenance capabilities remain excluded; status reads do not approve or publish. Real Auth, SQL/RLS, Worker and browser validation remains a separate gate.

### Pending original content

`GET` / `HEAD /api/data/v1/tenants/:tenantId/projects/:projectId/ingestions/:ingestionId/candidates/:processingBatchId/assets/:assetId/content?reviewHash=<sha256>` uses the same verified bearer, tenant/project and purpose headers. The only query parameter is the frozen lowercase SHA-256 `reviewHash`; aliases such as `versionId`, repeated parameters and `assetId: source` are rejected. Maintenance for the immutable submitter/delegator or independent human review authority is necessary. Catalog-only authority does not grant candidate-original access.

The route proxies the exact original after full hash/size verification, including for HEAD and a single byte range. It never returns a signed URL or storage address. Originals must be from 1 byte through 32 MiB; a changed, truncated, oversized or unavailable object produces a sanitized failure without original bytes. A valid range returns 206; an unsatisfiable single range returns 416; malformed/multiple ranges return validation failure. Content is private/no-store, attachment-only and sandboxed. Current authority and candidate binding are rechecked before delivery and for each output chunk; already delivered bytes cannot be recalled. The audit records authorized access, not successful receipt.

Before fetching storage bytes, each API instance admits at most four active candidate-original requests and 128 MiB of their declared original sizes, with at most two active requests for the same responsible actor in one tenant/project. GET, HEAD and ranges share these limits because each verifies the complete original. When capacity is full, the route returns a sanitized `503` with `Retry-After: 1`; retry the same fixed reference after the indicated delay. Capacity remains reserved while a response is slow or unconsumed and is released after completion or cancellation cleanup. These are per-instance safeguards, not a measured throughput target or a cluster-wide quota. Existing published-original routes retain their behavior. Live service acceptance and candidate saving remain open gates.

### Fixed candidate view endpoints (1.0)

The four discovered `data.ingestion.candidate.view.*` capabilities use `/api/data/v1/ingestion-candidate-views`: POST creates, GET lists, and POST `/:viewId/open` or `/:viewId/revoke` opens or revokes. Open/revoke carry an empty JSON body because the ID is in the path. Create/revoke require a UUID Idempotency-Key; no optimistic version header is required. Existing tenant/project/purpose, bearer, fresh-delivery authorization and no-store rules apply.

Create fixes `title` (1–160 characters), `visibility` (private by default or explicit project), 1–100 unique candidate `references` and strict `viewSpec`. Reject unknown fields, authority injection, published version/query substitution, raw records and stored cursors. `viewSpec.page` selects assets, records or geometry with `first` 1–200, a member reference and, for record/map pages, an exact asset. `afterAssetId` or `afterRecordId` is a server-verified stable anchor. Optional focus must also belong to the manifest; map and period are display state. Create/open UTF-8 envelopes are limited to 128 KiB.

List defaults to 20 and permits `first` 1–100 plus an authority-bound cursor; returns only currently readable metadata and nextCursor, without a global total. Open reauthorizes every fixed member and returns a typed candidate-view envelope with the original three-read request and fresh continuation. Call that reader to obtain content. Private ownership, responsible delegation, current purpose/expiry and explicit project sharing never substitute for candidate permission. Revocation is owner-only, immutable and idempotent; a zero-row write is a failure, not a success receipt. Old saved views remain unchanged. Actual authenticated persistent recovery and controlled export require their own integration evidence.

The Web original route additionally accepts an optional, unique UUID `savedViewId` as navigation context. With that ID it calls the existing standard `candidate.view.open` before fetching the original, after original response headers and before every output block; each call rechecks every current fixed member and verifies the requested complete candidate reference belongs to the returned manifest. No authority result is cached. Original asset permission remains independently checked by the original API; view sharing never grants download access, and direct reads without this context keep their existing behavior. Invalid or duplicate view IDs fail before Auth. All checks share caller cancellation and the existing 120-second original deadline; saved responses remain bounded by the smaller of 128 KiB and the Web configuration. File-size and API concurrency budgets are unchanged. Repeated current checks can exhaust the deadline and safely stop delivery rather than extend it. These separate HTTP calls are not one cross-request transaction, and bytes already delivered cannot be recalled. Synthetic transport and bounded-stream checks do not establish live Auth, SQL, storage or browser acceptance. Each internal standard open retains the existing capability audit; these checks are not counts of user reopens or completed downloads.

### Candidate original service-output outcomes

The API now appends a separate internal `data.ingestion.candidate.original.output` event to the existing append-only `security.audit_event` carrier. The earlier `data.ingestion.candidate.original.read` / `ALLOWED` event still means signing authorization. Each server-generated attempt distinguishes full GET, single-range GET and HEAD, with bounded selected/offered byte counts, duration and safe error codes. HTTP `finish` records complete API output only after the selected bytes are offered; `close` before finish records interruption. Capacity rejection, hash/size mismatch and other output failures have separate terminal outcomes. The first terminal wins, including normal finish followed by close.

Only the trusted download adapter's opaque in-process receipt can append an outcome. It snapshots the signing actor/delegator, tenant/project, candidate reference and asset security policy before asynchronous signing; outcome writes do not reread or grant content. No client JSON input, public Capability, permission enumeration or migration is added. The separate SQL transaction retains the ten-second statement timeout. Each append Promise is observed once, using the existing 120-second original-operation duration as its observation limit; expiry or module shutdown records an unconfirmed observation without waiting indefinitely. A failed append emits one fixed sanitized diagnostic with its server attempt ID. Observation expiry does not cancel SQL, establish rollback or release an active connection; late settlement is handled without a second diagnostic, and uncertain writes are not retried or rewritten. The existing shared pool shutdown is unchanged and is not proven to have a global deadline by this slice. These events count bytes offered to the API response stream, not browser receipt, user disk downloads or later Web-proxy output. The management read view, real Auth/SQL/storage validation and product acceptance remain separate gates.

Error responses do not wait for audit observation. The existing non-stream cleanup releases an original reservation after the awaited original work settles; an unresolved non-cooperative fetch still retains its reservation. Streaming authorization stops output on either current denial or temporary failure, retaining the offered-byte prefix: forbidden or missing access records `AUTHORITY_CHANGED`, while other failures record `UNAVAILABLE`. Audit SQL retains its own connection until actual settlement. Existing stream-close cleanup is unchanged and does not prove every pending authorization query or generator has completed; neither does the observation deadline prove a global pool shutdown deadline.

### Complete candidate topic specification v2 — contract checkpoint

The independent `candidate-topic.ts` contract checkpoint reserves explicit `schemaVersion: 2`; the existing versionless candidate-view v1 contract, registered endpoints and consumers remain unchanged. The strict shape, dependency consistency and legacy dispatch are implemented at this contract checkpoint; validation is pure and does not enable topic persistence. This is not an enabled HTTP API, a migration or persistent recovery acceptance.

The fixed configuration includes the existing page, focus and map bounds; an explicit month/day window with calendar-valid boundaries, `timeRole`, `displayUnit` and `includeUndated`; a question, region/need IDs and exact candidate/asset/record pins; projection, readiness, requirement and impact rule versions; exact asset, record or whole-record geometry dependencies; and relation content revision plus decision version. It contains no raw values, geometry coordinates or client-issued authority. Content and permissions are always obtained afresh by the server.

The manifest remains 1–100 unique candidate references and the whole create envelope remains at most 128 KiB of UTF-8 JSON. Planned bounded fields are: question 2,000 characters; region IDs 32; need IDs 64; record/dependency pins 200 each; rule pins 32; relation pins 100; source-local object keys 256 characters and rule/parser identifiers/versions 128 characters. Rule pins must cover all four adopted rule categories, while relations may be empty. A decision version of zero means no appended candidate decision in this new specification, not approval; a relation revision starts at one. The server must verify actual source hashes, processing versions, record/geometry hashes, relationship source dependencies and decision history before saving.

Version dispatch accepts strict versionless v1 or complete v2 only. An unknown or incomplete version is rejected rather than stripped into v1; v1 period remains display state, and legacy month/year fields are not reinterpreted as day windows. Compatibility list filtering, safe old-open rejection, the existing-table v2 constraint migration and the three separately registered topic capabilities are subsequent integration work. The legacy published-view contract is independent.
