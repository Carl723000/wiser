import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env['DATA_TEST_DATABASE_URL'];
describe.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'resource access RLS',
  () => {
    let pool: Pool, client: PoolClient;
    const tenant = randomUUID(),
      project = randomUUID();
    const sources = Array.from({ length: 2 }, () => ({
      item: randomUUID(),
      version: randomUUID(),
      asset: randomUUID(),
      evidence: randomUUID(),
      assertion: randomUUID(),
      analysis: randomUUID(),
      record: randomUUID(),
    }));
    const first = sources[0]!,
      second = sources[1]!;
    const processRun = randomUUID(),
      lineageEdge = randomUUID();
    const role = `resource_test_${randomUUID().replaceAll('-', '')}`;
    const ref = (source: typeof first) => ({
      kind: 'version',
      dataItemId: source.item,
      versionId: source.version,
    });
    const policy = (
      actions: Record<string, unknown[]> = { 'content.read': [ref(first)] },
      validUntil: string | null = new Date(Date.now() + 3600000).toISOString(),
    ) => ({
      mode: 'managed',
      permissions: {
        'source.discover': [],
        'content.read': [],
        'original.read': [],
        'result.export': [],
        'external.directory': [],
        ...actions,
      },
      validUntil,
    });
    const set = (key: string, value: string) =>
      client.query('select set_config($1,$2,true)', [key, value]);
    const scope = async (value: unknown, action = 'content.read') => {
      await set('wiser.resource_scope', JSON.stringify(value));
      await set('wiser.resource_action', action);
    };
    const ids = async (table: string, column: string) =>
      (
        await client.query<{ id: string }>(
          `select ${column} id from ${table} order by ${column}`,
        )
      ).rows.map((row) => row['id']);
    beforeAll(async () => {
      if (!url) throw Error('DATA_TEST_DATABASE_URL is required');
      pool = new Pool({ connectionString: url, max: 1 });
      client = await pool.connect();
      await client.query('begin');
      await client.query(`create role ${role} nologin nosuperuser nobypassrls`);
      await client.query(
        `grant usage on schema catalog,knowledge,service,security,lineage to ${role}`,
      );
      await client.query(
        `grant select on all tables in schema catalog,knowledge,service,lineage to ${role}`,
      );
      await client.query(
        `grant execute on all functions in schema security to ${role}`,
      );
      for (const s of sources) {
        const subject = {
          key: 'synthetic-point',
          label: 'Synthetic point',
          kind: 'MONITORING_POINT',
          externalId: 'test:synthetic-point',
        };
        const object = {
          key: 'synthetic-reading',
          label: 'Synthetic reading',
          kind: 'INDICATOR',
          externalId: 'test:synthetic-reading',
        };
        const candidate = {
          subject,
          predicate: 'test',
          object,
          evidence: [
            {
              assetId: s.asset,
              sourceHash: createHash('sha256').update(s.asset).digest('hex'),
            },
          ],
        };
        await client.query(
          `insert into catalog.data_item(data_item_id,tenant_id,project_id,owner_project_id,name,business_domains,source_natures,source_channels,processing_stage,intended_uses,source_organization,authorization_scope,generation_method,quality_grade,acceptance_status,publication_status,security_level,update_mode) values($1,$2,$3,$3,'Synthetic resource',array['test'],array['test'],array['test'],'RAW',array['test'],'Synthetic provider','test','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL','SNAPSHOT')`,
          [s.item, tenant, project],
        );
        await client.query(
          `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at) values($1,$2,$3,$4,1,'[]',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),'RAW','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL',now())`,
          [s.version, tenant, project, s.item],
        );
        await client.query(
          `insert into catalog.content_blob(content_blob_id,tenant_id,project_id,content_hash,byte_size,raw_storage_key,lifecycle_state,security_level) values($1::uuid,$2,$3,digest($1::text,'sha256'),1,$1::text,'RAW','L1_INTERNAL')`,
          [s.asset, tenant, project],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,security_level,content_blob_id,lifecycle_state) values($1::uuid,$2,$3,$4,$1::text,digest($1::text,'sha256'),'text/plain',1,'L1_INTERNAL',$1::uuid,'RAW')`,
          [s.asset, tenant, project, s.version],
        );
        await client.query(
          `insert into knowledge.evidence_fragment(evidence_fragment_id,tenant_id,project_id,data_item_id,version_id,asset_id,locator,content_hash,excerpt,security_level) values($1,$2,$3,$4,$5,$6,'{}',decode(repeat('ab',32),'hex'),'Synthetic evidence','L1_INTERNAL')`,
          [s.evidence, tenant, project, s.item, s.version, s.asset],
        );
        await client.query(
          `insert into knowledge.assertion(assertion_id,tenant_id,project_id,evidence_fragment_id,subject,predicate,object,confidence,generation_method,security_level) values($1,$2,$3,$4,$5::jsonb,'test',$6::jsonb,null,'SYNTHETIC','L1_INTERNAL')`,
          [
            s.assertion,
            tenant,
            project,
            s.evidence,
            JSON.stringify(subject),
            JSON.stringify(object),
          ],
        );
        await client.query(
          `insert into knowledge.assertion_binding(assertion_id,tenant_id,project_id,data_item_id,version_id,mapping_version,identity_key,fingerprint,candidate,security_level,policy_version) values($1,$2,$3,$4,$5,'resource-test.v1','synthetic',decode(repeat('ab',32),'hex'),$6::jsonb,'L1_INTERNAL',1)`,
          [
            s.assertion,
            tenant,
            project,
            s.item,
            s.version,
            JSON.stringify(candidate),
          ],
        );
        await client.query(
          `insert into catalog.temporal_extent(tenant_id,project_id,data_item_id,version_id,starts_at,ends_at,timezone,security_level) values($1,$2,$3,$4,now(),now(),'UTC','L1_INTERNAL')`,
          [tenant, project, s.item, s.version],
        );
        await client.query(
          `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload) values($1,$2,$3,'data.analysis.create',$1,'PENDING','L1_INTERNAL','{}')`,
          [s.analysis, tenant, project],
        );
        await client.query(
          `insert into service.analysis_run(analysis_id,tenant_id,project_id,version_id,operation_id,parser_version,security_level,policy_version) values($1,$2,$3,$4,$1,'synthetic','L1_INTERNAL',1)`,
          [s.analysis, tenant, project, s.version],
        );
        await client.query(
          `insert into service.analysis_asset(analysis_id,asset_id,tenant_id,project_id,source_hash,status,record_count,feature_count,security_level,policy_version) values($1,$2::uuid,$3,$4,digest($2::text,'sha256'),'READY',1,1,'L1_INTERNAL',1)`,
          [s.analysis, s.asset, tenant, project],
        );
        await client.query(
          `insert into catalog.analysis_record(analysis_id,record_id,asset_id,tenant_id,project_id,record_index,record_values,geom,security_level,policy_version) values($1,$2,$3,$4,$5,1,'{"label":"Synthetic point"}',st_setsrid(st_makepoint(0,0),4326),'L1_INTERNAL',1)`,
          [s.analysis, s.record, s.asset, tenant, project],
        );
        await client.query(
          `update service.analysis_run set status='READY',completed_at=now() where analysis_id=$1`,
          [s.analysis],
        );
      }
      await client.query(
        `insert into lineage.process_run(process_run_id,tenant_id,project_id,operation_id,process_type,implementation_version,input_manifest,status,security_level) values($1,$2,$3,$4,'SYNTHETIC','resource-test.v1','{}','SUCCEEDED','L1_INTERNAL')`,
        [processRun, tenant, project, first.analysis],
      );
      await client.query(
        `insert into lineage.edge(edge_id,tenant_id,project_id,process_run_id,from_data_item_id,from_version_id,to_data_item_id,to_version_id,relation_type,security_level) values($1,$2,$3,$4,$5,$6,$7,$8,'SYNTHETIC','L1_INTERNAL')`,
        [
          lineageEdge,
          tenant,
          project,
          processRun,
          first.item,
          first.version,
          second.item,
          second.version,
        ],
      );
      await client.query(`grant ${role} to current_user`);
      await client.query(`set local role ${role}`);
    });
    beforeEach(async () => {
      for (const [key, value] of Object.entries({
        'wiser.tenant_id': tenant,
        'wiser.project_id': project,
        'wiser.max_security_level': 'L1_INTERNAL',
        'wiser.policy_version': '1',
        'wiser.resource_scope': '',
        'wiser.resource_action': '',
      }))
        await set(key, value);
    });
    afterAll(async () => {
      if (client) {
        await client.query('rollback');
        client.release();
      }
      await pool?.end();
    });
    it('retains the existing legacy boundary', async () => {
      expect(await ids('catalog.data_item', 'data_item_id')).toHaveLength(2);
      expect(await ids('lineage.edge', 'edge_id')).toEqual([lineageEdge]);
      await set('wiser.project_id', randomUUID());
      expect(await ids('catalog.data_item', 'data_item_id')).toEqual([]);
      expect(await ids('knowledge.assertion_binding', 'assertion_id')).toEqual(
        [],
      );
      expect(await ids('lineage.edge', 'edge_id')).toEqual([]);
    });
    it('filters full metadata and immutable versions before counts and pagination', async () => {
      await scope(policy());
      expect(await ids('catalog.data_item', 'data_item_id')).toEqual([
        first.item,
      ]);
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([
        first.version,
      ]);
      expect(
        (
          await client.query<{ total: number }>(
            'select count(*)::int total from catalog.data_item_version',
          )
        ).rows[0]?.['total'],
      ).toBe(1);
    });
    it('filters direct asset, evidence, assertion and time-range reads', async () => {
      await scope(policy());
      expect(await ids('catalog.asset', 'asset_id')).toEqual([first.asset]);
      expect(await ids('knowledge.assertion_binding', 'assertion_id')).toEqual([
        first.assertion,
      ]);
      expect(
        await ids('knowledge.evidence_fragment', 'evidence_fragment_id'),
      ).toEqual([first.evidence]);
      expect(await ids('knowledge.assertion', 'assertion_id')).toEqual([
        first.assertion,
      ]);
      expect(await ids('catalog.temporal_extent', 'version_id')).toEqual([
        first.version,
      ]);
    });
    it('filters parsed records and geometry projections through their immutable analysis version', async () => {
      await scope(policy());
      expect(await ids('service.analysis_run', 'analysis_id')).toEqual([
        first.analysis,
      ]);
      expect(await ids('service.analysis_asset', 'analysis_id')).toEqual([
        first.analysis,
      ]);
      expect(await ids('catalog.analysis_record', 'record_id')).toEqual([
        first.record,
      ]);
      expect(await ids('service.analysis_amap_geometry', 'record_id')).toEqual([
        first.record,
      ]);
      expect(await ids('catalog.content_blob', 'content_blob_id')).toEqual([
        first.asset,
      ]);
    });
    it('does not turn a discoverable source into full metadata or content access', async () => {
      await scope(policy({ 'source.discover': [ref(first)] }));
      expect(await ids('catalog.data_item', 'data_item_id')).toEqual([]);
      await set('wiser.resource_action', 'source.discover');
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([]);
    });
    it('requires the exact item-version pair and the existing security ceiling', async () => {
      await scope(
        policy({
          'content.read': [{ ...ref(first), dataItemId: second.item }],
        }),
      );
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([]);
      expect(await ids('catalog.data_item', 'data_item_id')).toEqual([]);
      expect(await ids('knowledge.assertion_binding', 'assertion_id')).toEqual(
        [],
      );
      await scope(policy());
      await set('wiser.max_security_level', 'L0_PUBLIC');
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([]);
      expect(await ids('knowledge.assertion_binding', 'assertion_id')).toEqual(
        [],
      );
    });
    it('separates original access and intersects export with content access', async () => {
      await scope(
        policy({
          'content.read': [ref(first)],
          'original.read': [ref(second)],
          'result.export': [ref(first), ref(second)],
        }),
        'original.read',
      );
      expect(await ids('catalog.asset', 'asset_id')).toEqual([second.asset]);
      await set('wiser.resource_action', 'result.export');
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([
        first.version,
      ]);
      expect(await ids('knowledge.assertion_binding', 'assertion_id')).toEqual([
        first.assertion,
      ]);
    });
    it('requires both authorized lineage endpoints', async () => {
      await scope(policy());
      expect(await ids('lineage.edge', 'edge_id')).toEqual([]);
      await scope(policy({ 'content.read': [ref(first), ref(second)] }));
      expect(await ids('lineage.edge', 'edge_id')).toEqual([lineageEdge]);
    });
    it('rejects cross-source links hidden behind independently valid foreign keys', async () => {
      const provenance = randomUUID();
      const wrongPairEvidence = randomUUID();
      const wrongAssetEvidence = randomUUID();
      const wrongEdge = randomUUID();
      const wrongSchema = randomUUID();
      const wrongVersion = randomUUID();
      const wrongField = randomUUID();
      const wrongAsset = randomUUID();
      const sharedContentAsset = randomUUID();
      await client.query('savepoint mismatched_resource_links');
      try {
        await client.query('reset role');
        await client.query(
          `insert into catalog.source_provenance(provenance_id,tenant_id,project_id,data_item_id,version_id,source_organization,security_level) values($1,$2,$3,$4,$5,'Hidden source contact','L1_INTERNAL')`,
          [provenance, tenant, project, second.item, first.version],
        );
        await client.query(
          `insert into knowledge.evidence_fragment(evidence_fragment_id,tenant_id,project_id,data_item_id,version_id,asset_id,locator,content_hash,excerpt,security_level) values($1,$2,$3,$4,$5,$6,'{}',decode(repeat('ab',32),'hex'),'Hidden source excerpt','L1_INTERNAL')`,
          [
            wrongPairEvidence,
            tenant,
            project,
            second.item,
            first.version,
            first.asset,
          ],
        );
        await client.query(
          `insert into knowledge.evidence_fragment(evidence_fragment_id,tenant_id,project_id,data_item_id,version_id,asset_id,locator,content_hash,excerpt,security_level) values($1,$2,$3,$4,$5,$6,'{}',decode(repeat('ab',32),'hex'),'Hidden asset excerpt','L1_INTERNAL')`,
          [
            wrongAssetEvidence,
            tenant,
            project,
            first.item,
            first.version,
            second.asset,
          ],
        );
        await client.query(
          `insert into lineage.edge(edge_id,tenant_id,project_id,process_run_id,from_data_item_id,from_version_id,to_data_item_id,to_version_id,relation_type,security_level) values($1,$2,$3,$4,$5,$6,$7,$8,'MISBOUND','L1_INTERNAL')`,
          [
            wrongEdge,
            tenant,
            project,
            processRun,
            second.item,
            first.version,
            first.item,
            first.version,
          ],
        );
        await client.query(
          `insert into catalog.schema_version(schema_version_id,tenant_id,project_id,data_item_id,version_number,json_schema,schema_hash,security_level) values($1,$2,$3,$4,1,'{}',decode(repeat('ef',32),'hex'),'L1_INTERNAL')`,
          [wrongSchema, tenant, project, second.item],
        );
        await client.query(
          `insert into catalog.data_item_version(version_id,tenant_id,project_id,data_item_id,version_number,asset_manifest,source_hash,metadata_hash,schema_version_id,processing_stage,generation_method,quality_grade,acceptance_status,publication_status,security_level,committed_at) values($1,$2,$3,$4,2,'[]',decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),$5,'RAW','SYNTHETIC','A','PASSED','PUBLISHED','L1_INTERNAL',now())`,
          [wrongVersion, tenant, project, first.item, wrongSchema],
        );
        await client.query(
          `insert into catalog.field_definition(field_definition_id,tenant_id,project_id,schema_version_id,field_name,field_position,data_type,nullable,security_level) values($1,$2,$3,$4,'hidden_field',0,'text',true,'L1_INTERNAL')`,
          [wrongField, tenant, project, wrongSchema],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,security_level,content_blob_id,lifecycle_state) values($1::uuid,$2,$3,$4,$1::text,digest($5::text,'sha256'),'text/plain',1,'L1_INTERNAL',$6::uuid,'RAW')`,
          [
            wrongAsset,
            tenant,
            project,
            first.version,
            first.asset,
            second.asset,
          ],
        );
        await client.query(
          `insert into catalog.asset(asset_id,tenant_id,project_id,version_id,storage_key,content_hash,media_type,byte_size,security_level,content_blob_id,lifecycle_state) values($1::uuid,$2,$3,$4,$1::text,digest($5::text,'sha256'),'text/plain',1,'L1_INTERNAL',$6::uuid,'RAW')`,
          [
            sharedContentAsset,
            tenant,
            project,
            second.version,
            first.asset,
            first.asset,
          ],
        );
        await client.query(`set local role ${role}`);
        await scope(
          policy({
            'content.read': [
              ref(first),
              {
                kind: 'version',
                dataItemId: first.item,
                versionId: wrongVersion,
              },
            ],
          }),
        );
        expect(await ids('catalog.source_provenance', 'provenance_id')).toEqual(
          [],
        );
        expect(
          await ids('knowledge.evidence_fragment', 'evidence_fragment_id'),
        ).toEqual([first.evidence]);
        expect(await ids('lineage.edge', 'edge_id')).toEqual([]);
        expect(
          await ids('catalog.schema_version', 'schema_version_id'),
        ).toEqual([]);
        expect(
          await ids('catalog.field_definition', 'field_definition_id'),
        ).toEqual([]);
        expect(await ids('catalog.content_blob', 'content_blob_id')).toEqual([
          first.asset,
        ]);
        await scope(policy({ 'content.read': [ref(second)] }));
        expect(
          new Set(await ids('catalog.content_blob', 'content_blob_id')),
        ).toEqual(new Set([first.asset, second.asset]));
      } finally {
        await client.query('rollback to savepoint mismatched_resource_links');
        await client.query('release savepoint mismatched_resource_links');
      }
    });
    it('fails closed for empty, expired, malformed or unsupported managed contexts', async () => {
      for (const value of [
        policy({}),
        policy(undefined, '2000-01-01T00:00:00Z'),
        policy(undefined, null),
        {},
        null,
        { mode: 'legacy' },
        'invalid',
      ]) {
        await scope(value);
        expect(await ids('catalog.data_item_version', 'version_id')).toEqual(
          [],
        );
        expect(
          await ids('knowledge.assertion_binding', 'assertion_id'),
        ).toEqual([]);
        expect(await ids('lineage.edge', 'edge_id')).toEqual([]);
      }
      await set('wiser.resource_scope', 'not-json');
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([]);
      await scope(policy(), 'unknown');
      expect(await ids('catalog.data_item_version', 'version_id')).toEqual([]);
    });
    it('does not retain resource scope after transaction rollback', async () => {
      await client.query('savepoint scoped');
      await scope(policy());
      await client.query('rollback to savepoint scoped');
      expect(await ids('catalog.data_item_version', 'version_id')).toHaveLength(
        2,
      );
    });
  },
);
