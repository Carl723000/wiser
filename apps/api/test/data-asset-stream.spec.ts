import { describe, expect, it, vi } from 'vitest';
import { authorizedAssetStream } from '../src/data-foundation/authorized-asset-stream.js';

function source() {
  const cancel = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === 3) controller.close();
      else controller.enqueue(Uint8Array.of(++index));
    },
    cancel,
  });
  return { body, cancel };
}

describe('authorized asset stream', () => {
  it('preserves bytes and rechecks before each released chunk', async () => {
    const { body } = source();
    const authorize = vi.fn(() => Promise.resolve(true));
    const bytes: number[] = [];
    for await (const chunk of authorizedAssetStream(body, authorize))
      bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(body.locked).toBe(false);
  });
  it('cancels the upstream and withholds the next chunk after revocation', async () => {
    const { body, cancel } = source();
    const authorize = vi.fn(() => Promise.resolve(true));
    const stream = authorizedAssetStream(body, authorize);
    expect((await stream.next()).value).toEqual(Uint8Array.of(1));
    authorize.mockResolvedValue(false);
    await expect(stream.next()).rejects.toThrow('Asset delivery unavailable');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('does not leak internal authorization errors', async () => {
    const { body, cancel } = source();
    const stream = authorizedAssetStream(body, () =>
      Promise.reject(new Error('internal authority details')),
    );
    await expect(stream.next()).rejects.toThrow(/^Asset delivery unavailable$/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels on downstream termination', async () => {
    const { body, cancel } = source();
    const stream = authorizedAssetStream(body, () => Promise.resolve(true));
    await stream.next();
    await stream.return();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
