import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { Neo4jGraphQueryPort } from '../src/data-foundation/query-adapters.js';
import type { ScopedSpecialQueryRequest } from '../src/data-foundation/special-query-executors.js';
import { GraphResultSchema } from '@wiser/data-contracts';

it.skipIf(process.env['WISER_GRAPH_RESOURCE_INTEGRATION'] !== '1')(
  'constrains real Neo4j paths by endpoint and relationship source versions',
  async () => {
    const endpoint = process.env['WISER_GRAPH_TEST_URL'];
    const password = process.env['NEO4J_PASSWORD'];
    if (endpoint !== 'http://127.0.0.1:56574' || !password)
      throw Error('Dedicated Graph test instance required');
    const authorization = `Basic ${Buffer.from(`neo4j:${password}`).toString('base64')}`;
    const tenantId = randomUUID(),
      projectId = randomUUID(),
      dataItemId = randomUUID(),
      versionId = randomUUID(),
      otherItem = randomUUID(),
      otherVersion = randomUUID(),
      evidenceId = randomUUID();
    const governance = {
      tenantId,
      projectId,
      securityLevel: 'L1_INTERNAL',
      policyVersion: 1,
      publicationStatus: 'PUBLISHED',
      acceptanceStatus: 'PASSED',
      qualityGrade: 'A',
      confidence: 0.5,
      evidenceId,
      dataItemId,
      versionId,
    };
    const query = async (statement: string, parameters: unknown) => {
      const response = await fetch(`${endpoint}/db/neo4j/query/v2`, {
        method: 'POST',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ statement, parameters }),
      });
      const body: unknown = await response.json();
      if (
        !response.ok ||
        !body ||
        typeof body !== 'object' ||
        ('errors' in body && Array.isArray(body.errors) && body.errors.length)
      )
        throw Error('Synthetic graph fixture query failed');
      return body;
    };
    let requests = 0;
    const port = new Neo4jGraphQueryPort({
      baseUrl: endpoint,
      database: 'neo4j',
      authorization,
      http: {
        request: async (input) => {
          requests++;
          const response = await fetch(input.url, {
            method: input.method,
            headers: input.headers,
            body: JSON.stringify(input.body),
            signal: input.signal,
          });
          return {
            status: response.status,
            body: await response.json(),
          };
        },
      },
    });
    const request: ScopedSpecialQueryRequest = {
      scope: {
        tenantId,
        projectId,
        maxSecurityLevel: 'L1_INTERNAL',
        maximumPolicyVersion: 1,
      },
      input: { entityId: `${projectId}:a`, maxDepth: 1 },
      signal: new AbortController().signal,
    };
    try {
      await query(
        `CREATE (a:WiserEntity),(b:WiserEntity),(c:WiserEntity) SET a=$base,b=$base,c=$other SET a.entityId=$a,a.name='Synthetic A',b.entityId=$b,b.name='Synthetic B',c.entityId=$c,c.name='Synthetic C' CREATE (a)-[allowed:readable]->(b),(a)-[hidden:unreadable]->(b),(a)-[foreign:foreign]->(c) SET allowed=$base,hidden=$other,foreign=$base SET allowed.edgeId='allowed',hidden.edgeId='hidden',foreign.edgeId='foreign' RETURN a.entityId`,
        {
          base: governance,
          other: {
            ...governance,
            dataItemId: otherItem,
            versionId: otherVersion,
          },
          a: `${projectId}:a`,
          b: `${projectId}:b`,
          c: `${projectId}:c`,
        },
      );
      const legacy = GraphResultSchema.parse(await port.expand(request));
      expect(legacy.nodes).toHaveLength(3);
      expect(legacy.edges).toHaveLength(3);
      const managed: ScopedSpecialQueryRequest = {
        ...request,
        scope: {
          ...request.scope,
          resourceAccess: {
            revision: 1,
            fingerprint: 'a'.repeat(64),
            scope: {
              mode: 'managed',
              validUntil: '2099-01-01T00:00:00Z',
              permissions: {
                'content.read': [{ kind: 'version', dataItemId, versionId }],
                'source.discover': [],
                'original.read': [],
                'result.export': [],
                'external.directory': [],
              },
            },
          },
        },
      };
      const selected = GraphResultSchema.parse(await port.expand(managed));
      expect(selected.nodes.map((n) => n.entityId).sort()).toEqual([
        `${projectId}:a`,
        `${projectId}:b`,
      ]);
      expect(selected.edges.map((e) => e.edgeId)).toEqual(['allowed']);
      const path = GraphResultSchema.parse(
        await port.findPath({
          ...managed,
          input: {
            fromEntityId: `${projectId}:a`,
            toEntityId: `${projectId}:c`,
            maxDepth: 2,
          },
        }),
      );
      expect(path).toEqual({ nodes: [], edges: [] });
      const hiddenPath = GraphResultSchema.parse(
        await port.expand({
          ...managed,
          input: { ...managed.input, relationTypes: ['unreadable'] },
        }),
      );
      expect(hiddenPath.nodes.map((n) => n.entityId)).toEqual([
        `${projectId}:a`,
      ]);
      expect(hiddenPath.edges).toEqual([]);
      if (managed.scope.resourceAccess?.scope.mode !== 'managed')
        throw Error('test');
      managed.scope.resourceAccess.scope.permissions['content.read'] = [];
      const before = requests;
      expect(await port.expand(managed)).toEqual({ nodes: [], edges: [] });
      expect(requests).toBe(before);
    } finally {
      await query(
        'MATCH (n:WiserEntity {tenantId:$tenantId,projectId:$projectId}) DETACH DELETE n',
        { tenantId, projectId },
      );
    }
  },
  30000,
);
