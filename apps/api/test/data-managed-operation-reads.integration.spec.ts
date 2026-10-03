import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { DataCapabilityExecutionContext } from '../src/data-foundation/capability-handler.js';
import { createPostgresDataReadRuntime } from '../src/data-foundation/postgres-read-executors.js';

it.skipIf(process.env['WISER_DATA_PG_INTEGRATION'] !== '1')(
  'guards real standard-intake Operation status/events under non-bypass API role and session RLS',
  async () => {
    const url = process.env['DATA_TEST_DATABASE_URL'];
    if (!url) throw Error('DATA_TEST_DATABASE_URL is required');
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    const tenant = randomUUID(),
      project = randomUUID(),
      actor = randomUUID(),
      other = randomUUID(),
      agent = randomUUID();
    const scope = {
      mode: 'managed' as const,
      validUntil: '2099-01-01T00:00:00Z',
      permissions: {
        'content.read': [],
        'original.read': [],
        'result.export': [],
        'source.discover': [],
        'external.directory': [],
      },
    };
    const context: DataCapabilityExecutionContext = {
      principal: {
        actorId: actor,
        actorType: 'human',
        authenticationMethod: 'supabase_jwt',
        authUserId: actor,
        sessionId: randomUUID(),
      },
      authorization: {
        tenantId: tenant,
        projectId: project,
        roles: ['data-steward'],
        scopes: ['data.operation.read', 'data.ingestion.write'],
        purpose: 'operation-test',
        maxSecurityLevel: 'L1_INTERNAL',
        authzVersion: 1,
        resourceAccess: { revision: 1, fingerprint: 'a'.repeat(64), scope },
      },
      effectiveMaxSecurityLevel: 'L1_INTERNAL',
      traceId: 'b'.repeat(32),
      auditLevel: 'STANDARD',
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };
    const fixtures = [
      { actor, actorType: 'human', delegatedBy: null, known: true },
      { actor: other, actorType: 'human', delegatedBy: null, known: true },
      { actor: agent, actorType: 'agent', delegatedBy: actor, known: true },
      { actor, actorType: 'human', delegatedBy: null, known: false },
    ].map((f) => ({
      ...f,
      upload: randomUUID(),
      operation: randomUUID(),
      ingestion: randomUUID(),
    }));
    const unrelated = randomUUID();
    // Production SQL and RLS execute under the real non-bypass API role. Savepoints
    // keep test statements inside the rollback fixture; this is not a live Auth test.
    const runtime = createPostgresDataReadRuntime({
      connect: () =>
        Promise.resolve({
          query: async (sql: string, values?: readonly unknown[]) => {
            if (/^begin\b/i.test(sql)) {
              await client.query('savepoint operation_read');
              return { rows: [] };
            }
            if (/^commit\b/i.test(sql)) {
              await client.query('release savepoint operation_read');
              return { rows: [] };
            }
            if (/^rollback\b/i.test(sql)) {
              await client.query('rollback to savepoint operation_read');
              return { rows: [] };
            }
            return client.query<Record<string, unknown>>(
              sql,
              values ? [...values] : undefined,
            );
          },
          release() {},
        }),
      end: () => Promise.resolve(),
    });
    // Reuse one connection sequentially; parallel executor transactions cannot share
    // a savepoint safely and are deliberately not used by this fixture.
    const readSequential = async (
      operationId: string,
      actorContext = context,
    ) => {
      const outputs: unknown[] = [];
      for (const capability of ['data.operation.get', 'data.operation.events'])
        outputs.push(
          await runtime.executors
            .find((executor) => executor.id === capability)!
            .execute(
              {
                operationId,
                ...(capability === 'data.operation.events' ? { first: 1 } : {}),
              },
              actorContext,
            ),
        );
      return outputs;
    };
    try {
      await client.query('begin');
      await client.query(
        `select set_config('wiser.tenant_id',$1,true),set_config('wiser.project_id',$2,true),set_config('wiser.max_security_level','L1_INTERNAL',true),set_config('wiser.policy_version','1',true)`,
        [tenant, project],
      );
      for (const f of fixtures) {
        await client.query(
          `select set_config('wiser.actor_id',$1,true),set_config('wiser.actor_type',$2,true),set_config('wiser.delegated_by',$3,true)`,
          [f.actor, f.actorType, f.delegatedBy ?? ''],
        );
        for (const [operationId, capability] of [
          [f.upload, 'data.uploadSession.create'],
          [f.operation, 'data.ingestion.create'],
        ]) {
          await client.query(
            `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
            values($1,$2,$3,$4,$5,'WAITING_INPUT','L1_INTERNAL',$6::jsonb)`,
            [
              operationId,
              tenant,
              project,
              capability,
              f.actor,
              JSON.stringify(
                f.known && capability === 'data.uploadSession.create'
                  ? {
                      intakeResponsibility: {
                        actorId: f.actor,
                        actorType: f.actorType,
                        ...(f.delegatedBy
                          ? { delegatedBy: f.delegatedBy }
                          : {}),
                        purpose: 'original-purpose',
                      },
                    }
                  : {},
              ),
            ],
          );
          for (const sequence of [1, 2])
            await client.query(
              `insert into service.operation_event(tenant_id,project_id,operation_id,sequence_number,to_status,event_type,payload,security_level)
            values($1,$2,$3,$4,'WAITING_INPUT','WAITING_INPUT','{"message":"http://storage.internal/private/path","progressPercent":0}','L1_INTERNAL')`,
              [tenant, project, operationId, sequence],
            );
        }
        await client.query(
          `insert into ingestion.session(ingestion_id,tenant_id,project_id,operation_id,owner_project_id,state,intended_uses,requested_security_level,security_level,submitted_by_actor_id,submitted_actor_type,submitted_delegator_actor_id)
          values($1,$2,$3,$4,$3,'RECEIVED',array['synthetic-test'],'L1_INTERNAL','L1_INTERNAL',$5,$6,$7)`,
          [
            f.ingestion,
            tenant,
            project,
            f.operation,
            f.known ? f.actor : null,
            f.known ? f.actorType : null,
            f.known ? f.delegatedBy : null,
          ],
        );
      }
      await client.query(
        `insert into service.operation(operation_id,tenant_id,project_id,capability_id,actor_id,status,security_level,request_payload)
        values($1,$2,$3,'data.reconciliation.create',$4,'WAITING_INPUT','L1_INTERNAL','{}')`,
        [unrelated, tenant, project, actor],
      );
      await client.query('set local role wiser_data_api');
      expect(
        (
          await client.query(
            'select rolsuper,rolbypassrls from pg_roles where rolname=current_user',
          )
        ).rows[0],
      ).toEqual({ rolsuper: false, rolbypassrls: false });
      for (const fixture of [fixtures[0]!, fixtures[2]!])
        for (const operation of [fixture.upload, fixture.operation]) {
          const result = await readSequential(operation);
          expect(JSON.stringify(result)).not.toMatch(
            /storage\.internal|intakeResponsibility|submitted_by/,
          );
        }
      for (const fixture of [fixtures[1]!, fixtures[3]!])
        for (const operation of [fixture.upload, fixture.operation])
          await expect(readSequential(operation)).rejects.toMatchObject({
            statusCode: 404,
          });
      await expect(readSequential(unrelated)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        readSequential(fixtures[0]!.operation, {
          ...context,
          authorization: { ...context.authorization, projectId: randomUUID() },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const delegated = {
        ...context,
        principal: {
          actorId: agent,
          actorType: 'agent' as const,
          authenticationMethod: 'delegated_credential' as const,
          credentialId: randomUUID(),
          delegationId: randomUUID(),
          delegatedBy: actor,
        },
      };
      for (const operation of [fixtures[2]!.upload, fixtures[2]!.operation]) {
        await expect(
          readSequential(operation, delegated),
        ).resolves.toBeDefined();
        await expect(
          readSequential(operation, {
            ...delegated,
            principal: { ...delegated.principal, delegatedBy: other },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      }
      const reviewer = {
        ...context,
        principal: { ...context.principal, actorId: other, authUserId: other },
        authorization: {
          ...context.authorization,
          scopes: ['data.operation.read', 'data.publish'],
        },
      };
      for (const operation of [
        fixtures[0]!.upload,
        fixtures[0]!.operation,
        fixtures[2]!.operation,
      ])
        await expect(
          readSequential(operation, reviewer),
        ).resolves.toBeDefined();
      await expect(
        readSequential(fixtures[1]!.operation, reviewer),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        readSequential(fixtures[0]!.operation, {
          ...context,
          authorization: {
            ...context.authorization,
            scopes: ['data.operation.read'],
          },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        readSequential(fixtures[0]!.operation, {
          ...context,
          authorization: {
            ...context.authorization,
            resourceAccess: {
              ...context.authorization.resourceAccess!,
              scope: { ...scope, validUntil: '2000-01-01T00:00:00Z' },
            },
          },
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      // A fresh authorized purpose does not establish a permanent submission-purpose identity.
      await expect(
        readSequential(fixtures[0]!.upload, {
          ...context,
          authorization: {
            ...context.authorization,
            purpose: 'current-review',
          },
        }),
      ).resolves.toBeDefined();
      const eventExecutor = runtime.executors.find(
        (e) => e.id === 'data.operation.events',
      )!;
      const page = (await eventExecutor.execute(
        { operationId: fixtures[0]!.operation, first: 1 },
        context,
      )) as { nextCursor: string };
      await expect(
        eventExecutor.execute(
          {
            operationId: fixtures[0]!.operation,
            first: 1,
            after: page.nextCursor,
          },
          {
            ...context,
            authorization: {
              ...context.authorization,
              purpose: 'current-review',
            },
          },
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      await client.query("select set_config('wiser.resource_scope','',true)");
      const { resourceAccess: _, ...legacy } = context.authorization;
      await expect(
        readSequential(fixtures[3]!.operation, {
          ...context,
          authorization: legacy,
        }),
      ).resolves.toBeDefined();
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);
