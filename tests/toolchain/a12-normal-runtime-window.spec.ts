import { afterEach, expect, it, vi } from 'vitest';
import { createA12RuntimeObservationWindows } from '../../apps/web/e2e-live/support/a12-normal-runtime-window.ts';
import type {
  RuntimeObservationWindow,
  RuntimeWindowReason,
} from '../../apps/web/e2e-live/support/a12-normal-runtime-window.ts';

// Synthetic algorithm tests only: no actual launcher, Auth/SQL/scanner or A12 proof.
const digest = (n: number) => n.toString(16).padStart(64, '0');
const observation = () => ({
  status: 'observed',
  binding: {
    generations: ['api', 'data-worker', 'clamav'].map((service, i) => ({
      service,
      actualId: digest(i + 1),
      startedAt: '2026-10-06T08:20:00Z',
      restartGeneration: 0,
      immutableImageId: `sha256:${digest(i + 11)}`,
    })),
    sourceBuildSha256: digest(21),
    configurationSha256: digest(22),
    mountsSha256: digest(23),
    migrationSha256: digest(24),
    signatureSourceSha256: digest(25),
    signatureBytesSha256: digest(26),
    signatureReadinessSha256: digest(27),
    ownershipLoopbackSha256: digest(28),
  },
});
const controls = {
  maximumObservationMs: 200,
  sampleIntervalMs: 1000,
  maximumWindows: 2,
};
afterEach(() => {
  vi.useRealTimers();
});
const openedWindow = async (
  owner: ReturnType<typeof createA12RuntimeObservationWindows>,
) => {
  const opened = await owner.openWindow();
  expect(opened.status).toBe('open');
  if (opened.status !== 'open') throw new Error('Missing observation window');
  expect(await owner.checkpoint(opened.window)).toEqual({
    status: 'unchanged',
  });
  return opened.window;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

it('forged and serialized handles never become owned windows or live signals', async () => {
  let reads = 0;
  const owner = createA12RuntimeObservationWindows(() => {
    reads++;
    return Promise.resolve(observation());
  }, controls);
  const forged = JSON.parse(
    '{"status":"open","verified":true}',
  ) as RuntimeObservationWindow;
  expect(await owner.checkpoint(forged)).toEqual({
    status: 'unknown',
    reason: 'unowned_session',
  });
  expect(owner.signal(forged).aborted).toBe(true);
  owner.closeWindow(forged);
  owner.close();
  owner.close();
  expect(reads).toBe(0);
  expect(owner.diagnostics()).toEqual({
    activeWindows: 0,
    activeObservations: 0,
    activeWatchers: 0,
    closed: true,
  });
});

const drifts: {
  label: string;
  reason: RuntimeWindowReason;
  mutate: (value: ReturnType<typeof observation>) => void;
}[] = [];
for (let index = 0; index < 3; index++) {
  for (const field of [
    'actualId',
    'startedAt',
    'restartGeneration',
    'immutableImageId',
  ] as const) {
    drifts.push({
      label: `${['api', 'data-worker', 'clamav'][index]} ${field}`,
      reason:
        field === 'immutableImageId' ? 'build_changed' : 'generation_changed',
      mutate: (value) => {
        const g = value.binding.generations[index]!;
        if (field === 'actualId') g.actualId = digest(90);
        else if (field === 'startedAt') g.startedAt = '2026-10-06T08:21:00Z';
        else if (field === 'restartGeneration') g.restartGeneration++;
        else g.immutableImageId = `sha256:${digest(90)}`;
      },
    });
  }
}
for (const [field, reason] of [
  ['sourceBuildSha256', 'build_changed'],
  ['configurationSha256', 'configuration_changed'],
  ['mountsSha256', 'mount_changed'],
  ['migrationSha256', 'migration_changed'],
  ['signatureSourceSha256', 'signature_changed'],
  ['signatureBytesSha256', 'signature_changed'],
  ['signatureReadinessSha256', 'signature_changed'],
  ['ownershipLoopbackSha256', 'ownership_changed'],
] as const)
  drifts.push({
    label: field,
    reason,
    mutate: (value) => {
      value.binding[field] = digest(91);
    },
  });

it.each(drifts)(
  'WINDOW-R2 rejects $label and preserves first cause after recovery',
  async ({ mutate, reason }) => {
    let value = observation();
    const owner = createA12RuntimeObservationWindows(
      () => Promise.resolve(value),
      controls,
    );
    try {
      // Every variant gets its own actual open and unchanged read before one mutation.
      const window = await openedWindow(owner);
      mutate(value);
      expect(await owner.checkpoint(window)).toEqual({
        status: 'rejected',
        reason,
      });
      expect(owner.signal(window).aborted).toBe(true);
      value = observation();
      expect(await owner.checkpoint(window)).toEqual({
        status: 'rejected',
        reason,
      });
      expect(owner.diagnostics().activeWindows).toBe(0);
    } finally {
      owner.close();
    }
  },
);

it('unchanged reordered service observations retain identity instead of rejecting order alone', async () => {
  const value = observation();
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(value),
    controls,
  );
  try {
    const window = await openedWindow(owner);
    value.binding.generations.reverse();
    expect(await owner.checkpoint(window)).toEqual({ status: 'unchanged' });
  } finally {
    owner.close();
  }
});

