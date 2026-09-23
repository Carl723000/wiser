import { Buffer } from 'node:buffer';

import { Pool } from 'pg';

import { createExternalMetadataExecutor } from './external-metadata-executor.js';
import {
  createTrustedExternalMetadataPorts,
  type TrustedExternalMetadataRegistry,
} from './external-metadata-registry.js';
import { DATA_CAPABILITY_IDS } from '@wiser/data-contracts';
import {
  createDataEmbedding,
  embeddingCollectionName,
  Neo4jSearchBackend,
  OPENSEARCH_EVIDENCE_INDEX,
  OpenSearchSearchBackend,
  PgSTACSearchBackend,
  PostGISSearchBackend,
  SearchOrchestrator,
  WeaviateSearchBackend,
  createS3AuthorityObjectStore,
  createS3AuthorityPresigner,
  createSeaweedFsS3Client,
} from '@wiser/data-infra';

import {
  DataCapabilityHandler,
  type DataCapabilityAuditPort,
  type DataCapabilityExecutor,
} from './capability-handler.js';
import { createDataFoundationGraphqlModule } from './graphql-module.js';
import {
  createDataFoundationGeoProxyModule,
  type DataFoundationGeoAuditPort,
  type DataFoundationGeoAuthorityPort,
  type DataFoundationGeoProxyPort,
} from './geo-proxy-module.js';
import {
  FixedOriginDataFoundationGeoProxyPort,
  PostgresDataFoundationGeoAuthorityPort,
} from './geo-proxy-ports.js';
import { createDataFoundationModule } from './plugin.js';
import {
  createPostgresDataCommandRuntime,
  type DataCommandObjectStore,
} from './postgres-command-executors.js';
import { createPostgresDataReadRuntime } from './postgres-read-executors.js';
import { createDataResourcePackageValidator } from './resource-package-validator.js';
import { createDataManagementCatalogReader } from './management-catalog.js';
import type { ResourceAdministrationOptions } from '@wiser/platform-auth';
import {
  Neo4jGraphQueryPort,
  PostgisGeoQueryPort,
  PostgresStructuredDataQueryPort,
  PostgresProjectionReadAuthority,
  type QueryAdapterHttpClient,
} from './query-adapters.js';
import {
  createDataFoundationRestModule,
  type DataFoundationAssetDownloadPort,
} from './rest-module.js';
import { createDataFoundationResourceModule } from './resource-module.js';
import { PostgresDataFoundationResourcePort } from './postgres-resource-port.js';
import type { DataFoundationResourcePort } from './resource-types.js';
import {
  PostgresDataAssetDownloadPort,
  type AssetDownloadObjectStore,
} from './postgres-asset-download.js';
import {
  loadDataFoundationApiRuntimeConfig,
  type DataFoundationApiRuntimeConfig,
} from './runtime-config.js';
import { createSpecialQueryExecutors } from './special-query-executors.js';
import { PostgresExplorationExecutor } from './exploration-runtime.js';
import { createExplorationSavedExecutors } from './exploration-saved.js';
import { createKnowledgeRelationExecutors } from './knowledge-relations-runtime.js';
import { createAssessmentExecutors } from './assessment-runtime.js';
import { createReconciliationExecutors } from './reconciliation-runtime.js';
import type { PlatformAuthRuntime } from '../platform/auth-runtime.js';
import type { WiserApiModule } from '../platform/modules.js';

export interface DataFoundationSharedPool {
  close(): Promise<void>;
}

export interface DataFoundationObjectStoreResource {
  readonly store: unknown;
  probe(): Promise<boolean>;
  close(): Promise<void>;
}

interface ExecutorRuntime {
  readonly executors: readonly DataCapabilityExecutor[];
}

