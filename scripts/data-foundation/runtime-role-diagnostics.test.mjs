import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import * as operations from './operations.mjs';

const SECRET = 'synthetic-sensitive-role-check';
const expectedRoles = [
  'wiser_data_api|false|false|true',
  'wiser_data_gis|false|false|true',
  'wiser_data_runtime|false|false|false',
  'wiser_data_worker|false|false|true',
].join('\n');
const stages = ['role-flags', 'wrong-scope', 'fixture-scope'];
const successes = [expectedRoles, '0', '1'];
const reasons = [
  'ROLE_FLAGS_INVALID',
  'RLS_SCOPE_CROSSED',
  'SEEDED_SCOPE_UNREADABLE',
];

async function run(values, failureIndex = -1) {
  const calls = [];
  let caught;
  let result;
  try {
    result = await operations.assertRuntimeRoles({
      runPostgresSql: async (sql) => {
        const index = calls.length;
        calls.push(sql);
        if (index === failureIndex) throw new Error(SECRET);
        return values[index];
      },
    });
  } catch (error) {
    caught = error;
  }
  return { calls, caught, result };
}
const diagnostic = (error) => operations.runtimeRoleFailureDiagnostics?.(error);

for (let index = 0; index < stages.length; index += 1) {
  test(`fixed diagnosis for ${stages[index]} assertion without exposing returned data`, async () => {
    const values = [...successes];
    values[index] = SECRET;
    const { calls, caught } = await run(values);
    assert.ok(caught instanceof Error);
    assert.deepEqual(diagnostic(caught), {
      stage: stages[index],
      reasonCode: reasons[index],
    });
    assert.equal(calls.length, index + 1);
    assert.ok(!inspect(caught).includes(SECRET));
    assert.ok(Object.isFrozen(diagnostic(caught)));
  });
  test(`fixed diagnosis for ${stages[index]} execution failure without the original error`, async () => {
    const { calls, caught } = await run(successes, index);
    assert.ok(caught instanceof Error);
    assert.deepEqual(diagnostic(caught), {
      stage: stages[index],
      reasonCode: 'ROLE_CHECK_EXECUTION_FAILED',
    });
    assert.equal(calls.length, index + 1);
    assert.ok(!inspect(caught).includes(SECRET));
  });
}

test('successful runtime-role checks preserve all three SQL probes and the original report', async () => {
  const { calls, result, caught } = await run(successes);
  assert.equal(caught, undefined);
  assert.deepEqual(result, { api: true, worker: true, rls: true });
  assert.equal(calls.length, 3);
  assert.match(calls[0], /pg_catalog\.pg_roles/);
  assert.match(calls[1], /11111111-1111-4111-8111-111111111111/);
  assert.match(calls[2], /d1000000-0000-4000-8000-000000000101/);
  assert.match(calls[1], /rollback;/);
  assert.match(calls[2], /rollback;/);
});

for (const fake of [
  new Error(SECRET),
  Object.assign(new Error(SECRET), {
    stage: 'role-flags',
    reasonCode: 'ROLE_FLAGS_INVALID',
  }),
  {
    stage: 'role-flags',
    reasonCode: 'ROLE_FLAGS_INVALID',
    get message() {
      throw new Error(SECRET);
    },
  },
  null,
  SECRET,
]) {
  test('unowned exceptions cannot forge a runtime-role diagnosis', () => {
    assert.equal(diagnostic(fake), undefined);
  });
}

test('changing public fields on an owned error cannot replace its private diagnosis', async () => {
  const { caught } = await run(['unexpected', '0', '1']);
  caught.stage = SECRET;
  caught.reasonCode = SECRET;
  caught.cause = { stage: SECRET, reasonCode: SECRET };
  assert.deepEqual(diagnostic(caught), {
    stage: 'role-flags',
    reasonCode: 'ROLE_FLAGS_INVALID',
  });
});