it('valid snapshots are copied; mutating the first producer object cannot alter the baseline', async () => {
  const value = observation();
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(value),
    controls,
  );
  try {
    const window = await openedWindow(owner);
    value.binding.mountsSha256 = digest(72);
    expect(await owner.checkpoint(window)).toEqual({
      status: 'rejected',
      reason: 'mount_changed',
    });
  } finally {
    owner.close();
  }
});

it('known absence stays unknown and cannot recover into unchanged', async () => {
  let value: unknown = observation();
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(value),
    controls,
  );
  try {
    const window = await openedWindow(owner);
    value = { status: 'unknown', reason: 'observation_missing' };
    expect(await owner.checkpoint(window)).toEqual({
      status: 'unknown',
      reason: 'observation_missing',
    });
    value = observation();
    expect(await owner.checkpoint(window)).toEqual({
      status: 'unknown',
      reason: 'observation_missing',
    });
  } finally {
    owner.close();
  }
});

it('observation accessors, extra authority flags and malformed service lists remain unread and invalid', async () => {
  let getters = 0;
  for (const value of [
    {
      status: 'observed',
      get binding() {
        getters++;
        return observation().binding;
      },
    },
    { ...observation(), verified: true },
    {
      ...observation(),
      binding: { ...observation().binding, generations: [] },
    },
    {
      ...observation(),
      binding: { ...observation().binding, generations: new Array(3) },
    },
  ]) {
    const owner = createA12RuntimeObservationWindows(
      () => Promise.resolve(value),
      controls,
    );
    try {
      expect(await owner.openWindow()).toEqual({
        status: 'unknown',
        reason: 'invalid_observation',
      });
    } finally {
      owner.close();
    }
  }
  expect(getters).toBe(0);
});

it('two live owners cannot exchange handles, even with identical observation hashes', async () => {
  const first = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    controls,
  );
  const second = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    controls,
  );
  try {
    const a = await openedWindow(first),
      b = await openedWindow(second);
    expect(await first.checkpoint(b)).toEqual({
      status: 'unknown',
      reason: 'unowned_session',
    });
    expect(await second.checkpoint(a)).toEqual({
      status: 'unknown',
      reason: 'unowned_session',
    });
    expect(
      await first.checkpoint(
        JSON.parse(JSON.stringify(a)) as RuntimeObservationWindow,
      ),
    ).toEqual({ status: 'unknown', reason: 'unowned_session' });
    expect(await first.checkpoint(a)).toEqual({ status: 'unchanged' });
    expect(await second.checkpoint(b)).toEqual({ status: 'unchanged' });
  } finally {
    first.close();
    second.close();
  }
});

it('closed windows retain their reason and cannot be revived by late successful reads', async () => {
  const gate = deferred<unknown>();
  let pending = false;
  const owner = createA12RuntimeObservationWindows(
    async () => (pending ? gate.promise : observation()),
    controls,
  );
  try {
    const window = await openedWindow(owner);
    pending = true;
    const check = owner.checkpoint(window);
    owner.closeWindow(window);
    gate.resolve(observation());
    expect(await check).toEqual({ status: 'unknown', reason: 'closed' });
    expect(await owner.checkpoint(window)).toEqual({
      status: 'unknown',
      reason: 'closed',
    });
    expect(owner.signal(window).aborted).toBe(true);
  } finally {
    owner.close();
  }
});

it('close while opening refuses a late observation and repeated close releases resources once', async () => {
  const gate = deferred<unknown>();
  const owner = createA12RuntimeObservationWindows(
    async () => gate.promise,
    controls,
  );
  const open = owner.openWindow();
  owner.close();
  owner.close();
  gate.resolve(observation());
  expect(await open).toEqual({ status: 'unknown', reason: 'closed' });
  expect(await owner.openWindow()).toEqual({
    status: 'unknown',
    reason: 'closed',
  });
  expect(owner.diagnostics()).toEqual({
    activeWindows: 0,
    activeObservations: 0,
    activeWatchers: 0,
    closed: true,
  });
});

it('active-window bound refuses additional work without invalidating an existing window', async () => {
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    {
      ...controls,
      maximumWindows: 1,
    },
  );
  try {
    const window = await openedWindow(owner);
    expect(await owner.openWindow()).toEqual({
      status: 'unknown',
      reason: 'window_limit',
    });
    expect(await owner.checkpoint(window)).toEqual({ status: 'unchanged' });
  } finally {
    owner.close();
  }
});

