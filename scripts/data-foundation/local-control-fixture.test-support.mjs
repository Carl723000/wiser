export const isolatedTarget = Object.freeze({
  workdir: '/tmp/wiser-isolated-control',
  projectId: 'wiser-isolated',
  apiPort: 57321,
  databasePort: 57322,
});

export const isolatedEnvironment = Object.freeze({
  COMPOSE_PROJECT_NAME: 'wiser-isolated',
  DATA_API_ORIGIN: 'http://127.0.0.1:3641',
  DATA_WEB_ORIGIN: 'http://127.0.0.1:3640',
  DATA_MCP_ORIGIN: 'http://127.0.0.1:14004',
});

// Synthetic compiled configuration. No image is started and no key is real.
export function localComposeFixture(
  target = isolatedTarget,
  environment = isolatedEnvironment,
) {
  const containerAuth = `http://host.docker.internal:${target.apiPort}`;
  const controlDatabase = `postgresql://postgres:synthetic@host.docker.internal:${target.databasePort}/postgres`;
  const mount = (source, destination) => ({
    type: 'volume',
    source,
    target: destination,
  });
  const volumeServices = {
    'data-postgres': ['data-postgres-data', '/var/lib/postgresql'],
    seaweedfs: ['seaweedfs-data', '/data'],
    weaviate: ['weaviate-data', '/var/lib/weaviate'],
    opensearch: ['opensearch-data', '/usr/share/opensearch/data'],
    'opensearch-dashboards': [
      'opensearch-dashboards-data',
      '/usr/share/opensearch-dashboards/data',
    ],
    neo4j: ['neo4j-data', '/data'],
    geoserver: ['geoserver-data', '/opt/geoserver_data'],
    clamav: ['clamav-data', '/var/lib/clamav'],
  };
  const publicFileOrigin = 'http://127.0.0.1:19333';
  const ports = (published, destination) => [
    { host_ip: '127.0.0.1', published, target: destination },
  ];
  return {
    name: target.projectId,
    networks: { default: { name: `${target.projectId}_default` } },
    services: {
      ...Object.fromEntries(
        Object.entries(volumeServices).map(
          ([service, [source, destination]]) => [
            service,
            { volumes: [mount(source, destination)] },
          ],
        ),
      ),
      seaweedfs: {
        volumes: [mount('seaweedfs-data', '/data')],
        ports: ports('19333', 8333),
      },
      api: {
        ports: ports(new URL(environment.DATA_API_ORIGIN).port, 3001),
        environment: {
          WISER_AUTH_MODE: 'supabase',
          EXCON_V2_MODE: 'postgres',
          SUPABASE_URL: containerAuth,
          DATABASE_URL: controlDatabase,
          EXCON_JOURNAL_DATABASE_URL: `postgresql://wiser_excon_api:synthetic@host.docker.internal:${target.databasePort}/postgres`,
          DATA_DATABASE_URL:
            'postgresql://wiser_data_api:synthetic@data-postgres:5432/wiser_data',
          DATA_PUBLIC_API_ORIGIN: environment.DATA_API_ORIGIN,
          DATA_S3_ENDPOINT: 'http://seaweedfs:8333',
          DATA_S3_PUBLIC_ENDPOINT: publicFileOrigin,
        },
      },
      web: {
        ports: ports(new URL(environment.DATA_WEB_ORIGIN).port, 3000),
        environment: {
          WISER_AUTH_MODE: 'supabase',
          SUPABASE_URL: containerAuth,
          NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${target.apiPort}`,
        },
      },
      worker: { environment: { DATABASE_URL: controlDatabase } },
      'mcp-http': {
        ports: ports(new URL(environment.DATA_MCP_ORIGIN).port, 3004),
        environment: { SUPABASE_URL: containerAuth },
      },
      'data-worker': {
        environment: {
          SUPABASE_URL: containerAuth,
          DATA_DATABASE_URL:
            'postgresql://wiser_data_worker:synthetic@data-postgres:5432/wiser_data',
          DATA_PUBLIC_API_ORIGIN: environment.DATA_API_ORIGIN,
          DATA_STAC_ASSET_BASE_URL: environment.DATA_API_ORIGIN,
          DATA_S3_ENDPOINT: 'http://seaweedfs:8333',
          DATA_S3_PUBLIC_ENDPOINT: publicFileOrigin,
        },
      },
    },
    volumes: Object.fromEntries(
      Object.values(volumeServices).map(([source]) => [
        source,
        { name: `${target.projectId}_${source}` },
      ]),
    ),
  };
}