interface ReadExecutorRuntime extends ExecutorRuntime {
  readonly audit: DataCapabilityAuditPort;
  readonly validateResourcePackage?: ResourceAdministrationOptions['validatePackage'];
  readonly listManagementCatalog?: ResourceAdministrationOptions['listManagementCatalog'];
  readonly listExternalSources?: ResourceAdministrationOptions['listExternalSources'];
}

type ExternalMetadataPorts = ReturnType<
  typeof createTrustedExternalMetadataPorts
>;

export interface DataFoundationRuntimeFactories {
  createPool(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
  ): DataFoundationSharedPool;
  createObjectStore(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
  ): DataFoundationObjectStoreResource;
  createReadRuntime(
    pool: DataFoundationSharedPool,
    external?: ExternalMetadataPorts,
  ): ReadExecutorRuntime;
  createCommandRuntime(
    pool: DataFoundationSharedPool,
    objectStore: unknown,
  ): ExecutorRuntime;
  createSpecialExecutors(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
    pool: DataFoundationSharedPool,
    external?: ExternalMetadataPorts,
  ): readonly DataCapabilityExecutor[];
  createAssetDownloadPort(
    pool: DataFoundationSharedPool,
    objectStore: unknown,
  ): DataFoundationAssetDownloadPort;
  createResourcePort(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
    pool: DataFoundationSharedPool,
  ): DataFoundationResourcePort;
  createGeoAuthorityPort(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
    pool: DataFoundationSharedPool,
  ): DataFoundationGeoAuthorityPort & DataFoundationGeoAuditPort;
  createGeoProxyPort(
    config: Extract<DataFoundationApiRuntimeConfig, { mode: 'enabled' }>,
  ): DataFoundationGeoProxyPort;
  probeDatabase(pool: DataFoundationSharedPool): Promise<boolean>;
  probeWorker(workerUrl: string): Promise<boolean>;
}

export interface DataFoundationRuntime {
  readonly enabled: boolean;
  readonly modules: readonly WiserApiModule[];
  readonly executors: readonly DataCapabilityExecutor[];
}

interface DefaultPool extends DataFoundationSharedPool {
  readonly pg: Pool;
}

function safeFetchProbe(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) })
    .then((response) => response.ok)
    .catch(() => false);
}

const boundedHttpClient: QueryAdapterHttpClient = {
  async request(request) {
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
    } catch {
      throw new Error('Data projection HTTP backend is unavailable.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2_000_000) {
      throw new Error('Data projection HTTP response is too large.');
    }
    let body: unknown;
    try {
      body = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      throw new Error('Data projection HTTP response is invalid.');
    }
    return { status: response.status, body };
  },
};