it('out-of-band sampler invalidates a window before the next explicit checkpoint', async () => {
  vi.useFakeTimers();
  const value = observation();
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(value),
    {
      ...controls,
      sampleIntervalMs: 10,
    },
  );
  try {
    const window = await openedWindow(owner);
    value.binding.signatureBytesSha256 = digest(73);
    await vi.advanceTimersByTimeAsync(11);
    expect(owner.signal(window).aborted).toBe(true);
    expect(await owner.checkpoint(window)).toEqual({
      status: 'rejected',
      reason: 'signature_changed',
    });
    expect(owner.diagnostics().activeWatchers).toBe(0);
  } finally {
    owner.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('a non-cooperative reader reaches the whole-observation deadline and its late result cannot reopen', async () => {
  vi.useFakeTimers();
  const gate = deferred<unknown>();
  let settled: unknown;
  const owner = createA12RuntimeObservationWindows(async () => gate.promise, {
    ...controls,
    maximumObservationMs: 50,
  });
  const opening = owner.openWindow().then((value) => {
    settled = value;
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(51);
    expect(settled).toEqual({
      status: 'unknown',
      reason: 'observation_unavailable',
    });
    gate.resolve(observation());
    await opening;
    expect(owner.diagnostics().activeWindows).toBe(0);
  } finally {
    owner.close();
    gate.resolve(observation());
    await opening;
  }
  expect(vi.getTimerCount()).toBe(0);
});

it('concurrent checkpoints share the same observation without racing a healthy result over a drift', async () => {
  const gate = deferred<unknown>();
  let pending = false,
    reads = 0;
  const owner = createA12RuntimeObservationWindows(() => {
    reads++;
    return pending ? gate.promise : Promise.resolve(observation());
  }, controls);
  try {
    const window = await openedWindow(owner);
    const before = reads;
    pending = true;
    const a = owner.checkpoint(window),
      b = owner.checkpoint(window);
    const changed = observation();
    changed.binding.configurationSha256 = digest(74);
    gate.resolve(changed);
    expect(await a).toEqual({
      status: 'rejected',
      reason: 'configuration_changed',
    });
    expect(await b).toEqual({
      status: 'rejected',
      reason: 'configuration_changed',
    });
    expect(reads - before).toBe(1);
  } finally {
    owner.close();
  }
});

it('invalid controls reject before any observation is attempted', () => {
  for (const value of [0, -1, NaN, Infinity, 1.1])
    expect(() =>
      createA12RuntimeObservationWindows(() => Promise.resolve(observation()), {
        ...controls,
        maximumObservationMs: value,
      }),
    ).toThrow();
});

it('WINDOW-R1: observed runtime opens an opaque local window with unchanged checkpoint', async () => {
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    controls,
  );
  try {
    const opened = await owner.openWindow();
    expect(opened.status).toBe('open');
    if (opened.status !== 'open') throw new Error('Missing observation window');
    expect(owner.signal(opened.window).aborted).toBe(false);
    expect(await owner.checkpoint(opened.window)).toEqual({
      status: 'unchanged',
    });
    expect(JSON.stringify(opened.window)).toBe('{}');
  } finally {
    owner.close();
  }
});

it('cleanup cannot strand a checkpoint after an exposed signal instance method is overwritten', async () => {
  vi.useFakeTimers();
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    { ...controls, maximumObservationMs: 50 },
  );
  const window = await openedWindow(owner),
    signal = owner.signal(window);
  let settled: unknown;
  Object.defineProperty(signal, 'removeEventListener', {
    configurable: true,
    value: () => {
      throw new Error('private cleanup failure');
    },
  });
  const pending = owner.checkpoint(window).then((value) => {
    settled = value;
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(51);
    expect(settled).toEqual({ status: 'unchanged' });
    await pending;
  } finally {
    Reflect.deleteProperty(signal, 'removeEventListener');
    owner.close();
  }
});

it('synchronous close refuses queued checkpoint work before calling its reader', async () => {
  let reads = 0;
  const owner = createA12RuntimeObservationWindows(() => {
    reads++;
    return Promise.resolve(observation());
  }, controls);
  try {
    const window = await openedWindow(owner),
      before = reads;
    const pending = owner.checkpoint(window);
    owner.closeWindow(window);
    expect(await pending).toEqual({ status: 'unknown', reason: 'closed' });
    expect(reads).toBe(before);
  } finally {
    owner.close();
  }
});

it('shadowed aborted getter cannot prevent owned cancellation or expose an exception', async () => {
  const owner = createA12RuntimeObservationWindows(
    () => Promise.resolve(observation()),
    controls,
  );
  const window = await openedWindow(owner),
    signal = owner.signal(window);
  Object.defineProperty(signal, 'aborted', {
    configurable: true,
    get: () => {
      throw new Error('private shadowed getter');
    },
  });
  try {
    expect(() => owner.closeWindow(window)).not.toThrow();
  } finally {
    Reflect.deleteProperty(signal, 'aborted');
    owner.close();
  }
  expect(signal.aborted).toBe(true);
  expect(await owner.checkpoint(window)).toEqual({
    status: 'unknown',
    reason: 'closed',
  });
});