const defaultFactories: DataFoundationRuntimeFactories = {
  createPool(config) {
    const pg = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    return { pg, close: () => pg.end() };
  },
  createObjectStore(config) {
    const client = createSeaweedFsS3Client(config.objectStore);
    const signingClient = createSeaweedFsS3Client({
      ...config.objectStore,
      endpoint: config.objectStorePublicEndpoint,
    });
    const store = createS3AuthorityObjectStore({
      bucket: config.objectStore.bucket,
      client,
      presign: createS3AuthorityPresigner(signingClient),
      presignInternal: createS3AuthorityPresigner(client),
    });
    return {
      store,
      probe: () => safeFetchProbe(`${config.objectStore.endpoint}/status`),
      close: () => {
        client.destroy();
        signingClient.destroy();
        return Promise.resolve();
      },
    };
  },
  createReadRuntime(pool, external) {
    const pg = (pool as DefaultPool).pg;
    return {
      ...createPostgresDataReadRuntime(pg),
      validateResourcePackage: createDataResourcePackageValidator(pg, external),
      listManagementCatalog: createDataManagementCatalogReader(pg),
      ...(external
        ? {
            listExternalSources: (input) =>
              external.listManagementSources(input),
          }
        : {}),
    };
  },
  createCommandRuntime(pool, objectStore) {
    return createPostgresDataCommandRuntime(
      (pool as DefaultPool).pg,
      objectStore as DataCommandObjectStore,
    );
  },
  createSpecialExecutors(config, pool, external) {
    const pg = (pool as DefaultPool).pg;
    const embedding = createDataEmbedding(config.embedding);
    const search = new SearchOrchestrator({
      openSearch: new OpenSearchSearchBackend({
        endpoint: config.openSearch.url,
        indexName: OPENSEARCH_EVIDENCE_INDEX,
        username: config.openSearch.username,
        password: config.openSearch.password,
      }),
      weaviate: new WeaviateSearchBackend({
        endpoint: config.weaviate.url,
        apiKey: config.weaviate.apiKey,
        collectionName: embeddingCollectionName(embedding.model),
        vectorDimensions: embedding.model.dimensions,
        embed: (text) => embedding.embed(text, { purpose: 'query' }),
      }),
      neo4j: new Neo4jSearchBackend({
        endpoint: config.neo4j.url,
        database: config.neo4j.database,
        username: config.neo4j.username,
        password: config.neo4j.password,
      }),
      postgis: new PostGISSearchBackend({ pool: pg }),
      pgstac: new PgSTACSearchBackend({
        endpoint: config.stac.url,
        bearerToken: config.stac.bearerToken,
      }),
    });
    return [
      ...createSpecialQueryExecutors({
        search,
        projectionAuthority: new PostgresProjectionReadAuthority({ pool: pg }),
        data: new PostgresStructuredDataQueryPort({ pool: pg }),
        graph: new Neo4jGraphQueryPort({
          baseUrl: config.neo4j.url,
          database: config.neo4j.database,
          authorization: `Basic ${Buffer.from(
            `${config.neo4j.username}:${config.neo4j.password}`,
          ).toString('base64')}`,
          http: boundedHttpClient,
        }),
        geo: new PostgisGeoQueryPort({ pool: pg }),
      }),
      new PostgresExplorationExecutor(pg),
      ...createExplorationSavedExecutors(pg),
      ...createReconciliationExecutors(pg),
      ...createAssessmentExecutors(pg),
      ...createKnowledgeRelationExecutors(pg),
      createExternalMetadataExecutor(
        external
          ? (sourceId, context) => external.resolveReader(sourceId, context)
          : undefined,
      ),
    ];
  },
  createAssetDownloadPort(pool, objectStore) {
    return new PostgresDataAssetDownloadPort({
      pool: (pool as DefaultPool).pg,
      objectStore: objectStore as AssetDownloadObjectStore,
      ttlSeconds: 60,
    });
  },
  createResourcePort(config, pool) {
    return new PostgresDataFoundationResourcePort({
      pool: (pool as DefaultPool).pg,
      stac: {
        baseUrl: config.stac.url,
        bearerToken: config.stac.bearerToken,
        publicApiOrigin: config.publicApiOrigin,
      },
    });
  },
  createGeoAuthorityPort(config, pool) {
    return new PostgresDataFoundationGeoAuthorityPort({
      pool: (pool as DefaultPool).pg,
      bucket: config.objectStore.bucket,
    });
  },
  createGeoProxyPort(config) {
    return new FixedOriginDataFoundationGeoProxyPort({
      origins: {
        GEOSERVER: config.geo.geoserverUrl,
        STAC: config.stac.url,
        TITILER: config.geo.titilerUrl,
        MARTIN: config.geo.martinUrl,
      },
      stacBearerToken: config.stac.bearerToken,
    });
  },
  async probeDatabase(pool) {
    try {
      await (pool as DefaultPool).pg.query('select 1');
      return true;
    } catch {
      return false;
    }
  },
  probeWorker(workerUrl) {
    return safeFetchProbe(`${workerUrl}/health/ready`);
  },
};

function exactExecutors(
  groups: readonly (readonly DataCapabilityExecutor[])[],
): readonly DataCapabilityExecutor[] {
  const executors = groups.flat();
  const ids = executors.map(({ id }) => id);
  if (
    executors.length !== DATA_CAPABILITY_IDS.length ||
    new Set(ids).size !== DATA_CAPABILITY_IDS.length ||
    DATA_CAPABILITY_IDS.some((id) => !ids.includes(id))
  ) {
    throw new Error(
      `Data Foundation runtime must compose exactly ${DATA_CAPABILITY_IDS.length} Capability executors.`,
    );
  }
  return Object.freeze([...executors]);
}

export function createDataFoundationRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv,
  platformAuth: PlatformAuthRuntime,
  factories: DataFoundationRuntimeFactories = defaultFactories,
  externalMetadataRegistry?: TrustedExternalMetadataRegistry,
): DataFoundationRuntime {
  const config = loadDataFoundationApiRuntimeConfig(environment);
  if (config.mode === 'off') {
    return Object.freeze({ enabled: false, modules: [], executors: [] });
  }
  if (platformAuth.resolver === null) {
    throw new Error(
      'Data Foundation requires unified Auth and cannot run with Auth off.',
    );
  }

  const pool = factories.createPool(config);
  const objectStore = factories.createObjectStore(config);
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    const results = await Promise.allSettled([
      pool.close(),
      objectStore.close(),
    ]);
    if (results.some(({ status }) => status === 'rejected')) {
      throw new Error('Data Foundation resources could not close cleanly.');
    }
  };

  try {
    const external = externalMetadataRegistry
      ? createTrustedExternalMetadataPorts(externalMetadataRegistry)
      : undefined;
    const read = factories.createReadRuntime(pool, external);
    const command = factories.createCommandRuntime(pool, objectStore.store);
    const special = factories.createSpecialExecutors(config, pool, external);
    const assetDownload = factories.createAssetDownloadPort(
      pool,
      objectStore.store,
    );
    const resources = factories.createResourcePort(config, pool);
    const geoAuthority = factories.createGeoAuthorityPort(config, pool);
    const geoProxy = factories.createGeoProxyPort(config);
    const executors = exactExecutors([
      read.executors,
      command.executors,
      special,
    ]);
    const handler = new DataCapabilityHandler({
      executors,
      audit: read.audit,
    });
    const readiness = async () => {
      const [database, objectStoreReady, worker] = await Promise.all([
        factories.probeDatabase(pool).catch(() => false),
        objectStore.probe().catch(() => false),
        factories.probeWorker(config.workerUrl).catch(() => false),
      ]);
      return { database, objectStore: objectStoreReady, worker };
    };
    const baseHealth = createDataFoundationModule({ readiness });
    const health: WiserApiModule = {
      ...baseHealth,
      async register(app) {
        await baseHealth.register(app);
        app.addHook('onClose', closeOnce);
      },
    };
    const modules = Object.freeze([
      health,
      ...(platformAuth.resourceAdministrationModule &&
      read.validateResourcePackage
        ? [
            platformAuth.resourceAdministrationModule(
              read.validateResourcePackage,
              read.listManagementCatalog,
              read.listExternalSources,
            ),
          ]
        : []),
      createDataFoundationRestModule({
        resolver: platformAuth.resolver,
        handler,
        assetDownload,
      }),
      createDataFoundationGraphqlModule({
        resolver: platformAuth.resolver,
        handler,
        production: environment['NODE_ENV'] === 'production',
      }),
      createDataFoundationResourceModule({
        resolver: platformAuth.resolver,
        resources,
      }),
      createDataFoundationGeoProxyModule({
        resolver: platformAuth.resolver,
        authority: geoAuthority,
        proxy: geoProxy,
        audit: geoAuthority,
      }),
    ]);
    return Object.freeze({ enabled: true, modules, executors });
  } catch (error) {
    void closeOnce().catch(() => undefined);
    throw error;
  }
}
